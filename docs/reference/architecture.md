# Архитектура, форматы и ограничения

Описывает текущую архитектуру и границы пилота; исходная version 2.3.0 была на
`4f2625bf`. Исполнитель задачи, меняющей поведение, обновляет этот reference.
Исторические measurements остаются в [baseline](../testing/baseline-2026-09-19.md).

## Владельцы кода

| Область        | Файлы                                                                                     | Ответственность                                       |
| -------------- | ----------------------------------------------------------------------------------------- | ----------------------------------------------------- |
| CLI/entry      | `src/index.ts`, `src/cli.ts`, `src/core/config.ts`                                        | Аргументы, startup config, выбор транспорта           |
| Hosting        | `src/transport/`, `src/transport.ts`                                                      | stdio/HTTP и публичный facade export                  |
| Composition    | `src/server.ts`                                                                           | PathGuard, stores, registrars, lifecycle              |
| MCP tools      | `src/tools/index.ts`, `define.ts`, отдельные tools                                        | Inventory, read-only gate, schemas, dispatch/response |
| Guarded I/O    | `src/core/path.ts`, `path-utils.ts`, `guarded-open.ts`, `fs.ts`                           | Root policy, resolution, файловые операции            |
| Text/discovery | `src/core/read.ts`, `search.ts`, `mime.ts`, `glob.ts`, `list-walk.ts`, `source-ignore.ts` | Чтение, поиск, классификация, ignore                  |
| Resources      | `src/resources.ts`, `src/core/file-uri.ts`                                                | URI, text/blob delivery, subscriptions                |
| State          | `src/core/store.ts`, `page-store.ts`, `watcher-registry.ts`                               | Кэш результатов, страницы, уведомления                |
| Durable jobs   | `job-manager.ts`, `snapshot-pipeline.ts`, `bundle-pipeline.ts`                            | Общий lifecycle и producers                           |
| Validation     | `__tests__/`, `.github/workflows/ci.yml`                                                  | Unit/integration/stdio/HTTP tests и CI                |

Сначала искать существующего владельца поведения. Не обходить guard прямым
доступом к файлам в новом tool и не менять публичный transport export ради
внутренней перестановки.

## Возможности

### Граница guarded file I/O

`PathGuard` проверяет lexical/resolved roots и sensitive policy; возвращаемая
строка сама по себе не является разрешением на последующий syscall. Общий
[`guarded-open.ts`](../../src/core/guarded-open.ts) используется для source bytes:
все режимы text read (включая cached batch/search), raw originals/resources,
editable text, MIME sample, подсчёт строк, `open`, `openOriginal` и append.
Размер и тип реально читаемого файла проверяются через descriptor; raw read
ограничен также во время чтения. `openOriginal` сохраняет более строгий запрет
symlink/junction selectors и scratch, обычные read/append разрешают заранее
разрешённые in-root aliases.

Search сохраняет исходное имя в matches, а для stat/read передаёт canonical
`resolvedPath`, возвращённый той же проверкой `PathGuard`. В частности, реальное
Windows 8.3 имя не сравнивается с long spelling как с другим target; проверки
guarded open на смену пути и identity при этом сохраняются.

На Linux resolved leaf открывается с `O_NOFOLLOW|O_NONBLOCK`; перед bytes
проверяются regular-file type, pre-open/fstat identity и настоящий pathname
descriptor через `/proc/self/fd`. Он должен совпадать с validated canonical path
и проходить текущую root/sensitive policy. Недоступный procfs приводит к отказу,
а не к пропуску проверки. Подмена leaf на FIFO не блокирует open. Эти проверки
закрепляют открытый объект; они не замораживают содержимое или namespace после
проверки и не определяют происхождение hard links.

На Windows Node не предоставляет `O_NOFOLLOW`, `O_NONBLOCK` и final path
открытого HANDLE. Выполняются pre-open lstat, fstat identity и повторные
realpath/policy/lstat до bytes: final-component swap и устойчивый ancestor
junction swap отклоняются. Это **ограниченное hardening**, не доказательство
containment против процесса, способного многократно менять ancestors и
возвращать их между path probes (ABA). Для Windows и других платформ без
descriptor-path verification ancestors должны оставаться доверенными; полный
враждебный sandbox там требует отдельного native backend. Проверенная Windows
junction ветка не подменяет Linux descriptor evidence или недоступные file-symlink
tests. Враждебные mount/namespace изменения привилегированным процессом не входят
в эту гарантию.

