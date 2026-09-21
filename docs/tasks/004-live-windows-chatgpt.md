# 004-live: Windows → ChatGPT, проверка bundle с пользователем

Статус и назначение: [центральная доска](../project/status.md).
Зависимость: code review 004 PASS на `82e8d18756e1787f41379720b5c5dd6f29fe42ca`.
Модель рабочей задачи: GPT-5.6-Sol, effort Extra High (`gpt-5.6-sol`, `xhigh`).

## Результат и формат работы

Провести пользователя по шагам через запуск коннектора на Windows, подключение
к ChatGPT и фактическую доставку bundle. В первом ответе дать короткую карту этапов
и первый выполнимый шаг. Далее — один небольшой блок действий, ожидаемый результат,
проверка ответа пользователя и следующий шаг. Локальную подготовку, чтение кода и
исправление тестовых скриптов выполнять самостоятельно; не просить повторного
разрешения на уже назначенную работу. Не выдавать всё сопровождение одной простынёй.

Результат — проверяемый отчёт о materialization/bytes в ChatGPT, отдельный результат
teardown и обновлённый Work record. Локальный SDK PASS не подменяет живой опыт.

## Контекст и база

- [Brief](../project/brief.md), [workflow](../development/parallel-work.md),
  [Windows runbook](../development/windows.md).
- [Code review PASS](../testing/004-review-r3-2026-09-21.md): R1–R8 закрыты;
  403 tests, 395 pass, 0 fail, 8 skips; локальные ZIP/XLS и 7 MiB volume PASS.
- [Карточка 004](004-selected-originals-bundle.md); после подготовки testing-ветки
  прочитать docs/testing/bundle-live.md, bundle-local-2026-09-20.md и
  scripts/bundle-check. В исходном main runtime 004 ещё отсутствует.
- [Live 003](../testing/003-live-2026-09-20.md): маршрут через Windows tunnel работал;
  после опыта PowerShell более часа оставался в stopping, пользователь завершил
  tunnel вручную. Причина не установлена; не объявлять этот инцидент исправленным.
- Старые ignored profiles, fixtures и ключи не являются переносимым контекстом.
  Их наличие можно проверить локально без вывода секретов; отсутствие не блокирует
  подготовку нового synthetic стенда.

Приложение создаёт отдельный worktree от main с этой карточкой. Использовать его,
второй не создавать; чужие checkout не переключать. В своём worktree создать
ветку `codex/004-live-windows-chatgpt` и объединить текущую базу с точным reviewed
commit `82e8d18756e1787f41379720b5c5dd6f29fe42ca` обычным merge в эту testing-ветку.
Это разрешённая подготовка тестовой базы; main и рабочую ветку 004 не менять.
Commit доступен в общем локальном Git. Не запускать main без bundle и не выбирать
новый непроверенный tip автоматически. При отсутствии commit сообщить планированию
конкретный Git-блокер и продолжать независимую подготовку.

После объединения сверить отсутствие diff относительно reviewed commit для src,
package.json, package-lock.json и серверных конфигурационных файлов. Записать
reviewed SHA и фактический testing HEAD; docs-дельта допустима. Собирать dist только
из своего checkout, а profile должен ссылаться именно на него.

## Scope и владение

Исполнитель владеет этой карточкой, обезличенным docs/testing/004-live-<date>.md,
уточнениями bundle-live.md и небольшими synthetic generators/verifiers при
необходимости. Runtime/API/лимиты/версии не менять ради прохождения опыта.
Найденный runtime-дефект воспроизвести и передать планированию с evidence.
Центральную доску, push/PR/main merge/release оставляет планированию.

Нужен только новый synthetic source root, read-only/root-boundary и отдельный
scratch вне источника. Production roots/файлы не нужны. Не выдавать корпоративные
данные, ключи, tunnel IDs, локальные личные пути и архивы в Git. Секрет вводится
скрыто в локальной выделенной PowerShell-сессии; не просить его в чат и не выводить
env dump. При отсутствии credential продолжать локальные этапы и дать короткий
безопасный шаг для пользователя. Перед актуальными командами подключения сверить
установленный tunnel CLI/help/doctor и при необходимости официальную документацию.

## Последовательность

1. Подготовить testing-ветку и точную сборку, проверить Node >=24, Python и CLI.
   Использовать npm ci/build; повторить необходимый локальный MCP preflight с
   независимым verifier. Полный check уже выполнен на reviewed runtime; повторять
   его при runtime-дельте/новой проблеме либо необходимости проверки интеграции.
2. Создать новый synthetic source/scratch, сохранить независимые эталоны и hash-tree
   до запуска. Для малого опыта использовать существующий originals generator:
   ZIP 703 B и BIFF8 XLS 5632 B, эталоны entries/cells в bundle-live.md.
3. Подготовить отдельный profile с абсолютным dist path, read-only/root-boundary,
   собственным scratch и ограниченными caps. Не переиспользовать работающий чужой
   daemon. Сохранить PID/порты своего server/tunnel при запуске, исключая секреты.
   Проверить doctor, health/ready, затем через ChatGPT list_roots и наличие bundle.
   Текущий рабочий root должен быть ровно synthetic; refresh старого connection
   отделить от доказательства новой runtime-сборки.
4. Провести малый живой опыт по bundle-live.md: stat/expected, bundle, reorder reuse,
   изменённый selection с тем же key → conflict, polling status, отдельный fetch
   manifest и каждой ZIP, распаковка, независимые hashes, nested ZIP и семь XLS cells.
