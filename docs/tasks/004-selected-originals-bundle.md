# 004: bundle выбранных оригиналов для анализа

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятая 003 / [PR #4](https://github.com/obolibok/filesystem-mcp/pull/4),
merge `2de005ec`; planning checkpoint после приёмки — `ecfc02f8`.
Пользователь разрешил подготовить и запустить реализацию 2026-09-20.
Рабочая ветка: `codex/004-selected-originals-bundle`, отдельный worktree.

## Зачем и контекст

Ассистент изучает snapshot или результаты поиска, выбирает конкретные originals
из разных подпапок и одним запросом заказывает пакет для анализа. Коннектор читает
ровно выбранные файлы, сохраняет их bytes и происхождение, сжимает и доставляет
через готовый jobs/artifacts lifecycle. После анализа ассистент может выбрать
следующий набор. Предметный выбор выполняет принимающий ИИ; сервер остаётся
универсальным файловым коннектором.

Прочитать [brief](../project/brief.md), [workflow](../development/parallel-work.md),
[Windows runbook](../development/windows.md), [architecture](../reference/architecture.md),
[основу 003/004](../project/snapshot-bundle-design.md),
[итог интеграции 003](../testing/003-integration-2026-09-20.md) и
[живой опыт](../testing/003-live-2026-09-20.md).

003 уже реализует snapshot, job_status, cancel_job, get_artifact, TTL, quotas,
restart и доставку. В ChatGPT проверен ZIP 7802264 B, включая повторную выдачу;
это максимальный проверенный размер, не установленный предел host. Сжатие CSV
не предсказывает сжимаемость PDF/XLS/ZIP или других originals.

Эта карточка — контракт разрешённой реализации. Исторические proposed в документах
003 не отменяют назначения 004. Чужие checkout, ignored scratch, Downloads,
производственные файлы и сохранённый ключ не являются зависимостями задачи.

## Scope и владение

Добавить producer bundle и публичный tool `bundle`, используя один существующий
manager и storage lifecycle. Допустимы необходимые изменения core/GuardedFileSystem,
tool schemas, config, composition/регистрации/инструкций, tests, synthetic harness,
reference, runbook и Work record этой карточки. Минимальное обобщение snapshot-only
типов/счётчиков/артефактов разрешено; совместимость snapshot сохраняется.

Центральную доску ведёт планирование. Вне scope: автоматический рекурсивный выбор
папки, glob/selectors, несколько независимых source roots в одном bundle, подбор
файлов по смыслу на сервере, парсеры/OCR, изменения originals, vector DB, OAuth,
публичные download URLs, разрезание одного оригинала между частями, возобновление
незавершённой job после restart. Не менять версии package.json/server.json.
Использовать существующую ZIP-зависимость; новую добавлять только при доказанной
необходимости, с объяснением лицензии и footprint.

## Контракт первой версии

### Выбор и запуск

Tool `bundle` принимает один `path` — явно выбранный guarded directory, обязательный
`idempotencyKey` и непустой ограниченный массив `files`. Один элемент содержит
`relativePath` и необязательный `expected` с парой `size` / `lastWriteTime` для
проверки против metadata из snapshot. Зафиксировать точные schemas в reference.
Пример формы запроса (имена и пути synthetic):

```json
{
  "path": "<allowed source directory>",
  "idempotencyKey": "bundle-board-001",
  "files": [
    { "relativePath": "Daum/board-A/program.smf" },
    { "relativePath": "Inoplacer/board-A/program.asc" },
    { "relativePath": "Documents/board-A/parts.csv" }
  ]
}
```

- `relativePath` обозначает один обычный файл внутри выбранного root; папка не
  означает рекурсивное включение. Формат разделителей — `/`, как у snapshot.
  Не угадывать файл по basename и не расширять список соседними файлами.
  Явный выбор использует политику чтения get_file: discovery ignore rules не должны
  молча выкидывать выбранные originals; sensitive-path policy guard остаётся в силе.
- Запретить absolute/drive/UNC/device paths, `..`, NUL, ADS и выход за root.
  Проверять requested и resolved paths существующим guard. Не разыменовывать
  symlink/junction в выбранном относительном пути. Windows 8.3 spelling самого
  root должен работать по правилам 003 и не ослаблять запрет настоящих ссылок.
  Наличие другого каталога в общей allow-list не разрешает выход из выбранного root.
- Повторяющиеся выбранные пути отклонять; aliases одного canonical path не должны
  создавать две записи. Разные имена файлов с одинаковыми bytes остаются разными
  originals; content deduplication не требуется. Не нормализовать Unicode с потерей
  различий и не сливать одноимённые файлы из разных подпапок.
- Порядок массива не меняет смысл выбора: kind bundle, canonical root,
  нормализованный набор и preconditions участвуют в fingerprint. Same key + тот же набор возвращает ту же job, в том
  числе после потери ответа/restart; изменение набора/expected даёт conflict.
- Submit выполняет bounded schema/root validation и регистрацию; чтение originals,
  обход массива с source I/O и сжатие выполняются worker, не удерживают HTTP call.
  Ограничить число путей и суммарные bytes selection/metadata; не переносить большой
  список или содержимое файлов в text ответа. Опубликовать defaults и caps.
- Существующие `job_status`, `cancel_job`, `get_artifact` обслуживают bundle.
  Использовать фазы и счётчики requested/included/skipped, source/ZIP bytes, parts;
  не выдавать snapshot CSV counters как единственный смысл bundle progress.

### Содержимое и происхождение

- Читать originals через GuardedFileSystem; при необходимости добавить bounded
  чтение/streaming на этой границе. Прямой unguarded source I/O из tools/producer
  запрещён. Scratch не становится allowed source; выбирать его output path нельзя.
- Каждый включённый оригинал сохраняет bytes без декодирования, перекодирования,
  парсинга, перепаковки вложенного ZIP или изменения переносов строк.
- Обычные самостоятельные ZIP-части содержат целые файлы. Сохранить относительную
  структуру путей под отдельным префиксом, например `files/`, и однозначное
  соответствие archive entry ↔ исходный relativePath. Служебный manifest не должен
  конфликтовать с файлом пользователя. Не создавать entries с traversal или
  коллизиями при целевой распаковке; неподдерживаемое имя явно отклонить.
- Внешний ограниченный manifest — отдельный artifact. Он содержит schema version,
  job/root ID, интервал сборки, применённые лимиты, complete, итог каждого выбранного
  файла, исходный relativePath, expected (если задан), наблюдавшиеся metadata,
  фактические size/SHA-256 включённых bytes, part/artifact ID и archive entry.
  Для каждой ZIP-части — size/SHA-256, число файлов, raw bytes. Локальные абсолютные
  пути и secrets не включать. Принимающая среда не зависит от внутренних filenames.
- Не публиковать полный manifest в tool text. Ограниченный status содержит summary,
  samples ошибок и ссылки/IDs; детали доступны через manifest artifact.

### Изменения, ошибки и полнота

- До чтения сверить optional expected size/mtime; несовпадение — `changed`, такой
  файл не включать. Сравнить identity/size/mtime до и после захвата bytes, считать
  hash именно упакованных bytes. Наблюдаемая замена/изменение во время чтения также
  исключает этот файл. Не публиковать mixed/truncated bytes как успешный оригинал.
- Проверки metadata не дают атомарного snapshot файловой системы и не гарантируют
  обнаружение любой записи с восстановленным mtime. Честно описать предел метода;
  не обещать побайтовое соответствие историческому snapshot без content hash.
- Missing/disappeared, OS-level inaccessible, directory/special file, изменившийся
  файл и превышение per-file/одной ZIP-part cap — явный результат этого элемента.
  Остальные допустимые файлы могут быть собраны: job `completed`, но `complete=false`.
  Даже когда включённых файлов нет, доступен manifest с причинами, без пустого ZIP
  и без `complete=true`. Полный успех — ровно весь выбранный набор.
- Некорректный/небезопасный selector, PathGuard policy denial или выход из root
  отклоняет запрос/задание; не читать запрещённые bytes и не выдавать частичный bundle
  как обход access policy. Фатальные I/O storage/compression, превышение общей квоты,
  числа частей или deadline завершают job с ясным stopReason и cleanup без выдачи
  незавершённого комплекта. Отмена сохраняет правила terminal state/cleanup 003.
- Служебные ошибки не превращать в ошибку исходного файла с продолжением. Сохранить
  общие гарантии crash/orphan cleanup, accounting при EACCES/EPERM и active read.

### Размеры, упаковка и доступ

- Ограничить число выбранных файлов, per-file/raw-job bytes, raw bytes одной части,
  конечные ZIP/delivery bytes, metadata/manifest bytes, число частей и ресурсы worker.
  Общие running/queued jobs, storage quota, TTL и read semaphore не дублировать.
  Раскрыть, какие существующие настройки общие и какие новые относятся к bundle;
  не переименовывать FS_SNAPSHOT_* без совместимости и не менять их прежнюю семантику.
- Память не должна расти с суммарным объёмом originals: bounded reads/compression,
  ограниченные открытые handles и промежуточный scratch под общей квотой.
  Проверять конечный ZIP с overhead, не оценивать cap только по raw размерам.
  Raw-file cap отличается от delivery cap: хорошо сжимаемый файл больше delivery
  cap может быть включён, если укладывается в raw-file cap и итоговый ZIP.
- Если группа файлов превышает cap, перераспределить её по независимым частям.
  Если один файл не помещается даже отдельно, записать `too_large` с причиной/лимитом,
  исключить его и вернуть неполный manifest. Не резать binary и не выдавать ссылку
  на архив сверх установленного cap. Повтор выдачи готовой части не читает source.
- Сохранить текущие runtime/general-file и delivery limits; не поднимать cap скрыто
  ради теста. Проверка должна включать плохо сжимаемые bytes и уже сжатый ZIP.
- Проверять текущие права при submit/status/cancel/fetch. Bundle не может доставить
  файл, который текущая policy больше не разрешает, лишь потому что root/artifact ID
  известен. Учесть все выбранные источники и recorded canonical paths. При этом
  обычное удаление/изменение source после готовности не отменяет право повторно
  получить сохранённые immutable bytes до TTL; auth check не должен требовать
  повторного чтения содержимого или существования каждого source файла.
  Сам source root в v1 по-прежнему должен существовать, как требует manager 003;
  его удаление делает status/fetch недоступными. Отдельно проверить неизменные bytes
  после удаления/изменения выбранного файла и отказ после сужения policy, включая
  restart. Не менять семантику snapshot ради этой проверки bundle.
- Источники работают с `--read-only`; служебные запись/отмена отражены честными MCP
  annotations по примеру 003. Удаление artifacts не затрагивает исходное дерево.

### Совместимость

Существующие snapshot API/manifest v1 и get_file остаются совместимыми. Stored
snapshot jobs schemaVersion 1 после upgrade по-прежнему читаются и выдаются до TTL;
старые interrupted/expiry состояния не переинтерпретируются. Если обобщение storage
требует нового schema version, добавить явное совместимое чтение старого формата
и проверку restart на synthetic persisted snapshot. Не переименовывать существующие
поля snapshot ради bundle. MIME/kind и подсказки status/get_artifact должны различать
оба producer; не создавать второй manager или endpoint lifecycle.

## Воспроизведение и проверки

Минимальный synthetic набор: два одноимённых файла в разных папках, Unicode и
пробелы/запятая, zero-byte файл, binary bytes, вложенный ZIP и небольшой XLS fixture
из существующего harness. Запрос выбирает только часть дерева. Независимый verifier
распаковывает все части, сверяет точное множество entries/paths и bytes/SHA-256 с
эталоном, созданным из fixture; затем открывает вложенный ZIP и проверяет XLS cells.
Не ограничиваться сравнением ZIP hash с manifest того же producer.

Добавить воспроизводимый harness/protocol под `scripts/` и `docs/testing/`:
настоящие MCP calls bundle → job_status → get_artifact; отдельные повторные fetch
большой части должны действительно дойти до сервера и материализовать равные bytes.
Предусмотреть synthetic multi-part и плохо сжимаемый одиночный oversized файл.
Для локального объёмного опыта выбрать ограниченный набор с общим объёмом хотя бы
в несколько part caps; записать submit/build/fetch time, raw/ZIP bytes, parts,
peak RSS/scratch. Большой опыт можно отделить от быстрого CI.

Полный `npm run check` обязателен. Отдельно проверить настоящие Windows 8.3 TEMP/root
и file/junction cases: менять env только для процесса проверки, не обходить дефект
перенастройкой CI. Не пропускать тесты из-за короткого spelling. Сохранять причины
platform skips и отличать локальные результаты от remote Windows/Ubuntu CI.

## Acceptance

- [x] Tool bundle принимает явный bounded набор, не добавляет невыбранные файлы;
      reorder/retry/idempotency/conflict и собственная отмена job проверены.
- [x] Несколько подпапок, одинаковые basename, Unicode и binary/XLS/ZIP originals
      проходят независимую проверку точных bytes и manifest provenance.
- [x] Самостоятельные ZIP-части и manifest укладываются в реальные caps; single
      oversized, poor compression, duplicate/unsafe paths дают ожидаемый результат.
- [x] Missing/inaccessible/changed и optional expected metadata дают полную отчётность,
      complete=false при любом пропуске; all-skipped не превращается в пустой успех.
- [x] Guard/read-only, symlink/junction/ADS/traversal, scratch separation и narrowing
      текущего доступа защищают submit и сохранённые artifacts; source не изменяется.
- [x] Deadline/cancel/timeout/disconnect, storage failure/quota, restart/TTL/active read
      сохраняют общий lifecycle; старые snapshot jobs и snapshots не регрессируют.
- [x] Локальный MCP harness с независимым verifier, повторной выдачей и multi-part
      проходит; объёмный профиль и Windows short paths проверены и описаны.
- [x] Полный check PASS; reference/config/tool instructions/Windows runbook обновлены,
      Work record содержит base/head, решения, команды, results/skips и ограничения.
- [x] Подготовлена пошаговая инструкция synthetic live ChatGPT опыта с manifest,
      всеми ZIP, распаковкой, per-file hashes и повторной выдачей; локальный результат
      явно отмечен LOCAL_ONLY. Целевой live PASS записывается только после опыта.

Готовность к code review требует локальных acceptance и подготовленного live runbook.
Живой опыт проводим после review вместе с пользователем; отсутствие runtime key в
новом worktree не блокирует реализацию или локальный harness. Центральное done,
окончательную live-приёмку и merge выполняет планирование.

## Launch prompt

```text
Реализуй docs/tasks/004-selected-originals-bundle.md. Пользователь разрешил начать.
Прочитай AGENTS.md, docs/README.md, brief, карточку, workflow и Windows runbook.
Используй предоставленный приложением отдельный worktree; второй не создавай.
Рабочая ветка codex/004-selected-originals-bundle от принятого main с этой карточкой.
Проверь реальную базу и наличие карточки. Не переключай чужие checkout.
Выполни реализацию, meaningful regressions, MCP harness и независимый verifier,
полный check, обнови reference и Work record. Не жди разрешения на обычные
реализационные решения внутри карточки. Если обнаружится существенное противоречие
контракта, подготовь конкретное предложение планированию и продолжай независимую работу.
Сохрани итог отдельными локальными commits, сообщи base/head, проверки и ограничения.
Центральную доску не редактируй. Не используй production данные/ключ/чужой live tunnel.
Подготовь live runbook, сам целевой ChatGPT опыт пока не запускай.
Push/PR/merge и release оставь планированию до отдельной команды.
```

## Work record

Исполнитель: Codex, 2026-09-20. Статус: **ready for review**.

- Base и branch: `51149b06d3112cb374559cc71b5438dbcbbe55ae`,
  `codex/004-selected-originals-bundle`; implementation/evidence head до этого
  Work record — `a40d7934f76ebf94b8a1ecf0468a3f7aa39738e5`. Итоговый tip с самим Work record
  фиксируется отдельным локальным commit и передаётся в handoff.
- Что изменилось и почему: добавлены public `bundle`, guarded chunked capture,
  bounded spool и closed-ZIP splitting, внешний manifest v1 с provenance/outcomes,
  bundle counters/config, текущая policy-проверка всех selectors и общий lifecycle
  status/cancel/fetch/restart. Snapshot stored schemaVersion 1, API и manifest v1
  сохранены. Добавлены 10 regression tests, stdio MCP harness, независимый Python
  ZIP/XLS verifier, volume profile, local evidence и post-review live protocol.
- Решения и отклонения от плана: один существующий manager и общие
  `FS_SNAPSHOT_*` lifecycle/ZIP/delivery/quota/TTL caps; новые `FS_BUNDLE_*` только
  для selection/capture/manifest. Portable extraction names отклоняются до job,
  явный набор сортируется для fingerprint. Whole originals спулируются через
  `GuardedFileSystem`, ZIP-группа делится после проверки фактического закрытого
  размера, single oversized становится `too_large`; all-skipped публикует только
  manifest. Абсолютный root в manifest не записывается. Новая ZIP-зависимость не
  добавлялась, версии не менялись. Существенных отклонений от карточки нет.
- Команды, результаты, среда и skips: Windows, Node `v24.15.0`, npm `11.12.1`,
  Python `3.12.3`; выполнены `npm ci`, `npm run check`, отдельные bundle/snapshot
  suites, `node scripts\\bundle-check\\local-mcp-check.mjs ...`, pinned
  `verify_bundle.py` и `node --import tsx scripts\\bundle-check\\volume.mts ...`.
  Финальный `npm run check`: 395 tests, 388 pass, 0 fail, 7 skip; static/build/types/
  eslint/prettier/knip PASS. Bundle: 10/10 без skips в обычном и настоящем 8.3 TEMP
  (`...\\BUF3C7~1`) прогонах; snapshot: 27/27. Реальный junction fail-closed и short
  source root PASS. Семь общих skips — POSIX inode/mode и Windows file-symlink cases
  без привилегии; bundle skips отсутствуют. Первый sandbox-запуск Node/tsx получил
  системный `uv_os_get_passwd ENOMEM`, обязательный check повторён вне sandbox и PASS;
  pinned Python install аналогично потребовал разрешённый network-доступ.
- Локальная evidence: stdio submit/build 16,4/34,5 ms, 6335 B originals, manifest
  3022 B, ZIP 1633 B, byte-equal repeat; independent nested ZIP/XLS/hash verification
  PASS. Volume: 7 × 1 MiB, 7 частей по 1 049 084 B, build 438,4 ms, fetch 25,4 ms,
  peak RSS 140 083 200 B, sampled scratch 9 410 665 B, independent bytes PASS.
  Полные детали и оговорки — в `docs/testing/bundle-local-2026-09-20.md`.
- Выполненные и оставшиеся acceptance: все локальные acceptance выше выполнены.
  Shared storage/quota/TTL/active-read/restart regressions проверены существующим
  snapshot suite после обобщения manager. Remote Windows/Ubuntu CI и целевой ChatGPT
  live опыт не запускались; это намеренно оставлено planning после review.
- Риски и live handoff: metadata interval не обнаруживает запись с восстановленными
  size/mtime; Windows inaccessible outcome проверен synthetic EACCES, а file symlink
  зависит от runner privilege. Проверенный local artifact — 1 049 084 B; фактический
  верхний предел принимающего host этим не заявляется. Результаты строго
  `LOCAL_ONLY_NOT_CHATGPT`; пошаговый опыт, teardown и форма evidence находятся в
  `docs/testing/bundle-live.md`. Production данные, ключи и tunnel не использовались.

### Исправления review, 2026-09-21

Main commit `8b8c7dd8` опубликовал независимый review со статусом
`CHANGES_REQUESTED` и замечаниями R1–R8. Все восемь исправлены в implementation
commit `8d9655e9516156332950abf6f6d40e78b1081e7e`; статус задачи исполнителя —
**ready for re-review**.

- R1/R7: scratch metadata/artifacts нельзя выбрать через canonical/8.3/junction
  aliases; каждый существующий selector component проверяется даже при missing leaf.
- R2/R3: ZIP producer владеет lazy streams, перенаправляет input error в failed job,
  закрывает streams при split/cancel/error; faulted job не завершает server.
- R4: scratch I/O error fatal и не маскируется как inaccessible source outcome.
- R5: idempotent reuse перед status summary повторно авторизует root/selectors до и
  после restart, сохраняя reuse после обычного удаления разрешённого source.
- R6: raw original соблюдает общий `FS_MAX_FILE_SIZE`, delivery cap остаётся отдельным.
- R8: local harness canonicalizes destination/ancestor до любой записи; verifier
  проверяет file-to-part provenance и tampered-link negative control.
- Дополнительно закрыты Windows-invalid wildcard/superscript device names, добавлен
  Linux FIFO regression и исправлен найденный volume profile multi-chunk buffer reuse.

Финальная локальная проверка: `npm run check` — 401 tests, 393 pass, 0 fail,
8 platform skips; bundle — 15 pass и 1 Linux-only FIFO skip в обычном и настоящем
Windows 8.3 TEMP прогонах; stdio verifier и 7 MiB volume — PASS. Полная evidence:
`docs/testing/004-fixes-2026-09-21.md`. Remote CI и целевой ChatGPT live ещё не
запускались; push/PR/merge/release и `docs/project/status.md` не выполнялись.
