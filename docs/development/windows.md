# Локальная разработка на Windows

## Подготовка checkout

Требуется Node.js >=24; `.nvmrc` задаёт используемую в CI major-версию. Проверять
локальную сборку из своей ветки. Опубликованный `npx ...@latest` не содержит её правок.

```powershell
git status --short
node --version
npm --version
npm ci
npm run build
```

Для новой coding-задачи сначала создать/выбрать отдельный worktree по
[workflow](parallel-work.md). Каждому worktree нужны свои `node_modules` и `dist`.
Версии в `package.json` и `server.json` вручную не менять.

Tracked text нормализуется в LF правилом `* text=auto eol=lf` в корневом
`.gitattributes`. `text=auto` оставляет binary без EOL-преобразований, а `eol=lf` имеет
приоритет над Windows `core.autocrlf=true`. Глобальную Git configuration менять не
нужно.

## Проверки

```powershell
npm run check
```

Это build, production/test types, ESLint, Prettier, Knip и Node tests. Цепочка
останавливается на первом failure. При диагностике, если static stage остановился,
оставшиеся проверки можно выполнить отдельно:

```powershell
npm test
node node_modules/knip/bin/knip.js
```

Фильтр Node test runner передаётся после `--`:

```powershell
npm test -- --test-name-pattern="resources"
```

На историческом baseline `4f2625bf` Windows checkout с `core.autocrlf=true` не проходил
Prettier из-за CRLF. Все 96 failures исходного прогона объяснялись только EOL; типы,
ESLint, Knip и 329 tests прошли. Задача 001 ввела репозиторную LF-политику и
Windows job в CI с теми же `npm ci` и `npm run check`, что и на Ubuntu. Это не заменяет
фактический remote run обоих jobs.

Полезная read-only диагностика:

```powershell
git ls-files --eol
git config --show-origin --get core.autocrlf
git check-attr text eol -- src/core/read.ts
```

В чистом checkout ожидается `i/lf w/lf attr/text=auto eol=lf` для tracked text в
`git ls-files --eol`; binary может показывать `-text`/`none` и не менять bytes. Для
проверки политики с `core.autocrlf=true` использовать отдельный clean worktree/
checkout; не перезаписывать незавершённые правки в текущем worktree.

Если sandbox сообщает `tsx`/`uv_os_get_passwd` до загрузки tests, это сбой среды,
а не 22 независимых дефекта suites. Использовать разрешённый запуск с рабочим
доступом к информации пользователя, зафиксировать среду и итог. Не отключать tests.
POSIX-only и недоступные Windows file-symlink tests могут иметь явные skips;
записывать их причины, а не объявлять такие ветки проверенными.

Если Git сообщает dubious ownership из-за sandbox identity, допустимо разовое
`git -c safe.directory=<проверенный-абсолютный-git-root> ...`. Сначала проверить
реальный путь; не использовать `safe.directory=*` или глобальные изменения.

Windows runner или `os.tmpdir()` может вернуть 8.3 spelling вроде
`C:\Users\RUNNER~1`, тогда как `realpath` возвращает
`C:\Users\runneradmin`. Это aliases одной filesystem location: тесты path identity
сравнивают canonical real paths, а не raw strings. PathGuard намеренно сохраняет
requested и real aliases для lexical/resolved containment checks; omitted `path`
группирует их по canonical location и требует explicit path только для разных locations.

## Synthetic каталог и конфигурация

Из корня своей рабочей копии создать маленький UTF-8 fixture:

```powershell
$repoPath = (Get-Location).Path
$fixturePath = Join-Path $repoPath ('.tmp/local-smoke-' + [guid]::NewGuid().ToString('N'))
New-Item -ItemType Directory -Path $fixturePath | Out-Null
[System.IO.File]::WriteAllText(
  (Join-Path $fixturePath 'probe.txt'),
  "Header`nAntenna Größe Антенна`n",
  [System.Text.UTF8Encoding]::new($false)
)
node dist/index.js --read-only --root-boundary $fixturePath $fixturePath --print-config --json
```

Ожидаются `transport: stdio`, `readOnly: true`, roots этого fixture, тринадцать tools и
лимит полного чтения 10 MiB. Если каталог имеет alias через junction/drive mapping или
Windows 8.3 name, сервер может показать оба пути. Они не делают omitted `path`
неоднозначным, пока разрешаются в одну location.

MCP-клиент должен запускать `node` с аргументами:

```text
<absolute-checkout>/dist/index.js
--read-only
--root-boundary
<absolute-fixture>
<absolute-fixture>
```

`node dist/index.js --read-only <fixture>` в терминале ожидает MCP messages на stdin.
Отсутствие prompt/ответа в таком режиме не означает зависание. Для проверки
протокола использовать SDK harness из `__tests__/helpers.ts`; stdin нельзя засорять
произвольным текстом. Запускать дочерний процесс с timeout и закрывать client/transport.

Проверить `list_roots`, `list`, `find_files`, `read`, `search_text`, отсутствие
mutating tools. Реализация фиксов использует дополнительные Buffer fixtures из
карточки 001, а не пользовательские документы.

## HTTP и клиентские конфиги

Для локального HTTP-опыта с тем же fixture, в отдельном терминале:

```powershell
node dist/index.js --port 3000 --http-host 127.0.0.1 --read-only --root-boundary $fixturePath $fixturePath
```

Переменная должна быть определена в этом терминале; передать её фактическое
значение явно при необходимости. Это локальный endpoint, не подключение облачного
ChatGPT. Доставка в выбранную среду анализа — отдельный будущий опыт.
Не оставлять тестовый сервер работающим после проверки.

