# 012: память и срок жизни страниц

Исследование 11.10.2026, принятый source commit
`7d58beac5a95cd2014d2e37f966c4074d6e5d5ec` после 010, без 011.
Runtime/defaults, установленный сервис и центральная доска не изменены.
Карточка: [012](../tasks/012-pagination-memory-study.md), основание:
[triage](report-triage-2026-10-11.md).

## Решение для планирования

**Не увеличивать 32 snapshots / TTL 60 s. Предложить отдельный follow-up на
byte budget и периодическую очистку PageSnapshotStore.** Небольшая матрица работает
с explicit pageSize 1/100, но это не доказывает достаточность для всего пилота.
При этих уменьшенных страницах 32 реальных запроса к synthetic файлу 2,63 MiB/128
matches удерживают около 88 MiB страниц отдельно от примерно 24 MiB resources.
**Обычный search_text без page аргумента имеет default=500: те же 128 matches
помещаются на одной странице, snapshots/resources не создаются.** У direct store нет byte bound:
3 допустимых по числу строк набора context=10 дают 174 MiB дополнительного heap.
Full OOM не проверялся.

Предлагаемый первый кандидат, **не реализован и требует отдельного решения**:

- оставить count=32 и fixed TTL=60000 ms;
- aggregate charged budget страниц **64 MiB**, eviction LRU по count/bytes;
- cleanup expired entries каждые **15000 ms**, один unref timer на владельца
  store, с teardown; в idle память expired страниц будет удерживаться не более
  TTL + cleanup interval + задержки event loop;
- ResourceStore оставить независимым: 64 / 25 MiB total / 10 MiB entry / 60 s.
  Если нужна гарантия освобождения его idle памяти, отдельно применить такой же
  cleanup interval, согласовав list-changed notifications. Одного page timer
  для этого недостаточно.

64 MiB должен ограничивать **оценку удерживаемого представления**, включая arrays,
objects, строки и retained backing source, а не только JSON matches. В baseline
context=0 при explicit p1/p100 JSON страниц всего 4,28 MiB, но они удерживают около
85 MiB source backing; это не стоимость default вызова к 128 matches.
Конкретный meter требует design/validation: либо producer передаёт консервативную
стоимость backing source плюс overhead, либо stored strings отделяются от исходного
буфера и учитываются вместе с объектами. UTF-8 JSON bytes сами по себе недостаточны.
Кандидат 64 MiB уменьшает current worst retention, но не задаёт жёсткий process RSS:
ещё существуют serialization, transient scan, SDK и allocator high-water.

При таком budget большой набор может занять большую часть cache или не поместиться.
Follow-up должен явно выбрать поведение одного oversized набора, проверять возврат
пригодного cursor/resource и не оставлять недоступную большую запись после ошибки
externalization. Это предложение о контракте, не выполненный runtime fix.

Потенциальные настройки следует проводить через принятую runtime configuration
(`core/config`/CLI/env), с upper/lower bounds, а не registry `server.json`.
Пилот с несколькими моделями платит общей ёмкостью: одинаковый fresh query каждого
клиента добавляет новый набор и повторный scan. Более длинный TTL увеличивает это
окно и не продлевает resource TTL. Время между действиями реального ChatGPT здесь
не измерялось; evidence для увеличения TTL нет. В этой задаче никаких flags нет.

## Воспроизводимость и безопасность нагрузки

Среда: Windows 10 build 19045, Node v24.15.0, SDK client/server 2.0.0 из lockfile,
изолированный worktree, ветка `codex/012-pagination-memory-study`. `npm ci` выполнен.
Source чистый; source commit и harness SHA-256 записываются в каждый JSON.
Hash harness основных замеров study/TTL/smoke:
`5925f5795126af27fa0ba64a6868536360a55a8b6ce8d266312c16d523597eb6`.
Затем добавлен только launcher mode `default-pages`, worker/common не менялись.
Hash default-pages и финального smoke:
`60d469defd6161a25fb7439204849e590c4f165a1e441cf1333444fa8afa8762`.

```powershell
npm ci
npm run build
node scripts/pagination-check/run.mjs smoke
node scripts/pagination-check/run.mjs study --output .tmp/pagination-012-study-final.json
node scripts/pagination-check/run.mjs default-pages --output .tmp/pagination-012-default-pages-final.json
node scripts/pagination-check/run.mjs validation --output .tmp/pagination-012-validation.json
node scripts/pagination-check/run.mjs ttl --output .tmp/pagination-012-ttl-final.json
npm run check
```

