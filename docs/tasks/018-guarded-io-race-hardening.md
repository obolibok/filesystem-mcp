# 018: закрыть гонки проверки пути в guarded filesystem I/O

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: 017.

## Зачем

`PathGuard` сейчас проверяет и разрешает путь до отдельного filesystem syscall. Между этими операциями путь или его компонент может быть заменён symlink/junction. В `src/core/path.ts` это явно записано как принятый остаточный риск. Родительский репозиторий позже добавил no-follow открытие и повторную проверку открытого объекта для части операций, а также отказ от перезаписи файла, появившегося после проверки overwrite. Это полезная точечная защита для нашего guarded filesystem; переносить её нужно с учётом собственной архитектуры.

## Контекст и источники

- `src/core/path.ts`: принятый риск между path validation и операцией.
- `src/core/fs.ts`, `src/core/read.ts`, `src/tools/create.ts`: guarded filesystem boundaries и file operations.
- Upstream changelog описывает исправление symlink-swap race и create overwrite race в релизе 2.7.6: https://github.com/j0hanz/filesystem-mcp/blob/main/CHANGELOG.md.
- Локальная ссылка `upstream/main` может отставать. До переноса получить актуальный upstream ref и записать точный upstream commit SHA и релиз/изменения, на которые опирается реализация.

## Scope и владение

Адаптировать только необходимые защиты в существующей архитектуре `PathGuard` и `GuardedFileSystem`; не заменять эти границы копированием исходников upstream.

Проверить и закрыть race между проверкой и открытием файла для guarded reads/original delivery и append. Для платформ, где доступна проверка открытого descriptor/handle, подтвердить, что реально открытый объект остаётся внутри разрешённых roots. При невозможности такой проверки на платформе — явно и безопасно отказать в уязвимой операции либо описать подтверждённую платформенную границу; не выдавать неполную защиту за полную.

Для `create` без явного `overwrite: true` файл, созданный конкурентным процессом после проверки отсутствия/подтверждения, не должен быть молча заменён. Сохранить существующие разрешённые in-root symlink semantics и overwrite confirmation flow там, где это совместимо с безопасным открытием.

Не включать generic MCP input limits, undo/history, широкую переработку concurrency или непроверенные upstream изменения; оформить их follow-up при наличии конкретного обоснования.

## Acceptance

- [x] Synthetic regression сценарий пытается подменить конечный путь на ссылку после validation; bytes/append не пересекают разрешённую границу.
- [x] Сценарий с конкурентным появлением файла подтверждает, что `create` без overwrite не заменяет чужие bytes; явный overwrite сохраняет установленное поведение.
- [x] Проверены Windows и Linux ветки, либо platform-specific ограничения и skips точно указаны. Используются только временные synthetic roots.
- [x] Не ослаблены `PathGuard`, чувствительные пути, boundaries, отмена и cleanup; обычные in-root symlink cases проверены.
- [x] `npm run check` проходит, обновлена архитектурная документация, Work record содержит upstream SHA, threat boundary, проверки и handoff.
- [x] Изменение остаётся узким и отделённым от snapshot formats/jobs и dependency bump 017.

## Launch prompt

```text
Реализуй задачу docs/tasks/018-guarded-io-race-hardening.md в этом репозитории.
Сначала прочитай AGENTS.md, docs/README.md и карточку. Перед кодом синхронизируй
и изучи актуальный upstream, записав точный commit SHA; локальная upstream/main
может быть устаревшей. Адаптируй race hardening к нашим PathGuard и
GuardedFileSystem, не копируй upstream целые модули. Добавь synthetic regressions
для symlink/junction swap и create overwrite race; проверь Windows/Linux поведение
и все acceptance. Заполни Work record и передай результат планированию.
Центральную доску не редактируй.
```

## Work record

Исполнитель: 018; исследование upstream завершено до правок реализации, 29.10.2026.

