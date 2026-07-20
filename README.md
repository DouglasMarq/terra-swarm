# Terra Swarm

**Mission control for AI coding agents.** Run Claude, Codex, OpenCode, Kimi and plain shells side by side in one native window — organized by project, monitored at a glance.

![Terra Swarm demo](docs/media/terra-swarm-demo.gif)

[Full-quality MP4](docs/media/terra-swarm-demo.mp4)

## Features

- **Workspaces** — one workspace per project folder. Switch instantly with `⌘1…9` (macOS) / `Ctrl+1…9`, reorder via drag & drop, see the git branch of each workspace at a glance.
- **Agent grid** — spawn terminals running `claude`, `codex`, `opencode`, `kimi` or any shell into a resizable, drag-to-reorder grid. Installed agents are auto-detected.
- **Session resume** — on startup, Terra Swarm offers to bring back every terminal that was running when you quit, using agent-native continuation (`claude --continue`, `codex resume --last`, …) so agents pick up where they left off.
- **Voice input** — dictate prompts into the focused terminal. Powered by local Whisper models (offline, GPU-accelerated on macOS), with per-model downloads and 16 languages.
- **Notifications & context tracking** — get badged when an agent needs attention, jump straight to the terminal, and watch per-agent context-window usage.
- **Keyboard-first** — every shortcut is remappable in Settings, with per-platform defaults.
- **Auto-updates** — built-in updater keeps the app current.

## Tech stack

| Layer    | Tech                                                        |
| -------- | ----------------------------------------------------------- |
| Shell    | [Tauri 2](https://tauri.app) (Rust)                          |
| Frontend | React 19 + TypeScript + Vite                                 |
| Terminal | [xterm.js](https://xtermjs.org) + `portable-pty`             |
| Voice    | [whisper-rs](https://github.com/tazz4843/whisper-rs) + cpal  |

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

## Demo video

The demo above is generated with [Remotion](https://remotion.dev) from `video/`. To tweak and re-render it:

```bash
cd video
npm install
npm run studio   # live preview
npm run render   # docs/media-ready MP4 (1920x1080 @ 30fps)
npm run gif      # looping GIF (1280x720 @ 30fps)
```
