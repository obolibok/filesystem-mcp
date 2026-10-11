# 012: измерение памяти и срока жизни страниц поиска

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятая 010 и [triage](../testing/report-triage-2026-10-11.md).
Пользователь разрешил исследование и запуск 11.10.2026.
Исполнитель: GPT-6.1-Sol / Extra High, отдельный managed worktree,
ветка `codex/012-pagination-memory-study`. Checkpoint с карточкой передаёт планирование.

## Зачем

PageSnapshotStore хранит до 32 наборов без суммарного byte budget. TTL 60 секунд
от создания не продлевается чтением; expired entries очищаются при create/read,
а не таймером. HTTP callers используют общий store. Нехватка памяти или ёмкости
32 набора пока не доказана. ResourceStore отдельно имеет byte/count limits и
свой TTL. Job artifacts/scratch к этому cache не относятся.

Нужны воспроизводимые измерения и конкретное решение: достаточно текущего режима
для пилота или требуется отдельное изменение byte budget/cleanup/конфигурации.
Заранее увеличивать лимиты либо заявлять OOM не нужно.

## Контекст и владение

Прочитать `src/core/{page-store,store,cursor}.ts`, `src/transport/http.ts`,
соответствующие tests и [архитектуру](../reference/architecture.md).
Основание: [triage](../testing/report-triage-2026-10-11.md).

Владение только:

- новый воспроизводимый harness/fixtures в `scripts/pagination-check/`;
- `docs/testing/012-pagination-memory.md` с методикой, результатами и рекомендацией;
- Work record этой карточки; при необходимости dedicated tests своего harness.

Runtime src/, существующие tests, package.json/server.json, зависимости, общий
README/reference и центральную доску не менять. Не добавлять операционные flags,
метрики/эндпоинты в сервис и не менять defaults/TTL/reuse/ignore. Ключи/туннель,
установленный сервис, рабочие документы и production roots не использовать.
Большие generated fixtures/raw outputs хранить в ignored scratch; tracked harness
должен самостоятельно создавать их и проверять containment перед очисткой.

011 параллельно меняет поисковые инструменты. Здесь стартует baseline текущего
принятого main. Shared runtime файлы не редактировать; новую реализацию 011
самостоятельно не cherry-pick и её checkout не трогать. Harness по возможности
читает schema: новый limit/pageSize или прежний maxResults; фиксирует вариант,
а не сравнивает разные workloads молча. После интеграции 011 планирование повторит
ключевые сценарии этим harness. Этот дополнительный прогон не мешает передать
baseline и рекомендацию на review уже сейчас.

## Методика и результат

1. Зафиксировать Git source commit, Node/Windows, параметры fixtures, точные команды,
   размеры payload и scope измерения. Сначала baseline процесса после загрузки модулей,
   отдельно cold start, retained store и сериализация/клиентские копии.
2. Выполнить небольшой повторяемый набор: list с короткими/длинными путями и
   search_text с короткими/длинными строками, context 0/10; pageSize маленький и
   типичный при одинаковом собранном наборе. Для literal/regex достаточно
   представительных случаев, это не повтор полного функционального тестирования.
3. Проверить 1/несколько независимых клиентов и заполнение ниже/на/выше 32 наборов.
   Различать snapshots, страницы одного cursor и одинаковые fresh queries:
   без cursor это новые наборы. Показать eviction и пригодность surviving cursor.
   Нужен хотя бы один end-to-end local HTTP сценарий с действительно общим store;
   изолированный unit-like store microbenchmark обозначать отдельно.
4. Измерять RSS, heapUsed/heapTotal, external/arrayBuffers и доступную оценку размера
   удерживаемых наборов. JSON byte length не равен V8 heap size. Выполнить несколько
   повторов ключевых случаев и показать разброс; разделять peak/retained/post-cleanup.
   Harness не должен сам удерживать ответы/fixtures и выдавать их память за store.
   Explicit GC допустим только в диагностическом child process и отмечается в отчёте.
5. Проверить fixed TTL, чтение до/после expiry, отсутствие renewal, idle interval
   без новых операций, subsequent create/read и clear/teardown. Реальный 60-секундный
   жизненный цикл проверить хотя бы один раз; fake clock использовать для детерминизма
   отдельных cases, не подменять им измерение idle memory.
6. Отдельно проверить согласование PageSnapshotStore и ResourceStore: cursor может
   пережить eviction resource или наоборот. Это не lifecycle фоновых jobs и не
   доказательство session isolation/security flaw. Зафиксировать что видит клиент
   при expired/evicted cursor/resource и какие действия позволяют продолжить работу.
7. Нагрузку повышать постепенно в отдельном child process с ограничением heap,
   времени и собственным teardown; не доводить рабочую машину до исчерпания памяти.
   Полный OOM для acceptance не требуется. Если выбранный безопасный budget достигнут,
   дать измеренный lower bound и аккуратную оценку, а не выдумывать полный результат.
8. Выдать решение с evidence: оставить defaults либо предложить конкретные значения
   byte budget/TTL/count/cleanup и tradeoffs. Config surface предлагать через принятый
   runtime configuration, не registry server.json. Учесть независимый resource TTL,
   стоимость повторного scan, несколько клиентов и время между действиями модели.
   Рекомендации отдельно от проверенных фактов; нового runtime в этой задаче нет.

## Acceptance

- [ ] Самодостаточный synthetic harness запускается из чистого worktree после npm ci;
      точные команды и cleanup documented, приватные данные не нужны.
- [ ] Раздельно показаны исходная память, retained page sets, serialization/client
      overhead, peak и состояние после expiry/create/read/clear; повторы воспроизводимы.
- [ ] Есть list/search_text и context/long-line cases, paging без rescan,
      независимые queries, multiple clients/shared HTTP store и 32/33 eviction.
- [ ] Реальная fixed-TTL/idle проверка не смешана с fake time и диагностическим GC;
      cursor и resource lifecycle описаны отдельно от jobs/artifacts.
- [ ] Workloads и безопасные границы нагрузки явны; OOM/достаточность defaults
      не утверждаются сверх измерений. Изменений runtime/defaults нет.
- [ ] Отчёт даёт конкретную рекомендацию и короткий набор повторов после 011.
- [ ] Harness smoke и соответствующие static/check проверки пройдены; npm run check
      выполнен как проверка итогового checkout, failures/skips разделены по причине.
- [ ] Обновлены Work record и отчёт; локальные commits готовы к review.

## Launch prompt

```text
Выполни исследовательскую задачу docs/tasks/012-pagination-memory-study.md.
Пользователь разрешил работу. GPT-6.1-Sol / Extra High, существующий managed
worktree; ветка codex/012-pagination-memory-study. Прочитай AGENTS.md, docs map,
brief/status, workflow, Windows runbook и карточку. Проверь checkpoint.
Сделай synthetic harness и измерения, зафиксируй честную рекомендацию и границы.
Соблюдай изоляцию от 011: только свои scripts/docs, без src/defaults/dependencies.
Сохрани локальный commit, Work record и handoff с фактическими base/head/branch,
командами, числами, skips и ready for review. Центральную доску не редактируй;
push/PR/merge и настройки установленного сервиса оставь планированию.
```

## Work record

Заполняет исполнитель. До начала исследования: не начато.

- Base и branch:
- Методика и изменения harness:
- Измерения и воспроизводимость:
- Решение и его границы:
- Команды и результаты проверок, среда, skips:
- Выполненные/оставшиеся acceptance:
- Повторы после 011 и состояние handoff:
