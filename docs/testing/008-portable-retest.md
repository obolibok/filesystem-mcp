# 008 — установка и повторный большой тест

Тестовая сборка содержит исправления 007 и 008. Проверенный runtime commit:
`7bf58e0539054f0338bc797ab832e12e8036c023` (поле sourceCommit в BUILD.json).
Общая инструкция Windows/tunnel/key/подключения находится в README.html.

## 1. Остановить текущий экземпляр

Дождитесь окончания нужных jobs, нажмите Ctrl+C в окне Start.ps1.
Из папки установки выполните Status.ps1: /readyz должен стать недоступен.
Если stopping завис, используйте Stop.ps1 -Force по общей инструкции.
Два экземпляра на одном tunnel_id одновременно не запускайте.

## 2. Развернуть сборку

Можно снова использовать C:\SWB-MCP. После остановки переименуйте прежнюю папку,
например в C:\SWB-MCP-before-008, затем распакуйте новый комплект и поместите его
содержимое в C:\SWB-MCP. Так сохранятся конфигурация, результаты прошлого опыта
и возможность отката. Не смешивайте server/runtime/scripts двух сборок.
Другой вариант — распаковать отдельно в C:\SWB-MCP-008; подставьте этот путь
в дальнейшие команды вместо C:\SWB-MCP.

В корне новой папки должны находиться BUILD.json, Start.ps1 и config.json.
Скопируйте только config.json из прежней папки в новую. Сохраните tunnelId,
roots и лимиты. Для этого опыта используйте новый пустой scratch:
`"scratchDirectory": "./data/jobs"`. Рабочие data/jobs и data/tunnel не переносите.
Если прежнюю папку уже удалили, восстановите эти настройки вручную по README.

Проверьте, что источники те же, что в прошлом большом опыте. Комплект и scratch
должны находиться вне разрешённых source деревьев. API key в JSON не добавлять.

## 3. Проверить и запустить

```powershell
Set-Location 'C:\SWB-MCP'
(Get-Content .\BUILD.json -Raw | ConvertFrom-Json).sourceCommit
powershell -NoProfile -ExecutionPolicy Bypass -File .\Check.ps1
powershell -NoProfile -ExecutionPolicy Bypass -File .\Start.ps1
```

Ожидается нужный SHA и LOCAL_MCP_PASS. Введите прежний runtime key скрыто при
Start.ps1. Во втором PowerShell из папки комплекта вызовите Status.ps1,
дождитесь HTTP 200 /readyz. Обновите метаданные tools существующего подключения
к этому туннелю, откройте новый чат и проверьте list_roots.

## 4. Запрос для ChatGPT

Замените <ROOT> на точный большой корень из list_roots. Если в прежнем опыте
параметры includeHidden/includeIgnored отличались от false, используйте прежние.

> Используй подключение Schwarzbeck. Вызови list_roots, найди <ROOT>.
> Запусти snapshot с явным path этого корня, forceRefresh=true, maxAgeMs=0,
> includeHidden=false, includeIgnored=false,
> idempotencyKey="008-large-20260925-01". Покажи jobId/reason/state.
> Регулярно проверяй job_status, не создавая новых snapshot. Не снижай частоту
> polling специально ради обхода ошибки; фиксируй число вызовов и время.
> Сохрани state, complete, counters, errors, fatalError, stopReason,
> metadataPersistence и artifacts. После появления completed/failed ещё
> проверяй status в течение примерно 10 секунд: terminal metadata может
> сохраняться отдельно. Если metadataPersistence осталось failed, укажи
> отказ сохранения, даже когда основной state=completed. Если recovering —
> дождись исхода и зафиксируй его. Не перезапускай snapshot автоматически.
> При completed получи manifest и все ZIP через get_artifact как реальные
> файлы. Проверь SHA-256, размеры, CRC, CSV row count и уникальность RelativePath
> между частями. Полный inventory не печатай. При complete=false опиши пропуски.
> При failed сохрани полную fatalError и metadataPersistence, включая доступные
> nativeErrorCode/operation/path. Составь Markdown-отчёт, отделив полученные
> файлы и выполненные проверки от того, что проверить не удалось.

Для повторного отдельного прогона используйте ключ 008-large-20260925-02.
Для повтора одного вызова после таймаута сохраняйте исходный ключ и аргументы.
Желательны два последовательных больших прогона: прежняя ошибка была перемежающейся.

## 5. Проверить сохранение результата

После завершения job и дополнительных status-проверок возьмите её jobId и
прочитайте metadata из PowerShell новой установки (пример ниже рассчитан на
scratch ./data/jobs). Это один read после завершения, не постоянное чтение файла
во время опыта. Запустите команды в отдельном окне, где Start.ps1 не работает:

```powershell
Set-Location 'C:\SWB-MCP'
$testedJobId = 'ВСТАВЬТЕ-jobId'
if ($testedJobId -notmatch '^[0-9a-fA-F-]{36}$') { throw 'Expected jobId UUID' }
$metadataPath = Join-Path (Get-Location).Path ('data\jobs\' + $testedJobId + '\job.json')
$durableJob = Get-Content -LiteralPath $metadataPath -Raw -Encoding UTF8 | ConvertFrom-Json
$durableJob | Select-Object jobId,state,complete,finishedAt,counters,fatalError | ConvertTo-Json -Depth 6
```

Ожидается тот же terminal state и counters, что у клиента, а при failed — та же
сохранённая fatalError. Если на диске осталось running, сохраните этот факт и
metadataPersistence из live status. Поле metadataPersistence по контракту только
в памяти: отсутствие в job.json само по себе не доказывает успешную запись.

Затем Ctrl+C, Status.ps1 подтверждает остановку, повторный Start.ps1 с тем же
config и scratch. В ChatGPT вызовите только job_status прежнего jobId, не snapshot.
Ожидается сохранённый completed/failed с теми же итогами (пока не истёк TTL).
Повторно получить manifest тоже полезно. Новый job для проверки restart не нужен.

## 6. Что вернуть

Отчёт, jobId каждого прогона, длительность, счётчики, ошибки, SHA/CRC/CSV,
наблюдения metadataPersistence, сверку persisted job.json и результат restart.
При сетевом отказе — ещё результат Status.ps1 и вывод окна Start.ps1 без ключей.
Инвентарь и архивы с личными путями в Git не публикуйте.

Короткие блокировки записи теперь пережидаются: до 2,5 секунды на запись,
terminal save имеет дополнительное окно 2,5 секунды. Более долгий/постоянный
отказ может оставить последний durable checkpoint; он должен быть виден в
metadataPersistence. Реальный источник прошлой блокировки пока неизвестен.
