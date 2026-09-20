# 003: фоновый snapshot с выдачей сжатых частей

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятая 002-tool / PR #3.
Пользователь разрешил подготовить и запустить реализацию 2026-09-20.
Рабочая ветка: `codex/003-compressed-snapshot`, отдельный worktree.

## Зачем и источники

Ассистент должен запустить обход большого разрешённого каталога, позднее получить
его состояние и скачать сжатый индекс частями без ручной нарезки и повторного обхода.
Пользовательский CSV содержит 2 899 231 запись / 448,51 MB; общий ZIP 35,16 MB.
Самостоятельные ZIP существующих частей занимают 1,47–5,53 MB. Исходный обход,
по словам пользователя, занимал 20–30 минут. Малые ZIP/XLS через get_file уже
материализованы в ChatGPT; передача больших частей пока не доказана.

Прочитать:

- [Brief](../project/brief.md), [workflow](../development/parallel-work.md),
  [Windows runbook](../development/windows.md), [architecture](../reference/architecture.md).
- [Согласованную основу 003/004](../project/snapshot-bundle-design.md) и
  [обезличенные измерения CSV](../testing/snapshot-shape-2026-09-20.md).
- [Текущий протокол доставки](../testing/tool-originals-delivery.md).

Эта карточка фиксирует scope реализации. Документ дизайна объясняет решения;
устаревшие proposed/не назначено в исторических материалах не отменяют разрешение.
Производственный ZIP и чужой checkout не являются зависимостью новой задачи.

## Scope и владение

003 реализует общий механизм jobs/artifacts и snapshot как первый сценарий:
фоновый обход metadata, CSV, независимые ZIP-части, manifest, статус, отмену,
получение результатов, лимиты, срок хранения и очистку. Общие компоненты должны
позволять добавить producer выбранных originals в 004 без второго lifecycle.

Владение: нужные изменения `src/core/`, composition `src/server.ts`, transports,
MCP tools/регистрация/инструкции, config, тесты, synthetic benchmark, reference,
runbook, протокол проверки и Work record этой карточки. При необходимости разрешена
минимальная зависимость для корректной потоковой ZIP-записи: обосновать выбор,
лицензию и footprint; не писать собственную реализацию ZIP ради отсутствия зависимости.

Вне scope: сборка выбранных originals (004), чтение/хеширование их содержимого,
парсеры документов, индексная БД, embeddings, OCR, OAuth/multi-user, публичный
файловый сервер, автоматическое продолжение обхода после падения процесса.
Версии package.json/server.json не менять. Центральную доску ведёт планирование.

## Контракт первой версии

### Запуск и состояние

- Базовый API — обычные MCP tools. Рабочие имена: `snapshot` для запуска,
  `job_status`, `cancel_job`, `get_artifact`; окончательные имена/schema записать
  в Work record. Native MCP Tasks/notifications не являются условием работы клиента.
- Один явно выбранный source root на job, существующий guarded path resolution.
  Параметры обхода и применённые ограничения фиксируются в manifest. Include-ignored
  сохраняет существующую семантику, не отключает PathGuard.
- Submit быстро возвращает jobId и состояние. Не ждать файлового обхода или ZIP.
  Idempotency key обязателен: same key + те же нормализованные параметры в текущем
  endpoint scope возвращают ту же job, включая параллельный submit/потерянный ответ.
  Другие параметры с тем же key дают conflict. Terminal job не перезапускается
  повторным submit; для нового обхода нужен новый key. Срок удержания key описать
  явно и сохранять не короче жизни job/результата; восстановить его после restart.
- Состояния queued/running/completed/failed/cancelled/interrupted. Истёкший результат
  явно недоступен; его нельзя выдавать как готовый пустой snapshot. Статус содержит
  фазу, elapsed, точные счётчики, bytes, ограниченные примеры ошибок, manifest ID
  и время истечения готового результата. Не выдавать весь inventory в tool text.
- Disconnect/таймаут submit после регистрации job не отменяет её. У job собственный
  AbortController; не удерживать request context, signal или callback уведомлений.
  Явная отмена идемпотентна и освобождает незавершённые результаты. Статус terminal
  не переписывается поздним завершением worker; гонки completion/cancel проверяются.
- Один manager на HTTP endpoint, доступный всем per-request createServer. Для stdio
  один владелец на процесс/соединение. Закрытие отдельного HTTP-запроса его не чистит.

### Обход и формат

