# 002-live: Windows → ChatGPT, пошаговая проверка с пользователем

Статус и назначение: [центральная доска](../project/status.md).
Зависимость: интегрированный стенд [002](002-originals-delivery.md).

## Результат и формат работы

Пользователь ожидает отдельный рабочий чат на GPT-5.6-Sol / Extra High, который
последовательно проведёт его через развёртывание коннектора на Windows-машине,
подключение к ChatGPT и проверку фактической доставки оригиналов.

Это интерактивный прогон. Сначала дать короткую карту этапов и первый выполнимый
шаг. Затем выдавать по одному небольшому блоку команд/действий с ожидаемым
результатом, ждать ответ пользователя, разбирать ошибки и только потом двигаться
дальше. Не заменять сопровождение большой инструкцией «выполните всё сами».
Параллельно можно читать код, проверять документацию и готовить следующие шаги.

## Контекст

- [Протокол 002](../testing/originals-delivery.md) содержит генераторы, команды,
  эталонные hashes, ZIP entries, XLS cells и пределы локального доказательства.
- [Windows runbook](../development/windows.md), [архитектура](../reference/architecture.md),
  [brief](../project/brief.md), [workflow](../development/parallel-work.md).
- Серверный участок испытан локально. Доставка в ChatGPT и открытие файла в его
  среде анализа пока `BLOCKED/INCONCLUSIVE`, не `PASS` и не доказанный `FAIL`.
- Предложенный маршрут: ChatGPT Work web, Developer mode/personal plugin,
  Secure MCP Tunnel до локального stdio MCP. Сначала проверить доступность этого
  маршрута для реального аккаунта и Windows-хоста; это не заданный факт.
