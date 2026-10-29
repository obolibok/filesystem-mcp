# 016: tree-depth-v1 по умолчанию

Статус реализации: принята и интегрирована через PR #15; check PASS. Зависимости: задачи 014 и 015 интегрированы.
Планирующий чат ведёт центральную доску и принимает результат после ревью.

## Зачем

На живом сравнении R2 формат tree-depth-v1 сохранил пути и метаданные всех
выданных файлов и уменьшил ZIP на 28,2%. Исправленный локальный consumer
benchmark и прогон в чате показали более быструю обработку дерева для поиска и
построения полного индекса. Чат сообщил, что понимает D/F/C/U и глубину без
отдельного скилла. Свидетельства и ограничения описаны в
[ChatGPT A/B 014](../testing/014-chatgpt-ab-2026-10-29.md) и
[локальном сравнении 015](../testing/015-local-r2-2026-10-29.md).

Экспериментальный формат пора сделать стандартным результатом snapshot. Stable
CSV остаётся явным вариантом совместимости, выбираемым конфигурацией сервера.

## Решение и публичный контракт

- Сохранить имя инструмента создания snapshot. Если формат не задан, инструмент
  создаёт tree-depth-v1 и возвращает tree manifest. Обычные инструкции модели
  направляют инвентаризацию в этот инструмент, без выбора между двумя snapshot
  tools.
- Добавить настройку формата сервера: FS_SNAPSHOT_FORMAT в runtime и
  snapshotFormat в portable config. Допустимы значения tree и stable. Значение
  по умолчанию — tree; stable явно выбирает прежний CSV. Portable validator
  отклоняет неверный тип и неизвестное значение до запуска. Неверное runtime
  значение останавливает старт с ясной ошибкой.
- Убрать snapshot_tree как отдельно публикуемый экспериментальный tool создания.
  FS_EXPERIMENTAL_SNAPSHOT_TREE больше не управляет discovery. Старое поле
  experimentalSnapshotTree может встречаться в существующем portable config;
  оно не должно незаметно возвращать stable как формат по умолчанию. Описать
  переход и указать snapshotFormat: "stable" для возврата к прежнему формату.
- Сохранить прежние сериализатор stable и его manifest/schema. Сохранить байты и
  schema tree-depth-v1, а также отдельный tree raw-part cap из задачи 015.
- Разделить новые jobs по сохранённому формату/layout, чтобы automatic reuse,
  in-flight reuse и idempotency никогда не пересекались. Подходящий ранее
  snapshot_tree job должен оставаться кандидатом для reuse в tree-режиме после
  обновления.
- job_status, get_artifact и cancel_job продолжают обслуживать существующие
  stable/tree jobs после смены формата и рестарта — в рамках прежних правил
  авторизации и TTL. Выбранный формат создания не должен закрывать чтение уже
  созданной job.
- Описания tool и плагина должны объяснять выбранный manifest и правила формата:
  root record, RFC 4180 CSV records, числовая глубина, D/F объекты, C-контекст
  части, U-неполные каталоги и точные имена. Отдельный скилл модели не добавлять.

## Объём

Runtime config и композиция tools, обработчик snapshot и его identity, portable
валидация и mapping запуска, пользовательские tool instructions, документация
tree/stable, synthetic tests, portable acceptance и work record этой карточки.

Не менять файловый обход, PathGuard, schema tree-v1 или stable-сериализацию,
lifecycle jobs, общие ZIP/delivery limits, отдельный tree raw cap или версии
пакетов. Не менять установленный сервис C:\FileMCP и туннель. После review и
интеграции планирование соберёт пользовательский portable комплект.

## Приёмка

- [x] В стандартной portable и runtime конфигурации доступен один канонический
      tool snapshot, который по умолчанию создаёт tree-depth-v1 без opt-in.
- [x] snapshotFormat: "stable" / FS_SNAPSHOT_FORMAT=stable выбирают прежний CSV
      и manifest без изменения контракта. Неверные настройки останавливают запуск;
      inherited environment не переопределяет portable config.
- [x] Default и stable modes остаются в пределах tool discovery budgets.
      Обычные инструкции направляют модель в настроенный snapshot tool.
