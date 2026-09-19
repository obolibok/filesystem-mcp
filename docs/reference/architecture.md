# Архитектура, форматы и ограничения

Описывает исходную version 2.3.0 (`4f2625bf`) и текущие границы пилота. Исполнитель
задачи, меняющей поведение, обновляет этот reference. Исторические measurements
остаются в [baseline](../testing/baseline-2026-09-19.md).

## Владельцы кода

| Область        | Файлы                                                       | Ответственность                                       |
| -------------- | ----------------------------------------------------------- | ----------------------------------------------------- |
| CLI/entry      | `src/index.ts`, `src/cli.ts`, `src/core/config.ts`          | Аргументы, startup config, выбор транспорта           |
| Hosting        | `src/transport/`, `src/transport.ts`                        | stdio/HTTP и публичный facade export                  |
| Composition    | `src/server.ts`                                             | PathGuard, stores, registrars, lifecycle              |
| MCP tools      | `src/tools/index.ts`, `define.ts`, отдельные tools          | Inventory, read-only gate, schemas, dispatch/response |
| Guarded I/O    | `src/core/path.ts`, `path-utils.ts`, `fs.ts`                | Root policy, resolution, файловые операции            |
| Text/discovery | `src/core/read.ts`, `search.ts`, `mime.ts`, `glob.ts`       | Чтение, поиск, классификация, ignore                  |
| Resources      | `src/resources.ts`, `src/core/file-uri.ts`                  | URI, text/blob delivery, subscriptions                |
| State          | `src/core/store.ts`, `page-store.ts`, `watcher-registry.ts` | Кэш результатов, страницы, уведомления                |
| Validation     | `__tests__/`, `.github/workflows/ci.yml`                    | Unit/integration/stdio/HTTP tests и CI                |

Сначала искать существующего владельца поведения. Не обходить guard прямым
доступом к файлам в новом tool и не менять публичный transport export ради
внутренней перестановки.

## Возможности

| Группа                      | Tools                                                       |
| --------------------------- | ----------------------------------------------------------- |
| Навигация                   | `list_roots`, `list`, `find_files`                          |
| Чтение и metadata           | `read`, `stat`                                              |
| Текстовый поиск и сравнение | `search_text`, `diff`                                       |
| Изменение                   | `create`, `edit`, `move`, `delete`, `patch`, `replace_text` |

13 tools; `--read-only` публикует семь и исключает последние шесть. Источник
inventory — [tools/index.ts](../../src/tools/index.ts). Есть stdio, Streamable HTTP,
resources, `get-help`, progress, отмена, logs и подписки с protocol-era ограничениями.

Корни задаются явно CLI/env или поддерживаемым access grant; `list_roots` показывает
уже доступные roots. Omitted path может выбрать единственный root; при нескольких
нужен явный path. Baseline descriptions двух search tools обещают другое — задача 001.
`includeIgnored` управляет фильтрами обхода, но не снимает запреты доступа PathGuard.

## Форматы

| Данные                                  | Реальное поведение baseline                                                                |
| --------------------------------------- | ------------------------------------------------------------------------------------------ |
| UTF-8 TXT/Markdown/CSV/code             | Полное/частичное и batch чтение, literal/RE2 поиск; структурного парсинга CSV нет          |
| Image/audio                             | Полный `read` может вернуть media content block                                            |
| PDF/Office/ZIP/binary                   | Известные binary отклоняются текстовым `read`; file resource передаёт originals как base64 |
| UTF-16 LE/BE с BOM                      | Признаётся текстом, затем ошибочно декодируется UTF-8; задача 001                          |
| Binary со вводящим в заблуждение `.txt` | Расширение может ошибочно определить text resource; проверить/исправить в 001              |

MIME detection не означает PDF extraction, OCR, Office parser или анализ программ
станков. `search_text` baseline читает файлы как UTF-8 без согласованного binary
фильтра — это подтверждённый дефект, а не поддержка поиска внутри архивов.

Схема file resource: `filesystem-mcp://file/{+path}`. Encoder и decoder находятся
в [file-uri.ts](../../src/core/file-uri.ts); использовать общий helper при построении
URI. Получение blob SDK-клиентом не доказывает материализацию файла в конкретной
аналитической среде.

## Лимиты и контракт результата

| Ограничение                | Baseline default / cap                                      | Владелец                        |
| -------------------------- | ----------------------------------------------------------- | ------------------------------- |
| Полное чтение/raw resource | 10 MiB; конфиг 1–100 MiB                                    | `core/util.ts`, `core/fs.ts`    |
| Batch read budget          | 512 KiB по умолчанию                                        | `core/util.ts`, `tools/read.ts` |
| Search timeout             | 5 секунд; конфиг 100–60000 ms                               | `core/util.ts`                  |
| Search results             | До 10000 собранных результатов; page size отдельно          | `core/util.ts`, search tools    |
| List entries               | До 20000                                                    | `core/util.ts`, `tools/list.ts` |
| Search context             | До 10 строк с каждой стороны                                | `tools/search-text.ts`          |
| Page snapshots             | 32 snapshots, TTL 60 секунд                                 | `core/page-store.ts`            |
| Cached result resources    | 64 записи; 10 MiB на запись, 25 MiB суммарно; TTL 60 секунд | `core/store.ts`                 |

Пагинация не отменяет cap/timeout первого обхода. Проверять `truncated`,
`stoppedReason` и счётчики пропусков; пустая выдача не доказывает полноту поиска.
`read(includeHash)` хеширует возвращённый текст, включая фрагмент partial read;
это не обязательно hash полного оригинала. `stat.tokenEstimate` — размер/4.

Текстовые tools сохраняют metadata в `_meta`; outputs без собственного текста
могут использовать `structuredContent`. `define.ts` не публикует `outputSchema`.
Перед изменением этого контракта изучить compatibility comments и tests, не
добавлять schema механически. Новые artifact/job ответы потребуют отдельной оценки.

HTTP baseline имеет один auth context: общий ключ, guard/grants, resource/page
stores для endpoint. OAuth spike не обеспечивает production изоляцию principal.
Watcher даёт сигнал изменения, не durable journal с checkpoint для индекса.

## Ещё не реализовано

`snapshot`, `bundle`, большие downloadable artifacts и их lifecycle, интеграция
доставки в целевой ChatGPT-клиент. Их описание в brief/task board — план.
Persistent corpus index, vector search, domain parsers и multi-user OAuth не
входят в первую coding-задачу.

Будущий artifact service должен разделять read-only источники и создание
служебных результатов. Кэш tool output на 60 секунд не подходит для долгой выдачи
CSV/ZIP. Перечисление миллионов записей требует отдельного потокового обхода,
а не повторного использования ограниченного `find_files` как полного snapshot.
