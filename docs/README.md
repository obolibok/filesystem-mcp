# Работа над filesystem-mcp

Это точка входа для планирования, реализации и ревью проекта Schwarzbeck.
Контекст, нужный новому чату, хранится здесь и в карточке задачи; читать прошлую
переписку или искать файлы в чужом checkout не требуется.

## Новый чат

| Роль         | Что прочитать                                                                      | Что вести                                            |
| ------------ | ---------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Планирование | [Brief](project/brief.md), [доска](project/status.md), итоги задач                 | Приоритеты, границы, решения и приёмку               |
| Реализация   | `AGENTS.md`, brief, назначенную карточку, [workflow](development/parallel-work.md) | Код, проверки и work record своей задачи             |
| Ревью        | Карточку задачи, её diff, доказательства проверок                                  | Замечания по acceptance и рекомендации по интеграции |

**Текущие задачи и следующий шаг:** [центральная доска](project/status.md).
Карточки в `docs/tasks/` содержат scope, acceptance и контекст для coding-чата.

## Карта

- [Brief](project/brief.md): зачем проект, что решено, что ещё проверить.
- [Доска](project/status.md): единый статус интеграции и следующий шаг.
- [Параллельная работа](development/parallel-work.md): worktrees, владение файлами,
  handoff и приёмка.
- [Windows](development/windows.md): воспроизводимая установка и локальная проверка.
- [Переносимый Windows-комплект](development/windows-portable.md): папка для VM,
  операторская инструкция, roots, tunnel/plugin и сроки хранения.
- [Originals delivery](testing/originals-delivery.md): проверенный локальный стенд,
  доказательства и ограничения; [tool delivery](testing/tool-originals-delivery.md) —
  фактически проверенный маршрут `get_file` в ChatGPT; [002-live](tasks/002-live-windows-chatgpt.md) —
  исторический отрицательный опыт с `resources/read`.
- [Snapshot benchmark](testing/snapshot-benchmark-2026-09-20.md): 3 млн metadata
  records и отдельный настоящий walk; [live protocol](testing/snapshot-live.md) —
  пошаговая целевая проверка manifest/ZIP в ChatGPT;
  [live results](testing/003-live-2026-09-20.md) — результаты smoke/main/upper;
  [интеграция 003](testing/003-integration-2026-09-20.md) — Windows fixes и финальный CI.
- [Bundle local](testing/bundle-local-2026-09-20.md): stdio MCP, independent
  ZIP/XLS verifier, multipart volume и Windows 8.3; [live protocol](testing/bundle-live.md) —
  пошаговая целевая проверка после code review;
  [live results](testing/004-live-2026-09-21.md) — ZIP/XLS и multipart в ChatGPT;
  [интеграция 004](testing/004-integration-2026-09-21.md) — независимая приёмка и CI.
- [Исправления review 004](testing/004-fixes-2026-09-21.md): R1–R8 regressions,
  повторные harness/volume/8.3 evidence и ограничения перед повторным review.
- [Исправления повторного review 004](testing/004-fixes-r2-2026-09-21.md): явное
  владение compression chain, quota-safe partial ZIP и проверки перед review R3.
- [Code review 006](testing/006-review-2026-09-24.md): независимая проверка общего reuse снимков; живой опыт ещё предстоит.
- [Архитектура, форматы и лимиты](reference/architecture.md): карта владельцев кода
  и текущие возможности и ограничения.
- [Baseline от 19 сентября](testing/baseline-2026-09-19.md): проверенные наблюдения,
  отделённые от планируемых исправлений.
- [Шаблон задачи](tasks/TEMPLATE.md): минимальный контракт для следующего чата.
- [README](../README.md): upstream usage и configuration reference.
- [CONTRIBUTING](../CONTRIBUTING.md): upstream contribution; [CHANGELOG](../CHANGELOG.md):
  история опубликованных версий.

## Решения и исследования upstream

| Документ                                                                                                                                 | Как использовать                                                                 |
| ---------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| [ADR-001: ignore](adr/001-one-skipignored-flag-owns-both-exclusion-rules.md)                                                             | Принятое upstream-решение; сохранять единую семантику исключений                 |
| [ADR-002: legacy sunset](adr/002-legacy-protocol-paths-sunset.md)                                                                        | Принятое правило удаления legacy-путей; не удалять их досрочно ради упрощения    |
| [ADR-003: legacy HTTP](adr/003-http-serves-2025-era-clients-statelessly.md)                                                              | Принятое решение о stateless fallback                                            |
| [OAuth spike](plan/2026-09-15-oauth-resource-server/design.md)                                                                           | Исследование, prototype удалён; production OAuth этим не реализован              |
| [SDK hook deletion map](plan/2026-09-15-sdk-listen-hook/deletion-map.md) и [issue draft](plan/2026-09-15-sdk-listen-hook/issue-draft.md) | Исследовательские материалы и будущий cleanup, не готовая задача текущего пилота |

Новые задачи лежат в `docs/tasks/`; папка `docs/plan/` сохраняет upstream-историю.
Новый ADR нужен при устойчивом изменении архитектурного контракта, а обычное
обоснование реализации достаточно записать в карточке задачи.

`docs/project/status.md` отвечает за статус; task card — за scope, acceptance и
свидетельства реализации; baseline — за исторические измерения. Не копировать
меняющиеся статусы в несколько документов. После изменения поведения обновлять
его reference и соответствующий task record.

В Git попадают обезличенные требования, решения, synthetic fixtures и итоги
проверок. Рабочие данные предприятия, исходный чат, секреты, CSV/ZIP и подробные
локальные логи остаются за его пределами. Игнорируемые `reports/` и `.tmp/` удобны
для локальных материалов, но не являются обязательными зависимостями новой задачи.
