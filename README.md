# Terra Swarm

**Mission control for AI coding agents.** Run Claude, Codex, OpenCode, Kimi and plain shells side by side in one native window — organized by project, monitored at a glance.

![Terra Swarm demo](docs/media/terra-swarm-demo.gif)

## What is Terra Swarm?

Terra Swarm is a desktop app for working with multiple AI coding agents at once. Instead of juggling terminal windows and tabs, you get a single window where each project is a **workspace**, and each workspace holds a grid of terminals — one per agent. Every pane is a real PTY, so agents behave exactly as they do in your normal terminal.

## Features

- **Workspaces** — one workspace per project folder. Switch instantly, reorder via drag & drop, and see the git branch of each workspace at a glance.
- **Agent grid** — spawn `claude`, `codex`, `opencode`, `kimi` or any shell into a resizable, drag-to-reorder grid. Installed agents are auto-detected on your PATH.
- **Session resume** — when you reopen the app, Terra Swarm offers to bring back every terminal that was running when you quit, using agent-native continuation (`claude --continue`, `codex resume --last`, …) so agents pick up exactly where they left off.
- **Voice input** — dictate prompts straight into the focused terminal. Powered by local Whisper models: fully offline, GPU-accelerated on macOS, with per-model downloads and 16 languages.
- **Notifications** — get badged when an agent finishes or needs input, and jump straight to the right terminal from the notification center.
- **Context tracking** — watch each agent's context-window usage live, so you know before it runs out.
- **Agent coordination (MCP)** — a built-in MCP server gives the agents of a project a shared task board, messages between them and shared notes, with a live Tasks panel. See [below](#agent-coordination-mcp).
- **Keyboard-first** — every action has a shortcut, and every shortcut is remappable.
- **Auto-updates** — new versions install themselves in the background.

## Agent coordination (MCP)

Terra Swarm runs a small [MCP](https://modelcontextprotocol.io) server inside the app so the agents working on the same project can coordinate. Each project (workspace) gets:

- a **shared task board**, also shown live in the **Tasks** tab of the right panel (`⌘I`), where you can add tasks, move them between statuses and assign them;
- **messages** between agents, directly or to everyone;
- **shared notes**: project memory that outlives sessions (commands, conventions, decisions);
- a **status** per agent (`working`, `idle`, `needs_input`, `blocked`).

### How agents connect

The server listens on `127.0.0.1` only, on a free port picked at startup, and speaks Streamable HTTP at `/mcp`. Every terminal Terra Swarm opens gets its own random token, and these variables in its environment:

| Variable             | Value                                           |
| -------------------- | ----------------------------------------------- |
| `TERRA_MCP_URL`      | `http://127.0.0.1:<port>/mcp`                   |
| `TERRA_MCP_TOKEN`    | Bearer token of this terminal                   |
| `TERRA_PANE_ID`      | Terminal id, e.g. `t-3` (how agents address each other) |
| `TERRA_WORKSPACE_ID` | Project id                                      |

Requests without a valid token get `401`. The token decides who the caller is and which project it sees: an agent can never read or change another project's board. The token is revoked when the terminal exits or is closed.

Known agent CLIs are registered automatically when Terra Swarm launches them (including session resume):

- **Claude Code** — `--mcp-config <app data>/mcp/claude-mcp.json`, a file that reads the URL and token from the variables above (it holds no secret).
- **Codex** — `-c mcp_servers.terra.url=… -c mcp_servers.terra.bearer_token_env_var=TERRA_MCP_TOKEN`.

Other agents still get the environment variables, so you can point any MCP client that supports HTTP servers at `$TERRA_MCP_URL` with the header `Authorization: Bearer $TERRA_MCP_TOKEN`.

### Tools

| Tool            | What it does                                                                 |
| --------------- | ---------------------------------------------------------------------------- |
| `whoami`        | Your terminal id, agent and project, and the teammates connected with their state |
| `list_tasks`    | Tasks of the project (active first, then priority and board position), filtered by `status` and/or `assignee` (`"me"` works); `blocked_by` lists unfinished dependencies |
| `get_task`      | One task with its description, dependencies and latest history events       |
| `create_task`   | Add a task (`title`, `description`, `priority`, `depends_on`, `labels`)      |
| `claim_task`    | Take a `todo` task; atomic, fails if someone else has it or a dependency isn't done |
| `update_task`   | Change status and/or add a note to the task's history                       |
| `complete_task` | Hand your task in for review with a summary (moves it to `review`)          |
| `send_message`  | Message a teammate by terminal id, or `"all"`                               |
| `read_inbox`    | Your messages, oldest first; marks them read (`unread_only` defaults to true, `limit` to 50) |
| `add_note`      | Save a project note; a note with the same `key` is replaced                  |
| `search_notes`  | Full-text search (SQLite FTS5) over note keys and text, best matches first (`limit` defaults to 20) |
| `report_status` | Set your state and a one-line summary                                        |

Tasks move through `todo → in_progress → review → done`, with `blocked` for waiting. Every change is kept in the task's history (created, claimed, status, assigned, note, completed).

### Storage

Everything lives in a SQLite database, `<app data>/mcp.db` (on macOS `~/Library/Application Support/com.terra-swarm.app/mcp.db`; **Settings → Agents** shows the exact path). Messages, notes and task history are kept in full. Closing a project deletes its board, messages and notes. Agent statuses and tokens are kept in memory only. If the database can't be opened or upgraded, the app keeps working with the MCP server off, and Settings shows the reason.

### Turning it off

**Settings → Agents → Expose Terra MCP to agents.** When it is off, new terminals get no token, no variables and no extra CLI flags. Agents already running keep their connection until they exit. The same card shows the server's current URL and port.

## Tech stack

| Layer    | Tech                                                        |
| -------- | ----------------------------------------------------------- |
| Shell    | [Tauri 2](https://tauri.app) (Rust)                         |
| Frontend | React 19 + TypeScript + Vite                                |
| Terminal | [xterm.js](https://xtermjs.org) + `portable-pty`            |
| Voice    | [whisper-rs](https://github.com/tazz4843/whisper-rs) + cpal |

## Getting started

Prerequisites: [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

On Linux, also install:

```bash
sudo apt install -y build-essential cmake pkg-config clang libclang-dev \
  libdbus-1-dev libasound2-dev \
  libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev patchelf
```

```bash
npm install
npm run tauri dev
```

Build a release bundle:

```bash
npm run tauri build
```

## Keyboard shortcuts (macOS defaults)

| Action             | Shortcut  |
| ------------------ | --------- |
| New terminal       | `⌘T`      |
| Close terminal     | `⌘W`      |
| Maximize terminal  | `⌘Enter`  |
| New workspace      | `⇧⌘N`     |
| Switch workspace   | `⌘1…9`    |
| Focus terminal     | `⇧⌘1…9`   |
| Toggle voice input | `⇧⌘Space` |

All shortcuts can be rebound in **Settings → Keyboard shortcuts**.
