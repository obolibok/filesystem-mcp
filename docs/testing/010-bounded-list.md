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

Локально проверено:

- Bounded acceptance suite: 14 PASS, 0 FAIL, 0 skips.
- Existing targeted regression suites: 187 PASS, 0 FAIL, 6 skips.
- Actual stdio full/read-only: PASS; default page 1000, total collected 1008;
  limit=100/pageSize=25 — 4 × 25, 100 unique entries, resource entries идентичны,
  последний warning остаётся, maxEntries отклоняется с его именем в validation error.
- Tools/list: full 19 tools / 25888 chars; read-only 13 tools / 15808 chars.
  После удаления повторов в depth/pageSize descriptions прирост к 009 — 156 chars
  в каждом профиле. Existing ceilings 26900/15900 сохранены, count не менялся.
- Финальный полный check: 457 tests, 449 PASS, 0 FAIL, 8 skips. Три POSIX-only
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
   этот набор. Дойти до последней страницы: cursor отсутствует, warning остаётся.
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