Append существующего файла не использует `O_CREAT`, отсутствующего — использует
exclusive create; даже созданный descriptor проверяется до записи. При EEXIST
победивший файл открывается заново через тот же guard, без права cleanup.
При abort/failure cleanup проверяет policy, regular-file type и identity нашей
записи; при неоднозначности не удаляет чужое имя. Pathname cleanup не атомарен
против дальнейших namespace swaps. После parent escape при exclusive open может
остаться пустая запись: bytes не записываются, небезопасный unlink запрещён.
Abort во время open/fstat освобождает поздний descriptor; append остаётся
нетранзакционным и при abort во время записи может оставить prefix bytes.

`create` без `overwrite: true` или принятого overwrite confirmation использует
`O_CREAT|O_EXCL`, поэтому появившийся после planning файл не заменяется.
Подтверждение применяется к согласованному canonical target: если перед atomic
overwrite этот pathname разрешается уже в другую цель, запись отменяется.
Явный/подтверждённый overwrite сохраняет temp+rename и mode.
Identity содержимого между раундами подтверждения не связывается токеном;
подтверждение по-прежнему разрешает overwrite pathname. Остальные pathname
mutations, metadata, snapshot walk/jobs и undo/history этим изменением не
перерабатываются. См. [018](../tasks/018-guarded-io-race-hardening.md).

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

`list_roots` сохраняет `roots`/условный `hint` и добавляет `host: { name, machineId }`
и `rootDetails: [{ path, volume: { label, serialNumber } }]` в порядке roots.
Имя и системный UUID относятся к машине с MCP-процессом. Serial — номер тома
`XXXX-XXXX` (uppercase hex), не заводской номер устройства. Недоступные поля — null;
без roots возвращается пустой rootDetails. Общий provider
[`source-provenance.ts`](../../src/core/source-provenance.ts) использует `os.hostname`,
на Windows — `Win32_ComputerSystemProduct.UUID`, `GetVolumePathNameW` и отдельные
`GetVolumeInformationW` запросы label/serial. Поддерживаются подкаталоги, mount points,
mapped/UNC paths в пределах доступного ОС; metadata не расширяет root policy.
UUID пустой, нулевой, all-ones sentinel или неверного формата становится null.
PowerShell 5.1 helper получает path как environment data, возвращает UTF-8 JSON и
работает без elevation; локализованный `vol` не используется. Запросы независимы,
параллельны, каждый ограничен 3 секундами с остановкой дочернего процесса.
Timeout/error одного запроса сохраняет остальные поля и не ломает tool/job.
Кэша metadata нет. На других ОС UUID/volume fields — null, hostname при наличии.

## Выбор инструментов и трактовка инвентаризации

Краткая серверная инструкция, `get-help`/instructions resource и опубликованные
`tools/list` descriptions выбирают маршрут по намерению пользователя:

| Намерение                                              | Маршрут                                  |
| ------------------------------------------------------ | ---------------------------------------- |
| Доступные корни                                        | `list_roots`                             |
| Содержимое папки                                       | `list`                                   |
| Конкретное имя/glob                                    | `find_files`                             |
| Текст внутри файлов                                    | `search_text`                            |
| Рекурсивный индекс/инвентаризация/число видимых файлов | `snapshot -> job_status`                 |
| Сам индекс для анализа                                 | `snapshot -> job_status -> get_artifact` |
| Текст / metadata одного или нескольких путей           | `read` / `stat`                          |
| Один original                                          | `get_file`                               |
| Выбранные originals                                    | `bundle -> job_status -> get_artifact`   |

Известный root достаточен для `snapshot`; широкий `find_files(**/*)` перед ним
не требуется. Неизвестные дочерние пути открывают через `list`/`find_files`.
При нескольких canonical roots область выбирают явно по запросу, не подменяют
все roots первым. Snapshot строит metadata CSV/ZIP без копирования originals;
источники только читаются, служебное состояние/scratch меняются под прежними
ограничениями policy/quota/deadline. Отдельного counting tool или режима нет.

