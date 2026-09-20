# Synthetic snapshot delivery: ChatGPT live protocol

Воспроизводимый runbook. [Опыт 2026-09-20](003-live-2026-09-20.md) завершён:
smoke/main/upper PASS. Локальный SDK/HTTP PASS сам по себе не доказывает доставку
в принимающую среду; новый клиент или профиль проверяется отдельным опытом.

## Подготовка

1. Собрать текущий commit (`npm ci`, `npm run build`) и запустить тот же checkout
   через актуальный Windows tunnel/profile. Source root — только новый synthetic
   fixture; scratch задать отдельным `FS_SNAPSHOT_DIR` вне source root.
2. Зафиксировать commit, Node/tunnel версии, effective roots, read-only mode и
   snapshot limits. Не записывать tunnel ID, API key или абсолютные личные пути в Git.
3. Fixture должен дать минимум три части при выбранном raw cap. Одна часть должна
   быть около 5,53 MB ZIP; size ladder должен иметь меньшую и большую ступени,
   причём ни одна не превышает локальный ZIP/delivery/file cap.

## Пошаговый опыт в ChatGPT

1. Вызвать `snapshot` с новым idempotencyKey. Записать latency submit, jobId и
   состояние; submit не должен ожидать завершения обхода/сжатия.
2. Повторить тот же submit: ожидаются `reused=true` и прежний jobId. Если wrapper
   скрывает boolean, записать наблюдавшееся явное сообщение reuse и тот же jobId.
   Повторить key с другим параметром и увидеть conflict без второй job.
3. Опросить `job_status` отдельными вызовами до terminal. Записать phases,
   elapsed/counters/errors и подтвердить, что разрыв/новый HTTP-запрос job не теряет.
4. Получить manifest через `get_artifact`; сохранить materialized bytes в analysis
   runtime, вычислить SHA-256 и сравнить с tool metadata.
5. Получить все ZIP-части fixture, содержащего минимум три части, включая около
   5,53 MB. Для каждой записать raw CSV и ZIP bytes, base64 length, latency/timeout,
   SHA-256; выполнить CRC/integrity, распаковку и strict CSV parse. Полный wire size
   записывать только при фактическом измерении, иначе пометить неизмеренным.
6. Суммировать data rows и сравнить с manifest/job_status. Проверить одинаковый
   header, шесть полей, полный synthetic expected set без дублей/пропусков.
   На Windows проверить Unicode/comma/no-extension; quotes/newline в filename
   проверять на допускающей их платформе или в отдельных metadata regressions.
7. Повторно вызвать `get_artifact` для части около 5,53 MB, сохранить новую
   материализованную копию отдельно и сравнить bytes/hash с первым получением.
   Повтор не должен запускать snapshot или подменяться чтением прежней копии.
8. Пройти size ladder до выбранной рабочей границы или первого честного отказа.
   Записать максимальный проверенный файл и наблюдавшийся отказ, если он был.
   Не объявлять успешную ступень или локальный cap верхним пределом принимающего host.

PASS требует materialized manifest и всех частей в ChatGPT, независимых hashes,
распаковки, CSV counts и повторной выдачи. Ошибка одной ступени не отменяет меньшие
PASS, но рабочая граница остаётся ниже первой неуспешной. Production архивы и
inventories в этом опыте не используются.
