# 018: закрыть гонки проверки пути в guarded filesystem I/O

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: 017.

## Зачем

`PathGuard` сейчас проверяет и разрешает путь до отдельного filesystem syscall. Между этими операциями путь или его компонент может быть заменён symlink/junction. В `src/core/path.ts` это явно записано как принятый остаточный риск. Родительский репозиторий позже добавил no-follow открытие и повторную проверку открытого объекта для части операций, а также отказ от перезаписи файла, появившегося после проверки overwrite. Это полезная точечная защита для нашего guarded filesystem; переносить её нужно с учётом собственной архитектуры.

## Контекст и источники

- `src/core/path.ts`: принятый риск между path validation и операцией.
- `src/core/fs.ts`, `src/core/read.ts`, `src/tools/create.ts`: guarded filesystem boundaries и file operations.
- Upstream changelog описывает исправление symlink-swap race и create overwrite race в релизе 2.7.6: https://github.com/j0hanz/filesystem-mcp/blob/main/CHANGELOG.md.
- Локальная ссылка `upstream/main` может отставать. До переноса получить актуальный upstream ref и записать точный upstream commit SHA и релиз/изменения, на которые опирается реализация.

## Scope и владение

Адаптировать только необходимые защиты в существующей архитектуре `PathGuard` и `GuardedFileSystem`; не заменять эти границы копированием исходников upstream.

Проверить и закрыть race между проверкой и открытием файла для guarded reads/original delivery и append. Для платформ, где доступна проверка открытого descriptor/handle, подтвердить, что реально открытый объект остаётся внутри разрешённых roots. При невозможности такой проверки на платформе — явно и безопасно отказать в уязвимой операции либо описать подтверждённую платформенную границу; не выдавать неполную защиту за полную.

Для `create` без явного `overwrite: true` файл, созданный конкурентным процессом после проверки отсутствия/подтверждения, не должен быть молча заменён. Сохранить существующие разрешённые in-root symlink semantics и overwrite confirmation flow там, где это совместимо с безопасным открытием.

Не включать generic MCP input limits, undo/history, широкую переработку concurrency или непроверенные upstream изменения; оформить их follow-up при наличии конкретного обоснования.

## Acceptance

- [ ] Synthetic regression сценарий пытается подменить конечный путь на ссылку после validation; bytes/append не пересекают разрешённую границу.
- [ ] Сценарий с конкурентным появлением файла подтверждает, что `create` без overwrite не заменяет чужие bytes; явный overwrite сохраняет установленное поведение.
- [ ] Проверены Windows и Linux ветки, либо platform-specific ограничения и skips точно указаны. Используются только временные synthetic roots.
- [ ] Не ослаблены `PathGuard`, чувствительные пути, boundaries, отмена и cleanup; обычные in-root symlink cases проверены.
- [ ] `npm run check` проходит, обновлена архитектурная документация, Work record содержит upstream SHA, threat boundary, проверки и handoff.
- [ ] Изменение остаётся узким и отделённым от snapshot formats/jobs и dependency bump 017.

## Launch prompt

```text
Реализуй задачу docs/tasks/018-guarded-io-race-hardening.md в этом репозитории.
Сначала прочитай AGENTS.md, docs/README.md и карточку. Перед кодом синхронизируй
и изучи актуальный upstream, записав точный commit SHA; локальная upstream/main
может быть устаревшей. Адаптируй race hardening к нашим PathGuard и
GuardedFileSystem, не копируй upstream целые модули. Добавь synthetic regressions
для symlink/junction swap и create overwrite race; проверь Windows/Linux поведение
и все acceptance. Заполни Work record и передай результат планированию.
Центральную доску не редактируй.
```

## Work record

Заполняет исполнитель. До начала реализации: не начато.

- Base и branch:
- Upstream ref/release и точный commit SHA:
- Что изменилось и почему:
- Решения/отклонения от upstream:
- Команды и результаты проверок, platform skips:
- Выполненные/оставшиеся acceptance:
- Риски, follow-up и состояние handoff:
