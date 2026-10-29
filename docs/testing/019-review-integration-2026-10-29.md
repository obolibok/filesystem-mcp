# Review и интеграция 019, 2026-10-29

**PASS**: новых блокирующих или неблокирующих замечаний по diff не найдено.
[PR #19](https://github.com/obolibok/filesystem-mcp/pull/19) слит:
318173d0c0f0f359e7c7be712884d6e7d000400f.

## Версия и покрытие

Base aa8bca0d94cda896f0522cd9ffd0fe8388a81372, runtime исполнителя
9f5cb02aed45f689dc3929a69e126a2719d8956c, итоговый PR head
70f7b23a13136125a9ed64c2f85d8fb0af524720. При внесении main конфликт был только
в карточке; сохранены acceptance и полный Work record, runtime не менялся.

Прочитаны все шесть изменённых source/test files и оба docs files; прослежены
GuardedFileSystem/PathGuard, SDK verifier, grants и read-only registration.
Отдельный независимый архитектурный проход подтвердил trust boundaries.

HMAC связывает operation, canonical pending set и EntryIdentity. Первый swap
до retry требует новый полный набор ответов, второй отменяет вызов. Legacy state
и изменение pending set fail-closed. create проверяет identity после записи temp,
move/copy — после mkdir, delete — перед удалением. Сохранены public schemas,
skip/decline, explicit overwrite и guard boundary.

## Проверки

- Независимый Windows npm run check на 70f7b23a: 598 tests, **585 pass, 0 fail,
  13 skips**, все static stages PASS. Skips — platform/file-symlink permissions.
- [PR CI](https://github.com/obolibok/filesystem-mcp/actions/runs/40958756222):
  Windows **593/0/5**, Ubuntu **582/0/16**, всего 598 tests.
- 53 новые реальные synthetic MCP round-trip regressions проходят без skips:
  approve/skip/decline, first/second swap, legacy/foreign state, новые/исчезнувшие
  цели, порядок ключей, final mutation checks, directory-to-file, empty-dir Skip.
- Linux/WSL check исполнителя 582/0/16 — отдельное reported evidence.
- Свежий production audit --omit=dev: 0. Full audit: 3 dev/tooling package findings
  (client SDK, brace-expansion, smol-toml), оставлены отдельному triage.
- Codex Security scan 60a60dfb-6aa4-431a-8dfa-08c00822a672 завершён без findings.
  Canonical report остаётся в workbench; для чтения протокола доступ к нему не нужен.
  Частичный rollout usage включает старую историю большого planning-чата:
  total 8,246,452; input 8,222,369; cached input 8,050,432. Это не изолированная
  стоимость review 019.

## Ограничения

Identity относится к записи, не к content hash или детям каталога; поля identity
могут быть ограничены FS. Pathname recheck не атомарен против external swap после
последней проверки, требуются доверенные ancestors. Код/reference согласованы.

Live production, установленный MCP/tunnel, новый portable, EXDEV redesign и другие
upstream API в этой приёмке не менялись. Следующий шаг — [handover](../project/architect-handover-2026-10-29.md).
