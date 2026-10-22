# Terra Swarm

Terra Swarm is a desktop app (Tauri 2) that runs AI coding agents (Claude Code, Codex, OpenCode, Kimi) and plain shells side by side in real PTYs, organized by project workspace. It is used by developers on macOS, Linux and Windows. Besides the UI it exposes a local MCP server (`127.0.0.1`, Streamable HTTP at `/mcp`) and agent state hooks (`/hooks`) that the agents it launches use to share a task board, messages and notes. User-facing behaviour is described in `README.md`.

## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:

- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.
- If a change touches how an agent CLI is launched or resumed (`src/lib/features/agents.json`, `src-tauri/src/mcp/launch.rs`), say which CLIs and shells (POSIX, PowerShell, `cmd`) it affects.

## 2. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:

- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"
- "Add an MCP tool" → "A `tools.rs` test for the happy path, invalid arguments and another workspace's data, plus the README tool table"

For multi-step tasks, write the plan in docs/plans/TASK<UnixTimestamp>-<branch-slug>.md from docs/plans/\_template.md before coding, and wait for approval. Keep its checkboxes and status current.

```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

## 3. Rules Layout

- `.claude/rules/*.md` — core rules. Rules with `paths:` frontmatter apply only to matching files.
  - `architecture.md` — frontend and backend layering, the IPC boundary, folder layout.
  - `code-style.md` — TypeScript/React and Rust style, naming, typing, errors, i18n, styling.
  - `database.md` — the SQLite store of the MCP server (`mcp.db`) and the other files the app persists.
  - `security.md` — MCP tokens, local-only servers, PTY and process spawning, file access, Tauri capabilities, secrets.
  - `testing.md` — Vitest + Testing Library, Rust unit tests, Given-It naming.
- `src/styles/README.md`, `src/styles/tokens.css` and `.impeccable/design.json` — the visual foundation (tokens and status colours).

## 4. Domain

- **Workspace** (project): a folder on disk with its terminals, groups and layout. Persisted by the backend in `<app data>/workspaces.json` (versioned envelope, atomic writes). Closing a workspace deletes its MCP board, messages and notes.
- **Terminal / pane**: one PTY running an agent CLI or a shell. Its `command` is stored exactly as the user typed it; launch-only additions (per-agent args, MCP flags, role prompt) are added to the spawned process only, so resume can rebuild the command.
- **Agent catalog**: `src/lib/features/agents.json` is the single list of agent CLIs, read by the frontend (`agentProfiles.ts`) and compiled into the backend (`pty/agents.rs`). Never duplicate it.
- **Session resume**: on restart the app offers to respawn the terminals that were running, with each CLI's continuation command (`claude --continue`, `codex resume --last`).
- **MCP coordination** (per workspace): tasks `todo → in_progress → review → done` plus `blocked`, with dependencies and a full history; messages between terminals or to `"all"`; notes (same `key` replaces, FTS5 search); agent status (`working`, `idle`, `needs_input`, `blocked`). Status and tokens live in memory only.
- **Roles and teams**: orchestrator, planner, executor, reviewer, tester (`mcp/roles.rs`, `src/domain/agentRoles.ts`, `teamTemplates.ts`). Only the orchestrator may `assign_task`; nothing is ever typed into an agent that is working or waiting for the user.
- **Worktrees**: an agent may run on a `terra/<terminal>` branch in its own git worktree; review, commit, merge into the base branch or open a PR with `gh` from the app.
- Invariants:
  - !IMPORTANT: An agent's identity and workspace come from its MCP token — an agent can never read or change another workspace's data.
  - The MCP server is optional: if `mcp.db` can't be opened or migrated, or the user turns it off, the app keeps working without it and new terminals get no token, variables or flags.

## 5. Environment

- Tauri 2 shell (Rust, edition 2021) in `src-tauri/`: `portable-pty` for terminals, `rmcp` + `axum` + `tokio` for the MCP server, `rusqlite` (bundled SQLite) for `mcp.db`, `whisper-rs` + `cpal` + `rubato` for voice input (Metal on macOS), `reqwest` (rustls) for model downloads, Tauri plugins dialog, updater, process and notification.
- Frontend in `src/`: React 19 + TypeScript (strict) + Vite, Zustand stores, xterm.js, CodeMirror 6, Radix UI (dialog, tabs), dnd-kit, cmdk, motion, lucide-react, react-resizable-panels.
- Tests: Vitest (node environment by default, `// @vitest-environment jsdom` per file for DOM tests) + Testing Library; Rust `#[cfg(test)]` modules with the `tauri` `test` feature (`tauri::test::mock_app()`).
- No linter or formatter is configured for TypeScript (no ESLint/Prettier); `tsc` (strict, `noUnusedLocals`, `noUnusedParameters`) is the static check. Rust uses `cargo fmt` defaults and Clippy defaults (no custom lint table).
- Node 24 (CI). Distributed as signed desktop bundles from GitHub Releases with in-app auto-update (Tauri updater). Releases build on macOS (arm64, x86_64), Linux (AppImage, patched by `scripts/tauri-ci.sh`) and Windows.
- The version lives in three places that must match: `package.json`, `src-tauri/Cargo.toml` and `src-tauri/tauri.conf.json`. Pushing a `v*` tag runs `.github/workflows/release.yml`, which publishes a draft release.
- `video/` is a separate Remotion project for the demo media; it is not part of the app build.

## 6. Commands

| Command | Description |
|---------|-------------|
| `npm install` | Install frontend dependencies |
| `npm run tauri dev` | Run the desktop app with hot reload (starts Vite on http://localhost:1420) |
| `npm run dev` | Vite only, without the Rust backend |
| `npx vite --port 5174 --strictPort` then open `http://localhost:5174/?mock` | Browser preview with `src/dev/mockBackend.ts` answering every IPC command (`.claude/launch.json` → `ui-preview`) |
| `npm run build` | Type-check (`tsc`) and build the frontend into `dist/` |
| `npm test` | Run all frontend tests (`vitest run`) |
| `npx vitest run src/stores/mcpStore.test.ts` | Run one test file |
| `npx vitest run -t "claims a task"` | Run tests whose name matches |
| `cargo test --manifest-path src-tauri/Cargo.toml` | Run all backend tests |
| `cargo test --manifest-path src-tauri/Cargo.toml mcp::tools` | Run backend tests of one module (filter by path or name) |
| `cargo clippy --manifest-path src-tauri/Cargo.toml --all-targets` | Lint the backend |
| `cargo fmt --manifest-path src-tauri/Cargo.toml` / `-- --check` | Format / check formatting of the backend |
| `npm run tauri build` | Build the release bundle for the current platform |
| `SWARM_DEMO=1 npm run tauri dev` | Start with demo terminals seeded (`pty::demo_seed`) |

## 7. Before Finishing

- Ensure `npm run build` succeeds (type-check included) and, for backend changes, `cargo build --manifest-path src-tauri/Cargo.toml` succeeds.
- Ensure all tests pass: `npm test` and `cargo test --manifest-path src-tauri/Cargo.toml`.
- Ensure `cargo fmt -- --check` passes and `cargo clippy --all-targets` reports no new warnings.
- Every new or changed branch has a test (no coverage tool is configured).
- New user-visible text exists in both `src/i18n/locales/en.ts` and `pt-BR.ts`.
- New IPC commands are registered in `src-tauri/src/lib.rs`, declared in `src/lib/tauri/commands.ts` (`IpcCommandContract` + `IPC_COMMANDS`) and answered by `src/dev/mockBackend.ts`.
- Changes to MCP tools, environment variables, shortcuts or user-facing features keep `README.md` true.

## 8. Conventions

- Commits follow Conventional Commits, written in English, with the area as scope (`feat(mcp):`, `fix(ui):`, `refactor(pty):`, `chore(dev):`).
- Work happens on `development`; `main` receives releases.
- Never put credentials, tokens or real customer data in code, tests or examples — use fictitious values.