- [x] Completed reuse, in-flight reuse, idempotency и force refresh разделены
      по формату. Совместимая tree job из 014/015 переиспользуется после
      обновления; stable jobs и artifacts остаются доступны при смене режима.
- [x] Restart и format-switch regressions подтверждают доступность старых jobs
      через status/fetch/cancel по прежним правилам авторизации и TTL.
- [x] Независимая synthetic проверка подтверждает одинаковые file paths, length и
      timestamps в обоих форматах; покрыты пустые/неполные каталоги, multipart C,
      Unicode, запятые, кавычки и CR/LF.
- [x] Portable Verify покрывает default tree, явный stable, отказ на неверной
      настройке и изоляцию от inherited env без production данных.
- [x] Обновлены README, architecture, portable/operator docs и карта docs.
      tree-depth-v1 описан как поддерживаемый default, а не эксперимент.
- [x] npm run check, targeted regressions и portable verification проходят.
      В Work record записаны команды, среда, результаты и skips. Версия пакета
      не меняется, release workflow не запускается.

## Сообщение исполнителю

Реализуй docs/tasks/016-tree-default.md в отдельном managed worktree от
актуального принятого main. Сначала прочитай AGENTS.md, docs/README.md, brief,
эту карточку и parallel-work workflow. Пользователь разрешил сделать
tree-depth-v1 форматом snapshot по умолчанию, а stable оставить явным режимом
конфигурации. Сохрани имя snapshot, раздели reuse/idempotency по формату, оставь
старые stable/tree jobs доступными для status/fetch/cancel и переведи portable
на snapshotFormat=tree|stable. Не меняй установленный сервис или туннель.
Добавь synthetic regressions и portable Verify, обнови пользовательские docs,
выполни приёмку и npm run check, заполни Work record и передай фактические
base/head, проверки и риски планированию. Центральную status board не меняй.
Planning интегрирует результат после независимого review; portable build для
пользователя соберёт planning.

## Work record

Дата: 2026-10-29. Реализация готова к независимому review. Центральная доска
не менялась; приёмку и пользовательскую portable-сборку выполняет planning.

- Base: `14d74bfd41bbcc48d4a2c55f3999242dad5ef392`; ветка
  `codex/016-tree-default`, отдельный managed worktree приложения. Исходный diff
  пуст. Commit результата сообщается в handoff; собственный SHA сюда не включён.
- Runtime `FS_SNAPSHOT_FORMAT` строго принимает tree/stable, default tree;
  `--print-config` показывает выбранный формат. Manager захватывает настройку
  при старте; composition регистрирует ровно один snapshot нужного формата.
- Stable normalized input, tree layout discriminator и fingerprints сохранены
  без изменений. Формат создания намеренно не добавлен в authorization/config
  fingerprint: совместимые 014/015 tree jobs переиспользуются новым snapshot,
  чтение/cancel старых jobs не зависит от режима создания. Между форматами
  отсутствуют completed/in-flight reuse и replay одного ключа; forceRefresh
  остаётся retry-safe в своём формате. Walker, serializers, manifests, tree
  raw cap, общий lifecycle/limits, версии пакетов не менялись.
- Portable `snapshotFormat` принимает только строки tree/stable, отсутствие
  означает tree; false/null/числа/объекты/неизвестные строки отклоняются до MCP.
  Legacy experimentalSnapshotTree ещё валидируется как boolean, но игнорируется
  при выборе; inherited FS_* очищается. Retired FS_EXPERIMENTAL_SNAPSHOT_TREE
  не влияет на discovery. README, architecture, portable/operator instructions,
  docs map и tool/internal instructions описывают поддерживаемый default и migration;
  TEST-014 помечен историческим, добавлен TEST-016. Отдельный skill не добавлен.
- Synthetic regressions проверяют обе последовательности format-switch,
  completed/in-flight/retry/force, restart, status/fetch/cancel обеих jobs,
  отказы authorization и TTL в обоих creation modes, pre-016 stored identity,
  exact path/Length/LastWriteTime parity. Независимый ZIP/CSV readback покрывает
  Unicode, запятые, кавычки, CR/LF, multipart C, U и пустые каталоги.
