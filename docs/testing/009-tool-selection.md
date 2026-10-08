# 009: локальный контракт и протокол выбора инструментов

Локальные проверки выполнены 08.10.2026 в отдельном checkout задачи 009.
**Live оценка поведения LLM ещё не выполнена.** Её ведут планирование и
пользователь после review, с фактически обновлённым каталогом tools.

## Локальные свидетельства

Через `createTestClientPair` сняты настоящие `tools/list`, initialize instructions,
`find_files`, `snapshot` и `job_status` на synthetic source/scratch.
Сравнение wire до/после подтверждает неизменность всех полей tool contracts,
кроме трёх descriptions: names/count, titles, input schemas/defaults, annotations
и политика отсутствующего outputSchema совпадают.

Размер — `JSON.stringify(result.tools).length` (UTF-16 symbols), bytes — UTF-8;
это не измерение tokenizer и не размер всего JSON-RPC envelope.

| Профиль   | Tools | До: symbols / bytes | После: symbols / bytes | Ceiling после |
| --------- | ----: | ------------------: | ---------------------: | ------------: |
| Full      |    19 |       25206 / 25224 |          25732 / 25750 |         26900 |
| Read-only |    13 |       15126 / 15134 |          15652 / 15660 |         15900 |

Рост +526 symbols на профиль: find_files +30, snapshot +251, job_status +245.
Удалены ненужная ссылка на replace_text из find_files (её нет в read-only) и
обещание optional metadata; подробное руководство вынесено в help. Остаток —
видимые до первого вызова сведения о выборе, cap/page и значении status.
Full ceiling сохранён; read-only увеличен с 15200 до 15900, запас 248 symbols.

Meaningful wire regressions:

- PageSnapshotStore seam воспроизводит capped, timed-out и complete наборы
  find_files без большого disk scan: warning перед первой строкой и на final
  page, все collected paths/counters сохранены, cursor не продолжает scan.
  Это проверка rendering/replay, не новый замер engine cap или timeout.
- Настоящий search_text на одном synthetic файле с 10001 matches проверяет
  cap=10000, warning перед matches, externalized resource, последнюю страницу
  и отсутствие перенаправления content search на metadata snapshot.
- Настоящий read-only walk проверяет completed/complete=true и
  completed/complete=false (synthetic sensitive .env при includeHidden=true),
  exact counters, их совпадение с manifest, JSON text/structuredContent и reuse
  с прежним interval. Snapshot/bundle/cancel_job сохраняют readOnlyHint=false.
- Regression suites tools, snapshot, walk-recovery, resources, prompts и
  tool-selection: 172 tests, 170 PASS, 0 failures, 2 skips: POSIX-only 0222 append и запрещённый Windows file symlink.
- Полный repository check и финальная среда записаны в Work record
  [карточки 009](../tasks/009-tool-selection.md).

Воспроизводимые команды из корня checkout:

```powershell
npm ci
node --test --import tsx __tests__/tool-selection.test.ts __tests__/tools.test.ts __tests__/snapshot.test.ts __tests__/snapshot-walk-recovery.test.ts __tests__/resources.test.ts __tests__/prompts.test.ts
npm run check
```

Размер tools/list можно независимо снять через этот же harness:

```powershell
@'
import { createTestClientPair, createTestRoot, cleanupTestRoot } from './__tests__/helpers.ts';
const source = await createTestRoot();
const scratch = await createTestRoot();
process.env.FS_SNAPSHOT_DIR = scratch;
try {
  for (const readOnly of [false, true]) {
    const pair = await createTestClientPair([source], { readOnly });
    try {
      const { tools } = await pair.client.listTools();
      const json = JSON.stringify(tools);
      console.log({ readOnly, tools: tools.length, symbols: json.length, bytes: Buffer.byteLength(json) });
    } finally { await pair.close(); }
  }
} finally {
  await cleanupTestRoot(source);
  await cleanupTestRoot(scratch);
}
'@ | node --import tsx --input-type=module
```

## Подготовка живого опыта

Использовать принятую после review сборку и synthetic fixture: два различимых
roots A/B, несколько файлов/подкаталогов, UTF-8 файл с известным marker,
пара небольших originals, hidden/ignored entries и sensitive .env.
Scratch вне sources. Не менять production roots, установленный комплект,
tunnel/key в рамках локальной 009.

Зафиксировать commit/runtime, клиент, фактически выбранную модель/effort,
read-only профиль, каталог tools и дату опыта. Перед независимым prompt открыть
чистый чат с обновлёнными metadata; не подсказывать названия tools или маршрут.
Root placeholders ниже заменить понятными пользователю именами fixture.
list_roots допустим, если roots ещё неизвестны; подтверждённый ранее path/результат
может использоваться без повторного discovery/status. Не фиксировать число polls.

Для каждого запуска раскрыть в клиенте все фактические карточки вызовов tools
и сохранить их по порядку: name, arguments, время, ответ/error, job/reuse reason.
Использовать экспорт tool-call trace клиента, когда доступен; иначе выписать
данные непосредственно из раскрытых вызовов и отметить отсутствующие поля.
При доступном MCP wire trace сопоставить request IDs `tools/call` и ответы.
Ответ модели о том, что она «вызвала», не заменяет trace. Повторный SDK harness
не является свидетельством выбора LLM. Если клиент скрывает calls/arguments,
оценка маршрута остаётся inconclusive до доступного trace.

