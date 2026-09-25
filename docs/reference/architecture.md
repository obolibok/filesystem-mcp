# Архитектура, форматы и ограничения

Описывает текущую архитектуру и границы пилота; исходная version 2.3.0 была на
`4f2625bf`. Исполнитель задачи, меняющей поведение, обновляет этот reference.
Исторические measurements остаются в [baseline](../testing/baseline-2026-09-19.md).

## Владельцы кода

| Область        | Файлы                                                          | Ответственность                                       |
| -------------- | -------------------------------------------------------------- | ----------------------------------------------------- |
| CLI/entry      | `src/index.ts`, `src/cli.ts`, `src/core/config.ts`             | Аргументы, startup config, выбор транспорта           |
| Hosting        | `src/transport/`, `src/transport.ts`                           | stdio/HTTP и публичный facade export                  |
| Composition    | `src/server.ts`                                                | PathGuard, stores, registrars, lifecycle              |
| MCP tools      | `src/tools/index.ts`, `define.ts`, отдельные tools             | Inventory, read-only gate, schemas, dispatch/response |
| Guarded I/O    | `src/core/path.ts`, `path-utils.ts`, `fs.ts`                   | Root policy, resolution, файловые операции            |
| Text/discovery | `src/core/read.ts`, `search.ts`, `mime.ts`, `glob.ts`          | Чтение, поиск, классификация, ignore                  |
| Resources      | `src/resources.ts`, `src/core/file-uri.ts`                     | URI, text/blob delivery, subscriptions                |
| State          | `src/core/store.ts`, `page-store.ts`, `watcher-registry.ts`    | Кэш результатов, страницы, уведомления                |
| Durable jobs   | `job-manager.ts`, `snapshot-pipeline.ts`, `bundle-pipeline.ts` | Общий lifecycle и producers                           |
| Validation     | `__tests__/`, `.github/workflows/ci.yml`                       | Unit/integration/stdio/HTTP tests и CI                |

Сначала искать существующего владельца поведения. Не обходить guard прямым
доступом к файлам в новом tool и не менять публичный transport export ради
внутренней перестановки.

## Возможности

| Группа                      | Tools                                                            |
| --------------------------- | ---------------------------------------------------------------- |
| Навигация                   | `list_roots`, `list`, `find_files`                               |
| Чтение и metadata           | `read`, `get_file`, `stat`                                       |
| Durable jobs                | `snapshot`, `bundle`, `job_status`, `cancel_job`, `get_artifact` |
| Текстовый поиск и сравнение | `search_text`, `diff`                                            |
| Изменение                   | `create`, `edit`, `move`, `delete`, `patch`, `replace_text`      |

19 tools; `--read-only` публикует тринадцать, включая durable jobs, и исключает
последние шесть source-mutating tools. `snapshot`, `bundle` и `cancel_job` меняют
служебное состояние и поэтому честно имеют `readOnlyHint: false`, но не изменяют источники. Источник
inventory — [tools/index.ts](../../src/tools/index.ts). Есть stdio, Streamable HTTP,
resources, `get-help`, progress, отмена, logs и подписки с protocol-era ограничениями.

Корни задаются явно CLI/env или поддерживаемым access grant; `list_roots` показывает
уже доступные roots. Omitted path может выбрать единственный root; при нескольких
нужен явный path. Lexical и real path одного root остаются отдельными внутренними
aliases для проверок PathGuard, но при omitted path считаются одной canonical location.
Tool descriptions фиксируют то же правило.
`includeIgnored` управляет фильтрами обхода, но не снимает запреты доступа PathGuard.

## Форматы

