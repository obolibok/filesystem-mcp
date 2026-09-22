# Переносимая Windows-поставка

Операторская инструкция является частью шаблона поставки:
[README комплекта](../../scripts/windows-portable/template/README.md).
В собранную папку также попадает автономная HTML-копия.

## Сборка сопровождающим

Исходники должны содержать принятые snapshot/bundle. Нужен Node 24 и npm;
зависимости разработчика устанавливаются в checkout через npm ci.
На целевой машине эти инструменты устанавливать не нужно.

Загрузки: Node 24.15.0 Windows x64 из
[официального каталога](https://nodejs.org/dist/v24.15.0/) и полный tunnel-client
0.0.14 Windows amd64 из [официальных releases](https://github.com/openai/tunnel-client/releases).
Сборщик проверяет оба SHA-256; Node hash сверён с официальным SHASUMS256.txt,
tunnel hash совпадает с проверенным в 002/004 полным архивом. Hash не заменяет
проверку publisher signature; tunnel binary ранее наблюдался как NotSigned.
Новые версии сначала проверяются отдельно, затем меняются pins сборщика.

Из checkout, под Windows PowerShell:

```powershell
npm ci
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/windows-portable/Build.ps1 -NodeArchive 'C:\Downloads\node-v24.15.0-win-x64.zip' -TunnelArchive 'C:\Downloads\tunnel-client-v0.0.14-windows-amd64.zip' -OutputDirectory 'C:\SWB-output\Schwarzbeck-MCP'
node scripts/windows-portable/Verify.mjs 'C:\SWB-output\Schwarzbeck-MCP'
```

OutputDirectory должен быть новым. Сборщик не очищает и не обновляет действующие
установки. Он запускает build, копирует dist/package/lock/license, ставит только
production dependencies через npm ci --omit=dev --ignore-scripts, добавляет Node,
полный tunnel archive и шаблоны. Выполняет stdio preflight и записывает hashes.
Проверенный SHA runtime и версии находятся в BUILD.json.
Не менять upstream package/server version ради локальной упаковки.

Verify.mjs работает на копии поставки в ignored .tmp: перенос, Unicode/пробелы,
несколько roots, реальные snapshot/bundle, SHA/CRC/содержимое ZIP, ошибочная
конфигурация, junction, PowerShell 5.1 doctor и отказ emergency stop по чужому PID.
Используется фиктивный ключ только для локального doctor; run не вызывается.
Production roots не нужны. Synthetic копии и отчёты остаются локально.

Результат помещать в ignored out/. В Git коммитятся builder, templates,
инструкция и обезличенные результаты; бинарники, node_modules, keys и jobs — нет.
На новую VM доставлять чистый комплект; рабочие данные и локальную конфигурацию
переносить отдельно по операторской инструкции.

## Приёмка 22.09.2026

- Платформа: Windows 10 Pro x64, build 19045, Windows PowerShell 5.1.
- Bundled Node 24.15.0; tunnel-client 0.0.14; 85 production dependency packages.
- 13 сценариев Verify.mjs — PASS, включая реальную материализацию snapshot/bundle.
- Прежний dependency RE2 WASI init падал при кириллице в argv[1]. Portable launcher
  задаёт ASCII program label, а модуль импортирует по фактическому file URL.
  Server runtime и package dependencies не изменялись; перенос с Unicode проверен.
- Check использует отдельный временный scratch и не открывает рабочие jobs.
- Start.ps1 -DoctorOnly проверен со скрытым вводом synthetic SecureString;
  профиль содержит только env-ссылку, ключа в нём нет.
- Force-stop отказался трогать чужой PID. Настоящий forced shutdown туннеля здесь
  не выполнялся; штатный Ctrl+C был проверен в опыте 004.
- Windows 11/новая VM, корпоративные SMB ACL, реальная новая сессия туннеля/ChatGPT
  на этой поставке ещё не проверялись. Для них есть пошаговый операторский smoke.

Полный repository check и окончательная поставка фиксируются в карточке
[004-portable](../tasks/004-portable-windows.md).
