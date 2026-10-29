# Handover архитектору SWB RAG

29.10.2026. Прочитать этот файл, AGENTS.md, [brief](brief.md), [доску](status.md),
[архитектуру](../reference/architecture.md) и [parallel-work](../development/parallel-work.md).
История большого чата для старта не нужна.

## Цель и роль

Fork obolibok/filesystem-mcp от j0hanz/filesystem-mcp даёт ассистенту доступ к
разрешённым файловым roots, индексам и выбранным originals для Schwarzbeck.
Предметный пилот — Daum/Inoplacer. Доменные парсеры, vector DB/embeddings и
постоянная индексная БД пока не назначены; анализ выполняется принимающей средой.

Архитектор ведёт scope, приоритеты, status.md, review и integration. Исполнитель
получает одну карточку docs/tasks/, branch/worktree и ведёт Work record.
Пользователь предпочитает небольшие понятные решения: «не лепить боинг».

Есть постоянное разрешение на commit/push/merge main и рабочих веток после
review/checks без нового Git-permission. Release не публиковать без задачи,
package/server version вручную не менять. Production data, inventories, ключи
и личные абсолютные пути не коммитить. Для coding-исполнителей последняя
согласованная модель — GPT-6.1-Sol / xhigh; старые 5.6/6 Sol — история.

При создании coding-чата проверять фактические project, HEAD, чистоту и наличие
карточки. Приложение ранее создавало worktree на старой локальной базе;
исправлялось fetch и веткой от origin/main. Не продолжать старые detached trees
как актуальную базу.

## Принятое состояние

