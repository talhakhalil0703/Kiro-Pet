# Kiro Pet

Kiro Pet is a native macOS desktop companion for the Kiro IDE. It watches Kiro's
local or Remote SSH chat lifecycle records and animates Ghosty above normal application
windows:

- **Idle**: calm floating and blinking
- **Running**: active movement and scanning eyes
- **Waiting**: attentive pose when a chat needs input
- **Review**: short celebration when a turn completes
- **Failed**: visible error reaction

Multiple chats are aggregated with this priority: waiting, failed, running,
review, idle. A badge shows concurrent activity.

Active chats show a status card with the Kiro session title. Waiting, failed,
and completed alerts remain until clicked; clicking the card focuses Kiro and
opens that exact chat session.

## How Codex Pet Works

The installed Codex desktop app uses two layers:

1. A versioned transparent sprite atlas maps app activity to animation rows:
   idle, directional drag, waving, jumping, failed, waiting, running, review,
   and look directions.
2. A frameless transparent Electron panel is `alwaysOnTop` at macOS's floating
   window level. A native AppKit bridge handles Spaces, window parenting,
   dragging, and switching between click-through and interactive hit testing.

Kiro Pet uses the same split architecture, adapted to public/local Kiro
contracts. The IDE extension monitors chat state, while a small AppKit helper
owns the cross-application panel. The helper hosts a transparent local WebKit
view and receives state snapshots over loopback-only UDP.

## Kiro State Detection

Kiro 1.0.138 persists IDE sessions under:

```text
~/.kiro/sessions/<workspace-hash>/<session-id>/
├── session.json
└── messages.jsonl
```

`session.json` exposes the coarse states `in_progress`, `waiting_on_user`,
`completed`, `idle`, and `failed`. `messages.jsonl` adds explicit `turn_start`
and `turn_end` markers, which lets the pet react during a first turn before the
metadata file exists.

For Remote SSH workspaces, the extension reads session status and title from
`session.json` through Kiro's existing `vscode-remote` filesystem connection.
Locally, it also reads exact lifecycle marker text in the
last 128 KiB of each transcript. It does not parse, retain, or transmit chat
content. All communication stays on `127.0.0.1`.

## Build And Install

Requirements:

- macOS 12 or newer
- Kiro IDE 1.0.138 or newer
- Node.js 20 or newer
- Xcode Command Line Tools

```bash
npm install
npm test
npm run package
/Applications/Kiro.app/Contents/Resources/app/bin/code \
  --install-extension kiro-pet-0.1.2.vsix
```

Reload Kiro after installation. Use the **Kiro Pet** commands from the Command
Palette to show, hide, restart, reset, or make the pet click-through. Drag the
pet directly when click-through is disabled.

## Design Notes

- The helper is a singleton per macOS user. Multiple Kiro windows send the same
  aggregate state to a fixed loopback UDP port.
- The helper exits after 12 seconds without a Kiro extension heartbeat.
- Running states older than six hours are treated as stale after a crash.
- Failed states remain visible for up to one hour; waiting states for one day.
- The first release ships a macOS helper. The extension boundary is
  platform-neutral so Windows and Linux helpers can implement the same JSON
  protocol later.
