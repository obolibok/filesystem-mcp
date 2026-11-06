# 020: необязательный runtime key в portable config

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятые 017–019 и portable от 30.10.

## Зачем

Пользователь хочет запускать portable без повторного ввода runtime API key.
Непустой ключ в настройках используется при запуске; пустое или отсутствующее
поле сохраняет прежний скрытый ввод без записи введённого значения.

## Scope и контракт

- Optional top-level `runtimeApiKey` в portable `config.json`, template — пустая
  строка. Отсутствие, null, пустая или whitespace-only строка вызывают prompt.
  Непустая строка после trim используется без prompt; иные JSON-типы отклоняются.
- Ключ хранится в пользовательском config обычным текстом. Пользователь явно
  разрешил этот режим. Интерактивный ввод не сохраняется в config.
- Tunnel получает ключ через прежний `CONTROL_PLANE_API_KEY`, профиль — только
  env-reference. Не добавлять ключ в argv, output, diagnostics или MCP config.
  Ошибка авторизации сохранённого ключа остаётся обычной ошибкой tunnel-client;
  автоматической перезаписи config или второго prompt после неё нет.
- Start.ps1, config helper, template, Verify и операторские docs входят в scope.
  Скрыть содержимое malformed JSON в diagnostics, поскольку config теперь может
  содержать ключ. Не менять source tools, guard, dependencies и runtime pins.
- Проверки только synthetic. Новый чистый portable собирается отдельно;
  установленный сервис/рабочий туннель не перенастраивать.

## Acceptance

- [x] Непустой настроенный ключ используется без Read-Host; старые конфиги и
      пустые/null/whitespace значения сохраняют скрытый ввод без сохранения.
- [x] Неверные типы и malformed JSON отклоняются без утечки synthetic sentinel.
- [x] Key отсутствует в exported configuration, профиль содержит env-reference;
      success/error cleanup освобождает lock и переменную окружения.
- [x] Полный repository check и расширенный portable Verify проходят; новая
      чистая поставка содержит пустой ключ и проверенные hashes.
- [x] Документация и Work record объясняют контракт, проверки и ограничения.

## Work record

06.11.2026. **Ready for review**. Текущий planning-чат выполнил задачу в отдельном
worktree, branch `codex/020-portable-runtime-key`, base с committed карточкой
`769714e8a0c876b7cabeb61bb844f0e21bf2260f`. Исходный main — `46ced0c2`.

### Реализация

- Feature checkpoint `dabb61b1377a55649cc2ae512f58756adacb86ab`: optional поле
  template и выбор ключа в Start.ps1. Прежний interactive путь сохранён, config
  никогда не записывается launcher. Проверена Windows PowerShell 5.1.
- Общий JS helper валидирует тип, исключает runtimeApiKey из exported config и
  выдаёт фиксированную ошибку malformed JSON. PowerShell parser тоже не выводит
  исходный JSON. Профиль по-прежнему содержит env-reference, environment очищается
  в finally. Source tools/guard, dependencies, versions и runtime pins не менялись.
- Обновлены операторские docs. Заполненный пользовательский config хранит ключ
  обычным текстом по прямому запросу пользователя; чистый комплект содержит `""`.

### Проверки

- Windows 10 x64 build 19045, Node 24.15.0, npm 11.12.1, PowerShell 7.6.5 и 5.1.
- `npm ci`: PASS, 249 packages из прежнего lockfile. Наблюдались 14 full-graph
  audit notices (12 moderate, 2 high); зависимости в этой задаче не обновлялись.
  Отдельные свежие source и packaged `npm audit --omit=dev --json`: **0** findings.
- `npm run check`: все static stages PASS; 598 tests / 72 suites,
  **585 pass, 0 fail, 13 skips**. Skips относятся к POSIX/Linux и недоступным
  Windows file-symlink privileges. После уточнения только Verify harness отдельно
  повторены targeted ESLint/Prettier; production-код не менялся.
- Candidate [PR #20 CI #151](https://github.com/obolibok/filesystem-mcp/actions/runs/42197711272):
  Windows и Ubuntu PASS на feature checkpoint. Итоговый head и приёмка — ниже.
- `Build.ps1`: **PORTABLE_BUILD_PASS**, production install (85 packages) и
  packaged stdio preflight PASS. SourceCommit в BUILD.json — feature checkpoint.
- Расширенный `Verify.mjs`: **35/35 PASS**, 0 failures/skips. Прежние delivery,
  tree/stable/restart и config cases сохранены. Дополнительно проверены пять
  вариантов выбора ключа, четыре неверных типа в JS и PowerShell, отсутствие
  writeback/prompt/output leak, exported config redaction, malformed JSON и
  принудительный локальный отказ записи profile после получения ключа/lock.
  Последующий успешный doctor подтверждает освобождение lock.
- Первый Verify остановился на неверной script scope переменной счётчика prompt
  в новом harness. Исправлен на изолированную global scope внутри дочернего
  PowerShell; повторный полный Verify прошёл. Содержимое комплекта не менялось.
- ZIP создан .NET ZipFile, независимо прочитан Python zipfile: точный набор всех
  2,833 файлов, SHA-256 каждого и CRC всех entries совпали. Также проверены
  SHA256SUMS.json, byte parity package/lock и templates, 85 production versions.

### Поставка

- Папка: `out/Schwarzbeck-MCP-020-runtime-key-2026-11-06/`.
- ZIP: `out/Schwarzbeck-MCP-020-runtime-key-2026-11-06.zip`, **71,171,233 bytes**.
- SHA-256: `25a11789b44b60ccf3b607d47a2c1635ea46b40c2455d71aa96476b2f40576df`;
  sidecar `.zip.sha256` находится рядом.
- Распакованная папка: **2,833 файла, 180,000,856 bytes**. Node/tunnel pins —
  24.15.0/0.0.14; исходные архивы проверены builder по штатным SHA-256.
- Ключ пустой, roots — sample-source, tunnel ID пустой, runtime data отсутствуют.
  Новая поставка содержит также уточнения инструкции от 03.11.

### Границы и handoff

Локальные build/check/Verify logs, audit JSON и QA summaries сохранены в ignored
`.tmp/` основного checkout, комплект и ZIP — в его ignored `out/`. Production
service/tunnel не менялись; real keys и cloud requests в проверках не использовались.
Фактическая авторизация сохранённого ключа в живом туннеле остаётся пользовательским
smoke. Центральную приёмку и итоговый CI фиксирует planning после review.

## Интеграция 06.11.2026

**Принято** planning после review diff и локальных проверок.
[PR #20](https://github.com/obolibok/filesystem-mcp/pull/20) слит в main:
`a3af994bdef7651a14792fac35035f318d24e379`, итоговый head
`32e452ed1363b5eeb0f9e3f610bdc0d4b2894171`.
[CI #152](https://github.com/obolibok/filesystem-mcp/actions/runs/42198319160):
полный check на Windows и Ubuntu — PASS. Центральный статус — done.

Review проследил оба способа выбора ключа и finally cleanup, PowerShell 5.1
missing-property поведение, исключение ключа из JS config и diagnostics.
Расширенный Verify 35/35 и ZIP checks относятся к поставке с sourceCommit
`dabb61b1`; последующий diff содержит только harness scope fix и Work record.
Новый пользовательский smoke остаётся отдельным следующим шагом.
