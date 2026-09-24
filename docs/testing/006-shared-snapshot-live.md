# 006: следующий live опыт с двумя ChatGPT-чатами

Проводить после code review на одном обновлённом Windows deployment. Локальные
MCP clients и synthetic tests не доказывают поведение ChatGPT/tunnel. Использовать
только synthetic source с несколькими файлами и отдельный scratch; не переносить
inventory или ключи в протокол.

1. Записать проверенный commit, время запуска `Start.ps1`, PID сервера и туннеля,
   адрес health/ready без credentials, `FS_SNAPSHOT_DIR`, synthetic root и TTL.
   В обоих чатах проверить одинаковые roots и доступность одного deployment.
2. Чат A отправляет обычный `snapshot` без ключа; записать `jobId`, `reason`,
   `startedAt` и число job directories в scratch. После завершения получить manifest
   и ZIP, проверить SHA-256 полученных bytes. Чат B, без передачи jobId/ключа,
   отправляет такой же запрос: ожидаются `completed_reuse`, тот же jobId и те же
   hashes; число producer jobs не растёт.
3. Для inflight проверки чат A запускает `forceRefresh=true` с новым явным ключом
   на достаточно большом synthetic fixture. Пока job queued/running, чат B
   отправляет обычный запрос с `maxAgeMs=0`: ожидаются `inflight_reuse` и тот же
   jobId. Зафиксировать состояние до завершения и отсутствие второго producer.
   При потере ответа A повторяет forced запрос с тем же ключом и получает
   `idempotent_replay`.
4. Чат B запускает `forceRefresh=true` с другим ключом после завершения и получает
   новый jobId. Проверить его manifest/ZIP hashes и отличие synthetic source,
   если fixture изменён контролируемо между обходами.
5. Перед каждым шагом проверить тот же PID сервера и туннеля через `Status.ps1`
   и `/readyz`; записать uptime или start time. Если туннель/сервер перезапустился,
   отделить restart ready reuse от совместного inflight опыта и повторить последний
   на одном непрерывном процессе. После опыта штатно остановить tunnel/server,
   проверить исчезновение PID и недоступность readyz. Не записывать tunnel ID/API
   key в Git.

PASS: два независимых чата получили один готовый job и один inflight job, полученные
bytes совпали с SHA-256, второй producer не стартовал, forced scan дал новый job,
а lifetime процесса был проверен. Локальный PASS и URI без материализованных bytes
не заменяют эти наблюдения.
