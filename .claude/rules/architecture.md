## Layering

The app is two programs talking over Tauri IPC: the React frontend (`src/`) and the Rust backend (`src-tauri/src/`). Each has a single direction of dependency:

```
frontend:  components (UI)  →  app hooks / stores  →  domain + lib (pure logic)
                                       ↓
                               lib/tauri (IPC boundary)
                                       ↓  invoke / events
backend:   #[tauri::command] fns, MCP tools, hook routes  →  module logic (workspace, pty, mcp, worktree, voice)  →  OS, files, SQLite, git, PTY
```

- Components render and forward user intent to app hooks (`src/app/use*.ts`) and Zustand stores (`src/stores/*Store.ts`). No business rules in JSX.
- `src/domain/` and `src/lib/` (except `lib/tauri`) are pure TypeScript: selectors, migrations, labels, planners, queues. They import only types and each other — never React components, stores or Tauri APIs.
- Non-trivial logic of a component lives next to it in a plain `<name>Model.ts` (`tasks/boardModel.ts`, `review/diffModel.ts`, `voice/voiceModel.ts`) so it is tested without rendering.
- Backend commands, MCP tool handlers and hook routes parse and validate input, call the module, and map the result. The MCP tools (`mcp/tools.rs`) and the Tasks panel commands (`mcp/commands.rs`) share the same `mcp/repo.rs`, so humans and agents change the board the same way.
- !IMPORTANT: Every `invoke` goes through `src/lib/tauri/commands.ts` (`invokeCommand` with the typed `IpcCommandContract` and the `IPC_COMMANDS` name map) and the per-area wrappers in `src/lib/tauri/*.ts`, re-exported by `src/api.ts`. NEVER call `invoke` from `@tauri-apps/api/core` anywhere else. Event subscriptions (`listen` from `@tauri-apps/api/event`) are allowed in app hooks, stores and the components that already own them.
- !IMPORTANT: The MCP core NEVER depends on Tauri directly: it reaches the app through the `McpHost` trait (`emit`, `workspace`, `terminals`), so it runs in tests with `test_support::RecordingHost`. Keep it that way for new MCP code.

## Organization

- Frontend: group by feature — one folder per surface under `src/components/<feature>/` (component, its CSS, its model, its tests), cross-surface flows in `src/app/`, state in `src/stores/`, pure rules in `src/domain/`, helpers in `src/lib/<area>/`.
- Backend: one module per concern (`workspace/`, `pty/`, `mcp/`, `worktree/`, `voice/`, `cli/`), each with its commands, logic and `#[cfg(test)] mod tests`.
- Shapes that cross IPC are declared once per side: Rust structs with `#[serde(rename_all = "camelCase")]`, TypeScript types in `src/types.ts`, kept in sync by hand. Frontend view models are separate from IPC types and map from them explicitly.
- `src/lib/features/agents.json` is the single source for the agent CLI catalog, shared by both sides (`include_str!` in `pty/agents.rs`).
- The folder layout:

```
src/
  main.tsx, App.tsx          entry and top-level composition
  api.ts                     re-exports the lib/tauri wrappers
  types.ts                   IPC types shared by the frontend
  app/                       use<Flow>.ts hooks wiring stores, IPC and events
  components/<feature>/      surfaces: shell, workbench, navigation, tasks, fleet, review, editor, preview, settings, voice, ...
  stores/                    <area>Store.ts (Zustand)
  domain/                    pure rules: selectors, migration, agent labels/roles/status, team templates
  lib/
    tauri/                   IPC boundary: commands.ts + one wrapper file per backend area
    session/ async/ platform/ features/   pure helpers and the agent catalog
  i18n/                      t / useT, locales/en.ts and locales/pt-BR.ts
  styles/                    tokens.css, reset, layout primitives, motion
  dev/mockBackend.ts         browser preview IPC mock (dev only, `?mock`)
  test/setup.ts              Vitest setup
src-tauri/src/
  lib.rs                     plugin setup, state, the invoke_handler list, exit handling
  main.rs                    binary entry; `mcp-stdio` and `hook` subcommands go to cli/
  workspace/                 workspaces.json store, groups, layout, snapshots, files and editor, git status
  pty/                       PTY manager, agent detection, output scanning, dev server probing, shells
  mcp/                       MCP hub: auth (tokens), db (migrations), repo, tools, server (axum), hooks, launch flags, roles, commands
  worktree/                  agent worktrees and review (diff, commit, merge, gh PR)
  voice/, voice.rs           Whisper models, audio capture, transcription
  scrollback.rs, usage.rs, fonts.rs, sync.rs
```

## Anti-patterns

- NEVER create circular dependencies between features or modules.
- NEVER reach into another backend module's private state; use its `pub` / `pub(crate)` functions.
- NEVER read or write the persisted files (`workspaces.json`, `mcp.db`, scrollback) from the frontend — the backend owns them.
- NEVER add abstractions, configuration or extension points that no current requirement needs.
