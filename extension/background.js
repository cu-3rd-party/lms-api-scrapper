// ===================================================================
//              ПОЛНЫЙ КОД ДЛЯ BACKGROUND.JS
// ===================================================================

// Глобальные переменные для хранения состояния
let capturedRequests = {};
let isMonitoring = false;
let isStopping = false; // Флаг, что запущен процесс остановки
let debuggee = null;
const protocolVersion = "1.3";
let pendingResponses = new Set(); // Множество для ID запросов, для которых ждем тело ответа

// 1. Слушатель сообщений от popup.html
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.command === "start") {
    startMonitoring();
  } else if (request.command === "stop") {
    stopMonitoring();
  }
  return true; // Важно для асинхронных операций
});


// 2. Функция начала мониторинга
function startMonitoring() {
  if (isMonitoring) {
    console.log("Мониторинг уже запущен.");
    return;
  }

  // Сбрасываем состояние перед новым запуском
  capturedRequests = {};
  pendingResponses.clear();
  isStopping = false;

  chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
    if (tabs.length === 0) {
      console.error("Не найдено активных вкладок.");
      return;
    }
    const targetTab = tabs[0];

    // Проверка на защищенные страницы
    if (targetTab.url.startsWith('chrome://') || targetTab.url.startsWith('https://chrome.google.com/')) {
      console.error("Невозможно запустить мониторинг на защищенной странице:", targetTab.url);
      return;
    }

    debuggee = { tabId: targetTab.id };
    chrome.debugger.attach(debuggee, protocolVersion, () => {
      if (chrome.runtime.lastError) {
        console.error("Ошибка прикрепления отладчика:", chrome.runtime.lastError.message);
        return;
      }
      console.log("Отладчик прикреплен к вкладке:", debuggee.tabId);
      isMonitoring = true;
      
      chrome.debugger.sendCommand(debuggee, "Network.enable", {}, () => {
        if (chrome.runtime.lastError) {
          console.error("Ошибка при включении Network:", chrome.runtime.lastError.message);
          stopMonitoring(); // Выполняем очистку, если включить не удалось
          return;
        }
        console.log("Мониторинг сети включен.");
      });
    });
  });
}


// 3. Функция остановки мониторинга
function stopMonitoring() {
  if (!debuggee) {
    console.log("Мониторинг не был запущен.");
    return;
  }
  
  console.log("Остановка мониторинга...");
  isMonitoring = false;    // Немедленно прекращаем принимать НОВЫЕ запросы
  isStopping = true;       // Начинаем процедуру завершения

  chrome.debugger.detach(debuggee, () => {
    console.log("Отладчик откреплен.");
    debuggee = null;
    // После открепления проверяем, можно ли сохранять файл
    checkIfReadyToSave(); 
  });
}

// 4. Главная функция проверки и сохранения
function checkIfReadyToSave() {
  // Сохраняем, только если была дана команда на остановку И все ответы получены
  if (isStopping && pendingResponses.size === 0) {
    console.log("Все ответы получены. Сохранение файла...");
    saveRequestsToFile();
    isStopping = false; // Сбрасываем флаг, чтобы избежать повторных сохранений
  } else if (isStopping) {
    console.log(`Ожидание ответов... Осталось: ${pendingResponses.size}`);
    // Если мы здесь, значит, нужно ждать, пока колбэки от getResponseBody сработают и вызовут эту функцию снова.
  }
}

// 5. Основной слушатель событий отладчика
chrome.debugger.onEvent.addListener((source, method, params) => {
  if (!debuggee || source.tabId !== debuggee.tabId) {
    return;
  }

  // --- Перехватываем начало запроса ---
  if (isMonitoring && method === "Network.requestWillBeSent" && params.request.url.includes("centraluniversity.ru")) {
    const requestId = params.requestId;
    capturedRequests[requestId] = {
      endpoint: params.request.url,
      timestamp: new Date().toISOString(),
      payload: params.request.postData || null,
      auth_needed: params.request.headers.hasOwnProperty('Authorization') || params.request.headers.hasOwnProperty('authorization'),
      return_code: null,
      response: null,
    };
  }

  // --- Перехватываем получение ответа ---
  if (method === "Network.responseReceived" && capturedRequests[params.requestId]) {
    const requestId = params.requestId;
    capturedRequests[requestId].return_code = params.response.status;

    pendingResponses.add(requestId); // Добавляем в список ожидания

    chrome.debugger.sendCommand(debuggee, "Network.getResponseBody", { requestId }, (responseBody) => {
      // Даже если отладчик уже откреплен, этот колбэк все равно может сработать
      if (capturedRequests[requestId]) {
        if (chrome.runtime.lastError) {
          capturedRequests[requestId].response = `[Тело ответа не получено: ${chrome.runtime.lastError.message}]`;
        } else {
          try {
            // Пытаемся сохранить JSON как объект для читаемости
            capturedRequests[requestId].response = JSON.parse(responseBody.body);
          } catch (e) {
            // Если это не JSON, сохраняем как есть
            capturedRequests[requestId].response = responseBody.body;
          }
        }
      }
      pendingResponses.delete(requestId); // Убираем из списка ожидания
      checkIfReadyToSave(); // После обработки каждого ответа проверяем, не пора ли сохранять
    });
  }
  
  // --- Перехватываем ошибку загрузки ---
  if (method === "Network.loadingFailed" && capturedRequests[params.requestId]) {
    const requestId = params.requestId;
    capturedRequests[requestId].return_code = "FAILED";
    capturedRequests[requestId].response = params.errorText;
    checkIfReadyToSave(); // Ошибки тоже завершают запрос, проверяем, не пора ли сохранять
  }
});


// 6. Функция сохранения файла (без изменений)
function saveRequestsToFile() {
  const requestsArray = Object.values(capturedRequests);
  if (requestsArray.length === 0) {
    console.log("Нет запросов для сохранения.");
    return;
  }

  const dataToSave = JSON.stringify(requestsArray, null, 2);
  const blob = new Blob([dataToSave], { type: 'application/json' });
  const reader = new FileReader();

  reader.onload = function() {
    const dataUrl = reader.result;
    chrome.downloads.download({
      url: dataUrl,
      filename: 'api_requests.json',
      saveAs: true
    });
  };

  reader.readAsDataURL(blob);
  
  // Очищаем для следующей сессии
  capturedRequests = {};
}