`find_files` и `search_text` принимают `limit` (default/cap 10000) и `pageSize`
(defaults 100/500, cap 10000), оба в диапазоне 1..10000. `maxResults` удалён
без alias; validation направляет к новым полям. Limit считает файлы / совпавшие
строки: occurrences (`matchCount`) и context не расходуют дополнительные единицы.
На N-м результате сбор останавливается без look-ahead. `stoppedReason=limit`
консервативно сообщает неподтверждённую полноту даже при exact N; `timeout` означает
частичный результат после deadline/cancel. Explicit TIMEOUT/CANCELLED также допустим.
`limit`, `truncated`, counters и stoppedReason одинаковы в `_meta` и JSON resource.
Оба JSON resources содержат объект результата с полным собранным массивом;
find_files больше не externalizes только массив без metadata.

Поиск использует bounded guarded ветку `globEntries` и walker 010, с Node
`path.matchesGlob` и прежним раскрытием hidden patterns. `maxDepth=0/1/2`
открывает root / также детей / также внуков; default/cap 100. `.gitignore` читается
только в открытом каталоге; предварительного recursive discovery нет. Hidden,
default exclusions, nested ignore/negation, PathGuard и no-follow при descent
сохранены. List по-прежнему считает глубину с 1; replace_text сохраняет свой
отдельный контракт и прежнюю ветку glob. Отмена проверяется перед/после I/O,
в filtering и line loops; поздние handles закрываются. Неотменяемый OS I/O
не прерывается принудительно. Ошибка directory traversal — explicit tool error;
best-effort чтение ignore rules сохраняет log warning.

Сортируется собранный набор, а не глобально первые N во всём дереве. Limit не
ограничивает просмотренные файлы/OS calls; редкий pattern может потребовать долгого
обхода в пределах depth/deadline. Явный file path в search_text читает ровно этот
файл, включая glob metacharacters в его имени, независимо от directory filters.
Cursor перелистывает собранный набор и не продолжает обход после limit/timeout.
Перед rows каждой частичной страницы, включая последнюю, стоит warning с effective
limit и смыслом totals. Next page — полный исполняемый JSON с path, filters,
limit, pageSize и cursor. Identity включает effective scope и все query options
кроме pageSize: его можно менять. Без cursor выполняется новый scan; TTL/stores
не изменились. [Протокол и live-матрица 011](../testing/011-bounded-search.md)
различают локальные wire проверки и ещё не выполненный целевой ChatGPT опыт.

`job_status` сохраняет JSON text и `structuredContent`. Во время queued/running
counters являются progress; даже `complete=true` в это время не доказывает завершение.
`completed` означает успешное завершение producer, но может сопровождаться
`complete=false`; failed/cancelled/interrupted не являются успешной инвентаризацией.
Проверяют оба поля, errors/fatalError, stopReason, metadataPersistence и expiry.
У завершённого snapshot `complete=true` относится к выбранной области, flags и
исключениям; это не обещание перечислить все физические файлы диска.

`filesWritten` — файловые записи, вошедшие в CSV, а не bytes originals или
гарантированное число уникальных физических файлов. `directoriesVisited` включает
открытый root; `entriesSeen` считает перечисленные entries без root и не является
числом файлов. `inaccessibleSkipped` включает отказы каталогов, итераторов и ignore
rules; прибавлять его к `filesWritten` как число дополнительных файлов нельзя.
Для сводных counters достаточно конечного status; artifacts получают для анализа
самого индекса или уточнения manifest policy/interval.

В результате называют root, flags/исключения и interval startedAt/finishedAt;
обход не atomic, reuse описывает прежний interval. Изменения source/.gitignore
автоматически не отслеживаются. Требуемую свежесть задаёт `maxAgeMs` от начала
обхода; `maxAgeMs=0` ещё допускает joining. `forceRefresh` нужен для явно нового
обхода, с optional `idempotencyKey` для safe retry, а не для каждого запроса.
Подробные reuse/TTL правила ниже остаются прежними. Протокол оценки фактического
выбора LLM: [009](../testing/009-tool-selection.md); локальные wire checks не
доказывают поведение модели в живом клиенте.

## Ограниченный list

`list` использует потоковый guarded walker в `core/list-walk.ts`. `maxDepth=1`
открывает только root, 2 — root и доступные дочерние каталоги; папки на границе
видны, но их содержимое и локальные ignore rules не читаются. `.gitignore`
загружается только для открытого каталога, до перечисления его детей. Hidden,
default exclusions, nested ignore/negation и PathGuard source policy действуют
до yield; symlink/junction entries не используются для рекурсии.

