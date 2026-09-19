# 001 — Исправить дефекты чтения, поиска и Windows baseline

| Поле       | Значение                                                                                   |
| ---------- | ------------------------------------------------------------------------------------------ |
| Status     | См. [центральную доску](../project/status.md)                                              |
| Depends on | 000 — committed documentation checkpoint                                                   |
| Owner      | Первый coding chat; заполняется при начале работы                                          |
| Branch     | `codex/001-baseline-defects` (предлагаемое имя)                                            |
| Base       | Коммит с этой карточкой и правилами совместной работы; точный SHA зафиксировать при старте |
| Result     | Пока не реализовано; эта карточка описывает работу                                         |

## Цель и границы

Подготовить надёжную исходную версию коннектора для локального эксперимента:
устранить порчу UTF-16, поиск внутри binary, неверные обещания о выборе root и
зависимость проверок форматирования от Windows `core.autocrlf`.

Работать в отдельном checkout/worktree. Перед изменениями прочитать корневой
`AGENTS.md`, карту `docs/README.md` и актуальные правила совместной работы, на
которые она ссылается. Зафиксировать ветку, базовый SHA и владельца в этой
карточке. Общие проектные status/brief/decision документы ведёт planning chat:
передать ему результат, а не редактировать их параллельно.

Задача не включает `snapshot`, `bundle`, OAuth, доставку в среду анализа ChatGPT,
парсеры производственных форматов, индекс, векторную БД или реорганизацию
исходников. Работать только с синтетическими файлами. Сведения о содержимом
Daum/Inoplacer из переданного ранее чата не являются проверенными образцами.

## Проверенные причины

Причины подтверждены просмотром исходников baseline `4f2625bf`; при старте
проверить, не изменилась ли реализация. Локальный исходный отчёт находился в
игнорируемом `reports/schwarzbeck-connector-review.md`; наличие отчёта, PDF и
старых `.tmp` файлов для выполнения задачи не требуется.

1. `src/core/mime.ts`: `isBinarySample()` считает BOM `FF FE` и `FE FF`
   признаком допустимого текста. `src/core/read.ts` затем декодирует UTF-8.
   В результате `read` успешно возвращает повреждённый UTF-16 текст.
2. `src/core/search.ts`: `searchContent()` читает каждый подходящий файл через
   `readFile(..., { encoding: 'utf-8' })` без text/binary проверки. ASCII-маркер
   внутри `.bin` попадает в grep; маркер в UTF-16 не находится.
3. `src/core/fs.ts`: `readRaw()` выбирает text/blob по `detectMimeFromContent()`.
   `detectMimeType()` предпочитает известное расширение содержимому, поэтому
   `.txt` остаётся text даже с неподдерживаемой кодировкой. `src/resources.ts`
   декодирует такой ресурс в UTF-8. Исправления одного BOM-предиката недостаточно.
4. Descriptions `find_files` и `search_text` обещают default first root.
   `PathGuard.resolvePathOrRoot()` при нескольких roots требует явный path.
5. `.github/workflows/ci.yml` проверяет Ubuntu; `.gitattributes` отсутствует.
   При Windows checkout с `core.autocrlf=true` Prettier ожидает LF и отклоняет
   CRLF. На исходной машине это остановило полный check на 96 файлах.

## Предпочтительное решение

### UTF-16 и исходные байты

Минимальная стратегия: явно отклонять UTF-16 LE/BE с BOM в текстовом `read`,
пропускать с объяснимым счётчиком в `search_text`, отдавать оригинальные байты
через file resource как base64 `blob`. Ошибка текстового чтения должна говорить
о неподдерживаемой кодировке и способе получить оригинал. Не возвращать «успех»
с NUL/U+FFFD, появившимися из-за неверного декодирования UTF-16; настоящий U+FFFD
в корректном UTF-8 не является ошибкой. Не перезаписывать исходник в UTF-8.

Применить единое решение к full/head/tail/range, batch read и resources. Для
resources расширение `.txt` не должно принуждать к UTF-8-декодированию. MIME и
способ передачи должны правдиво описывать ответ; file resource для UTF-16 обязан
передавать `blob` с BOM и всеми исходными байтами при обеих стратегиях текстового
чтения. Сохранить исходные байты известных binary/media файлов.

