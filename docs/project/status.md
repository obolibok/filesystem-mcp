# Приоритеты и интеграция

Владелец — архитекторский/планирующий чат. Обновлено 2026-11-26.
Начать с [handover архитектору](architect-handover-2026-10-29.md).
Задачи 024–028 приняты и вошли в `main`.
Предыдущая хроника сохранена в [архиве](history/status-2026-10-29.md).

| ID           | Работа                                                                                        | Статус | Зависит от         |
| ------------ | --------------------------------------------------------------------------------------------- | ------ | ------------------ |
| 000          | Подготовка контекста и правил работы                                                          | done   | —                  |
| 001          | [Baseline-дефекты и Windows](../tasks/001-baseline-defects.md)                                | done   | 000                |
| 002          | [Стенд доставки originals](../tasks/002-originals-delivery.md)                                | done   | 001                |
| 002-live     | [Живой прогон Windows/ChatGPT](../tasks/002-live-windows-chatgpt.md)                          | done   | 002                |
| 002-tool     | [Выдача originals через tool](../tasks/002-tool-delivery.md)                                  | done   | 002, 002-live      |
| 003          | [Фоновый snapshot и сжатые части](../tasks/003-compressed-snapshot.md)                        | done   | 002-tool           |
| 004          | [Bundle выбранных originals](../tasks/004-selected-originals-bundle.md)                       | done   | 003                |
| 004-live     | [Живой bundle Windows/ChatGPT](../tasks/004-live-windows-chatgpt.md)                          | done   | 004 review PASS    |
| 004-portable | [Переносимый Windows-комплект](../tasks/004-portable-windows.md)                              | done   | 004                |
| 006          | [Общее переиспользование снимков](../tasks/006-shared-snapshot-reuse.md)                      | done   | 003, 004-portable  |
| 007          | [Устойчивость snapshot и fatal diagnostics](../tasks/007-snapshot-walk-recovery.md)           | done   | 006                |
| 008          | [Надёжность job metadata на Windows](../tasks/008-job-metadata-persistence.md)                | done   | 007 runtime        |
| 009          | [Выбор инструментов и понятные результаты](../tasks/009-tool-selection.md)                    | done   | 007, 008           |
| 010          | [Ограниченный list и ясные лимиты](../tasks/010-bounded-list.md)                              | done   | 009                |
| 011          | [Ограниченный поиск и пагинация](../tasks/011-bounded-search.md)                              | done   | 010, triage        |
| 012          | [Память и TTL пагинации](../tasks/012-pagination-memory-study.md)                             | done   | 010, triage        |
| 013          | [Машина и тома источников](../tasks/013-source-provenance.md)                                 | done   | 011, 012           |
| 014          | [Экспериментальный snapshot_tree](../tasks/014-snapshot-tree.md)                              | done   | 013                |
| 015          | [Отдельные настройки snapshot_tree](../tasks/015-snapshot-tree-settings.md)                   | done   | 014 live           |
| 016          | [Tree как основной формат snapshot](../tasks/016-tree-default.md)                             | done   | 014, 015, live A/B |
| 017          | [Production dependency remediation](../tasks/017-production-dependency-remediation.md)        | done   | 016                |
| 018          | [Guarded I/O race hardening](../tasks/018-guarded-io-race-hardening.md)                       | done   | 017                |
| 019          | [Identity-bound destructive confirmations](../tasks/019-confirmation-identity.md)             | done   | 018                |
| 020          | [Runtime key в portable config](../tasks/020-portable-runtime-key.md)                         | done   | 017–019            |
| 021          | [Диагностика provenance](../tasks/021-provenance-diagnostics.md)                              | done   | 020                |
| 005          | [Контролируемое повторение предметного исследования](../tasks/005-controlled-domain-study.md) | done   | 004, 006, 007, 008 |
| 022          | [Единый portable для stdio и HTTP](../tasks/022-universal-portable.md)                        | done   | 020, 021           |
| 023          | [Постоянный файловый каталог](../tasks/023-persistent-file-catalog.md)                        | done   | 006, 015, 018, 022 |
| 024          | [Защищённые элементы при индексации](../tasks/024-catalog-protected-entries.md)               | done   | 023                |
| 025          | [SQL для опубликованного каталога](../tasks/025-catalog-sql.md)                               | done   | 024                |
| 026          | [Встроенная справка каталога](../tasks/026-catalog-help.md)                                   | done   | 025                |
| 027          | [Выгрузка опубликованного индекса](../tasks/027-export-published-index.md)                    | done   | 025, 026           |
| 028          | [Бюджет контекста search_text](../tasks/028-search-text-context-budget.md)                    | done   | 011                |

