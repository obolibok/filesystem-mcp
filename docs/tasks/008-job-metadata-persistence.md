# 008: устойчивое сохранение job metadata на Windows

Статус/назначение: [доска](../project/status.md). Пользователь разрешил реализацию
25.09.2026. Исполнитель: GPT-6-Sol / Extra High, отдельный worktree,
ветка codex/008-job-metadata-persistence. Состояние запуска — на доске.
Зависимость: runtime 007 `832a6771cd3938947c24329b6d06a512bf5605db`.
Планирование готовит committed checkpoint с этим runtime и карточкой; его SHA
передаётся в launch prompt. Если приложение создаёт worktree от main, до правок
внести checkpoint только в свою ветку и проверить отсутствие runtime-дельты
от reviewed 007. Это подготовка базы, не merge в main.

## Проблема и доказательства

[Live 007 и независимый triage](../testing/007-live-2026-09-25.md): большой обход
484710 файлов завершён и проверен, но два других jobs упали при EPERM/rename
внутреннего metadata-tmp -> job.json. Live видит failed/fatalError, persisted
job.json остаётся running на предыдущем checkpoint без fatalError.

В job-manager.ts уже есть serial persist chains и 8 попыток rename с суммарными
задержками 280 ms. GetJob/status running job возвращает данные из памяти.
Не считать доказанной причину «polling читает job.json» и не предлагать редкий
polling как fix. Возможный внешний держатель handle в production не установлен.

## Scope и владение

Владение: core/job-manager.ts, необходимые job types/status schemas, synthetic
regressions, reference и work record этой карточки. Работа последовательна с 007.

1. Сделать замену metadata устойчивой к конечной transient Windows блокировке
   на 1,5 секунды. Bounded retry/backoff должен учитывать остановку, timeout и
   сериализацию записей; ошибки ENOSPC/invalid path/неизвестные IO не превращать
   в безусловные долгие retries. Сохранить atomic replacement и последнюю
   пригодную metadata; не делать unlink destination перед rename.
2. Явно обработать отказ terminal persist. После освобождения кратковременной
   блокировки terminal state и fatalError должны сохраняться в пределах
   документированного recovery window. Исключить молчаливое вечное расхождение
   live failed и durable running. При постоянной невозможности записи нельзя
   обещать durable успех: показать и записать доступную bounded диагностику,
   определить поведение close/restart и проверить его. Не обещать сохранение
   на физически недоступном диске.
3. Не удерживать слот/очередь/close бесконечно, не допускать старой отложенной
   записью перезаписи более нового состояния. Quota, accounting временных файлов,
   cleanup/expiry и отмена остаются согласованными. Любые новые durable файлы
   требуют bounded размера, понятного recovery и совместимости legacy jobs;
   сначала обосновать, нужны ли они вообще.
4. Исправить misleading error sample message: recoverable ACCESS_DENIED не
   описывается как `Job failed`. Использовать безопасный фиксированный текст,
   например `Access denied` / `Sensitive file blocked`; слово skipped допустимо
   только в контексте фактического skip. Не менять code/counters и не выводить
   произвольный текст cause/секреты. Fatal может использовать общий helper:
   не приписывать ему skip автоматически.
5. Сохранить PathGuard, отсутствие чтения sensitive, shared reuse/idempotency,
   bundle и старые metadata. Крупный original walk заново не реализовывать.

Вне scope: production scan, изменение пользовательского комплекта/тunnel/key,
отключение антивируса/проверок доступа, новый общий job state machine, глобальные
retry всех filesystem операций, hand-edited package version, изменения лимитов
source scan или требование снизить частоту status.

## Минимальное воспроизведение

На Windows создать isolated source/scratch и ArtifactJobManager. Producer
после начального running persist открывает отдельным PowerShell-процессом
job.json с FileAccess.Read и FileShare.ReadWrite (без FileShare.Delete),
ждёт сигнала открытия, вызывает ctx.checkpoint. Helper закрывает handle через
50 ms или 1500 ms. Не использовать реальные jobs/production файлы.

На исходном head 50 ms проходят, 1500 ms вызывают failed EPERM/rename и повторный
отказ terminal persist. После завершения worker и освобождения handle сравнить
getJob и JSON на диске, затем close/restart. Контроль: 500 checkpoint без holder,
getJob с интервалом 1 ms — наблюдалось completed и 730 успешных status reads.

## Acceptance

- [x] Воспроизведение показано до fix; реальная Windows handle block 1500 ms
      после fix завершается без потери checkpoint/результата. Короткая и постоянная
      блокировки имеют отдельные tests и bounded ожидание.
- [x] Несколько status callers + частые checkpoint/terminal transitions:
      корректные JSON/state/counters; нет stale overwrite, зависаний и утечек.
      Windows integration test и переносимые deterministic fault tests.
- [x] Ошибка terminal save и последующее восстановление проверены отдельно от
      ошибки промежуточного checkpoint; durable state/fatalError после recovery
      и restart соответствуют контракту. Permanent failure честно диагностируется.
- [x] Cancel/timeout/close остаются ограниченными по времени; retry не записывает
      позднее completed поверх cancelled/interrupted. Non-transient ошибки не
      маскируются, scratch quota и cleanup учтены.
- [x] Non-fatal ACCESS_DENIED больше не говорит Job failed; native diagnostics,
      safe path bounds и bundle/legacy контракты сохранены.
- [x] Полный npm run check и meaningful stress; записаны длительности, retries,
      platform skips и границы доказательств. Production данные не нужны.
- [x] Reference и work record объясняют recovery window, terminal persist failure,
      close/restart и ограничения. Центральный статус ведёт планирование.

## Передача после назначения

