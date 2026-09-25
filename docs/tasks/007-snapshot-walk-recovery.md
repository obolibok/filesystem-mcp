# 007: устойчивость snapshot к отказам дочерних путей и fatal diagnostics

Статус/назначение: [доска](../project/status.md). Зависит от принятой 006.
Пользователь разрешил передать на реализацию 25.09.2026.
Исполнитель: GPT-6-Sol (gpt-6-sol) / Extra High (xhigh), отдельный worktree,
ветка codex/007-snapshot-walk-recovery. Назначение и статус запуска — на доске.

## Проблема и доказательства

[Независимый triage](../testing/007-snapshot-failure-triage-2026-09-25.md)
подтверждает разную классификацию raw EACCES и wrapped PERMISSION_DENIED, потерю
fatal path и переполнение samples. На диске пользователя два обхода оборвались
после 413350 записей; metadata проверена, точный fatal объект/errno не сохранён.
Synthetic reproduction: 60 файлов, отказ statDetailed на 30-м вызове; raw EACCES
даёт completed/complete=false, эквивалентный FsError — failed и удалённые artifacts.
См. triage для варианта с >20 предварительными samples и закрытыми ZIP частями.

## Scope

Владение: snapshot-pipeline.ts, job-manager.ts/job-types.ts, job-shared.ts и
необходимые schemas/описания, synthetic regressions и reference/runbook.
Общий PathGuard и errno mapping не ослаблять ради обхода. Код не читает source
в обход GuardedFileSystem. Соседние bundle/storage contracts сохранить.

1. Согласовать raw и wrapped recoverable ошибки именно на операции чтения
   дочернего объекта: PERMISSION_DENIED, исчезновение/изменение типа пути;
   для IO_ERROR различать известный recoverable native cause (например EBUSY)
   и настоящий неизвестный/fatal отказ. Не превращать любой UNKNOWN/IO_ERROR,
   ошибку producer/compression/storage или программную ошибку в пропуск.
2. Проверить stat, opendir/итерацию, loadLocalIgnore и recursion boundary.
   Отказ одного дочернего объекта/каталога не должен прекращать обход соседей;
   исключить повторный подсчёт ошибки при подъёме по рекурсии. Продолжение не
   означает чтение запрещённого объекта. Сохранить symlink/no-follow policy.
3. Отказ запрошенного root, отмена/timeout, смена политики, исчерпание лимитов,
   ENOSPC/EMFILE/ENFILE и ошибки ZIP/scratch остаются явными отказами.
   Root, недоступный при submit или ставший недоступным перед началом обхода,
   не выдавать за успешно завершённый пустой snapshot.
4. Recoverable пропуски используют текущий state=completed, complete=false,
   counters/errors, manifest и нормальную выдачу закрытых частей. Не вводить
   state=partial. Автоматический ready reuse 006 по-прежнему исключает complete=false.
5. Добавить optional fatalError для failed job независимо от первых 20 samples:
   bounded code/message и доступный source path, nativeErrorCode/operation если
   они достоверно известны. Сохранять через restart и выдавать через job_status.
   stopReason оставить совместимым. Для пути учитывать FsError.problem.path,
   explicit context и native cause; не придумывать path/errno при их отсутствии.
   Не отдавать сырой stack, произвольные cause objects, credentials или пути
   вне разрешённого source/scratch. Сохранять проверку доступа перед status.
   Error samples также должны сохранять допустимый путь FsError при отсутствии
   explicit path. Ограничить длину полей/глубину разбора cause и общий размер.
6. Fatal diagnostics общих jobs не ломает bundle и старые persisted jobs без
   нового поля. Уточнить применимость поля к timeout/cancel/interrupted; не
   выдавать отмену за неизвестную ошибку и не менять state machine.

Вне scope: сохранение пригодного partial manifest после произвольного fatal,
изменение cleanup/TTL/quota, новый list_jobs, global retry, production scan,
автообновление кеша, отключение sensitive guard и новая доменная функциональность.
Рабочий комплект пользователя, реальные inventories и credentials не требуются.

## Acceptance

- [ ] Synthetic regressions демонстрируют дефект до fix и проходят после него:
      raw/wrapped EACCES/EPERM, ENOTDIR/исчезновение, известный EBUSY cause.
- [ ] Child file/dir/ignore-read и iteration failures не теряют последующих соседей;
      counts корректны, manifest complete=false, реально выданные ZIP SHA/CRC/CSV
      содержат все доступные записи, включая записи после проблемного объекта.
- [ ] Root access failure, cancellation/timeout, лимиты, scratch/compression fault
      остаются отказами; прежние PathGuard/symlink constraints не ослаблены.
- [ ] После >20 recoverable ошибок fatal сохраняется отдельно с корректными
      bounded code/path/cause fields; доступен после restart, samples ограничены.
      Путь не теряется и когда fatal — первая ошибка. Старые jobs читаются.
- [ ] Complete=false не становится автоматическим ready hit; bundle совместим.
- [ ] Полный npm run check, значимые Windows/POSIX проверки, wire schema/tool budget;
      документация описывает отличие completed от complete и fatalError.
- [ ] Work record содержит base/head, результаты, skips, публичный контракт,
      ограничения и протокол последующего большого опыта. Production данные
      и персональные пути не коммитятся; версии пакетов не меняются.

## Передача исполнителю

После назначения: прочитать AGENTS.md, docs/README.md, brief, эту карточку,
triage и parallel-work workflow. В изолированном worktree воспроизвести synthetic
сценарии, исправить в рамках scope и выполнить acceptance. Закоммитить результат
и передать ready for review с base/head, проверками и ограничениями. Центральную
доску, push/PR/merge и live опыт ведёт планирование; не запускать их из coding-чата.

## Work record

Реализация не начата. Планирование подтвердило synthetic reproduction на 14a8ea0e.