| Данные                                  | Текущее поведение                                                                                                                  |
| --------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| UTF-8 TXT/Markdown/CSV/code             | Полное/частичное и batch чтение, literal/RE2 поиск; структурного парсинга CSV нет                                                  |
| SVG                                     | Доступен текстовому `read`, `search_text` и text resource с MIME `image/svg+xml`                                                   |
| Image/audio                             | Полный `read` возвращает media content block; file resource и `get_file` передают исходные байты base64 blob                       |
| PDF/Office/ZIP/binary                   | Текстовые операции отклоняют; file resource и `get_file` передают originals как byte-exact base64 blob                             |
| UTF-16 LE/BE с BOM                      | `read` возвращает понятную encoding error; `search_text` считает `skippedUnsupportedEncoding`; resource возвращает byte-exact blob |
| Binary со вводящим в заблуждение `.txt` | Определяется по sample: поиск пропускает с `skippedBinary`, resource возвращает `application/octet-stream` blob                    |

MIME detection не означает PDF extraction, OCR, Office parser или анализ программ
станков. `read` и `search_text` используют общую классификацию: известное binary-расширение
или binary sample не попадают в UTF-8 pipeline; UTF-16 BOM выделен в отдельную причину.
Это не поддержка поиска внутри архивов.

Схема file resource: `filesystem-mcp://file/{+path}`. Encoder и decoder находятся
в [file-uri.ts](../../src/core/file-uri.ts); использовать общий helper при построении
URI. `get_file` возвращает тот же URI одновременно в стандартном embedded resource
(`type: resource`, `resource.blob`) и matching `resource_link`. Blob уже находится
в результате `tools/call`; отдельный `resources/read` для него не нужен. Получение
blob SDK-клиентом само по себе не доказывает материализацию файла в конкретной
аналитической среде; проверенный ChatGPT-маршрут записан в
[tool delivery protocol](../testing/tool-originals-delivery.md).

## Лимиты и контракт результата

| Ограничение                           | Baseline default / cap                                                            | Владелец                        |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| Полное чтение/raw resource/`get_file` | 10 MiB; конфиг 1–100 MiB                                                          | `core/util.ts`, `core/fs.ts`    |
| `get_file` wire blob                  | Base64: ровно `4 * ceil(raw bytes / 3)` символов; отдельного configurable cap нет | `tools/get-file.ts`             |
| Batch read budget                     | 512 KiB по умолчанию                                                              | `core/util.ts`, `tools/read.ts` |
| Search timeout                        | 5 секунд; конфиг 100–60000 ms                                                     | `core/util.ts`                  |
| Search results                        | До 10000 собранных результатов; page size отдельно                                | `core/util.ts`, search tools    |
| List entries                          | До 20000                                                                          | `core/util.ts`, `tools/list.ts` |
| Search context                        | До 10 строк с каждой стороны                                                      | `tools/search-text.ts`          |
| Page snapshots                        | 32 snapshots, TTL 60 секунд                                                       | `core/page-store.ts`            |
| Cached result resources               | 64 записи; 10 MiB на запись, 25 MiB суммарно; TTL 60 секунд                       | `core/store.ts`                 |
| Snapshot CSV record / raw part        | 1 MiB / 45 MiB                                                                    | `core/snapshot-config.ts`       |
| Snapshot ZIP / delivery               | 8 MiB / 8 MiB; delivery также ограничен `FS_MAX_FILE_SIZE`                        | `core/snapshot-config.ts`       |
| Snapshot job raw / ready artifacts    | 512 MiB / 512 MiB; до 128 частей                                                  | `core/snapshot-config.ts`       |
| Snapshot concurrency / queue / time   | 1 running / 4 queued / 60 минут                                                   | `core/job-manager.ts`           |
| Snapshot scratch / result TTL         | 1 GiB / 24 часа от completed                                                      | `core/job-manager.ts`           |
| Bundle selection                      | 1000 paths / 256 KiB metadata; schema ceiling 10000                               | `core/snapshot-config.ts`       |
| Bundle original / raw ZIP candidate   | min(64 MiB, `FS_MAX_FILE_SIZE`) / 64 MiB                                          | `core/snapshot-config.ts`       |
| Bundle raw job / external manifest    | 512 MiB / 4 MiB                                                                   | `core/snapshot-config.ts`       |

