# 010: bounded list — локальные проверки и live-протокол

Дата локальной проверки: 2026-10-09. Только synthetic fixtures, отдельный
managed worktree от checkpoint `151dfa1feefcd74b80c69e939f3e8b5ec30ee7cb`,
ветка `codex/010-bounded-list`. Установленный комплект, production roots,
туннель и credentials не использовались и не менялись. Live ещё не выполнен.

## Воспроизведение до изменения

In-memory MCP client/server, synthetic source: три branch-папки, в каждой
10 nested-папок по два файла; scratch отдельно от source. Обёртка настоящего
`fs.promises.glob` до импорта сервера с `syncBuiltinESMExports` считала raw
matches и уникальные `parentPath`, в том числе отвергнутые depth filter.
Запрос: maxDepth=1, maxEntries=100, includeHidden=true, includeIgnored=true.

| Опыт                              | Raw matches | Глубже scope | Перечисленные parent directories | После 1000 ms | Ответ                     |
| --------------------------------- | ----------- | ------------ | -------------------------------- | ------------- | ------------------------- |
| Без задержки                      | 93          | 90           | 34                               | 0             | 3 entries, success, 45 ms |
| 15 ms перед каждым глубоким yield | 93          | 90           | 34                               | 37            | TIMEOUT, 1627 ms          |

Время — наблюдение данного synthetic запуска, не benchmark production диска.
Задержка искусственная; лишняя рекурсия доказана первым опытом без задержки.
Локальный scratch probe не является зависимостью: структура и измерение
записаны здесь; независимый исходный [triage](010-list-depth-triage-2026-10-09.md)
сохраняется как историческое свидетельство.

## Реализация и instrumentation после изменения

List использует `core/list-walk.ts`: потоковые `Dir.read()` через
`GuardedFileSystem.opendir`, depth check до descent, lazy guarded `.gitignore`
только открытых каталогов. Ignore matcher/default exclusions вынесены из glob
в `core/source-ignore.ts` без смены контрактов find_files/search_text/replace_text.
После N доступных entries consumer закрывает iterator; все frames закрывают
Dir handles в finally. Guarded opendir ждёт неотменяемый OS open и закрывает
поздний handle при отмене. Между OS calls и на excluded entries проверяется signal.

`__tests__/list-bounded.test.ts` оборачивает настоящий guarded opendir, нативные
Dir.read/close и guarded openOriginal; проверки основаны на фактических opens,
reads и closes, а не только на отфильтрованном массиве или времени.

- На трёх обычных branches и одной hidden branch с 10 nested-папками в каждой:
  depth=1 открывает ровно root; depth=2 — root+3 или root+4 branches в зависимости
  от includeHidden. Nested directories никогда не открываются. При includeIgnored
  rules не читаются; иначе попытки читать `.gitignore` соответствуют ровно открытым
  каталогам, не затрагивая rules глубже scope. Матрица обеих flags PASS.
- На wide/deep дереве limit=1 открывает только root, делает один Dir.read и один
  close, возвращает первую доступную папку и не входит в неё. Обе flags проверены.
- Cases 0/1/N-1/N/N+1 с N=3, pageSize 1/3/10: общий набор <=N; pages без потерь
  и дублей. Exact N консервативно truncated. Cursors не увеличивают I/O counters;
  можно изменить pageSize. Query mismatch для limit/path/depth/flags и expiry
  проверены без зависимости от wall-clock.
- Text warning перед rows, totals и stop metadata/resource согласованы на каждой
  странице, включая последнюю без cursor. Без resourceStore тот же bounded
  результат. Nested entries с родителем на прошлой странице видимы в text.
- Отмена во время delayed filtered read закрывает два открытых frames и не
  начинает следующий read; отмена во время ignore loading закрывает rule+Dir
  handles без Dir.read. Предварительная отмена запускает 0 operations.
  Late native opendir после отмены возвращает закрытый handle. Реальный wire
  deadline (default 5 s, без увеличения) даёт TIMEOUT, 1 read/1 close, без metadata
  успешного результата. Тесты синхронизированы событиями, не sleep thresholds.
