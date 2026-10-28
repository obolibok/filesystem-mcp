# 014: экспериментальный snapshot_tree рядом со стабильным snapshot

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятые 003/006/007/008/013 и текущий main после live 013.
Пользователь разрешил эксперимент 28.10.2026. Ветка: `codex/014-snapshot-tree`.

## Зачем

В нынешнем CSV RootId одинаков во всех записях одной job, RelativePath повторяет
имя файла и префиксы каталогов, Name/Extension выводятся из RelativePath.
Каталоги не экспортируются, поэтому пустые папки теряются. Нужен параллельный
эксперимент: дерево с числовой глубиной, одним именем каждого объекта и корнем
в первой записи. Действующий snapshot и его результаты сохранить.

Пользователь согласовал отдельный snapshot_tree, общие jobs/artifacts и сравнение
форматов на одинаковых источниках. Не заменять стабильный CSV до оценки опыта.
«Не лепить Боинг»: один дополнительный tool/encoder, общий lifecycle и ограниченный
потоковый обход, без новой БД, inventory service или второго job manager.

## Контекст

- [Стабильный snapshot](../../src/tools/snapshot.ts),
  [pipeline/walker/CSV/ZIP](../../src/core/snapshot-pipeline.ts).
- [Jobs](../../src/core/job-manager.ts), [types](../../src/core/job-types.ts),
  [limits](../../src/core/snapshot-config.ts), [job schemas](../../src/tools/job-shared.ts).
- [Tool registry](../../src/tools/index.ts), [instructions](../../src/instructions.ts),
  [portable configuration](../../scripts/windows-portable/template/scripts/config.mjs).
- [013 integration](../testing/013-integration-2026-10-26.md) и
  [live](../testing/013-live-2026-10-26.md): provenance, restart, доставка files.
- [Исторический профиль](../testing/snapshot-shape-2026-09-20.md): 2,899 млн
  записей, 448,5 MB CSV / 35,2 MB ZIP. Это старый внешний CSV, не текущий encoder
  и не прогноз размера нового формата. Исходник не является зависимостью задачи.

## Параллельные tools и включение

- Стабильный snapshot сохраняет имя, inputs/defaults, прежнюю CSV schema,
  RootId/RelativePath/Name/Extension, counters и чтение старых jobs/artifacts.
- Новый tool snapshot_tree, явно experimental в English description, использует
  тот же scope/includeHidden/includeIgnored/maxAgeMs/forceRefresh/idempotencyKey
  и общие job_status/cancel_job/get_artifact. Он не изменяет source files и доступен
  в read-only профиле при включённом эксперименте.
- По умолчанию эксперимент выключен: tool не публикуется и не вызывается,
  стандартные tools/list counts/budgets 19/13 сохраняются. Включение для обычного
  runtime: FS_EXPERIMENTAL_SNAPSHOT_TREE=1. Для portable: optional boolean
  experimentalSnapshotTree в config.json (default false/absent) с явным mapping
  в environment launcher. Inherited env не должен включать его вопреки config.
  Добавлять универсальную платформу feature flags или новый CLI-фреймворк не нужно.
- Обычная инструкция модели по-прежнему выбирает snapshot. snapshot_tree нужен
  при явном запросе эксперимента/дерева. При включении протестировать discovery,
  schema и размер нового toolset отдельно; не ослаблять default budgets.
- Выключение creation-tool не должно мешать status/fetch/cancel уже существующих
  tree jobs в пределах прежней access policy.

## Формат tree-depth-v1

Каждая ZIP-часть содержит CSV UTF-8 без BOM, CRLF, RFC 4180 quoting. В начале:

1. Первая CSV-запись с **одним полем**: абсолютный фактический sourceRoot job.
   Это может быть выбранный подкаталог или UNC, не обязательно корень диска.
   Использовать CSV quoting, а не самодельное экранирование/разрезание строк.
2. Header: Type,Depth,Name,Length,LastWriteTime.
3. Записи дерева в depth-first порядке. Depth — неотрицательное целое:
   0 означает непосредственное содержимое sourceRoot; 1 — следующий уровень.

