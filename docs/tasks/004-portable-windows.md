# 004-portable: переносимый Windows-комплект

Владелец: planning/integration, по прямому поручению пользователя 22.09.2026.
База runtime: e2b963a12b6169cf83ff2b7f1f8602b2097b04e9.

## Результат

До предметного опыта 005 предоставить одну переносимую папку и ZIP:
собранный принятый MCP, production dependencies, Node, полный tunnel-client,
локальная конфигурация, операторские PowerShell-команды и инструкция.
Инструкция покрывает Windows 10/11 x64, plugin, создание tunnel/runtime key,
несколько дисков/UNC, scratch, TTL, проверку, остановку и перенос на VM.

## Границы

Не менять server runtime и версии, не добавлять OAuth, доменные парсеры или
автоустановку Windows Service. Секретов и production данных в поставке нет.
Ключ вводится при запуске; source roots и scratch задаются на целевой машине.
Новая облачная сессия/VM проверяется пользователем по вложенной инструкции.

## Work record

- Добавлены Build.ps1, Verify.mjs и переносимые templates.
- В комплекте есть Node 24.15.0, полный tunnel-client 0.0.14, licenses, dist,
  production dependencies, README.md/README.html, BUILD.json и SHA256SUMS.json.
- Фиксированный read-only launcher канонизирует roots/scratch, задаёт такой же
  FS_ROOT_BOUNDARY и исключает наследование глобального FS_* окружения.
- Добавлены local MCP check, foreground start/doctor, status, emergency stop
  только по проверенному PID/времени создания/дереву процессов.
- Изолирован scratch локального check; исправлена зависимость RE2 от ASCII argv[1].
- 13 Windows acceptance scenarios прошли: relocation/Unicode, multiple roots,
  snapshot/bundle delivery+hash/CRC/content, negative config/junction, doctor,
  отказ stop по постороннему PID.
- [Подробности сборки/приёмки](../development/windows-portable.md).
- Полный npm run check — PASS: 409 tests, 401 pass, 0 fail, 8 platform/permission skips.
- Generated out/.tmp явно исключены из ESLint/Prettier; tracked sources проверяются полностью.
- Именование поставки: out/Schwarzbeck-MCP-2026-09-22 и одноимённый ZIP.
  На целевой машине начать с README.html/README.md и Check.ps1.

Текущий интеграционный статус хранится в docs/project/status.md.
