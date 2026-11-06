# 021: диагностика отказов Windows provenance

Статус и назначение: [доска](../project/status.md). Зависимость: 020.

## Зачем и scope

При запуске portable пользователь наблюдал Avast IDP.HELU.PSE96 для powershell.exe.
Предполагаемый источник — вспомогательный provenance query, но скриншоты не
показывают command line/parent и не доказывают причину. Пользователь разрешил
добавить диагностику; переработка работающей цепочки запуска не назначена.

- Сохранить PowerShell scripts/flags, Win32 lookup, 3 s timeout, no-cache,
  best-effort null, MCP schemas и job lifecycle.
- Записывать безопасное warning при ошибке запуска/исполнения/JSON или timeout:
  query machine/volume, номер root в запросе, UTC time/elapsed, server PID и
  helper PID/code/signal, когда доступны. Не объявлять ошибку доказательством Avast.
- Не выводить raw Error, cmd/EncodedCommand, stderr/stdout, environment, секреты,
  UUID/volume identifiers и source paths. Отсутствующие значения не выдумывать.
- Одна запись на отказ lookup; поздний reject после timeout не дублирует warning.
  Сбой logging не должен ломать основной запрос или лишать его timeout.
- Успешный portable preflight должен показать warnings provenance на stderr,
  сохранив JSON stdout и успешный exit. Остальной stderr не раскрывать.
- Scope: provider, его tests, portable check/Verify и operator/reference docs.
  Production service/tunnel/Avast settings и runtime pins не менять.

## Acceptance

- [x] Ошибка, timeout и invalid JSON дают безопасные и различимые warnings;
      success/non-Windows остаются тихими. Поздний failure не дублирует timeout.
- [x] Поведение metadata/list_roots/snapshot/bundle и safe failure сохранено;
      сбой logger тоже не превращается в tool failure.
- [x] Secrets/log-injection sentinel из native errors не попадает в diagnostics.
- [x] Preflight warning виден при успешном JSON/exit; PowerShell 5.1 DoctorOnly
      продолжает запуск на synthetic warning.
- [x] Targeted и full check, portable Verify, новая чистая сборка; Work record
      содержит evidence и остающуюся необходимость корреляции с Avast на целевой машине.

## Work record

06.11.2026. **Ready for review**. Текущий planning-чат повторно использовал
собственный чистый worktree после принятой 020, новая branch
`codex/021-provenance-diagnostics`, base с карточкой
`d882782777a3698b1930688184882add4edbde75`.
Feature/build source: `adc74d5224d49b9dfcc425d57b49af450e43b6f1`.

### Изменения и review

- Provider выдаёт warning через прежний Logger только при query failure/timeout.
  Safe поля создаются явно; raw error/cause, cmd, stdout/stderr, environment,
  paths и UUID/serial не сериализуются. Code/signal ограничены известными значениями,
  exitCode — safe integer. Helper PID берётся из настоящего child process, если
  доступен при ошибке; server PID/time помогают корреляции. Отсутствующие поля
  опускаются. Timeout не выдаёт повторную запись при позднем AbortError.
- Logging failure перехватывается отдельно. Успешные query, non-Windows и обычные
  пустые/невалидные metadata остаются тихими. PowerShell scripts/flags, Win32 calls,
  timeout, parallelism, no-cache, null fallback и MCP schemas сохранены.
- Portable check пересылает только bounded строки warning provenance при success;
  прочий captured stderr остаётся скрытым. JSON stdout и exit code не меняются.
- Self-review diff проследил error/timeout races, safe fields, native PID и stdout
  separation. Новых предположений о причине Avast в runtime не добавлено.

### Проверки

- Среда: Windows 10 x64 build 19045, Node 24.15.0, npm 11.12.1; shell PowerShell
  7.6.5, native helper и DoctorOnly — Windows PowerShell 5.1.
- Targeted `node --test --import tsx __tests__/source-provenance.test.ts`:
  **15/15 PASS**, 0 skips. Пять новых regressions покрывают redaction/root index,
  timeout/late rejection, invalid JSON/unknown codes, throwing logger и quiet success.
  Прежние native Windows, metadata/list_roots и snapshot/bundle restart/legacy tests
  также проходят. Начальные TS typing ошибки новых tests исправлены до прогона.
- `npm run check`: все static stages PASS; **603 tests / 72 suites,
  590 pass, 0 fail, 13 skips**. Skips — POSIX/Linux и недоступные Windows
  file-symlink privileges. Проверки выполнялись без production sources.
- `Build.ps1`: **PORTABLE_BUILD_PASS**, TypeScript build, production install и
  packaged stdio preflight PASS. Runtime pins и dependencies не менялись.
- `Verify.mjs`: **36/36 PASS**, 0 failures/skips. Новый synthetic case добавляет
  warning и отдельный private stderr sentinel к MCP subprocess: Check сохраняет
  успешный JSON/exit, показывает warning и скрывает sentinel. Настоящий PowerShell
  5.1 Start.ps1 -DoctorOnly с этим warning успешно доходит до cleanup marker.
  Все 35 сценариев принятой 020 сохранены.
- ZIP создан .NET ZipFile и независимо прочитан Python zipfile: точный набор всех
  2,833 файлов, SHA-256 каждого и CRC всех entries совпали. SHA256SUMS, template
  bytes, package/lock и 85 production versions также проверены.

### Новая поставка

- Папка: `out/Schwarzbeck-MCP-021-diagnostics-2026-11-06/`.
- ZIP: `out/Schwarzbeck-MCP-021-diagnostics-2026-11-06.zip`, **71,175,059 bytes**.
- SHA-256: `d7c820374521fbaad34ef6f8ac5ba5a74f2cba968aa63eaabe70f5e7e879dbdf`;
  sidecar `.zip.sha256` находится рядом.
- Распакованная папка: **2,833 файла, 180,014,101 bytes**. Node 24.15.0,
  tunnel-client 0.0.14; archive SHA проверены builder. Config чистый: sample-source,
  пустые tunnel ID/runtimeApiKey, runtime data отсутствуют. Включена принятая 020.
- Полные synthetic check/build/Verify logs и QA summaries сохранены в ignored
  `.tmp/` основного checkout, комплект и ZIP — в его ignored `out/`.

### Оставшаяся проверка

Сборка добавляет диагностику и не исправляет предполагаемое срабатывание Avast.
Production service/tunnel, реальные roots/ключи и настройки защиты не менялись.
Нужно повторить запуск на целевой машине и сопоставить новый warning по времени/PID
с событием Avast/Windows. Общая причина `process_error` сама по себе не доказывает
вмешательство антивируса. Итоговый PR CI и приёмка фиксируются ниже после integration.

## Интеграция 06.11.2026

**Принято** planning после review и проверок. [PR #21](https://github.com/obolibok/filesystem-mcp/pull/21)
слит в main: `ebeec54847d25958ac1681b7fb57e1277dcbc78f`.
Проверенный head и BUILD source — `adc74d5224d49b9dfcc425d57b49af450e43b6f1`.
[CI #156](https://github.com/obolibok/filesystem-mcp/actions/runs/42203049178):
полный check Windows/Ubuntu PASS. Центральный статус — done.
Пользовательское воспроизведение с Avast остаётся отдельным следующим шагом.
