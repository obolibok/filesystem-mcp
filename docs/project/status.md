# Приоритеты и интеграция

Владелец — архитекторский/планирующий чат. Обновлено: 2026-10-30.
Начать с [handover архитектору](architect-handover-2026-10-29.md).
Все назначенные coding-задачи приняты, активных исполнителей сейчас нет.
Предыдущая хроника сохранена в [архиве](history/status-2026-10-29.md).

| ID           | Работа                                                                                 | Статус   | Зависит от         |
| ------------ | -------------------------------------------------------------------------------------- | -------- | ------------------ |
| 000          | Подготовка контекста и правил работы                                                   | done     | —                  |
| 001          | [Baseline-дефекты и Windows](../tasks/001-baseline-defects.md)                         | done     | 000                |
| 002          | [Стенд доставки originals](../tasks/002-originals-delivery.md)                         | done     | 001                |
| 002-live     | [Живой прогон Windows/ChatGPT](../tasks/002-live-windows-chatgpt.md)                   | done     | 002                |
| 002-tool     | [Выдача originals через tool](../tasks/002-tool-delivery.md)                           | done     | 002, 002-live      |
| 003          | [Фоновый snapshot и сжатые части](../tasks/003-compressed-snapshot.md)                 | done     | 002-tool           |
| 004          | [Bundle выбранных originals](../tasks/004-selected-originals-bundle.md)                | done     | 003                |
| 004-live     | [Живой bundle Windows/ChatGPT](../tasks/004-live-windows-chatgpt.md)                   | done     | 004 review PASS    |
| 004-portable | [Переносимый Windows-комплект](../tasks/004-portable-windows.md)                       | done     | 004                |
| 006          | [Общее переиспользование снимков](../tasks/006-shared-snapshot-reuse.md)               | done     | 003, 004-portable  |
| 007          | [Устойчивость snapshot и fatal diagnostics](../tasks/007-snapshot-walk-recovery.md)    | done     | 006                |
| 008          | [Надёжность job metadata на Windows](../tasks/008-job-metadata-persistence.md)         | done     | 007 runtime        |
| 009          | [Выбор инструментов и понятные результаты](../tasks/009-tool-selection.md)             | done     | 007, 008           |
| 010          | [Ограниченный list и ясные лимиты](../tasks/010-bounded-list.md)                       | done     | 009                |
| 011          | [Ограниченный поиск и пагинация](../tasks/011-bounded-search.md)                       | done     | 010, triage        |
| 012          | [Память и TTL пагинации](../tasks/012-pagination-memory-study.md)                      | done     | 010, triage        |
| 013          | [Машина и тома источников](../tasks/013-source-provenance.md)                          | done     | 011, 012           |
| 014          | [Экспериментальный snapshot_tree](../tasks/014-snapshot-tree.md)                       | done     | 013                |
| 015          | [Отдельные настройки snapshot_tree](../tasks/015-snapshot-tree-settings.md)            | done     | 014 live           |
| 016          | [Tree как основной формат snapshot](../tasks/016-tree-default.md)                      | done     | 014, 015, live A/B |
| 017          | [Production dependency remediation](../tasks/017-production-dependency-remediation.md) | done     | 016                |
| 018          | [Guarded I/O race hardening](../tasks/018-guarded-io-race-hardening.md)                | done     | 017                |
| 019          | [Identity-bound destructive confirmations](../tasks/019-confirmation-identity.md)      | done     | 018                |
| 005          | Контролируемое повторение предметного исследования                                     | proposed | 004, 006, 007, 008 |

proposed — направление без назначения; ready — согласованная карточка;
active — назначен исполнитель; review — проверяемый результат; done — принят
и интегрирован. При новом назначении сохранять фактические thread, branch и base.
Центральную доску ведёт планирование, coding-чаты — Work record своих карточек.

## Последняя приёмка

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

1. Провести пользовательский smoke нового portable с 017–019. Комплект от 30.10
   собран из принятого main, synthetic Verify 24/24 и ZIP parity PASS; deployment
   и проверка через рабочий туннель ещё не выполнялись.
2. Dev dependency triage: свежий npm audit 29.10 — 3 package findings (2 high,
   1 moderate): @modelcontextprotocol/client, brace-expansion, smol-toml.
   Production audit --omit=dev — 0. Исторические 9 в карточке 017 — не текущий счётчик.
3. Выборочное upstream triage: проверен v2.12.1 82da458e; 019 адаптирует v2.12.0
   b23023f2. Кандидаты без назначения: EXDEV move staging/cleanup, replace_text
   match limits и list timeout. Общий merge upstream не назначен.
4. Предметный опыт 005 остаётся proposed: нужны выборка, вопрос и эталон.
5. Намерение воспроизвести tunnel Ctrl+C после Windows Sleep сохраняется;
   подтверждённого диагноза и назначенной задачи нет.

## Действующие ограничения

Snapshot — одна job на один root. Готовые/выполняющиеся snapshots переиспользуются
сервисом между чатами. maxAgeMs/forceRefresh управляют свежестью, result TTL —
хранением; это разные параметры. FS_SNAPSHOT_FORMAT / portable snapshotFormat:
tree по умолчанию, stable явно.

[ChatGPT A/B](../testing/014-chatgpt-ab-2026-10-29.md): R2 tree raw -65.7%, ZIP -28.2%,
query scan быстрее 19.9%, полный path-index быстрее 24.8%.
[Parity](../testing/015-local-r2-2026-10-29.md): exact paths/metadata совпали;
470 inaccessible skips в обоих форматах. Это результаты конкретной выборки.

После docs edits запускать targeted Prettier до push. CI #141/#142 падали на
Markdown formatting, исправление main #144 Windows/Ubuntu PASS. Историческая
хроника и прежние назначения перенесены в архив, не являются текущими задачами.