Отдельный worktree/ветка codex/008-job-metadata-persistence на подготовленном
планированием checkpoint. Прочитать AGENTS.md, docs/README.md, brief, эту карточку,
triage и parallel-work workflow. Не менять checkout 007 или установленный сервис.
Реализовать, проверить, закоммитить и передать ready for review с фактическим SHA.
Push/PR/merge, live и новая поставка остаются у планирования.

## Work record

Передача исполнителя на review (историческая запись). Исполнитель использовал созданный приложением worktree. HEAD при
старте был detached `2f993a60371b7ce218a0f59b4cf06d5201fe9190` (main с
актуальной карточкой, без runtime 007). Создана ветка
`codex/008-job-metadata-persistence`; сделан только в ней `merge --ff-only`
подготовленного checkpoint `5028c06c352d6e2753e577b8f0a16396c6bdbedb`.
Начальная `git diff --name-status` от reviewed runtime
`832a6771cd3938947c24329b6d06a512bf5605db` была пуста для `src`,
`__tests__`, `scripts`, `package.json`, `package-lock.json`, `server.json`.
Планирование и main не менялись.

До fix новый независимый Windows test открыл synthetic `job.json` отдельным
PowerShell-процессом с `FileAccess.Read + FileShare.ReadWrite` без Delete на
1500 ms. На исходном коде получен `EPERM` при rename; live job стала `failed`,
terminal persist тоже отказал. Тест завершился fail (`Timed out waiting for
completed; got failed`, 13,86 s). Node/tsx под sandbox identity не запускался
из-за `uv_os_get_passwd ENOMEM`, поэтому этот и последующие test/check команды
выполнены локально с повышенным sandbox permission, без доступа к production.

Решение: metadata replacement сохраняет atomic rename и прежний destination;
для transient `EPERM`/`EACCES`/`EBUSY` retry ограничен 2500 ms на запись.
Checkpoint retry принимает worker signal и завершается при cancel/timeout/close.
После первого transient отказа terminal write получает второе окно 2500 ms;
итого recovery до примерно 5 секунд. Terminal writers одной job сериализованы,
старые checkpoint не могут перезаписать более поздний terminal state.
Nontransient ошибки сразу прекращают retry. Новые durable sidecar файлы не нужны:
старый `job.json` остаётся пригодным для startup; metadata-temp ограничен quota,
удаляется после отказа, а неудачное удаление учитывается как orphan.

При исчерпании terminal recovery живой status получает optional
`metadataPersistence` (`recovering`/`failed` и безопасную bounded native
диагностику), и ошибка попадает в server log. Поле не пишется в `job.json`;
успешное восстановление убирает его. Если запись физически недоступна,
после close/restart последний durable `running`/`queued` становится
`interrupted` с `server-restarted`; несохранённый fatalError не выдумывается.
Дополнительного изменения state machine или metadata schema v1 нет.
Non-fatal `ACCESS_DENIED` sample теперь получает фиксированное
`Permission denied`, сохраняет code/counters/path и не объявляет всю job failed.

Целевой набор после fix: 11/11 PASS на Windows/Node 24.15.0, 12,25 s.
Реальный handle 50 ms и 1500 ms: durable `completed`, checkpoint и counters
сохранены; handle 6500 ms: bounded live `metadataPersistence.failed`, durable
остаётся `running`, restart переводит в `interrupted`. Fault injection отдельно
проверил terminal-only failure/recovery/fatalError/restart, permanent EIO и EPERM,
500 checkpoints с четырьмя параллельными частыми status callers, cancel,
timeout, close, nontransient checkpoint, quota и отсутствие metadata-temp после
отказа. В stress 500 checkpoints завершились за 0,75 s; прямой непрерывный
test read `job.json` исключён из status stress, потому что сам создаёт Windows
read handle. Platform skips целевого Windows набора: 0.

Полный `npm run check` на Windows: build/type-check/type-check:test/eslint/
prettier/knip PASS; Node suite 441 tests, 433 PASS, 0 FAIL, 8 platform skips,
39,14 s на окончательном коде. Первые два прохода нашли и исправили соответственно лишний exported
type (Knip) и несовместимое изменение общего fatal `IO_ERROR` message в
существующем test 007. Итоговый fatal fallback `Job failed` сохранён;
non-fatal `ACCESS_DENIED` исправлен отдельно. Количество попыток зависит от
времени, а не фиксировано: nontransient fault дал одну попытку, постоянный
synthetic transient — несколько попыток и ограниченное окно 100+150 ms в тесте;
production окна составляют 2500+2500 ms.
Остаточный риск: источник production lock неизвестен. Недоступный дольше 5 s
destination и постоянный отказ диска не могут получить гарантию durable terminal
state; restart показывает только последнее успешное metadata. Окно ограничивает
ожидание между filesystem attempts, не зависший syscall. Большой production walk,
installed kit и облачный маршрут не проверялись в этой задаче; это остаётся у
планирования после review.

## Приёмка планированием, 25.09.2026

Принята после [независимого review](../testing/008-review-2026-09-25.md),
[portable checks](../testing/008-portable-2026-09-25.md) и
[большого live с проверкой restart](../testing/008-live-2026-09-25.md).
Финальный CI Windows/Ubuntu: по 441 tests, 438/429 pass, 0 fail, 3/12 skips.
[PR #7](https://github.com/obolibok/filesystem-mcp/pull/7) слит в main,
merge `eefc00298045c216ba64dcbce707aa9bc6153d85`.
[Интеграционный протокол](../testing/008-integration-2026-09-25.md)
фиксирует immutable head, CI и изменения tests при интеграции. Live metadata
сохранилась после restart, прежний manifest снова получен без нового snapshot.
