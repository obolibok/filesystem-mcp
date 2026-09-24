# 006: общее переиспользование снимков между чатами

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятые 003, 004 и 004-portable; исходный checkpoint `71631de3`.
Пользователь разрешил подготовить и запустить реализацию 2026-09-24.
Рабочая ветка: `codex/006-shared-snapshot-reuse`, отдельный worktree.
Исполнитель: GPT-6-Sol (`gpt-6-sol`), Extra High (`xhigh`).

## Зачем и наблюдаемое поведение

Построение большого индекса занимает, по опыту пользователя, 20–30 минут.
Сейчас snapshot требует idempotencyKey; manager ищет предыдущую job только
по этому ключу. Одинаковый canonical root и параметры с разными ключами создают
разные jobs. Новый чат не знает старого ключа или jobId и повторяет сканирование.
Параллельные запросы одного снимка с разными ключами также дублируют работу.

Нужен выбор на стороне сервиса: вернуть подходящий свежий результат, присоединить
запрос к уже выполняющемуся заданию либо создать новое. Чаты не должны обмениваться
ключами для этого. Явное принудительное обновление остаётся доступным.

Прочитать [brief](../project/brief.md), [workflow](../development/parallel-work.md),
[Windows runbook](../development/windows.md), [architecture](../reference/architecture.md),
[основу jobs/artifacts](../project/snapshot-bundle-design.md) и
[переносимую поставку](../development/windows-portable.md).
Исходные владельцы поведения: src/tools/snapshot.ts, src/core/job-manager.ts,
src/core/job-types.ts, src/core/snapshot-config.ts, src/tools/job-shared.ts,
src/core/path.ts, HTTP/stdio composition и **tests**/snapshot.test.ts.

Эта карточка — разрешённый контракт новой реализации, а не описание уже принятой
возможности. Чужие checkout, production inventories, Downloads и tunnel credentials
для реализации не нужны. Предметная задача 005 сохраняет номер и следует после 006.

## Scope и владение

Изменить snapshot submit и необходимую часть общего manager/storage lifecycle,
schemas/tool instructions, tests, reference и operator documentation. Сохранять
PathGuard/GuardedFileSystem, фоновые producers, лимиты, TTL, delivery integrity,
совместимость существующих snapshot/bundle consumers и read-only источники.

Область переиспользования — один экземпляр сервиса и его устойчивый scratch.
Для HTTP это общий manager разных MCP-сессий; для stdio — один процесс сервера.
Один scratch по-прежнему принадлежит одному процессу. Не объявлять общий кеш
между независимыми процессами/VM, пользователями или deployment без доказательства.
Проверить фактическую границу в composition и описать её для оператора.

Вне scope: автоматический кеш bundle, база индексов, watcher/USN/incremental scan,
распределённые блокировки, отдельный list_jobs/search_jobs, OAuth, domain parsers,
перезапуск незавершённых workers после restart, новый cloud/live прогон и release.
Не менять версии package.json/server.json. Центральную доску ведёт планирование.

## Публичный контракт

### Параметры snapshot

- Сохранить path, includeHidden, includeIgnored и их текущий смысл.
- Сделать idempotencyKey необязательным для snapshot. Если передан, сохранять
  защиту повторной отправки после потери ответа. Старые запросы остаются валидными.
  Схему и обязательность ключа bundle эта задача не меняет.
- Добавить maxAgeMs: целое число от 0 до 30 суток, default 3 600 000 (один час).
  Это допустимый возраст готового снимка, а не TTL хранения. Значение 0 запрещает
  выбор готового результата, но допускает присоединение к queued/running job.
- Добавить forceRefresh, default false. При true новый логический запрос
  обходит и готовые результаты, и выполняющиеся jobs, создавая новое задание.
  Повтор того же явного idempotencyKey с теми же параметрами возвращает уже
  созданное задание; потеря ответа не должна создавать второй forced scan.
- Отсутствие ключа означает автоматический выбор по содержанию запроса.
  Повтор forceRefresh=true без ключа — новый логический запрос, что явно
  объяснить в tool description и инструкции.

