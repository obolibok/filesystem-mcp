# Приоритеты и интеграция

Владелец: планирующий чат. Обновлено: 2026-09-20.
Это единая доска интеграционного статуса. Coding-чаты записывают свою работу в
карточках задач, а планирование обновляет эту таблицу после review/интеграции.

| ID       | Работа                                                               | Статус   | Зависит от    | Назначение                                                                                  |
| -------- | -------------------------------------------------------------------- | -------- | ------------- | ------------------------------------------------------------------------------------------- |
| 000      | Подготовка контекста и правил работы                                 | done     | —             | Планирующий чат; docs checkpoint                                                            |
| 001      | [Baseline-дефекты и Windows](../tasks/001-baseline-defects.md)       | done     | 000           | `001 - baseline defects fix`; `codex/001-baseline-defects`                                  |
| 002      | [Стенд доставки originals](../tasks/002-originals-delivery.md)       | done     | 001           | `codex/002-originals-delivery`; принят через PR #2; целевой прогон вынесен в 002-live       |
| 002-live | [Живой прогон Windows/ChatGPT](../tasks/002-live-windows-chatgpt.md) | review   | 002           | `002-live - Windows and ChatGPT validation`; ZIP FAIL, XLS не проверялся; teardown уточнить |
| 002-tool | [Выдача originals через tool](../tasks/002-tool-delivery.md)         | ready    | 002, 002-live | Одобрена 2026-09-20; исполнитель не назначен                                                |
| 003      | Потоковый snapshot каталога                                          | proposed | 002-tool      | Ожидает подтверждённую доставку в целевой среде                                             |
| 004      | Bundle и manifest                                                    | proposed | 002-tool, 003 | Ожидает подтверждённую доставку и snapshot                                                  |
| 005      | Контролируемое повторение предметного исследования                   | proposed | 004           | Планирование + пользователь                                                                 |

`proposed` — направление без разрешения на реализацию; `ready` — scope и acceptance
готовы; `active` — назначен исполнитель; `review` — есть проверяемый результат;
`done` — принят и интегрирован; `blocked` — указана конкретная внешняя зависимость.
При назначении рядом с ID сохранять имя/ссылку чата и ветку, доступные из приложения.
Не придумывать task ID приложения или commit SHA.

## Текущий следующий шаг

Выполнить 002-tool: пользователь разрешил минимальную доработку read-only tool
для доставки originals и повторную проверку в ChatGPT на synthetic стенде.
[Карточка](../tasks/002-tool-delivery.md) готова; сначала подтвердить контракт
результата, затем проверить ZIP 703 bytes, после успеха — XLS. Наличие URI/base64
или локальный SDK PASS не заменяет получения и открытия файла в среде анализа.

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

002-live находится на review с отрицательным результатом маршрута и открытым
состоянием teardown. Статус done у 002 означает принятие локального стенда.
003/004 не начинать до подтверждённой доставки или отдельного решения планирования.

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