Код и подробный протокол: [harness README](../../scripts/pagination-check/README.md).
Raw JSON/fixtures только в ignored `.tmp`, переносимая evidence — этот отчёт и
самодостаточный generator. Собственный marked scratch удаляется с canonical
containment check, source отделён от jobs scratch. Caller env/production roots,
credentials, tunnel и installed service не используются.

Каждый worker — отдельный diagnostic child: heap cap 384 MiB, soft retained heap
180 MiB, аварийная RSS-граница 512 MiB, timeout 180 s. Workers одного `study`
последовательны; нагрузка растёт 1 → 8 → 32 → 33, с дополнительными checkpoints
при давлении heap. При soft stop возвращается результат с достигнутым числом sets.
Это ограниченный стенд, не capacity test машины и не намеренная проверка OOM.
Real TTL запускался отдельно от fake-clock cases; оба используют diagnostic GC,
но wall clock и TTL реального HTTP не подменяются. Остальные процессы Windows не
останавливались; RSS разброс не следует трактовать как универсальную константу.

## Что измерено

`cold` — child до загрузки compiled runtime/SDK; `modules-loaded` — после загрузки
и генерации fixture, до stores/server; `ready` — пустые stores и три in-memory
clients/servers либо настоящий HTTP endpoint. Fixture text не остаётся в массиве
harness, ответы выходят из scope; сохраняются только cursor/URI/count/byte scalars.

На checkpoint сохраняются natural memory **до** GC и retained **после** трёх
explicit GC с event-loop turn. Это диагностические нижние оценки живых allocations,
не обещание production GC. Отдельно sampled peaks каждые 20 ms/на границах операций
и OS process maxRSS. Синхронный transient heap peak может быть пропущен; maxRSS
включает также overhead диагностической JSON byte оценки и client-copy exercise.

`heapUsed`, `heapTotal`, `external`, `arrayBuffers`, RSS записаны отдельно.
`arrayBuffers` входят в `external`: их нельзя складывать ещё раз. Для store
атрибуции далее приведены delta heapUsed и delta external от `ready`.
HeapTotal/RSS сохраняют high-water после clear; это не равно live store bytes.

PageSnapshotStore compact JSON estimate — сумма items, без metadata. ResourceStore
bytes — настоящая logical quota pretty JSON. Ни одна величина не называется V8
heap size. Read-only inspection TS-private Maps выполняется только в worker;
layout assertions не дадут молча измерить другую реализацию.

Handler isolation `page` удаляет real serialized resource из диагностического
store сразу после putText; `resource` очищает диагностический page store сразу
после create. Scan/serialization всё равно происходят. Это искусственная атрибуция,
отдельная от режима обеих копий и HTTP. Direct microbenchmark сам создаёт плоские
уникальные ASCII строки; он не имитирует walk/RE2/IO/HTTP и обозначен отдельно.

## Workloads и реальные handlers

Общий собранный набор не меняется при pageSize 1/100, а также default list pageSize
1000 в дополнительном прогоне. List опубликован как
`limit+pageSize`, limit=20000; search_text baseline — `maxResults`, внутренний
collect cap=10000. Harness выбирает схему из tools/list и фиксирует её.
Каждый сценарий делает 33 fresh queries через три независимых in-memory clients
с общими stores; на 32-м читает первый cursor, затем проверяет eviction второго
и сохранность первого. Для list-long и search-long/context=10 — три отдельных
child repeats каждого pageSize; остальные cases по одному.
Первоначальный `default-pages` проверял только explicit list pageSize=1000.
Search_text baseline default — **500**, а 100 — default find_files, которого
в этой memory matrix нет. После R1 настоящий default-pages пропускает page аргумент
и проверяет также search_text по обе стороны 500; подробности исправлений ниже.

| Fixture              | Параметры собранного набора                                           |
| -------------------- | --------------------------------------------------------------------- |
| List short           | 1200 файлов, relative path 14 chars                                   |
| List long            | 1200 файлов + 2 directories, maxDepth=3, relative path до 168 chars   |
| Search short         | 1000 matching lines; 21 lines/block; width 64; source 1,30 MiB        |
| Search long          | 128 matching lines; 21 lines/block; width 1024; source 2,63 MiB       |
| Context              | 0 или 10 строк до/после; matches разнесены, контексты не пересекаются |
| Regex representative | 128 short matches, context=10, RE2 `study-[a-z]+`, 8 queries          |