- Optional signal в PathGuard/GuardedFileSystem не даёт начинать stat/ancestor
  probes/opendir после отмены во время realpath validation (0 новых операций).
- Nested ignore negation, default exclusions, sensitive `.env`, escaping и
  internal junction no-follow, configured-root canonical junction PASS.
  Общие boundary/allow/deny/alias regressions проверяются существующими suites.

## Воспроизводимые команды

В чистом checkout нужны только lockfile dependencies; probe или чужие ignored
файлы не требуются. Shell sandbox в этой сессии не запускался (`setup refresh`),
резервный Node REPL также завершался; разрешённый local shell запуск работал.
Использован Windows, Node v24.15.0, npm 11.12.1, `npm ci` в собственном worktree.
Runtime/dependencies/версии проекта не менялись.

```powershell
npm ci
node --test --import tsx __tests__/list-bounded.test.ts
node --test --import tsx __tests__/tools.test.ts __tests__/core-fs.test.ts __tests__/security.test.ts __tests__/tool-selection.test.ts __tests__/stdio.test.ts __tests__/http-transport.test.ts
npm run build
node scripts/list-check/local-mcp-check.mjs
npm run check
```

Runnable harness сам создаёт 1008 top-level entries + глубокие synthetic branches,
source и scratch отдельно, запускает build stdio server в full и read-only,
проверяет actual tools/list и tool responses, затем закрывает процесс и удаляет
свои fixtures. Окружение stdio ограничено default environment + synthetic scratch;
production FS settings не наследуются.

Локально проверено на первоначальном review head `7fabbe0b`:

- Bounded acceptance suite: 14 PASS, 0 FAIL, 0 skips.
- Existing targeted regression suites: 187 PASS, 0 FAIL, 6 skips.
- Actual stdio full/read-only: PASS; default page 1000, total collected 1008;
  limit=100/pageSize=25 — 4 × 25, 100 unique entries, resource entries идентичны,
  последний warning остаётся, maxEntries отклоняется с его именем в validation error.
- Tools/list: full 19 tools / 25888 chars; read-only 13 tools / 15808 chars.
  После удаления повторов в depth/pageSize descriptions прирост к 009 — 156 chars
  в каждом профиле. Existing ceilings 26900/15900 сохранены, count не менялся.
- Первоначальный полный check: 457 tests, 449 PASS, 0 FAIL, 8 skips. Три POSIX-only
  cases (FIFO, inode/mode, 0222 append target) и пять недоступных Windows
  file-symlink cases; реальные junction checks 010 PASS. Полный environment и
  skips записаны также в Work record карточки.

## Контракт и ограничения

`limit` default/cap=20000, `pageSize` default=1000/cap=20000, диапазон обоих
1..20000; maxEntries удалён без alias, maxPages отсутствует. Limit считает
доступные файлы/папки/symlink/other суммарно. Page size не сокращает сбор.

Машинные поля: `limit`, `truncated` (boolean всегда), `stoppedReason='limit'`
только при cap stop. Эти поля находятся в `_meta` text tool и в JSON resource;
дублирующий structuredContent не добавлен. `totalEntries/totalDirectories`
относятся к собранному набору; `totalFiles` сохраняет прежнее non-directory
значение, включая symlink/other. `complete` не добавляется. Exact N не доказывает
EOF и всегда предупреждает о неподтверждённой полноте.

Cursor не продолжает scan; identity включает effective limit и прежние
path/depth/flags. PageSize вне identity. TTL/resource delivery прежние. Сортируется
только собранный набор, глобально первые N не гарантируются. Raw policy-excluded
entries и OS read-ahead могут превышать limit; limit не является OS-call budget.
No-follow не гарантирует атомарность source: прежний TOCTOU window PathGuard
сохраняется. Ignore read failures остаются best-effort с log warning, как прежде;
source policy применяется к самим rules и symlink rules не читаются. Отмена
ждёт уже начатый неотменяемый OS I/O; зависший OS call принудительно не прерывается.

## Live после review и поставки — выполняет планирование

