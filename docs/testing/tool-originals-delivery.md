# Доставка оригинала через `get_file`: контракт и доказательства

Дата проверки: 2026-09-20. Карточка: [002-tool](../tasks/002-tool-delivery.md).
Предыдущий отрицательный опыт с `resources/read` сохранён в
[Windows/ChatGPT live](windows-chatgpt-live.md).

## Итог

Маршрут `tools/call(get_file)` — стандартный MCP embedded resource — ChatGPT
материализованный файл — analysis runtime подтверждён для synthetic ZIP и настоящего
BIFF8/OLE XLS. ChatGPT вычислил SHA-256 из полученных файлов, открыл оба формата и
повторно получил их без ручного upload, ссылки или base64 в сообщении.

Это подтверждает только bounded delivery одного файла через `get_file`. Проверка не
создаёт и не обосновывает snapshot, bundle, OAuth, публичный download service или
долгоживущий artifact store.

## Поддерживаемый wire contract

`get_file` принимает один обязательный `path` и возвращает `CallToolResult.content`:

1. короткий text block без bytes;
2. embedded resource с `type: resource` и
   `resource: { uri, mimeType, blob }`, где `blob` — base64 исходных bytes;
3. matching `resource_link` с тем же `uri`, именем, MIME и raw size.

Metadata в `_meta` содержит `name`, `size`, `encodedSize`, `mimeType`,
`resourceUri` и `delivery: mcp-embedded-resource`. Это диагностические поля, а не
нестандартная file-reference схема. Tool не публикует `outputSchema`: текст остаётся
model-facing частью результата, а bytes несёт стандартный content block.

Выбор основан на трёх разных слоях:

- установленный в репозитории `@modelcontextprotocol/server` 2.0.0 типизирует
  `CallToolResult.content` стандартными `EmbeddedResource` и `ResourceLink`; binary
  resource использует `BlobResourceContents`;