- Среда: Windows 10 x64 (10.0.19045), Node 24.15.0, npm 11.12.1,
  Windows PowerShell 5.1.19041.6456. `npm ci` — PASS.
- `node --test --import tsx __tests__/snapshot-tree.test.ts __tests__/snapshot.test.ts __tests__/tool-selection.test.ts __tests__/source-provenance.test.ts`:
  67 PASS, 0 failures/skips. После дополнительной authorization/TTL regression:
  `node --test --import tsx __tests__/snapshot-tree.test.ts` — 18 PASS,
  0 failures/skips. Общие tests запущены отдельно (итог ниже).
- Финальный `npm test` после всех regressions: 516 tests, 508 PASS,
  0 failures/cancelled, 8 skips, 70 suites. Skips: POSIX FIFO, inode/mode,
  0222 append target (3); Windows file symlink privilege отсутствует для
  append in-root/out-of-root/sensitive target, PathGuard sensitive target и
  stat own symlink (5). Junction/настоящий 8.3 и native provenance smoke прошли.
- Discovery: tree full/read-only 27 180 / 17 100 chars; stable
  27 030 / 16 950, budgets 27 200 / 17 100. В обоих режимах 19/13 tools,
  snapshot_tree не публикуется даже при старом flag=1.
- `npm run check` фактически запущен: build, production/test types и полный
  ESLint прошли; Prettier остановил цепочку на шести неизменённых файлах базы:
  `docs/project/status.md`, `docs/tasks/015-snapshot-tree-settings.md`,
  `docs/testing/014-chatgpt-ab-2026-10-29.md`,
  `docs/testing/015-integration-2026-10-29.md`,
  `docs/testing/015-live-r2-2026-10-29.md`,
  `docs/testing/015-local-r2-2026-10-29.md`. Их diff относительно base пуст;
  чужая карточка и центральная доска не редактировались. Поэтому последний
  acceptance checkbox оставлен открытым. Planning нужно нормализовать эти docs
  в своём scope и повторить полный check перед integration.
- Отдельно пройдены `npm run type-check:test`, ESLint изменённых TS/MJS,
  `knip`, Prettier всех файлов текущего diff и `git diff --check`.
- Portable: `Build.ps1` собрал отдельный локальный test kit в
  `.tmp/016-portable-test` из рабочего diff, с pinned Node/tunnel archives
  и проверкой SHA-256. Это test kit, не итоговая поставка пользователя;
  BUILD sourceCommit в нём указывает base, исходные bytes включают реализацию.
  `node scripts/windows-portable/Verify.mjs .tmp/016-portable-test` —
  PORTABLE_ACCEPTANCE_PASS, 24 scenarios, 0 skips. Проверены relocation/Unicode,
  default/omitted format + legacy false, явный stable, inherited env с обратным
  форматом, оба manifests, multipart caps, tree-only cap change/reuse, restart,
  byte-identical fetch обеих layouts из обоих modes, invalid format/type/null,
  existing path/limit negatives, PowerShell doctor и отказ чужому PID.
- Ограничения среды: sandbox запуск tsx падал до tests на
  `uv_os_get_passwd / ENOMEM`; успешные tests выполнены вне sandbox. Первый
  sandbox Verify дошёл до Stop negative control и получил Get-CimInstance
  Access denied; полный повтор вне sandbox прошёл. Проверки не ослаблялись.
- Production источники, установленный сервис и tunnel не трогались. В Git только
  code/docs/synthetic tests. Live ChatGPT/SMB и итоговая portable поставка —
  следующая ответственность planning после review. Функциональных failures нет;
  остаётся унаследованный repository-wide formatting blocker выше.
- Planning review/integration follow-up (2026-10-29): independent code review found
  no correctness issues. The six inherited Markdown formatting blockers listed
  above were normalized in the isolated integration worktree. On the combined
  task/main head, `npm run check` passed: build, production/test types, ESLint,
  Prettier, Knip, and 516 tests (508 passed, 8 platform skips, 0 failures).
  No service, tunnel, or production sources were touched.
- Интегрирована через [PR #15](https://github.com/obolibok/filesystem-mcp/pull/15). Merge commit:
  `77a9e71ba6242afce39cc025ac63f2c86aa885c9`; GitHub CI Windows/Ubuntu — PASS.
