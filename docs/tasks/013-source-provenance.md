# 013: машина и тома источников

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: принятые list_roots и snapshot/bundle; текущий main после 011/012.
Согласовано пользователем 26.10.2026. Ветка: `codex/013-source-provenance`.

## Зачем

Модель должна видеть, на какой машине запущен MCP-сервис и к каким томам
относятся разрешённые корни. Manifest должен сохранять эти сведения для
происхождения полученных файлов и снимков. Пользователь просит минимальную
реализацию: использовать сведения ОС, недоступные значения возвращать как null.
Абсолютная уникальность идентификаторов и распознавание клонов не требуются.

## Контекст

- [list_roots](../../src/tools/list-roots.ts) сейчас возвращает roots: string[]
  и необязательный hint. Массив путей сохранить.
- [snapshot](../../src/tools/snapshot.ts) и [bundle](../../src/tools/bundle.ts)
  вычисляют sourceRootId из пути. Существующие rootId, reuse и idempotency
  не менять в рамках этой задачи.
- [Snapshot manifest](../../src/core/snapshot-pipeline.ts) и
  [bundle manifest](../../src/core/bundle-pipeline.ts) формируются в pipeline;
  [job types](../../src/core/job-types.ts) и
  [job manager](../../src/core/job-manager.ts) отвечают за durable metadata.
- У Windows номер тома отличается от заводского номера накопителя:
  [GetVolumeInformation](https://learn.microsoft.com/en-us/windows/win32/api/fileapi/nf-fileapi-getvolumeinformationa).
  Нужен именно серийный номер тома, включая сетевой том, если ОС его сообщает.
- Системный UUID Windows берётся из
  [Win32_ComputerSystemProduct.UUID](https://learn.microsoft.com/en-us/windows/win32/cimwin32prov/win32-computersystemproduct).
  Пустое/нулевое или недоступное значение не заменять выдуманным ID.

## Согласованный контракт

В list_roots добавить два поля:

- host: { name: string | null, machineId: string | null }.
  name — имя ОС-хоста, где работает MCP-процесс; machineId — системный UUID.
  Получать сведения на текущей машине, не переносить их из BUILD.json или
  идентификатора, сгенерированного в папке переносимого комплекта.
- rootDetails: массив { path: string, volume: { label: string | null,
  serialNumber: string | null } }, соответствующий разрешённым roots.
  serialNumber — номер тома в едином hex-формате XXXX-XXXX; label — метка тома.
  Одинаковые сведения у двух корней одного тома допустимы.

Существующие roots и hint сохранить. При отсутствии roots rootDetails пустой.
Для локального и сетевого пути пробовать получить сведения от ОС. Если одно
поле недоступно, остальные доступные поля сохранить. Недоступные сведения — null,
без синтетических UUID, подстановки буквы диска или хеша пути вместо номера тома.

В новые snapshot/bundle manifest добавить provenance: { host, root }, где root
имеет форму элемента rootDetails и относится к фактическому source root джобы,
в том числе выбранному подкаталогу разрешённого корня. Сведения зафиксировать
при начале нового задания и использовать при формировании manifest; не считывать
их заново как происхождение старого результата при get_artifact или reuse.
Сохранять их вместе с durable job metadata, если это требуется существующим
lifecycle. Старые jobs/manifests без provenance остаются читаемыми; существующие
артефакты не переписывать. Новые поля являются информацией о происхождении,
не проверкой целостности, уникальности или неизменности носителя во время обхода.

## Scope и владение

Один небольшой общий provider системных сведений, list_roots, перенос provenance
в jobs и оба manifest, необходимые schema/tests/reference. Сохранять
GuardedFileSystem/PathGuard: запрос сведений о томе разрешённого root не даёт
доступа к новым путям. Произвольный путь для нового metadata-tool не добавлять.

Основная платформа — Windows 10/11, PowerShell 5.1 и текущий portable Node.
Для остальных ОС сохранить работоспособность: hostname при наличии, отсутствующие
UUID/volume metadata — null; отдельные Linux/macOS probes не разрабатывать.
Выбор конкретного Windows API/helper — routine implementation choice. Системные
запросы должны иметь конечный timeout, поддерживать Unicode/пробелы и не зависеть
от локализованного текста команды vol. Ошибка/timeout получения метаданных
не ломает list_roots или создание snapshot/bundle; отдельные unavailable-поля
остаются null. Не запрашивать повышение прав ради заполнения полей.

Вне scope: заводские номера устройств, RAID/topology, распознавание клонов,
реестр инвентаризации машин, новые постоянные machine IDs, изменение cache/reuse,
новые parser/vector services, настройка/перезапуск рабочего туннеля и диагностика
его 503. Public tool descriptions и поля остаются English.

## Acceptance и проверки

- [ ] list_roots сохраняет roots/hint и возвращает host/rootDetails по контракту.
- [ ] Windows hostname/UUID и volume label/serial получаются из ОС; пустые/нулевые
      UUID, недоступные значения и ошибки отражены как null.
- [ ] Покрыты обычный root, подкаталог, несколько корней одного тома, сетевой
      root и частично недоступные метаданные. Сетевой provider тестируется
      синтетически; реальный SMB не является обязательной зависимостью тестов.
- [ ] Metadata lookup конечен по времени; timeout/error не блокирует основные
      tools/jobs. Недоступные сведения не кешируются навечно как факт о носителе.
- [ ] Новый snapshot и bundle manifest содержат provenance источника; сохранение
      и чтение после restart не подменяет его текущими сведениями машины.
- [ ] Legacy jobs/manifests без новых полей и reuse прежних результатов работают.
      Root IDs, hashes ZIP/CSV, лимиты и доступ к исходным файлам сохранены.
- [ ] Выполнены meaningful targeted regressions и npm run check; результаты,
      skips и границы реального Windows smoke записаны в Work record.
- [ ] Обновлены architecture/reference, Windows/portable инструкция по мере
      необходимости. Реальные имена/UUID/серийные номера машины не коммитятся;
      в tests/отчёте только синтетические или обезличенные значения.

## Launch prompt

```text
Реализуй docs/tasks/013-source-provenance.md. Пользователь согласовал минимальный
scope: имя машины, системный UUID, метка и серийный номер тома каждого root;
недоступное — null. Эти сведения нужны в list_roots и новых manifest.
Прочитай AGENTS.md, docs map, brief, карточку и parallel-work workflow.
Работай в отдельном worktree от checkpoint с этой карточкой;
ветка codex/013-source-provenance. Сохраняй roots и прежний jobs/reuse контракт.
Не расширяй scope физическими дисками, распознаванием клонов или инвентаризацией.
Выполни acceptance/check, обнови Work record, закоммить результат и передай
планированию ready for review. Центральную доску ведёт планирование.
Push/PR/merge, сборку и пользовательский live проводит планирование.
```

## Work record

Реализация не начата. Карточка подготовлена планированием 26.10.2026;
исполнитель ещё не назначен.