- [MCP TypeScript SDK: embedded resource results](https://ts.sdk.modelcontextprotocol.io/server)
  показывает embedded resource внутри результата tool; SDK-допустимость не обещает
  конкретный способ отображения хостом;
- [OpenAI Plugin reference: File APIs](https://developers.openai.com/plugins/reference#file-apis)
  описывает input file parameters и widget helpers/file IDs. Она не задаёт новый
  server-side output object для этой задачи, поэтому такие поля не выдумывались.

Фактическая материализация ChatGPT проверена отдельно ниже. До live-проверки она была
гипотезой, а не следствием одной лишь SDK-схемы.

## Guard, лимиты и отмена

Handler вызывает только `GuardedFileSystem.readRaw(path, { signal })`. Поэтому до
чтения сохраняются lexical и canonical проверки `PathGuard`, root boundary,
sensitive-path policy, проверка regular file и `FS_MAX_FILE_SIZE`. Канонический
validated path используется для общего `filesystem-mcp://file/{+path}` URI.

Raw size и wire size учитываются раздельно. Файловый cap применяется к исходным bytes;
base64 занимает ровно `4 * ceil(raw size / 3)` символов и записывается как
`encodedSize`. Отдельного configurable wire cap сейчас нет: сначала действует raw
cap 1–100 MiB, затем результат несёт неизбежный base64 overhead. Ошибка доступа или
лимита возвращается как `isError` без resource/resource_link, то есть bytes не
подмешиваются в отрицательный ответ.

Request `AbortSignal` передаётся в `readRaw`; тест отменяет клиентский `tools/call` и
проверяет, что тот же сигнал дошёл до guarded raw read. Tool имеет read-only и
idempotent annotations и остаётся доступен с `--read-only`; шесть mutating tools по-
прежнему скрыты.

## Локальная проверка

Существующий synthetic стенд запускает built server по stdio с `--read-only`,
`--root-boundary` и `--max-file-size 1048576`. Harness вызывает `get_file`, декодирует
только embedded blob, сверяет matching link и `_meta`, сохраняет полученные bytes вне
source root и повторяет отдельный `tools/call`. SDK resource cache в этом маршруте не
участвует.

Результат Windows-прогона:

| Проверка            | Результат                                                                                                                                            |
| ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read-only inventory | `PASS`: восемь tools, включая `get_file`                                                                                                             |
| ZIP                 | `PASS`: 703 B, source/delivered/repeat SHA-256 `4e729b848906db06641b1ef60e752ae654b5705e92a881cd68319a6538a7fe02`                                    |
| XLS                 | `PASS`: 5,632 B, MIME `application/vnd.ms-excel`, source/delivered/repeat SHA-256 `db5c5cbd862f422b42085e3ac0936bb200a7a32cdbf3fce503b3bc76f476fc91` |
| Exact 1 MiB         | `PASS`: 1,048,576 raw bytes; encoded size проверен отдельно                                                                                          |
| 1 MiB + 1           | `PASS` expected rejection: `TOO_LARGE`, без resource blocks                                                                                          |
| Outside root        | `PASS` expected rejection: `ACCESS_DENIED`, без resource blocks                                                                                      |
| Independent parser  | `PASS`: ZIP CRC/entries и семь XLS cells прочитаны Python-проверяющим                                                                                |

Regression `GET-FILE-001..005` дополнительно проверяет byte equality, MIME, read-only
registration, traversal, canonical in-root links, escaping links, raw limit и
cancellation. На Windows обе link-ветки выполнились без skip.

## Живой Windows/ChatGPT прогон

Secure MCP Tunnel client `0.0.14+0f870e50` запускал текущий `dist/index.js` из ветки
`codex/002-tool-delivery`, а не старую сборку из другого worktree. Профиль сохранил
фиксированный loopback health listener, read-only режим, root boundary и единственный
synthetic source root. `doctor` и `/readyz` вернули `PASS`/`ready`; после refresh
ChatGPT показал `get_file`. Tunnel ID, ключ и абсолютные пользовательские пути в Git
не записаны.

### ZIP

ChatGPT получил видимый downloadable `unicode-original.zip` и положил его в analysis
runtime как файл. Из фактических bytes он получил:

- размер 703 B и SHA-256
  `4e729b848906db06641b1ef60e752ae654b5705e92a881cd68319a6538a7fe02`;
- `ZipFile.testzip() -> None`;
- `README.txt` 41 B, `data/Größe-Антенна.txt` 31 B и `payload.bin` 273 B;
- ожидаемые UTF-8 строки обоих text entries.

Во время первого разрешения на материализацию хост успел повторить вызов, и в чате
появились два одинаковых file objects. Это дало также повторную ZIP-доставку; ни один
файл не был загружен пользователем вручную.

### XLS и явный повтор

ChatGPT дважды отдельно вызвал `get_file` для `legacy-original.xls`. Оба вызова
материализовали BIFF8/Excel 97–2003 файл; после второго вызова analysis runtime заново
вычислил hash из host-side file object. Оба результата: 5,632 B и SHA-256
`db5c5cbd862f422b42085e3ac0936bb200a7a32cdbf3fce503b3bc76f476fc91`.

Workbook открылся с листами `Control` и `Контроль`; прочитаны все контрольные cells:

| Cell          | Значение                         |
| ------------- | -------------------------------- |
| `Control!A1`  | `SCHWARZBECK-ORIGINALS-002`      |
| `Control!B2`  | `4242`                           |
| `Control!C3`  | `12.5`                           |
| `Control!D4`  | `Größe Антенна`                  |
| `Control!E5`  | дата/время `2026-09-19 12:34:56` |
| `Контроль!A1` | `КОНТРОЛЬ-Ω`                     |
| `Контроль!B3` | `-7`                             |

`manifest.json` ChatGPT не использовал. Сервер не возвращал hash; оба digest вычислены
в analysis runtime после materialization. Совпадение имени runtime path не считается
кэшем: хост повторно заменил/materialized файл, его timestamp изменился, а второй hash
посчитан после отдельного tool call.

## Граница результата

Подтверждены ZIP, BIFF8 XLS и повторная доставка малых файлов. В целевом ChatGPT не
проверялись максимальные 1 MiB/10 MiB payloads, остальные Office/PDF/media форматы,
долгое хранение или expiry. Локальная проверка лимита не заменяет target-limit trial.
Для текущей карточки дополнительный сервис не нужен; расширение lifecycle или размера
требует отдельной задачи и измерений реального host/control-plane cap.
