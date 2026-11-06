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

Runtime provenance берётся на целевой машине при работе MCP, независимо от BUILD.json.
`list_roots` показывает имя/системный UUID хоста и label/серийный номер тома каждого
root; недоступные значения — null без требования elevation. Новые snapshot/bundle
manifest сохраняют `provenance` с абсолютным source path и этими сведениями.
Перенос scratch/restart/reuse сохраняет исходное provenance старых результатов;
старые artifacts без него не дополняются. Windows lookup и обезличенный native smoke:
[runbook](windows.md#происхождение-машины-и-томов).

Verify.mjs работает на копии поставки в ignored .tmp: перенос, Unicode/пробелы,
несколько roots, реальные snapshot/bundle, SHA/CRC/содержимое ZIP, ошибочная
конфигурация, junction, PowerShell 5.1 doctor и отказ emergency stop по чужому PID.
Используется фиктивный ключ только для локального doctor; run не вызывается.
Production roots не нужны. Synthetic копии и отчёты остаются локально.

Результат помещать в ignored out/. В Git коммитятся builder, templates,
инструкция и обезличенные результаты; бинарники, node_modules, keys и jobs — нет.
На новую VM доставлять чистый комплект; рабочие данные и локальную конфигурацию
переносить отдельно по операторской инструкции.

## Эксплуатация и сроки

Ошибки Windows metadata query (021) видны как `[warning] [source-provenance]` на
stderr MCP и успешного portable preflight. Safe поля позволяют сопоставить время,
PID и код с журналом защитного ПО; причина антивирусом не объявляется автоматически.
Подробности — в [диагностике комплекта](../../scripts/windows-portable/template/README.md#диагностика-метаданных-windows).
Получение metadata остаётся best-effort, launch scripts/flags и source policy сохранены.

Optional `runtimeApiKey` в config.json (020) позволяет стартовать без повторного
ввода ключа. Непустая строка используется после trim; отсутствие, null, пустая или
whitespace-only строка сохраняют скрытый prompt без записи введённого ключа.
Иные типы отклоняются. Это хранение ключа обычным текстом в пользовательском config;
чистый template содержит пустую строку. Launcher оставляет профиль с env-reference,
не публикует ключ в MCP configuration и очищает runtime environment после работы.
Условия и пример — в [разделе 3 инструкции](../../scripts/windows-portable/template/README.md#3-создание-туннеля-и-runtime-api-key).

Свежесть snapshot задаётся в каждом tool call через `maxAgeMs` (default 1 час
от начала обхода) и `forceRefresh`. Модель выбирает их по задаче и указаниям
пользователя; отдельной настройки default freshness в config.json/env нет.
`limits.FS_SNAPSHOT_RESULT_TTL_MS` отвечает за хранение всех manifest/ZIP snapshot
и bundle: default 24 часа после завершения job, максимум 30 суток. Раздельных
сроков по типу или размеру выгрузки сейчас нет. Детали повторной выдачи и restart —
в [разделах 6–7 инструкции комплекта](../../scripts/windows-portable/template/README.md#6-минимальная-проверка-перед-рабочими-данными).

Для параллельных экземпляров, в том числе из разных аккаунтов, нужны отдельные
папки portable, tunnel IDs, runtime keys, подключения и scratch. Roots могут
совпадать; jobs/artifacts и автоматический reuse у разных процессов отдельные.
Для каждого подключения проверяются workspace association и разрешения. Условия
и граница проверки — в [инструкции комплекта](../../scripts/windows-portable/template/README.md#два-экземпляра-на-одном-компьютере).

Обновление текста template само по себе не меняет уже собранный ZIP. Поставка
[017–019 от 30.10](../testing/017-019-portable-2026-10-30.md) и её hashes сохраняются.
Поставка [020 от 06.11](../tasks/020-portable-runtime-key.md) содержит optional
runtime key и уточнения инструкции от 03.11 в README.md/README.html.
Поставка [021 от 06.11](../tasks/021-provenance-diagnostics.md) включает 020 и
безопасные warnings Windows provenance/preflight; формат запуска helper сохранён.

## Формат snapshot (016)

Шаблон содержит `"snapshotFormat": "tree"`; отсутствие поля также выбирает tree.
Явное `"snapshotFormat": "stable"` возвращает прежний file-only CSV/manifest.
Оба режима публикуют один snapshot и 13 read-only tools. Любой иной тип/значение
отклоняется до старта MCP. Launcher после очистки inherited FS_* явно задаёт
FS_SNAPSHOT_FORMAT из config; inherited env не меняет выбор.

Прежний optional boolean experimentalSnapshotTree принимается и валидируется,
но игнорируется при выборе формата. Даже false/отсутствие не возвращает stable.
FS_EXPERIMENTAL_SNAPSHOT_TREE больше не влияет на discovery; snapshot_tree убран.
После изменения нужен restart; сохранённые stable/tree jobs и artifacts доступны
через status/fetch/cancel по прежним policy/limits/TTL. Совместимая 014/015 tree
job переиспользуется новым snapshot; cross-format reuse и replay запрещены.

Verify проверяет default tree, явный stable, restart/reuse, оба manifests и bytes,
ошибочные типы/значения и изоляцию от inherited FS_SNAPSHOT_FORMAT. Проверка
работает только с synthetic данными; tunnel run не вызывается. Сборку для
пользователя и live-проверку выполняет planning после независимого review.
Формат и первоначальные измерения: [014](../testing/014-snapshot-tree.md).

Настройка [015](../tasks/015-snapshot-tree-settings.md): optional
`limits.FS_SNAPSHOT_TREE_MAX_RAW_PART_BYTES` задаёт только tree raw part cap.
Шаблон содержит 16777216 (16 MiB) рядом с общим stable cap 47185920 (45 MiB);
удаление tree ключа возвращает fallback на общий cap. Portable принимает только
целое JSON-число в диапазоне 65536–536870912, отклоняет неверное значение до
запуска MCP и очищает inherited FS_* перед применением config. Ключ не выбирает
формат. Tree manifest и automatic reuse используют effective cap;
stable fingerprint/reuse/bytes сохраняются. Общие ZIP/delivery/job/quota/TTL
ограничения не меняются; меньший raw cap не гарантирует compression ratio.

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

## Обновление 24.09.2026

Поставка с принятым общим snapshot reuse: out/Schwarzbeck-MCP-2026-09-24,
рядом ZIP и SHA-256. Локальные 13 portable scenarios PASS; живой опыт двух
ChatGPT-чатов и штатный Ctrl+C PASS. Обновлённая инструкция входит в комплект.
[Итоги, источник сборки и контрольная сумма](../testing/006-integration-2026-09-24.md).