Полная поддержка UTF-16 допустима, если coding chat обоснует ограниченный объём
и обеспечит обе byte orders, BOM, все режимы чтения, поиск, line numbers,
ограничения размера и raw resources. Записать выбранный контракт и причины в
результате карточки. Предпочтение — явный отказ: текущие line slicing и tail
рассчитывают границы по UTF-8 байтам, поэтому замена одного decoder недостаточна.
Угадывание произвольных legacy-кодировок и UTF-16 без BOM не входит в scope.

### Binary filtering и наблюдаемость поиска

Использовать общую классификацию с чтением: известные binary-расширения и
проверку содержимого для остальных файлов. Не полагаться только на расширение:
binary с `.txt` или без расширения также не должен становиться grep-текстом.
Сохранить поддержку корректного UTF-8, включая символ на границе sample/chunk.
Общая классификация text/binary не заменяет MIME/media kind: SVG остаётся доступным
текстовому чтению и поиску, PNG/audio сохраняют существующие media blocks и MIME.

Предлагаемые независимые счётчики: `skippedBinary` и
`skippedUnsupportedEncoding`. Разделить их с `skippedTooLarge` и
`skippedInaccessible`; один файл получает одну причину пропуска. Допустима иная
ясная схема, если она совместима с существующим ответом и объясняет отсутствие
совпадений. Зафиксировать значение `filesScanned` и согласовать schema/descriptions
с подсчётом. Не менять существующие поля без необходимости.

Счётчики должны пройти весь путь: core summary → tool metadata/schema → `_meta`
ответа → page snapshot → externalized JSON resource. Ненулевые пропуски должны
быть понятны также в текстовом ответе, особенно при `No matches`. Не скрывать
ошибки чтения в успешном пустом результате. Сохранить maxResults, timeout,
отмену, ignored/hidden правила и PathGuard.

### Roots и Windows

Согласовать descriptions инструментов и затронутую документацию с действующим
правилом: omitted path использует единственный root; при нескольких roots
нужен явный path. Поведение выбора root и границы доступа сохраняются.

Ввести репозиторную LF-политику через `.gitattributes`, согласованную с Prettier.
Не менять глобальные Git settings. Автоматическое определение text должно
сохранять binary; исключения для форматов, которым реально требуется CRLF,
добавлять по необходимости. Нормализация существующих tracked text допустима,
но её объём и отсутствие смысловых изменений должны быть явно видны в diff.
Не применять массовый reset/checkout поверх пользовательских правок.

Добавить Windows в существующий CI рядом с Ubuntu; одинаковые `npm ci` и
`npm run check`, версия Node из `.nvmrc`. Сохранить действующие ограничения
permissions и триггеры. Windows job должен проверять checkout с новой
EOL-политикой, а не маскировать ошибку отключением Prettier или tests.
Причины платформенных skips фиксировать; не делать весь suite условно успешным.

## Самодостаточное воспроизведение

Создать временный `.mjs` с кодом ниже и выполнить `node <путь-к-скрипту>`.
Скрипт создаёт новый corpus в системном temp; не использует старые `.tmp` или
производственные данные. Сохранить напечатанный абсолютный путь. После опыта
удалять только этот созданный каталог, проверив его точный путь.

