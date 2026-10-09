# 010: ограниченный обход list и понятные лимиты результата

Статус и назначение: [центральная доска](../project/status.md).
Зависимость: принятая 009. Исходный main: `e8de76846eda44c1db8a27aa4c4fcb6fce1b54d7`.
Пользователь разрешил исправление, постановку и запуск 09.10.2026.
Исполнитель: GPT-6.1-Sol / Extra High, отдельный managed worktree,
ветка `codex/010-bounded-list`. Launch checkpoint с карточкой передаёт планирование.

## Зачем и доказательства

list с maxDepth=1 обходит вложенное дерево и только затем отбрасывает глубокие
результаты. Даже небольшой верхний уровень большого диска может дать TIMEOUT.
Уменьшение maxEntries не помогает: сейчас это page size, а не предел сбора.
Пользователь просит ограничивать количество возвращаемых объектов и устранить
путаницу между общим лимитом и размером страницы.

[Независимое воспроизведение](../testing/010-list-depth-triage-2026-10-09.md):
для трёх верхних папок прочитано 93 raw glob matches; искусственное замедление
глубоких записей воспроизводит TIMEOUT и продолжение обработки после deadline.
Скриншот, личные пути и ignored probe новому checkout не нужны.

## Решение о публичном контракте

Планирование уточнило первоначальное предложение о совместимости после вопроса
пользователя. Для этого пилота вводится чистый контракт list без alias maxEntries.
Не менять старому имени смысл и не добавлять maxPages: это означало бы число страниц.

| Поле       | Смысл и default                                                                                                                      |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| maxDepth   | Глубина фактического обхода; 1 — только содержимое указанной папки                                                                   |
| limit      | Максимум собранных доступных записей во всём результате, на всех страницах вместе; default MAX_LIST_ENTRIES=20000, диапазон 1..20000 |
| pageSize   | Максимум записей в одном ответе; default DEFAULT_TREE_ENTRIES=1000, диапазон 1..20000                                                |
| maxEntries | Удалить из актуальной схемы list; старые вызовы не принимать молча                                                                   |

Запись list — файл, каталог, symlink или other, прошедшие действующую source
policy. limit=100 означает не более 100 таких записей суммарно, а не 100 файлов
плюс неограниченное число папок. Режим files-only/count-only в задачу не входит.
Число просмотренных, но исключённых policy записей может быть больше limit;
limit не обещает предел числа OS calls, который дополнительно сдерживают depth
и deadline. Для полного индекса остаётся snapshot.

Примеры: limit=100, pageSize=25 собирает максимум 100 записей и выдаёт до четырёх
страниц по 25; limit=30, pageSize=100 выдаёт максимум 30; pageSize сам по себе
не останавливает сбор. Defaults сохраняют прежний размер страницы/хранимого
набора, но общий cap теперь действительно останавливает обход.

## Scope и владение

- src/tools/list.ts и необходимая общая traversal/glob/ignore логика в src/core/.
  Можно выделить ограниченный walker, если это проще и безопаснее изменения glob;
  обосновать выбор в Work record. Не добавлять незащищённый доступ в tool handler.
- Общие cursor/page/fmt изменения — только нужные для лимита, честной неполноты
  и сохранения пагинации. Соседние find_files/search_text контракты не переименовывать.
- Public list description, argument descriptions, server instructions/help,
  README/reference и текущие runnable примеры; исторические протоколы не переписывать.
- Meaningful regressions, локальный протокол и короткий план живой проверки.

Сохранять PathGuard/GuardedFileSystem, sensitive и allow/deny, boundaries,
Windows aliases/junction/symlink поведение, hidden/default exclusions и nested
.gitignore semantics. Изменение общего primitive требует регрессий его других
потребителей. Snapshot/bundle pipeline, reuse/freshness/TTL, транспорт, OAuth,
multi-root job, версии/dependencies, Ctrl+C/Sleep и flaky PowerShell helper — вне scope.
Установленный сервер, production roots, ключи и туннель не трогать.

## Поведение обхода и отмены

1. При maxDepth=1 не открывать дочерние каталоги ради перечисления их содержимого.
   Каталоги на граничном уровне видны в результате, но внутрь обход не идёт.
   Проверки доступности/типа и canonical path допустимы; full descendant scan нет.
2. Ограничение глубины и остановка по limit работают до дорогой лишней рекурсии.
   includeHidden=true не должен запускать дополнительные неограниченные обходы.
   При includeIgnored=false читать только релевантные .gitignore посещаемых
   каталогов; не собирать все ignore-файлы дерева заранее.
3. После N допустимых записей остановить сбор, освободить iterator/handles и не
   считать всё дерево ради точного total. Не читать/сортировать все descendants
   заранее ради первых N. Допустимо сортировать уже собранный набор; не обещать,
   что это первые N элементов глобальной сортировки всего дерева.
