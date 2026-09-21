# Локальная проверка bundle 004: 2026-09-20

Статус: **PASS, LOCAL_ONLY_NOT_CHATGPT**. Это evidence реализации и локального
MCP-маршрута; материализация в целевой ChatGPT analysis runtime не запускалась.
Live protocol: [bundle-live.md](bundle-live.md).

## Stdio MCP и независимый verifier

Из принятого synthetic originals generator 002 созданы ZIP 703 B и BIFF8 XLS
5632 B. Новый `scripts/bundle-check/local-mcp-check.mjs` запустил фактический
`dist/index.js` по stdio с `--read-only`, одним `--root-boundary` и отдельным
`FS_SNAPSHOT_DIR`, затем выполнил `bundle → job_status → get_artifact`.

- submit: 16,4 ms; ожидание terminal: 34,5 ms;
- job: completed, complete=true, requested/included 2/2, skipped/errors 0;
- source bytes 6335, один ZIP 1633 B, manifest 3022 B;
- retry с обратным порядком переиспользовал job; наибольшая часть отдельно выдана
  второй раз и совпала побайтово;
- server source root содержал ещё limit fixtures, но в ZIP вошли ровно два выбранных
  original; source не изменялся.

Отдельный `verify_bundle.py` читал только материализованные manifest/ZIP, проверил
part size/SHA-256, ZIP CRC, exact entry set и распакованные bytes против fixture
manifest, созданного до server. Затем он открыл вложенный ZIP (3 entries) и BIFF8
workbook (7 cells, включая Unicode/date/numbers). Итоговый status PASS. Python
dependencies были pinned `xlrd==2.0.2`, `xlwt==1.3.0` в ignored `.tmp` venv.

## Объёмный профиль

`scripts/bundle-check/volume.mts` создал 7 детерминированных плохо сжимаемых
originals по 1 MiB. Raw-part и closed-ZIP caps — по 2 MiB; суммарные raw bytes
7340032 B, то есть 3,5 raw-part caps. Producer не держал originals в общем Buffer:
guarded capture и ZIP output обрабатывались chunks, а промежуточные bytes находились
в quota-managed scratch.

| Метрика                |                Значение |
| ---------------------- | ----------------------: |
| Parts                  |                       7 |
| Raw originals          |             7 340 032 B |
| Closed ZIP total       |             7 343 588 B |
| Каждая ZIP             |             1 049 084 B |
| Submit                 |                  8,6 ms |
| Build                  |                438,4 ms |
| Fetch всех parts       |                 25,4 ms |
| Peak RSS процесса      |           140 083 200 B |
| Peak scratch sample    |             9 410 665 B |
| Повтор наибольшей part | 1 049 084 B, byte-equal |

Independent yauzl verifier полностью прочитал все семь архивов, проверил entry
set, CRC/размеры и SHA-256 каждого распакованного original против эталона generator:
PASS. Времена — локальные wall-clock наблюдения одного Windows запуска, не benchmark
SLA. RSS включает Node/tsx/test runtime, а scratch sampling с шагом 5 ms может не
поймать более короткий transient peak.

## Regression и Windows paths

`__tests__/bundle.test.ts`: 10 pass, 0 fail, 0 skip. Проверены HTTP disconnect/timeout,
bounded selection, exact selection,
reorder/retry/conflict, duplicate/unsafe inputs, same basenames, Unicode, zero-byte,
binary/nested ZIP/XLS bytes, expected metadata, missing/inaccessible/changed/special,
all-skipped, poor compression split, single `too_large`, immutable repeat after source
deletion, policy narrowing after restart, cancel, deadline и real junction fail-closed.

Отдельный прогон создал длинный TEMP-каталог и передал test runner его настоящий
8.3 spelling (`...\BUF3C7~1`) через process-local `TEMP`/`TMP`; весь bundle suite:
10 pass, 0 fail, 0 skip. Тот же suite передал 8.3 spelling длинного source root через
public MCP tool. Direct-pipeline fixtures предварительно canonicalized так же, как
`bundle`, чтобы test setup не подменял production path semantics.

Существующий `snapshot.test.ts` после обобщения lifecycle: 27 pass, 0 fail,
0 skip. Финальный `npm run check`: **PASS**, 395 tests, 388 pass, 0 fail,
7 skip. Все skips относятся к существующим platform/permission cases: POSIX
inode/mode assertions на Windows и file-symlink cases без доступной привилегии;
bundle suite в обычном и 8.3 TEMP прогонах не имел skips. Отдельный
`npm run check:static` также завершился PASS.