- Base: `a87ad6bbe24e44c3a340ff91e89f779679f4f642` (принятый merge 017),
  branch `codex/018-guarded-io-races`; назначенный managed worktree. Исходное
  дерево было чистым; ветка fast-forward обновлена с `ec7ebfb6` после fetch origin.
- 29.10 выполнен настоящий `git fetch upstream main --tags`: актуальный
  `upstream/main` — `b23023f2e8b349502035635c2252dfe873a6c567` (v2.12.0).
  Источник узкого переноса — v2.7.6 (12.10.2026), peeled commit
  `3da494ae782b526e2890d8d3da545dfca74ff282`, fix
  `db1474ddd66a68d872777384b6b1eb61ed23f6de`: no-follow read/append opens, Linux descriptor containment,
  exclusive create при отсутствии overwrite approval. Из более поздних
  модулей undo/history и generic limits ничего не переносится.
- Предварительная платформенная граница: Node win32 не экспортирует
  `O_NOFOLLOW`/`O_NONBLOCK` и не предоставляет final path открытого HANDLE.
  Нулевой fallback upstream не считается защитой Windows. Реализованы
  lstat/fstat identity и повторная policy validation до bytes; это обнаруживает
  устойчивый swap и final-component swap, но не доказывает containment при
  враждебном ABA swap всех path probes. Linux проверяет `/proc/self/fd` до bytes
  и отказывает при недоступном procfs. Отдельный native Windows backend остаётся
  за пределами узкой адаптации; полная гарантия там требует доверенных ancestors.

### Реализация и решения

- Общий `src/core/guarded-open.ts` охватывает все source-byte opens в `fs.ts`
  и `read.ts`, включая прямых callers cached batch/search; tools не получают
  прямой доступ к filesystem. `countFileLines` стал guarded методом.
- До bytes проверяются regular-file type, identity и current policy. Linux
  проверяет `/proc/self/fd` и exact canonical pathname, без upstream silent
  fallback при недоступном procfs; для read/append добавлен `O_NONBLOCK`, чтобы
  regular→FIFO swap не зависал. Даже новый exclusive-created descriptor
  проверяется до записи (upstream v2.7.6 пропускал этот check для created).
- Raw originals/resources читаются через существующий bounded descriptor reader,
  поэтому размер проверяется по открытому объекту и во время чтения. In-root
  file symlinks и directory aliases разрешаются заранее; stricter bundle
  selectors по-прежнему запрещают aliases и scratch.
- Существующий append открывается без `O_CREAT`; missing — с `O_EXCL`.
  EEXIST fallback повторяет guarded open и не получает cleanup ownership.
  Cleanup сверяет policy/type/identity; при неизвестной identity сохраняет
  чужой файл. Late open/fstat после abort освобождает handle; append commit-point
  и best-effort metadata сохранены.
- Create без approval использует exclusive syscall, сохраняя concurrent winner.
  Явный/принятый overwrite оставлен на temp+rename с mode preservation.
  Принятый canonical target дополнительно сверяется после resolution: alias
  swap не переносит approval на другой in-root файл. Токен не привязывается к
  inode/content — это прежний pathname overwrite contract, не undo/history.

### Воспроизведение, review и проверки

- На точном base `a87ad6bb` в одноразовом Linux clone четыре strongest triggers
  завершились ожидаемыми failures: leaf raw-read swap, leaf append swap,
  ancestor swap после validation и same-call create race. Команда:
  `node --test --import tsx --test-name-pattern="raw original read refuses|append refuses a final|read refuses a directory|create preserves" __tests__/guarded-io-races.test.ts`.
  Native Windows junction исходного read также вернул outside bytes вместо отказа.
- Новый `__tests__/guarded-io-races.test.ts`: 28 synthetic regressions, включая
  full/head/tail/range/raw/editable/sample/line-count/open/original/cached reads,
  existing/new append и EEXIST fallback, sensitive aliases, syscall create race,
  parent/leaf confirmation redirects, owned cleanup, abort/stalled fstat,
  Linux procfs refusal и FIFO swap. Fixtures — только временные roots.