4. Отмена/deadline проверяется при перечислении, в том числе на отфильтрованных
   элементах и при чтении ignore rules. Не запускать новую работу после отмены;
   дать завершиться уже начатой недоступной для отмены OS operation, затем выйти.
   Не обещать принудительное прерывание зависшего OS I/O. TIMEOUT/CANCELLED не
   превращать в успешный полный результат; увеличить timeout вместо fix нельзя.

## Пагинация, счётчики и видимость для модели

- Cursor перелистывает только зафиксированный собранный набор. Не возобновляет
  обход после limit и не создаёт новые фоновые сканирования на последней странице.
- Эффективный limit включить в query identity; cursor с другим limit/path/depth/
  flags отклоняется. pageSize можно менять между страницами без смены набора.
- Сохранить entries/types/relative paths, counters, resource delivery и TTL,
  поправив явно неверные описания. totalEntries/totalFiles/totalDirectories
  на остановленном сборе описывают собранные записи, не точный итог дерева.
- Добавить машинно читаемые признаки остановки сбора (например truncated и
  stoppedReason=limit), отличимые от наличия ещё одной страницы. Имена и точный
  минимальный набор полей закрепить в Work record. Не делать complete=true,
  если обход прекращён без установленного EOF. Можно консервативно сообщить
  limit reached при точном N, не обходя остаток ради доказательства полноты.
- Предупреждение о лимите/неподтверждённой полноте перед rows на каждой странице,
  включая последнюю. Оно должно показывать действующий limit, что totals относятся
  к собранному набору и cursor не продолжит scan. Empty/full/partial не путать.
- Resource содержит тот же bounded set и признаки остановки; не называть его
  полным деревом при неполном обходе. Проверить путь с и без resourceStore.
- Модель читает text и tools/list. Поля только в _meta/output-schema или README
  не заменяют видимую подсказку. У list с text metadata остаются в _meta согласно
  общей политике; не добавлять дублирующий structuredContent без причины.

## Проверки и acceptance

- [x] Synthetic instrumentation доказывает отсутствие descent за maxDepth, включая
      1/2, hidden папки и includeIgnored=false с глубокими .gitignore. Проверять
      реальные посещения/открытия, не только итоговый отфильтрованный массив.
- [x] На широком/глубоком дереве limit прекращает traversal, ограничивает весь
      набор до N, а pageSize меняет только страницу. Проверены 0/1/N-1/N/N+1
      найденных записей, limit меньше/равно/больше pageSize и validation bounds.
- [x] Cap result не объявляется полным; counters/text/_meta/resource согласованы.
      Pages без дублей/потерь; последняя страница без cursor сохраняет warning.
      Cursor query mismatch/expiry и изменение pageSize работают корректно.
- [x] При delayed iterator и отмене завершается работа и закрываются handles;
      вложенные отфильтрованные элементы и ignore discovery не прячут отмену.
      Стабильные tests по событиям/счётчикам; wall-clock только с разумным запасом.
- [x] No-follow/allowed boundaries/sensitive paths, Windows canonical aliases,
      hidden/.gitignore/default exclusions сохранены. Соседние find_files и
      search_text проверены при затрагивании общей логики; 009 warnings не сломаны.
- [x] Wire tools/list публикует limit/pageSize, не maxEntries; старое имя даёт
      понятную validation error. Actual request/response и defaults проверены.
      Описания однозначно разделяют collect cap, page size и число страниц.
- [x] Полный npm run check PASS; environment/skips записаны. Actual full/read-only
      tools/list размеры измерены; сначала сократить дублирование. Необходимое
      увеличение budget обосновать измерениями, не менять count без нового tool.
- [x] Reference/runnable examples и Work record обновлены. Протокол live включает
      обновление каталога tools в подключении, быстрый верхний уровень большого
      root, limit/pageSize и последнюю страницу; live ещё не объявлять выполненным.

## Launch prompt

Реализуй docs/tasks/010-bounded-list.md. Пользователь разрешил исправление и запуск.
Работай на GPT-6.1-Sol / Extra High в отдельном managed worktree от опубликованного
checkpoint с карточкой. Прочитай AGENTS.md, docs/README.md, brief, workflow,
карточку и triage. Ветка codex/010-bounded-list только в своём checkout.
Воспроизведи дефект, исправь depth/limit/cancellation/ignore traversal и внедри
чистые limit + pageSize вместо maxEntries без compatibility alias. Проверь
соседние контракты, выполни acceptance/full check, обнови документацию и Work record,
сделай локальный commit и передай ready for review с SHA, результатами и рисками.
Центральную доску, push/PR/merge, установленный комплект и live ведёт планирование.

## Work record

2026-10-09 — **ready for review**. Центральную доску исполнитель не менял;
приёмка/интеграция и live остаются у планирования.

