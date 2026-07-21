---
name: Terra Swarm
description: Mission control for AI coding agents — one native window, every agent side by side as a real PTY.
colors:
  bg: "#101013"
  bg-sidebar: "#131316"
  bg-panel: "#17171b"
  bg-elevated: "#1d1d22"
  bg-hover: "#232329"
  terminal-bg: "#0c0c0e"
  border: "#26262c"
  border-strong: "#34343c"
  text: "#e4e4e7"
  text-muted: "#8e8e96"
  text-faint: "#5b5b64"
  accent: "#fafafa"
  green: "#4ade80"
  green-dim: "#4ADE801A"
  amber: "#e0b45c"
  red: "#e5636f"
typography:
  display:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif"
    fontSize: "16px"
    fontWeight: 700
    lineHeight: 1.3
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 600
    lineHeight: 1.4
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.4
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif"
    fontSize: "11px"
    fontWeight: 400
    lineHeight: 1.4
  micro:
    fontFamily: "-apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Segoe UI', Roboto, sans-serif"
    fontSize: "10px"
    fontWeight: 600
    letterSpacing: "0.09em"
    lineHeight: 1.4
  terminal:
    fontFamily: "'SF Mono', Menlo, Monaco, 'Courier New', monospace"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.2
rounded:
  sm: "4px"
  md: "6px"
  lg: "8px"
  xl: "10px"
  modal: "14px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
components:
  button-default:
    backgroundColor: "{colors.bg-elevated}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-default-hover:
    backgroundColor: "{colors.bg-hover}"
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "#111113"
    rounded: "{rounded.md}"
    padding: "6px 12px"
  button-primary-hover:
    backgroundColor: "#d4d4d8"
  input:
    backgroundColor: "{colors.bg}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "8px 10px"
  terminal-pane:
    backgroundColor: "{colors.terminal-bg}"
    textColor: "#d4d4d8"
    rounded: "{rounded.xl}"
    typography: "terminal"
  badge:
    backgroundColor: "{colors.bg-hover}"
    textColor: "{colors.text}"
    rounded: "{rounded.md}"
    padding: "2px 8px"
    typography: "label"
---

# Design System: Terra Swarm

## 1. Overview

**Creative North Star: "The Quiet Console"**

Terra Swarm is a dark, dense control room that has learned to keep its mouth shut. The aesthetic is Warp's seriousness applied to a fleet of agents: a near-black zinc palette, terminal-grade typography, and chrome so restrained it registers only when it carries state. Nothing on screen is decorative; every pixel either is agent output or says something true about an agent right now.

The system explicitly rejects IDE chrome overload — toolbars, panels, and ornamentation competing with the terminals for attention. Depth is tonal, not shadowed. Color is a status vocabulary, not a brand wash: green means running, amber means attention, red means failure, and the only "accent" is a white button. Motion is fast (140–250ms) and exists solely to convey state change.

Density is a feature. This is a tool its user opens at the start of a session and leaves open all day; it should feel like a well-made instrument, not a presentation.

**Key Characteristics:**
- Terminal grid is the product; chrome recedes to 38px topbar, 24px statusbar, one sidebar.
- Near-black zinc surfaces, layered tonally — no hue in the neutrals.
- White-on-dark inverted primary button; the interface has no brand color.
- Green / amber / red used exclusively as live agent state.
- Two type voices: system sans for chrome, SF Mono for anything the machine said.
- Flat at rest; shadows exist only on layers floating above the grid.

## 2. Colors

A hue-free zinc scale carries the entire UI; the only saturated colors are a three-word status language.

### Primary
- **Signal White** (`{colors.accent}`): the primary-action fill — white buttons with near-black text (`#111113`). Rarity is the point: one or two per screen, never decoration.
- **Running Green** (`{colors.green}`): an agent is alive — status dots, active toggle, selected nav, context meter at healthy load. Also surfaces as a 10% tint (`{colors.green-dim}`) for selected rows.

### Tertiary
- **Attention Amber** (`{colors.amber}`): something needs the user — unread notifications, per-pane bell chips, warning states, mid-range context usage.
- **Exit Red** (`{colors.red}`): failure and destruction — dead processes, danger menu items, close-hover, mic recording.

### Neutral
- **App Black** (`{colors.bg}`): the root background everything sits on.
- **Terminal Black** (`{colors.terminal-bg}`): one step darker than the app — panes recede so agent output glows forward.
- **Chrome Slate** (`{colors.bg-sidebar}`): topbar, statusbar, sidebar — the frame around the work.
- **Panel Slate** (`{colors.bg-panel}`): pane headers, modals, command blocks.
- **Elevated Slate** (`{colors.bg-elevated}`): resting buttons, popovers, hover-list items.
- **Hover Slate** (`{colors.bg-hover}`): hover fills and meter tracks.
- **Hairline** (`{colors.border}`): default 1px borders.
- **Strong Hairline** (`{colors.border-strong}`): emphasized borders on controls and active items.
- **Ink** (`{colors.text}`): primary text.
- **Murmur** (`{colors.text-muted}`): secondary text, resting icons — and all essential tertiary text (paths, branches, timestamps, placeholders), which measures 5.2–5.8:1 against the surface scale.
- **Whisper** (`{colors.text-faint}`): non-essential rests only — icon glyphs at rest. At 2.5–2.8:1 it never carries text the user must read (measured against `bg`/`bg-sidebar`/`bg-panel`; the candidate bump `#6e6e78` still failed at 3.3–3.8:1, so essential Whisper usages moved to Murmur instead of shifting the token).

