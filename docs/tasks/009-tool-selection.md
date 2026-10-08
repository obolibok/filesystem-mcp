# 009: выбор инструментов для инвентаризации и понятные результаты

Статус и назначение: [центральная доска](../project/status.md).
Зависимость: принятые 007+008. Исходный main: `18f6cf87606d6d831b5ce46ba646cfdaa8955b7e`.
Пользователь разрешил постановку и передачу исполнителю 08.10.2026.
Исполнитель: отдельная задача GPT-6.1-Sol / Extra High, ветка
`codex/009-tool-selection` в собственном worktree. Launch checkpoint с этой
карточкой передаёт планирование; его наличие проверяется до правок.

## Зачем

На запрос о количестве доступных файлов модель сначала применила find_files
с широким glob и большой страницей, получила усечённую выдачу, затем перешла
на snapshot и job_status. Запрос был проверкой естественного выбора создания
индекса. Пользователь явно исключил новый count_files: отдельный инструмент,
режим count-only или inventory_stats не нужны.

Нужный результат: по просьбе об индексе, инвентаризации или рекурсивном охвате
всего дерева модель получает ясное основание сразу выбрать существующий
snapshot. Поиск конкретных имён остаётся find_files. Ответы должны передавать
область обследования, неполноту и свежесть результата, не создавать ложной
уверенности, что завершённый обход описывает все физические файлы диска.

## Контекст и доказательства

Экспорт пользовательского диалога содержит объяснение самой модели и приведённые
ею параметры/счётчики, а не полный сырой wire trace. Это наблюдение о поведении,
не доказательство её внутренней причины выбора. Экспорт и личные пути не нужны
исполнителю и не включаются в Git. Проверка текущего кода подтвердила:

- `src/instructions.ts`: INSTRUCTIONS_SUMMARY предлагает универсальную цепочку
  list_roots -> list/find_files -> stat -> read; path_resolution также требует
  list/find_files без исключения для уже известного root. Snapshot отсутствует
  в кратком правиле выбора. Подробная справка есть, но требует отдельного чтения.
- `src/tools/find-files.ts`: description не объясняет общий scan cap и отличие
  от полного индекса. maxResults задаёт размер страницы, а produce использует
  MAX_SEARCH_RESULTS; пагинация не продолжает обход за пределом найденного набора.
  Текущий MAX_SEARCH_RESULTS в `src/core/util.ts` равен 10000.
- `src/tools/snapshot.ts`: description начинается с reuse/queue, не с задачи
  инвентаризации. Строятся CSV/ZIP metadata, исходное содержимое не копируется.
- `src/core/fmt.ts` и find-files: предупреждение stoppedReason следует после
  списка путей, где может потеряться при обрезке большого ответа клиентом.
- `src/tools/define.ts`: outputSchema намеренно не публикуется. Если run возвращает
  text, structured уходит в _meta; без text доступны JSON text и structuredContent.
  Поэтому комментарии к внутренней output-схеме сами по себе не обучают модель.
- `src/core/snapshot-pipeline.ts`: filesWritten считает записанные CSV-записи;
  directoriesVisited включает открытый root; entriesSeen считает перечисленные
  entries без root; inaccessibleSkipped также увеличивается при отказах каталогов,
  итерации и чтения ignore rules. Это не гарантированное число уникальных файлов.

