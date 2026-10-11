# 011: bounded search — локальный протокол и live-матрица

Проверки задачи [011](../tasks/011-bounded-search.md), база
`7d58beac5a95cd2014d2e37f966c4074d6e5d5ec`, ветка `codex/011-bounded-search`.
Дата: 11.10.2026. Windows, Node v24.15.0, npm 11.12.1. Только synthetic fixtures;
установленный сервис, production roots, туннель и credentials не использовались.

## Независимое воспроизведение на базе

Через SDK in-memory MCP client/server созданы три root `.txt` и три ветви,
в каждой десять вложенных папок с `.txt`; все 33 файла содержат `triage-token`.
Обёртка настоящего `fs.promises.glob` считает raw Dirents до depth filtering.
Fixture canonicalized через realpath, поэтому Windows TEMP alias не искажает
счётчик глубины. Вызов обоих tools: explicit path, `pattern="**/*.txt"`,
`maxDepth=0`, `maxResults=1`, `includeIgnored=true`; text дополнительно получает
`searchPattern="triage-token"`.

| Tool        | Raw glob | Ниже depth 0 | Собрано | Первая страница | Literal Next page                     |
| ----------- | -------: | -----------: | ------: | --------------: | ------------------------------------- |
| find_files  |       33 |           30 |       3 |               1 | validation: отсутствует pattern       |
| search_text |       33 |           30 |       3 |               1 | validation: отсутствует searchPattern |

Повтор с исходными аргументами и cursor проходит в обоих случаях. Это собственный
baseline задачи, независимо от [triage](report-triage-2026-10-11.md). Полные
локальные логи/fixtures в Git не нужны: постоянная regression suite ниже
воспроизводит структуру и проверяет реальные opens/reads уже исправленного кода.

## Решение и доказательства

Read-only searches выбирают guarded ветку `globEntries` с walker из 010.
На filesystem entry выполняются source policy и Node glob matching; ignore rules
читаются только при открытии каталога. Pattern без globstar дополнительно
ограничивает достижимую глубину; фиксированный prefix отсекает посторонние ветви.
Общий limit прекращает iterator на N-м результате без N+1; handles закрываются
при return/abort. RE2/occurrence/Unicode и существующий per-file read budget
сохраняются. Явный file scope стал literal и не перечисляет соседние файлы.

Public input: limit/pageSize, без maxResults alias, maxDepth default/cap 100.
`stoppedReason=limit` и `truncated=true` при exact N консервативны. `_meta` и
JSON resource содержат effective limit и одни counters/stop state. Find resource
теперь object с results и metadata вместо bare array. Warning перед rows сохраняется
на всех частичных страницах; context не искажает позицию match-page trailer.
Next page содержит весь повторяемый query, включая effective path, и новый cursor.
pageSize исключён из identity; limit и остальные параметры включены.

| Проверяемая область                                           | Постоянная regression                                                                                                                                        |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| depth 0/1/2 × hidden × ignored × matched/unmatched, оба tools | opendir/read/close и ignore-read counters; ниже cutoff opens/ignore reads отсутствуют                                                                        |
| finite glob, exact path, fixed prefix                         | root-only `*.txt`, wanted-only patterns, unmatched suffix; без лишних opens                                                                                  |
| 0/1/N−1/N/N+1, pageSize < = > limit                           | N+1 read отсутствует; text следующий файл не открывает; conservative exact N                                                                                 |
| все страницы + resource                                       | totals/limit/truncated/reason одинаковы; warnings на последней странице; без дубликатов/потерь                                                               |
| literal continuation                                          | JSON извлекается из настоящего MCP text и вызывается целиком; single/multiple roots, nondefault options, explicit file, изменённый pageSize                  |
| cursor validation                                             | изменение каждого query option отклоняется; expiry проверяется контролируемым store clock; без cursor новый scan                                             |
| text semantics                                                | Unicode literal/RE2, две occurrences = одна строка, context, hidden explicit file с `[literal]` именем; binary/UTF-16/too-large skips из существующих suites |
| abort filtering/ignore/native open                            | event/counter gates для hidden/ignored/unmatched/no-match; закрыты directory/rule handles и поздние native file/directory handles                            |
| abort line loops / zero-match deadline                        | partial counters сохраняются; timeout виден даже при нуле; допускается explicit TIMEOUT/CANCELLED                                                            |
| без resourceStore                                             | та же limit/warning/metadata семантика, literal pagination и expiry                                                                                          |
| policy / Windows                                              | nested negation, default exclusions, sensitive paths, no-follow in/out-root junctions; canonical aliases, настоящий 8.3 root и отдельный 8.3 TEMP process    |
| принятый list / replace_text                                  | прежняя глубина list; optional query pruning не меняет list; replace оставлен на прежнем glob/контракте                                                      |

