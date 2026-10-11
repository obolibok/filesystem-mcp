# 011: ограниченный поиск и исполняемая пагинация

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятая 010 и [triage](../testing/report-triage-2026-10-11.md).
Пользователь разрешил планирование и запуск 11.10.2026.
Исполнитель: GPT-6.1-Sol / Extra High, отдельный managed worktree,
ветка `codex/011-bounded-search`. Checkpoint с карточкой передаёт планирование.

## Зачем и контекст

`find_files` и `search_text` фильтруют maxDepth после получения raw glob matches.
Поиск только в root поэтому всё равно перечисляет глубокие подкаталоги; во время
такой фильтрации отмена может долго не наблюдаться. Маленький maxResults уменьшает
страницу, но сбор остаётся до 10000 результатов. Подсказка Next page содержит
только cursor и при буквальном выполнении не проходит обязательные параметры.

См. [triage и synthetic evidence](../testing/report-triage-2026-10-11.md),
[контракт list 010](010-bounded-list.md), [архитектуру](../reference/architecture.md),
`src/core/{glob,search,cursor,fmt}.ts`, `src/tools/{find-files,search-text}.ts`.
Нужная база и воспроизведение находятся в Git; Downloads и ignored probe не нужны.

## Решение о публичном контракте

Продолжить принятый в 010 чистый контракт пилота без legacy alias.

| Поле       | find_files                                                                             | search_text                                                          |
| ---------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| limit      | Общий максимум найденных файлов, default/cap 10000, диапазон 1..10000                  | Общий максимум совпавших строк, default/cap 10000, диапазон 1..10000 |
| pageSize   | Размер страницы, default 100, диапазон 1..10000                                        | Размер страницы, default 500, диапазон 1..10000                      |
| maxResults | Удалить из публичного input; не принимать молча                                        | Удалить из публичного input; не принимать молча                      |
| maxDepth   | 0 = файлы непосредственно в base; 1 = также один уровень подкаталогов; диапазон 0..100 | Те же правила при directory scope                                    |

Пропущенный maxDepth соответствует существующему фактическому пределу 100;
схема/описание должны говорить об этом явно, без неверного обещания unlimited.
Семантику глубины list (1 = top-level) не менять. Defaults includeHidden и
includeIgnored остаются false. Explicit-file search_text сохраняет своё поведение:
один заданный файл, без отбора по directory glob/hidden/ignored.

limit=30, pageSize=100 выдаёт не больше 30 результатов; limit=100, pageSize=25 —
до четырёх страниц. Для search_text одна строка с несколькими вхождениями
считается один раз, matchCount и context не расходуют дополнительный limit.
limit ограничивает найденные результаты, а не число просмотренных файлов или
OS calls. Отдельный maxFilesScanned/count-only режим в scope не входит.
Пустой/редкий pattern может требовать много работы; её ограничивают depth и
кооперативная отмена. Для полного дискового индекса остаётся snapshot.

## Scope и владение

- Инструменты find_files/search_text, необходимые guarded traversal/glob/ignore
  primitives, search engine, точечные cursor/fmt/schema changes.
- Public descriptions, server instructions и error recovery hints, README,
  architecture и текущие runnable examples; исторические протоколы не переписывать.
- Targeted regressions, `docs/testing/011-bounded-search.md` с локальным протоколом
  и короткой live-матрицей, Work record этой карточки.
- Выбор реализации за исполнителем: reuse/extraction walker либо доработка glob
  допустимы при сохранении поддерживаемой glob syntax и source policy.

PathGuard/GuardedFileSystem, allow/deny/sensitive boundaries, no-follow,
Windows aliases, hidden/default exclusions и nested .gitignore/negation сохранить.
Не добавлять прямой незащищённый fs доступ в tool handlers. При изменении общего
primitive проверить все его потребители, включая принятый list.

Задача 012 параллельно владеет только своим benchmark harness/отчётом/карточкой;
не менять эти файлы. Центральной доской владеет планирование. Snapshot/bundle/jobs,
TTL/byte quota stores, транспорт, OAuth, версии/dependencies, Ctrl+C/Sleep и
известный job terminal/cleanup follow-up вне scope. Установленный сервис,
production roots, туннель и ключи не трогать.

## Требуемое поведение

1. maxDepth ограничивает реальное перечисление каталогов, включая предварительное
   discovery .gitignore. При 0 не открывать дочерние каталоги для их содержимого;
   при 1 не спускаться на следующий уровень. Stat/canonical boundary validation
   сами по себе не считать descent. Проверять hidden/ignored режимы и сложные glob.
2. На N-м допустимом результате остановить дальнейший сбор и закрыть обход;
   не сканировать хвост ради total/sort или доказательства N+1. Сортировать
   собранный набор, не обещать глобально первые N по всему дереву.
   Для text search чтение текущего файла остаётся в существующем per-file budget;
   context вокруг последнего match допустим, но следующий файл не открывать.
