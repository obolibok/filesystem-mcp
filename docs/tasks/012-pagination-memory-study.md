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

11.10.2026: **ready for review**. Исследование завершено, runtime не изменён.

- Base и branch: созданный приложением managed worktree был чистым, detached HEAD
  точно `7d58beac5a95cd2014d2e37f966c4074d6e5d5ec`; карточка присутствовала.
  Создана только ветка `codex/012-pagination-memory-study` от этого checkpoint.
  Второго worktree, cherry-pick 011 и переключения чужих checkout нет.
- Методика и изменения harness: собственные `scripts/pagination-check/{common,
worker,run}.mjs` и README. Детерминированные fake-clock assertions, реальные
  handlers, direct stores и неизменённый local HTTP endpoint с тремя clients
  в другом процессе. Новые fixtures создаются в marked ignored `.tmp`, cleanup
  проверяет canonical containment. Child heap=384 MiB, retained soft stop=180 MiB,
  RSS ceiling=512 MiB, timeout=180 s. Explicit GC только diagnostic child; natural
  и post-GC values отдельны, peak sampling/OS maxRSS и JSON bytes не смешиваются.
- Измерения и воспроизводимость: [отчёт](../testing/012-pagination-memory.md),
  [протокол/команды](../../scripts/pagination-check/README.md). Итоговый `study`
  — 34 PASS workers; short/long list и search, context 0/10, pageSize 1/100,
  три repeats ключевых cases, RE2 representative, раздельные stores, 32/33 eviction,
  paging по прежним rows после опустошения source. Real TTL HTTP PASS: reads в
  55050 ms, idle checkpoint в 61012 ms; expiry не освобождает idle Maps и read
  не renewal. create/read/list/clear/teardown проверены отдельно от jobs/artifacts.
  Harness SHA-256 основных study/TTL замеров:
  `5925f5795126af27fa0ba64a6868536360a55a8b6ce8d266312c16d523597eb6`.
  Дополнительно `default-pages`: short + 3 long repeats со штатным list pageSize
  1000, все 4 PASS; тот же собранный набор/retention, long Δ heap 39,90–40,13 MiB.
  Worker/common неизменны; launcher mode добавлен после основных замеров. Текущий
  hash harness (default-pages и финальный smoke):
  `60d469defd6161a25fb7439204849e590c4f165a1e441cf1333444fa8afa8762`.
- Ключевые результаты: long search C10/32 snapshots — page-only Δ heap
  3,81–4,21 MiB **плюс** Δ external 84,18 MiB; resource-only — 24,28 MiB heap,
  9 resources / 24,08 MiB logical quota. Long C0 compact page JSON 4,28 MiB
  не отражает 84,18 MiB retained backing source. Direct upper-cap list остановлен
  на 24 sets (Δ heap 157,61 MiB), search C10 на 3 sets (Δ heap 174,26 MiB).
  Это soft-budget lower bounds, OOM и достаточность defaults для всего пилота
  не заявлены. Small resource может пережить cursor eviction; cursor может
  пережить resource quota eviction. Public resource failure объединяет expiry
  и eviction: `Cached result not found or expired`, code -32602.
- Решение и его границы: не увеличивать count/TTL. Предложение отдельной задачи —
  charged page byte budget 64 MiB с учётом backing source/objects, fixed TTL 60 s,
  count 32, cleanup 15 s; самостоятельный ресурсный TTL/quota не увеличивать.
  Это кандидат для validation/design, не готовый JSON-byte meter и не обещание
  RSS cap. Runtime config через принятую CLI/env/config, не `server.json`.
  HTTP teardown residual SDK heap, Unicode/production/ChatGPT pauses не профилировались.
- Команды и результаты проверок: Windows build 19045, Node v24.15.0, npm ci PASS;
  npm run build PASS; targeted ESLint/Prettier PASS; `run.mjs smoke` 3 workers PASS,
  `run.mjs study` 34 workers PASS с 2 ожидаемыми soft stops; `run.mjs ttl` 1 PASS.
  `run.mjs default-pages` 4 PASS; финальный smoke текущего harness 3 PASS.
  Raw JSON в `.tmp/pagination-012-{smoke,study,ttl}-final.json`, не нужен для запуска
  из чистого worktree и не коммитится. Первый `npm run check` в sandbox прошёл static,
  но tests не загрузились из-за `tsx/uv_os_get_passwd ENOMEM` (environment failure).
  Разрешённый полный повтор вне sandbox PASS: **458 tests / 450 pass / 0 fail /
  8 skips**, 69 suites, около 43 s test stage; static build/types/ESLint/Prettier/Knip PASS.
  Skips: 3 POSIX-only (FIFO, inode/mode, 0222 append target), 5 Windows file-symlink
  cases без разрешения на symlink. Эти ветки не названы проверенными.
  Последний полный check финального checkout после default-pages: те же 450/0/8,
  test stage 41,23 s; все static stages PASS.
- Выполненные/оставшиеся acceptance: все baseline acceptance выполнены; код,
  переносимый отчёт и этот Work record готовы к локальному review. Src, existing
  tests, dependencies, versions, shared board/reference не менялись. Новая схема
  011 не проверена; её интеграция и предложенный runtime follow-up вне задачи.
- Повторы после 011: rebuild, `node scripts/pagination-check/run.mjs post-011`,
  затем `node scripts/pagination-check/run.mjs ttl`. Сверить variant/max totals,
  p1/p100 retention, оба lifecycle направления HTTP и fixed expiry; при изменении
  представления strings повторить полный study. Локальный commit будет передан
  с фактическим SHA в handoff. Push/PR/merge и установленный сервис не затронуты;
  центральный статус принимает только planning/integration owner.