```js
import { Buffer } from 'node:buffer';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'filesystem-mcp-001-'));
const first = join(root, 'root-one');
const second = join(root, 'root-two');
await mkdir(first);
await mkdir(second);

const source = 'UTF16_MARKER Größe Антенна\r\nSecond line\r\n';
const le = Buffer.from(source, 'utf16le');
const be = Buffer.from(le).swap16();
const binary = Buffer.concat([
  Buffer.from([0, 1, 2, 3, 255, 0]),
  Buffer.from('ASCII_MARKER_BINARY\n', 'ascii'),
  Buffer.from([0, 255]),
]);
const files = new Map([
  ['utf16-le.txt', Buffer.concat([Buffer.from([255, 254]), le])],
  ['utf16-be.txt', Buffer.concat([Buffer.from([254, 255]), be])],
  ['binary.bin', binary],
  ['binary.txt', binary],
  ['binary-no-extension', binary],
  ['измерения-ä.txt', Buffer.from('Header\r\nUTF8_MARKER Größe Антенна\r\n', 'utf8')],
  ['empty.txt', Buffer.alloc(0)],
]);
for (const [name, bytes] of files) await writeFile(join(first, name), bytes);
await writeFile(join(second, 'second.txt'), 'SECOND_ROOT_MARKER\n', 'utf8');

const resourceUri = (name) =>
  `filesystem-mcp://file/${encodeURIComponent(join(first, name).replaceAll('\\', '/')).replaceAll('%2F', '/')}`;