Пагинация не отменяет cap/timeout первого обхода. Проверять `truncated`,
`stoppedReason` и счётчики пропусков; пустая выдача не доказывает полноту поиска.
`search_text.filesScanned` считает доступные файлы, для которых проверены metadata/классификация,
включая `skippedBinary`, `skippedUnsupportedEncoding` и `skippedTooLarge`;
`skippedInaccessible` в него не входит. Один файл получает одну причину пропуска; счётчики
сохраняются на всех страницах и в externalized JSON.
`read(includeHash)` хеширует возвращённый текст, включая фрагмент partial read;
это не обязательно hash полного оригинала. `stat.tokenEstimate` — размер/4.

Текстовые tools сохраняют metadata в `_meta`; outputs без собственного текста
могут использовать `structuredContent`. `define.ts` не публикует `outputSchema`.
Перед изменением этого контракта изучить compatibility comments и tests, не
добавлять schema механически. Изменения artifact/job ответов требуют проверки совместимости.

Snapshot и bundle имеют единый disk-backed lifecycle и не используют 60-секундные
ResourceStore/PageSnapshotStore. `snapshot` быстро выбирает подходящую job или создаёт
новую; `idempotencyKey` необязателен. `bundle` по-прежнему требует ключ для отсортированного явного набора и optional
`expected { size, lastWriteTime }`. `job_status` опрашивается отдельными вызовами, `cancel_job` отменяет
собственный AbortController job, `get_artifact` выдаёт ровно один manifest/ZIP как
embedded resource + matching resource_link. HTTP endpoint владеет одним manager для
всех per-request McpServer; закрытие запроса его не очищает. После process restart
queued/running становятся `interrupted`, completed bytes остаются immutable до TTL.
Startup удаляет только manager-owned partial/metadata-temp и UUID-named ZIP/JSON.
Unreferenced final после crash между rename и metadata commit удаляется; ошибка
удаления остаётся учтённой в scratch quota до успешного cleanup/restart. Expiry,
artifact removal и terminal directory cleanup сериализованы для каждой job.

Обычный snapshot сначала проверяет текущий доступ и явный ключ, затем выбирает самый
новый совместимый `completed` с `complete=true`, живыми artifacts, TTL и возрастом
от `startedAt` не более `maxAgeMs` (default 3600000 ms, допустимо 0–30 суток).
`maxAgeMs=0` запрещает ready hit, но допускает присоединение к queued/running.
Если ready hit нет, присоединяется к самой ранней совместимой queued/running job;
иначе создаёт новую. `forceRefresh=true` обходит оба вида автоматического reuse;
повтор с тем же явным ключом остаётся replay даже для forced job. Без ключа каждый
forced вызов создаёт новый логический запрос. Ответ возвращает `reused`, `reason`
(`created`, `completed_reuse`, `inflight_reuse`, `idempotent_replay`) и прежний
`job` с `startedAt`, `finishedAt`, `resultExpiresAt`. Reuse не запускает второй
producer, не занимает queue slot и не продлевает TTL. Отмена общей job действует
на всех наблюдателей; отключение клиента её не отменяет.

Автоматическая identity включает kind, canonical source root, flags, версию
семантики/формата, effective allowed roots и boundaries, sensitive deny/allow
policy, а также captured snapshot limits и scratch location. Изменение значимых
лимитов после restart блокирует replay/status/fetch старого результата; изменения
TTL и ёмкости очереди не меняют identity. Lexical aliases
одного root канонизируются. Fingerprint используется только для поиска: перед
replay, status, cancel и artifact fetch guard заново проверяет root и policy.
Более широкая или узкая политика требует нового snapshot; старый job с ключом
не выдаёт metadata/artifacts при policy mismatch. Старые job JSON без policy proof
доступны по прежнему ключу и jobId, но не участвуют в автоматическом поиске.
Identity явного retry отдельно учитывает path/flags/maxAgeMs/forceRefresh;
изменение любого из них даёт conflict. Новые ключи, присоединившиеся к job,
сохраняются в её metadata, переживают restart и удаляются вместе с terminal job.
На одну job допускается не более 1024 дополнительных привязок: следующая явно
отклоняется без потери уже живых привязок. Failed/cancelled/interrupted/expired,
partial и result с отсутствующим artifact не выбираются автоматически. Наличие,
тип и размер artifacts проверяются без перечитывания ZIP; SHA-256 остаётся
обязательной проверкой при выдаче. Изменения source/.gitignore не инвалидируют
готовый результат: для нового обхода задают `forceRefresh` или меньший maxAgeMs.

