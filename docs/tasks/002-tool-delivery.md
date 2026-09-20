# 002-tool: Доставка оригинала через tool в ChatGPT

Статус и назначение: [центральная доска](../project/status.md).
Основа: принятая 002 и отрицательный ZIP-результат 002-live.

## Зачем и исходные факты

В [живом прогоне](../testing/windows-chatgpt-live.md) Windows, Secure MCP Tunnel,
плагин и семь read-only tools работали. ChatGPT нашёл ZIP, но не получил callable
`resources/read`; файл в analysis runtime не появился. Маркер результата —
`ROUTE_FAIL_NOT_MATERIALIZED`. XLS отдельно не запускали.

Нужно дать ассистенту доступный tool для получения оригинала и подтвердить,
что файл действительно доступен инструментам анализа без ручного переноса.
Текущий binary путь находится в [resources.ts](../../src/resources.ts).
[read](../../src/tools/read.ts) не доставляет ZIP/XLS как файлы, а
[resource_link](../../src/core/file-uri.ts) содержит URI и metadata без bytes.

## Scope и разрешённое изменение

Разрешён один минимальный read-only tool, рабочее имя `get_file`, для одного
разрешённого файла за вызов. Окончательные имя и output contract обосновать стилем
репозитория и совместимостью. Выбор внутри этих границ не требует нового разрешения.
Допустимо вместо нового tool расширить существующий, сохранив его прежнее поведение.

Переиспользовать `GuardedFileSystem`, `PathGuard`, общий URI encoder, size limits
и request cancellation. Сохранять исходные bytes без UTF-8-конвертации и парсинга.
Ограничения исходного файла и ответа с base64 overhead учитывать отдельно.
Старые resources, текстовое/media чтение и ограничения mutating tools сохраняются.

Исполнитель владеет tool/минимальной регистрацией, необходимыми helpers/tests,
затронутыми descriptions/reference, этой карточкой и новым протоколом
`docs/testing/tool-originals-delivery.md`. Центральную доску ведёт планирование.
Не начинать snapshot/bundle, OCR, domain parsers, OAuth, production artifact store,
публичный download service и расширение roots на рабочие данные. Для нового сервиса
или существенной смены маршрута подготовить отдельное конкретное решение.

## Порядок работы

1. Прочитать AGENTS, карту docs, brief, архитектуру, Windows runbook, workflow,
   [локальный протокол](../testing/originals-delivery.md) и результаты 002-live.
   Проверить diff/base/branch. Новая ветка — `codex/002-tool-delivery` от принятого
   `main` с этой карточкой, в изолированном worktree. При продолжении 002-live
   сохранить её незакоммиченные записи checkpoint-коммитом перед синхронизацией:
   их обезличенная копия уже перенесена в main. Не терять локальные данные/настройки,
   не применять reset/clean и не переключать planning checkout.
