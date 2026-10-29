# 019: привязать destructive confirmations к идентичности цели

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: 018.

## Зачем

`input_required` переживает несколько вызовов `tools/call`: сервер повторно планирует
операцию после ответа пользователя. Сейчас HMAC `requestState` содержит тип операции и
пути, но не идентичность объектов. Если файл или каталог по тому же пути заменить,
пока пользователь смотрит на подтверждение, старый ответ может примениться к
новому объекту.

Это отдельная граница от задачи 018: guarded open защищает чтение/append,
а сравнение canonical path в `create` не доказывает, что по этому пути всё ещё
лежит тот же файл.

## Контекст и источники

- Принятый baseline: merge 018
  `c651d077bc5edec1ecface32f76e4afd88df3ca3`; текущая ветка `main`.
- В fork `src/core/input-required.ts` сериализует `PendingState` с `op` и `paths`,
  а `pendingRoundTrip` сравнивает набор путей без объектов на диске.
- `src/tools/create.ts` повторно строит подтверждение по canonical path;
  `src/tools/move.ts` хранит только факт наличия destination;
  `src/tools/delete.ts` сравнивает `lstat` identity лишь внутри повторного вызова,
  не с первоначальным состоянием до elicitation.
- Актуальный upstream проверен 29.10.2026: `main` — `82da458e76aa5207e5050b5abe0110fd302b74bb`
  (v2.12.1); релиз с нужным hardening — v2.12.0, commit
  `b23023f2e8b349502035635c2252dfe873a6c567`.
  В [upstream changelog](https://github.com/j0hanz/filesystem-mcp/blob/v2.12.0/CHANGELOG.md)
  описаны повторное подтверждение при замене объекта во время prompt и отказ
  при замене после одобрения; источник реализации — upstream
  `src/core/confirmation.ts`.
- Остальные изменения v2.12.0/v2.12.1 оценены отдельно: новые semantics cross-device
  `move`, лимит совпадений `replace_text`, и partial `list` на timeout не входят
  в этот hardening. `search_text` уже сообщает причины пропуска в нашем fork;
  исправление формы множественного числа в v2.12.1 не требует переноса.

## Scope и владение

Общий непрозрачный HMAC-sealed `requestState` для destructive confirmations:
`create` overwrite, `move/copy` overwrite и подтверждаемый рекурсивный `delete`.

- Сохранять для каждого ожидающего подтверждения canonical path и snapshot identity
  существующей записи (тип и доступные filesystem identity fields). Не считать
  совпадение пути доказательством совпадения объекта.
- На повторном `tools/call` сверять свежий план с запечатанной идентичностью
  до чтения ответа пользователя. Если тот же путь указывает на другой объект,
  игнорировать прежний ответ и выдать одну новую `input_required` итерацию с
  обновлённым identity snapshot. Повторная замена после этого второго prompt
  должна завершить эту цель отказом/`CANCELLED` без мутации.
- Новая или изменившаяся цель не может унаследовать ответ от другой цели.
  При изменении pending set разрешено запросить новый полный набор ответов;
  в любом случае старые значения не должны применяться по сдвинутому индексу.
  Сохранить безопасное поведение при исчезновении цели и при смене operation.
- После принятого ответа повторно сверять identity непосредственно перед
  соответствующей мутацией; документировать, что pathname check не делает
  операцию атомарной против внешнего swap после последней проверки.
- Не менять публичные tool schemas. Сохранить подтверждённый `overwrite: true`
  для `create`/`copy`, skip/decline, существующую границу PathGuard и HMAC
  integrity. Старый request state без identity не должен разрешать мутацию:
  запросить новое подтверждение либо отказать безопасным способом.
- `delete` без elicitation уже сравнивает identity в пределах одного вызова;
  не расширять это на несвязанные pathname operations.

Не переносить upstream-модули целиком. Не включать cross-device staging/cleanup,
`replace_text` API rename, generic limits, undo/history, release/version bump или
изменения live ChatGPT/tunnel. Использовать только synthetic roots.

## Воспроизведение

Добавить synthetic сценарии на HMAC request-state round-trip: цель существует и
создаёт `input_required`; между раундами её заменяют другим объектом по тому же
пути; ответ `overwrite/delete` с первого раунда не меняет новый объект.
Повторное изменение после повторного prompt заканчивается без мутации. Повторить
основной сценарий для `create`, `move`/`copy` и рекурсивного `delete`.

## Acceptance

- [x] HMAC `requestState` связывает подтверждение с operation, canonical paths и
      identity snapshots; неподдерживаемый/старый state не может разрешить запись.
- [x] Замена цели между prompt и retry вызывает максимум один новый prompt;
      первый ответ не применяется к заменённому объекту.
- [x] Повторная замена после нового prompt завершается fail-closed без записи,
      копирования, перемещения или удаления замены.
- [x] Подтверждённые цели, обычные skip/decline, новая цель, исчезнувшая цель,
      смена операции и порядок ключей multi-item batch проверены synthetic tests.
- [x] Явный `overwrite: true` сохраняет прежнюю семантику; новый функционал
      не ослабляет PathGuard, HMAC, sensitive paths или guards из 018.
- [x] Обновлены reference и Work record; полный `npm run check` проходит на Windows
      и Linux. Отдельно записаны skips и границы pathname-based проверки.
- [x] Изменения ограничены подтверждениями destructive operations; никаких
      нерелевантных upstream imports или API/output изменений.

## Launch prompt

```text
Реализуй задачу docs/tasks/019-confirmation-identity.md в этом репозитории.
Сначала прочитай AGENTS.md, docs/README.md, brief, status, карточку и
parallel-work/windows workflow. Работай в отдельном worktree от актуального
принятого main. Адаптируй upstream v2.12.0 identity-bound confirmation semantics
к нашему HMAC-sealed input_required протоколу; не копируй upstream confirmation
модуль целиком. Проверь на реальных synthetic MCP round-trips create, move/copy
и recursive delete. Старый/изменённый state не должен применять stale response;
повторное подтверждение ограничено одной новой итерацией. Сохрани текущий
public schema и PathGuard. Выполни все acceptance на Windows/Linux, запиши
точную upstream/base SHA и Work record. Центральную status.md ведёт планирование.
```

## Work record

Ready for review, 2026-10-29. Назначенный worktree сначала был чистым detached HEAD
`ee50952276a5d6b01587109b804bdb6b32b4f1fa`, без карточки 019. После fetch origin
создана ветка `codex/019-confirmation-identity` от опубликованного
`aa8bca0d94cda896f0522cd9ffd0fe8388a81372`; карточка и принятый merge 018 присутствуют.
Перед изменениями `git diff` пуст. Upstream обновлён: `main`
`82da458e76aa5207e5050b5abe0110fd302b74bb`, release v2.12.1. Источник семантики —
v2.12.0, peeled commit `b23023f2e8b349502035635c2252dfe873a6c567`
(annotated tag object `38fa86253165d5fe6a0f60d77a61b6d2e6f392c3`).

### Реализация и выбранный контракт

- `PendingState` дополнен snapshots (`type`, `dev`, `ino`, `birthtimeMs`, с
  canonical path для каждой записи) и запечатанным `reprompted`. Общий
  `pendingRoundTrip` сравнивает snapshot до чтения ответов: первая замена даёт
  один новый prompt для полного pending set; следующая отменяет весь batch с
  `CANCELLED` до начала мутаций. Access grants сохраняют прежний контракт.
- Выбран строгий вариант path-set binding: новые/исчезнувшие pending paths дают
  `INVALID_INPUT`, включая исчезновение последнего. Ответы не сдвигаются между
  `confirm_N`; клиент начинает новый вызов без старого state. Это сохраняет
  существующие R9 regressions. Legacy HMAC state без identity отменяется с
  `CANCELLED`, что разрешено scope карточки; state другой operation запрашивает
  собственное подтверждение без применения чужого ответа.
- `create` получает identity через guarded `lstat`, передаёт её в atomic write и
  повторно сверяет после записи temp перед rename. `move`/`copy` сохраняют
  destination identity в плане и проверяют её после mkdir перед transfer.
  Recursive `delete` связывает исходный `lstat` с HMAC state и сохраняет свой
  final re-stat; formerly pending существующий путь остаётся pending после
  опустошения каталога/смены типа. При замеченной замене после принятого ответа
  подтверждённая мутация возвращает `CANCELLED`.
- Public tool schemas/descriptions и output envelopes не менялись. Сохранены
  явный `overwrite:true`, skip/decline, PathGuard, sensitive policy и guards 018.
  Прямого filesystem I/O в tool handlers не добавлено. Reference обновлён в
  `docs/reference/architecture.md`; upstream confirmation-модуль не копировался.

### Проверки

Среда: Windows, Node v24.15.0 / npm 11.12.1; Linux — Ubuntu/WSL2 kernel
6.18.54.1, те же Node/npm, отдельная копия исходников и `npm ci` на Linux FS.
Все fixtures synthetic; production roots, live сервер и tunnel не использовались.

- Воспроизведение на base `aa8bca0d` в отдельной временной копии:
  `node --test --import tsx --test-name-pattern="a replacement gets one new prompt, then skip" __tests__/confirmation-identity.test.ts`
  — **4 failures / 4** (create/move/copy/delete): старый ответ завершал мутацию
  без второго prompt. Та же группа на исправлении — PASS.
- `node --test --import tsx __tests__/confirmation-identity.test.ts` — **53 pass,
  0 fail, 0 skips**. Настоящий modern-era MCP round-trip проверяет unchanged
  approval/skip/decline, первый и второй swap для всех четырёх операций,
  legacy path-only state, смену operation, появление и исчезновение цели,
  обратный порядок batch и исчезновение первого key. Дополнительно проверены
  final mutation checks (включая create после записи temp), смена directory→file,
  Skip для опустевшего directory и явный overwrite:true в create/copy.
- `node --test --import tsx __tests__/input-required.test.ts __tests__/tools.test.ts __tests__/guarded-io-races.test.ts`
  — **137 pass, 0 fail, 7 platform skips**; HMAC tamper/expiry/malformed, исходные
  R9 tests и guards 018 сохранены.
- Полный **Windows `npm run check` PASS**: build, production/test types, ESLint,
  Prettier, Knip; **598 tests, 585 pass, 0 fail, 13 skips**. Skips: 5 POSIX/Linux-only
  cases и 8 file-symlink cases без Windows permissions. Junction/8.3 scenarios,
  применимые к Windows, прошли.
- Полный **Linux `npm run check` PASS**: все static stages и **598 tests,
  582 pass, 0 fail, 16 Windows-only skips** (8.3, NTFS/Win32 naming, Windows handles,
  native provenance). Новые 53 regressions прошли без skips на обеих платформах.
- `git diff --check` PASS; изменённые tracked text — LF.
- Начальный sandbox-запуск tests завершался `tsx`/`uv_os_get_passwd ENOMEM` до
  загрузки suites; проверки выше выполнены с рабочим доступом к user info по
  Windows runbook. Первый Linux bootstrap потерял ephemeral `/tmp` между WSL
  вызовами; следующий запуск ошибочно включил runtime в prettier scope. Финальный
  полный PASS использует отдельный runtime вне чистой копии проекта в одном сеансе.

### Границы и handoff

Все acceptance выполнены; результат **ready for review**. Итоговый commit SHA и
результат push передаются в сообщении handoff, а не в собственном тексте commit.
`docs/project/status.md`, PR/merge и установленный стенд оставлены планированию.

Identity не является content hash: in-place edits и изменения children того же
каталога не требуют нового подтверждения. Filesystem может давать ограниченные
identity fields. Повторная проверка pathname не атомарна против external swap
после последней проверки и не является HANDLE/descriptor-bound mutation.
Доверенные ancestors по-прежнему необходимы. Cross-device move semantics,
replace_text/list и прочие upstream изменения не переносились. Новых
воспроизводимых рисков за пределами согласованной границы при этой проверке не
установлено; отдельное расширение scope не требуется.
