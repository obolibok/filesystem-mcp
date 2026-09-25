# Snapshot: отказ большого обхода, triage 25.09.2026

Два дефекта подтверждены кодом и synthetic reproduction. Связь с конкретным
нативным отказом на пользовательском диске вероятна, но его путь/errno не были
сохранены. Пользовательский Markdown принят как свидетельство, его рекомендации
не являются разрешением менять контракты. Личные пути, raw metadata и inventory
в Git не переносятся.

## Проверенные наблюдения

Пользователь подтвердил комплект от 24.09 на той же Windows-машине и указал
установку. BUILD.json sourceCommit — 91d4a001; 264 server/dist файла независимо
сверены с SHA256SUMS, расхождений нет. Read-only проверка двух сохранённых job.json:

- Оба state=failed, stopReason=Cannot access path; длительности 164928 и 147192 ms.
- entriesSeen=425036, filesWritten=413350, directoriesVisited=11326.
- inaccessibleSkipped=38, errors=39, сохранено 20 samples, все ACCESS_DENIED.
- rawCsvBytes=67126166, zipBytes=4635800, parts=1; массив artifacts уже пуст.
- fatalError отсутствует. Первый job не имел idempotencyKey; второй имел явный
  диагностический ключ. Следовательно, два jobId не доказывают нарушение replay.
- Лимит времени установлен 3600000 ms, raw/job — 536870912 B, scratch — 1 GiB.
  Stop reason и времена не указывают на исчерпание таймаута; увеличивать лимиты
  по этим данным оснований нет.

Приведённый в пользовательском отчёте hash первой части уже не с чем сравнить:
сервер удалил artifacts. Точное место и native errno фатального отказа из
сохранённого job.json восстановить нельзя. Повторного обхода диска и изменений
установленной конфигурации при triage не выполнялось.

## Подтверждённый механизм

1. PathGuard.handleRealpathError (src/core/path.ts) оборачивает native errno в
   FsError с сообщением Cannot access path, problem.path и cause.
2. ERRNO_MAP (src/core/errors.ts): EACCES/EPERM → PERMISSION_DENIED,
   ENOTDIR → NOT_DIRECTORY, EBUSY → IO_ERROR.
3. isRecoverableWalkError (src/core/snapshot-pipeline.ts) допускает raw
   EACCES/EPERM/ENOTDIR/EBUSY, но для FsError — только NOT_FOUND/ACCESS_DENIED.
   Таким образом, один и тот же отказ обрабатывается по-разному в зависимости
   от слоя возникновения/обёртки. PERMISSION_DENIED дочернего пути роняет job.
4. JobRunContext.addError ограничивает samples двадцатью. В fatal catch manager
   вызывает addError(error) без path; safeErrorSample не извлекает problem.path
   или cause. Путь теряется даже до достижения лимита samples. При заполненном
   списке исчезает и отдельная запись fatal; остаётся общий stopReason.
5. Fatal catch удаляет artifacts. Это текущая политика очистки failed jobs;
   исправление классификации позволит recoverable обходу завершиться с manifest,
   complete=false и доступными частями без изменения этой политики.

## Synthetic reproduction на принятом main 14a8ea0e

Изолированный source из 60 небольших файлов, отдельный scratch, raw part cap
1024 B для проверки уже закрытых частей. Через подмену statDetailed в synthetic
GuardedFileSystem вводится ошибка на 30-м вызове. Реальные pipeline и manager,
guard разрешает только synthetic root; исходники проекта не изменены.

| Введённая ошибка                                                   | State                     | Files | Inaccessible | Errors | Samples | Artifacts |
| ------------------------------------------------------------------ | ------------------------- | ----: | -----------: | -----: | ------: | --------: |
| raw EACCES                                                         | completed, complete=false |    59 |            1 |      1 |       1 |         6 |
| FsError(PERMISSION_DENIED, Cannot access path, path, EACCES cause) | failed                    |    29 |            0 |      1 |       1 |         0 |
| 25 успешных stat, 21 FsError(ACCESS_DENIED), затем wrapped EACCES  | failed                    |    25 |           21 |     22 |      20 |         0 |

Во втором случае fatal sample содержит код/сообщение без path. В третьем fatal
sample отсутствует вовсе; две уже закрытые части удалены. Это воспроизводит
механизм симптомов, но не доказывает native errno исходного пользовательского сбоя.
Локальные script/result остаются в ignored .tmp/007-triage; приведённых шагов
достаточно для независимого regression, этот ignored каталог не зависимость задачи.

## Следующий шаг

[007](../tasks/007-snapshot-walk-recovery.md): локальная классификация child errors
и независимая bounded fatal diagnostics, затем review, CI, новая portable сборка
и повтор пользователем исходного обхода. Частичные completed результаты не входят
в автоматический ready reuse 006; это существующий контракт. Отдельное сохранение
artifacts после настоящего fatal/ENOSPC/отмены и новый state partial требуют
самостоятельного решения и в baseline fix не включены.