Обычный запрос: path=<allowed source directory>, maxAgeMs=3600000.
Новое сканирование с безопасным retry: тот же path, forceRefresh=true,
idempotencyKey="refresh-example-001". Пути в документации только synthetic.

### Порядок выбора

1. Проверить текущий доступ к root и политику. Для уже известного явного ключа
   выполнить idempotent replay с проверкой соответствия запроса и текущего доступа.
   Replay имеет приоритет над свежестью/forceRefresh и сохраняет прежнюю семантику:
   expired/failed job не превращается в новую под тем же ключом.
2. Если forceRefresh=false, выбрать самый новый подходящий готовый снимок:
   state=completed, complete=true, живые опубликованные artifacts, TTL не истёк,
   совпадают содержание запроса и совместимая политика; возраст <= maxAgeMs.
3. Если forceRefresh=false и готового результата нет, найти совместимую queued/running job и вернуть
   её jobId. Свежесть maxAgeMs применяется только к готовым результатам; joining
   выполняющейся job не обещает, что она завершится в этом возрастном окне.
4. Иначе создать новую job с существующими queue/quota ограничениями.

Возраст считать от startedAt, то есть начала построения, а не finishedAt:
долгий обход не становится мгновенно свежим при завершении. Время построения —
интервал наблюдения, не атомарный снимок диска. Для ready result без достоверного
startedAt либо с некорректным временем автоматический reuse запрещён.
При нескольких совместимых кандидатах выбор должен быть детерминированным.

### Совпадение запроса и доступ

Автоматический ключ поиска отделить от клиентского ключа повторной отправки.
Учитывать kind, canonical root, includeHidden/includeIgnored, версию формата/
семантики и эффективную политику доступа/обхода, способную изменить результат.
Разные spelling одного разрешённого Windows пути не должны случайно дублировать
работу; разные roots и значимые flags не должны объединяться.

Выбрать и описать консервативный устойчивый fingerprint политики. Изменение roots,
ограничений обхода, sensitive policy или несовместимой схемы не должно давать старый
результат как эквивалент нового запроса. Не подменять проверку доступа совпадением
хеша. Обе проверки обязательны перед возвратом metadata/artifacts, включая replay.
Не сканировать всё дерево ради проверки свежести: изменения файлов и .gitignore
в источнике регулируются maxAgeMs/forceRefresh, автоматической инвалидации нет.

Новый явный ключ, который выбрал существующую job автоматически, должен устойчиво
привязаться к этому результату: его retry после restart возвращает ту же job.
Отдельно хранить identity запроса для replay: изменение path/flags/maxAgeMs/
forceRefresh у уже использованного ключа даёт conflict; omitted/default значения
эквивалентны. Старые persisted keys без новых полей должны сохранять replay для
старой формы запроса. Определить ограничение роста записей привязки ключей и их
cleanup; нельзя молча забыть живую привязку, а затем принять retry за новую работу.

### Результат и жизненный цикл

Сохранить reused и job. Добавить машинно-читаемую причину выбора, например
created, completed_reuse, inflight_reuse, idempotent_replay, и достаточные
временные данные для оценки возраста/истечения. Точные имена дополнительных полей
можно выбрать при реализации; синхронизировать schema, text и reference.
Не включать новые absolute source paths, ключи других клиентов или большой inventory.

Выбор кандидата и регистрация нового задания должны быть атомарными относительно
других submit: два одновременных обычных запроса без общего ключа запускают один
worker. Нельзя удерживать submit на время обхода/сжатия. Reuse не занимает второй
queue slot, не повторяет producer и не продлевает TTL artifacts.

Failed/cancelled/interrupted/expired и complete=false результаты не кандидаты
для автоматического ready reuse. Они по-прежнему доступны по своему jobId/ключу
с реальным статусом. Присоединившийся запрос видит тот же итог worker, включая
partial/failure. Новый обычный запрос после такого итога может создать новую job.
Отмена общей job отменяет её для всех наблюдателей; ref-count/subscriptions не
добавлять. Потеря соединения одного клиента не отменяет shared worker.

