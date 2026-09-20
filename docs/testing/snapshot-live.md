# Synthetic snapshot delivery: ChatGPT live protocol

Статус: pending после локальной готовности задачи 003. Этот документ описывает
целевой опыт; локальный SDK/HTTP PASS его не заменяет.

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
   состояние; ответ должен прийти до обхода/сжатия.
2. Повторить тот же submit и убедиться, что `reused=true` и jobId совпадает.
   Повторить key с другим параметром и увидеть conflict без второй job.
3. Опросить `job_status` отдельными вызовами до terminal. Записать phases,
   elapsed/counters/errors и подтвердить, что разрыв/новый HTTP-запрос job не теряет.
4. Получить manifest через `get_artifact`; сохранить materialized bytes в analysis
   runtime, вычислить SHA-256 и сравнить с tool metadata.
5. Получить минимум три ZIP-части, включая около 5,53 MB. Для каждой записать raw
   CSV, ZIP и base64/wire sizes, latency/timeout, SHA-256; выполнить CRC/integrity,
   распаковку и strict CSV parse.
6. Суммировать data rows и сравнить с manifest/job_status. Проверить одинаковый
   header, шесть полей, Unicode/quotes/multiline и отсутствие дублей/пропусков в
   synthetic expected set.
7. Повторно вызвать `get_artifact` для части около 5,53 MB и сравнить bytes/hash с
   первым получением. Повтор не должен запускать snapshot.
8. Пройти size ladder до выбранной рабочей границы или первого честного отказа.
   Записать именно наблюдавшийся host/control-plane предел, не переносить API file
   input limit на MCP embedded resource.

PASS требует materialized manifest и частей в ChatGPT, независимых hashes,
распаковки, CSV counts и повторной выдачи. Ошибка одной ступени не отменяет меньшие
PASS, но рабочая граница остаётся ниже первой неуспешной. Production архивы и
inventories в этом опыте не используются.