- До патча выполнен отдельный read-only boundary investigation; после focused
  checks — один независимый bypass/regression review по skill `fix-finding`.
  Подтверждённый reviewer confirmation redirect исправлен и закреплён native
  parent-junction и Linux leaf-symlink regressions. Остальных конкретных
  bypasses/regressions в просмотренной границе reviewer не обнаружил.
- `npm ci`: PASS (249 packages), lockfile не менялся; три dev-only audit notices
  уже описаны в 017, dependency scope не расширялся.
- `npm run type-check`, `npm run type-check:test`, focused ESLint и formatting:
  PASS. Первый full check остановился на единственном unused export Knip;
  экспорт удалён. Sandbox-only запуск tsx получил `uv_os_get_passwd/ENOMEM`;
  проверки выполнялись в разрешённой обычной пользовательской среде.
- Windows Node 24.15.0: финальный `npm run check` PASS: 544 tests,
  **531 pass / 0 fail / 13 skips**. Skips: восемь file-symlink privilege cases
  (три core append, один PathGuard write, один stat и три новых leaf swap),
  три POSIX-only cases (bundle FIFO, inode/mode, mode-0222 metadata) и два новых
  Linux-only procfs/FIFO cases. Новая suite: **23 pass / 0 fail / 5 skips**;
  native junction tests, включая confirmation redirect, не skipped.
- Linux Node 24.22.2, Debian bookworm, disposable `node:24-bookworm` container
  с read-only mount исходников и отдельными dependencies. Прогон root дал
  единственный failure существующего mode-0222 metadata test (root обходит DAC);
  финальный повтор `--user node` PASS: 544 tests,
  **529 pass / 0 fail / 15 skips**. Skips: восемь Windows 8.3/alias cases
  (bundle/harness 3, search 2, snapshot 3), три Windows handle-recovery cases,
  три Win32 sensitive-name/ADS cases и один native PowerShell provenance smoke.
  Новая suite: **28 pass / 0 fail / 0 skips**; native leaf-symlink confirmation
  refusal проверен. Source mount read-only, build/test workdir `/tmp/work`,
  копия без `.git`, `node_modules`, `dist`, `.tmp`; затем `npm ci && npm run check`.

### Границы и handoff

- Полная Windows HANDLE-based containment не заявляется. Подтверждённая граница —
  trusted ancestors; adversarial ABA, hard-link provenance, privileged mount
  swaps и изменения namespace после descriptor check не закрыты этим переносом.
  Metadata и другие pathname mutations остаются отдельными follow-ups.
- При parent escape exclusive open может создать пустую запись до проверки;
  тест подтверждает ноль supplied bytes. За пределами guard она намеренно не
  удаляется. Pathname cleanup остаётся best-effort и не атомарен против следующего
  swap. Append при abort во время write может оставить prefix, как и раньше.
- Snapshot formats/jobs, versions/dependencies, общая доска и чужие задачи не
  менялись. Полный native Windows backend и inode-bound confirmation tokens
  требуют отдельных scope/acceptance; не включены скрыто в baseline fix.
- Все шесть acceptance выполнены в явно описанной платформенной границе.
  Финальные Windows и Linux full checks, `git diff --check`, formatting PASS.
  **Ready for review**: результат сохраняется отдельным commit в ветке 018 и
  передаётся планированию для независимой приёмки; фактический SHA — в handoff
  сообщении. Общую доску исполнитель не обновляет; интеграция не объявлена.

### R1: Windows CI и реальные 8.3 aliases (29.10.2026)

- Вход: planning сообщил о двух Windows search failures на PR #18 merge head
  `2299f4e5` / PR head `3be6074c`. Назначенный worktree был чистым; после fetch
  только ветка 018 fast-forward обновлена до
  `3be6074c84794e3210a9009e04f9506d22424657`.
  PR/main metadata и общая доска исполнителем не меняются.
