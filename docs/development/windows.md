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

Ожидаются `transport: stdio`, `readOnly: true`, roots этого fixture, восемь tools и
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

JSON-конфиги зависят от клиента: README содержит отдельный VS Code пример с
`servers` и другие варианты с `mcpServers`. Не копировать оболочку между клиентами.
В строках JSON использовать `C:/path` либо экранированные `C:\\path`; placeholders
заменять своими путями. На Windows `FS_ALLOWED_DIRS` разделяет roots через `;`.
Задавать переменные в окружении конкретного процесса, не через глобальный `setx`.

Службы Windows могут не видеть mapped drive буквы интерактивного пользователя.
Доступ к UNC, сетевые credentials и permissions проверяются от фактической
сервисной учётной записи. Это проверка будущего deployment, не основание читать
сетевые диски в локальных regression tests.