Первоначальные raw counts соответствуют fixtures, но исходный harness не записывал
и не отвергал truncated/reason/skips: blanket утверждение «без truncation» ими не
доказано. Исправленный validator и затронутые полные повторы описаны ниже.
Это не повтор полного
функционального поиска. Real handler replay дополнительно возвращает прежние rows
после замены synthetic source пустым directory по тому же path. Fresh query заново
выполняет produce; cursor не добавляет snapshot/resource. Complete single-page
результат вообще не создаёт snapshot — отдельная deterministic проверка paginate.

Округление MiB, delta от пустого `ready`, checkpoint после 33 fresh queries
(32 page sets); оба stores включены. Исторические результаты относятся к **явно
заданным страницам**, всем sets нужна пагинация. Они не описывают default search
к 128 matches и сохранены с исходными hashes/ограничением полноты:

| Case                             | Page JSON | Resources count / MiB |  Δ heapUsed | Δ external | retained RSS |
| -------------------------------- | --------: | --------------------: | ----------: | ---------: | -----------: |
| List short, p1 / p100            |      2,64 |             33 / 4,99 | 18,96–18,97 |         ≈0 |      148–150 |
| List long, p1, 3 repeats         |     10,34 |            33 / 15,35 | 39,88–40,11 |         ≈0 |      224–228 |
| List long, p100, 3 repeats       |     10,34 |            33 / 15,35 | 40,12–40,72 |         ≈0 |      224–227 |
| Search short C0, p1 / p100       |      4,20 |             33 / 5,90 |   9,79–9,80 |      41,75 |      197–198 |
| Search short C10, p1 / p100      |     45,73 |            14 / 23,48 | 54,90–55,57 |      41,75 |      289–298 |
| Search long C0, p1 / p100        |      4,28 |             33 / 4,62 |   5,33–5,35 |      84,18 |      189–190 |
| Search long C10, p1, 3 repeats   |     84,60 |             9 / 24,08 |       28,30 |      84,18 |      214–216 |
| Search long C10, p100, 3 repeats |     84,60 |             9 / 24,08 | 28,88–28,89 |      84,18 |      221–223 |

Дополнительный standard list pageSize=1000: short Δ heapUsed=18,98 MiB/RSS=150,41;
long три repeats Δ heapUsed=39,90–40,13 MiB/RSS=223,01–224,15. Page JSON/resource
bytes и count остаются теми же, Δ external≈0. Первая response JSON оценена в
99160 bytes short / 372879 bytes long (SDK tool result без JSON-RPC envelope).
В этих list fixtures даже default pageSize=1000 меньше 1200/1202 entries:
пагинация остаётся нужна, поэтому retention сохраняется.

Пока collected set больше каждой сравниваемой страницы, её уменьшение не снижает
собранный набор/retained external. Если полный набор помещается на странице,
paginate не создаёт snapshot и resource — retention меняется принципиально. Изменяются
response copies/текст/сериализация страницы, поэтому p100 немного дороже по heap.
Разброс RSS шире разброса live heap; это ожидаемо для allocator/GC, но не следует
объявлять его нормой всех Node/Windows версий.

External delta близка к 32 × source file size, а arrayBuffers после GC около
0,05 MiB. Код читает Buffer → string и возвращает строки из split/slice.
**Интерпретация:** retained substring/backing strings держат полный source текст,
в этой V8 реализации преимущественно вне heapUsed. Это согласуется с C0/C10 и
падением external после page clear; heap snapshot/native allocation profile не
снимался, точная V8 внутренняя структура отдельно не доказана.

## Раздельные stores, peak и освобождение

Search long C10 / **explicit pageSize 1** / 33 queries, три repeats:

| Режим                              | Страницы / resources |    Δ heapUsed | Δ external | Logical resource bytes |
| ---------------------------------- | -------------------: | ------------: | ---------: | ---------------------: |
| Только PageSnapshotStore retention |               32 / 0 | 3,81–4,21 MiB |  84,18 MiB |                      0 |
| Только ResourceStore retention     |                0 / 9 |     24,28 MiB |  ≈0,10 MiB |              24,08 MiB |
| Оба                                |               32 / 9 |     28,30 MiB |  84,18 MiB |              24,08 MiB |

