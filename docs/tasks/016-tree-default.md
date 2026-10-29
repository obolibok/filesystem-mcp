# 016: tree-depth-v1 по умолчанию

Статус: готова к реализации. Зависимости: задачи 014 и 015 интегрированы.
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

- [ ] В стандартной portable и runtime конфигурации доступен один канонический
      tool snapshot, который по умолчанию создаёт tree-depth-v1 без opt-in.
- [ ] snapshotFormat: "stable" / FS_SNAPSHOT_FORMAT=stable выбирают прежний CSV
      и manifest без изменения контракта. Неверные настройки останавливают запуск;
      inherited environment не переопределяет portable config.
- [ ] Default и stable modes остаются в пределах tool discovery budgets.
      Обычные инструкции направляют модель в настроенный snapshot tool.
- [ ] Completed reuse, in-flight reuse, idempotency и force refresh разделены
      по формату. Совместимая tree job из 014/015 переиспользуется после
      обновления; stable jobs и artifacts остаются доступны при смене режима.
- [ ] Restart и format-switch regressions подтверждают доступность старых jobs
      через status/fetch/cancel по прежним правилам авторизации и TTL.
- [ ] Независимая synthetic проверка подтверждает одинаковые file paths, length и
      timestamps в обоих форматах; покрыты пустые/неполные каталоги, multipart C,
      Unicode, запятые, кавычки и CR/LF.
- [ ] Portable Verify покрывает default tree, явный stable, отказ на неверной
      настройке и изоляцию от inherited env без production данных.
- [ ] Обновлены README, architecture, portable/operator docs и карта docs.
      tree-depth-v1 описан как поддерживаемый default, а не эксперимент.
- [ ] npm run check, targeted regressions и portable verification проходят.
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

До начала реализации: не начато.

- Base / branch:
- Изменения и выбранные решения:
- Команды, environment, результаты и skips:
- Приёмка:
- Остаточные риски / handoff:
