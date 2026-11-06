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

- [ ] Ошибка, timeout и invalid JSON дают безопасные и различимые warnings;
      success/non-Windows остаются тихими. Поздний failure не дублирует timeout.
- [ ] Поведение metadata/list_roots/snapshot/bundle и safe failure сохранено;
      сбой logger тоже не превращается в tool failure.
- [ ] Secrets/log-injection sentinel из native errors не попадает в diagnostics.
- [ ] Preflight warning виден при успешном JSON/exit; PowerShell 5.1 DoctorOnly
      продолжает запуск на synthetic warning.
- [ ] Targeted и full check, portable Verify, новая чистая сборка; Work record
      содержит evidence и остающуюся необходимость корреляции с Avast на целевой машине.

## Work record

Текущий planning-чат, собственный изолированный checkout после принятой 020;
новая branch `codex/021-provenance-diagnostics` от main с этой карточкой.
Реализация ещё не начата.
