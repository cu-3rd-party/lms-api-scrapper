document.getElementById('startMonitoring').addEventListener('click', () => {
  chrome.runtime.sendMessage({ command: "start" });
  window.close();
});

document.getElementById('stopMonitoring').addEventListener('click', () => {
  chrome.runtime.sendMessage({ command: "stop" });
  window.close();
});