Предыдущая приёмка: [интеграция 007+008](../testing/008-integration-2026-09-25.md).
Рекомендации по описаниям и оценке выбора инструментов:
[OpenAI: Optimize Metadata](https://developers.openai.com/plugins/guides/optimize-metadata)
и [Function calling](https://developers.openai.com/api/docs/guides/function-calling).
Сначала сверять локальный контракт; внешняя рекомендация не меняет scope.

## Scope и владение

Основные файлы: `src/instructions.ts`, `src/tools/find-files.ts`,
`src/tools/snapshot.ts`, `src/tools/job-status.ts`; при необходимости минимальные
правки соседних descriptions, `src/core/fmt.ts`, wire tests и reference.
`src/tools/define.ts` и job-shared изучить для понимания доставки текста, но общий
wire envelope и API не перерабатывать. Центральную доску ведёт планирование.

1. Согласовать короткое правило выбора на уровне сервера, get-help/resource и
   descriptions. Публичный текст оставить английским, без большого дублирующего
   руководства в каждом tool. Правила должны быть доступны из tools/list без
   обязательного чтения help и сохранять корректный read-only профиль.
2. find_files: поиск конкретных имён/шаблонов с ограниченной выдачей; назвать
   действующий общий cap из существующей константы, отличить его от page size,
   указать, что cursor не обходит cap. Для полного дерева/индекса и рекурсивного
   подсчёта направлять на snapshot. Не запрещать обычный поиск в больших корнях.
3. snapshot: начать с создания/reuse рекурсивного индекса metadata и больших
   инвентаризаций. Известный root из list_roots достаточен; предварительный
   find_files с универсальным glob не нужен. Сохранить reuse, maxAgeMs,
   forceRefresh/idempotencyKey и shared job semantics. Для сводных счётчиков
   достаточно финального job_status; artifacts нужны, когда требуется сам индекс.
   Snapshot остаётся ограничен quota/deadline/политиками, не обещать unlimited scan.
4. Правила маршрута:

   | Запрос                                                                | Маршрут                                |
   | --------------------------------------------------------------------- | -------------------------------------- |
   | Доступные корни                                                       | list_roots                             |
   | Содержимое конкретной папки                                           | list                                   |
   | Конкретное имя/шаблон                                                 | find_files                             |
   | Текст внутри файлов                                                   | search_text                            |
   | Полный индекс дерева, инвентаризация, сколько файлов видно рекурсивно | snapshot -> job_status                 |
   | Получить индекс для анализа                                           | snapshot -> job_status -> get_artifact |
   | Прочитать текст                                                       | read                                   |
   | Получить один original                                                | get_file                               |
   | Получить выбранные originals                                          | bundle -> job_status -> get_artifact   |

   Несколько roots не сводить молча к первому. Не выдумывать пути; выбрать
   область по запросу и list_roots. Не добавлять отдельный routing tool.

5. При усечении find_files cap/timeout сделать короткое предупреждение видимым
   ДО списка путей. Различать ещё доступные страницы и окончание ограниченного
   scan. Сохранить cursor/resource/metadata и относительные пути. Если меняется
   общий formatter, не направлять content-search запросы на metadata snapshot.
   Не обрезать дополнительно сами результаты и не менять search limits.
6. Сделать смысл job_status понятным через опубликованное description/help,
   сохранив его structuredContent и поля ответа. Не добавлять text так, чтобы
   общий wrapper спрятал JSON в _meta. Различать running progress, successful
   terminal state, failed/cancelled/interrupted и complete. Объяснить:
   - completed не равно complete=true и не означает весь физический диск;
   - filesWritten — вошедшие в индекс файловые записи, не original bytes;
   - inaccessibleSkipped нельзя арифметически прибавлять к числу файлов;
   - directoriesVisited включает root; entriesSeen не является числом файлов;
   - scope, flags/exclusions и время наблюдения существенны; snapshot не atomic;
   - reuse не доказывает состояние источника сейчас. Не включать forceRefresh
     автоматически; просьба о свежести должна учитывать existing maxAgeMs semantics.
     Основные ограничения вынести кратко в видимые descriptions, подробности в help.
7. Сохранить tool count, названия, параметры/defaults, поля/counters/state machine,
   outputSchema policy, annotations, PathGuard/GuardedFileSystem, source read-only,
   TTL/quota/reuse/cancellation и поведение доступа к artifacts. Не маскировать
   side effects snapshot/bundle ради более охотного выбора клиентом.
8. Обновить reference и подготовить `docs/testing/009-tool-selection.md`:
   компактный набор естественных prompts, ожидаемые маршруты, способ снять
   фактическую последовательность вызовов и оценить формулировку результата.
   Реальный выбор LLM измеряется отдельно, а не объявляется гарантированным тестом
   строк. Live после review ведут планирование и пользователь.

Вне scope: count_files/inventory_stats/count-only, постоянный индекс или БД,
доменные парсеры, новый MCP tool/AI router, переименование API, рост scan caps,
полная миграция общего response envelope, конфигурация установленного комплекта,
production scan, tunnel/Sleep/Ctrl+C, прежний Windows PowerShell test timeout,
version bumps и публикация release. Внешние API ключи для локальной работы не нужны.

## Воспроизведение и проверки

Сначала снять фактически опубликованные descriptions и исходные ответы через
существующий test harness. Использовать только synthetic source/scratch.
Для cap/timeout и pagination переиспользовать существующие seams/fixtures;
не добавлять длительный большой filesystem scan в обычный CI без необходимости.

Значимые локальные проверки: предупреждение видно до путей; полная и неполная
выдача различаются; последующие страницы не обещают продолжить truncated scan;
job_status сохраняет structuredContent и исходные счётчики, даже если help стал
подробнее; для read-only профиля не предлагаются отсутствующие mutating tools.
Не писать большие snapshots точной формулировки prose или tests, которые лишь
повторяют реализацию. Проверить фактический wire и public contract.

В набор live prompts включить RU/EN формулировки без названий tools: построить
индекс, обследовать дерево для дальнейшего анализа, количество доступных файлов
как один из индикаторов маршрута, найти конкретный файл, найти текст, получить
один/несколько originals. Отдельные условия: несколько roots, incomplete result,
готовый reused snapshot, требование свежего результата, запрос самого CSV/ZIP.
Для каждого указать допустимый маршрут и недопустимые лишние действия; не
требовать фиксированного числа status polls или вызова при уже известном результате.
Не расширять сравнение на разные модели/клиенты без фактического доступа.

## Acceptance реализации

- [x] Модель получает согласованные правила выбора из опубликованных tool metadata
      и краткой серверной инструкции; инвентаризация явно сопоставлена snapshot,
      targeted search — find_files, без обязательного широкого поиска перед индексом.
- [x] В find_files понятны общий cap и page size; cap/timeout предупреждение
      предшествует путям, cursor и metadata сохранены; соседний search_text корректен.
- [x] Job status и руководство не приравнивают completed к полноте, не называют
      inaccessibleSkipped числом дополнительных файлов; JSON остаётся видимым.
- [x] API и политики источников/артефактов не изменены; read-only профиль корректен,
      новых инструментов и count-only режима нет.
- [x] Значимые regression/wire checks и полный npm run check PASS; фактические
      full/read-only размеры tools/list измерены. Сначала сокращать дублирование,
      любое необходимое увеличение budget обосновать измерением и записать в Work record.
- [x] Reference, Work record и протокол проверки выбора готовы. В record разделены
      локальная проверка контракта и ещё не выполненная live оценка поведения LLM.

## Приёмка планированием после review

Сверить diff и CI, затем повторить prompts в чистых чатах с реально обновлённым
каталогом tools. Измерить первый содержательный tool, лишние вызовы, объём выдачи,
корректность scope/freshness/неполноты. До результата не обещать, что descriptions
гарантируют правильный выбор. Новую поставку и живой опыт организует планирование.

## Launch prompt

Реализуй docs/tasks/009-tool-selection.md. Пользователь разрешил реализацию;
запрос количества файлов был проверкой выбора snapshot, count_files не нужен.
Работай на GPT-6.1-Sol / Extra High в выделенном worktree от опубликованного
checkpoint с карточкой. Прочитай AGENTS.md, docs/README.md, brief, workflow,
карточку и фактические wire contracts. Создай codex/009-tool-selection только
в своём checkout. Выполни работу и проверки, обнови Work record, сделай локальный
commit и передай ready for review с SHA, diff summary, проверками и ограничениями.
Центральную доску, push/PR/merge, пользовательский runtime и live не меняй.

## Work record

08.10.2026: **ready for review**. Локальная реализация и контрактные проверки
завершены; acceptance планирования и live выбор LLM ещё не выполнялись.

- Base: `fcb801909a8861e590fc59802f4922079776e773` (launch checkpoint с карточкой).
  Checkout перед началом чистый, HEAD совпадал с checkpoint. В существующем
  выделенном worktree создана ветка `codex/009-tool-selection`; второй worktree
  не создавался. Итоговый head передаётся в handoff после локального commit.
- Правило выбора согласовано в server instructions, get-help/resource и трёх
  опубликованных descriptions. Recursive index/inventory/file total ведёт к
  snapshot, names/globs — к find_files. Известный root достаточен; multiple roots
  требуют выбора scope. Для summary counters достаточно конечного job_status,
  artifacts нужны для самого индекса/уточнения manifest или originals.
- find_files публикует действующий MAX_SEARCH_RESULTS=10000, отличие scan cap
  от maxResults page size и невозможность возобновить capped/timed-out scan
  cursor-ом. Удалены ненужные optional metadata/replace_text предложения.
- Общий formatter разделён на scanWarning и pageTrailer. Find/content search
  показывают warning до rows на каждой странице, включая final; trailers,
  относительные paths, cursor/resource и metadata сохранены. Content search
  не перенаправляется на metadata snapshot; limits не изменены.
- Job status сохранён без собственного text: JSON text и structuredContent
  остаются видимыми. Description/help объясняют provisional progress,
  completed/complete, filesWritten и inaccessibleSkipped, root/flags/exclusions
  и interval/freshness. Код создаёт queued job с complete=true, поэтому help
  явно связывает вывод о полноте с уже completed snapshot. Entries/directories
  разобраны в подробной справке. Reuse/maxAgeMs/forceRefresh/idempotencyKey,
  TTL/cancellation и честные scratch side effects сохраняются.
- API, input schemas/defaults, output fields/counters/states, outputSchema
  policy, annotations и full/read-only tool counts не изменены. Actual
  tools/list до/после сравнен через synthetic SDK harness: все поля контрактов,
  кроме трёх descriptions, совпадают. PathGuard/GuardedFileSystem и producers/
  job lifecycle не менялись.

### Tools/list budget

Измерение `JSON.stringify(result.tools).length`; bytes в UTF-8. JSON-RPC
envelope и tokenizer не включены.

| Профиль   | Tools | До: chars / bytes | После: chars / bytes |               Ceiling |
| --------- | ----: | ----------------: | -------------------: | --------------------: |
| Full      |    19 |     25206 / 25224 |        25732 / 25750 | 26900 (без изменения) |
| Read-only |    13 |     15126 / 15134 |        15652 / 15660 |    15900 (было 15200) |

Рост +526 chars: find_files +30, snapshot +251, job_status +245 (около 2,1%
full и 3,5% read-only). Сначала убрано ненужное дублирование find_files; большие
пояснения вынесены в help. Оставшийся рост нужен для выбора и интерпретации,
доступных непосредственно из tools/list. Старый RO ceiling имел лишь 74 chars
запаса; увеличен на 700 с итоговым запасом 248. Full ceiling не повышен.
TOOL-SURFACE-002 фиксирует count и оба бюджета.

### Проверки

- Среда: Windows, Node v24.15.0, npm 11.12.1, отдельный task checkout.
  Обычный Windows sandbox не создавал процессы (setup helper failure);
  команды выполнены через разрешённый escalated exec. Apply_patch также
  недоступен; изменения записаны в UTF-8 без BOM и LF. Git EOL policy проверена.
- `npm ci` PASS. Сняты исходные и итоговые actual tools/list/initialize
  instructions и ответы find_files/snapshot/job_status через
  `createTestClientPair`, только synthetic source/scratch.
- Новые meaningful wire checks в `__tests__/tool-selection.test.ts`:
  seeded PageSnapshotStore для cap/timeout/complete и всех collected pages;
  настоящий read-only walk complete/partial, exact counters/manifest,
  видимость JSON/structuredContent и прежнего interval при completed reuse.
  Cap/timeout seam проверяет rendering/replay, а не скорость большого обхода.
- Усилен существующий real search_text cap fixture (10001 lines в одном
  файле): warning перед matches, 10000-result cap, first-page resource,
  последняя страница и неизменные metadata. Tests точного prose не добавлены.
- `node --test --import tsx __tests__/tool-selection.test.ts __tests__/tools.test.ts __tests__/snapshot.test.ts __tests__/snapshot-walk-recovery.test.ts __tests__/resources.test.ts __tests__/prompts.test.ts`
  PASS: 172 tests, 170 pass, 0 fail, 2 skips — POSIX-only 0222 append и
  file symlink, запрещённый Windows permissions.
- `npm run check` PASS: build, production/test types, ESLint, Prettier, Knip;
  443 tests, 435 pass, 0 fail, 8 skips. Skips: 3 POSIX-only (FIFO, inode/mode,
  0222 append) и 5 file-symlink checks без Windows permission. Эти ветки не
  объявляются проверенными; доступные junction/8.3 regressions прошли.
- `git diff --check` PASS. Форматировались только файлы задачи; repository-wide
  fix, версии и dependencies не изменялись.

### Acceptance и оставшееся

Все шесть implementation criteria выше выполнены локально. Reference обновлён;
[протокол 009](../testing/009-tool-selection.md) содержит локальные evidence,
естественные RU/EN prompts, expected routes и фиксацию actual calls/результата.
Descriptions не являются доказательством выбора LLM: live после review остаётся
планированию/пользователю. Remote CI этим локальным прогоном не заменён.

Следующий шаг — review diff/контракта и интеграционная проверка, затем live по
протоколу с действительно обновлёнными metadata в чистых чатах. Отдельно проверить
multiple roots, partial/reused/freshness и выдачу CSV/ZIP. Центральная доска,
push/PR/merge, установленный runtime, tunnel/key и production roots не менялись.

## Приёмка планированием, 08.10.2026

Реализация принята после независимого review и пользовательской live проверки.
[PR #8](https://github.com/obolibok/filesystem-mcp/pull/8) слит в main, merge
`a67fa81914a543e7a4aa1595d63df0a49e287f11`; проверенный head
`7c4f4ec9e0c13e5ae4a24a1a4b823d9392290f86`.

- [Независимый review](../testing/009-review-2026-10-08.md): блокирующих замечаний
  нет; полный local check 443 tests, 435 pass, 0 fail, 8 skips.
- [CI PR](https://github.com/obolibok/filesystem-mcp/actions/runs/37775500386):
  Windows 440 pass / 3 skips; Ubuntu 431 pass / 12 skips; по 443 tests, 0 fail,
  полный npm run check на обеих платформах.
- Пользователь сообщил, что проверка прошла неплохо, и разрешил merge. Принятие
  live опирается на это подтверждение. Подробные traces, версия установленного
  комплекта и таблица результатов всех prompts не предоставлены; прохождение
  каждого сценария протокола и устойчивость выбора на всех моделях не заявляются.

Исторический Work record выше описывает передачу исполнителем до review.
Центральная доска обновлена на done. Новая сборка и изменение установленного
сервиса в рамках этой интеграции не выполнялись.
