# 015: отдельные настройки экспериментального snapshot_tree

Статус: done; принята и интегрирована через PR #13 (merge `6c89ab5833f5283df17898a9f01425ec3d36e9bd`). Планирование ведёт
[центральную доску](../project/status.md). Основание — пожелание пользователя
28.10.2026, [реальный опыт 014](../testing/014-independent-live-2026-10-29.md) и
ошибка запуска комплекта от 29.10.2026: portable config validator отклонил
`FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES` как неизвестный ключ.

## Проблема

С общим raw part 45 MiB и delivery 8 MiB stable обработал 2843566 файлов,
а tree остановился на первой ZIP-part. Для повтора приходится менять общий
FS_SNAPSHOT_MAX_RAW_PART_BYTES, затрагивая stable partitioning/reuse.
Пользователь предложил отдельные настройки эксперимента. «Не лепить Боинг»:
нужен отдельный format knob, а не копия server config/lifecycle.

## Предлагаемый минимальный контракт

- Сохранить experimentalSnapshotTree boolean и opt-in discovery.
- Отдельная настройка сырого размера части только для tree: optional env
  `FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES`, задаваемая в portable config как ключ
  `limits.FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES` — тот же стиль и место, что у
  остальных `FS_*` лимитов. Это точный ключ, который пользователь уже добавил.
  Допустимый диапазон совпадает с `FS_SNAPSHOT_MAX_RAW_PART_BYTES`
  (64 KiB–512 MiB). Если ключ отсутствует, tree сохраняет прежнее поведение,
  используя общий `FS_SNAPSHOT_MAX_RAW_PART_BYTES`; рабочее значение для повтора
  R2 — 16 MiB (16777216 bytes).
- Stable FS_SNAPSHOT_MAX_RAW_PART_BYTES, CSV/identities/artifacts оставить
  прежними. Effective tree knob учитывается только в tree automatic reuse
  identity и manifest policy. Idempotency-семантику не менять.
- Tree-only change не инвалидирует stable completed/in-flight reuse/bytes.
- PathGuard/source policy, jobs/artifacts/TTL/quota/deadline и delivery ceilings
  остаются общими. Не расширять предел доставки ради эксперимента.
- Portable строго валидирует тип/границы, очищает inherited env; ошибочное
  значение не включает эксперимент и не меняет stable config.
- Tree raw cap поступает в tree pipeline до разбиения частей. Общие ZIP,
  delivery, job, scratch/quota и TTL лимиты не увеличиваются и не становятся
  tree-only.
- Меньший raw cap не гарантирует любой compression ratio: общий конечный ZIP
  cap и явный TOO_LARGE сохраняются.

## Acceptance будущей реализации

1. Разные raw part caps одновременно работают у stable/tree в одном процессе.
2. Tree-only config change не меняет stable fingerprints/reuse/bytes; tree reuse
   разделён по effective cap. Проверены completed, in-flight, restart/flag off.
3. Manifest/counters отражают actual policy и все root/header/C/U bytes.
4. Synthetic noisy profile воспроизводит closed-ZIP failure при большом cap и
   проходит с меньшим cap, без production inventories.
5. Default 19/13 и opt-in 20/14 tools, guards/lifecycle/общие ceilings сохранены.
6. Docs/portable sample; regression tests подтверждают, что ошибочное значение
   отвергается до запуска и что stable/tree используют разные raw caps в одном
   процессе.
7. `npm run check` и portable builder/`Verify.mjs` проходят. Новая сборка
   сохраняется в ignored `out/` с BUILD metadata и SHA-256; пользовательские
   корни и production artifacts в неё не входят.

Adaptive repartition по compressed size, новая БД, новые discovery tools,
настройка tree ZIP/delivery cap и полная матрица tree-only limits сюда не входят.
Текущий 014 live не повторять до получения новой сборки.

## Work record

### 2026-10-29 — реализация и проверки

- Ветка `codex/015-snapshot-tree-settings`, изолированный managed worktree.
  Исходная база `a43dfd8183a1ff8b7dfd8509db222ee5637bb5fd`; по указанию
  планирования изменения сохранены через stash и ветка перебазирована на
  `origin/main` — `873b8c1779dff6a0411e154f8d23fa4397abf697` (только исправления
  форматирования документов). Файлы планирования исполнитель не менял.
- Дефект воспроизведён на validator из `a43dfd81` в отдельном synthetic kit:
  корректный tree limit 16777216 отвергался до запуска как неизвестный ключ.