```csv
"C:\Fixture\Base"
Type,Depth,Name,Length,LastWriteTime
D,0,Backups,,
F,1,db_20260907.bak,12345,2026-09-07T12:00:00.000Z
F,0,rag_demo.doc,6789,2026-09-08T12:00:00.000Z
D,0,Empty,,
```

- F: обычный файл; Name содержит ровно basename с расширением, Length — bytes,
  LastWriteTime — ISO 8601 UTC, как в stable snapshot.
- D: каталог; Length/LastWriteTime пусты, дополнительный stat каждого каталога
  ради необязательных metadata не требуется. Каталоги без exported children
  также представлены. Сам sourceRoot задан первой записью и не дублируется как D.
- C: служебная запись предка для начала новой части; форма как D. Это контекст,
  а не новый каталог: не увеличивает files/directories и не создаёт дубликаты
  логического дерева при сборке частей.
- U: служебная отметка unreadable/incomplete child directory, форма как D.
  Указывает на каталог, который не удалось полностью прочитать; может уточнять
  уже встреченный D. Не считать новым файлом/дубликатом каталога. Конкретная
  причина — в bounded job diagnostics; complete=false и счётчики ошибок сохранены.
  Ошибки самого root и нарушения policy/containment остаются fatal как раньше.

RootId, полный RelativePath и отдельный Extension в записях нового формата не
повторяются. Путь восстанавливается из базы и стека имён предков. Имена сохраняются
точно, включая Unicode, commas, quotes и допустимые CR/LF. Единица — CSV record,
не обязательно физическая строка. Не сортировать/буферизовать всё дерево ради вывода.

Набор ограничен действующими roots, policy, hidden/ignore/no-follow и исключением
scratch. Папка без выгруженных детей означает пустоту в наблюдаемой выборке;
при exclusions/ошибках не обещать физическую пустоту или полный охват диска.
Не добавлять предварительный обход ради обнаружения всех каталогов.

## Самостоятельные части и manifest

- В каждой части повторены тот же sourceRoot и header. Если первая data record
  находится на depth N, перед ней идут C для цепочки предков 0..N-1.
  Все depths остаются относительно исходной базы даже при возврате наверх дерева.
- Пример начала второй части внутри Backups: после root/header идут
  `C,0,Backups,,`, затем `F,1,...`. В первой части контекста может не быть.
- Каждая часть отдельно восстанавливает полные пути без загрузки других частей.
  Новый verifier проверяет также объединение частей: C/U не удваивают объекты.
- Root/header/context входят в raw-byte, record, scratch, quota и part-count caps.
  Разрезать только между целыми CSV records. Если служебные записи и следующий
  объект не помещаются в пустую часть, завершить ограниченной понятной ошибкой,
  без бесконечного создания частей или oversized artifacts.
- ZIP/delivery/base64 limits, SHA-256, CRC, cancel/restart/TTL и provenance общие
  с существующим pipeline. Формирование bounded/streaming: стек глубины и одна
  текущая часть; не собирать все paths/nodes в память.
- Новый manifest имеет явные отдельные schema/version и layout tree-depth-v1,
  правила Depth/Type, root/provenance, completeness/policy/errors и parts/hashes.
  Для частей различать files, directories и служебные context/error records.
  Не подменять filesWritten числом всех CSV records.

## Reuse и совместимость

Формат участвует во всех identities нового tool: ordinary/request fingerprint,
completed/in-flight automatic reuse и idempotency. Stable snapshot никогда не
получает tree result, и наоборот. Одинаковый idempotencyKey для разных форматов
даёт conflict, а не чужой результат. Существующие stable fingerprints и legacy
config/policy identity не менять из-за включения feature flag. Возможный минимум:
job kind snapshot и дополнительный discriminator в input только для нового
tool; конкретный wiring выбирает исполнитель. Stored/status metadata tree job
должны позволять понять layout (добавочные optional поля допустимы).

Новые tree jobs сохраняют layout/provenance при restart и fetch. Старые stable
jobs/artifacts читаются без миграции и переписывания bytes, в том числе с включённым
экспериментом. Factory settings/tool registration не должны менять доступ к старым
артефактам только из-за feature flag. Общий lifecycle/ZIP code переиспользовать;
рефакторинг walker ограничить необходимым, с regression proof стабильного вывода.

