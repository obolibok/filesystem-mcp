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

- [ ] Старый stdio config и все прежние portable scenarios проходят.
- [ ] HTTP effective config совпадает со stdio по roots/scratch/format/limits;
      штатный PowerShell 5.1 Start не требует tunnel credentials.
- [ ] На synthetic loopback HTTP проходят auth, discovery 13 read-only tools,
      get_file, multipart snapshot, SHA/CRC/readback и reuse/restart artifacts.
- [ ] Неверные transport/host/port/key types и короткий ключ отклоняются;
      секреты не попадают в stdout/stderr/argv/state, prompt не меняет config.
- [ ] Проверены failure cleanup, перенос/Unicode и отказ при занятом run lock.
- [ ] Полный repository check, расширенный Verify, Windows/Ubuntu CI и
      production audit; новая чистая папка/ZIP, SHA-256 и parity всех файлов.
- [ ] Инструкция и результаты в Git; комплект и логи в ignored out/.tmp.

## Work record

- Base до назначения: `427d38d5`; implementation начинается от committed карточки.
- До реализации: source/template diff отсутствует, оба checkout чистые.
- Проверки и итоговые source/merge/build SHA будут записаны после выполнения.