- В первой версии строки CSV описывают обычные файлы. Каталоги обходятся;
  symlink/junction внутри дерева не разыменовываются, их пропуски учитываются.
  Каноническое разрешение самого root и Windows aliases сохраняют текущий guard.
- Источники читаются только через PathGuard/GuardedFileSystem. Реальный потоковый
  обход должен ограничивать очередь, открытые handles, ignore rules и ошибки.
  Не собирать/сортировать весь массив; не снимать cap с list/find_files вместо
  нового обхода. Существующий globEntries заранее собирает .gitignore — учесть это.
- CSV v1: UTF-8, одинаковый header каждой части, документированные quoting/newline.
  Поля `RootId,RelativePath,Name,Extension,Length,LastWriteTime`: путь относительно
  root с документированным разделителем, Length в bytes, время ISO 8601 UTC.
  RootId разрешается через manifest. Не называть relative path полем FullName.
  Разбиение по целым CSV-записям, включая non-ASCII, quotes и multiline; bytes
  header/BOM/newline входят в лимит. Пустой Extension допустим.
- Snapshot описывает интервал наблюдения, не атомарный FS snapshot. Manifest v1
  содержит root, фильтры/policy, start/end, count, completeness, ошибки/пропуски,
  причины остановки и части. Плановые исключения отделены от неожиданных failures.
  Completed не означает complete=true при недоступных/исчезнувших элементах.
  Silent truncation недопустим; исчерпание жёсткой квоты/непомещающаяся запись
  завершают job понятной ошибкой, не притворяются полным успешным результатом.

### Упаковка, доставка и lifecycle

- Потоковая сериализация и сжатие с backpressure. Не нужен полный несжатый snapshot
  перед упаковкой. Разрешён ограниченный spool текущей части в scratch, если нужен
  для точного соблюдения ZIP cap/переразбиения; его bytes тоже входят в дисковую квоту.
- Результат: небольшой manifest и самостоятельные обычные ZIP-части. Каждая часть
  отдельно распаковывается; multipart ZIP и один безразмерный итоговый архив не нужны.
  В manifest записаны rows, raw/ZIP sizes, SHA-256 артефакта и идентификаторы частей.
  Не публиковать .partial/незакрытый ZIP. Готовые bytes неизменны до удаления.
- get_artifact принимает opaque artifactId, возвращает одну готовую ограниченную
  часть или manifest стандартным embedded resource + matching resource_link,
  используя совместимый с get_file способ выдачи. URI или manifest без полученных
  bytes не считаются доставкой. Идентификатор не является разрешением доступа.
- Источники и служебное хранилище разделены. Scratch не добавляется в общие
  source roots и не попадает в свой snapshot: отдельный root либо обязательное
  canonical исключение subtree, зафиксированное в manifest. Не принимать произвольный
  output path от tool caller. Tool handlers не делают прямое незащищённое FS I/O.
- Status/cancel/fetch проверяют текущий доступ к canonical source root, в том числе
  после restart с суженными roots/grants. Текущий один HTTP auth context остаётся
  одним endpoint scope; изоляцию пользователей не заявлять.
- Jobs/metadata/готовые части хранятся на диске с атомарной фиксацией metadata.
  После restart активные jobs становятся interrupted, готовые части доступны до TTL.
  Автоматического resume обхода нет. Cleanup удаляет только собственные файлы
  внутри проверенного scratch, защищает активные writes/reads, учитывает ENOSPC
  и ошибки компрессии. TTL готового результата отсчитывается от completed.
- Source read-only режим сохраняется: jobs могут писать только служебный scratch.
  Текущая регистрация связывает --read-only с readOnlyHint: отделить разрешённость
  служебной операции от честных annotations submit/cancel. Файловые mutating tools
  по-прежнему отсутствуют в --read-only. Источники не изменяются.

## Лимиты и конфигурация

Все единицы явные; MB=1 000 000 bytes, MiB=1 048 576 bytes. Раздельно ограничить
размер записи, raw CSV-части, закрытого ZIP, выдачи, всей job, scratch, числа jobs/частей,
времени работы и TTL. Base64 занимает `4 * ceil(zipBytes / 3)` плюс JSON/metadata;
текущий механизм выдачи буферизует одну часть, поэтому ограничить и параллельные выдачи.

