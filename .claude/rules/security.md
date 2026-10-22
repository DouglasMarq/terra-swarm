## Secrets and data

- !IMPORTANT: NEVER put credentials, tokens, keys or connection strings in code, tests, examples or docs. The updater signing key (`TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD`) and `GITHUB_TOKEN` exist only as GitHub Actions secrets in `.github/workflows/release.yml`; only the public key (`plugins.updater.pubkey` in `tauri.conf.json`) is committed.
- !IMPORTANT: NEVER use real customer data (names, emails, paths with real user names, repository names, agent transcripts) in code, tests, fixtures, mock data (`src/dev/mockBackend.ts`) or examples — use fictitious values (`/Users/me/...`, `t-1`, `ws-terra`).
- NEVER log credentials, MCP tokens, environment variables of a terminal or terminal output. Mask or omit them. User-facing error details go through `src/components/system/errorModel.ts`, which strips paths and token-like strings.
- `.env` files are never read or committed; the app itself reads no `.env`.

## Local servers (MCP and hooks)

- !IMPORTANT: The axum server binds `127.0.0.1` only, on a free port (`mcp/server.rs::start`). NEVER bind `0.0.0.0` or a fixed public interface.
- !IMPORTANT: Every route (`/mcp`, `/hooks`, `/hooks/claude`) sits behind the bearer-token middleware (`authenticate`); a request without a valid token gets `401` with `WWW-Authenticate: Bearer`. NEVER add a route outside that layer.
- !IMPORTANT: The caller's identity (terminal id, workspace id, agent, role) comes ONLY from its token (`AgentIdentity` resolved by `TokenRegistry`) — NEVER from tool arguments, headers or the request body. Every tool and store call uses `who.workspace_id`; an agent can never see another workspace's board, messages or notes.
- Tokens are 256-bit random (`getrandom`), held in memory only, one per terminal, replaced when the terminal is respawned and revoked when it exits or closes and when its workspace closes. They reach the agent only through its process environment (`TERRA_MCP_TOKEN`); files written for CLIs (`claude-mcp.json`, `claude-hooks.json`) reference the variable and hold no secret.
- Users' own environment variables for a terminal can NEVER override `TERRA_*` variables (`pty::valid_env`).
- Browser origins are rejected: the MCP service enforces origin validation and hook routes answer `403` to any request carrying `Origin`. Request bodies are capped (`MAX_BODY_BYTES`, `MAX_HOOK_BODY`).
- Errors returned to agents are short English messages (`ToolError`: unknown tool → JSON-RPC invalid params, invalid arguments and store errors → a tool result with `is_error`), never stack traces, SQL or file contents. Hook routes answer bare status codes (`400`, `401`, `403`, `413`, `200` with an empty body).
- Role checks happen in the tool (`assign_task` is orchestrator only); NEVER trust a role claimed in arguments.

## Processes and shells

- The command a user types for a terminal runs in their login shell by design (`sh -l -c "exec <command>"`, PowerShell `-Command`, `cmd /C`). That string is the user's own input; NEVER build it from agent-, MCP- or network-provided text.
- !IMPORTANT: Values the app adds to a command line (config paths, role prompts, URLs) are quoted with `mcp::launch::quote` for the target shell (`Quoting::Posix` / `Quoting::Windows`). NEVER interpolate them raw.
- !IMPORTANT: `git` and `gh` run with argument arrays (`Command::new("git").arg("-C").arg(dir).args(args)`, `worktree::git`, `review::run`), with `GIT_TERMINAL_PROMPT=0`. NEVER pass a single string to a shell to run git, and validate or separate (`--`) user values that could start with `-`.
- Agent detection only checks ids from the compiled-in catalog (`agents.json`); NEVER run `command -v` with an arbitrary string.
- Text the app types into a terminal on its own (orchestrator nudges from `assign_task`) goes only to idle agents, never to one that is working or waiting for the user.

## File access

- !IMPORTANT: Paths from the frontend are workspace-relative and validated with `workspace::safe_relative_path` (no absolute paths, no `..`, no NUL), then canonicalized and checked with `starts_with(workspace_root)` so symlinks can't escape. NEVER open a path from IPC without both steps.
- The editor refuses files over `MAX_EDIT_BYTES` and refuses to overwrite a file that changed on disk since it was read (agents edit the same files).
- Ids used as file names are validated as plain path components and symlinks are refused, as `scrollback.rs` does.

## Webview

- The CSP in `tauri.conf.json` allows frames only from `localhost`/`127.0.0.1`; the Preview panel also refuses any other host (`previewStore.ts`). NEVER widen either to remote origins.
- !IMPORTANT: Capabilities (`src-tauri/capabilities/default.json`) grant the minimum. Adding a permission or plugin is a security decision to raise with the user; NEVER grant shell, fs or http plugin scopes to the webview.
- Downloads (Whisper models) come from fixed HTTPS URLs in `voice/models.rs`; updates are verified by the updater signature.

## Input handling

- Validate all external input (IPC arguments, MCP tool arguments, hook payloads, persisted files, PTY output used for detection) at the boundary before it reaches the module logic: typed deserialization, length caps, enum values (`STATUS_VALUES`, `PRIORITY_VALUES`).
- !IMPORTANT: NEVER concatenate input into SQL, shell commands, file paths or templates — use bound parameters, argument arrays and the path helpers above.

## Dependencies

- Prefer well-maintained libraries with MIT/Apache licenses. Justify any new dependency (npm or crate), and prefer what is already installed.