## Естественные prompts и маршруты

RU и EN — отдельные независимые запуски в доступном клиенте/модели, а не
сравнение разных моделей. Это сценарии, а не ещё полученные результаты.

| ID  | RU prompt                                                         | EN prompt                                                                     | Ожидаемый маршрут                                                 |
| --- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------- | ----------------------------------------------------------------- |
| P1  | Какие каталоги тебе доступны?                                     | Which folders can you access?                                                 | list_roots                                                        |
| P2  | Покажи содержимое папки A.                                        | Show the contents of folder A.                                                | list                                                              |
| P3  | Построй индекс файлов в A для дальнейшего анализа.                | Build a file index of A for later analysis.                                   | snapshot → job_status                                             |
| P4  | Обследуй всё дерево A, чтобы затем выбрать документы для анализа. | Inventory the whole tree of A so we can choose documents for analysis later.  | snapshot → job_status                                             |
| P5  | Сколько файлов тебе видно рекурсивно в A?                         | How many files are visible recursively under A?                               | snapshot → job_status, без artifacts только ради counters         |
| P6  | Найди файлы с именами report*.txt в A.                            | Find files named report*.txt under A.                                         | find_files, допустимы страницы                                    |
| P7  | Найди текст CALIBRATION_MARKER внутри файлов A.                   | Find CALIBRATION_MARKER inside files under A.                                 | search_text                                                       |
| P8  | Прочитай текст notes.txt из A.                                    | Read the text of notes.txt in A.                                              | read; discovery только для неизвестного path                      |
| P9  | Дай original sample.zip из A для анализа.                         | Give me the original sample.zip from A for analysis.                          | get_file                                                          |
| P10 | Получи originals sample.zip и sheet.xls из A вместе для анализа.  | Retrieve the originals sample.zip and sheet.xls from A together for analysis. | bundle → job_status → get_artifact                                |
| P11 | Пришли сам индекс дерева A в CSV/ZIP для анализа.                 | Deliver the actual CSV/ZIP file index of A for analysis.                      | snapshot → job_status → get_artifact, manifest и нужные ZIP parts |

## Отдельные условия

| Условие / естественный prompt                                                                            | Подготовка                                              | Критерий                                                                                                                                                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| «Сделай индекс всех доступных каталогов» / “Index all accessible folders”                                | Два roots A/B                                           | Явный scope каждого root, отдельные jobs; aliases одной location не дублируются. Не выбрать молча первый root и не складывать пересекающиеся scope как уникальные файлы. |
| «Сколько файлов видно в A, включая скрытые?» / “How many files are visible in A, including hidden ones?” | sensitive .env, обычная deny policy                     | includeHidden=true, completed/complete=false явно сообщён; inaccessibleSkipped не прибавляется к filesWritten.                                                           |
| «Повтори сводку по файлам A» / “Repeat the file summary for A”                                           | В том же процессе есть compatible complete snapshot     | completed_reuse допустим; прежний interval назван, forceRefresh не включён автоматически.                                                                                |
| «Нужен индекс A не старше пяти минут» / “I need an index of A no older than five minutes”                | Есть результат старше пяти минут и доступна текущая job | maxAgeMs=300000 по возрасту от walk start; joining допустим по текущему контракту, но возраст сообщён честно.                                                            |
| «Сделай новый обход A сейчас» / “Run a new inventory of A now”                                           | Уже есть ready snapshot                                 | forceRefresh=true, stable idempotencyKey для повторов; новый interval, без обещания atomic снимка.                                                                       |
| «Продолжи поиск report*.txt» / “Continue finding report*.txt”                                            | find_files cap/timeout с cursor                         | Warning виден перед paths на каждой странице; cursor заканчивает collected set, не продолжает scan за cap. Для новых name matches можно сузить scope/glob.               |

## Оценка и запись

Для каждого запуска сохранить первый содержательный tool после root discovery,
полную последовательность, лишние вызовы, bytes/symbols ответов (если доступны),
state/complete/reason/counters и формулировку пользователю. Нельзя требовать
повторного status, если полный результат уже известен из достоверного контекста.

Маршрут проходит, если intent ведёт к tool из таблицы. Для P3–P5/P11 широкие
find_files/list, массовые stat/read или скачивание originals перед индексом
считаются лишними. Для P6 snapshot не нужен; для P7 metadata index не заменяет
поиск текста. Для P5 artifacts не нужны только ради сводных counters. Discovery
конкретного неизвестного child и необходимые polls не считать ошибками.

Формулировка проходит, если число относится к индексным записям в названной
области/flags/exclusions и interval; completed отделён от complete, неполнота
и stale reuse видимы, нет обещания всего диска или unique physical file count.
У failed/cancelled/interrupted нельзя сообщать успешную готовую инвентаризацию;
при expiry или metadataPersistence нужны соответствующие ограничения.

Таблица будущего результата: case/language, model/client/runtime, trace source,
first tool, calls, лишние actions, response size, scope/freshness/completeness,
PASS/FAIL/inconclusive и причина. Обезличенные итоги сохраняет планирование;
inventories, originals, credentials и chat exports в Git не включать.