`limit` — общий максимум доступных entries (default/cap 20000), `pageSize` —
размер одного ответа (default 1000, cap 20000). Оба имеют диапазон 1..20000;
`maxEntries` удалён без alias, `maxPages` нет. Файлы, папки, symlink/other
считаются одинаково в limit. Policy-excluded raw entries могут потребовать
больше OS calls; depth и deadline дополнительно сдерживают работу.

После N-й допустимой записи обход закрывает все handles без look-ahead и
дальнейшего подсчёта дерева. `truncated=true`, `stoppedReason=limit` и
эффективный `limit` остаются в `_meta` каждой страницы и JSON resource;
`totalEntries/totalDirectories` считают собранный набор, а `totalFiles`
сохраняет прежнее значение: все non-directory entries, включая symlink/other.
При exact N тоже сообщается неподтверждённая полнота. Warning перед tree rows
на каждой странице объясняет limit, смысл totals и отсутствие scan continuation.
`complete=true` не добавляется. Без resourceStore warning/metadata те же.

Cursor хранит только этот набор, зависит от path/depth/flags/limit; pageSize можно
менять. Команда `Next page: list {...}` повторяет effective path, depth, flags,
limit и pageSize; её JSON можно исполнять без ручного восстановления scope.
Сортируется лишь собранный набор, не весь источник ради глобально первых N.
Resource выдаётся на первой странице при paging/truncation; TTL/cap stores прежние.
Контекст отсутствующего на странице родителя показывается отдельной relative
строкой, поэтому nested rows на поздних страницах не теряются из текста.
Отмена проверяется до/после перечисления, включая excluded entries и ignore reads;
активный неотменяемый opendir/read завершается, после чего handle закрывается.
Принудительного прерывания зависшего OS I/O нет; TIMEOUT/CANCELLED не выдаются
как успешные полные results. Общий glob соседних tools сохраняет свой контракт.

Проверки и следующий live: [010 bounded list](../testing/010-bounded-list.md).

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

## Формат snapshot: tree по умолчанию (016)

Канонический `snapshot` создаёт tree-depth-v1. Runtime `FS_SNAPSHOT_FORMAT` и
portable `snapshotFormat` принимают только tree (default) или stable; неверные
значения останавливают запуск. В обоих режимах 19/13 tools, отдельного
snapshot_tree в discovery нет. Обычные inventory instructions ведут в snapshot.
Portable очищает inherited FS_*; старый boolean experimentalSnapshotTree
валидируется для совместимости, но не выбирает формат. Для прежнего CSV нужно
явно задать `"snapshotFormat": "stable"`; FS_EXPERIMENTAL_SNAPSHOT_TREE игнорируется.

Общий `snapshot-pipeline.ts` выдаёт в tree-режиме D/F/U события из прежнего
guarded depth-first walker. Источник не читается вторично, stat каталога не
добавлен. Writer хранит стек имён глубины и текущий spool; ZIP, quotas, commit,
TTL и delivery остаются общими. Stable CSV/manifest и его normalized identity
не изменены. Для tree discriminator `layout: tree-depth-v1` добавлен в normalized
input и все три fingerprints (ordinary/reuse/request). Job kind остаётся snapshot.
Один idempotency key между форматами конфликтует. Выбор creation-формата не входит в captured
config/policy identity: stable/tree status/fetch/cancel работают после смены
режима и restart по прежним правилам TTL/authorization. Сохранённые 014/015
tree jobs имеют тот же layout/fingerprint и остаются кандидатами для reuse.

Каждая часть: одна CSV-запись absolute sourceRoot, header
`Type,Depth,Name,Length,LastWriteTime`, затем basename/depth записи. UTF-8 без BOM,
CRLF и RFC 4180, включая quoting root и имён с CR/LF. Depth 0 — содержимое
sourceRoot, сам sourceRoot не дублируется как D. D включает пустые в выборке
каталоги, F — bytes/UTC metadata. C в начале следующей части восстанавливает
ancestor stack 0..N-1. U уточняет уже экспортированный D при child open/readdir
или ignore-read failure; это incomplete каталог, а не дополнительный объект.
Root open/readdir и policy/storage failures остаются fatal. Физическая пустота
каталога при exclusions/ошибках не утверждается.

