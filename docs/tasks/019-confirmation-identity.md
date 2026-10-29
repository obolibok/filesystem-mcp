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

- [ ] HMAC `requestState` связывает подтверждение с operation, canonical paths и
  identity snapshots; неподдерживаемый/старый state не может разрешить запись.
- [ ] Замена цели между prompt и retry вызывает максимум один новый prompt;
  первый ответ не применяется к заменённому объекту.
- [ ] Повторная замена после нового prompt завершается fail-closed без записи,
  копирования, перемещения или удаления замены.
- [ ] Подтверждённые цели, обычные skip/decline, новая цель, исчезнувшая цель,
  смена операции и порядок ключей multi-item batch проверены synthetic tests.
- [ ] Явный `overwrite: true` сохраняет прежнюю семантику; новый функционал
  не ослабляет PathGuard, HMAC, sensitive paths или guards из 018.
- [ ] Обновлены reference и Work record; полный `npm run check` проходит на Windows
  и Linux. Отдельно записаны skips и границы pathname-based проверки.
- [ ] Изменения ограничены подтверждениями destructive operations; никаких
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

Заполняет исполнитель. До начала реализации: не начато.

- Base и branch:
- Что изменилось и почему:
- Решения/отклонения от исходного плана:
- Команды и результаты проверок, среда, skips:
- Выполненные/оставшиеся acceptance:
- Риски, follow-up и состояние handoff:
