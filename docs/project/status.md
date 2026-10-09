# Приоритеты и интеграция

Владелец: планирующий чат. Обновлено: 2026-10-09.
Это единая доска интеграционного статуса. Coding-чаты записывают свою работу в
карточках задач, а планирование обновляет эту таблицу после review/интеграции.

| ID           | Работа                                                                              | Статус   | Зависит от         | Назначение                                                                                                                        |
| ------------ | ----------------------------------------------------------------------------------- | -------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| 000          | Подготовка контекста и правил работы                                                | done     | —                  | Планирующий чат; docs checkpoint                                                                                                  |
| 001          | [Baseline-дефекты и Windows](../tasks/001-baseline-defects.md)                      | done     | 000                | `001 - baseline defects fix`; `codex/001-baseline-defects`                                                                        |
| 002          | [Стенд доставки originals](../tasks/002-originals-delivery.md)                      | done     | 001                | `codex/002-originals-delivery`; принят через PR #2; целевой прогон вынесен в 002-live                                             |
| 002-live     | [Живой прогон Windows/ChatGPT](../tasks/002-live-windows-chatgpt.md)                | done     | 002                | Отрицательный `resources/read` маршрут принят как исторический результат в PR #3                                                  |
| 002-tool     | [Выдача originals через tool](../tasks/002-tool-delivery.md)                        | done     | 002, 002-live      | `codex/002-tool-delivery`; review и CI PASS; принят через PR #3                                                                   |
| 003          | [Фоновый snapshot и сжатые части](../tasks/003-compressed-snapshot.md)              | done     | 002-tool           | `003 - compressed snapshot`; принят через [PR #4](https://github.com/obolibok/filesystem-mcp/pull/4); code review, live и CI PASS |
| 004          | [Bundle выбранных originals](../tasks/004-selected-originals-bundle.md)             | done     | 003                | Code review, live и CI PASS; принят через [PR #5](https://github.com/obolibok/filesystem-mcp/pull/5)                              |
| 004-live     | [Живой bundle Windows/ChatGPT](../tasks/004-live-windows-chatgpt.md)                | done     | 004 review PASS    | Live и graceful teardown PASS; evidence принята и интегрирована в PR #5                                                           |
| 004-portable | [Переносимый Windows-комплект](../tasks/004-portable-windows.md)                    | done     | 004                | Planning; local acceptance и полный check PASS; Node/tunnel, инструкции, roots/TTL                                                |
| 006          | [Общее переиспользование снимков](../tasks/006-shared-snapshot-reuse.md)            | done     | 003, 004-portable  | Принята через [PR #6](https://github.com/obolibok/filesystem-mcp/pull/6); review, live, CI и portable PASS                        |
| 007          | [Устойчивость snapshot и fatal diagnostics](../tasks/007-snapshot-walk-recovery.md) | done     | 006                | Принята вместе с 008 через [PR #7](https://github.com/obolibok/filesystem-mcp/pull/7); review, большой live и CI PASS             |
| 008          | [Надёжность job metadata на Windows](../tasks/008-job-metadata-persistence.md)      | done     | 007 runtime        | Принята через [PR #7](https://github.com/obolibok/filesystem-mcp/pull/7); review, portable, live/restart и CI PASS                |
| 009          | [Выбор инструментов и понятные результаты](../tasks/009-tool-selection.md)          | done     | 007, 008           | Принята через [PR #8](https://github.com/obolibok/filesystem-mcp/pull/8); review и CI PASS; пользователь принял live              |
| 010          | [Ограниченный list и ясные лимиты](../tasks/010-bounded-list.md)                    | done     | 009                | Принята пользователем; R1–R3, local/CI/portable PASS; интегрирована через PR #9                                                   |
| 005          | Контролируемое повторение предметного исследования                                  | proposed | 004, 006, 007, 008 | Планирование + пользователь; выбрать данные, исходный вопрос и критерии                                                           |

`proposed` — направление без разрешения на реализацию; `ready` — scope и acceptance
готовы; `active` — назначен исполнитель; `review` — есть проверяемый результат;
`done` — принят и интегрирован; `blocked` — указана конкретная внешняя зависимость.
При назначении рядом с ID сохранять имя/ссылку чата и ветку, доступные из приложения.
Не придумывать task ID приложения или commit SHA.

## Текущий следующий шаг

[010](../tasks/010-bounded-list.md) принята пользователем 09.10.2026 и
[слита через PR #9](https://github.com/obolibok/filesystem-mcp/pull/9) в main,
merge `c84f238b48a65fcd4c00fde49ee99c725cf0e608`. Reviewed head
`346d4b691a40331f3a0b634c572685e0b372abf7`; merged runtime/tests/scripts совпадают.
[Review R3](../testing/010-review-r3-2026-10-09.md) и
[интеграция](../testing/010-integration-2026-10-09.md): R1–R3 закрыты,
обычный bounded suite 15/0/0, actual 8.3 TEMP check 450/0/8; CI Windows 455/0/3,
Ubuntu 446/0/12, все 13 portable checks PASS. Пользователь явно принял результат
и разрешил merge; отдельный live-отчёт/trace не предоставлен, полное выполнение
live-матрицы не утверждается.

list ограничивает реальный обход по maxDepth и общему limit, pageSize задаёт
размер страницы. maxEntries удалён без alias; maxPages не добавлен. Literal
Next page сохраняет scope/limit. Комплект
`out/Schwarzbeck-MCP-010-test-2026-10-09` и ZIP соответствуют принятому runtime;
BUILD.json source `29fa8b7b`, R3 менял только tests/docs. Установленный сервис
во время интеграции не менялся, release не публиковался.

Следующий плановый этап — согласовать предметный опыт 005: выборку
Daum/Inoplacer, вопрос и проверяемые критерии. Пока proposed, исполнитель
не назначен; новый coding-чат автоматически не создавать.

Отдельное наблюдение CI: первый Windows attempt на новом head застал failed
snapshot до завершения очистки artifacts; неизменённый повтор PASS. Job-manager
и этот тест не менялись в 010. [Evidence и follow-up](../testing/010-review-r3-2026-10-09.md)
сохранены: уточнить terminal/cleanup контракт и сделать тест детерминированным.
Это не считается устранённым повтором CI и не смешивается с закрытым R3.

[009](../tasks/009-tool-selection.md) принята и интегрирована через
[PR #8](https://github.com/obolibok/filesystem-mcp/pull/8), merge
`a67fa81914a543e7a4aa1595d63df0a49e287f11`. Проверенный head:
`7c4f4ec9e0c13e5ae4a24a1a4b823d9392290f86`.
[Независимое code review](../testing/009-review-2026-10-08.md) и полный local
check PASS: 435 pass, 0 fail, 8 platform/permission skips.
[CI PR](https://github.com/obolibok/filesystem-mcp/actions/runs/37775500386)
Windows/Ubuntu PASS: 440/431 pass, 0 fail, 3/12 skips, по 443 tests.

08.10.2026 пользователь сообщил, что проверка прошла неплохо, и явно разрешил
merge. Это принятая пользовательская live проверка; trace по отдельным сценариям
и количественные результаты не предоставлены. Полное покрытие RU/EN матрицы
не утверждается. [Протокол](../testing/009-tool-selection.md) сохранён для
повторных опытов. Count_files/count-only не добавлены; API и source policy прежние.
Sleep/Ctrl+C и нестабильный PowerShell helper остаются отдельными наблюдениями.

После 010 — согласовать предметный опыт 005: выборку Daum/Inoplacer,
исходный вопрос и критерии результата. Задача пока proposed, исполнитель
не назначен; новую реализацию автоматически не начинать.

Инфраструктурные задачи 007 и 008 приняты и интегрированы через
[PR #7](https://github.com/obolibok/filesystem-mcp/pull/7), merge
`eefc00298045c216ba64dcbce707aa9bc6153d85`.
[Code review 007](../testing/007-review-r2-2026-09-25.md),
[code review 008](../testing/008-review-2026-09-25.md),
[portable](../testing/008-portable-2026-09-25.md),
[пользовательский live/restart](../testing/008-live-2026-09-25.md) и
[финальный CI](../testing/008-integration-2026-09-25.md) PASS.

Большие обходы: 484719 и 69779 уникальных записей, persisted completed,
SHA/CRC/CSV проверены. После restart прежний большой job и manifest доступны
без нового snapshot; SHA manifest совпадает с файлом на диске.
`complete=false` из-за недоступных дочерних файлов сохранён в контракте.
Финальный PR head `65b7bc4c` прошёл Windows/Ubuntu: по 441 tests,
438/429 pass, 0 fail, 3/12 skips.

Историческая поставка 008 с отдельным portable-протоколом —
`out/Schwarzbeck-MCP-008-test-2026-09-25` и соседний ZIP, source runtime
`7bf58e05`; изменения 009 в этот архив не входят. Точный состав установленного
комплекта при live 009 отдельно не фиксировался. Во время merge 009 новая
поставка не собиралась, установленный сервис не менялся.
Внутри автономные Node/tunnel, инструкция Windows, multiple roots,
tunnel/key/plugin, scratch/TTL. 13 portable checks PASS. Новый перенос на VM,
Windows 11 и SMB остаются отдельными условиями deployment.

Предметный опыт 005: выбрать каталоги/файлы
Daum/Inoplacer, один исходный исследовательский вопрос и проверяемые критерии
результата. Задача остаётся proposed; исполнитель не назначен. После согласования
планирование оформит карточку, а отдельная задача проведёт исследование из
чистого чата через snapshot/bundle. Серверные доменные парсеры и постоянная
индексная БД в scope не добавлены.

## Ранее принятая инфраструктура

[006](../tasks/006-shared-snapshot-reuse.md) принята через
[PR #6](https://github.com/obolibok/filesystem-mcp/pull/6), merge `9707bbe3`.
[Code review](../testing/006-review-2026-09-24.md),
[живой опыт](../testing/006-live-2026-09-24.md) и
[интеграция/CI/portable](../testing/006-integration-2026-09-24.md) PASS.
Общий snapshot reuse включён в main; тестовый туннель штатно остановлен.

004 и 004-live приняты через [PR #5](https://github.com/obolibok/filesystem-mcp/pull/5).
[004-portable](../tasks/004-portable-windows.md) обеспечивает автономные Node,
MCP и tunnel-client, конфигурацию нескольких roots и операторские инструкции.
[Builder и verifier](../development/windows-portable.md) создают поставку в
ignored out/; templates и обезличенные доказательства хранятся в Git.
Сборка от 24.09 историческая, актуальная указана выше. Credentials в чистую
поставку не включены.

## Запуск 010, 2026-10-09

Карточка и triage опубликованы в main checkpoint
`151dfa1feefcd74b80c69e939f3e8b5ec30ee7cb` перед созданием задачи.
Запрошенное название — `010 - bounded list traversal and result limits`,
проект `SWB RAG Dev`, модель `gpt-6.1-sol`, effort `xhigh`, managed worktree.

Приложение приняло запуск и вернуло pending creation ID
`client-new-thread:8b8ef23b-5dc8-45f4-a203-850184494493`.
В Git подтверждён worktree `22c3` на checkpoint; карточка и triage доступны.
При review установлен настоящий threadId `01a1213c-22fa-7ed2-95e4-66591c4dcd23`,
host `local`; checkout и готовый результат подтверждены через read_thread.
Pending ID сохранён только как история создания; повторную задачу не создавать.
Ветка исполнителя `codex/010-bounded-list`, первый review head
`7fabbe0bf4e88eab1aa30181d9569f23b9ccacb3`. Review и замечания — в
[протоколе R1](../testing/010-review-r1-2026-10-09.md).

Переданы разрешение на реализацию, scope, чистый контракт limit/pageSize,
regressions/full check, docs и локальный commit/handoff. Центральную доску,
push/PR/merge, новую поставку и live ведёт планирование. Production roots,
установленный сервис и tunnel/key не являются зависимостями реализации.

## Запуск 009, 2026-10-08

Карточка опубликована в main checkpoint
`fcb801909a8861e590fc59802f4922079776e773` перед созданием задачи.
Запрошенное название — `009 - tool selection and inventory guidance`, проект
`SWB RAG Dev`, модель `gpt-6.1-sol`, effort `xhigh`, отдельный managed worktree.
Модель уточнена пользователем до dispatch; GPT-6-Sol не запускалась.

Приложение вернуло pending creation ID
`client-new-thread:854080ef-a635-4c95-9286-dba045a1d818`.
Worktree приложения `ec59` создан от этого checkpoint, наличие карточки и
ветки `codex/009-tool-selection` независимо подтверждено. В списке задач API
пока не появился настоящий threadId; первый ответ через API не прочитан.
Pending ID не использовать как threadId; повторную задачу не создавать.

Исполнителю разрешены правки в scope карточки, synthetic/wire checks, полный
check, reference/live-протокол, Work record и локальный commit. Push/PR/merge,
обновление установленного комплекта и живую приёмку ведёт планирование.
Исходный экспорт остаётся вне Git; новым worktree он не требуется.

## Запуск 008, 2026-09-25

Пользователь разрешил реализацию. Карточка и разрешение опубликованы в main
`2f993a60`. Запрошенное название — `008 - job metadata persistence`, проект
`SWB RAG Dev`, модель `gpt-6-sol`, effort `xhigh`, отдельный managed worktree.

Планирование подготовило checkpoint `5028c06c352d6e2753e577b8f0a16396c6bdbedb`:
reviewed runtime 007 + актуальные docs/main. Подготовка выполнена в собственном
review checkout, не в main. Diff по src/tests/scripts/package files к
`832a6771cd3938947c24329b6d06a512bf5605db` пуст. Исполнитель сначала создаёт
ветку `codex/008-job-metadata-persistence` в своём worktree и вносит checkpoint,
потом воспроизводит и исправляет дефект. База сохраняет карточку и work record 007.

Create вернул `client-new-thread:124e05ff-bb05-40d0-b66e-cea8396c6048` — pending
creation ID, не настоящий task ID. Создание worktree `55a7` на main `2f993a60`
и наличие карточки независимо проверены. На момент записи API списка задач ещё
не вернул новый task ID, первый ответ исполнителя не подтверждён. Повторный
запрос создания не отправлять.

Launch prompt разрешает runtime fix в scope 008, synthetic Windows handle/polling
и deterministic tests, полный check, reference/work record и локальный commit.
Установленный комплект, production roots, jobs и tunnel не являются зависимостями.
Push/PR/merge, приёмку, новую поставку и live ведёт планирование.

## Запуск 006, 2026-09-24

Карточка опубликована в main commit `3b7059cc7f2b48b41888b776a5826a706a0ba77a`.
Запрошенное название — `006 - shared snapshot reuse`, проект `SWB RAG Dev`,
модель `gpt-6-sol`, effort `xhigh`. Приложение создало отдельный worktree `c641`
на этом checkpoint; HEAD и наличие карточки независимо проверены.
Рабочая ветка `codex/006-shared-snapshot-reuse` уже создана в этом worktree; проверено через Git.

Create вернул `client-new-thread:e9141ef5-2d09-491e-b502-2be6d7d96249`;
это pending creation ID, не настоящий task ID для API. На момент записи запуск
принят, первый ответ исполнителя ещё не подтверждён. Не создавать дубликат.
Пользователь затем подтвердил работающего исполнителя; 2026-09-24 результат передан на review. Prompt разрешает реализацию, локальные проверки, документацию и commits.
Code review, cloud/live проверка, push/PR/merge и обновление поставки остаются
у планирования. 005 не перенумерована и ожидает завершения 006.

## Приёмка 004 и 004-live, 2026-09-21

[PR #5](https://github.com/obolibok/filesystem-mcp/pull/5) слит в `main`:
[merge `9bec9f40`](https://github.com/obolibok/filesystem-mcp/commit/9bec9f4018587a28e488551b36dd273960a6ab65).
Проверенный head — `359cec25086e55f17f66a07a81f1c593fd860a2f`,
интеграционная ветка `codex/004-integration`.

- Code review R1–R8 закрыт на runtime `82e8d18756e1787f41379720b5c5dd6f29fe42ca`;
  этот же runtime прошёл live и вошёл в main без последующих изменений.
- [Live-отчёт](../testing/004-live-2026-09-21.md) и
  [независимая приёмка](../testing/004-integration-2026-09-21.md): ZIP/XLS,
  multipart 7 × 1 MiB, reuse/conflict, повтор крупнейшей части, partial/missing — PASS.
  Client hashes сверены с server artifacts, CRC и original bytes; source hash-tree
  неизменён. Крупнейший полученный ZIP — 1049126 B, это наблюдение, не предел ChatGPT.
- Ctrl+C завершил tunnel штатно; процесс отсутствует и readyz недоступен.
  Зависание из опыта 003 не повторилось; его причина не установлена.
- В новом live helper при интеграции исправлена canonical проверка destinations
  через junction/8.3 alias. Шесть regressions (18 CLI-сценариев) и свежая локальная
  ZIP/XLS доставка прошли. Серверный runtime этой дельтой не затронут.
- Финальный локальный `npm run check`: 409 tests, 401 pass, 0 fail, 8
  platform/permission skips; static checks также PASS.
- [CI проверенного head](https://github.com/obolibok/filesystem-mcp/actions/runs/35649089044):
  полный `npm run check` PASS на Windows (406 pass, 3 skips) и Ubuntu
  (401 pass, 8 skips); по 409 tests, 0 fail. POSIX FIFO проверен на Ubuntu.

Исполнитель live — `004-live - Windows ChatGPT bundle`, task
`01a0c45b-e972-71f3-9177-2801312cd01f`, handoff
`edbe2c2f77463d0ec3e4b694595f84c4266b7da3`.
Исполнитель кода — `004 - selected originals bundle`, task
`01a0c043-36d8-7b91-b9cc-dc49b31686a0`, ветка `codex/004-selected-originals-bundle`.
Synthetic evidence остаётся локально; в Git сохранены обезличенные протоколы.

## Запуск 004-live, 2026-09-21

Пользователь поручил создать отдельную тестовую задачу на GPT-5.6-Sol / Extra High.
Запрошенное название — `004-live - Windows ChatGPT bundle`; проект `SWB RAG Dev`,
модель `gpt-5.6-sol`, effort `xhigh`, отдельный worktree.

Карточка опубликована в main commit `bff8eba55d7efc6a5f59097b1a6690226ca1b727`.
Приложение создало worktree `4090`; его HEAD и наличие карточки независимо проверены.
Create вернул `client-new-thread:165e79d3-f649-40e8-b524-f4a12a98078d` (pending ID,
не task ID для API). Затем пользователь подтвердил, что исполнитель работает.
При приёмке список задач подтвердил ID `01a0c45b-e972-71f3-9177-2801312cd01f`
и название `004-live - Windows ChatGPT bundle`. Pending ID сохранён как история запуска.

Prompt поручает в собственном worktree создать `codex/004-live-windows-chatgpt`,
объединить docs-базу с reviewed runtime `82e8d18756e1787f41379720b5c5dd6f29fe42ca`
и подтвердить отсутствие runtime-дельты. На момент запуска main ещё не содержал bundle; testing
merge разрешён только в ветку опыта. Исполнитель ведёт пользователя по одному шагу:
Windows setup, собственный tunnel/profile, ChatGPT, малый ZIP/XLS, multipart,
reuse/conflict/repeated fetch, partial outcome, verifier/evidence и ограниченный
teardown. Shutdown и functional result записываются отдельно. Ключи остаются
локально; production roots не нужны.

Исполнитель владеет карточкой/live report и локальными commits. Центральная доска,
приёмка, публикация результатов, CI и main merge остаются у планирования.

## Запуск 004, 2026-09-20

Название в запросе: `004 - selected originals bundle`, модель `gpt-5.6-sol`,
effort `xhigh`, проект `SWB RAG Dev`. Приложение создаёт отдельный worktree;
запрошенная рабочая ветка — `codex/004-selected-originals-bundle`.

Карточка опубликована в base `51149b06d3112cb374559cc71b5438dbcbbe55ae`.
В созданном worktree `025a` независимо проверены точный base и наличие карточки.
Приложение вернуло pending creation ID
`client-new-thread:7ba85be7-71af-49fd-b256-75d53aa8eff1`; это ещё не task ID.
При первоначальной записи фактический task ID/первый ответ исполнителя ещё не
были получены. Позднее пользователь подтвердил создание задачи и выполнение
работы. В Git независимо видна ветка `codex/004-selected-originals-bundle` в
worktree `025a`. Инструмент списка задач пока не возвращает её task ID; pending
ID выше остаётся историей dispatch и не заменяет настоящий task ID. Повторный
запрос создания не отправлять.

Prompt передаёт разрешение начать реализацию, полный scope карточки, локальные
проверки и commit/handoff. Центральную доску, live ChatGPT опыт и push/PR/merge
ведёт планирование. Данные/секреты/чужой tunnel не являются зависимостями.

## Приёмка задачи 003, 2026-09-20

[PR #4](https://github.com/obolibok/filesystem-mcp/pull/4) слит в `main`:
[merge `2de005ec`](https://github.com/obolibok/filesystem-mcp/commit/2de005ec37d632e43f188bc8de9d6671d94cefc2).
Итоговый head: `e3c088d4ea08ca0bf76bbff7fa9080fce86b8094`, интеграционная ветка
`codex/003-integration`. В ней объединены код исполнителя, planning evidence и
исправления Windows, найденные при интеграции.

- Фоновый `snapshot`, `job_status`, `cancel_job`, `get_artifact`: manifest и
  самостоятельные сжатые CSV/ZIP части; idempotency, restart, TTL, quotas,
  ограниченный обход и scratch вне исходников. Сохранены PathGuard/GuardedFileSystem.
- [Code review](../testing/003-review-r3-2026-09-20.md) исходного runtime `9ff20792`:
  R1–R8 и два уточнения evidence закрыты. Независимый полный check исходного head:
  380 tests, 373 pass, 0 fail, 7 прежних Windows skips.
- При интеграции исправлен startup с настоящим Windows 8.3 TEMP: ссылки в scratch
  и ancestors проверяются до mkdir, а storage I/O использует canonical scratch.
  Direct-pipeline fixtures и benchmark теперь нормализуют paths как рабочий tool;
  assertions сохранены. [Протокол интеграции](../testing/003-integration-2026-09-20.md).
- Локальный полный check после startup fix: 385 tests, 378 pass, 0 fail, 7 прежних
  skips. Финальный follow-up: весь runner под short TEMP — те же 378 pass / 0 fail /
  7 skips; полный `check:static` PASS. Пять новых alias/junction regressions и весь
  snapshot suite 27/27 прошли без skips; независимое review follow-up — PASS.
- [CI итогового head](https://github.com/obolibok/filesystem-mcp/actions/runs/35530671618):
  полный `npm run check` на обеих платформах — PASS. Windows: 383 pass, 0 fail,
  2 platform skips; Ubuntu: 380 pass, 0 fail, 5 platform skips; всего по 385 tests.
- [Живой ChatGPT опыт](../testing/003-live-2026-09-20.md) на `9ff20792` —
  **PASS: smoke, main и upper**. Main: 21011 уникальных путей, 103801018 B CSV,
  три ZIP около 5,53 / 5,53 / 1,11 MB. Upper: 13852 уникальных пути,
  47183919 B CSV, ZIP 7802264 B. Все manifest/ZIP материализованы;
  SHA-256/CRC/CSV и полные эталоны совпали; повторная доставка больших частей
  побайтово идентична. Main подтвердил reuse/conflict. Планирование сверило
  пользовательские отчёты с jobs и серверными hashes, независимо разобрало upper.
  Последующая startup-дельта не меняла CSV/ZIP producer или delivery.

Максимальный проверенный ZIP — 7802264 B; это не установленный предел ChatGPT.
Реальный обход миллионов файлов в течение 20–30 минут не проверялся;
[отдельный pipeline benchmark](../testing/snapshot-benchmark-2026-09-20.md)
проверил 3 млн metadata records. После canonical follow-up настоящий walk под
short TEMP также прошёл: 21000 rows, errors 0, `verified: true`.

Исполнитель: `003 - compressed snapshot`, task
`01a0be9c-0f01-7c42-8abb-a6ff550e1532`, ветка `codex/003-compressed-snapshot`.
Три live jobs завершены. После merge пользователь вручную завершил туннель:
окно PowerShell с туннелем больше часа оставалось в `stopping`. Остановка
подтверждена пользователем, штатный graceful shutdown не подтверждён; причина
зависания не установлена. [Запись инцидента](../testing/003-live-2026-09-20.md).
Функциональный live PASS сохраняется; пользователь отдельно подтвердил работу 004.
Synthetic материалы сохранены локально; cleanup после forced termination не проверялся.

## Запуск 003, 2026-09-20

Запрошена рабочая задача с названием `003 - compressed snapshot`, модель
`gpt-5.6-sol`, effort `xhigh`. Приложение вернуло pending creation ID
`client-new-thread:92fb736a-49d0-4763-90af-61911445f7c0`; это ещё не task ID.
Новый worktree создан на базе `ce4f22b4f9ca453d915100c3206363d96dc6d208`,
карточка и измерения в нём присутствуют. В prompt передана ветка
`codex/003-compressed-snapshot` и поручение начать локальную реализацию.
Фактический task ID подтверждён через handoff и app read_thread:
`01a0be9c-0f01-7c42-8abb-a6ff550e1532`, название `003 - compressed snapshot`.
Pending ID выше сохраняется только как история запуска. Push/PR/merge исполнителю
не поручены.

## Приёмка задачи 002-tool, 2026-09-20

Исполнитель — `002 - originals delivery experiment`, task
`01a0b975-35f7-73f1-b94c-caf22ab46fa9`; ветка `codex/002-tool-delivery`.
Проверен commit `881f94d684b513f460491bae701b7292e402e072` относительно базы
`84eb8221ab405d2201208dcfe4e771bdab994100`.
[PR #3](https://github.com/obolibok/filesystem-mcp/pull/3) принят и слит в `main`:
[merge `fc279005`](https://github.com/obolibok/filesystem-mcp/commit/fc279005174be35c642ad042c7fcdfe2483c9c7b).

- Добавлен read-only `get_file`: исходные bytes в стандартном MCP embedded
  resource и согласованный `resource_link` в результате tools/call. Сохранены
  PathGuard, raw-size limit, отмена запроса и отсутствие серверных парсеров.
- По протоколу исполнителя `docs/testing/tool-originals-delivery.md` в этой ветке
  ChatGPT материализовал ZIP 703 bytes и BIFF8 XLS 5632 bytes, вычислил SHA-256
  полученных файлов, открыл три ZIP entry и прочитал все семь контрольных XLS cells.
  XLS получен двумя отдельными вызовами; ZIP повторился при permission round-trip.
  Эти live-наблюдения опираются на протокол исполнителя и handoff пользователя;
  планирование повторно не запускало ChatGPT/tunnel.
- Независимый `npm ci` и `npm run check` в изолированном checkout проверенного
  commit: 358 tests, 351 pass, 0 fail, 7 известных platform/permission skips.
  Отдельный повтор трёх регрессий harness: 3 pass, 0 fail, 0 skip.
- Review runtime, harness и evidence не выявило блокирующих замечаний.
  Неблокирующее уточнение перед интеграцией: старый
  [протокол стенда](../testing/originals-delivery.md) ещё описывает актуальный
  harness через resources/read/cache bypass. Сохранить исторические измерения,
  но пометить смену маршрута на get_file и сослаться на новый протокол.
- Размеры выше этих малых fixtures в ChatGPT, остальные форматы и lifecycle
  не проверены. Локальные size-limit тесты не заменяют ограничения принимающего host.
  По handoff tunnel остановлен; профиль, backup и synthetic стенд сохранены локально.
- [CI PR #3](https://github.com/obolibok/filesystem-mcp/actions/runs/35505903279):
  Windows и Ubuntu jobs выполнили полный repository check со статусом `success`.
  Review follow-up пометил прежний `resources/read` протокол историческим и сослался
  на текущий `get_file` протокол. `snapshot`, `bundle`, OAuth и публичный файловый
  сервис не реализованы.

## Результат 002-live, 2026-09-20

[Обезличенный отчёт](../testing/windows-chatgpt-live.md) и Work record сохранены
из рабочего checkout. Исходные файлы/настройки исполнителя не изменялись.

- Windows-клиент туннеля, plugin connection, discovery и live calls tools — PASS.
- Локальный synthetic ZIP/XLS delivery и независимый verifier — PASS.
- Изолированный ZIP опыт в ChatGPT: ROUTE_FAIL_NOT_MATERIALIZED. Найденный оригинал
  не получен, поскольку текущий host не предоставил вызываемый resources/read;
  файла и запуска Python в analysis runtime не было.
- XLS в ChatGPT не запускали: это не второй независимо наблюдавшийся FAIL.
  Production-файлы не выбирались. Следующий эксперимент — 002-tool.
- При последней записи daemon/profile/plugin были оставлены на стенде; их текущее
  состояние и требуемые перезапуск/teardown выясняет исполнитель следующего опыта.

002-live остаётся историей отрицательного результата маршрута resources/read;
доставку через get_file и состояние teardown уточнил следующий опыт 002-tool выше.
Оба результата приняты при интеграции PR #3. 003/004 не начинать до назначения
следующей задачи планированием.

## Приёмка задачи 002

[PR #2](https://github.com/obolibok/filesystem-mcp/pull/2) принят и слит в `main`:
[merge a34fdeb6](https://github.com/obolibok/filesystem-mcp/commit/a34fdeb6ab8b416c1fec2995df13a613bba8710c).
Проверенный head: `8655a6e3425e2b4444f20ed58c3756582534ad37`.

- Приняты deterministic ZIP и BIFF8 XLS fixtures, MCP harness, независимый Python
  verifier и [протокол с доказательствами](../testing/originals-delivery.md).
- На review исправлены SDK cache при повторе, ложноположительные отрицательные
  проверки и canonical path validation для delivery. Добавлены три регрессии;
  запуск через Windows drive alias также проверен. Уточнены tunnel credentials
  и отдельный preflight поддержки Windows. Серверный runtime/контракт не менялся.
- Независимый Windows повтор: hashes исходников и полученных файлов совпали,
  ZIP integrity/entries и семь XLS cells — PASS. Полный локальный check:
  353 tests, 346 pass, 0 fail, 7 известных platform/permission skips.
- [CI проверенного head](https://github.com/obolibok/filesystem-mcp/actions/runs/35451713418):
  Windows — 351 pass, 0 fail, 2 POSIX-only skips; Ubuntu — 350 pass, 0 fail,
  3 Windows-only skips. Оба jobs выполнили полный `npm run check`.
- Принимающая среда ChatGPT, совместимый Windows tunnel client и материализация
  MCP resource bytes в файл пока не проверены. Это предмет 002-live, а не
  подтверждённая возможность интегрированного стенда.

## Приёмка задачи 001

[PR #1](https://github.com/obolibok/filesystem-mcp/pull/1) принят и слит в `main`:
[merge commit 6cc8c564](https://github.com/obolibok/filesystem-mcp/commit/6cc8c564c7e25c2f3d3e665631881f6dc847e85e).
Проверенный head: `a52ea0d1de5e975dc0a2a6edd0851584c9f539c2`.
Исполнитель — задача `001 - baseline defects fix`, ветка `codex/001-baseline-defects`.

- UTF-16 LE/BE с BOM явно отклоняется в текстовом чтении, включая SVG;
  file resources сохраняют исходные bytes. Binary search публикует причины пропуска.
- На review закрыт обход encoding policy для полного чтения SVG (`3fe4e68a`).
  Windows CI выявил ошибочный подсчёт short/long aliases как разных roots;
  исправлены выбор default root и неверные test assumptions (`a52ea0d1`).
  Expanded allow-list и проверки requested/resolved paths сохранены; новый lookup
  получает сигнал отмены запроса.
- Финальный локальный `npm run check`: 350 tests, 343 pass, 0 fail, 7 skips
  (два POSIX-only сценария и пять недоступных file-symlink сценариев).
  Дополнительно 30/30 targeted cases прошли с настоящим Windows 8.3 temp alias.
- [CI итогового head](https://github.com/obolibok/filesystem-mcp/actions/runs/35439791900):
  Windows — 348 pass, 0 fail, 2 POSIX-only skips; Ubuntu — 347 pass, 0 fail,
  3 Windows-only skips. Обе платформы выполнили полный `npm run check`.
- Принятые ограничения: классификация содержимого по первым 512 bytes;
  UTF-16 без BOM и произвольные legacy encodings не распознаются.
  Версии и зависимости не менялись. Reference и Windows runbook актуализированы.

Историческая база: исходники `4f2625bf`, version 2.3.0. 329 тестов прошли, 7
пропущены, полный check остановился на Windows EOL. Наблюдения и ограничения
зафиксированы в [baseline](../testing/baseline-2026-09-19.md); это не результат
проверок принятого исправления.

## Решения по очередности

- Сначала восстановить надёжность чтения/поиска и воспроизводимую проверку Windows.
- Delivery проверять отдельным опытом до реализации больших архивов.
- `snapshot` и общий jobs/artifacts lifecycle приняты в 003; `bundle` принят в 004.
- OAuth/multi-user, постоянный индекс и серверные парсеры сейчас не назначены.

После каждой интеграции сохранять ссылку на принятый commit/PR, итог acceptance,
актуальный reference и состояние зависимых задач. Новые coding-задачи начинать
от принятого `main`; пересекающиеся изменения core назначать последовательно.

## Передача 007, 25.09.2026

Пользователь разрешил реализацию. Base checkpoint:
`86b7eafc6be7f97cf1a0cdc013426c48ac402585`, опубликован в main до запуска.
Приложению передан prompt с карточкой/triage, synthetic regressions, scope,
проверками и handoff без изменения установленного сервера.

Запрошенное название задачи: `007 - snapshot walk recovery`; модель `gpt-6-sol`,
effort `xhigh`, проект SWB RAG Dev, environment=worktree. Приложение вернуло
pending clientThreadId `client-new-thread:29a11d3c-8525-4016-926f-2566bd99966e`.
Отдельный worktree `7799` создан на указанной базе; наличие карточки проверено.
На момент передачи реальный threadId и первый ответ исполнителя ещё не доступны
через список задач. Pending id не используется как threadId и повторный запуск
не выполняется. После готовности исполнитель назначает рабочую ветку
`codex/007-snapshot-walk-recovery` и ведёт Work record карточки.

## Review 007, 25.09.2026

Исполнитель передал aca33f39, реальный threadId: 01a0d7d8-88f3-7480-84fe-7d4d1f436f6e.
Независимый full check PASS (427 tests, 419 pass, 8 skips), однако дополнительные
synthetic проверки подтвердили R1: sensitive child стал fatal и R2: теряется
fatal path при 8.3 scratch. [Протокол](../testing/007-review-r1-2026-09-25.md).
Замечания переданы на исправление в прежнюю задачу. До повторного review
интеграция и обновление пользовательского комплекта не выполняются.