3. Отмена/deadline проверяются в циклах обхода и фильтрации, включая отсутствие
   совпадений, hidden/ignored entries, discovery/read ignore rules. Закрывать handles
   и корректно завершать поздно открывшийся handle. Не обещать принудительное
   прерывание неотменяемого OS I/O.
4. Успешный частичный результат обязан иметь stoppedReason и видимое предупреждение;
   допустим существующий explicit TIMEOUT/CANCELLED error path. Нельзя молча выдавать
   полный успех после пропущенной отмены, включая ноль собранных совпадений.
5. Публичный stoppedReason для общего лимита — `limit`; сохранить явный `timeout`
   для разрешённой частичной выдачи. Effective limit и признак неполноты доступны
   в response metadata и JSON resource, если он есть. При exact N можно
   консервативно сообщать limit reached, не делать look-ahead.
6. Warning перед rows на каждой странице объясняет действующий limit, смысл totals
   и отсутствие scan continuation. Последняя страница неполного набора сохраняет
   warning; nextCursor означает оставшиеся страницы, а не оставшийся обход.
   Для tools без resourceStore смысл ответа тот же. Text/_meta/resource согласованы;
   сохранить принятую политику без лишнего дублирования structuredContent.
7. Cursor identity включает effective path, pattern/searchPattern, flags, maxDepth,
   sort/context/regex/case и limit. pageSize можно менять между страницами. Повтор
   без cursor не обещает reuse. TTL и правила хранения в этой задаче не менять.
8. Next page содержит полный JSON повторяемого запроса с новым cursor. Его буквальный
   вызов работает для обоих инструментов, одного/нескольких roots, explicit file
   у search_text, non-default flags/depth/context/regex/limit/pageSize.
9. Удаление maxResults отражено в tools/list, instructions, актуальных примерах и
   deprecated FS_MAX_INLINE_MATCHES warning. Старому полю не назначать новый смысл;
   validation error должен давать понятное указание limit/pageSize. Внутренние
   имена можно сохранить, если они не искажают public contract или других tools.

## Воспроизведение

