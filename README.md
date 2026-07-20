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
- **Keyboard-first** — every action has a shortcut, and every shortcut is remappable.
- **Auto-updates** — new versions install themselves in the background.

## Tech stack

| Layer    | Tech                                                               |
| -------- | ------------------------------------------------------------------ |
| Shell    | [Tauri 2](https://tauri.app) (Rust)                                |
| Frontend | React 19 + TypeScript + Vite                                       |
| Terminal | [xterm.js](https://xtermjs.org) + `portable-pty`                   |
| Voice    | [whisper-rs](https://github.com/tazz4843/whisper-rs) + cpal        |

## Getting started

Prerequisites: [Node.js](https://nodejs.org), [Rust](https://rustup.rs), and the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) for your OS.

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