Стартовый локальный профиль: CSV-часть до 45 MiB, ZIP до 8 MiB, одна выполняющаяся
job, ограниченная очередь, время job до 60 минут, TTL готового результата 24 часа,
общая дисковая квота 1 GiB. Остальные caps и их допустимые диапазоны выбрать
и записать до benchmark; менять эти ориентиры при измеренной необходимости можно
самостоятельно с обоснованием. Уважать более строгие действующие file-size limits.

Проверять конечный размер ZIP с overhead; плохое сжатие не обходить превышением cap.
Допустим понятный bounded failure вместо сложного переразбиения. Для выбранного
рабочего профиля обычный synthetic набор около 3 млн записей должен успешно пройти.
Числа выше — локальные настройки, не доказанные лимиты ChatGPT. До live проверки
документация должна явно различать локальную готовность и целевую доставку.

## Acceptance

- [x] Контракт и настройки документированы; submit/status/cancel/fetch работают
      в stdio и последовательных независимых HTTP-запросах, в source read-only режиме.
- [x] Повторный и параллельный submit с одним key не дублирует обход; конфликт
      аргументов отклоняется. Потерянный ответ, disconnect и короткий client timeout
      не уничтожают принятую job; последующий статус её видит. Отмена и shutdown проверены.
- [x] Настоящий synthetic FS walk более 20 000 файлов: точное множество/число строк
      на неизменяемом дереве, без пропусков/дублей. Unicode,
      пустое расширение, Windows paths/aliases, inaccessible/disappearing files,
      escape junction, ignore semantics и исключение scratch проверены.
- [x] Отдельный synthetic pipeline benchmark: около 3 млн metadata records /
      450–500 MB raw с реалистичной длиной строк; bounded streaming, все части проверены
      независимым verifier (ZIP integrity, CSV parsing, schema, counts, SHA-256).
      Проверить плохо сжимаемые данные, граничные размеры и CSV quoting/multiline через
      synthetic metadata или POSIX fixtures: не требовать запрещённых символов в Windows
      именах файлов. Production input не нужен.
- [x] Записаны elapsed, peak RSS/heap, peak disk, rows/raw/ZIP/base64 bytes и число
      частей. При одинаковых caps сравнить меньший и большой pipeline: память не растёт
      пропорционально числу строк. Ориентир standalone benchmark — peak RSS <256 MiB;
      отклонение объяснить и устранить источник неограниченного роста перед handoff.
      Полный benchmark выполнить локально; не помещать 3 млн файлов в обычный CI.
- [x] Disk/size/job quotas, ENOSPC, compression failure, cancel/complete races,
      TTL/cleanup concurrent with read, restart и сужение доступа воспроизводимо проверены.
      Нет утечки partial artifacts и выдачи неавторизованных bytes.
- [x] Полный npm run check, relevant HTTP/stdio tests, reference, runbook и
      воспроизводимый benchmark/protocol обновлены. Skips и их причины указаны.
- [ ] После локальной готовности — synthetic live ChatGPT прогон с пользователем:
      start/status/получение manifest и нескольких частей, независимые hashes,
      распаковка и CSV counts. Size ladder включает архив около 5,53 MB и выбранную
      рабочую границу; записать raw/ZIP/wire sizes, таймауты/ошибки и повторную выдачу.
      Не загружать production архив. Если этот шаг ждёт пользователя/среду, закончить
      локальную реализацию, закоммитить и явно передать pending live, не заявляя done.

## Порядок работы и handoff

Исполнитель самостоятельно выбирает routine implementation details в этом scope,
делает небольшие последовательные commits: контракт/общая основа, pipeline,
проверки/документация. Сначала зафиксировать решения в Work record, затем реализовать;
не добавлять повторное согласование для уже разрешённых операций. Material scope
changes передавать планированию с конкретным предложением. 004 параллельно не запускать.

Локальные проверки выполнить самостоятельно. Подключение стенда и ChatGPT проверять
с пользователем пошагово по действующему runbook; повторно использовать настройки
только после проверки их актуальности. Не публиковать секреты и production input.
Обновить Work record, создать локальные commits и передать SHA/проверки/риски.
Push, PR и merge оставить планированию до отдельной команды пользователя.

## Work record

Реализация начата 2026-09-20.

- Base и branch: `ce4f22b4f9ca453d915100c3206363d96dc6d208`,
  `codex/003-compressed-snapshot`, отдельный worktree приложения.
