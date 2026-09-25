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

- [ ] Воспроизведение показано до fix; реальная Windows handle block 1500 ms
      после fix завершается без потери checkpoint/результата. Короткая и постоянная
      блокировки имеют отдельные tests и bounded ожидание.
- [ ] Несколько status callers + частые checkpoint/terminal transitions:
      корректные JSON/state/counters; нет stale overwrite, зависаний и утечек.
      Windows integration test и переносимые deterministic fault tests.
- [ ] Ошибка terminal save и последующее восстановление проверены отдельно от
      ошибки промежуточного checkpoint; durable state/fatalError после recovery
      и restart соответствуют контракту. Permanent failure честно диагностируется.
- [ ] Cancel/timeout/close остаются ограниченными по времени; retry не записывает
      позднее completed поверх cancelled/interrupted. Non-transient ошибки не
      маскируются, scratch quota и cleanup учтены.
- [ ] Non-fatal ACCESS_DENIED больше не говорит Job failed; native diagnostics,
      safe path bounds и bundle/legacy контракты сохранены.
- [ ] Полный npm run check и meaningful stress; записаны длительности, retries,
      platform skips и границы доказательств. Production данные не нужны.
- [ ] Reference и work record объясняют recovery window, terminal persist failure,
      close/restart и ограничения. Центральный статус ведёт планирование.

## Передача после назначения

Отдельный worktree/ветка codex/008-job-metadata-persistence на подготовленном
планированием checkpoint. Прочитать AGENTS.md, docs/README.md, brief, эту карточку,
triage и parallel-work workflow. Не менять checkout 007 или установленный сервис.
Реализовать, проверить, закоммитить и передать ready for review с фактическим SHA.
Push/PR/merge, live и новая поставка остаются у планирования.

## Work record

Не начато. Triage и synthetic reproduction выполнены планированием;
реализация разрешена, запуск исполнителя ведёт планирование.
