# 007 — установка тестовой сборки и повтор большого snapshot

Это тестовый комплект после code review, до итоговой приёмки большого опыта.
Runtime source commit в BUILD.json должен быть:
`832a6771cd3938947c24329b6d06a512bf5605db`.
Общая инструкция Windows, tunnel, ключа и подключения: README.html рядом.

## 1. Остановить прежний экземпляр

Дождитесь завершения нужных jobs. В старом окне Start.ps1 нажмите Ctrl+C.
Из папки прежнего комплекта выполните Status.ps1 и подтвердите, что /readyz
недоступен. При зависании используйте описанную в README штатную процедуру
Stop.ps1 -Force. Не запускайте две копии на одном tunnel_id.

## 2. Распаковать в отдельную папку

Распакуйте ZIP, затем перенесите вложенную папку комплекта, например в
C:\SWB-MCP-007. В этой папке должны находиться Start.ps1 и BUILD.json.
Прежнюю установку сохраните для отката. Не распаковывайте поверх неё.

Проверьте источник сборки и выполните локальный smoke:

```powershell
Set-Location 'C:\SWB-MCP-007'
(Get-Content .\BUILD.json -Raw | ConvertFrom-Json).sourceCommit
powershell -NoProfile -ExecutionPolicy Bypass -File .\Check.ps1
```

Ожидается LOCAL_MCP_PASS.

## 3. Перенести конфигурацию, создать отдельный scratch

Оба экземпляра должны быть остановлены. Скопируйте только config.json старой
установки в новую, сохранив tunnelId, roots и лимиты. Для этого опыта используйте
новый пустой scratch: `"scratchDirectory": "./data/jobs"`. Не копируйте data/jobs,
data/tunnel и профиль. Старые результаты останутся в прежней установке.

Пример для прежней установки C:\SWB-MCP и новой C:\SWB-MCP-007:

```powershell
Set-Location 'C:\SWB-MCP-007'
Copy-Item -LiteralPath 'C:\SWB-MCP\config.json' -Destination '.\config.json'
$testConfig = Get-Content -LiteralPath '.\config.json' -Raw -Encoding UTF8 | ConvertFrom-Json
$testConfig.scratchDirectory = './data/jobs'
[IO.File]::WriteAllText((Join-Path (Get-Location).Path 'config.json'), ($testConfig | ConvertTo-Json -Depth 10), [Text.UTF8Encoding]::new($false))
```

Проверьте roots в config.json: это должны быть те же доступные источники, на
которых воспроизводился отказ. Новый комплект/scratch должен находиться вне
этих деревьев. Если открыт весь C:/, разместите комплект на другом диске.
API key в конфигурацию не добавлять; он вводится скрыто при запуске.

## 4. Запустить и проверить подключение

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start.ps1
```

Введите сохранённый runtime key. Во втором PowerShell из новой папки:

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File .\Status.ps1
```

Ожидается HTTP 200 /readyz. Используйте существующее подключение к тому же
туннелю, обновите метаданные tools и откройте новый чат. Проверьте list_roots.
Окно Start.ps1 оставьте открытым до окончания опыта.

## 5. Запрос для ChatGPT

Вместо <ROOT> укажите точный корень из list_roots, соответствующий прежнему
большому обходу. Ключ ниже предназначен для одного опыта. Повторы одного
запроса после таймаута используют те же аргументы и тот же ключ; для отдельного
нового опыта измените суффикс ключа.

> Используй файловое подключение Schwarzbeck. Вызови list_roots и найди <ROOT>.
> Запусти snapshot с явным path этого корня, forceRefresh=true,
> idempotencyKey="007-large-20260925-01". Остальные параметры обхода сохрани
> такими же, как в прошлом опыте. Покажи jobId, reason и state.
> Дождись завершения через job_status, не создавая дополнительных snapshot.
> Сохрани итоговый job_status: state, complete, counters, stopReason,
> fatalError, errors и список artifacts.
> Если completed, получи manifest и все ZIP части через get_artifact как
> настоящие файлы. Проверь размеры, SHA-256, ZIP CRC и число CSV-записей
> относительно manifest; заголовок не считать записью. Не выдавай URI или
> обещание скачать за материализованный файл. Полный inventory в ответ не
> печатай. Если complete=false, отдельно опиши счётчики пропусков и ошибки;
> completed само по себе не означает полноту индекса.
> Если failed, сохрани fatalError целиком, включая path/nativeErrorCode/operation
> при наличии, даже если errors уже содержит 20 samples. Не перезапускай job
> автоматически. Составь Markdown-отчёт о результате и неподтверждённых проверках.

При прежних default-параметрах includeHidden/includeIgnored остаются false.
Если прошлый опыт использовал другие значения, передайте их явно.

## 6. Что вернуть планированию

Отчёт, jobId, время/длительность, state/complete, counters, fatalError (если есть),
число/размер частей и результат SHA/CRC/CSV. Реальные пути в диагностике можно
передать локальным файлом; не публикуйте inventory, секреты или ZIP в Git.
Если ChatGPT потерял соединение, сохраните вывод окна запуска и результат
Status.ps1; не меняйте одновременно лимиты и параметры обхода.

Успех: обход завершается и выдаёт проверяемые artifacts несмотря на отдельные
ожидаемые child отказы. При complete=false полнота не заявляется. Новый failure
разбирается по fatalError; неизвестный errno исходного сбоя не считается
подтверждённым только по сходным счётчикам.

После опыта Ctrl+C и проверка остановки через Status.ps1. Для отката остановите
новую копию и запустите прежнюю из её папки с прежним config/scratch.
