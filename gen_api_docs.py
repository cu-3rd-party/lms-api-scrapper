import json
import re
from collections import defaultdict
from urllib.parse import urlparse, unquote
import os

# ===================================================================
# ИСПРАВЛЕННЫЙ БЛОК: Паттерны для статических ресурсов
# ===================================================================
# Порядок в этом словаре важен: от более специфичных правил к более общим.
ASSET_PATTERNS = {
    # Правило для JS чанков (теперь без '/' в начале, чтобы ловить их в любой папке)
    'JS Chunks': re.compile(r'chunk-.*\.js$', re.IGNORECASE),
    'Иконки (.svg)': re.compile(r'\.svg$', re.IGNORECASE),
    'Изображения (.png, .jpg, .gif)': re.compile(r'\.(png|jpg|jpeg|gif)$', re.IGNORECASE),
    'Шрифты (.woff, .woff2)': re.compile(r'\.(woff|woff2)$', re.IGNORECASE),
    'Стили (.css)': re.compile(r'\.css$', re.IGNORECASE),
    # Общее правило для JS должно идти ПОСЛЕ правила для чанков
    'Скрипты (.js)': re.compile(r'\.js$', re.IGNORECASE),
}

def normalize_endpoint(url):
    """Очищает URL от query-параметров и заменяет числовые ID на плейсхолдер {id}."""
    parsed_url = urlparse(url)
    path = parsed_url.path
    normalized_path = re.sub(r'/\d+', '/{id}', path)
    return normalized_path

def format_json_block(data, summary_text):
    """Красиво форматирует JSON и оборачивает его в сворачивающийся блок <details>."""
    if data is None: return "Отсутствует."
    
    details_open = f"<details>\n<summary>{summary_text}</summary>\n\n"
    details_close = "\n</details>"
    
    if isinstance(data, str):
        try: data = json.loads(data)
        except json.JSONDecodeError:
            formatted_str = f"```\n{data}\n```"
            return f"{details_open}{formatted_str}{details_close}"

    formatted_str = json.dumps(data, indent=2, ensure_ascii=False)
    code_block = f"```json\n{formatted_str}\n```"
    return f"{details_open}{code_block}{details_close}"

def generate_documentation(input_file, output_file):
    """Основная функция для генерации документации."""
    try:
        with open(input_file, 'r', encoding='utf-8') as f:
            requests_data = json.load(f)
    except FileNotFoundError:
        print(f"Ошибка: Файл '{input_file}' не найден.")
        return
    except json.JSONDecodeError:
        print(f"Ошибка: Не удалось прочитать JSON из файла '{input_file}'.")
        return

    api_requests = defaultdict(list)
    asset_groups = defaultdict(lambda: defaultdict(set))

    for req in requests_data:
        if not req.get('return_code'): continue
        
        path = urlparse(req['endpoint']).path
        asset_matched = False
        
        # Итерируемся по паттернам, чтобы классифицировать запрос
        for group_name, pattern in ASSET_PATTERNS.items():
            if pattern.search(path):
                directory, filename = os.path.split(path)
                directory = directory + '/' if not directory.endswith('/') else directory
                asset_groups[group_name][directory].add(filename)
                asset_matched = True
                break # Важно! Прерываем цикл после первого совпадения
        
        # Добавляем в API, только если это НЕ статический ресурс
        if not asset_matched:
            normalized = normalize_endpoint(req['endpoint'])
            api_requests[normalized].append(req)

    with open(output_file, 'w', encoding='utf-8') as f:
        f.write("# Документация по API centraluniversity.ru\n\n")
        f.write("*Сгенерировано автоматически на основе перехваченных запросов.*\n\n")

        if asset_groups:
            f.write("## Статические ресурсы (Assets)\n\n")
            f.write("Сгруппированный список запрошенных статических файлов.\n\n")
            for group_name in sorted(asset_groups.keys()):
                f.write(f"### {group_name}\n\n")
                for dir_path, filenames in sorted(asset_groups[group_name].items()):
                    f.write(f"#### Путь: `{dir_path}`\n\n")
                    f.write("<details>\n")
                    f.write(f"<summary>Нажмите, чтобы посмотреть список ({len(filenames)} шт.)</summary>\n\n")
                    for filename in sorted(list(filenames)):
                        f.write(f"- `{filename}`\n")
                    f.write("\n</details>\n\n")
            f.write("---\n\n")

        f.write("## API Эндпоинты\n\n")
        if not api_requests:
            f.write("Не найдено API-запросов для документирования.\n")
        
        for endpoint in sorted(api_requests.keys()):
            requests = api_requests[endpoint]
            has_payload = any(req.get('payload') for req in requests)
            method = "POST" if has_payload else "GET"

            f.write(f"### ` {method} {endpoint} `\n\n")

            unique_examples = []
            seen_signatures = set()
            for req in requests:
                signature = (req['return_code'], req['payload'] is not None)
                if signature not in seen_signatures:
                    unique_examples.append(req)
                    seen_signatures.add(signature)
                if len(unique_examples) >= 3:
                    break
            
            for i, example in enumerate(unique_examples):
                f.write(f"#### Пример {i + 1}\n\n")
                full_url = unquote(example['endpoint'])
                f.write(f"**Полный URL запроса:**\n`{full_url}`\n\n")
                f.write("**Тело запроса (Payload):**\n")
                f.write(format_json_block(example['payload'], "Нажмите, чтобы посмотреть Payload") + "\n\n")
                f.write(f"**Ответ сервера (Код: {example['return_code']}):**\n")
                f.write(format_json_block(example['response'], "Нажмите, чтобы посмотреть Response") + "\n\n")
            
            f.write("---\n\n")

    print(f"Готово! Документация с корректной фильтрацией Assets сохранена в файл '{output_file}'")

if __name__ == "__main__":
    INPUT_JSON_FILE = "api_requests.json"
    OUTPUT_DOC_FILE = "api_documentation.md"
    generate_documentation(INPUT_JSON_FILE, OUTPUT_DOC_FILE)