## Snapshot jobs

`snapshot` доступен вместе с `job_status`, `cancel_job` и `get_artifact`, в том
числе с `--read-only`: источники только читаются, а служебные bytes пишутся в
отдельный scratch. Для воспроизводимого deployment задавать стабильный каталог:

```powershell
$env:FS_SNAPSHOT_DIR = 'D:\filesystem-mcp-scratch'
node dist/index.js --read-only --root-boundary $fixturePath $fixturePath
```

Один scratch каталог принадлежит одному процессу сервера. Для параллельных
экземпляров задавать разные `FS_SNAPSHOT_DIR`; каталог должен переживать restart
того же экземпляра, если требуется повторная выдача completed artifacts.

Scratch не должен быть source root или его потомком. Если scratch находится внутри
более широкого source root, walker канонически исключает его subtree и фиксирует это
в manifest. Default без переменной — `filesystem-mcp-snapshot-v1` под системным temp;
OS может очищать temp, поэтому это только локальный профиль, не durable deployment.

Быстрый synthetic test и воспроизводимые load/walk команды:

```powershell
node --test --import tsx __tests__/snapshot.test.ts
node --import tsx scripts/snapshot-benchmark/run.mts --mode pipeline --records 3000000
node --import tsx scripts/snapshot-benchmark/run.mts --mode walk --walk-files 21000 --records 1
node --import tsx scripts/snapshot-benchmark/run.mts --mode walk --walk-files 60000 --records 1
```

Два walk-масштаба используют одинаковые caps и `.gitignore`: сравнивать peak RSS/heap,
а не только row count, чтобы regression в path cache был виден. Benchmark verifier
должен пройти до конца каждого ZIP, проверить единственный CSV entry, CRC-32, SHA-256
и strict CSV parse. Benchmark 3 млн не входит в обычный CI. Перед live опытом следовать
[snapshot protocol](../testing/snapshot-live.md); локальный PASS не доказывает
материализацию большой embedded resource в ChatGPT. Результаты проверенного
стенда: [smoke/main/upper](../testing/003-live-2026-09-20.md).

## Bundle выбранных originals

`bundle` использует тот же `FS_SNAPSHOT_DIR`, queue, deadline, quota, TTL,
ZIP/delivery caps и `job_status`/`cancel_job`/`get_artifact`. Отдельные настройки
`FS_BUNDLE_*` ограничивают file count/selection metadata, raw original, raw bytes
ZIP candidate/job и внешний manifest; точные defaults перечислены в README.
`FS_MAX_FILE_SIZE` ограничивает и raw selected original до чтения, и каждый готовый
artifact при создании/fetch. Хорошо сжимаемый original может превышать delivery cap,
но не этот общий source cap.

Быстрый runtime suite, настоящий stdio MCP и independent verifier:

```powershell
node --test --import tsx __tests__/bundle.test.ts
npm run build
python -m venv .tmp/bundle-venv
.tmp\bundle-venv\Scripts\python.exe -m pip install -r scripts\originals-delivery\requirements.txt
.tmp\bundle-venv\Scripts\python.exe scripts\originals-delivery\generate_fixtures.py --output <source>
node scripts\bundle-check\local-mcp-check.mjs --fixture-root <source> --delivery-dir <delivered> --scratch-dir <scratch>
.tmp\bundle-venv\Scripts\python.exe -X utf8 scripts\bundle-check\verify_bundle.py --fixture-manifest <source>\manifest.json --bundle-manifest <delivered>\bundle-manifest.json --artifacts-dir <delivered> --delivery-dir <extracted> --output <report.json>
node --import tsx scripts\bundle-check\volume.mts --output .tmp\bundle-volume.json
```

`source`, `delivered`, `scratch` и `extracted` должны быть разными synthetic
каталогами; последние три находятся вне source. Harness до записи canonicalizes
существующий target или ближайший существующий ancestor, поэтому junction/8.3 alias
в source отклоняется. Verifier проверяет точный entry set, ZIP CRC, SHA-256 и bytes
originals, соответствие каждой записи artifact ID/name/entry, negative provenance
control, затем открывает вложенный ZIP и семь XLS cells.
Volume default создаёт 7 MiB плохо сжимаемых originals при 2 MiB raw-part/ZIP caps,
проверяет все распакованные bytes и повторный fetch, записывает timings, peak RSS и
peak scratch. Это LOCAL_ONLY; целевой ChatGPT опыт выполняется по
[bundle live protocol](../testing/bundle-live.md) только после code review.

Для настоящего Windows 8.3 TEMP создать каталог с длинным именем, получить
`Scripting.FileSystemObject.GetFolder(...).ShortPath` и задать его только процессу
test runner в `TEMP`/`TMP`. Bundle suite также передаёт short spelling source root и
проверяет настоящий junction fail-closed; одинаковый long path вместо `~1` не
считается 8.3 evidence.

JSON-конфиги зависят от клиента: README содержит отдельный VS Code пример с
`servers` и другие варианты с `mcpServers`. Не копировать оболочку между клиентами.
В строках JSON использовать `C:/path` либо экранированные `C:\\path`; placeholders
заменять своими путями. На Windows `FS_ALLOWED_DIRS` разделяет roots через `;`.
Задавать переменные в окружении конкретного процесса, не через глобальный `setx`.

Службы Windows могут не видеть mapped drive буквы интерактивного пользователя.
Доступ к UNC, сетевые credentials и permissions проверяются от фактической
сервисной учётной записи. Это проверка будущего deployment, не основание читать
сетевые диски в локальных regression tests.