## Воспроизводимые команды

Из своего clean worktree выполнить `npm ci`, затем:

```powershell
node --test --import tsx __tests__/search-bounded.test.ts __tests__/core-fs.test.ts __tests__/list-bounded.test.ts __tests__/tool-selection.test.ts __tests__/tools.test.ts
node scripts/search-check/windows-short-temp.mjs
npm run check
```

8.3 launcher создаёт собственный parent под `.tmp/`, получает настоящий ShortPath,
сверяет basename `~N` и realpath и задаёт TEMP/TMP только дочернему process.
Запускает обе bounded suites; после завершения проверяет resolved target и удаляет
свой synthetic parent. Long spelling или junction вместо 8.3 не считаются evidence.
На другом volume возможен явный skip 8.3-root test; launcher тогда сообщает error,
а не PASS. File symlinks требуют соответствующих Windows permissions.

Sandbox `tsx` до загрузки tests сообщил `uv_os_get_passwd ENOMEM`; проверки
выполнялись разрешённым обычным пользовательским процессом, без изменения tests.

| Проверка                      | Итог                                                |
| ----------------------------- | --------------------------------------------------- |
| baseline synthetic MCP        | PASS: оба depth/continuation дефекта воспроизведены |
| targeted suites               | PASS: 162 tests, 156 pass, 0 fail, 6 skips          |
| actual 8.3 TEMP search + list | PASS: 30 tests, 30 pass, 0 fail, 0 skips            |
| npm run check                 | PASS: static + 473 tests, 465 pass, 0 fail, 8 skips |

Предварительные targeted runs выявляли устаревшие assertions старого API и
ошибки нового test oracle (unsupported pipe в pattern, text rules без token).
Они исправлены; green повтор подтверждает исправленный тест, не скрывает runtime
flake. Статический check сначала обнаружил ESLint type/interface ошибку; исправлена.
Известный job terminal/cleanup follow-up не изменялся.
Он не воспроизвёлся в первом полном test run (465/0/8); повтор полного check
потребовался после самопроверки prefix pruning для directory extglob, а не для
маскировки failure. Последний runtime diff проверен targeted 156/0/6.
В full skips: POSIX FIFO, inode/mode и 0222 target (3), Windows file symlinks без
нужного permission (5). Junction и actual 8.3 tests прошли без skips.
Wire surface: full/read-only 26932/16852 chars, 19/13 tools. Budget увеличен
явно до 27200/17100 за два отдельных collect/page параметра и accurate depth /
continuation descriptions; assertions не отключались.

## Короткая целевая live-матрица

Это следующий опыт планирования после review; локальный SDK не доказывает
поведение ChatGPT. Live в этой задаче не выполнялся.

| Сценарий в целевом клиенте                                              | Ожидаемое                                                                    | Статус  |
| ----------------------------------------------------------------------- | ---------------------------------------------------------------------------- | ------- |
| root-only find_files и search_text, depth 0, limit 3/pageSize 1         | максимум 3 результата, warning limit, три страницы собранного набора         | NOT RUN |
| literal Next page при multiple roots                                    | копирование JSON без восстановления аргументов успешно, scope сохраняется    | NOT RUN |
| nondefault regex/case/context/hidden/ignored/depth, изменённый pageSize | те же matches, context не меняет page-position и limit                       | NOT RUN |
| explicit hidden file, filename с glob symbols                           | ровно названный файл; pattern/filter не исключают его                        | NOT RUN |
| limit достигнут / последняя страница / resource                         | warning остаётся, counters и limit совпадают, continuation обхода не обещана | NOT RUN |
| cursor mismatch/expiry и устаревший maxResults                          | понятная ошибка; новый scan без cursor; hint limit/pageSize                  | NOT RUN |
| sparse pattern / deadline / cancellation                                | explicit error либо видимый timeout partial, включая ноль                    | NOT RUN |

## Существенные границы

Limit считает найденные файлы/строки, не OS calls или scanned files. Редкий
pattern может долго искать в выбранном scope. Неотменяемый OS I/O завершается
естественно; cooperative checks не обещают жёсткий wall-clock deadline.
Сортируется собранный subset; дерево и результаты не являются atomic snapshot.
Best-effort ignore reads сохраняют log warning при не-abort ошибке; traversal
errors не превращаются в молчаливый полный success. Hidden pattern expansion
и glob syntax сохранены; полноценный dot-aware glob redesign не выполнялся.
TTL/byte budgets, jobs, snapshot/bundle, установленная поставка и live относятся
к отдельным задачам/планированию. Production/CI Linux результаты здесь не заявлены.