- Контракт tools, schema/manifest и defaults: выбраны `snapshot`, `job_status`,
  `cancel_job`, `get_artifact`. `snapshot` принимает обязательные `path` и
  `idempotencyKey`, а также `includeHidden` / `includeIgnored`; status/cancel/fetch
  принимают opaque ID и повторно проверяют доступ к canonical source root. CSV v1:
  UTF-8 без BOM, CRLF, RFC 4180 quoting, header
  `RootId,RelativePath,Name,Extension,Length,LastWriteTime`; relative paths всегда
  POSIX, timestamp — ISO 8601 UTC. Manifest JSON v1 является отдельным immutable
  artifact и перечисляет ZIP-части. Defaults до benchmark: raw CSV part 45 MiB,
  ZIP artifact/delivery 8 MiB, record 1 MiB, 128 parts/job, 512 MiB/job,
  1 running + 4 queued jobs, 60 minutes/job, TTL 24 hours, scratch quota 1 GiB,
  2 concurrent artifact reads. Настройки задаются отдельными `FS_SNAPSHOT_*`
  variables; MB/MiB в документации не смешиваются.
- Что изменилось и почему: общий disk-backed manager реализован endpoint/process
  scoped и producer-neutral, чтобы 004 добавил producer, а не второй lifecycle.
  Metadata фиксируется atomic temp+rename с bounded Windows retry; restart сохраняет
  completed artifacts и переводит queued/running в `interrupted`, без resume.
  Scratch выбирается оператором (`FS_SNAPSHOT_DIR`) либо стабильно создаётся в
  системном temp; один каталог имеет одного владельца-процесс. Он не становится
  source root: source внутри scratch отклоняется, scratch subtree внутри source
  канонически исключается. HTTP manager живёт дольше per-request server, stdio
  shutdown ожидает manager close. Idempotency submit сериализован, чтения имеют
  отдельный semaphore, cleanup не удаляет artifact во время активного read.
- Pipeline: bounded `opendir` walk через `GuardedFileSystem`, nested `.gitignore`,
  default/hidden filters, без следования symlink/junction; CSV режется только на
  границе записи и текущая raw часть spool-ится в scratch. `yazl` выбран как малая
  streaming ZIP dependency (MIT; одна runtime dependency `buffer-crc32`); `yauzl`
  и `csv-parse` используются только независимым test/benchmark verifier.
- Команды, результаты, среда и skips: Windows, Node.js 24.15.0. `npm run build`,
  `npm run type-check`, `npm run type-check:test`, `eslint .`, `knip` и targeted
  snapshot/HTTP/stdio tests проходят. Полный `npm test`: 367 tests, 360 pass,
  0 fail, 7 skips. Skips существующие: одна POSIX inode/mode проверка, одна POSIX
  0222 проверка и пять сценариев symlink, недоступных текущему Windows runner.
  `npm run check` выполнен, но останавливается только на унаследованном Prettier
  mismatch в `docs/project/status.md` и `docs/testing/snapshot-shape-2026-09-20.md`;
  первый файл запрещено менять этой задачей. Все изменённые файлы проходят отдельный
  `prettier --check`; последующие knip и полный test выполнены отдельно.
- Benchmark (walk отдельно от metadata pipeline): воспроизводимый runner и полные
  результаты в [snapshot benchmark](../testing/snapshot-benchmark-2026-09-20.md).
  3 000 000 записей: 478 889 517 raw bytes, 50 373 149 ZIP bytes, 11 частей,
  152,320 s, peak RSS 236 810 240 B, heap 76 750 992 B, scratch 96 691 088 B,
  base64 67 170 596 chars; independent ZIP/CSV/hash verifier PASS. 100 000 строк
  дали peak RSS 132 177 920 B: 30x rows при 1,79x RSS. Real walk: 21 000 файлов,
  exact set/count, 8,021 s, peak RSS 140 468 224 B. Poor-compression профиль
  boundedly отказал на 8 MiB ZIP cap без опубликованных partial artifacts.
- Live evidence / что ожидает пользователя: локальная реализация готова; pending
  целевой synthetic ChatGPT прогон по [live protocol](../testing/snapshot-live.md).
  Нужны materialized manifest и минимум три ZIP-части, включая около 5,53 MB,
  независимые hashes/распаковка/CSV counts/повторная выдача и size ladder. SDK/local
  delivery не отмечается как live PASS; production input запрещён.
- Выполненные и оставшиеся acceptance: локальные contract/lifecycle/walk/benchmark/
  quota/error/security checks выполнены. Не закрыты полный aggregate check из-за
  двух base formatting mismatches и отдельный live ChatGPT опыт, поэтому карточка
  не передаётся как `done`.
