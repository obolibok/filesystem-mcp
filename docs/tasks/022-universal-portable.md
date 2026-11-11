# 022: единая portable-конфигурация для stdio и HTTP

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: 020, 021; принятый runtime `main` после 005.
Назначение 11.11.2026: текущий planning-чат реализует задачу в своём изолированном
worktree, ветка `codex/022-universal-portable`.

## Зачем

Пользователь запускает сервер локального агента напрямую через `server/dist/index.js`.
Такой запуск не читает portable `config.json`: scratch уходит в системный TEMP,
tree cap использует общий fallback вместо значения из комплекта. Нужен один
portable-комплект и одинаковый способ настройки для ChatGPT и локального клиента.

Контекст: [«Проверка файлового плагина 2»](https://chatgpt.com/g/g-p-6aa3980f26048191aea335de06a6f5da-swb-rag/c/6af410c1-aee0-83ed-91cb-dddaceaed7ea).
Прочитан доступный текст переписки через read_thread: браузер отключён в Work.
Исходные production paths, IP, PID, job IDs и логи в Git не включаются.
Отсутствие partitioning не установлено: прямой запуск сохраняет общий raw cap,
а превышение закрытого ZIP cap остаётся явной ошибкой без автоматического переразбиения.

## Контракт и scope

- Optional `transport`: `stdio` по умолчанию, `http` явно. Старые config работают.
- Optional `localHttp`: конкретный IP/localhost, порт 1–65535, отдельный `apiKey`.
  Template содержит loopback, порт 8766 и пустой ключ. Wildcard bind не включается.
- `Start.ps1` использует выбранный режим: прежний tunnel flow для stdio,
  прямой foreground HTTP без tunnel ID/runtime key для HTTP. Оба режима read-only.
- HTTP использует отдельный ключ минимум 16 символов: непустой config после trim,
  иначе скрытый prompt без сохранения. `runtimeApiKey` остаётся ключом туннеля.
  Секреты не передаются в argv, не выводятся в diagnostics/print-config и не
  сохраняются в служебные файлы. Прямой `serve.mjs` может использовать HTTP-ключ
  из config или отдельного временного env без интерактивного prompt.
- Единый `serve.mjs` применяет roots, boundary, scratch, snapshot format и limits.
  `--print-config --json` показывает effective config с redaction. Preflight
  всегда изолированно проверяет файловые tools по stdio без запуска listener.
- Один Start на папку комплекта; для одновременного ChatGPT/HTTP — отдельные
  папки и scratch. Status/Stop описывают оба режима без остановки чужих процессов.
- Изменяются portable launchers/config/verifier/operator docs. Ядро, tool schemas,
  auth policy, PowerShell provenance helper, compression и TTL не переделываются.
  Production service/tunnel, firewall и настройки антивируса не меняются.

## Acceptance

- [x] Старый stdio config и все прежние portable scenarios проходят.
- [x] HTTP effective config совпадает со stdio по roots/scratch/format/limits;
      штатный PowerShell 5.1 Start не требует tunnel credentials.
- [x] На synthetic loopback HTTP проходят auth, discovery 13 read-only tools,
      get_file, multipart snapshot, SHA/CRC/readback и reuse/restart artifacts.
- [x] Неверные transport/host/port/key types и короткий ключ отклоняются;
      секреты не попадают в stdout/stderr/argv/state, prompt не меняет config.
- [x] Проверены failure cleanup, перенос/Unicode и отказ при занятом run lock.
- [x] Полный repository check, расширенный Verify, Windows/Ubuntu CI и
      production audit; новая чистая папка/ZIP, SHA-256 и parity всех файлов.
- [x] Инструкция и результаты в Git; комплект и логи в ignored out/.tmp.

## Work record

- Base до назначения: `427d38d5`; implementation начинается от committed карточки.
- До реализации: source/template diff отсутствует, оба checkout чистые.
- Implementation base с карточкой: `e712a6c4`; ветка `codex/022-universal-portable`.
- Изменены только portable config/launchers/verifier и документация. Ядро и
  PowerShell provenance helper не менялись. Неверный HTTP key/host/port и transport
  дают ошибки без вывода значений ключа; default configuration исключает секреты.
- `Start.ps1` сохраняет прежний stdio tunnel flow. HTTP не требует tunnel ID/key;
  DoctorOnly проверяет effective config с redaction без listener. Общий run lock
  предотвращает второй Start в той же папке до ввода ключа.
- `Status.ps1` проверяет HTTP /healthz без credentials и сообщает границу проверки;
  Stop рекомендует Ctrl+C. Force-stop HTTP намеренно отказывает: PID ownership
  для этого режима не добавлялся. Прежняя защита чужого tunnel PID сохранена.
- Полный `npm run check`: 603 tests, 590 PASS, 0 FAIL, 13 штатных Windows skips;
  static/build/types/ESLint/Prettier/Knip PASS. После уточнения verifier выполнены
  targeted ESLint/Prettier и diff check.
- Trial kit собран с pinned Node 24.15.0/tunnel-client 0.0.14. Verify: **51/51 PASS**,
  включая прежние 36 сценариев, legacy config, HTTP auth/discovery/get_file,
  effective-config parity, multipart SHA/CRC/readback/restart/reuse, PowerShell 5.1
  key config/prompt fallback, failure cleanup, run lock и отказ force-stop.
  После добавления rejection cases NUL/non-ASCII key и исправления числового типа
  порта для PowerShell 7 Verify повторён: **51/51 PASS**. Управляющие символы
  запрещены до записи в environment. Source production audit --omit=dev — **0**.
- Реальная клиентская сессия Hermes/LAN, новая сессия ChatGPT и штатный Ctrl+C
  на целевой машине остаются пользовательским smoke. Synthetic HTTP использует
  настоящий Node launcher; PowerShell проверяется через DoctorOnly и injected
  foreground launch failure. Это не подтверждение production deployment.
- Итоговые source/merge/build SHA, CI, audit и комплект записаны ниже.

## Интеграция и поставка 11.11.2026

Принято planning после review diff, проверок и чистой поставки; центральный статус done.

- [PR #22](https://github.com/obolibok/filesystem-mcp/pull/22): implementation head
  `8eef4afbf14057390249d8d341384783f74ce4f8`, merge в main
  `ff8b8e90e6d34b4108e729f665bb9fbe58b96b4c`.
- [PR CI #163](https://github.com/obolibok/filesystem-mcp/actions/runs/42983280831):
  полный check Windows/Ubuntu PASS.
- [Main CI #164](https://github.com/obolibok/filesystem-mcp/actions/runs/42983787014):
  attempt 1 Ubuntu PASS, Windows 597 PASS / 1 FAIL / 5 skips. Упал существующий
  тест `keeps startup available when expired artifact deletion is temporarily blocked`:
  `directoryBytes` в snapshot.test.ts перечислил metadata-tmp, затем получил
  ENOENT при stat во время замены metadata. Этот test helper и job-manager в 022
  не менялись. Запрошен rerun failed jobs без изменения кода; attempt 2 —
  Windows/Ubuntu PASS. Проблемный сценарий дополнительно проверен локально через
  test-name-pattern: **1/1 PASS**. Гонка test helper остаётся отдельным follow-up.
- Чистый portable собран из main `ff8b8e90`, BUILD sourceCommit совпадает.
  Финальный Verify на отдельной копии: **51/51 PASS**. Source и packaged
  `npm audit --omit=dev` — **0 vulnerabilities**.
- Проверены все dist/template/package/lock bytes, версии 85 production packages,
  SHA256SUMS.json и отсутствие runtime data/credentials. ZIP parity всех файлов,
  SHA-256 и CRC PASS. Прежние комплекты не перезаписывались.

### Комплект

- Папка: `out/Schwarzbeck-MCP-022-universal-2026-11-11/`.
- ZIP: `out/Schwarzbeck-MCP-022-universal-2026-11-11.zip`, **69,603,761 bytes**.
- SHA-256: `5de457e08eb28818e08a556aed6384ccb3954f2a1deb19a0212a5730741b4025`;
  рядом sidecar `.zip.sha256`.
- Распакованная папка: **2,833 файла, 180,030,731 bytes**. Node 24.15.0,
  tunnel-client 0.0.14. Default transport stdio; только sample-source, пустые
  tunnelId/runtimeApiKey/localHttp.apiKey; localHttp — loopback:8766.
- Полные check/build/Verify/audit/QA logs остаются в ignored `.tmp/` двух checkout;
  финальные комплект, ZIP и QA — в основном checkout. Git содержит только
  исходники, инструкции и обезличенные результаты.

Для локального агента: распаковать отдельную копию, настроить roots/scratch,
`transport: http` и localHttp.host/port/apiKey; запускать штатный Start.ps1.
Одинаковые roots разрешены, совместное использование scratch двумя процессами — нет.
Сервис, рабочий туннель, firewall и антивирус на целевой машине не менялись.
