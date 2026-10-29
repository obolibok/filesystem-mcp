# 017: убрать известные уязвимости production-зависимостей

Статус и назначение: [центральная доска](../project/status.md).
Зависимости: 016.

## Зачем

Предыдущий `npm audit --omit=dev` для переносимого комплекта обнаружил 9 production advisories: 4 moderate, 4 high и 1 critical. Текущий lockfile по-прежнему закрепляет уязвимые версии MCP SDK, `proxy-addr` и Zod. Свежий audit нужно выполнить на доступном npm registry; не считать прошлый результат актуальным полным перечнем advisories.

## Контекст и источники

- `package.json` и `package-lock.json` — версии зависимостей проекта.
- Предыдущий audit выявил MCP packages `2.0.0`, `proxy-addr 2.0.7` и `zod 4.6.5`.
- Известные advisory: [proxy-addr](https://github.com/advisories/GHSA-jqcg-44mw-7w3h), [MCP HTTP response isolation](https://github.com/advisories/GHSA-jm63-cq47-j5jp), [MCP HTTP request limits](https://github.com/advisories/GHSA-f897-62hf-6gxq), [Zod](https://github.com/advisories/GHSA-mrhx-c7xc-m3w5).
- Актуальный upstream `package.json` содержит исправленные MCP версии; использовать его как источник сравнения, но не подтягивать несвязанные изменения: https://github.com/j0hanz/filesystem-mcp/blob/main/package.json.

## Scope и владение

Обновить production dependencies и lockfile до совместимых исправленных версий. Минимальные известные целевые версии: `@modelcontextprotocol/express >=2.0.2`, `@modelcontextprotocol/node >=2.1.2`, `@modelcontextprotocol/server >=2.4.0`, `zod >=4.6.6`, `proxy-addr >=2.0.8`. Уточнить фактические advisory и дерево после свежего audit. Транзитивную зависимость исправлять поддерживаемым путём; не добавлять override без доказанной необходимости.

Не менять MCP tool contracts, код snapshot/job lifecycle, публичную версию продукта и unrelated dev dependencies. Не использовать массовый `npm audit fix` без анализа diff.

## Acceptance

- [ ] Свежий `npm audit --omit=dev` для исходного проекта не содержит известных исправленных production advisories; новые оставшиеся production findings отдельно объяснены в Work record.
- [ ] Portable build использует тот же исправленный production dependency graph; audit собранного server package подтверждает исправления.
- [ ] `npm ci` и `npm run check` проходят; зафиксированы среда и skips.
- [ ] MCP package API/stdio transport, HTTP transport, build и portable Verify проверены без изменения существующих tool contracts.
- [ ] Карточка содержит точные обновлённые версии, audit summary, проверки и handoff. Не хранить auth tokens или пользовательские данные.

## Launch prompt

```text
Реализуй задачу docs/tasks/017-production-dependency-remediation.md в этом репозитории.
Сначала прочитай AGENTS.md, docs/README.md и карточку. Работай в отдельном
worktree от принятого main checkpoint. Обнови только совместимые production
dependencies и lockfile для устранения advisories из карточки. Сначала получи
свежий npm audit; не запускай массовый audit fix. Проверь source и portable
dependency graph, npm ci, npm run check, HTTP/stdio compatibility и portable
Verify. Заполни Work record точными версиями, командами, результатами и skips.
Не обновляй центральную доску; передай результат планированию.
```

## Work record

Заполняет исполнитель. До начала реализации: не начато.

- Base и branch:
- Что изменилось и почему:
- Решения/отклонения от исходного плана:
- Audit: команда, время/источник, findings до/после:
- Команды и результаты проверок, среда, skips:
- Выполненные/оставшиеся acceptance:
- Риски, follow-up и состояние handoff:
