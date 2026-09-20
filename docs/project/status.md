# Приоритеты и интеграция

Владелец: планирующий чат. Обновлено: 2026-09-20.
Это единая доска интеграционного статуса. Coding-чаты записывают свою работу в
карточках задач, а планирование обновляет эту таблицу после review/интеграции.

| ID       | Работа                                                                 | Статус   | Зависит от    | Назначение                                                                                                                        |
| -------- | ---------------------------------------------------------------------- | -------- | ------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 000      | Подготовка контекста и правил работы                                   | done     | —             | Планирующий чат; docs checkpoint                                                                                                  |
| 001      | [Baseline-дефекты и Windows](../tasks/001-baseline-defects.md)         | done     | 000           | `001 - baseline defects fix`; `codex/001-baseline-defects`                                                                        |
| 002      | [Стенд доставки originals](../tasks/002-originals-delivery.md)         | done     | 001           | `codex/002-originals-delivery`; принят через PR #2; целевой прогон вынесен в 002-live                                             |
| 002-live | [Живой прогон Windows/ChatGPT](../tasks/002-live-windows-chatgpt.md)   | done     | 002           | Отрицательный `resources/read` маршрут принят как исторический результат в PR #3                                                  |
| 002-tool | [Выдача originals через tool](../tasks/002-tool-delivery.md)           | done     | 002, 002-live | `codex/002-tool-delivery`; review и CI PASS; принят через PR #3                                                                   |
| 003      | [Фоновый snapshot и сжатые части](../tasks/003-compressed-snapshot.md) | done     | 002-tool      | `003 - compressed snapshot`; принят через [PR #4](https://github.com/obolibok/filesystem-mcp/pull/4); code review, live и CI PASS |
| 004      | Bundle выбранных originals на основе jobs/artifacts                    | proposed | 003           | Последовательно после 003; общий механизм повторно не реализуется                                                                 |
| 005      | Контролируемое повторение предметного исследования                     | proposed | 004           | Планирование + пользователь                                                                                                       |

`proposed` — направление без разрешения на реализацию; `ready` — scope и acceptance
готовы; `active` — назначен исполнитель; `review` — есть проверяемый результат;
`done` — принят и интегрирован; `blocked` — указана конкретная внешняя зависимость.
При назначении рядом с ID сохранять имя/ссылку чата и ветку, доступные из приложения.
Не придумывать task ID приложения или commit SHA.

## Текущий следующий шаг

003 принята и интегрирована в `main`. Следующий шаг — уточнить scope и acceptance
004 (bundle выбранных originals), затем назначить реализацию от принятого `main`.
004 остаётся `proposed`; общие jobs/artifacts, TTL, quotas и delivery уже реализованы
в 003 и должны использоваться повторно. Новая рабочая задача ещё не запущена.

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
Три live jobs завершены. При последней сверке пользовательский foreground tunnel
отвечал; остановка Ctrl+C не подтверждена. Synthetic материалы сохранены локально.
Runtime интеграционной ветки принят; состояние foreground стенда не менялось при merge.

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
- `snapshot` и общий jobs/artifacts lifecycle реализованы в 003; `bundle` — задача 004.
- OAuth/multi-user, постоянный индекс и серверные парсеры сейчас не назначены.

После каждой интеграции сохранять ссылку на принятый commit/PR, итог acceptance,
актуальный reference и состояние зависимых задач. Новые coding-задачи начинать
от принятого `main`; пересекающиеся изменения core назначать последовательно.