### Named Rules
**The Inverted Primary Rule.** The loudest action on any screen is a white button, never a hue. Terra Swarm has no brand color in the UI; identity comes from restraint, not pigment.

**The Three-Word Rule.** Saturated color says exactly one of three things — green: running, amber: attention, red: failed. Using green, amber, or red for anything else (branding, decoration, categorization) is forbidden. Agent identity colors (Claude, Codex, OpenCode, Kimi badge tints) are the only exception, and they appear only on agent badges.

## 3. Typography

**Display Font:** system sans (`-apple-system, "SF Pro Text", "Segoe UI", Roboto`) — there is no display face; chrome never performs.
**Body Font:** the same system sans, 11–13px.
**Label/Mono Font:** SF Mono / Menlo (`{typography.terminal.fontFamily}`) — terminals, command blocks, hotkey chips, column counts.

**Character:** One sans family in a tight, dense scale does all UI work; the mono is reserved as the voice of the machine. Contrast comes from weight (400/500/600) and size, never from a second face.

### Hierarchy
- **Display** (700, 16px): modal headings only — the largest text in the app.
- **Title** (600, 13px): topbar title, workspace names, pane titles.
- **Body** (400, 13px): settings text, menu items, dialog copy.
- **Label** (400, 11px): metadata — paths, branches, timestamps, statusbar.
- **Micro** (600, 10px, +0.09em, uppercase): section headers and badges. Used sparingly — one per panel, never stacked.
- **Terminal** (400, 13px mono, user-adjustable 8–32px): all PTY output and anything the user would copy-paste as a command.

### Named Rules
**The Two Voices Rule.** Chrome speaks the system sans; the machine speaks SF Mono. If text is a command, path the user runs, or agent output, it is mono. Nothing else is.

**The Fixed Scale Rule.** No fluid type, no clamp(), no responsive font sizes. The app is viewed at a consistent DPI; the scale is fixed at 10 / 11 / 12 / 13 / 16px and nothing in between — the former 12.5px (context-menu items) and 9px (bell badge) offenders are converged to 12px and 10px. Chrome renders with `-webkit-font-smoothing: antialiased`; numeric meters and counters always use `tabular-nums`.

## 4. Elevation

Surfaces are flat at rest; depth is conveyed by tonal steps on the zinc scale (`bg` → `bg-sidebar` → `bg-panel` → `bg-elevated` → `bg-hover`). Box-shadows exist only where a layer physically floats above the terminal grid.

### Shadow Vocabulary
- **Pane rest** (`0 1px 4px rgba(0,0,0,0.35)`): the only resting shadow — barely-there separation between panes and the app background.
- **Floating menu** (`0 8px 24px rgba(0,0,0,0.45)`): context menus.
- **Popover** (`0 12px 32px rgba(0,0,0,0.5)`): topbar panels (notifications, grid layout).
- **Modal** (`0 24px 64px rgba(0,0,0,0.55)`): dialogs over the dimmed, blurred backdrop (`rgba(0,0,0,0.55)` + 2px blur).
- **Focus ring** (`0 0 0 3px rgba(113,113,122,0.18)`, token `--focus-ring`): the keyboard `:focus-visible` halo on every interactive element — buttons, icon buttons, inputs, sidebar rows, menu items, toggles, pickers. Zinc, never a colored glow; mouse clicks never show it. Text inputs also get it on `:focus`, since typing is always a keyboard context.

### Named Rules
**The Floating-Only Rule.** If a surface doesn't float, it gets no shadow. Resting cards, sidebar items, and list rows are tonal, not shadowed. If a new component wants a resting shadow beyond pane-rest, the design is wrong, not the token.

## 5. Components

### Buttons
- **Shape:** gently rounded (6px), compact padding (6px 12px) over a 14px line-height — a consistent 26px effective height, border included.
- **Default:** Elevated Slate fill with a Strong Hairline border; hover lifts to Hover Slate.
- **Primary:** Signal White fill, near-black text, weight 600; hover dims to `#d4d4d8`. One per screen.
- **Press:** every button compresses to `scale(0.97)` on `:active` (80ms) — the app's handshake.
- **Focus:** `:focus-visible` draws the `--focus-ring` zinc halo; pointer interaction shows nothing.
- **Icon buttons:** transparent at rest, Murmur icon, Hover Slate wash on hover; glyph-only at 24–30px square; disabled is opacity 0.4, never a gray fill.