Сумма deltas примерно согласуется; «page heap 4 MiB» без external была бы ошибкой.
ResourceStore byte/count quota не ограничивает второй store.

В намеренном client-copy exercise одной полной long C10 resource одновременно
удерживаются serialized envelope, decoded envelope и parsed payload. Retained
heap растёт примерно на **8,07 MiB**, после выхода из scope возвращается к прежнему
значению. Это дополнительная модель consumer/serialization, не store retention.
HTTP SDK-клиенты находятся в **родительском** процессе и их память не складывается
с server RSS. Parent memory отдельно помечена как без explicit GC и не используется
для attribution store.

Для long C10 p1 RSS при 33 sets около 216 MiB; после диагностической byte оценки
и client-copy maxRSS около 288 MiB. В этой разнице есть overhead harness. Для
direct C10 ниже OS peak 382 MiB, перед clear retained RSS 369 MiB, после clear
live heap возвращается около 23,5 MiB, но RSS остаётся около 380 MiB.
Освобождение reachable объектов и возврат страниц памяти OS — разные события.

Представительный полный trace long C10/p1/repeat 1; MiB. Первые пять числовых
столбцов — retained после diagnostic GC; последний — heapUsed перед GC:

| Этап                     |    RSS | heapUsed | heapTotal | external | arrayBuffers | natural heapUsed |
| ------------------------ | -----: | -------: | --------: | -------: | -----------: | ---------------: |
| Cold до runtime (без GC) |  38,94 |     5,27 |      6,69 |     2,07 |         0,04 |             5,27 |
| Modules + fixture        |  87,48 |    23,44 |     58,38 |    19,97 |         0,04 |            30,80 |
| Ready                    |  88,63 |    26,18 |     59,88 |    19,97 |         0,04 |            30,99 |
| 1 set                    | 100,02 |    29,89 |     64,05 |    22,70 |         0,05 |            37,53 |
| 8 sets                   | 141,89 |    49,11 |    116,79 |    41,09 |         0,05 |            52,21 |
| 33 queries / 32 sets     | 215,71 |    54,47 |    186,71 |   104,15 |         0,05 |            60,28 |
| После byte estimate      | 282,01 |    54,48 |    186,71 |   104,15 |         0,05 |            75,87 |
| Client copies held       | 286,75 |    62,59 |    194,82 |   104,15 |         0,05 |            62,61 |
| Client copies released   | 281,41 |    54,52 |    186,71 |   104,15 |         0,05 |            62,61 |
| Page clear               | 200,02 |    50,55 |    181,96 |    22,69 |         0,05 |            54,68 |
| In-scope teardown        | 200,02 |    50,38 |    182,21 |    22,69 |         0,05 |            50,61 |
| Worker scope released    | 173,31 |    26,07 |    157,88 |    20,07 |         0,05 |            50,39 |

Sampled maxima этого worker: RSS 288,28 / heapUsed 75,87 / heapTotal 196,66 /
external 120,32 / arrayBuffers 21,61 MiB; OS maxRSS=288,29 MiB. Это отдельные
максимумы разных моментов, складывать их нельзя.

Page clear в handler удаляет все Map entries и снижает external примерно с
104,15 до 22,69 MiB; часть текущего async/SDK состояния остаётся живой. Закрытие
clients/servers и выход из scope измеряются отдельными checkpoint; это не доказательство
обнуления всех SDK allocations. ResourceStore не имеет clear API: direct mode
проверяет dropping owner, real TTL — prune через публичные операции. В HTTP close
проверяется реальное pageStore.clear; observer references затем удаляются, но
оставшийся heap нельзя объявлять ресурсной утечкой без отдельного профиля.
В handler worker после выхода из всего async scope heap/external возвращаются
около 26,07/20,07 MiB; in-scope teardown ещё удерживал закрытые SDK объекты. В HTTP
после закрытия search endpoint остаётся около 51,20/20,10 MiB: этот residual не
выдан за page retention или leak, неизвестное SDK/HTTP удержание отдельно не
профилировалось. Counters=0 при удалённых observer references означают отсутствие
наблюдаемого store, не доказательство пустоты всех недоступных Maps. После завершения
worker память процесса освобождается OS.