5. Провести multipart: семь ненулевых poorly-compressible originals по 1 MiB,
   несколько подпапок, одинаковые basename в разных папках, Unicode и невыбранный
   контрольный файл. Сгенерировать bytes и независимые hashes до server run.
   Для воспроизводимого split использовать raw-part/ZIP/delivery caps 2097152 B
   (FS_BUNDLE_MAX_RAW_PART_BYTES, FS_SNAPSHOT_MAX_ZIP_BYTES,
   FS_SNAPSHOT_MAX_DELIVERY_BYTES), общий FS_MAX_FILE_SIZE не меньше originals.
   Проверить effective caps; ожидается несколько самостоятельных частей. Получить
   в ChatGPT все части, exact selected set без контрольного файла и весь provenance.
   Не считать прежний metadata snapshot нагрузочной проверкой bundle.
6. Повторить get_artifact для наибольшей части отдельным вызовом с отдельной второй
   материализованной копией; сравнить полные bytes. Нельзя заменить повтор локальным
   копированием первой доставки. Малый negative case: valid + обычный missing
   selector → completed, complete=false, manifest объясняет пропуск; не назвать
   такой результат полным успехом. Не использовать production paths для отрицаний.
7. Сохранить выполненный в принимающей среде verifier и machine-readable JSON:
   jobId/rootId связаны со status/manifest, part IDs/names/entries согласованы,
   size/SHA-256/CRC/exact entry set проверены, validation_errors пуст для positive
   cases. Verifier при несоответствии завершается ненулевым exit. Переданный в чат
   результат manifest без файла и выполненного verifier не является PASS.
8. Сверить пользовательскую evidence с server-side job/artifact hashes, подтвердить
   неизменность source hash-tree. Отдельно записать functional result и teardown.

Ограничиться synthetic наборами выше. Увеличение до предполагаемого верхнего лимита
host не требуется; максимальный реально полученный ZIP записать как наблюдение.
Если файл не материализуется, записать ROUTE_FAIL/INCONCLUSIVE с точным этапом,
а не обходить MCP ручной загрузкой архива или base64 в сообщениях.

## Остановка без повторения часового зависания

После сохранения evidence убедиться, что активных jobs нет. Выполнить штатную
остановку собственных tunnel/server; бюджет ожидания 30–60 секунд, с короткими
проверками состояния. При превышении сохранить очищенную диагностику и завершить
только подтверждённые PID/потомков этого опыта. Не применять общий kill всех node,
powershell или tunnel процессов. Проверить завершение своих процессов, отсутствие
listener и недоступность readyz на своём endpoint.

Записать graceful PASS либо forced-stop/неполную очистку отдельно от delivery PASS.
После аварийной остановки не полагаться на finally: очистить переменную ключа в
сохранившейся выделенной PowerShell-сессии либо закрыть эту сессию. Synthetic
fixture/scratch можно сохранить локально для приёмки. Cleanup не должен удалять
чужие профили или рабочие данные.

## Acceptance и handoff

- [x] Testing HEAD и reviewed runtime сверены; профиль использует новую сборку.
- [x] Малый live ZIP/XLS: materialization, независимые bytes/hashes/CRC/cells PASS.
- [x] Multipart: получены все части, только selected originals, полный provenance.
- [x] Reorder reuse/conflict, repeated largest fetch и partial/missing outcome проверены.
- [x] Verifier code/JSON и timings сохранены; client evidence отделена от server сверки.
- [x] Source hash-tree неизменён; effective caps и максимальный доставленный ZIP записаны.
- [x] Teardown уложился в ограниченный сценарий; graceful/forced результат указан честно.
- [x] Обезличенный отчёт и Work record закоммичены; planning получает фактический SHA,
      локальные/live результаты и оставшиеся вопросы. Production/секретов в Git нет.

## Work record

Статус исполнителя: **ready for review**. Подробные evidence и hashes:
[live-отчёт](../testing/004-live-2026-09-21.md).

- Base/testing branch/runtime SHA: base `bff8eba55d7efc6a5f59097b1a6690226ca1b727`,
  reviewed runtime `82e8d18756e1787f41379720b5c5dd6f29fe42ca`, testing merge
  `b543024e9d7b3ebfa5594785b4d9e4fce8678ea2`, запущенный head
  `8fb9826f188debed8b64f2b4b91c8fd14084cb04`; runtime/config diff отсутствует.
- Подготовка, команды, effective caps и окружение: `npm ci`, build/static и три
  stdio preflight PASS; один read-only synthetic root, отдельный scratch, 2 MiB
  part/ZIP/delivery/file caps, 8 MiB raw job и 16 MiB artifacts job.
- Малый live / multipart / negative / repeat: PASS. Полные jobs 2/2 и 7/7;
  reorder reuse и changed-selection conflict; крупнейшая часть повторно получена
  отдельным вызовом и byte-equal; valid + missing штатно `completed/complete=false`.
- Verifier и независимая сверка evidence: три ChatGPT verifier exit 0,
  `overall_pass=true`; scripts/JSON сохранены локально с SHA-256. Client hashes
  всех artifacts совпали с отдельной server-scratch сверкой.
- Timings, максимальный ZIP, пределы доказательства: server build 36/420/21 ms;
  client submit/fetch timings недоступны. Максимум 1049126 B — наблюдение выбранного
  split profile, не предел host. Проверены synthetic 7 MiB, не production/load max.
- Teardown, остановленные собственные процессы, состояние fixture/profile:
  все jobs terminal; один `Ctrl+C`, owned process exited, readyz недоступен,
  `GRACEFUL_STOP_PASS`, force kill не применялся. Ignored fixture/scratch/profile/
  client evidence сохранены локально для review.
- Итоговый commit, результаты и ограничения для planning: docs commit — HEAD этой
  ветки, точный SHA передаётся в handoff. Push/PR/main merge/центральная доска не
  изменялись; runtime defect не найден, прежний teardown incident не воспроизведён.