- Локальные commits: `f126d63d` (контракт), `63f4f08f` (основная реализация) и
  `1ce57b7c` (hardening, regression suite, benchmark и документация).
- Ограничения и handoff: source snapshot не атомарен; v1 не читает и не хеширует
  содержимое originals, не разыменовывает symlink/junction, не возобновляет job после
  restart и не заявляет multi-user isolation.

### Доработка после review `bc6724fb`, 2026-09-20

- В ветку обычным merge включён точный локальный `main` commit `bc6724fb`; merge
  commit `ec6cf8a9`. Центральная доска вручную не менялась.
- R1: cache уникальных путей внутри активных `ignore` matcher ограничен 256 tests;
  matcher пересоздаётся из скомпилированных rules публичным API. Regression сохраняет
  nested ignore/negation после нескольких refresh. Настоящие walk-21k/walk-60k с
  `.gitignore` и одинаковой instrumentation дали 2,86× files при 1,17× peak RSS и
  1,28× peak heap.
- R2: ZIP теперь получает явно управляемый source stream; ошибки source/producer
  передаются output consumer, все streams/handle закрываются. Fault injection удаляет
  raw spool перед compression: job становится `failed`, ready/partial artifacts нет,
  следующий job в том же manager завершается успешно.
- R3/R4: artifact removal и expiry/terminal cleanup сериализованы per job. Quota
  освобождается после фактического удаления; failed deletion остаётся charged.
  Startup удаляет только manager-owned partial/metadata-temp и UUID ZIP/JSON,
  распознаёт orphan final после rename-before-metadata и повторяет cleanup на restart.
  Concurrent cleanup, quota-vs-disk, injected delete failure, второй restart и
  сохранение чужого файла покрыты regression tests.
- R5: walker относит только ожидаемые NOT_FOUND/access ошибки к partial completeness;
  превышение depth и остальные hard failures завершают job как `failed` без manifest.
- R6: общий benchmark verifier требует один CSV, полный конец ZIP, strict independent
  CSV parse и собственный CRC-32 распакованных bytes. Extra entry, bad CRC, truncation
  и corrupt compressed bytes отклоняются. Small/large benchmark повторён этим verifier.
- R7: producer применяет минимум snapshot ZIP/delivery/captured general-file caps и
  записывает его в manifest policy; manifest учитывает также текущий file cap. Fetch
  сохраняет повторную проверку текущего `FS_MAX_FILE_SIZE`. Оба более строгих cap дают
  bounded failure без manifest/ready artifacts.
- Acceptance gaps закрыты отдельными сценариями: HTTP response loss после принятого
  submit с recovery тем же idempotency key; cancel до и после artifact rename;
  independent CSV round-trip через принудительные part boundaries; cancel/fetch при
  суженном доступе до и после restart; poor-compression runner утверждает отсутствие
  manifest, ready и partial artifacts.
- Проверки: targeted snapshot suite — 20/20 pass. Полный `npm run check` — 378 tests,
  371 pass, 0 fail, 7 прежних Windows skips (POSIX inode/mode, POSIX 0222 и пять
  symlink-permission сценариев). На перегруженном desktop host `tsx` до запуска tests
  получил системный `uv_os_get_passwd ENOMEM`; полный check повторён с локальным
  untracked fallback только для имени temp-cache `tsx`, после проверки dependency
  восстановлена. Код/fixtures и результаты тестов workaround не менял.
- Повторный benchmark: 100 000 rows — 15 788 947 raw B, 1 698 026 ZIP B, 4,041 s,
  peak RSS 138 436 608 B; 3 000 000 rows — 478 889 517 raw B, 50 373 149 ZIP B,
  11 parts, 173,841 s, peak RSS 238 374 912 B, heap 76 753 088 B, scratch
  96 829 298 B. High-entropy 300k boundedly отказал без artifacts. Полные числа и
  команды — в [benchmark report](../testing/snapshot-benchmark-2026-09-20.md).
- Локальные follow-up commits: `009744ee` (runtime hardening), `16021c0c`
  (regressions и verifier), `6af551fa` (documentation/evidence), `9dc36647`
  (старый byte-extraction helper также пропущен через строгий verifier).
- Live ChatGPT остаётся `pending` до повторного review и совместного запуска по
  [protocol](../testing/snapshot-live.md). Локальные результаты не объявляются live PASS.
- Состояние локального handoff: `ready for review`; push, PR и merge не выполнялись.