CSV v1 — UTF-8 без BOM, CRLF, RFC 4180, одинаковый header в каждой части:
`RootId,RelativePath,Name,Extension,Length,LastWriteTime`. RelativePath использует
`/`, Length — bytes, время — ISO 8601 UTC. Обычные файлы перечисляются потоково;
symlink/junction не разыменовываются. Manifest v1 фиксирует interval наблюдения,
policy, counters/errors/completeness и SHA-256/rows/raw/ZIP/base64 sizes частей.
Snapshot не является атомарным filesystem snapshot: исчезновение/недоступность
делает `complete=false`, но не скрывается как пустой успех.
Отказы чтения отдельного дочернего файла, каталога, `.gitignore` или итератора
каталога учитываются один раз и позволяют продолжить доступных соседей. Для
native `ENOENT`/`ENOTDIR`/`EISDIR` и wrapped
`NOT_FOUND`/`NOT_DIRECTORY`/`NOT_FILE` растёт
`disappearedSkipped`; для `EACCES`/`EPERM`/`EBUSY` и соответствующих wrapped
permission/известного native `EBUSY` растёт `inaccessibleSkipped`. Итерация
с ошибкой прекращается только внутри затронутого каталога. Если файл после
перечисления сменил тип на каталог, special или symlink, он не читается,
сохраняет соответствующий `specialSkipped`/`symlinksSkipped` и одну error
запись; snapshot становится неполным. Штатный sensitive child остаётся
запретным для чтения и учитывается как `inaccessibleSkipped`, не прекращая
доступных соседей. Root, отказ общей policy,
неизвестный IO, ENOSPC/EMFILE/ENFILE, лимиты, отмена, timeout и отказ
scratch/ZIP не классифицируются как пропуск. `state=completed` с
`complete=false` сохраняет manifest и готовые части, но не входит в
автоматический ready reuse; клиенту нужно проверить оба поля. Отдельного
state `partial` нет.

У `state=failed` статус имеет optional `fatalError` независимо от первых 20
`errors` samples: bounded `code`/`message`, допустимый source/scratch `path`,
а при известной native cause — `nativeErrorCode` и `operation`. Scratch path
проверяется по canonical директории manager даже при Windows 8.3 spelling
конфигурации; путь вне source/scratch не выдаётся. Поле
сохраняется в job metadata и доступно после restart через `job_status` после
обычной проверки доступа. `stopReason` остаётся прежним; cancelled и
interrupted не получают выдуманный fatalError, timeout использует
`TIMEOUT` без ложного пути. В `fatalError` не сериализуются stack и cause.
Кэш уникальных путей внутри `ignore` ограничен периодическим созданием нового matcher
из уже скомпилированных rules; nested patterns и negation сохраняются. Walk depth —
жёсткий policy cap и приводит к `failed`, а не к partial completed результату.

Bundle принимает только portable `/`-relative regular-file paths без globbing,
absolute/drive/UNC/device/ADS/traversal, Windows-invalid wildcard characters и
extraction collisions. Порядок выбора
не влияет на fingerprint; изменение paths или preconditions при том же key даёт
conflict. Explicit selection не применяет discovery ignore rules. Guard проверяет
root и каждый выбранный путь; каждый существующий компонент проверяется отдельно,
поэтому symlink/junction с отсутствующим leaf тоже является fatal unsafe selector.
Worker потоково копирует bytes через `GuardedFileSystem` в manager-owned scratch,
сверяет identity/size/mtime и optional expected metadata, затем упаковывает целые
originals под `files/<relativePath>`. Один original не режется между частями.
Raw original сначала проверяется против минимума bundle file/raw-part и общего
`FS_MAX_FILE_SIZE`. Закрытый ZIP отдельно проверяется против общего
ZIP/delivery/`FS_MAX_FILE_SIZE` cap; группа
при необходимости делится, а одиночный непомещающийся original получает `too_large`.