- Официальные исходные ссылки: [подключение плагина](https://developers.openai.com/plugins/deploy/connect-chatgpt),
  [Secure MCP Tunnel](https://developers.openai.com/api/docs/guides/secure-mcp-tunnels),
  [plugin file APIs](https://developers.openai.com/plugins/reference#file-apis).
  Перед конкретными командами сверить актуальные инструкции; возможности,
  отсутствующие в документации или реальном UI, не выдумывать.

## Последовательность

1. **Preflight.** Уточнить, эта ли Windows-машина будет хостом или другая; Windows
   version/architecture, PowerShell, Git, Node >=24, Python >=3.12, рабочую папку.
   Дать короткий блок read-only команд. Выяснить доступность ChatGPT Work,
   Developer mode, personal plugins и необходимых прав workspace. Не запрашивать
   пароли, API keys или токены в переписке.
2. **Совместимый путь подключения.** Проверить официальный tunnel package для
   фактической ОС, его install/help/config/doctor и права OpenAI Platform Tunnels.
   Workspace association не заменяет runtime credential `CONTROL_PLANE_API_KEY`.
   Указать пользователю, где создать/ввести нужное локально, не выводя значение.
   Если native Windows вариант недоступен, представить конкретную поддерживаемую
   альтернативу и её требования; не устанавливать WSL/контейнеры молча и не
   подменять задачу публикацией незащищённого HTTP endpoint.
3. **Локальная установка и проверка.** Использовать fork и принятый `main`,
   записать фактический SHA. Установить закреплённые зависимости, собрать сервер,
   сгенерировать synthetic ZIP и настоящий XLS, выполнить MCP harness и независимый
   verifier. Использовать абсолютные Windows paths в конфигурации клиента,
   `--read-only` и `--root-boundary` только на synthetic source root. Объяснить,
   что stdio server ожидает MCP-сообщения; отсутствие prompt само по себе не ошибка.
4. **Подключение ChatGPT.** Провести настройку совместимого туннеля/плагина по
   реальному UI и документации, проверить доступные tools и разрешённый root.
   Одноразовую настройку отделять от действий при каждом получении файла.
   Секреты остаются в локальной конфигурации/окружении пользователя и не в Git.
5. **Сквозной тест.** Дать готовый запрос для целевого ChatGPT-чата: найти fixtures
   через коннектор, получить их и открыть в analysis runtime. Зафиксировать вызовы,
   путь материализации, размеры и SHA-256, вычисленные кодом по фактическим
   полученным bytes. Проверить ZIP integrity/entries и семь контрольных XLS cells,
   затем повторить передачу обоих файлов без кэшированной подмены.
6. **Границы и живой пример.** Проверить применимые лимиты/ошибки и lifetime, если
   этот путь использует временные ссылки. После synthetic теста предложить один
   небольшой выбранный пользователем настоящий ZIP/XLS из согласованного каталога;
   подтвердить именно эти данные и место передачи перед расширением доступа.
   Для реальных данных достаточно byte equality и осмысленного открытия; не
   сохранять корпоративное содержимое или пути в public repo. Если передача
   originals не поддерживается выбранным путём, локализовать отказ и предложить
   минимальный следующий шаг планированию; не строить новый delivery service заодно.
7. **Завершение.** Зафиксировать PASS/FAIL/BLOCKED отдельно для каждой ступени,
   дать команды остановки/отключения тестового подключения и уточнить желаемое
   состояние стенда. Сохранить обезличенный runbook и результат в Git, передать
   планированию решение о возможности перехода к 003/004.

Пользователь запускает команды на целевом хосте по инструкции. Действия локального
агента допустимы для согласованного хоста и scope, но не заменяют требуемую
последовательную инструкцию и контроль результата с пользователем.

## Scope и владение

Использовать созданный приложением worktree и ветку `codex/002-live-windows-chatgpt`,
если свободна. Исполнитель ведёт эту карточку и новый
`docs/testing/windows-chatgpt-live.md` с фактически проверенными инструкциями.
Мелкие воспроизводимые исправления стенда разрешены, с подходящими проверками.
Серверные контракты, snapshot/bundle, OAuth, постоянное хранилище и доменные
парсеры остаются за пределами задачи; материальное изменение маршрута оформить
конкретным предложением. Центральную доску ведёт планирование.

## Acceptance

- [ ] Пользователь получил и прошёл последовательные шаги либо остановился на
      точно установленной внешней зависимости с понятным способом её устранить.
- [ ] Записаны ОС/версии, Git SHA, точная поддерживаемая схема подключения и её
      prerequisites; неизвестный Windows support не выдан за готовую команду.
- [ ] Локальный synthetic опыт повторён; ChatGPT получил файлы через коннектор,
      программно проверил полные bytes и открыл ZIP/XLS — либо получен точный FAIL/BLOCKED.
- [ ] URI, текст base64, ожидаемый hash из ответа модели, ручной upload и доступ
      к общему локальному диску не засчитаны как успешная доставка.
- [ ] Живой файл проверен с разрешения пользователя либо отдельно зафиксировано,
      что проверка осталась synthetic-only. Корпоративных файлов/секретов в Git нет.
- [ ] Есть воспроизводимый Windows runbook, результаты проверок, teardown и
      вывод для планирования. Задачи 003/004 не объявлены готовыми без целевого результата.

## Launch prompt

```text
Проведи с пользователем задачу docs/tasks/002-live-windows-chatgpt.md.
Сначала прочитай проектные правила, карточку, принятый протокол 002 и Windows runbook.
Работай в worktree приложения, не создавай вложенный и не переключай planning checkout.
Пользователь ждёт сопровождение: короткая карта пути и первый блок диагностики,
далее один небольшой шаг → ожидаемый результат → ответ пользователя → следующий шаг.
Уточни целевую Windows-машину и доступные возможности ChatGPT; не проси секреты.
Проверь актуальную официальную документацию и поддержку tunnel-клиента на этой ОС.
Проведи установку fork, local smoke, подключение, проверку полученных bytes и
открытие ZIP/XLS в ChatGPT. Затем небольшой согласованный живой пример.
Не выдавай local PASS за ChatGPT PASS. Сохрани runbook и Work record,
передай результат планированию. Не начинай 003/004, не делай push/merge/release
без отдельного запроса. Первое сообщение — уже первый выполнимый шаг.
```

## Work record

Пошаговый прогон начат 2026-09-19; результат сохранён планированием 2026-09-20.
ZIP — FAIL текущего resource-template маршрута; XLS не запускался. Продолжение:
[002-tool](002-tool-delivery.md). Состояние teardown требует проверки перед следующим опытом.

- Base/branch и целевой хост (обезличенно):
  `1cf6ab8da6945f92bf945373432147f427fbd019`,
  `codex/002-live-windows-chatgpt`; текущая Windows-машина пользователя.
- Доступность клиента/tunnel и выбранный маршрут: ChatGPT Work виден,
  Developer mode включён, создание personal plugins доступно. Проверяется маршрут
  personal plugin → Secure MCP Tunnel → read-only stdio MCP. Platform Tunnel
  settings доступны; создание/управление и ассоциация с ChatGPT workspace
  подтверждены. Platform предлагает `tunnel-client` v0.0.14 для Windows amd64;
  архив скачан, SHA-256 записан, Windows-бинарник запускается, `help quickstart`
  и `help doctor` доступны. Authenticode status — `NotSigned`. Тестовый tunnel
  endpoint создан с ассоциациями owning Platform organization и целевого ChatGPT
  workspace; его ID и данные аккаунта в Git не записаны. Отдельный runtime API key
  создан и остаётся только у пользователя. `doctor --explain` завершился с кодом
  0: profile, env-only credential reference, tunnel identity, Node executable,
  read-only MCP command и loopback health/UI listener прошли проверку. Foreground
  daemon запущен; отдельный health probe получил `200 live`, `200 ready` и
  подтвердил успешный control-plane poll. Personal plugin создан и подключён через
  tunnel; refresh штатно обнаружил read-only actions.
- Пройденные шаги и проверки: Windows 10 Pro 19045 x64; PowerShell 5.1; Git 2.45.1;
  Node 24.15.0; npm 11.12.1; Python 3.12.3. Требования локального стенда выполнены.
  Fork и base подтверждены; `npm ci` установил 241 package с нулём reported
  vulnerabilities, `npm run build` успешно создал `dist/index.js`. Synthetic
  ZIP/XLS и limit fixtures созданы; все размеры и четыре SHA-256 совпали с
  принятым manifest. Mojibake при `Get-Content` в PowerShell 5.1 отделён от
  проверки bytes; позднее Unicode проверен независимым reader.
- Локальный/целевой/synthetic/живой результат: локальный
  stdio MCP delivery harness и независимый Python verifier теперь `PASS`: uncached
  repeats, hashes, exact-limit read, два отрицательных контроля, три ZIP entries и
  семь XLS cells проверены. User-exported ChatGPT transcript подтверждает live
  tool calls: точное дерево, размеры, чтение manifest и два ожидаемых результата
  `find_files`. Это `PASS` для маршрута tools, но значения manifest не доказывают
  materialization/bytes в analysis runtime. Изолированный ZIP test вернул
  `ROUTE_FAIL_NOT_MATERIALIZED`: ChatGPT host выставил только семь tools и не
  предоставил callable `resources/read`; resource не читался, blob/file в analysis
  runtime не появился, Python не запускался, обходов через manifest/base64/upload
  не было. Целевая доставка ZIP — наблюдаемый `FAIL` текущего контракта; XLS не
  запускался, так как зависит от того же отсутствующего resource route. Живые
  данные не выбирались.
- Блокеры, ручные действия, teardown: Windows-клиент совместим, но не имеет
  Authenticode-подписи; hash фиксирует проверенный download, а не доказывает
  подпись издателя. Локальный synthetic этап завершён. Локальный stdio profile
  ссылается на key через `env:CONTROL_PLANE_API_KEY` и ограничивает сервер
  synthetic root. Первая попытка `init` безопасно остановлена:
  PowerShell 5.1 передал quoted абсолютный Node path из `Program Files` так, что
  preflight увидел `C:Program`; partial profile не создан. Повтор использует `node`
  из `PATH` и forward-slash paths без пробелов и успешно создал один profile в
  ignored `.tmp`. Проверено: только env key reference, secret value отсутствует,
  read-only/root-boundary/synthetic root присутствуют. `doctor --explain` — `PASS`;
  ожидаемые `SKIP` относятся к network/OAuth probes для stdio и необязательному
  Codex control plugin. PowerShell 5.1 снова оформил ожидаемую stderr-диагностику
  MCP server как `NativeCommandError`, но daemon продолжил работу; live/readiness
  и обязательный control-plane poll — `PASS`. ChatGPT app создан через Tunnel,
  подключён и штатно обновил actions при продолжающем работать daemon;
  gate `list_roots`/`find_files` пройден, а materialization gate дал точный `FAIL`
  на границе ChatGPT host → MCP resources. Минимальное предложение планированию —
  отдельный read-only adapter spike с focused tool, возвращающим стандартный tool
  file reference/resource link для одного guarded synthetic файла; сначала нужно
  проверить фактический SDK/host contract, потому что official File APIs не дают
  точной server-side output schema. Не добавлять public service, OAuth,
  snapshot/bundle или production roots. Daemon/profile/plugin пока оставлены до
  решения пользователя о сохранении стенда или teardown. Секреты в чат/Git не
  передавать.
- Файлы runbook, итоговый commit и решение для 003/004:
  docs/testing/windows-chatgpt-live.md; обезличенные записи перенесены из worktree
  в main планированием 2026-09-20 с уточнением ZIP FAIL / XLS не проверялся.
  SHA — в handoff планирования. 003/004 остаются вне scope до подтверждённой
  доставки или отдельного решения о смене маршрута.