- Base: `151dfa1feefcd74b80c69e939f3e8b5ec30ee7cb`, точный launch checkpoint,
  карточка присутствовала; исходный diff пуст. Managed worktree приложения,
  собственная ветка `codex/010-bounded-list`. Итоговый локальный commit SHA
  передаётся в handoff после создания, собственный SHA в commit не записывается.
- Воспроизведение: actual in-memory MCP, synthetic 3×10×2; ради 3 верхних папок
  glob выдал 93 raw matches из 34 parent directories, 90 глубже запроса. С 15 ms
  на глубокий yield — TIMEOUT через 1627 ms, 37 matches после 1000 ms. Подробное
  переносимое evidence: [локальные проверки и live](../testing/010-bounded-list.md).
- Traversal: отдельный streaming `core/list-walk.ts` выбран вместо изменения
  общего glob matching/hidden expansion соседних tools. Используются guarded
  opendir/Dir.read, depth pruning до descent, lazy guarded rules только открытых
  каталогов; cap закрывает iterator до рекурсии после N-го yield. Общий ignore
  matcher/default exclusions вынесен в `core/source-ignore.ts`; семантика glob
  consumers прежняя. В PathGuard validation добавлен optional signal, чтобы
  не начинать stat/ancestor probing после отмены в realpath; guarded opendir
  закрывает late OS handle. No-follow checks, source policy и canonical roots
  сохранены; pipeline/transport/dependencies/версии не менялись.
- Контракт: `limit` default/cap=20000, `pageSize` default=1000/cap=20000,
  оба 1..20000. `maxEntries` удалён и явно отклоняется strict validation;
  `maxPages` отсутствует. Limit считает все доступные entry types вместе.
  Cursor identity включает effective limit + path/depth/flags, pageSize можно
  менять. Cursors только листают собранный набор; TTL/resource правила прежние.
- Неполнота: `limit`, `truncated` (boolean всегда), optional
  `stoppedReason='limit'` в каждой `_meta` и JSON resource. Warning перед rows
  на каждой странице, включая последнюю без cursor, называет limit, смысл totals
  и отсутствие scan continuation. Exact N консервативно truncated без look-ahead;
  `complete` не добавлен. `totalEntries/totalDirectories` — collected counters,
  `totalFiles` сохраняет прежние non-directory entries (symlink/other включены).
  Без resourceStore тот же результат; текст поздних nested pages показывает
  relative parent, даже если сам parent был на прошлой странице.
- Checks: Windows, Node v24.15.0 / npm 11.12.1, `npm ci` внутри своего worktree.
  Shell sandbox и Node REPL не запускались из-за local setup refresh/runtime
  errors; разрешённый local shell работал. Форматировались только touched files,
  repository-wide fix не запускался. Финальный `npm run check` **PASS**:
  build, production/test types, ESLint, Prettier, Knip + **457 tests / 449 PASS /
  0 FAIL / 8 skips**. Предыдущий полный прогон до дополнительной guard cancellation
  regression: 448 PASS/0 FAIL/8 skips; это не финальное evidence.
- Skips полного прогона: 3 POSIX-only cases (FIFO, inode/mode, 0222 append target)
  и 5 недоступных Windows file-symlink cases (3 append variants, sensitive-target
  PathGuard validation, stat own-link). Эти ветки не объявляются проверенными.
  Настоящие Windows junction escape/no-follow и configured-root alias в 010 PASS.
- Bounded acceptance suite: **14 PASS / 0 FAIL / 0 skips**. Instrumentation
  настоящих opens/reads/closes: depth 1/2 и hidden/ignore matrix, cap/EOF
  0/1/N-1/N/N+1, wide/deep cap stop, cache/no-rescan, warning/resource/no-store,
  query mismatch/expiry, validation/defaults, delayed filtered cancellation,
  ignore cancellation, late opendir и отмена во время canonical validation.
  Реальный wire deadline оставлен 5 s; TIMEOUT закрывает iterator (1 read/1 close)
  и не возвращает success metadata. Уже отменённый walk начинает 0 operations.
- Existing targeted suites `tools/core-fs/security/tool-selection/stdio/http-transport`:
  **187 PASS / 0 FAIL / 6 skips** до дополнительной guard regression; финальный
  полный check повторно включает их, snapshot/bundle и все остальные suites.
- Actual built stdio harness `node scripts/list-check/local-mcp-check.mjs`
  **PASS** в full и read-only после финальных runtime правок. Defaults дают
  page=1000/total=1008; limit=100/pageSize=25 — 4×25, 100 unique entries, resource
  тот же bounded set, warning последней страницы остаётся, old name отклоняется.
- Actual tools/list: **19/13 tools, 25888/15808 chars** (full/read-only).
  Убраны повторные depth/default/page descriptions; прирост к 009 — 156 chars.
  Existing budgets **26900/15900** и tool counts сохранены, budget не увеличен.
  Server instructions/help, README, architecture и runnable examples обновлены.
