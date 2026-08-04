# wa-orchestrator

Turn your own WhatsApp number into a remote control for [OpenCode](https://opencode.ai).
Send a message from your phone, [OpenCode](https://opencode.ai) runs it (with full tool access —
bash, file edits, MCP servers, whatever your `opencode` config exposes), and the answer
comes back on WhatsApp, formatted for WhatsApp (not raw GitHub markdown), with the
session id in the footer so you can pick the same conversation back up from a terminal
with:

```bash
opencode -s "ses_xxxxxxxxxxxxxxxxxxxx"
```

Only one phone number is ever allowed to talk to it — every other contact is silently
ignored, on purpose. This is a personal remote control, not a public bot.

## How it works

```
Your phone (WhatsApp)
        │  message
        ▼
whatsapp-mcp bridge          — WhatsApp Web protocol client (Go, whatsmeow)
        │  webhook POST
        ▼
wa-orchestrator (this repo)  — filters sender, serializes requests, tracks session id
        │  spawns
        ▼
opencode run --attach ...    — talks to a warm `opencode serve` instance
        │
        ▼
        reply → markdown→WhatsApp formatting → POST back to the bridge → your phone
```

This project is the **middle layer only**. It expects an already-running,
already-paired [whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp)
bridge (the Go binary that actually speaks the WhatsApp protocol and exposes a
local REST API + webhook), and an [OpenCode](https://opencode.ai) install.

### Why a warm `opencode serve` instead of a fresh `opencode run` per message

A cold `opencode run` re-initializes every MCP server configured in your
`opencode.json` (docs servers, database tools, whatever you have wired up) on
every single invocation — that can take 1-2+ minutes depending on how much
you have configured. Keeping one `opencode serve` process warm and using
`opencode run --attach <url>` for every message cuts a typical reply down to
single-digit seconds.

### Why every `opencode run` call is serialized

Running two `opencode run --attach` calls concurrently against the same warm
server has been observed to deadlock both requests indefinitely (no error,
no timeout — just stuck). This project processes exactly one message at a
time through an internal queue to avoid that.

### Why `--auto` is required

Headless mode has no TTY to approve tool-permission prompts (bash commands,
file edits, etc). Without `--auto`, the first tool call in any message hangs
forever waiting for an approval that can never arrive. This is a real
trade-off: the agent runs with auto-approved permissions on every message
sent from your allowed number. Keep `WA_OPENCODE_CWD` pointed at a directory
you're comfortable with an LLM having full read/write/bash access to.

## Setup

### 1. Prerequisites

- A working [whatsapp-mcp](https://github.com/verygoodplugins/whatsapp-mcp) bridge,
  already paired (QR scanned) and running, with its REST API reachable (default
  `http://127.0.0.1:8080`).
- [OpenCode](https://opencode.ai) installed and authenticated (`opencode auth login`).
- Node.js 18+.

### 2. Configure

```bash
cp .env.example .env
# edit .env, set WA_ALLOWED_NUMBER to your own number (digits only, with country code)
```

### 3. Run a warm OpenCode server

```bash
opencode serve --port 4096 --hostname 127.0.0.1
```

### 4. Point the bridge's webhook at this orchestrator

Set `WEBHOOK_URL=http://127.0.0.1:8090/webhook` in the environment the
whatsapp-mcp bridge runs with, then (re)start it.

### 5. Run the orchestrator

```bash
node orchestrator.mjs
```

Send yourself a WhatsApp message from the allowed number — you should get a
reply within a few seconds.

## Commands

Send these as WhatsApp messages to control the bot itself (case-insensitive):

| Command | Effect |
| --- | --- |
| `/novo`, `/new`, `/reset`, `/limpar` | Discard the current session; the next message starts a brand new OpenCode conversation. Keeps whatever directory `cd` last left you in. |
| `/status` | Uptime, current directory, active session id, warm-server health. |

Note: deleting/clearing a chat on your phone does **not** reset anything —
that's a local, device-only action WhatsApp never syncs to linked devices.
Use `/novo` explicitly when you want a clean slate.

## Terminal passthrough

Messages whose first word matches a small allowlist (`cd`, `ls`, `pwd`,
`git`, and common oh-my-zsh git aliases like `gco`, `gst`, `gaa`, ...) are
run **directly as shell commands**, not sent to the LLM. Output comes back
verbatim in a WhatsApp code block, no tokens spent.

`cd` is special-cased: since every command runs in its own subprocess, a
real `cd` wouldn't persist anything. Instead the orchestrator tracks a
per-conversation "current directory" in `state.json` and resolves `cd`
targets against it (`~`, `~/x`, `..`, relative and absolute paths all work).
That same tracked directory is then used as `--dir` for **every** OpenCode
prompt too — so `cd some-project` followed by a plain-English question
operates on `some-project`, no need to repeat the path.

```
cd api-consig
ls
explica esse projeto pra mim
```

Extend the allowlist with `WA_SHELL_COMMANDS` (comma-separated) in `.env` if
you use other aliases. Anything not on the list — including plain English,
questions, or multi-word instructions — goes to OpenCode as usual.

Commands run through your login shell (`zsh -ic` by default, see
`WA_SHELL`) so your actual aliases and rc file are honored, with a 30s
timeout.

## Running as a persistent service (systemd --user, Linux)

Three units, in dependency order: `whatsapp-bridge` → `opencode-server` →
`wa-orchestrator`. Example unit files are in [`systemd/`](./systemd). Enable
with `loginctl enable-linger $USER` so they survive logout and start on boot
without a graphical session.

```bash
mkdir -p ~/.config/systemd/user
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now whatsapp-bridge opencode-server wa-orchestrator
loginctl enable-linger "$USER"
```

## Environment variables

See [`.env.example`](./.env.example) for the full list; `WA_ALLOWED_NUMBER`
is the only one without a default — the process refuses to start without it.

## Security notes

- `WA_ALLOWED_NUMBER` is a hard allowlist of exactly one contact. No group
  chats, no other numbers — messages from anyone else are dropped before
  anything else happens.
- The bridge's bearer token (`store/.bridge-token`) is read from disk, never
  hardcoded or logged.
- `--auto` means every tool call the model makes is auto-approved. Only run
  this against a working directory / project you'd trust an unattended agent
  with.
- `state.json` and `orchestrator.log` are gitignored — they're runtime state
  for your own conversations, not something to commit.

## License

MIT
