# 014: локальная проверка snapshot_tree

Дата: 28.10.2026. Стенд: Windows x64, Node 24.15.0, npm ci внутри managed
worktree задачи. Только synthetic fixtures, без enterprise inventories/SMB.
Base: `272a841e47366bacbe6774689ca3113a2e8b890b`, ветка `codex/014-snapshot-tree`.

## Контракт и проверки

Runtime opt-in — строго `FS_EXPERIMENTAL_SNAPSHOT_TREE=1`; portable — optional
boolean `experimentalSnapshotTree`, default false/absent. Inherited FS_* очищаются,
launcher явно задаёт 1/0. Стандартный `snapshot` остаётся обычным выбором модели.
Flag не включён в config/policy fingerprints; tree layout добавлен только в
normalized identity нового tool. Общий job kind snapshot, manager/storage/ZIP
не раздваиваются. Новые optional status поля позволяют прочесть tree при flag off.

`tree-depth-v1`: root как одна CSV-запись с одним полем, header, D/F объекты,
числовая глубина от 0, basename без повторения RelativePath/Extension/RootId.
C в начале части — контекст предков; U — incomplete child directory. Они не
увеличивают логическое число directories. Part rows включает root/header/C/U;
filesWritten считает только F. Root/header/context потребляют прежние caps.
Manifest schema отдельная, version 1; provenance и bytes сохраняются при restart.

```powershell
npm ci
node --test --import tsx __tests__/snapshot-tree.test.ts __tests__/snapshot.test.ts __tests__/snapshot-walk-recovery.test.ts __tests__/source-provenance.test.ts
npm run check
node --import tsx scripts/snapshot-benchmark/tree-comparison.mts --files 100000 --walk-files 1200
```

Targeted suite: 66 PASS, 0 FAIL, 0 SKIP. Дополненный final tree-only run:
8 PASS, 0 FAIL, 0 SKIP, включая MCP status/fetch/cancel при flag off.
Полный `npm run check`: PASS, включая build/type checks/ESLint/Prettier/Knip,
506 tests: 498 PASS, 0 FAIL, 8 SKIP. Три skips связаны с POSIX-only FIFO,
inode/mode и 0222 append target; пять — с отсутствием права Windows file-symlink
(append in/out root, sensitive target, PathGuard, stat). Tree suite без skips;
настоящий Windows junction в его walk проверен.
Первый sandbox запуск tsx завершился `uv_os_get_passwd ENOMEM` до загрузки tests;
рабочие прогоны выполнены с доступом к сведениям текущего пользователя, как
предписывает Windows runbook. Это отдельный environment failure, не skip.
Ожидаемая synthetic quota failure может писать diagnostic об отказе terminal
metadata save; тест проверяет failed, отсутствие artifacts и cleanup после close.

Покрыты:

- Реальный guarded walk выбранного subdir: уровни, empty dirs, одинаковые basenames,
  extensionless, каталог с точкой, Unicode/comma, hidden/ignored/default excludes,
  настоящий junction и scratch внутри source. File paths и прежние counters
  сопоставлены со stable CSV через прежний independent verifier.
- Encoder fixtures: commas/quotes/CR/LF/Unicode в именах и root, synthetic UNC,
  глубокая multipart boundary и возврат к соседней ветке. Windows запрещает часть
  таких имён физически: эти варианты проверены на metadata stream, без SMB lookup.
- Child open/readdir/ignore-read faults: D+U, complete=false, bounded diagnostics,
  продолжение siblings. Root/containment failures fatal. Невозможные root/header,
  context+record, oversized record, job raw, ZIP/delivery/file/parts/quota/artifact
  caps завершаются явно; partial artifacts убираются.
- Cancel/TTL, stable/tree bytes после restart, stored layout; completed/in-flight
  reuse в обоих направлениях, same-format joining, cross-format key conflict,
  forceRefresh/retry. Flag off сохраняет MCP status/fetch/cancel прежних tree jobs.
- Portable absent/false/true/type validation и inherited env isolation в дочерних
  процессах. Preflight проверяет ожидаемый toolset.

Independent verifier `scripts/snapshot-benchmark/verify-tree.mts` не импортирует
production walker/CSV/path helpers. Он разбирает CSV records потоковым csv-parse,
проверяет root/header/тип/глубину/metadata, единственный CSV entry, SHA-256,
uncompressed size и CRC-32 до конца ZIP. Каждая часть читается отдельно; merge
отклоняет duplicate D/F и проверяет, что C/U ссылаются на D. Отрицательные controls
меняют SHA и central-directory CRC. Synthetic эталон сравнивается по массивам точных
basenames, чтобы CR/LF не превратились в разделители физических строк.

## Discovery budget

`JSON.stringify(tools).length`, прежние default ceilings 27200/17100 сохранены.

| Flag | Профиль   | Tools | Символы |
| ---- | --------- | ----: | ------: |
| off  | full      |    19 |   27023 |
| off  | read-only |    13 |   16943 |
| on   | full      |    20 |   28474 |
| on   | read-only |    14 |   18394 |

