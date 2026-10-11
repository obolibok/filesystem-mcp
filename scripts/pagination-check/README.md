# Pagination memory study harness (012)

Самодостаточный диагностический стенд для принятого runtime, только synthetic
данные. Запуск из корня своего checkout на Node >=24:

```powershell
npm ci
npm run build
node scripts/pagination-check/run.mjs smoke
node scripts/pagination-check/run.mjs study
node scripts/pagination-check/run.mjs default-pages
node scripts/pagination-check/run.mjs ttl
```

`smoke` проверяет детерминированные lifecycle/границы, реальный handler с контекстом
и три клиента настоящего HTTP endpoint с 33 fresh queries. `study` выполняет
матрицу list/search, повторы, раздельные stores, bounded нагрузку и HTTP. `ttl`
занимает примерно 70 секунд: читает в 55 s, наблюдает idle retention после 61 s,
затем проверяет expiry/cleanup/recovery. Это настоящий wall clock.
`default-pages` отдельно повторяет list с его стандартным pageSize=1000:
один short и три long repeats, те же 1200 files/33 fresh queries.

После принятия 011:

```powershell
npm run build
node scripts/pagination-check/run.mjs post-011
node scripts/pagination-check/run.mjs ttl
```

Этот короткий набор повторяет search с context=10, pageSize 1/100 и два HTTP
сценария. Для сравнения разброса целиком повторить `study`. Harness читает
опубликованный inputSchema и сохраняет вариант `maxResults` или `limit+pageSize`.
Новый `limit` явно равен прежнему cap: 10000 search / 20000 list. Разные схемы не
сравниваются как одинаковые по умолчанию; проверить total/truncated в итогах.

Каждый worker запускается последовательно в отдельном процессе с `--expose-gc`
и `--max-old-space-size=384`, timeout 180 s, аварийной RSS-границей 512 MiB.
Нагрузка прекращается после checkpoint с retained heap >=180 MiB. Такой stop
записывается как измеренный lower bound; он не означает проверенный OOM. Одновременно
запускать несколько `study` не требуется. Во время исследования другие процессы
машины не контролируются; сравнивать прежде всего heap deltas своего процесса.

Stores наблюдаются без изменения runtime: читаются TS-private Maps в compiled JS;
при изменении layout assertion останавливает измерение. Handler isolation
`page` сериализует реальный resource, но сразу удаляет его из диагностического
ResourceStore; `resource` сразу очищает диагностический PageSnapshotStore.
Это искусственные режимы атрибуции памяти. Реальные обе копии и настоящий HTTP
измеряются отдельно с неизменёнными stores.

В HTTP worker запускается именно `startHttpServer(0, ..., {httpHost:'127.0.0.1'})`;
три SDK-клиента находятся в родительском процессе. Prototype wrappers только
фиксируют ссылки на реальные stores и не меняют create/put/cleanup. Ответы клиентов
не удерживаются на сервере. В handler/direct случаях ответы выходят из scope до
GC. Отдельный checkpoint намеренно удерживает сериализованный envelope и два
JSON.parse результата, после него эти ссылки освобождаются. Complete result,
помещающийся на одной странице, не создаёт snapshot — это проверяет smoke.

JSON содержит cold/module/ready baseline, natural memory перед GC, retained
memory после трёх GC с event-loop turn, sampled peak с шагом 20 ms и
`process.resourceUsage().maxRSS` в байтах. Синхронные пики между samples могут
пропускаться; maxRSS учитывает максимум процесса, но не даёт peak heap. Поля
`rss/heapUsed/heapTotal/external/arrayBuffers` сохраняются отдельно.
`pageCompactJsonBytes` — сумма compact JSON размеров items, без metadata; это
логический payload, **не** размер V8 heap и **не** предлагаемый готовый byte meter.
`resourceBytes` — настоящая логическая квота ResourceStore (pretty JSON).

Результаты по умолчанию: `.tmp/pagination-012-<mode>.json`. Можно задать
`--output .tmp/name.json`; существующий файл результата будет перезаписан.
В JSON фиксируются source commit, чистота runtime source, среда, ограничения и
SHA-256 конкатенации `common.mjs`, `worker.mjs`, `run.mjs`. Пересобрать dist перед
запуском: hash build output отдельно не проверяется. Файл сохраняется после каждого
worker; `complete:false` означает неполный прогон.

Fixtures/jobs находятся только в новом marked `.tmp/pagination-012-*` scratch.
Source и job scratch разделены. Перед recursive cleanup проверяются canonical
containment в `.tmp` этого checkout и marker; cleanup удаляет только свой новый
scratch. `.tmp`, raw JSON и fixtures не коммитятся. При жёстком завершении самого
launcher marker может остаться: проверить canonical target и удалить только этот
принадлежащий прогону каталог. Child env очищается от `FS_*`, `API_KEY`, HTTP_HOST
и PORT, без изменения caller/system env. Production roots, установленный сервис,
туннель и ключи не используются.

Fake-clock cases выполняются отдельно: PageSnapshotStore с `now`, ResourceStore
с временной подменой Date только в синхронном worker case; Date восстанавливается.
Они проверяют точные boundary/eviction/cleanup, но не измеряют idle time.
Реальный TTL не использует fake Date. Jobs/artifacts не создаются; служебный
ArtifactJobManager инициализируется/закрывается только как зависимость сервера.

Итоги и рекомендация: [012-pagination-memory](../../docs/testing/012-pagination-memory.md).