- Runtime принимает optional `FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES`, диапазон
  65536–536870912, fallback на общий raw cap. Portable принимает точный ключ
  `limits.FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES`, строго проверяет JSON number,
  integer и границы до запуска; существующая очистка inherited FS_* применяется
  и к новому ключу. Отсутствие/неверное portable значение не включает experiment.
  Для прямого runtime env сохранён общий стиль: неверное значение даёт warning
  и fallback. Шаблон содержит tree 16 MiB, stable 45 MiB, flag по-прежнему false.
- Pipeline выбирает effective raw cap до первой части; root/header/C/U входят
  в этот cap и job raw counters. Manifest `policy.maxRawPartBytes` отражает
  effective значение; CLI JSON показывает оба caps. Общие closed-ZIP/delivery,
  file/job/parts/quota/TTL caps, guards и tool discovery не увеличены.
- В config fingerprint подставляется effective raw cap только для tree;
  stable fingerprint сохраняет прежнюю форму и значения. Automatic reuse и
  status/fetch используют layout сохранённой job; формат/идемпотентность не
  менялись. Legacy tree без override совместим при прежнем effective cap.
- Regression tests проверяют одновременные разные caps в одном manager,
  exact stable fingerprint/ZIP SHA/counters, completed/in-flight/keyed reuse,
  раздельный tree reuse и equal-cap fallback, restart/flag off, строгую portable
  валидацию/очистку env, raw root/context/part errors и service-byte accounting.
  Noisy synthetic profile (1800 SHA-512 basenames) воспроизводит closed-ZIP
  `TOO_LARGE` при 512 KiB raw и проходит при tree 64 KiB с тем же delivery 64 KiB.
- При полном прогоне выявлена настоящая гонка публикации failure: `failed`
  становился виден до удаления partials. По указанию планирования failure теперь
  публикуется после artifact/partial cleanup; cancellation/close, произошедшие
  во время cleanup, не перезаписываются. Детерминированная задержка unlink
  проверяет `running` во время cleanup, отсутствие partial после `failed` и
  сохранение `cancelled`. Ошибки удаления по-прежнему удерживают quota по общей
  политике; это не гарантия успешного удаления при недоступном filesystem.

Проверки на Windows, Node 24.15.0 / npm 11.12.1:

- `npm ci` — PASS (248 packages).
- `node --test --import tsx __tests__/snapshot-tree.test.ts __tests__/snapshot.test.ts __tests__/job-metadata-persistence.test.ts`
  — **62/62 PASS**, 0 fail/skip, после lifecycle patch.
- `npm run check` на `873b8c17` — **PASS**: build, production/test types,
  ESLint, Prettier, Knip; **511 tests, 503 pass, 0 fail, 8 skip**.
  Skips: 3 POSIX-only и 5 Windows file-symlink privilege cases; junction/native
  Windows metadata проверки исполнялись. Новый test проверяет 19/13 default и
  20/14 opt-in tools с прежними schema budgets.
- До актуального PASS были два отдельных отказа: sandbox `uv_os_get_passwd
ENOMEM` до старта tsx (повтор вне sandbox); полный прогон после lifecycle patch
  поймал существующую гонку test helper `directoryBytes` в startup-expiry test:
  `readdir` увидел metadata-tmp, а последующий `stat` получил ENOENT после rename.
  Этот тест создаёт successful job, чей terminal/persist порядок не менялся;
  helper/assertions не ослаблялись. Он прошёл в targeted 62/62 и повторном full
  check. Ранний отказ форматтера на двух документах исходной базы устранён
  планированием в `873b8c17`, а не локальными правками этих файлов.
- Локальные evidence logs находятся в ignored `.tmp/015-targeted-final.log`
  и `.tmp/015-check-r2.log`; `.tmp/015-tests.log` относится к раннему прогону
  до lifecycle patch и не является итоговым evidence.

### Portable и handoff — ready for review

Runtime/build checkpoint: `0985bfa1dbc37bed39c7e1d20f6d22ea8edf17ab`, на базе
`873b8c1779dff6a0411e154f8d23fa4397abf697`. Следующий commit добавляет только
итоговую запись в эту карточку; runtime/templates совпадают с BUILD source.

Фактические команды из корня checkout:

```powershell
powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-portable/Build.ps1 -NodeArchive .tmp/portable-downloads/node-v24.15.0-win-x64.zip -TunnelArchive .tmp/portable-downloads/tunnel-client-v0.0.14-windows-amd64.zip -OutputDirectory out/Schwarzbeck-MCP-015-test-2026-10-29
node scripts/windows-portable/Verify.mjs out/Schwarzbeck-MCP-015-test-2026-10-29
```