- Причина подтверждена: `guardedEntries` вызывал
  `validateExistingPathDetailed`, но отбрасывал `resolvedPath`. Затем
  `searchContent` передавал исходное DOS short spelling как canonical `validPath`
  в descriptor reader. Повторная Windows validation возвращала long spelling,
  и строгая проверка path change давала отказ каждому чтению.
- Исправление находится в caller: iterator сохраняет отдельно исходный `path`
  для результатов и проверенный canonical `validPath` для stat/read. Нет новых
  filesystem probes, изменений `guarded-open.ts`, ослабления roots/sensitive,
  no-follow/identity/path-change проверок или прежней платформенной границы.
- Добавлен Windows-only regression в `search-bounded.test.ts` с настоящим
  COM ShortPath и проверкой `~n` basename/realpath parity. Он до исправления
  дал **0 вместо 7 scanned**, после — PASS без skips: literal/regex discovery,
  два matched text files/три lines, binary/UTF-16 skip counts, исходные paths в
  matches, explicit file, разрешённый in-root junction и отказ для escape junction.
- Существующий cancellation hook сравнивал absolute path raw string equality;
  canonical `c:` вместо fixture `C:` не включал injection. Он переведён на
  принятый в репозитории `isSamePath`; контроль отмены снова PASS, в том числе
  под настоящим 8.3 TEMP. Production cancellation не менялась.
- До исправления existing `windows-short-temp.mjs check` воспроизвёл оба CI
  search failures. Его длинный checkout-based TEMP также изменил ожидаемый
  error precedence одного существующего snapshot budget fixture; snapshot код
  и тест не менялись. Финальный Windows профиль использует настоящий 8.3 parent
  с девятисимвольным long basename непосредственно под OS temp, с TEMP/TMP только
  в дочернем процессе и cleanup проверенного synthetic каталога. Отдельный
  snapshot budget control в этом профиле PASS; это соответствует короткому temp CI.
- Первый одновременный Linux/Windows full run на исправленном search прошёл
  affected search cases, но Linux получил transient failure `STDIO-014`:
  ожидание overflow log не успело за 3 секунды. Stdio не использует изменённый
  search pipeline и не менялся; финальные full checks выполняются последовательно.
  Windows run, загрузивший старый cancellation hook, имел один описанный выше
  instrumentation failure; targeted повтор с `isSamePath` — 4/4 PASS вместе с
  обоими исходными CI failures и новым 8.3 regression.
- Следующий полный compact-8.3 Windows run прошёл все search cases, но выявил
  flaky delay в собственной 018 cleanup regression: 20 ms не гарантировали
  завершение detached cleanup на загруженном host. Тест теперь ждёт фактический
  owned `unlink` (bounded timeout 10 s), без изменения production cleanup;
  targeted repeat PASS. Финальный tree включает эту синхронизацию.
- Финальный Windows Node 24.15.0 `npm run check` с реальным compact-8.3 TEMP/TMP:
  **545 tests / 532 pass / 0 fail / 13 skips**; оба CI failures, новый native
  8.3 regression, cancellation и cleanup controls PASS. Skips те же, что выше,
  новый Windows regression не skipped.
- Финальный последовательный Linux Node 24.22.2 / non-root Debian bookworm
  `npm run check`: **545 tests / 529 pass / 0 fail / 16 skips**. Новое skip —
  Windows-only 8.3 regression; остальные 15 описаны выше. `STDIO-014` PASS
  без изменения stdio и его timeout. Docker profile и отдельные dependencies
  те же, что в основном work record.
- Код и tests после этих двух полных checks не менялись; финализировались только
  результаты в Work record, проверенные Prettier и `git diff --check`.
  **Ready for repeat review**: отдельный checkpoint R1 публикуется fast-forward
  в существующую ветку 018; фактические commit SHA и GitHub PR head проверяются
  после push и передаются планированию. PR title/body/state и main не меняются.