On-профиль имеет собственный тестовый запас +3400 к прежним ceilings;
default budget не ослаблен. Inputs snapshot и snapshot_tree одинаковы.

## A/B: воспроизводимый synthetic опыт

`tree-comparison.mts` запускает каждый format/profile/mode в отдельном свежем
процессе последовательно. DEFLATE level 6 и raw part cap 1 MiB одинаковы.
Streaming metadata: 100000 одинаковых для пары файлов/размеров/timestamps.
Shared/deep: пять общих префиксов на группу 1000 файлов, 600 D, включая 100 empty.
Flat/noisy: basename из 48 hex SHA-256 символов и .dat, 10 empty D.
Файлы имеют одинаковый фиксированный UTC timestamp. Stable закономерно не выдаёт D.

Отдельный настоящий walk создаёт 1200 файлов каждого профиля и известные пустые
каталоги, выставляет те же metadata, затем сверяет paths/metadata/dirs с эталоном.
Создание fixtures и readback ZIP исключены из интервала. Peak RSS/heap семплируются
каждые 5 ms до завершения job, включая baseline процесса; крупного expected tree
в памяти metadata worker нет. Небольшой walk держит эталон вне exporter.

Serialization/spool — pipeline elapsed минус интервалы compression; включает
генерацию metadata, UTF-8/CSV, spool writes, checkpoints и небольшой manifest/job
overhead. Compression включает ZIP level 6, hash, storage commit и удаление spool.
Это не isolated CPU microbenchmark. Walk elapsed включает filesystem/guards/ZIP;
его фазы отдельно не замерялись. Один прогон без статистической оценки шума.

Final прогон (bytes — точные числа, память — MiB):

| Mode / профиль    | Формат |  Files |   D |   C | Parts | Raw bytes | ZIP bytes |
| ----------------- | ------ | -----: | --: | --: | ----: | --------: | --------: |
| metadata / shared | stable | 100000 |   0 |   0 |    17 |  17489869 |    888730 |
| metadata / shared | tree   | 100000 | 600 |  20 |     5 |   5203185 |    521633 |
| metadata / flat   | stable | 100000 |   0 |   0 |    16 |  16189812 |   3532929 |
| metadata / flat   | tree   | 100000 |  10 |   0 |     9 |   8789959 |   3122183 |
| walk / shared     | stable |   1200 |   0 |   0 |     1 |    208947 |     11020 |
| walk / shared     | tree   |   1200 |  12 |   0 |     1 |     61657 |      6762 |
| walk / flat       | stable |   1200 |   0 |   0 |     1 |    193347 |     43043 |
| walk / flat       | tree   |   1200 |  10 |   0 |     1 |    104741 |     37766 |

U = 0 во всех A/B профилях; fault/partial случаи проверены отдельно в regressions.

| Mode / профиль / формат    | Elapsed ms | Serialization/spool ms | Compression ms | Peak RSS MiB | Peak heap MiB |
| -------------------------- | ---------: | ---------------------: | -------------: | -----------: | ------------: |
| metadata / shared / stable |       3548 |                   3384 |            164 |        96.86 |         37.04 |
| metadata / shared / tree   |       3611 |                   3543 |             68 |        97.54 |         36.65 |
| metadata / flat / stable   |       4209 |                   3909 |            300 |        97.34 |         37.03 |
| metadata / flat / tree     |       4228 |                   4016 |            213 |        96.84 |         36.77 |
| walk / shared / stable     |        518 |                      — |              — |        92.05 |         34.14 |
| walk / shared / tree       |        543 |                      — |              — |        92.77 |         34.15 |
| walk / flat / stable       |        544 |                      — |              — |        94.23 |         36.06 |
| walk / flat / tree         |        458 |                      — |              — |        96.34 |         37.15 |

Все 8 workers завершились completed/complete=true, independent ZIP readback PASS.
Metadata shared: raw −70.3%, ZIP −41.3%, parts 17→5; flat: raw −45.7%,
ZIP −11.6%, parts 16→9. Tree при этом экспортирует дополнительные D/C.
Serialization/spool в этом прогоне немного медленнее на обоих профилях;
compression быстрее. Total metadata time не улучшился, RSS/heap близки и не
показывают устойчивого выигрыша. Маленький walk в одном профиле медленнее,
в другом быстрее; при повторных запусках направление менялось. Его нельзя
экстраполировать на большой walk или предприятие. ZIP tree может отличаться на
несколько bytes между повторениями из-за случайного временного sourceRoot в CSV.

## Границы

Это LOCAL_ONLY: live ChatGPT delivery, новый portable build, remote Windows/Linux
CI, настоящий UNC/SMB и производственное дерево не проверялись в задаче 014.
Рабочая установка и tunnel не менялись. Tests/shared lifecycle дают локальное
доказательство, но не заменяют review и приёмку планированием. Выгода ZIP/time
зависит от формы дерева; ускорение большого walk или снижение памяти не обещаются.