## Direct store нагрузка: безопасные lower bounds

Это unit-like microbenchmark представления current published caps, **не** реальные
MCP scans такого размера. Строки создаются отдельно, не shared padding/ropes;
нет файлов, clients и ResourceStore в page-only строках таблицы.

| Case            | Набор                                       |             Достигнуто sets | Δ retained heap | Page JSON total |  OS maxRSS |
| --------------- | ------------------------------------------- | --------------------------: | --------------: | --------------: | ---------: |
| Page list       | 20000 entries; два поля строк по 128 chars  |               24, soft stop |      157,61 MiB |      137,33 MiB | 365,73 MiB |
| Page search C0  | 10000 matches; width 64                     |    33 queries / 32 retained |       48,95 MiB |       43,17 MiB | 203,20 MiB |
| Page search C10 | 10000 matches; 21 unique строки × 256 chars |                3, soft stop |      174,26 MiB |      158,34 MiB | 382,13 MiB |
| Resource only   | 2000 matches; width 512; pretty JSON        | 33 queries / quota eviction |       23,95 MiB |               — | 180,05 MiB |

Для последнего случая retained logical resource bytes=23,83 MiB. 25 MiB total,
64/65 count и 10 MiB entry rejection дополнительно проверены deterministic cases.
У repeated-identical text quota остаётся логической, даже если V8 физически
разделяет строки — этот deterministic случай не используется как memory benchmark.
Page count 32/33/LRU проверен и direct C0, и настоящими handlers/HTTP.
Строки C10 не доведены до 32; экстраполяция линейного flat representation даст
значительно больший объём, но полный результат и OOM не заявляются.

## Настоящий local HTTP и независимые lifecycle

Использован неизменённый `startHttpServer` на loopback/port 0, **explicit pageSize=100**,
три SDK clients в
другом процессе. Endpoint создаёт stores сам; diagnostic prototype wrappers лишь
наблюдают фактические instances. Это end-to-end HTTP, без туннеля/ChatGPT.

- List: 33 одинаковых fresh queries дают 32 page sets и 33 resources. Первый
  cursor прочитан другим клиентом на 32 sets; 33-й вытесняет второй cursor.
  Первый продолжает работать, resource **второго** всё ещё читается.
- Long C10 search: 32 page sets, только **9 resources** (24,08 MiB). Первый cursor
  остаётся пригодным после touch, его старый resource уже вытеснен byte quota.
  Paging не обновляет resource и не создаёт новый. Восстановление — fresh query.
- Server-only Δ heap/external: list примерно 23,5 / 0 MiB; search примерно
  31,3 / 84,2 MiB. SDK/HTTP overhead объясняет отличия от in-memory values;
  родительские client copies сюда не входят.

Evicted/expired cursor — tool result `isError=true`, текст
`Invalid cursor. Request the first page without a cursor.`
Public resources/read — `ResourceNotFoundError`, code **-32602**, текст
`Cached result not found or expired. Re-run the tool to regenerate.`
ResourceStore напрямую различает `Resource expired` и `Resource not found`, но
публичный контракт их объединяет. Это две независимые временные копии результата,
не persisted job artifacts и не проверка session isolation/security.

## Реальный fixed TTL / idle

Один завершённый настоящий HTTP цикл, два long C10 queries с **explicit pageSize=1**, чтение первого cursor
и resource около 55 s; затем никаких MCP операций до checkpoint после 61 s.
Diagnostic GC memory samples не вызывают stores и не изменяют их clock/TTL.

| Этап                                   | Page sets |     Resources | Что проверено                                                           |
| -------------------------------------- | --------: | ------------: | ----------------------------------------------------------------------- |
| После двух queries                     |         2 |             2 | Оба handles пригодны                                                    |
| Read около 55 s                        |         2 |             2 | Cursor/resource read успешны                                            |
| Idle после 61 s                        |         2 |             2 | Expired entries всё ещё физически в Maps                                |
| Read expired cursor и первого resource |         0 |             1 | Page read глобально prune; resource read удаляет только запрошенный URI |
| resources/list                         |         0 |             0 | Остальные expired resources prune                                       |
| Fresh query                            |         1 |             1 | Продолжение после expiry посредством нового scan                        |
| HTTP close                             |         0 | 1 наблюдаемый | Реальный page clear; resource observer удержан для диагностики          |