1. Зафиксировать reviewed/runtime SHA и обновлённую поставку. Обновить подключение
   и каталог tools (при необходимости reconnect/reinstall connection). В actual
   tools/list убедиться в limit default 20000/pageSize default 1000, отсутствии
   maxEntries/maxPages. Проверить ясное отклонение старого maxEntries.
2. Выбрать один явный разрешённый большой root из list_roots. Вызвать list с
   maxDepth=1, includeHidden=true, includeIgnored=true, limit=100, pageSize=25.
   Зафиксировать response/error и elapsed time; ожидается обход только верхнего
   уровня. Повторить includeIgnored=false для проверки scoped rules. Не считать
   время гарантийным SLA для SMB или зависшего OS I/O.
3. Проверить limit warning до tree rows, `_meta.limit/truncated/stoppedReason`,
   entryCount<=25, totals<=100 (файлы и папки вместе); cursor перечисляет только
   этот набор. Продолжать буквальным JSON из строки `Next page: list {...}`,
   без восстановления аргументов вручную. Дойти до последней страницы: cursor отсутствует, warning остаётся.
4. В одном опыте поменять только pageSize между pages: entries без дублей/потерь,
   прежние totals/stop state. С другим limit или depth старый cursor отклоняется.
   Resource на первой странице содержит те же collected entries и stop metadata;
   он не называется полным деревом. Читать его в пределах прежнего ~60 s TTL.
5. Повторить малый fixture с entries<limit: truncated=false, warning отсутствует;
   отдельно exact N: warning остаётся. Убедиться, что LLM различает collected
   totals и tree totals и для полного индекса/числа файлов выбирает snapshot.
6. Зафиксировать только обезличенные counters/flags, wire catalog и наблюдения
   времени/ошибок. Production paths/inventories/credentials не сохранять в Git.
   Отдельно отметить недоступные сценарии и сеть/permissions; local PASS не
   объявлять выполненной live-приёмкой.

## Доработка после review R1/R2, 2026-10-09

Review head `7fabbe0bf4e88eab1aa30181d9569f23b9ccacb3` опубликован планированием
в commit `4c9ce2ebf51d3cfaf9e348ac18d906b7dc757ef9`, документ
`docs/testing/010-review-r1-2026-10-09.md`. Он прочитан через git show; общая
доска не переносилась в ответственность исполнителя.

Новая regression до fix подтверждала actual INVALID_INPUT при исполнении
JSON из Next page для `list({limit:2,pageSize:1})` с omitted path. Actual wire
TIMEOUT также подтверждал прежнее `Reduce scope, depth, or maxResults.`.
Обе проверки были красными на предыдущем head и зелёными после доработки.

List теперь передаёт в общий pageTrailer nextArgs: effective path, исходные
parsed depth/flags/limit/pageSize. Path берётся из формирования query identity,
а не canonical output metadata (это сохраняет точное исходное spelling). При
omitted path в команду включается фактически выбранный root. Formatter всегда
заменяет старый cursor следующим. Identity/cache/TTL не изменены; другой limit
или scope по-прежнему отклоняется, pageSize можно менять.

Новая проверка исполняет именно извлечённую text-команду на каждой странице:
нестандартный limit без path, default limit control, explicit path с пробелом,
maxDepth=3, обе flags=true, limit=6; отдельно меняет только pageSize с 1 на 2.
Собранный набор не пересканируется (native opens/reads/closes и ignore reads
не меняются), нет дублей/потерь, final page сохраняет warning. Existing list
text test и built stdio harness также исполняют server-authored JSON вместо
ручного повторения args. Optional nextArgs не используется search tools;
их прежние formatter/page/009 warning regressions проходят.

Общая actual TIMEOUT suggestion теперь `Reduce scope or traversal depth.`.
Реальный wire deadline test проверяет этот текст и отсутствие maxResults/pageSize.
Deadline, traversal и cancellation механизм не менялись.

