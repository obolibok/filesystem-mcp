# Live protocol 004: selected originals bundle

Статус: runbook подготовлен; целевой ChatGPT опыт **не запускался**. До фактического
прогона любые результаты 004 помечаются `LOCAL_ONLY_NOT_CHATGPT`. Опыт выполнять
вместе с пользователем после code review на принятом commit; записать runtime head,
конфигурацию, все artifact hashes и источник каждого наблюдения.

## Цель и PASS

ChatGPT сам вызывает `bundle`, получает внешний manifest и все независимые ZIP,
материализует их в analysis runtime, распаковывает и независимо сверяет точный
selected set и bytes/SHA-256. Затем он открывает вложенный ZIP и BIFF8 XLS, проверяет
контрольные entries/cells и повторно вызывает `get_artifact` для наибольшей части.

PASS требует одновременно:

- submit/reorder retry возвращают один job; изменённый набор при том же key даёт conflict;
- `job_status`: `kind=bundle`, `completed`, `complete=true`, requested=included=2;
- manifest и каждый ZIP реально появились как файлы в принимающей среде;
- ZIP CRC, part size/hash, entry set и provenance совпали; лишних originals нет;
- hashes/bytes originals совпали с независимым fixture manifest ниже, не только с
  manifest самого producer;
- вложенный ZIP и семь XLS cells прочитаны; повторный fetch равен первому побайтово;
- сохранены timings и код/JSON verifier. Видимая ссылка без файла или локальный SDK
  PASS не считается materialization PASS.

## Подготовка Windows стенда

Использовать только новый synthetic каталог и отдельный scratch вне него. Не
подключать production roots, credentials в файлах или чужой foreground tunnel.
Сборка и fixtures:

```powershell
git status --short --branch
git rev-parse HEAD
npm ci
npm run build
python -m venv .tmp/bundle-live-venv
.tmp\bundle-live-venv\Scripts\python.exe -m pip install -r scripts\originals-delivery\requirements.txt
$liveRoot = Join-Path (Resolve-Path '.tmp').Path ('bundle-live-' + [guid]::NewGuid().ToString('N'))
$source = Join-Path $liveRoot 'source'
$scratch = Join-Path $liveRoot 'scratch'
New-Item -ItemType Directory -Path $source,$scratch | Out-Null
.tmp\bundle-live-venv\Scripts\python.exe scripts\originals-delivery\generate_fixtures.py --output $source
```

Независимый эталон создан generator до запуска server:

| Original               | Bytes | SHA-256                                                            |
| ---------------------- | ----: | ------------------------------------------------------------------ |
| `unicode-original.zip` |   703 | `4e729b848906db06641b1ef60e752ae654b5705e92a881cd68319a6538a7fe02` |
| `legacy-original.xls`  |  5632 | `db5c5cbd862f422b42085e3ac0936bb200a7a32cdbf3fce503b3bc76f476fc91` |

Запустить принятый runtime с `--read-only --root-boundary <source> <source>` и
`FS_SNAPSHOT_DIR=<scratch>`. Для HTTP/tunnel следовать проверенному deployment
процессу 003; ключ остаётся process-env и не попадает в команды/логи/Git. Проверить
`/healthz`, `/readyz`, затем что plugin видит ровно synthetic root и 13 read-only
tools, включая `bundle`. Не переиспользовать ещё работающий tunnel другого опыта.

Перед целевым прогоном полезно повторить локальный stdio preflight из
[Windows runbook](../development/windows.md). Его результат остаётся LOCAL_ONLY.

## Последовательность вызовов ChatGPT

1. В новом чистом чате вызвать `list_roots`; зафиксировать только synthetic root.
2. Вызвать `stat` для `unicode-original.zip` и `legacy-original.xls`. Сохранить
   `size` и `modified` как пару `expected` каждого selector.
3. Вызвать `bundle` с новым стабильным key, например `bundle-live-004-main`, и
   точным набором ниже; локальный абсолютный root подставить из `list_roots`:

```json
{
  "path": "<synthetic-root>",
  "idempotencyKey": "bundle-live-004-main",
  "files": [
    {
      "relativePath": "unicode-original.zip",
      "expected": { "size": 703, "lastWriteTime": "<stat.modified>" }
    },
    {
      "relativePath": "legacy-original.xls",
      "expected": { "size": 5632, "lastWriteTime": "<stat.modified>" }
    }
  ]
}
```

4. Немедленно повторить `bundle` с тем же key и элементами в обратном порядке.
   Проверить `reused=true` и тот же jobId. Затем один раз передать только XLS с тем
   же key: ожидается `INVALID_INPUT` conflict и отсутствие второй job.
5. Отдельными вызовами опрашивать `job_status` до terminal. Не держать submit call
   открытым. Зафиксировать submit/build elapsed, counters, manifestArtifactId и все
   `bundle-part` artifact IDs; при `complete=false` опыт не объявлять PASS.
6. Вызвать `get_artifact` для manifest, затем для **каждой** ZIP part. Убедиться,
   что каждый ответ материализовался как доступный analysis runtime файл, а не
   остался только resource link. Сохранить client fetch time, file size и SHA-256.
7. Для наибольшей ZIP part выполнить новый `get_artifact`, сохранить вторую копию
   отдельно и сравнить полные bytes/SHA-256 с первой.

## Независимая проверка в принимающей среде

Verifier читает полученные файлы, а не server scratch. Он должен:

1. Строго разобрать UTF-8 JSON; проверить schema/version/jobId/complete/root ID и
   отсутствие абсолютного root path.
2. Для каждой part вычислить size/SHA-256, открыть обычным ZIP reader, выполнить
   CRC test и сравнить `fileCount`/`rawBytes`. Entry set должен быть ровно:
   `files/unicode-original.zip`, `files/legacy-original.xls`, без traversal/дублей.
3. Извлечь originals в новый каталог, вычислить size/SHA-256 и сравнить одновременно
   с per-file manifest и независимой таблицей выше.
4. Открыть вложенный `unicode-original.zip`, проверить CRC и три entries:
   `README.txt`, `data/Größe-Антенна.txt`, `payload.bin`.
5. Открыть `legacy-original.xls` как BIFF8 workbook и проверить:
   `Control!A1=SCHWARZBECK-ORIGINALS-002`, `Control!B2=4242`,
   `Control!C3=12.5`, `Control!D4=Größe Антенна`,
   `Control!E5=2026-09-19T12:34:56`, `Контроль!A1=КОНТРОЛЬ-Ω`,
   `Контроль!B3=-7`.
6. Сравнить две копии повторно выданной ZIP по полным bytes, не только по именам.

Сохранить verifier code и JSON с `overall_pass`, `validation_errors`, hashes,
sizes, entries, cells, jobId и именами artifacts. Если библиотека XLS отсутствует,
это незавершённый этап, а не PASS; выбрать доступный spreadsheet reader и приложить
точный код/вывод.

## Отчёт и teardown

В `docs/testing/004-live-<date>.md` после опыта записать commit, client/plugin,
server caps, job/artifact IDs, timings, hashes, verifier evidence, skips и пределы.
Не включать API key или абсолютные личные пути. Отличать client report от независимой
сверки server scratch. Максимальный полученный ZIP — наблюдение, не предел host.

После сбора evidence: убедиться, что незавершённых jobs нет, остановить принадлежащий
этому опыту foreground tunnel/server, подтвердить `/readyz` недоступен. Synthetic
fixture/scratch можно оставить локально до приёмки; не коммитить их.