Tree manifest имеет отдельную schema `filesystem-mcp.snapshot-tree-manifest`,
version 1 и layout `tree-depth-v1`, root/provenance/policy/errors/complete.
Part `rows` включает root/header/D/F/C/U; `files`, `directories`,
`contextRecords`, `errorRecords` разделены. В status добавлен optional layout,
в counters — directoriesWritten/contextRecords/errorRecords только для tree.
Root/header/context учитываются в maxRecordBytes/raw-part/job-raw/scratch limits;
невмещающиеся preamble+context+объект дают TOO_LARGE до следующей части.
SHA/CRC и независимый readback, A/B и ограничения: [014](../testing/014-snapshot-tree.md).

## Лимиты и контракт результата

| Ограничение                           | Baseline default / cap                                                            | Владелец                        |
| ------------------------------------- | --------------------------------------------------------------------------------- | ------------------------------- |
| Полное чтение/raw resource/`get_file` | 10 MiB; конфиг 1–100 MiB                                                          | `core/util.ts`, `core/fs.ts`    |
| `get_file` wire blob                  | Base64: ровно `4 * ceil(raw bytes / 3)` символов; отдельного configurable cap нет | `tools/get-file.ts`             |
| Batch read budget                     | 512 KiB по умолчанию                                                              | `core/util.ts`, `tools/read.ts` |
| Search timeout                        | 5 секунд; конфиг 100–60000 ms                                                     | `core/util.ts`                  |
| Search results                        | До 10000 собранных результатов; page size отдельно                                | `core/util.ts`, search tools    |
| List entries                          | limit default/cap 20000; pageSize default 1000, cap 20000                         | `core/util.ts`, `tools/list.ts` |
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

Новые snapshot/bundle jobs перед чтением source фиксируют `provenance: { host, root }`
и сохраняют checkpoint в `job.json`; `root` повторяет форму элемента rootDetails
с фактическим guarded sourceRoot, в том числе выбранным подкаталогом. Оба manifest
получают сохранённое значение. Reuse и fetch не вызывают provider; restart не
подменяет происхождение текущими сведениями машины. Поле optional для совместимости:
legacy jobs/manifests без него читаются без миграции и переписывания artifacts,
`schemaVersion: 1`, прежние rootId/reuse fingerprints и формат CSV/ZIP сохранены.
Provenance описывает происхождение, а не целостность/уникальность носителя или
его неизменность за время обхода.

`job.json` заменяется через уникальный metadata-temp и atomic rename без удаления
старого destination. Только transient `EPERM`/`EACCES`/`EBUSY` при rename повторяются
до 2,5 секунды на одну запись; checkpoint retry прерывается при cancel/timeout/close.
Terminal write после первого transient отказа получает ещё одно ограниченное окно
2,5 секунды, итого до примерно 5 секунд на terminal recovery. Записи одной job
сериализованы, а одновременные terminal writers упорядочены. Metadata-temp
резервируется в scratch quota на время записи и удаляется после отказа; неудачное
удаление учитывается как orphan. `ENOSPC`, quota и неизвестные ошибки не получают
transient retry. Сроки относятся к ожиданию повторов и не ограничивают зависшую
саму OS filesystem operation или неотзывчивый producer.

После отказа terminal save живой `job_status` показывает optional
`metadataPersistence: {state: recovering|failed, error}` с безопасными bounded
code/message/path/native diagnostics. Это поле только в памяти, не в `job.json`;
успешное восстановление его убирает. При постоянном отказе server log фиксирует
ошибку, live state остаётся доступным до остановки процесса, но durable state
не гарантирован. `close` ждёт bounded metadata retries; после restart последний
доступный `job.json` со старым `running`/`queued` становится `interrupted`, без
выдуманного fatalError от несохранённого terminal результата. Если scratch вновь
доступен, startup сохраняет `interrupted`. Внешний долгий file handle, недоступный
диск и внезапное завершение процесса вне recovery window остаются ограничениями.
Частый `getJob`/`job_status` работающей job читает in-memory state и не открывает
`job.json`; снижать частоту status ради корректности записи не требуется.

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
Non-fatal `ACCESS_DENIED` sample получает безопасное `Permission denied` без
формулировки о провале всей job; code/counters/path остаются прежними. Fatal
diagnostics также используют фиксированный текст и не называют ошибку пропуском.
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

Bundle manifest v1 (`filesystem-mcp.bundle-manifest`) — отдельный JSON artifact.
`root` по-прежнему содержит только ID; новый `provenance.root.path` содержит абсолютный
путь source вместе с host/volume metadata. Он также содержит interval/caveat, limits, `complete`,
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