Restart восстанавливает готовые результаты, метаданные поиска и привязки ключей;
queued/running сохраняют текущую семантику interrupted. Старые jobs без доказуемой
совместимости можно исключить из автоматического поиска, сохранив доступ/replay.
Cleanup удаляет связанные индексы/привязки без утечек и гонок с submit/read.
Исчезнувшие/неполные artifacts не выдавать как пригодный ready hit; SHA-256
проверка выдачи остаётся обязательной. Не перечитывать все ZIP при каждом submit.

## Воспроизведение и acceptance

Synthetic source, отдельный scratch, два независимых MCP clients к одному HTTP
server. Доказательства включают jobId, причину выбора, число запусков producer и
SHA-256 полученных artifacts; одного совпадения поля reused недостаточно.

- [x] Повтор в одном клиенте и новый клиент без прежнего jobId/ключа получают
      один свежий готовый снимок; второй обход не выполняется.
- [x] Одновременные запросы без ключей и с разными ключами получают одну queued/
      running job. Проверить гонку с освобождением worker/завершением job и полную
      очередь: пригодный reuse остаётся доступным без нового queue slot.
- [x] Разные roots/flags/политики разделены; canonical Windows aliases учтены.
      Запрещённый root, сужение доступа и restart с изменённой политикой не дают
      metadata/artifacts прежнего более широкого контекста.
- [x] Проверены default age, границы возраста, maxAgeMs=0, forceRefresh при готовом
      и выполняющемся результате, idempotent retry forced запроса и conflicts.
      Использовать управляемые часы/барьеры, не ждать час и не полагаться на sleeps.
- [x] Изменённый synthetic source остаётся старым в допустимом ready reuse и
      появляется в forced/new snapshot. Возраст длинного обхода считается от старта.
- [x] Ready reuse и привязки разных ключей переживают restart. Старый storage
      читается совместимо; interrupted, partial, failure, expiry, missing artifacts
      и очистка metadata не создают ложных hits. TTL не продлевается от обращений.
- [x] Потеря ответа/отключение клиента не отменяет общий worker; explicit cancel
      отражается у обоих клиентов. Integrity и прежние bundle contracts сохранены.
- [x] Выполнен npm run check; проверки на Windows, skips и фактические результаты
      записаны. POSIX-specific поведение покрыть portable тестами для CI и честно
      отделить от того, что локально не исполнялось.
- [x] Обновлены reference, tool instructions, Windows runbook и portable README
      template: общность в пределах процесса, свежесть vs TTL, forceRefresh/retry,
      shared cancellation и отсутствие автоматической инвалидации.
- [x] Подготовлен короткий протокол следующего live опыта с двумя чатами через
      один deployment: готовый reuse, inflight reuse, forceRefresh и проверка
      фактического process lifetime туннеля. Не объявлять локальные clients
      доказательством поведения ChatGPT. Сам live опыт проводится после code review.

## Launch prompt

Реализуй docs/tasks/006-shared-snapshot-reuse.md. Пользователь разрешил начать.
Прочитай AGENTS.md, docs/README.md, brief, карточку и parallel-work workflow.
Используй уже созданный приложением изолированный worktree от main с карточкой;
создай в нём codex/006-shared-snapshot-reuse, если рабочая ветка ещё не назначена.
Проверь base и diff, установи зависимости, воспроизведи проблему на synthetic data.
Выполни реализацию, meaningful regressions, полный npm run check и документацию.
Разрешённые карточкой решения принимай самостоятельно; существенный выход за
контракт передай планированию конкретным предложением. Обнови Work record своей
карточки, не центральную доску. Сохрани результат локальными commits и
передай ready for review: branch/base/head, изменения, acceptance, проверки/skips,
ограничения. Push/PR/merge и live ChatGPT опыт выполняет планирование после review.
Не используй production files, ключи, чужой tunnel/checkout; не публикуй release.

## Work record

Реализация: ready for review. Центральный статус меняет планирование после приёмки.