Основная ветка — **main**, origin — fork. Последний runtime merge:
318173d0c0f0f359e7c7be712884d6e7d000400f,
[PR #19](https://github.com/obolibok/filesystem-mcp/pull/19).
Docs cleanup/handover идёт последующим commit, поэтому сначала git log/status и
origin/main, не предполагать точный HEAD по этому документу.
Все назначенные coding-задачи приняты. Активных исполнителей/review нет, 005 proposed.

| Задача | Что принято                                                 | Evidence                                                                   |
| ------ | ----------------------------------------------------------- | -------------------------------------------------------------------------- |
| 016    | tree-depth-v1 стандарт snapshot, stable явно                | PR #15; portable Verify 24/24                                              |
| 017    | production dependency remediation                           | PR #17; CI, source и portable                                              |
| 018    | guarded read/open/append, exclusive create, Windows aliases | PR #18; head ea794fd1; CI PASS                                             |
| 019    | HMAC подтверждение привязано к identity цели                | PR #19; [review](../testing/019-review-integration-2026-10-29.md); CI PASS |

019: 53 новые regressions. Независимый Windows check 585/0/13,
PR Windows 593/0/5, Ubuntu 582/0/16, всего 598 tests. Security diff review без findings.
Identity — type/dev/ino/birthtimeMs, не hash содержимого/детей. Проверки pathname
не атомарны после последнего probe; доверенные ancestors всё ещё нужны.

## Действующие контракты

- PathGuard/GuardedFileSystem — граница source access; read-only реально исключает
  mutating tools из регистрации. Pilot работает с read-only источниками.
- list — ограниченный просмотр; find_files/search_text — поиск; snapshot — полный
  фоновой индекс; bundle — явно выбранные originals. Count files tool пользователь
  отклонил: запрос подсчёта был способом побудить модель построить индекс.
- Одна snapshot job на root; несколько roots — отдельные calls. list_roots отдаёт
  roots и provenance (host name/machineId, volume label/serial). Отсутствующие OS
  значения остаются null; identifiers не выдумываются.
- Jobs/artifacts durable, переживают restart, имеют TTL/quota/cancel. Snapshot reuse
  общий между чатами: готовый свежий результат либо выполняющаяся job. maxAgeMs /
  forceRefresh — свежесть, result TTL — хранение, не путать их.
- FS_SNAPSHOT_FORMAT / portable snapshotFormat: tree default, stable явно.
  experimentalSnapshotTree больше не переключает формат. Tree spec, C/U records
  и границы частей — [reference](../reference/architecture.md) и [014](../testing/014-snapshot-tree.md).
  Обрабатывать потоком со стеком Depth; полные пути строить только когда нужны.
- get_file/get_artifact возвращают tool embedded resource + matching link.
  resources/read отдельно не доказал ChatGPT delivery.
- ChatGPT materialization bug может ложно сказать «чат закончился» при первом
  большом файле. Сначала материализовать маленький файл с постоянным разрешением
  в этом чате. Не считать это доказанным лимитом длины разговора.
- Обычный review не запускает и не перенастраивает production service/tunnel.
  Secrets/config оператора не служат общей памятью проекта.

## Замеры и поставка

[Большой live R2](../testing/015-live-r2-2026-10-29.md): 2,843,566 files,
345,209 каталогов, 881.308 s, 10 tree ZIP parts, raw 162,372,414 B,
ZIP 25,664,531 B, каждый ZIP <8 MiB. complete=false, 470 inaccessible skips.
[Parity](../testing/015-local-r2-2026-10-29.md): 21/21 SHA/CRC, exact paths/metadata
совпали, mismatches=0. [ChatGPT A/B](../testing/014-chatgpt-ab-2026-10-29.md):
raw -65.7%, ZIP -28.2%, query scan быстрее 19.9%, path-index быстрее 24.8%.
Это результаты данной выборки, не универсальная гарантия.

Последний пользовательский portable — **016**:
[протокол/хеши](../testing/016-integration-2026-10-29.md).
Review build 017 проверял production dependencies и Verify 24, но не 018/019.
Комплекта со всеми исправлениями 017–019 пока нет. Runtime pins существующего
builder: Node 24.15.0 Windows x64, tunnel-client 0.0.14; не обновлять их попутно.

## Ближайшие решения

1. Current-main portable, synthetic Verify 24 scenarios и пользовательский smoke:
   [runbook](../development/windows-portable.md). Live deployment — отдельно.
2. Dev dependency triage: audit 29.10 даёт 3 package findings (2 high, 1 moderate):
   @modelcontextprotocol/client, brace-expansion, smol-toml. Production --omit=dev — 0.
   Исторические 9 в старых docs не являются актуальным счётчиком.
3. Upstream проверен на v2.12.1, 82da458e76aa5207e5050b5abe0110fd302b74bb.
   019 адаптирует v2.12.0 b23023f2. Возможные узкие задачи без назначения:
   EXDEV move staging/cleanup, replace_text match limit, list partial timeout.
   Сначала подтвердить gap в fork. Общий merge upstream не назначен.
4. Tunnel/PowerShell Ctrl+C после Windows Sleep: намерение пользователя проверить;
   диагноза и назначенной задачи нет. Обычный graceful shutdown ранее проходил.
5. Опыт 005 требует выборки, исходного вопроса и эталона. Не превращать его
   автоматически в новую реализацию RAG backend.

## Порядок следующего чата

Primary checkout пользователя очищен и синхронизирован; перед edit проверить
фактическое состояние. Главная память — Git docs, не reports/.tmp/node_modules
или transcript. Не удалять чужие checkout или уникальные ignored evidence без
сохранения; старые worktrees не означают активных исполнителей.

status.md теперь компактная текущая доска; [история](history/status-2026-10-29.md)
сохранена отдельно. CI #141/#142 падали на Prettier двух Markdown files после
API edits; исправлено, main #144 PASS. Это доказанная причина красного CI;
повреждение Git из-за размера чата не подтверждено.

После docs edits выполнять targeted Prettier до push. Полный check после runtime
изменений; не повторять все tests после каждого изменения текста. safe.directory
только разовое значение проверенного canonical checkout, без wildcard/global.

Монитор 019 удалён после ready for review. Новый архитектор сначала подтверждает
принятую базу и следующий шаг. Не запускать coding или production service только
на основании handover.