2. Установить точный output contract по актуальным официальным OpenAI/MCP/SDK
   источникам и доступному клиенту. Начальные источники:
   [Plugin reference](https://developers.openai.com/plugins/reference#file-apis),
   [подключение](https://developers.openai.com/plugins/deploy/connect-chatgpt).
   Различать входной файл в tool, widget File APIs и исходящий файл в analysis runtime.
   Не выдумывать output schema из схемы входных параметров.
3. Реализовать минимальный обоснованный вариант для существующего ZIP 703 bytes.
   Допустим ограниченный опыт с resource_link/embedded resource в tool result,
   если SDK допускает ответ; поддержка хостом остаётся гипотезой до live проверки.
   Зафиксировать вариант, источник и проверяемое ожидание. Не строить большой
   компонент до подтверждения базового пути.
4. Проверить byte equality и контракт локально. Обновить registration, read-only
   inventory, descriptions, инструкции, schemas/tests и assertions локального
   harness: при добавлении нового read-only tool прежняя цифра семь изменится.
   Проверки не отключать ради прохождения; mutating tools остаются скрыты.
5. Вместе с пользователем обновить существующий synthetic стенд. Давать по одному
   действию с ожидаемым результатом и ждать ответа. Установить, какую сборку
   запускает tunnel profile: старый dist из другого worktree не проверяет новый tool.
   Проверить перезапуск/refresh и видимость новой функции. Наличие daemon/profile
   описано на момент прошлого опыта; текущее состояние перепроверить. Ключи не
   читать и не выводить в переписку/Git.
6. В ChatGPT вызвать tool для ZIP. Зафиксировать вызовы и факт последующей загрузки
   ресурса/bytes, если она нужна. В analysis runtime программно вычислить SHA-256
   доставленного файла и открыть три ZIP entries. После ZIP PASS проверить настоящий
   BIFF8 XLS, семь контрольных ячеек и повтор обоих форматов. Повтор должен
   проверять передачу, а не SDK cache. Эталоны — из принятого протокола 002.
7. При отказе записать точную границу. Следующий минимальный вариант проверять
   только при наличии технического основания. Если обоснованные варианты исчерпаны,
   вернуть наблюдаемый FAIL/BLOCKED и предложение следующего решения, не заявляя
   о недоказанной поддержке платформы.

URI, blob/base64 в сообщении модели, hash от сервера и пересказ manifest сами по
себе не доказывают появления файла. Ручной upload, вставка base64 пользователем,
повторная генерация fixture в ChatGPT и чтение общего локального диска не подходят.
Нужен воспроизводимый автоматический маршрут из tool result в среду анализа.

## Acceptance

- [x] Wire contract и источники описаны; SDK-допустимость и фактическая поддержка
      ChatGPT различаются. Неизвестные поля не выданы за документированный API.
- [x] Tool читает один guarded файл, сохраняет bytes и действует в read-only;
      прежние text/media/resource сценарии сохранены.
- [x] Содержательные tests проверяют binary bytes, outside-root/traversal,
      canonical paths/symlink containment, превышение лимита и cancellation.
      Неожиданная ошибка не засчитывается как ожидаемый отказ ограничения.
- [x] ChatGPT получил ZIP, сам вычислил hash и открыл entries; затем получил XLS
      и прочитал контрольные cells. Локальный SDK smoke не заменяет эту проверку.
- [x] Повторная доставка проверена без кэшированной подмены и ручного переноса;
      фактический build в tunnel profile установлен. Непроверенные форматы отмечены.
- [x] При невозможности доставки зафиксирован точный FAIL/BLOCKED; невыполненные
      ZIP/XLS критерии остаются невыполненными, добавленный tool не назван решением.
- [x] Regression tests и `npm run check` проходят; среда и skips записаны.
      Reference, протокол и Work record обновлены; есть локальный commit и handoff
      с branch/base/head. Секреты и рабочие документы не попали в tracked изменения.

## Launch prompt

```text
Выполни docs/tasks/002-tool-delivery.md: доработай выдачу оригинала через tool
и проверь получение файла в ChatGPT на существующем synthetic стенде.
Пользователь разрешил минимальный read-only get_file и необходимые изменения
регистрации/контракта в границах карточки. Сначала проверь SDK/host output contract,
затем реализуй и проверь ZIP 703 bytes, после него настоящий XLS.
Работай в изолированном worktree; сохрани свои изменения перед синхронизацией.
Код и локальные проверки выполняй самостоятельно, live проверку с пользователем —
по одному шагу. Проверь фактическую сборку в tunnel profile, сохрани guard/read-only,
лимиты и cancellation. URI/base64/локальный smoke не равны файлу в analysis runtime.
Не начинай snapshot/bundle/OAuth/public hosting. Добавь meaningful regressions,
выполни npm run check, обнови документацию, создай локальный commit и передай
результат на review. Push/merge/release — по отдельному запросу. Доску не меняй.
```

## Work record

Готово к review 2026-09-20.

- Base/branch и проверяемая сборка: ветка `codex/002-tool-delivery` синхронизирована
  с принятым локальным `main` `84eb8221ab405d2201208dcfe4e771bdab994100` без
  reset/clean. Проверялись собранный `dist/index.js` этой ветки и synthetic root;
  старый профиль из worktree `c004` сохранён с backup и направлен на эту сборку.
- Output contract, источники и гипотезы: выбран стандартный MCP `CallToolResult`
  с embedded binary resource и matching `resource_link`; metadata остаётся в `_meta`.
  Установленный SDK 2.0.0 допускает оба content block, а OpenAI File APIs не были
  ошибочно использованы как server output schema. До live run материализация была
  гипотезой; контракт и ссылки записаны в
  [tool-originals-delivery.md](../testing/tool-originals-delivery.md).
- Изменения и сохранённые ограничения: добавлен один `get_file`, который вызывает
  `GuardedFileSystem.readRaw` с request signal, использует validated canonical path
  и общий URI helper. Сохранены PathGuard/root/sensitive policy, raw size cap,
  read-only gate и прежние read/resources/media сценарии. Raw и base64 sizes
  записываются раздельно; `.xls` получает `application/vnd.ms-excel`. Snapshot,
  bundle, OAuth, публичный URL и artifact service не добавлены.
- Локальные проверки, full check и skips: targeted regressions — 8/8 PASS;
  реальный stdio harness и независимый Python `zipfile`/`xlrd` verifier — PASS для
  ZIP/XLS/repeat, exact 1 MiB, over-limit и outside-root. `npm run check` — PASS:
  358 tests, 351 pass, 0 fail, 7 skip. Skips — прежние POSIX inode/mode/0222 и
  недоступные в отдельных suites Windows symlink cases; `GET-FILE-001..005`, включая
  Windows junction containment, прошли без skip.
- ChatGPT ZIP/XLS/повтор: `PASS`. ChatGPT получил материализованный ZIP 703 B,
  сам вычислил `4e729b…fe02`, проверил CRC и открыл три entries. Первый permission
  round-trip вызвал tool дважды и дал два одинаковых file objects, подтвердив repeat
  без ручного upload. Затем два отдельных вызова материализовали настоящий BIFF8 XLS
  5,632 B; оба runtime hashes — `db5c5c…fc91`, открыты два листа и все семь cells.
  `manifest.json`, server hash, URL и base64 в ответе не использовались.
- Состояние стенда, ограничения, итоговый commit и handoff: Tunnel client 0.0.14
  прошёл `doctor` и `/readyz`; ChatGPT после refresh увидел `get_file`. В Git нет
  ключа, tunnel ID, абсолютных пользовательских путей, бинарных fixtures или live
  screenshots. Profile и backup остаются в ignored `.tmp` исходного worktree;
  daemon остановлен пользователем после проверки. Target limit выше малых ZIP/XLS,
  остальные форматы и lifecycle не проверялись. Итоговый commit — commit с этой
  записью; hash передаётся в handoff, push/merge не выполняются.
