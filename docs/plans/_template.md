---
status: draft # draft | approved | in-progress | done
branch: feat/<slug> # feat | fix | refactor | chore | or other types of Conventional Commits
ticket: <link> # github issue
---

# <Goal in one sentence>

## Context

Why this is needed; links to the issue, README sections, related code.

Surfaces touched: <frontend | backend | IPC commands/events | MCP tools | persisted formats (workspaces.json, mcp.db migration)>

## Assumptions

- ...

## Out of scope

- ...

## Steps

- [ ] 1. <step> → verify: <test / command>
- [ ] 2. <step> → verify: <test / command>

## Success criteria

- Tests: <Given-It cases that must exist>
- [ ] `npm run build` succeeds (includes `tsc`)
- [ ] `npm test` passes
- [ ] `cargo fmt -- --check` passes and `cargo clippy --all-targets` reports no new warnings (`--manifest-path src-tauri/Cargo.toml`)
- [ ] `cargo test --manifest-path src-tauri/Cargo.toml` passes
- [ ] Every new or changed branch has a test
- [ ] Tests follow Given-It naming and cover the happy path, not-found/empty cases, invalid input and authorization boundaries (another workspace's token, a missing token, paths outside the workspace)
- [ ] New user-visible text exists in `en.ts` and `pt-BR.ts`

## Open questions

- ...

## Decisions / deviations

- <date>: changed X because Y