Итоговые wall-clock checkpoints: read 55050 ms, idle 61012 ms после завершения
второго запроса (нижняя граница возраста обоих наборов). При 61 s retained heap
32,37 / external 25,35 / RSS 94,89 MiB; до resource read оба expired stores живы.
Это опровергает автоматическое освобождение памяти ровно при TTL. Read в 55 s
не renewal: в 61 s оба reads отвергаются. Exact-boundary 59999/60000, subsequent
create, resource get/put/keys и отсутствие snapshot для полной одной страницы
проверены отдельными fake-clock cases. Они не заменяют это idle измерение.

## Исправления review R1/R2 и затронутые повторы

Повтор выполнен на source head `b2b83fa746cf5295834e6da09ac8df483089957f`;
его runtime совпадает с исходным baseline, 011 не переносилась. Полный исторический
study из 34 cases повторно не запускался: representation/GC/fixtures для explicit
p1/p100 не изменены. Старые hashes и измерения выше сохранены как исторические;
отсутствующие в их JSON признаки полноты задним числом не добавляются.

Новый hash исполняемого harness (common/validate/worker/run, именно этот порядок):
`488e0dd6d97ae96cebc5e93d17a30870c78c9aab0bd755012b0df593a8c00b92`.

### R1: настоящие default calls

`default-pages` теперь **не передаёт maxResults/pageSize**, для modern схемы также
не передаёт limit. Effective default читается из tools/list. Baseline search_text
равен 500, list — 1000. Каждый case делает 33 fresh queries, всем 33 результатам
проверены collected/shown/truncated/reason/skips. List short + три long repeats
с omitted page также прошли (1200/1202 entries, 32 snapshots/33 resources).

| Search fixture, context=10                | Requested / effective page | Collected / shown | Cursor / resource | Sets / resources после 33 queries | Δ heapUsed / external | Resource quota bytes |
| ----------------------------------------- | -------------------------- | ----------------- | ----------------- | --------------------------------- | --------------------- | -------------------- |
| 128 matches × width 1024; source 2,63 MiB | omitted / 500              | 128 / 128         | absent / absent   | 0 / 0                             | 0,03 / 0,12 MiB       | 0                    |
| 600 matches × width 128; source 1,55 MiB  | omitted / 500              | 600 / 500         | present / present | 32 / 14                           | 44,06 / 49,73 MiB     | 24,85 MiB            |

Оба скана полные: truncated=false (optional field absent), reason=null, normalized
skip counters=0, filesScanned=1. Fit-case не удерживает page/resource payload;
его RSS 108,35 MiB — процесс с transient scan/response/JIT, не cache bytes.
Paged-case RSS=262,82 MiB. Width 128 у 600 matches выбран для безопасного file и
resource budget; это **другая fixture**, её нельзя сравнивать как ту же long/128
нагрузку из первоначальной таблицы. Это подтверждение реального default paging,
а не универсальная оценка стандартных запросов.

### R2: полнота каждого fresh query и negative controls

Общий `validateFresh` используется реальными handlers и HTTP clients. JSON
сохраняет effectiveContract (schema, requested/default/effective page, collection
limit и его источник), expectedScan и scalar freshQueries **для каждого** свежего
запроса. Записываются collected/shown, truncated/stoppedReason, filesScanned,
filesMatched, list counters, reportedLimit, четыре skipped counters, наличие
cursor/resource; отсутствующие optional flags отдельно сохраняются как null и
нормализуются false/zero. Полный case требует точного fixture count и page rows,
отсутствия stop/skips. Intentional partial требует отдельного expectedPartial и
точных collected/truncated/reason. Category отражает ожидаемый исход; отклонённые
контроли находятся в negativeControls, не в таблице успешных измерений.
`stoppedAtSafeBudget` ограничивает число fresh sets процесса и никак не заменяет
truncated отдельного скана.

- **Настоящий cap negative control:** fixture 10001 matches, width=32/C0,
  explicit p1, один query. Baseline собрал 10000, truncated=true,
  stoppedReason=maxResults, skips=0. Обычное ожидание complete отвергнуто,
  worker **exit=1**; launcher подтверждает ожидаемый отказ.
- **Intentional partial:** тот же скан принят только с expectedPartial
  `{reason:'cap', collected:10000}`; JSON category=intentional-partial и фактическая
  причина maxResults. Эта память не включена в сравнение полных workloads.
