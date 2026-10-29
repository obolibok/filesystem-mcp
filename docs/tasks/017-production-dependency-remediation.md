# 017: убрать известные уязвимости production-зависимостей

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: 016.

## Зачем

Предыдущий `npm audit --omit=dev` для переносимого комплекта обнаружил 9 production advisories: 4 moderate, 4 high и 1 critical. Текущий lockfile по-прежнему закрепляет уязвимые версии MCP SDK, `proxy-addr` и Zod. Свежий audit нужно выполнить на доступном npm registry; не считать прошлый результат актуальным полным перечнем advisories.

## Контекст и источники

- `package.json` и `package-lock.json` — версии зависимостей проекта.
- Предыдущий audit выявил MCP packages `2.0.0`, `proxy-addr 2.0.7` и `zod 4.6.5`.
- Известные advisory: [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [MCP HTTP response isolation](https://github.com/advisories/GHSA-jm63-cq47-j5jp), [MCP HTTP request limits](https://github.com/advisories/GHSA-f897-62hf-6gxq), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- Актуальный upstream `package.json` содержит исправленные MCP версии; использовать его как источник сравнения, но не подтягивать несвязанные изменения: https://github.com/j0hanz/filesystem-mcp/blob/main/package.json.

## Scope и владение

Обновить production dependencies и lockfile до совместимых исправленных версий. Минимальные известные целевые версии: `@modelcontextprotocol/express >=2.0.2`, `@modelcontextprotocol/node >=2.1.2`, `@modelcontextprotocol/server >=2.4.0`, `zod >=4.6.6`, `proxy-addr >=2.0.8`. Уточнить фактические advisory и дерево после свежего audit. Транзитивную зависимость исправлять поддерживаемым путём; не добавлять override без доказанной необходимости.

Не менять MCP tool contracts, код snapshot/job lifecycle, публичную версию продукта и unrelated dev dependencies. Не использовать массовый `npm audit fix` без анализа diff.

## Acceptance

- [x] Свежий `npm audit --omit=dev` для исходного проекта не содержит известных исправленных production advisories; новые оставшиеся production findings отдельно объяснены в Work record.
- [x] Portable build использует тот же исправленный production dependency graph; audit собранного server package подтверждает исправления.
- [x] `npm ci` и `npm run check` проходят; зафиксированы среда и skips.
- [x] MCP package API/stdio transport, HTTP transport, build и portable Verify проверены без изменения существующих tool contracts.
- [x] Карточка содержит точные обновлённые версии, audit summary, проверки и handoff. Не хранить auth tokens или пользовательские данные.

## Launch prompt

```text
Реализуй задачу docs/tasks/017-production-dependency-remediation.md в этом репозитории.
Сначала прочитай AGENTS.md, docs/README.md и карточку. Работай в отдельном
worktree от принятого main checkpoint. Обнови только совместимые production
dependencies и lockfile для устранения advisories из карточки. Сначала получи
свежий npm audit; не запускай массовый audit fix. Проверь source и portable
dependency graph, npm ci, npm run check, HTTP/stdio compatibility и portable
Verify. Заполни Work record точными версиями, командами, результатами и skips.
Не обновляй центральную доску; передай результат планированию.
```

## Work record

Исполнитель: coding-чат 017. Дата: 2026-10-29. **Ready for review**.

### Base и границы изменения

- Изолированный worktree приложения; branch `codex/017-production-dependency-remediation`.
  Base: свежий `origin/main` `ec7ebfb69cadf6c18fd70ef420c67759b99e398e`
  после `git fetch origin main`. PR #16 подтверждён merged, merge commit
  `82e7357b23aaf5978c8d3b25107039dd96baa19c` входит в base; карточка была в checkout
  до изменений. Начальный working tree чистый.
- Изменены только `package.json`, `package-lock.json` и эта карточка. Public
  version остаётся `2.3.0`; `server.json`, tools, transport implementation,
  snapshot/job lifecycle и центральная доска не менялись.
- Сравнение с upstream `package.json` от 29.10 подтвердило те же MCP pins и
  `zod ^4.6.7`. Остальные upstream изменения не переносились.

### Версии и способ обновления

| Пакет                         | До      | После   | Путь                            |
| ----------------------------- | ------- | ------- | ------------------------------- |
| @modelcontextprotocol/express | 2.0.0   | 2.0.2   | direct production               |
| @modelcontextprotocol/node    | 2.0.0   | 2.1.2   | direct production               |
| @modelcontextprotocol/server  | 2.0.0   | 2.4.0   | direct production               |
| @modelcontextprotocol/core    | 2.0.0   | 2.4.0   | server dependency               |
| zod                           | 4.6.5   | 4.6.7   | direct range поднят до `^4.6.7` |
| @hono/node-server             | 1.19.17 | 2.1.5   | node dependency                 |
| hono                          | 4.13.7  | 4.13.14 | node dependency                 |
| body-parser                   | 2.3.0   | 2.4.0   | express dependency              |
| proxy-addr                    | 2.0.7   | 2.0.8   | express dependency              |
| qs                            | 6.16.0  | 6.17.1  | express/body-parser dependency  |

После правки четырёх direct production ranges выполнено адресное обновление:

```powershell
npm update @modelcontextprotocol/express @modelcontextprotocol/node @modelcontextprotocol/server zod @hono/node-server hono proxy-addr body-parser qs --package-lock-only --ignore-scripts --no-audit --registry=https://registry.npmjs.org --cache .tmp/npm-cache
```

Массовый `npm audit fix` и overrides не применялись. Express остаётся `5.2.1`:
его ranges разрешают исправленные transitives. Новый node SDK явно поддерживает
`@hono/node-server ^1.19.9 || ^2.1.3`; выбранная версия 2.1.5 удовлетворяет этому
range. Новый server использует core 2.4.0. Dev client/core 2.0.0 сохранены:
root core теперь dev-only, production core 2.4.0 вложен под server. Сравнение
lockfile подтвердило неизменность devDependency versions/entries и отсутствие
несвязанных version updates.

### Свежий audit

Источник всех запросов: публичный `https://registry.npmjs.org`, 29.10.2026.
Команда: `npm audit --omit=dev --json --registry=https://registry.npmjs.org --cache .tmp/npm-cache`.
Baseline выполнен до изменения dependencies; обновление base затронуло только
назначение на доске, package/lockfile остались теми же.

| Production finding            | Severity | Advisory                                                                                                                                                                                                                                                                                   |
| ----------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| @hono/node-server             | moderate | [GHSA-rmxm-3fg6-px4f](https://github.com/advisories/GHSA-rmxm-3fg6-px4f)                                                                                                                                                                                                                   |
| @modelcontextprotocol/express | moderate | [GHSA-rvq5-wwqv-78pq](https://github.com/advisories/GHSA-rvq5-wwqv-78pq)                                                                                                                                                                                                                   |
| @modelcontextprotocol/node    | high     | [GHSA-f897-62hf-6gxq](https://github.com/advisories/GHSA-f897-62hf-6gxq)                                                                                                                                                                                                                   |
| @modelcontextprotocol/server  | high     | [response isolation](https://github.com/advisories/GHSA-jm63-cq47-j5jp), [validation memory](https://github.com/advisories/GHSA-46jr-4wx8-v453), [bearer audience](https://github.com/advisories/GHSA-rvq5-wwqv-78pq), [request limits](https://github.com/advisories/GHSA-f897-62hf-6gxq) |
| body-parser                   | high     | [GHSA-27r3-jxmh-p828](https://github.com/advisories/GHSA-27r3-jxmh-p828)                                                                                                                                                                                                                   |
| hono                          | moderate | [GHSA-5r4p-p66f-jhc7](https://github.com/advisories/GHSA-5r4p-p66f-jhc7)                                                                                                                                                                                                                   |
| proxy-addr                    | critical | [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h)                                                                                                                                                                                                                   |
| qs                            | moderate | [GHSA-6pq8-jhm2-2vcw](https://github.com/advisories/GHSA-6pq8-jhm2-2vcw)                                                                                                                                                                                                                   |
| zod                           | high     | [GHSA-mrhx-c7xc-m3w5](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5)                                                                                                                                                                                                                   |

- До: exit 1, 9 vulnerable packages (4 moderate, 4 high, 1 critical), 12 advisory
  entries / 10 unique GHSA. Число 9 в npm summary считает packages, а не unique GHSA.
- После: source exit 0, `vulnerabilities: {}`, все severity counts 0.
  Source audit: 13:36 UTC; portable audit: 13:43 UTC, также exit 0 / 0 findings.
  `metadata.dependencies.prod`: 85 → 86 (npm включает root в этот счётчик).
- Полный audit с dev после обновления: 3 vulnerable packages (1 moderate,
  2 high): dev `@modelcontextprotocol/client`, `brace-expansion` в lint/tooling
  graph и `smol-toml`. Они не входят в production graph и portable install;
  обновление dev tooling оставлено отдельному scope.

### Проверки безопасности и совместимости

- Среда: Windows x64 `10.0.19045`, Node `v24.15.0`, npm `11.12.1`, PowerShell
  `7.6.5`; portable проверяет также Windows PowerShell 5.1. Git использует только
  локальный command option `safe.directory` для этого worktree. Network/install
  и subprocess проверки выполняются разрешённым запуском вне offline sandbox.
- `npm ci --registry=https://registry.npmjs.org --cache .tmp/npm-cache`: PASS
  после bump, 249 installed packages; 3 dev-only audit notices описаны выше.
  До bump также проверена установка старого lockfile с `--ignore-scripts`.
- `npm run build`: PASS. `npm ls --omit=dev` для затронутых packages: PASS,
  разрешённые versions соответствуют таблице, invalid/missing dependencies нет.
- Безопасные probes до/после: `proxy-addr.compile` с `::ffff:10.0.0.0/8` и `::/1`
  до bump доверял внешнему `203.0.113.10`, после — false для обоих. Legitimate
  `10.0.0.0/8` по-прежнему доверяет `10.1.2.3` и отказывает внешнему адресу.
  `z.array(z.number()).max(2).safeParse(Array(1000).fill('bad'))` создавал 1001
  issue, теперь 1; `[1, 2]` принимается до/после. OOM/large-load attack не запускался.
- `node --test --import tsx __tests__/stdio.test.ts __tests__/http-server.test.ts __tests__/http-transport.test.ts __tests__/http-policy.test.ts __tests__/http-shared-guard.test.ts __tests__/subscriptions-listen.test.ts`:
  PASS, 83/83, 0 failures/skips. Проверены реальные stdio subprocess, modern/legacy
  HTTP, auth/413/400/415/405, grants, watchers, cancellation и subscriber cross-talk.
- Source review: новый SDK получает уже parsed body из ограниченного Express
  parser; ни adapter, ни modern/legacy SDK leg не перечитывают его с новым default
  cap. Responses/artifact size caps этим bump не меняются. Зависимость stdio от
  синхронной установки callback покрыта реальными subprocess tests.
- Независимые read-only investigation и один candidate review по skill
  `codex-security:fix-finding`: конкретных обходов/регрессий не обнаружено.
  Reviewer отдельно выполнил 59 transport tests (0 failures/skips) и проверки
  raw body >4 MiB → 413, legacy batch 101 → 400, parsed body 5 MiB → 200.
  Его первый sandbox-запуск остановился на `os.userInfo/ENOMEM` до tests;
  разрешённый запуск прошёл. Новые tracked tests не добавлялись: существующие
  transport suites и bounded probes покрывают изменённый dependency boundary.
- Первоначальный `npm run check` с общим process-level `FS_SNAPSHOT_DIR`:
  static PASS, 505 pass / 3 fail / 8 skip. Ошибка настройки исполнителя:
  общий scratch отменил штатный per-manager test isolation
  (`src/core/snapshot-config.ts`), managers конкурировали за metadata/partial
  artifacts; failures — два bundle scenarios и один HTTP startup (`ENOENT`).
  Настройка удалена; полный повтор с `NODE_ENV=test`, без `FS_SNAPSHOT_DIR`,
  со штатными уникальными temporary test directories: **PASS**, exit 0,
  516 tests / 70 suites, 508 pass / 0 fail / 8 skip. Build, production/test
  types, ESLint, Prettier, Knip — PASS. После финального обновления этой карточки
  повторены только её Prettier check и `git diff --check`.
- Skips: 3 POSIX-only (FIFO, inode/mode, 0222 append metadata) и 5 file-symlink
  cases без Windows privilege (`TC-FUNC-050`, `TC-FUNC-051`, `TC-FUNC-049c`,
  `TC-PG-008`, stat own symlink). Junction и symlinked-parent scenarios,
  доступные текущему Windows account, прошли. Эти skips не объявляются
  проверкой POSIX/file-symlink поведения.

### Portable

- `powershell.exe -NoProfile -ExecutionPolicy Bypass -File scripts/windows-portable/Build.ps1 -NodeArchive <verified-node-archive> -TunnelArchive <verified-tunnel-archive> -OutputDirectory out/Schwarzbeck-MCP-017-review`:
  `PORTABLE_BUILD_PASS`; build и packaged legacy stdio preflight прошли.
  `BUILD.json.sourceCommit`: `683dd3dc1b7235ce3f14d2c9d19db6da59bc571d`
  (dependency checkpoint; дальнейший diff относится только к этой карточке).
  Bundled Node 24.15.0 / tunnel-client 0.0.14; builder проверил штатные SHA-256
  обоих архивов. Runtime pins и builder не менялись.
- Production install: `npm ci --omit=dev --ignore-scripts`, 85 packages,
  0 vulnerabilities. `package.json` и `package-lock.json` в server byte-identical
  source. Независимая проверка прочитала версии всех 85 production lock entries
  из обоих установленных деревьев: `PRODUCTION_GRAPH_PARITY_PASS`.
  Dev client и dev root core 2.0.0 в portable отсутствуют.
- `npm audit --omit=dev --json --prefix out/Schwarzbeck-MCP-017-review/server --registry=https://registry.npmjs.org --cache .tmp/npm-cache`:
  exit 0, пустой findings object; все 9 исходных vulnerable packages устранены.
- `node scripts/windows-portable/Verify.mjs out/Schwarzbeck-MCP-017-review`:
  `PORTABLE_ACCEPTANCE_PASS`, 24/24 scenarios. Проверены перенос с Unicode,
  multiple roots, inherited FS isolation, default tree/explicit stable,
  snapshot/bundle bytes, SHA/CRC и reuse/restart, caps/config negatives,
  junction, PowerShell 5.1 DoctorOnly и отказ force-stop по чужому PID.
  Комплект и synthetic logs/results остаются в ignored `out/` / `.tmp/`.

### Handoff

Все acceptance выполнены в указанной Windows-среде. Изменение готово к
независимой приёмке planning: **ready for review**. Dependency checkpoint
`683dd3dc1b7235ce3f14d2c9d19db6da59bc571d`; итоговый documentation checkpoint
сообщается отдельно в handoff, без самоссылки в тексте commit.

Production findings после source и portable audit: 0; оставшиеся dev-only
findings описаны выше и требуют отдельной задачи. Для advisories SDK, body-parser,
Hono и qs доказательство обновления — patched package graph/audit плюс transport
regressions; все vendor exploit payloads и длительный memory stress не повторялись.
Новый live ChatGPT/tunnel, Linux/remote CI и независимая приёмка этой ветки
оставлены planning; локальные результаты не заменяют их. Центральная доска
не редактировалась. Задача 018 и выпуск пользовательского portable-комплекта
остаются после review/интеграции 017.