Bundle manifest v1 (`filesystem-mcp.bundle-manifest`) — отдельный JSON artifact без
абсолютных source paths. Он содержит root ID, interval/caveat, limits, `complete`,
bundle counters, outcome каждого selector, expected/observed metadata, size/SHA-256
включённых bytes и archive/part provenance, а также hashes/sizes частей. Outcomes
`missing`, `inaccessible`, `changed`, `special`, `too_large` дают completed job с
`complete=false`; all-skipped публикует manifest без пустого ZIP. Policy denial,
unsafe selector, storage/compression/quota/deadline — fatal, incomplete artifacts
удаляются. Metadata checks не являются atomic filesystem snapshot и не обнаружат
запись, восстановившую прежние size/mtime; content precondition v1 отсутствует.

Scratch и его ancestors не могут быть symlink/junction; проверка выполняется
до создания storage. Windows 8.3 spelling разрешён, после проверки manager
использует canonical scratch для I/O, cleanup и исключения из source traversal.

Source I/O остаётся в PathGuard/GuardedFileSystem. Scratch и его metadata/artifacts
нельзя выбрать как bundle source даже при вложении scratch в разрешённый root или
доступе через canonical/8.3/link alias. Caller не выбирает output path, а
status/cancel/fetch и idempotent reuse каждый раз проверяют текущий доступ к canonical
source root и всем bundle selectors. Удаление/изменение отдельного
original после completed не требует повторного source read и не меняет сохранённые
bytes; удаление root или сужение policy закрывает доступ. Одна HTTP credential остаётся одним endpoint scope;
multi-user isolation этим не заявляется. Один scratch каталог имеет одного владельца-
процесс; параллельным экземплярам нужны разные каталоги. Metadata сохраняется atomic
rename; quota учитывает spool, готовые artifacts и job metadata. Bundle ZIP producer
владеет input/output и всей внутренней CRC/counter/compression chain, перенаправляет
input errors в job failure и дожидается закрытия при split/cancel/error. Резерв
частично записанного ZIP сохраняется до фактического удаления partial. Producer
применяет минимум ZIP/delivery/captured general-file caps, а fetch повторно
проверяет текущий `FS_MAX_FILE_SIZE`. Cleanup защищает активное чтение и освобождает
quota только после фактического удаления bytes.

Stored job `schemaVersion: 1` сохранён: bundle добавляет новые kind/counters и
optional authorization paths, а прежние snapshot job JSON читаются без миграции.
Общие `FS_SNAPSHOT_*` lifecycle/ZIP/delivery/quota/TTL настройки не переименованы;
`FS_BUNDLE_*` ограничивают только selection/capture/manifest.

HTTP baseline имеет один auth context: общий ключ, guard/grants, resource/page
stores для endpoint. OAuth spike не обеспечивает production изоляцию principal.
Watcher даёт сигнал изменения, не durable journal с checkpoint для индекса.

На [проверенном стенде ChatGPT](../testing/003-live-2026-09-20.md) доставлен
и повторно получен ZIP 7802264 B; верхний предел принимающего host не установлен.

## Ещё не реализовано

Автоматический semantic selection, glob/folder bundle, несколько source roots в
одном bundle, parser/OCR service и content-hash precondition. `get_file` остаётся
отдельным быстрым маршрутом одного size-limited original.
Persistent corpus index, vector search, domain parsers и multi-user OAuth остаются
вне принятого scope пилота.

Durable artifact service разделяет read-only источники и создание служебных
результатов. Кэш tool output на 60 секунд не используется для долгой выдачи CSV/ZIP.
Перечисление миллионов записей выполняет отдельный потоковый обход, а не снятие cap
с `find_files`.