## Проверки и сравнение

- Synthetic дерево: файлы на разных уровнях, empty dirs, одинаковые basenames
  в разных ветках, файл без расширения, каталог с точкой, Unicode/commas/quotes,
  hidden/ignored, symlink/junction и scratch exclusion по прежним правилам.
- Непрочитанный child directory и ошибка посреди readdir: U/complete=false,
  без ложного утверждения о пустоте; root/policy/storage failures fatal как раньше.
- Минимум одна принудительно multipart fixture с boundary внутри глубокой ветки,
  переходом вверх/в соседнюю ветку, пустыми dirs и UTF-8/CSV escaping. Проверить
  каждую часть отдельно и восстановленное дерево целиком, без missing/duplicates.
- Проверить невозможный root+context+record budget, ZIP/raw/part/quota limits,
  cancellation, restart/fetch и legacy stable jobs.
- A/B reuse в обоих направлениях: completed, in-flight, idempotency conflict,
  forceRefresh; независимые одинаковые запросы одного формата переиспользуются.
- Опубликованные tools с flag off/on, read-only, portable mapping и env isolation.
  Обычный snapshot и header/CSV/ZIP semantics регрессий остаются прежними.

В docs/testing/014-snapshot-tree.md записать команды и честное сравнение stable CSV
и tree на одинаковом synthetic наборе файлов/metadata и одинаковом DEFLATE level 6.
Нужны два профиля: shared/deep prefixes и flat tree с плохо повторяющимися именами;
в дереве также есть известные пустые каталоги. Отдельно показать files/dirs/context,
raw bytes, ZIP bytes, parts, serialization/compression time и peak memory.
Имена/числа/metadata одинаковы для сопоставимых files; добавочные dir records
учитываются явно. Полный повторный обход предприятия не нужен. Допустим отдельный
больший streaming metadata fixture для encoder и небольшой настоящий FS walk.
Результат эксперимента не обязан выигрывать во всех профилях: отрицательный
результат и overhead фиксируются. Не выдавать serializer timing за ускорение walk.

## Acceptance

- [ ] Два toolset варианта доступны по явной настройке; stable default сохранён.
- [ ] Tree layout lossless по files/dirs, с числовой глубиной и первой root записью.
- [ ] Empty/unreadable/excluded случаи различены, прежние guards/policy сохранены.
- [ ] Multipart parts отдельно декодируются; служебный контекст корректен и учтён.
- [ ] Reuse изолирован по формату, legacy stable jobs и restart/fetch работают.
- [ ] Independent verifier/readback не делит CSV по физическим строкам; проверяет
      hashes/CRC/формат и сопоставляет дерево с synthetic эталоном.
- [ ] Targeted regressions и npm run check; pass/fail/skips и границы зафиксированы.
- [ ] Сравнение raw/ZIP/time/memory выполнено; обновлены reference/portable docs
      и Work record. Исходные данные/серийники/ключи/архивы в Git не попали.

## Launch prompt

```text
Реализуй docs/tasks/014-snapshot-tree.md в отдельном managed worktree с карточкой,
ветка codex/014-snapshot-tree. Пользователь разрешил эксперимент по обычной схеме:
стабильный snapshot сохраняется, snapshot_tree включается отдельно.
Прочитай AGENTS.md, docs map, brief, карточку и parallel-work workflow.
Выполни exact tree-depth-v1, самостоятельные части, shared jobs/artifacts и
разделение reuse, meaningful regressions и synthetic A/B comparison.
Не делай новый job manager, БД или полный in-memory tree. Сохраняй PathGuard.
Выполни acceptance и npm run check, заполни Work record, закоммить и передай
планированию head/base/branch, результаты и ограничения, ready for review.
Центральную доску ведёт планирование. Push/PR/merge, переносимую сборку и
пользовательский live проводит планирование; рабочую установку/туннель не менять.
```

## Work record

Реализация не начата. Карточка подготовлена планированием 28.10.2026;
исполнитель ещё не назначен.