### Chips / Badges
- **Style:** Hover Slate pill (6px radius, 2px 8px padding, 11px/600) for agent names — tinted per-agent background/fg pairs (Claude amber-brown, Codex teal, OpenCode moss, Kimi violet).
- **State badges:** green-on-`green-dim` for counts and selections, amber-on-`#36301c` for unread/notification, green fill with `#052e16` text for the bell counter.

### Cards / Containers
- **Corner Style:** panes and popovers 10px, context menus 8px, modals 14px.
- **Background:** Terminal Black for panes, Elevated Slate for menus and popovers, Panel Slate for modals.
- **Shadow Strategy:** per the Floating-Only Rule — resting containers are tonal.
- **Border:** 1px Hairline; focused panes swap to a `#52525b` ring, drop targets to `#a1a1aa`.

### Inputs / Fields
- **Style:** App Black fill, Strong Hairline border, 6px radius, 8px 10px padding.
- **Placeholder:** Murmur — guaranteed ≥ 4.5:1 against the field.
- **Focus:** border brightens to `#71717a` plus the zinc focus halo.
- **Disabled:** opacity 0.4.

### Navigation
- **Topbar (38px):** Chrome Slate, 13px/600 centered title, 14px icon buttons right. Left padding reserves 78px for macOS traffic lights. The unread counter is a 10px/700 Running Green pill with `tabular-nums`.
- **Sidebar (272px, collapses to 46px):** workspace rows (8px 12px padding) — 13px/500 name over 11px Murmur path/branch, running-green status dot, amber notification dot. Hover reveals actions; active row is Elevated Slate with a Strong Hairline border. Collapsed form is a 28px letter-dot per workspace.
- **Statusbar (24px):** Chrome Slate, 11px metadata, breathing green "agents running" dot.

### Terminal Pane (signature component)
The product. Terminal Black body with a Panel Slate header (6px 8px 6px 14px padding; title 11px/600, agent badge, context meter, icon actions revealed on hover or focus-within). 10px radius, 1px Hairline border, min 240×200px, 12px grid gap. Focused state is exactly one `0 0 0 1px #52525b` ring carried by box-shadow alone — the border stays Hairline so the two never stack into a 2px read. No glow, no color. Exit state is an 88%-black overlay with Exit Red text. The context-usage meter is a 34×4px bar that walks green → amber → red with `tabular-nums` percentage; its fill is a full-width bar scaled with `transform: scaleX(fraction)` (300ms `--ease-out`), so updates composite instead of re-laying-out.

### Toggles & Menus
- **Toggle:** 38×22px pill, Hover Slate off / Running Green on, 16px knob, 120ms travel.
- **Context menu:** Elevated Slate, 8px radius, 4px inset padding, 12px items on the 4/8/12 padding rhythm; danger items in Exit Red. Sits at `--z-dropdown`; topbar popovers at `--z-popover`. The grid itself is static — panes stay in spawn order at fixed, even sizes (no resize, no reorder); the only grid motion is the spawn/close FLIP glide and the `pane-enter` fade.

## 6. Do's and Don'ts

### Do:
- **Do** let the terminal grid own the window — chrome earns pixels only by carrying state (notification, context usage, git branch), per PRODUCT.md.
- **Do** keep transitions on the motion tokens — `--dur-hover` (140ms) for control state, `--dur-press` (80ms) for the button handshake, `--dur-med` (200ms) with `--ease-out` (`cubic-bezier(0.22, 1, 0.36, 1)`) for entrances; motion conveys state, nothing else.
- **Do** use the fixed type scale (10 / 11 / 12 / 13 / 16px) and the two voices exactly as defined.
- **Do** express every interactive component in all its states: default, hover, focus-visible, active, disabled. Keyboard focus always has the zinc halo; pointer focus never does.
- **Do** honor `prefers-reduced-motion` — the app ships a global reduce path; every new animation joins it.
- **Do** keep contrast at WCAG AA minimum against the dark surfaces — check, don't assume. Essential text never dips below Murmur (5.2:1 worst case); Whisper is for decorative rests only.

### Don't:
- **Don't** ship IDE chrome overload — PRODUCT.md's named anti-reference: toolbars, panels, or ornamentation that compete with agent output instead of serving it.
- **Don't** introduce a brand hue into the UI. No colored primary buttons, no gradient anything, no tinted neutrals outside the zinc scale.
- **Don't** use green, amber, or red decoratively — the Three-Word Rule is absolute.
- **Don't** add resting shadows to non-floating surfaces, or glow/ring effects beyond the single `#52525b` focused-pane ring and the zinc `--focus-ring` halo.
- **Don't** use a display font, a second sans, or fluid typography anywhere in chrome.
- **Don't** gate content on entrance animations; panes and lists are visible by default, motion only enhances.
- **Don't** reach for a modal as a first thought — inline and progressive disclosure first; modals are for spawning and settings, not workflow.
