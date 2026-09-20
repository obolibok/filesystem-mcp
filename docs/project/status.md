# Приоритеты и интеграция

Владелец: планирующий чат. Обновлено: 2026-09-20.
Это единая доска интеграционного статуса. Coding-чаты записывают свою работу в
карточках задач, а планирование обновляет эту таблицу после review/интеграции.

| ID       | Работа                                                               | Статус   | Зависит от    | Назначение                                                                            |
| -------- | -------------------------------------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------- |
| 000      | Подготовка контекста и правил работы                                 | done     | —             | Планирующий чат; docs checkpoint                                                      |
| 001      | [Baseline-дефекты и Windows](../tasks/001-baseline-defects.md)       | done     | 000           | `001 - baseline defects fix`; `codex/001-baseline-defects`                            |
| 002      | [Стенд доставки originals](../tasks/002-originals-delivery.md)       | done     | 001           | `codex/002-originals-delivery`; принят через PR #2; целевой прогон вынесен в 002-live |
| 002-live | [Живой прогон Windows/ChatGPT](../tasks/002-live-windows-chatgpt.md) | done     | 002           | Отрицательный `resources/read` маршрут принят как исторический результат в PR #3      |
| 002-tool | [Выдача originals через tool](../tasks/002-tool-delivery.md)         | done     | 002, 002-live | `codex/002-tool-delivery`; review и CI PASS; принят через PR #3                       |
| 003      | [Фоновый snapshot и сжатые части](../tasks/003-compressed-snapshot.md) | ready | 002-tool | Реализация разрешена 2026-09-20; рабочая задача создаётся |
| 004      | Bundle выбранных originals на основе jobs/artifacts | proposed | 003 | Последовательно после 003; общий механизм повторно не реализуется |
| 005      | Контролируемое повторение предметного исследования                   | proposed | 004           | Планирование + пользователь                                                           |

`proposed` — направление без разрешения на реализацию; `ready` — scope и acceptance
готовы; `active` — назначен исполнитель; `review` — есть проверяемый результат;
`done` — принят и интегрирован; `blocked` — указана конкретная внешняя зависимость.
При назначении рядом с ID сохранять имя/ссылку чата и ветку, доступные из приложения.
Не придумывать task ID приложения или commit SHA.

## Текущий следующий шаг

Пользователь разрешил реализацию 003 2026-09-20. Готова
[карточка 003](../tasks/003-compressed-snapshot.md): фоновые jobs, потоковый CSV,
самостоятельные ZIP-части, manifest, хранение, отмена, получение и проверки.
[Основа 003/004](snapshot-bundle-design.md) и
[измерения CSV](../testing/snapshot-shape-2026-09-20.md) входят в committed контекст.
003 запускается отдельной задачей GPT-5.6-Sol / Extra High в собственном worktree.
Сначала самостоятельная локальная реализация и benchmark, затем synthetic live
ChatGPT прогон с пользователем. Целевой PASS не подменять локальными проверками.
004 остаётся proposed и использует принятую в 003 основу для выбранных originals.

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
- `snapshot`/`bundle` — будущие tools, не текущие capabilities.
- OAuth/multi-user, постоянный индекс и серверные парсеры сейчас не назначены.

После каждой интеграции сохранять ссылку на принятый commit/PR, итог acceptance,
актуальный reference и состояние зависимых задач. Новые coding-задачи начинать
от принятого `main`; пересекающиеся изменения core назначать последовательно.