- **Timeout/skips controls:** пять dedicated unit tests; synthetic successful
  timeout result с тем же count отвергается по truncated/reason, skippedBinary=1
  также отвергается. Это смоделированные ответы, не реальные deadline/OS I/O опыты.
- **Затронутые полные повторы:** long128/C10 explicit p1/p100 по 33 запросам,
  shared real HTTP long128/C10/p100 — по 33 fresh records каждый; все count=128,
  truncated=false, reason=null, skips=0. Они сохраняют независимые 32/33 store
  lifecycle проверки. Smoke (3 workers) и реальный HTTP TTL (61 s) также повторены
  с validator. Default cases — 6 workers; validation mode — 4 successful workers
  плюс один ожидаемо rejected control; unit tests — 5/0/0.

Точные команды follow-up (raw JSON только ignored scratch):

```powershell
node --test scripts/pagination-check/validation.test.mjs
node scripts/pagination-check/run.mjs default-pages --output .tmp/pagination-012-r1-defaults.json
node scripts/pagination-check/run.mjs validation --output .tmp/pagination-012-r2-validation.json
node scripts/pagination-check/run.mjs smoke --output .tmp/pagination-012-r2-smoke.json
node scripts/pagination-check/run.mjs ttl --output .tmp/pagination-012-r2-ttl.json
npm run check
```

64 MiB и cleanup 15 s остаются кандидатами отдельного design/validation. R1 меняет
область применимости вывода о default call; R2 устраняет возможность молча сравнить
partial с complete. Новые runtime возможности этим follow-up не назначаются.

Итоговый full `npm run check` follow-up вне sandbox: **463 tests / 455 pass /
0 fail / 8 skips**, 69 suites, test stage 39,32 s; build/types/ESLint/Prettier/Knip
PASS. Skips прежние: 3 POSIX-only и 5 file-symlink без Windows permission.
Новый real TTL подтвердил reads в 55041 ms, idle 61008 ms, затем page/resource
prune и fresh recovery; clock не подменялся. Unit timeout остаётся отдельной
смоделированной проверкой validator.

## Проверки и границы

- `npm ci`, `npm run build`: PASS.
- Harness smoke, study (34 bounded workers), default-pages (4), real TTL: PASS; два direct workload
  завершены по soft memory budget, это ожидаемый результат lower-bound cases.
- Static stage полного `npm run check`: PASS (build/types/ESLint/Prettier/Knip).
- Sandbox test stage остановился до загрузки suites: `tsx` вызывает
  `os.userInfo`, `uv_os_get_passwd ENOMEM`. Это ошибка среды, не измеренный OOM
  PageSnapshotStore. Повтор полного `npm run check` вне sandbox: **450 pass,
  0 fail, 8 skips / 458 tests**, все static stages PASS. Детали skips в Work record.
- Исходные runtime files, existing tests, dependencies/versions, reference и
  центральная доска не изменены. Только harness, этот report и Work record 012.

Не измерены production corpus, ChatGPT pause distribution, remote latency,
Unicode worst-case representation и предельная ёмкость OS. Direct synthetic flat
strings не воспроизводят V8 backing behavior настоящего read. Diagnostic GC,
payload byte estimate и выбранная fixture геометрия ограничивают переносимость
чисел. Не назначены изменения runtime и не закрыты jobs/artifacts cleanup вопросы.

## Короткий повтор после 011

После интеграции, в чистом runtime checkout и после rebuild:

```powershell
node scripts/pagination-check/run.mjs post-011 --output .tmp/pagination-012-post-011.json
node scripts/pagination-check/run.mjs ttl --output .tmp/pagination-012-post-011-ttl.json
```

Post-011 mode включает omitted default search с 128 и 600 matches, затем explicit
p1/p100 long C10 и оба HTTP сценария. Сверить effectiveContract/requested=null,
actual published default, соответствие fixture/full outcome, отсутствие cache у
fit-case и наличие paging у above-default case. Validator отклонит неожиданное
усечение/skips, новые полные raw records доступны для каждого запроса.
Сверить schema variant, collected count/truncation, p1/p100 retention long C10,
32/33 LRU, оба HTTP lifecycle направления и wall-clock expiry. Если source/read
representation или бюджет меняются, повторить `study` с тремя repeats. 011 не
cherry-pick в этой ветке; её новая схема пока не названа проверенной.