- Builder — **PORTABLE_BUILD_PASS**, packaged preflight — **LOCAL_MCP_PASS**,
  default 13 tools. `BUILD.json` содержит source commit, UTC build time и SHA-256
  закреплённых Node 24.15.0 и tunnel-client 0.0.14 archives.
- `Verify.mjs` — **PORTABLE_ACCEPTANCE_PASS, 17/17 scenarios**. Проверены перенос
  с Unicode/пробелами и чужим cwd, roots/env isolation, snapshot/bundle SHA/CRC,
  разные stable/tree raw caps в одном packaged процессе, stable completed reuse
  при tree-only change, tree repartition, restart/flag off fetch и negative config.
  На initial фазе synthetic 900-file source даёт multipart у обоих форматов;
  каждый manifest/ZIP raw size и shared ceilings проверены отдельно.
- Первый Verify дошёл до старого negative PID test и получил sandbox-only
  `Get-CimInstance: Access denied`. Повтор той же команды вне sandbox разрешил
  чтение process metadata: все 17 сценариев PASS, в том числе отказ Stop.ps1 по
  synthetic чужому PID. Тест никого не останавливает. `Start.ps1 -DoctorOnly`
  использовал только dummy key/local doctor, tunnel run/service не запускались.
- Папка: `out/Schwarzbeck-MCP-015-test-2026-10-29/`.
  Архив: `out/Schwarzbeck-MCP-015-test-2026-10-29.zip`, **70891252 bytes**.
  SHA-256: `65d4037188cec322386f48dffdd787dfd0c33d18c3a30889aa024d81be9b143c`.
  Рядом записан `.zip.sha256`; внутри — `BUILD.json` и `SHA256SUMS.json`.
- Независимый локальный readback: все **2799** строк SHA256SUMS совпадают с
  delivered files; ZIP имеет ровно **2800** files (включая сам SHA256SUMS),
  проверены exact entry set, uncompressed sizes, CRC-32 и SHA-256 каждого файла.
  Только `./sample-source`, scratch `./data/jobs`, flag false, stable 45 MiB /
  tree 16 MiB, ZIP/delivery 8 MiB. В data нет файлов; production roots/jobs,
  пользовательские документы и credentials не включены.
- Итоговые portable evidence: ignored `.tmp/015-build.log`,
  `.tmp/015-portable-verify-final.log`, `.tmp/015-kit-audit.json` и
  `.tmp/015-zip-audit.json`. Бинарники/архивы/evidence не коммитятся.

Acceptance 1–7 выполнен, независимый review завершён, изменения приняты через [PR #13](https://github.com/obolibok/filesystem-mcp/pull/13). Merge commit: `6c89ab5833f5283df17898a9f01425ec3d36e9bd`.

Обе CI-платформы зелёные: Windows и Ubuntu, workflow run 102. Локальный full check — 511 tests, 503 pass, 0 fail, 8 ожидаемых skips. Portable Verify — 17/17; ZIP и полный SHA/CRC readback прошли. Детали, hash и параметры установки записаны в [протоколе интеграции](../testing/015-integration-2026-10-29.md).

Live R2 на новой сборке завершён: tree job `completed`, все 10 ZIP parts и manifest выданы; `complete=false` из-за 470 inaccessible skips и 8 tree error records. Stable/tree local SHA/CRC, extraction, exact path/metadata parity и scan/search сравнение записаны в [протоколе 015](../testing/015-local-r2-2026-10-29.md); live job детали — [здесь](../testing/015-live-r2-2026-10-29.md).

Планирование не меняло установленный пользователем сервис, его config/scratch или туннель; прогон запущен на обновлённом комплекте через подключённый FileMCP. 015 закрыта. Предметный опыт 005 остаётся proposed до выбора данных, вопроса и критериев.


### Follow-up: correction to local processing benchmark — 2026-10-29

Review of the local harness found asymmetric work inside the original timers: tree
performed per-file path reconstruction, duplicate tracking, cross-format metadata
validation and extension parsing that stable did not. The original parse/search
timings therefore do not compare equivalent consumer work and are superseded.
A corrected same-task scan measured medians 6.924 s stable / 5.248 s tree over
three passes; full path-to-metadata index medians were 8.272 s / 6.025 s over two
passes, with matching query counts and file totals. The corrected method and
limitations are documented in [the local R2 report](../testing/015-local-r2-2026-10-29.md).
This local Python result does not measure ChatGPT processing; a separate live-chat
A/B is being prepared.