console.log(
  JSON.stringify({ root, first, second, utf16Uri: resourceUri('utf16-le.txt') }, null, 2),
);
```

Из корня checkout выполнить `npm ci`, затем `npm run build`. Запускать именно
локальную сборку с аргументами `node dist/index.js --read-only <first>` через
MCP stdio client. `npx ...@latest` эту задачу не проверяет. Для automated tests
использовать существующий harness в `__tests__/helpers.ts`.

Подставить `first`, `second` и пути файлов из генератора; строки в угловых
скобках ниже — placeholders, а не буквальные аргументы.

| Вызов            | Аргументы                                                             | Дефект baseline / ожидаемый итог                                                          |
| ---------------- | --------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| `read`           | `{"path":"<first>/utf16-le.txt"}`                                     | Повреждённый успех → явная encoding error либо корректный текст при полной поддержке      |
| `read`           | `{"path":"<first>/utf16-be.txt","head":1}`                            | Та же политика для BE и partial read                                                      |
| `search_text`    | `{"path":"<first>","searchPattern":"ASCII_MARKER_BINARY"}`            | Binary matches → 0 совпадений, объяснимые пропуски                                        |
| `search_text`    | `{"path":"<first>/binary.bin","searchPattern":"ASCII_MARKER_BINARY"}` | Явный файл также проходит binary filtering                                                |
| `search_text`    | `{"path":"<first>","searchPattern":"UTF16_MARKER"}`                   | Пустой результат без encoding причины → counted skip либо корректные UTF-16 matches       |
| `search_text`    | `{"path":"<first>","searchPattern":"UTF8_MARKER"}`                    | Сохраняется совпадение в строке 2 с umlaut и кириллицей                                   |
| `resources/read` | `{"uri":"<utf16Uri>"}`                                                | UTF-16 `.txt` не декодируется как UTF-8; при стратегии отказа результат — исходный `blob` |
| `find_files`     | `{"pattern":"**/*.txt"}`                                              | С одним root работает; с двумя требует path, что и обещает description                    |
| `search_text`    | `{"searchPattern":"MARKER"}`                                          | То же правило для omitted path                                                            |

Для последних двух проверок повторно создать сервер с двумя roots:
`node dist/index.js --read-only <first> <second>`. Явный path к каждому root
должен работать и не включать соседний root.

## Критерии приёмки

- [x] Regression tests воспроизводят исходные дефекты и проверяют итоговый
      контракт. Fixtures создаются из Buffer в temp, не зависят от Git EOL.
- [x] UTF-16LE и UTF-16BE с BOM не возвращаются повреждённым текстом ни через
      full/head/tail/range, ни через batch. Batch сохраняет успешный UTF-8 файл
      и понятный per-file error при стратегии отказа; при полной поддержке
      возвращает корректный UTF-16 результат.
- [x] Directory search и explicit-file search исключают binary `.bin`, `.txt`
      и без расширения; оба UTF-16 BOM обрабатываются выбранной стратегией.
      Literal и regex идут через ту же политику.
- [x] UTF-8 с CRLF, umlaut, кириллицей и пустой файл читаются корректно;
      прежний контракт полных и частичных строк сохраняется. UTF-8, разрезанный
      границей MIME sample, не объявляется binary. Существующий тест на это
      остаётся зелёным.
- [x] Ненулевые skip counters проверены через MCP-ответ и при переходе на
      следующую страницу; externalized JSON содержит те же итоги. Проверено
      отсутствие совпадений при наличии пропусков. Размерный лимит и отмена
      сохраняют прежние причины остановки/пропуска.
- [x] Resources возвращают binary оригинал byte-for-byte: сравнить
      `Buffer.from(blob, 'base64')` с исходным Buffer, при желании и SHA-256.
      Покрыть синтетический ZIP или существующий media fixture и binary с
      misleading `.txt`. При любой выбранной стратегии отдельно проверить оба
      UTF-16 `.txt` как исходный blob, включая BOM. Проверки SVG/text и PNG/audio
      подтверждают сохранение прежнего контракта. Исходники на диске не изменились.
- [x] MCP descriptions и tests согласованы для одного/нескольких roots;
      PathGuard, read-only tool inventory и deny rules не ослаблены.
- [x] `.gitattributes` задаёт LF для text и сохраняет binary. Чистый Windows
      checkout/worktree применяет эту политику при `core.autocrlf=true` без
      изменения global config; `git ls-files --eol` и проверка attributes дают
      ожидаемый результат. Текущий working tree также проходит Prettier.
- [x] `npm run check` проходит локально на Windows; CI содержит Ubuntu и
      Windows с полным check. Remote CI считается пройденным только после
      реального запуска; если не запускался, указать это явно.
- [x] Обновлены `docs/reference/architecture.md` и
      `docs/development/windows.md` по фактическому результату. При
      необходимости синхронизированы затронутые README/instructions.
- [x] Не изменены версии `package.json`/`server.json`: это делает Release
      workflow. Dependency upgrades, force push и публикация не требуются.

Начать с нужных regression cases, затем выполнить полный `npm run check` один
раз на финальной версии. При ошибке `tsx`/`uv_os_get_passwd` отличать ограничения
исполняющей среды от провала tests; повторить разрешённым способом и честно
указать среду. Числа исходного baseline (329 pass, 7 skip) — историческая
справка, а не требование сохранить число tests или skips.

## Владение файлами и передача результата

Coding chat владеет этой карточкой и необходимыми для задачи изменениями:

- `src/core/mime.ts`, `src/core/read.ts`, `src/core/search.ts`, `src/core/fs.ts`;
- `src/resources.ts`, `src/tools/read.ts`, `src/tools/search-text.ts`,
  `src/tools/find-files.ts` и непосредственно затронутыми contracts/helpers;
- regression cases в `__tests__/core-fs.test.ts`, `__tests__/tools.test.ts`,
  `__tests__/resources.test.ts` и минимально необходимыми test helpers;
- `.gitattributes`, `.github/workflows/ci.yml`, необходимые EOL-настройки и
  нормализация tracked text с отдельным пояснением объёма;
- `docs/development/windows.md`, `docs/reference/architecture.md` и точечные
  описания изменённого поведения в README/`src/instructions.ts`.

Это scope, а не требование изменить каждый перечисленный файл. Другим coding
чатам не выдавать пересекающиеся задачи до передачи результата. Root
`AGENTS.md`, карта документации, общий status/brief и общие решения остаются
у planning chat. Если расширяется контракт или scope, записать предложение и
сообщить planning chat; не начинать соседние feature-задачи внутри этой.

Перед передачей записать в Work record `ready for review`, заполнить результат ниже,
проверить `git diff --check` и передать точные branch/SHA либо путь checkout с
diff. Если commit не создан, написать об этом. Состояние `done` означает
проверенный и интегрированный результат; его устанавливает planning chat.
Не выдавать окончание coding chat за интеграцию в базовую ветку.
В tracked Work record использовать логическое или относительное имя checkout;
абсолютный локальный путь, если нужен, сообщить только в handoff сообщении.

## Work record — заполняет coding chat

Состояние: ready for review. Интеграционный статус хранится на центральной доске.

- Owner / checkout / branch / base SHA: coding chat 001 / `.worktrees/001-baseline-defects` /
  `codex/001-baseline-defects` / `7c1b151a49c5c468c32d1d557f1c1403c5ee02ad`.
- Выбранная encoding policy и причины: текстовые operations явно отклоняют
  UTF-16 LE/BE с BOM через per-file `INVALID_INPUT`; полная поддержка потребовала бы
  пересчёта line/range/tail по UTF-16. Ошибка направляет к file resource, который отдаёт
  исходные bytes как base64 blob.
- Изменённый публичный контракт, включая skip counters: `search_text` не ищет в binary
  независимо от расширения и публикует `skippedBinary` и `skippedUnsupportedEncoding`
  рядом с `skippedTooLarge`/`skippedInaccessible`. Счётчики сохраняются в `_meta`, на всех
  страницах, в externalized JSON и в текстовом summary. `filesScanned` включает доступные
  проверенные файлы с этими skip reasons, но не `skippedInaccessible`. Optional path можно
  опускать только при одном root.
- Review follow-up: устранён media fast-path для `.svg`, из-за которого UTF-16 SVG при
  full/batch read мог вернуться успешным image block, хотя partial read уже отклонялся.
  Теперь любой SVG проходит общую text/encoding classification; UTF-8 SVG остаётся text,
  UTF-16 LE/BE SVG получает тот же `INVALID_INPUT`, а file resource сохраняет исходный blob.
  Regression покрывает оба byte order для single full, mixed batch, partial и raw resource.
- Проверки: Windows 10 `10.0.19045`, Node `v24.15.0`, npm `11.12.1`; исходный и
  исправленный synthetic stdio repro выполнены на локальном `dist`; после review follow-up
  `npm test` — 348 tests, 341 pass, 0 fail, 7 skip. Skips: два POSIX-only сценария и пять
  сценариев с недоступным Windows file symlink. `npm run check` — pass на финальной версии.
  Sandbox-only test launch не загрузил suites из-за `tsx` / `uv_os_get_passwd ENOMEM`; та же
  команда в разрешённом Windows-процессе прошла.
- Windows/Ubuntu CI: workflow содержит одинаковый full check на `ubuntu-latest` и
  `windows-latest`; remote CI не запускался.
- Checkpoint: первичный commit `0266effd`; исправленный итоговый SHA — в handoff сообщении.
- Риски, ограничения и предложения для planning chat: UTF-16 без BOM и прочие legacy
  encodings не угадываются; binary/content detection использует первые 512 bytes, как и до
  задачи. `.gitignore`, `.prettierignore` и `Dockerfile` изменены только EOL; версии и dependencies не
  менялись. Существенного расширения scope нет.

## Готовый запрос для нового чата

```text
Работаем над filesystem-mcp для Schwarzbeck. Выполни задачу
docs/tasks/001-baseline-defects.md целиком. Этот чат отвечает за код;
планирование проекта ведётся отдельно.

Сначала прочитай AGENTS.md, docs/README.md и связанные правила совместной
работы. Проверь git status, текущую ветку и базовый SHA. Работай в отдельном
worktree/checkout, чтобы planning chat и соседние задачи не затрагивали твои
файлы. Если этот чат уже открыт в изолированном worktree, используй его.
Все необходимые сведения и синтетические repro есть в task-файле; доступ
к старому чату, PDF, reports или .tmp не требуется.

Исправь UTF-16 handling, binary search с видимыми причинами пропуска,
descriptions для нескольких roots, LF-policy и Windows CI. Предпочтительно
явно отклонять неподдерживаемый UTF-16 в текстовых операциях и сохранять
исходные байты в resources. Сохрани guard/read-only ограничения. Добавь
содержательные regression tests и выполни npm run check. Не начинай
snapshot/bundle, OAuth или серверные парсеры; не меняй версии вручную.

Обнови свою карточку и затронутые reference/Windows docs по результату.
Общий project status, brief и правила меняет planning chat. Передай на
review точные branch/base SHA, commit SHA либо указание на незакоммиченный
diff, выбранный контракт, команды проверок, результаты и остаточные риски.
Не помечай задачу done до интеграции. Не делай push, merge или публикацию
без отдельного запроса.
```
