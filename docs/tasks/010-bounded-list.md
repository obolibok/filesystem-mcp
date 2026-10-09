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

- [ ] Synthetic instrumentation доказывает отсутствие descent за maxDepth, включая
      1/2, hidden папки и includeIgnored=false с глубокими .gitignore. Проверять
      реальные посещения/открытия, не только итоговый отфильтрованный массив.
- [ ] На широком/глубоком дереве limit прекращает traversal, ограничивает весь
      набор до N, а pageSize меняет только страницу. Проверены 0/1/N-1/N/N+1
      найденных записей, limit меньше/равно/больше pageSize и validation bounds.
- [ ] Cap result не объявляется полным; counters/text/_meta/resource согласованы.
      Pages без дублей/потерь; последняя страница без cursor сохраняет warning.
      Cursor query mismatch/expiry и изменение pageSize работают корректно.
- [ ] При delayed iterator и отмене завершается работа и закрываются handles;
      вложенные отфильтрованные элементы и ignore discovery не прячут отмену.
      Стабильные tests по событиям/счётчикам; wall-clock только с разумным запасом.
- [ ] No-follow/allowed boundaries/sensitive paths, Windows canonical aliases,
      hidden/.gitignore/default exclusions сохранены. Соседние find_files и
      search_text проверены при затрагивании общей логики; 009 warnings не сломаны.
- [ ] Wire tools/list публикует limit/pageSize, не maxEntries; старое имя даёт
      понятную validation error. Actual request/response и defaults проверены.
      Описания однозначно разделяют collect cap, page size и число страниц.
- [ ] Полный npm run check PASS; environment/skips записаны. Actual full/read-only
      tools/list размеры измерены; сначала сократить дублирование. Необходимое
      увеличение budget обосновать измерениями, не менять count без нового tool.
- [ ] Reference/runnable examples и Work record обновлены. Протокол live включает
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

Заполняет исполнитель. Реализация не начата.

- Base / branch / итоговый head:
- Изменения и решение по traversal:
- Контракт limit/pageSize, неполнота и counters:
- Checks, environment, результаты/skips и tools/list budget:
- Acceptance, риски, live и handoff:
