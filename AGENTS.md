# filesystem-mcp

MCP server exposing guarded filesystem tools (read, write, search, diff, patch)
over stdio and Streamable HTTP.

## Start here

This fork supports the Schwarzbeck filesystem exploration pilot. Shared project
memory lives in Git, not in a chat transcript or the ignored `reports/` directory.

1. Read [docs/README.md](docs/README.md) for the documentation map.
2. Read [the brief](docs/project/brief.md) and [current priorities](docs/project/status.md).
3. For implementation, read the assigned card in `docs/tasks/` and
   [the parallel-work workflow](docs/development/parallel-work.md).
4. For setup and checks, use [the Windows runbook](docs/development/windows.md).

Use Russian for project planning and handoffs; keep code identifiers and existing
upstream documentation in English. Public tool descriptions remain English.

## Working across chats

- The planning chat owns project scope, priorities, acceptance and `docs/project/status.md`.
- An implementation chat owns one assigned task, its task card and its isolated
  worktree/branch. Use `codex/<task-id>-<topic>` for new branches.
- Do not switch branches in another chat's checkout or edit another task's files.
  Independent tasks may run in parallel; overlapping core changes should run sequentially.
- Read the actual diff before editing. Preserve unrelated user changes.
- Record decisions, checks and remaining work in the task card. Chat-only progress
  is not a handoff. The task card's work record may say `ready for review`; only
  the planning/integration owner updates the central board to `done` after acceptance.
- Complete routine implementation and local checks within the assigned scope.
  Escalate material scope/contract choices to planning with a concrete proposal;
  do not add approval gates for routine reversible work.
- New worktrees start from committed content. Ensure the assigned task card is
  present in their base; ignored `.tmp/`, `reports/`, dependencies and build output
  are not portable project memory.

## Architecture and scope

See [architecture and limits](docs/reference/architecture.md). `src/transport/`
owns hosting, `src/server.ts` composition, `src/tools/` MCP contracts, and
`src/core/` guarded filesystem behavior. `src/transport.ts` is a public facade.

- Preserve `PathGuard` validation and the `GuardedFileSystem` boundary. Do not
  introduce unguarded filesystem access in tool handlers.
- The pilot reads source files and delivers originals for analysis elsewhere.
  `snapshot`, `bundle`, artifact delivery and OAuth are not implemented merely
  because they appear in a plan. Consult the current board and code.
- Keep domain parsers, vector databases and unrelated redesigns outside baseline fixes.
- Use synthetic fixtures. Do not commit production documents, file inventories,
  chat exports, credentials, personal absolute paths or generated archives.
- Keep upstream changes small and separable. Do not rewrite upstream history or
  publish a release as part of ordinary task work.

## Commands

```bash
npm run check        # full repository check (static + tests)
npm run fix          # format and lint-fix, then run the full check
npm run check:static # static checks only, no tests
npm test             # Node test runner; pass native flags after --
```

Tests run on Node's built-in test runner; `npm test --
--test-name-pattern="resources"` filters like the old wrapper did.

The [2026-09-19 baseline](docs/testing/baseline-2026-09-19.md) records pre-fix
Windows EOL failures and encoding/search defects. See the project status for
accepted fixes and current verification; historical results are not current evidence.
Use the repository LF policy. Do not run repository-wide `npm run fix` during
unrelated work; format only the files needed for the assigned task.

## Releases

Versions are bumped by the Release workflow (`workflow_dispatch`), which keeps
`package.json` and `server.json` in sync. Never hand-edit either version.