proposed — направление без назначения; ready — согласованная карточка;
active — назначен исполнитель; review — проверяемый результат; done — принят
и интегрирован. При новом назначении сохранять фактические thread, branch и base.
Центральную доску ведёт планирование, coding-чаты — Work record своих карточек.

## Последняя приёмка

- **028 (26.11)** — `search_text` выдаёт до 500 Unicode code points на
  совпадение и до 16 КиБ UTF-8 на модельный ответ. Ревью коммита `556d9f58`,
  полный локальный check, CI Windows/Ubuntu и portable Verify 62/62 прошли.
  На комплекте stdio/HTTP вернули по 11 записей из .mbt и .txt в 5 071 байте.
  Все 60 Unicode-совпадений прошли по шести страницам без дублей. Пакет
  `FileMCP-028-pilot-556d9f58.zip`, SHA-256
  `da854f17d8d27dc691707bd70a80778f5decf638fd90fb3a30ac892d6178eaaa`.
  Пользователь подтвердил прогон с Flash в тестовом Open WebUI. Merge `d4b238ba`.
  [PR #28](https://github.com/obolibok/filesystem-mcp/pull/28),
  [CI #200](https://github.com/obolibok/filesystem-mcp/actions/runs/45819447409),
  [карточка 028](../tasks/028-search-text-context-budget.md).

- **027 (24.11)** — `export_index` выгружает опубликованное поколение любого
  возраста через стандартные задания и артефакты. Справка MCP и инструкция
  portable описывают выбор инструмента и поля манифеста.
  [PR #27](https://github.com/obolibok/filesystem-mcp/pull/27), merge `d590e22f`.
  [CI #196](https://github.com/obolibok/filesystem-mcp/actions/runs/45371287901)
  Windows/Ubuntu PASS. Portable из `0ed3c7d9` прошёл Verify 62/62 на
  синтетических источниках. [Карточка 027](../tasks/027-export-published-index.md).

- **026 (23.11)** — подсказки для SQL по опубликованному индексу в сообщении
  при подключении, `get-help` и `internal://instructions`.
  [PR #26](https://github.com/obolibok/filesystem-mcp/pull/26), merge `bc3876e5`.
  [CI #191](https://github.com/obolibok/filesystem-mcp/actions/runs/45127200003)
  Windows/Ubuntu PASS. Однофайловый патч проверен через stdio и HTTP на копии
  portable 025. Справка загружается при следующем запуске процесса.
  [Карточка 026](../tasks/026-catalog-help.md).

- **025 (22.11)** — SQL по опубликованному индексу, фильтр по типу записи,
  стартовая индексация и переиспользование готовых поколений. Справка объясняет
  выбор между `search_index`, `query_index` и `snapshot`.
  [PR #25](https://github.com/obolibok/filesystem-mcp/pull/25), merge `57036f96`.
  [CI #188](https://github.com/obolibok/filesystem-mcp/actions/runs/45019872081)
  Windows/Ubuntu PASS. Portable из `450e8851` прошёл Verify 60/60 на
  синтетических источниках. [Карточка 025](../tasks/025-catalog-sql.md).

- **024 (22.11)** — штатные исключения Windows и диагностика отказа индексации.
  [PR #24](https://github.com/obolibok/filesystem-mcp/pull/24), merge `5d13d96f`.
  [CI #176](https://github.com/obolibok/filesystem-mcp/actions/runs/44949133923)
  Windows/Ubuntu PASS. Изолированная проверка на пилотном корне опубликовала
  пригодное поколение с 61 исключением.
  [Карточка 024](../tasks/024-catalog-protected-entries.md).

- **023 (21.11)** — общий SQLite-каталог и экспорт через прежний snapshot.
  PR #23 принят после повторного CI и проверки исключительного владения scratch.
  Portable из `6107fa72` прошёл Verify 54/54. Комплект и контрольная сумма
  записаны в [карточке 023](../tasks/023-persistent-file-catalog.md).

- **022 (11.11)**: единый portable config/Start для stdio и HTTP; общий
  roots/scratch/format/limits, отдельный HTTP key с config/prompt fallback.
  [PR #22](https://github.com/obolibok/filesystem-mcp/pull/22), head `8eef4afb`,
  merge/build `ff8b8e90`. [PR CI #163](https://github.com/obolibok/filesystem-mcp/actions/runs/42983280831)
  Windows/Ubuntu PASS; [main CI #164](https://github.com/obolibok/filesystem-mcp/actions/runs/42983787014)
  PASS после retry существующей test-helper race без изменения кода.
  Локальный full check 590/0/13; финальный Verify **51/51 PASS**; source/packaged
  production audit 0, ZIP parity всех 2,833 файлов PASS.
  [Контракт, границы, комплект и SHA-256](../tasks/022-universal-portable.md).
- **005 (07.11)**: пользователь принял предметный опыт 27–28.10 на копии архива
  предприятия. В отдельном ChatGPT-чате выполнены пять вопросов руководства:
  поиск по снапшотам, получение и анализ originals, отчёты DE/RU и расчётные
  материалы. Сохранены оговорки о неполноте, допущениях и устаревшем бэкапе.
  Это приёмка файлового исследовательского цикла; независимая численная сверка
  всех ответов и работа локальной модели остаются за её пределами.
  [Результаты и границы доказательств](../tasks/005-controlled-domain-study.md).
- **021 (06.11)**: безопасные warnings отказов Windows provenance и показ при
  успешном preflight. Запуск helper, PowerShell scripts/flags, timeout и null
  fallback сохранены. [PR #21](https://github.com/obolibok/filesystem-mcp/pull/21),
  merge `ebeec548`, head/build source `adc74d52`.
  [CI #156](https://github.com/obolibok/filesystem-mcp/actions/runs/42203049178)
  Windows/Ubuntu PASS; targeted 15/15, full check 590/0/13, portable **36/36 PASS**.
  Новый ZIP проверен по SHA-256/CRC всех 2,833 файлов.
  [Контракт, ограничения, комплект и SHA-256](../tasks/021-provenance-diagnostics.md).
- **020 (06.11)**: optional `runtimeApiKey` в portable config; непустой ключ
  используется без prompt, пустое/отсутствующее/null поле сохраняет скрытый ввод
  без записи. [PR #20](https://github.com/obolibok/filesystem-mcp/pull/20), merge
  `a3af994b`. Итоговый head `32e452ed`,
  [CI #152](https://github.com/obolibok/filesystem-mcp/actions/runs/42198319160)
  Windows/Ubuntu PASS; локальный check 585/0/13, portable Verify **35/35 PASS**.
  Чистый portable 020 собран из `dabb61b1`, production audit — 0, ZIP parity PASS.
  [Контракт, проверки, комплект и SHA-256](../tasks/020-portable-runtime-key.md).
- **Portable 017–019 (30.10)**: собран из `main` `282464ca`, Verify **24/24 PASS**,
  production audit — 0. ZIP и все 2,833 файла проверены по SHA-256/CRC.
  [Комплект, контрольная сумма и протокол](../testing/017-019-portable-2026-10-30.md).
  Пользовательский smoke ожидается; установленный сервис и рабочий туннель не менялись.
- **019**: [PR #19](https://github.com/obolibok/filesystem-mcp/pull/19), merge
  318173d0c0f0f359e7c7be712884d6e7d000400f. Review и security diff scan без замечаний.
  Runtime 9f5cb02a, итоговый PR head 70f7b23a. Конфликт касался только карточки.
  [Протокол](../testing/019-review-integration-2026-10-29.md).
  Независимый Windows check 585/0/13; [PR CI](https://github.com/obolibok/filesystem-mcp/actions/runs/40958756222):
  Windows 593/0/5, Ubuntu 582/0/16, всего 598 tests. Новые 53 регрессии без skips.
- **018**: [PR #18](https://github.com/obolibok/filesystem-mcp/pull/18), merge
  c651d077; guarded I/O, exclusive creation и Windows aliases. Final head ea794fd1,
  Windows/Ubuntu CI PASS.
- **017**: [PR #17](https://github.com/obolibok/filesystem-mcp/pull/17), merge
  a87ad6b; production dependencies, source/portable checks и Windows/Ubuntu CI PASS.
- **016**: [PR #15](https://github.com/obolibok/filesystem-mcp/pull/15), merge
  77a9e71; tree-depth-v1 по умолчанию, explicit stable, portable Verify 24/24 PASS.

## Следующие решения

1. Пользовательский smoke portable 022: прежний stdio/ChatGPT round-trip и
   новое HTTP-подключение локального агента, originals/artifacts в его расчётную
   среду. Для 021 на целевой машине ранее подтверждены BUILD sourceCommit,
   LOCAL_MCP_PASS, 13 tools/tree и заполненные UUID/volume metadata трёх roots.
   Пользователь наблюдал два задержанных
   окна Avast, warnings provenance нет; отказ helper в этом прогоне не выявлен.
   [Наблюдения и границы](../tasks/021-provenance-diagnostics.md#отдельный-preflight-на-целевой-машине-0611).
   Для определения детекта остаются command line/parent/PID; переделка provenance helper не назначена.
2. Dev dependency triage: npm ci 06.11 сообщил 14 full-graph findings (12 moderate,
   2 high); source и packaged production audit --omit=dev — 0. Нужен отдельный
   подробный full audit/triage. Счётчики 3 от 29.10 и 9 до remediation 017 — история.
3. Выборочное upstream triage: проверен v2.12.1 82da458e; 019 адаптирует v2.12.0
   b23023f2. Кандидаты без назначения: EXDEV move staging/cleanup, replace_text
   match limits и list timeout. Общий merge upstream не назначен.
4. Следующий предметный эксперимент — локальная модель с файлами: сначала
   получение одного оригинального Excel через FileMCP в расчётную среду,
   затем повторение тех же пяти вопросов. Облачный опыт 005 даёт материал для
   сравнения; старые ответы не заменяют независимый эталон. HTTP launcher готов
   в 022; клиентская передача в Python и целевой deployment ещё не проверены.

## Действующие ограничения

Snapshot — одна job на один root. Готовые/выполняющиеся snapshots переиспользуются
сервисом между чатами. maxAgeMs/forceRefresh управляют свежестью, result TTL —
хранением; это разные параметры. FS_SNAPSHOT_FORMAT / portable snapshotFormat:
tree по умолчанию, stable явно.

03.11 уточнены [операторские правила](../development/windows-portable.md#эксплуатация-и-сроки):
свежесть задаётся аргументами snapshot, TTL общий для snapshot/bundle;
параллельным portable нужны отдельные папки и scratch. Runtime и ZIP от 30.10
не менялись, новые live-проверки не выполнялись.

[ChatGPT A/B](../testing/014-chatgpt-ab-2026-10-29.md): R2 tree raw -65.7%, ZIP -28.2%,
query scan быстрее 19.9%, полный path-index быстрее 24.8%.
[Parity](../testing/015-local-r2-2026-10-29.md): exact paths/metadata совпали;
470 inaccessible skips в обоих форматах. Это результаты конкретной выборки.

После docs edits запускать targeted Prettier до push. CI #141/#142 падали на
Markdown formatting, исправление main #144 Windows/Ubuntu PASS. Историческая
хроника и прежние назначения перенесены в архив, не являются текущими задачами.