Создать 3 root .txt файла и 3 дочерние папки, в каждой 10 вложенных папок с одним
.txt. Во всех файлах строка triage-token. Вызвать оба поиска с explicit path,
pattern **/*.txt, maxDepth 0, maxResults 1, includeIgnored true; для search_text
добавить searchPattern triage-token. Baseline: raw glob выдаёт 33 совпадения,
из них 30 глубже scope; всего найдено 3, первая страница 1. Literal Next page
отклоняется из-за отсутствующего pattern/searchPattern. Повтор с исходными
аргументами и cursor работает. После изменения использовать limit/pageSize.

Реальное посещение подтвердить инструментированием opens/enumeration/ignore reads,
не только итоговым массивом. Искусственная задержка глубоких entries в triage
служила диагностикой отмены, не benchmark производительности диска.

## Acceptance

- [x] Воспроизведены оба дефекта на исходной базе, сохранены обезличенные выводы.
- [x] Реальный depth cutoff доказан для 0/1/2, hidden и обоих includeIgnored;
      глубокие .gitignore и unmatched glob не вызывают лишнюю рекурсию.
- [x] Общий limit прекращает сбор; 0/1/N-1/N/N+1 фактических результатов,
      limit меньше/равно/больше pageSize, validation bounds и exact N проверены.
- [x] Text limit считает строки; несколько occurrences/контекст/explicit-file,
      regex/Unicode и skipped binary/too-large/encoding semantics сохранены.
- [x] Отмена на filtered/no-match/ignore traversal и позднем open закрывает handles;
      tests используют события/счётчики, а не только хрупкий wall-clock threshold.
- [x] Literal Next page из реального MCP ответа исполняется без восстановления
      параметров, в том числе multiple roots и изменённый pageSize; mismatch и
      expiry cursor по-прежнему отклоняются. Дубликатов/потерь страниц нет.
- [x] Видимые warnings, counters, limit, stoppedReason и resource согласованы
      на всех страницах, с/без resourceStore; полнота не завышена.
- [x] Wire schemas публикуют limit/pageSize и точный default depth; старый maxResults
      получает понятную ошибку. Defaults/ignore/glob/path security сохранены.
- [x] Принятый list и остальные потребители изменённых helpers не регрессировали.
      Windows canonical/8.3/junction случаи проверены, реальные skips объяснены.
- [x] Targeted tests и npm run check PASS; среда, числа и skips записаны. Известный
      terminal/cleanup flake не маскировать повтором и не чинить вне scope.
- [x] Обновлены актуальные описания/reference, protocol/live matrix и Work record;
      изменения закоммичены локально, итог ready for review передан планированию.

## Launch prompt

```text
Реализуй docs/tasks/011-bounded-search.md. Пользователь разрешил эту задачу.
Используй GPT-6.1-Sol / Extra High и созданный приложением worktree. Прочитай
AGENTS.md, docs/README.md, brief/status, workflow, Windows runbook и карточку.
Проверь checkpoint и заведи codex/011-bounded-search в своём worktree, если
ветка ещё не создана. Воспроизведи, исправь, выполни acceptance и npm run check.
Закреплённый карточкой контракт уже согласован; routine fixes не требуют
повторного разрешения. Заполни Work record и сделай локальные commits.
Центральную доску/файлы 012 не меняй. Push, PR, merge, выпуск сборки и запуск
установленного сервиса оставь планированию. Заверши handoff с фактическими
base/head/branch, проверками и ready for review; review не подменяет самопроверку.
```

## Work record

Реализация завершена 11.10.2026; состояние: **ready for review**.
Проверки и короткая live-матрица: [протокол 011](../testing/011-bounded-search.md).

- Base: `7d58beac5a95cd2014d2e37f966c4074d6e5d5ec`; приложение создало чистый
  detached worktree непосредственно на checkpoint. Карточка/triage присутствовали.
  Создана только ветка `codex/011-bounded-search` в этом worktree; чужие checkouts
  и ветки не переключались. Git shared metadata потребовала разрешённого локального
  доступа; использован точечный safe.directory, без глобальных изменений.
- Baseline: самостоятельно воспроизведены оба поиска через настоящий in-memory MCP
  на 33 synthetic файлах. Raw glob 33, ниже maxDepth=0 — 30, собранный набор 3,
  страница 1; literal Next page отклонён по pattern/searchPattern, repeat с полным
  query проходит. Обезличенные выводы закреплены в протоколе.
- Изменения: guarded bounded ветка globEntries использует walker 010. Реальные
  depth/ignore cutoff, finite-pattern depth и fixed-prefix pruning, отмена на
  filtering/ignore/line loops, закрытие поздних handles. Limit останавливает на N,
  без N+1; text считает строки, сохраняет occurrences/context/RE2/skip semantics.
  pageSize независим от limit. Старый maxResults исключён без alias; validation
  объясняет оба новых поля. Next page повторяет полный запрос и effective path.
- Metadata: limit/truncated/stoppedReason=limit|timeout и counters согласованы
  между страницами и resources; warning перед rows сохраняется до последней
  страницы. Search context больше не искажает страницу через число rendered rows.
  Find JSON resource теперь объект с results и metadata, чтобы не терять limit и
  stop state. Сохраняется политика text + _meta, без structuredContent duplication.
- Внутренние решения в acceptance: original fs.glob ветка остаётся у replace_text;
  его optional maxDepth и maxResults/maxFiles контракт сохранены. List depth с 1
  не менялся; общий walker получил только optional callbacks. Explicit-file text
  scope стал literal (включая `[literal]` в имени) и не открывает parent/siblings.
  Это устранение glob reinterpretation в пределах принятого «ровно один файл».
  Runtime dependencies/версии/stores/TTL/ignore defaults не менялись.
- Актуализированы README, architecture, server instructions, tool/input/output
  descriptions, FS_MAX_INLINE_MATCHES CLI/runtime warning, protocol/live matrix.
  Wire payload 26932/16852 chars (full/read-only); два separate collect/page fields
  и точный depth требуют +1044 chars к 010. Budget явно обновлён до 27200/17100;
  schema/surface assertions сохранены.
- Проверки: Windows, Node v24.15.0 / npm 11.12.1, `npm ci` PASS. Sandbox tsx
  остановился до tests на uv_os_get_passwd ENOMEM; разрешённый обычный процесс
  устранил ограничение среды. Targeted пять suites: 162 tests, **156 pass / 0 fail /
  6 skips**. Настоящий 8.3 TEMP launcher: search + list, **30 / 0 / 0**, включая
  canonical roots, junctions и настоящий 8.3 configured root. `npm run check`:
  все static стадии PASS; **465 pass / 0 fail / 8 skips**, 473 tests / 69 suites.
  Skips — 3 POSIX-only и 5 file-symlink permissions; полный список в протоколе.
  Первый полный test run также PASS; финальный повтор обусловлен дополнительной
  самопроверкой directory extglob pruning, известный cleanup flake не маскировался.
- Acceptance: воспроизведение, реальная глубина/лимит, literal pagination,
  warnings/resource/counters, cancellation/late handles, wire validation и policy,
  зависимые list/replace helpers и локальные проверки выполнены. Synthetic
  fixtures, event/counter gates и настоящие Windows aliases подтверждают поведение;
  production inventory/абсолютные personal paths/archives в Git не включались.
  Целевая live-матрица сохранена **NOT RUN** для планирования; CI Linux не заявлен.
- Ограничения: limit — matches, не просмотренные файлы/OS calls; редкий pattern
  может быть дорогим. Exact N консервативно partial; sort только собранного subset.
  Native I/O не прерывается принудительно. Прежнее hidden pattern expansion и
  best-effort ignore-read/log policy сохранены; новый glob redesign вне scope.
  Job terminal/cleanup follow-up остаётся прежним. Центральная доска, файлы 012,
  установленный сервис, credentials, production roots, portable сборка, push/PR/
  merge/release не затрагивались. Изменения сохранены локальными commits; фактический
  HEAD передаётся в handoff, без self-SHA внутри этого record.