- Acceptance локально выполнен; живой опыт **не выполнен**. Короткий live-протокол
  в [010 testing](../testing/010-bounded-list.md): обновить connection/tool catalog,
  maxDepth=1 на большом явном root с обеими ignore flags, limit/pageSize,
  последняя страница/resource, changed pageSize и mismatch, LLM distinction.
- Ограничения/риски: сортируется только collected set, не глобально первые N;
  exact N не доказывает EOF. Excluded entries/OS read-ahead могут превышать limit,
  это не OS-call budget. Отмена ждёт начатый неотменяемый OS I/O, зависший OS call
  принудительно не прерывается. Source не atomic; прежний TOCTOU window guard
  сохраняется. Ignore read failures остаются best-effort с log warning;
  symlink/sensitive rules не читаются. Windows SMB, POSIX skips и live требуют
  отдельной приёмки в соответствующей среде. Installed server, roots, keys,
  tunnel, центральная доска, push/PR/merge/release не затронуты.

### Доработка после review R1/R2 — ready for repeat review, 2026-10-09

- Parent доработки: `7fabbe0bf4e88eab1aa30181d9569f23b9ccacb3`; та же ветка
  `codex/010-bounded-list`, clean tracked tree перед началом. Review прочитан
  через `git show 4c9ce2ebf51d3cfaf9e348ac18d906b7dc757ef9:docs/testing/010-review-r1-2026-10-09.md`;
  центральная доска и planning checkout не менялись. Новый локальный SHA
  передаётся в handoff, собственный SHA в commit не записывается.
- R1 воспроизведён новой regression на предыдущем head: actual command из text
  для list с limit=2/pageSize=1 без path приводит к INVALID_INPUT. Исправление:
  list передаёт parsed scope/limit/pageSize и effective query path в optional
  nextArgs общего pageTrailer. Formatter заменяет любой предыдущий cursor новым.
  Literal Next page JSON теперь исполним, включая continuation после смены
  pageSize. Query identity/cache/TTL не ослаблены; mismatching limit/scope
  по-прежнему отклоняются. Для omitted path команда фиксирует выбранный root.
- R2: реальный wire TIMEOUT до fix подтверждал совет снижать несуществующий
  maxResults. Общая suggestion теперь `Reduce scope or traversal depth.`.
  Existing real-deadline regression проверяет точный совет и отсутствие
  maxResults/pageSize. Deadline, walker и отмена не менялись.
- Новая meaningful regression извлекает и исполняет JSON на каждой странице:
  nondefault limit с omitted path, default-limit control, explicit path с
  пробелом, depth=3, обе flags=true, limit=6; отдельно меняет только pageSize
  с 1 на 2. Opens/reads/closes/ignore reads после первого сбора не увеличиваются,
  pages продвигаются без дублей/потерь, warning есть на final page. Existing
  TC-FUNC-075 и runnable built stdio также исполняют literal команды. Соседние
  find_files/search_text не передают nextArgs и сохраняют прежний text/контракт;
  их pagination и 009 warning regressions PASS.
- Проверки: `node --test --import tsx __tests__/list-bounded.test.ts __tests__/tools.test.ts __tests__/tool-selection.test.ts`
  — **108 tests / 106 PASS / 0 FAIL / 2 permission skips**. Все 15 bounded
  acceptance tests PASS, skips в двух прежних Windows file-symlink tools cases.
  `npm run check` после доработки — **458 tests / 450 PASS / 0 FAIL / 8 skips**,
  build, production/test types, ESLint, Prettier, Knip PASS. Среда та же:
  Windows, Node v24.15.0, npm 11.12.1, разрешённый local shell. Skips прежние:
  3 POSIX-only, 5 недоступных Windows file-symlink cases; junction checks PASS.
- `node scripts/list-check/local-mcp-check.mjs` на built stdio — full/read-only
  **PASS**, literal commands доводят limit=100/pageSize=25 до 4×25, bounded
  resource совпадает, warning final page остаётся. Tools/list прежние:
  19/13 tools, **25888/15808 chars**, budgets 26900/15900 не менялись.
  `git diff --check` PASS. README, architecture, instructions/help и [локальный
  протокол](../testing/010-bounded-list.md) дополнены literal continuation step.
- Остаточные ограничения прежние: exact N консервативно incomplete, сортируется
  collected set, cursor не продолжает scan и имеет прежний TTL; OS I/O не может
  быть принудительно прервано. Существующая scope-specific cursor-only подсказка
  search tools не расширялась в этой доработке. Live не выполнен; planning ведёт
  повторное review, поставку и приёмку. Push/PR/merge, версии/dependencies,
  installed service, production roots, keys и tunnel не затронуты.