Целевые suites `list-bounded/tools/tool-selection`: 108 tests, 106 PASS,
0 FAIL, 2 Windows file-symlink permission skips; все 15 bounded tests PASS.
Финальный `npm run check` после доработки: 458 tests, 450 PASS, 0 FAIL, 8 skips
(3 POSIX-only, 5 Windows file-symlink permission), весь static stage PASS.
Built stdio full/read-only PASS с literal командами: 4×25 entries при limit=100,
resource совпадает, warning final page остаётся. Результаты записаны также
в добавлении Work record.
Tools/list schemas/descriptions не менялись; ceilings и counts прежние.
Новый live шаг — исполнять буквальную Next page command с нестандартным limit
до final page. Живой опыт остаётся невыполненным; push/поставка/приёмка у планирования.

## R3: Windows 8.3 TEMP — исправление test setup, 2026-10-09

Parent: `29fa8b7b2bc20371a0a7fd50e7c9e3b87798f2ef`. Planning сообщил три
Windows CI failures draft PR #9 (job 113910207955, run 37957080981): ignore
cancellation не отклоняет scan из-за short root, а no-follow и wire deadline
instrumentation сравнивает canonical opens с short fixture и получает `../..`.

Независимое воспроизведение до fix: новый synthetic parent с длинным именем
в ignored scratch текущего worktree, настоящий FSO ShortPath, каноническая
идентичность parent подтверждена. Только дочерний Node process получил TEMP/TMP
с коротким spelling. Три exact-name cases дали **0 PASS / 3 FAIL / 0 skips**:
Missing expected rejection, тот же warning `Bundle selectors must not contain
symlink or junction aliases`, два mismatch observed.opened. Actual wire
TIMEOUT происходил; провал касался путей instrumentation.

Это **test-only fix**. `fixture` теперь возвращает realpath source/scratch,
как public list после validateExistingDirectory; прямой walker больше не получает
8.3 root вместо его canonical contract. Instrumentation использует guarded
opendir `validPath` вместо requested spelling. Checks отмены, closes и всех
посещений сохранены. Новые skips не добавлены; tool deadline 5 s сохранён. PathGuard/no-follow и
код сервера не изменены: diff по `src/` к parent пуст.

Public alias roots не скрыты канонизацией test setup: existing alias test расширен
и вызывает настоящий MCP list отдельно с junction root и с полученным через
FSO настоящим Windows 8.3 source root. Он проверяет relative paths и применение
.gitignore к вложенному файлу (ignored log отсутствует, обычный файл видим). Оба controls PASS.
Таким образом для публичного list runtime defect на 8.3 root не подтверждён.

Воспроизводимые команды с tracked launcher, без зависимости от ignored probe:

```powershell
node --test --import tsx __tests__/list-bounded.test.ts
node scripts/list-check/windows-short-temp.mjs targeted
node scripts/list-check/windows-short-temp.mjs suite
npm run check
node scripts/list-check/windows-short-temp.mjs check
```

Launcher требует Windows и действительный short basename нового parent;
если 8.3 names недоступны, выдаёт error, а не фиктивное доказательство. Source,
scratch, parent и log fixtures синтетические. TEMP/TMP меняются только в child
environment; системная конфигурация, installed server, production и tunnel не
используются. После process exit собственный parent удаляется с проверкой
containment внутри workspace scratch. Дополнительный wrapper deadline 300 s
ограничивает весь repository check; tool timeout 5 s не менялся.

После исправления bounded suite: обычный TEMP **15 PASS / 0 FAIL / 0 skips**,
реальный 8.3 TEMP **15 PASS / 0 FAIL / 0 skips**. Ignore cancellation, native
handles, canonical validation, wire timeout и literal continuation прошли в обоих
профилях; public configured source aliases проверены в обоих. Полный обычный
check и полный actual 8.3 check — каждый **458 tests / 450 PASS / 0 FAIL /
8 прежних skips** (3 POSIX-only, 5 Windows file-symlink permission cases).
Build, production/test types, ESLint, Prettier, Knip PASS в обоих профилях.
Переносимое handoff evidence записано в добавлении Work record R3.
Runtime источники/версии/dependencies прежние. CI rerun, portable и integration
по-прежнему у planning; новый remote CI результат здесь не утверждается.