- Base и branch: `3b7059cc7f2b48b41888b776a5826a706a0ba77a` (`main`),
  `codex/006-shared-snapshot-reuse`, выделенный приложением worktree. Перед правками
  checkout был clean. Исходный key-only путь с двумя разными ключами воспроизведён
  на synthetic source: две jobs/два запуска producer; regression сохраняет это
  наблюдение только для чтения старого persisted контракта.
- Что изменилось и почему: `snapshot` автоматически выбирает самый новый пригодный
  complete result, присоединяется к совместимой queued/running job или создаёт
  новую. `#submitChain` сериализует выбор, регистрацию и cleanup; проверка ready
  artifacts не читает ZIP, а race с завершением worker повторно просматривает
  кандидатов. Ответ содержит `reason`; HTTP endpoint уже владел одним manager и
  guard для разных MCP-клиентов, stdio — одним manager на процесс.
- Контракт и storage: `idempotencyKey` у snapshot optional, у bundle unchanged.
  `maxAgeMs` — 0–30 суток, default 3600000, от `startedAt`; 0 не выбирает ready.
  `forceRefresh` обходит auto ready/inflight, явный key replay имеет приоритет;
  без ключа forced retry создаёт новую job. Отдельные `reuseFingerprint` и
  `requestFingerprint` хранятся в прежнем `schemaVersion: 1` job JSON.
  Автоматическая identity: kind, canonical root, flags, format/semantics version,
  canonical effective roots, boundaries, sensitive deny/allow policy и captured
  result-affecting snapshot limits/scratch. Root и policy проверяются заново до
  metadata/artifact/replay; изменённые traversal limits также закрывают старый
  результат. Старые jobs без reuse proof не участвуют в auto search, прежний key
  и jobId продолжают работать. Дополнительные key bindings сохраняются в job JSON,
  максимум 1024 на job с явным отказом следующему ключу; cleanup удаляет их вместе
  с terminal job. TTL/queue settings не входят в semantic fingerprint; reuse не
  продлевает TTL.
- Проверки: Windows, Node 24.15.0. `npm ci` PASS; `node --test --import tsx
__tests__/snapshot.test.ts` PASS (38/38, 0 skips); `TOOL-SURFACE-002` PASS;
  `npm run check` PASS (build, types, ESLint, Prettier, Knip, 420 tests:
  412 pass, 0 fail, 8 platform/permission skips). Обычный sandbox запуск tsx
  остановился до тестов на `uv_os_get_passwd`; тесты и полный check выполнены с
  разрешённым доступом к системной информации. Первый full check выявил превышение
  бюджета tools/list (15636 > 15200 символов); после сокращения описания повторный
  полный check PASS. POSIX-only ветви локально не исполнялись; ждут CI.
- Acceptance: независимые HTTP clients и один scratch/job producer, SHA-256
  manifest; in-flight гонки с барьерами, full queue, переход worker к completed,
  readiness/0/default age/long walk, force/retry/restart, source mutation,
  roots/flags/alias/policy, partial/failure/missing artifacts, TTL/cleanup,
  shared cancel, legacy JSON и bundle compatibility проверены synthetic tests.
  Reference, tool instructions, Windows runbook, portable README template и
  [протокол двух чатов](../testing/006-shared-snapshot-live.md) обновлены.
- Ограничения и handoff: live ChatGPT/tunnel опыт и CI не выполнялись в coding
  worktree; проводить после code review. Одному scratch по-прежнему нужен один
  процесс, distributed cache/автоинвалидации source нет. Push/PR/merge/release
  исполнитель не делал. Итог сохранён локальным commit; SHA в handoff сообщении.

## Приёмка планированием, 2026-09-24

Реализация принята и интегрирована через [PR #6](https://github.com/obolibok/filesystem-mcp/pull/6).
Code review, live ChatGPT опыт, CI Windows/Ubuntu и обновлённая переносимая
поставка PASS. [Итог интеграции](../testing/006-integration-2026-09-24.md) содержит
head/merge, исправление тестового helper для 8.3 scratch, результаты и ограничения.
