# openclaw-coding-cli-bridge

Zero-dependency Node.js bridges that expose agentic **coding CLIs** as an
**OpenAI-compatible API**, so [OpenClaw](https://openclaw.ai) — or any other
OpenAI-API client — can use them as model backends with your existing CLI login:

| Backend | File | Port | CLI |
|---|---|---|---|
| Claude Code | `claude_proxy.js` | 8001 | `claude -p --output-format stream-json` |
| Google Antigravity | `proxy.js` | 8000 | `agy --print` |

Both share one client contract: model ids with a `-ro` suffix select a read-only
permission role, a concurrency semaphore with a bounded queue protects small hosts,
visible `⏳` progress ticks keep OpenClaw's stall detector (~400 s) fed during long
agent runs, every failure is reported as an SSE `error` event (never as content that
looks like a successful answer), and exact-match control replies (`NO_REPLY`,
`HEARTBEAT_OK`, …) are passed through byte-for-byte.

The CLIs run locally under your own account through their official entry points —
no OAuth tokens are extracted or shared. Usage counts against your own plan/limits.

## Claude Code backend (`claude_proxy.js`)

```
OpenClaw gateway
      │  POST /v1/chat/completions
      ▼
claude_proxy.js (127.0.0.1:8001)
      │  spawn per request (cwd = neutral workdir or a named project):
      │  claude -p --output-format stream-json --verbose --include-partial-messages
      │         --no-session-persistence --model X [--effort Y]
      │         --append-system-prompt-file <system msgs> --mcp-config <file>
      │         <role flags>                     (prompt on stdin)
      ▼
Claude Code agent loop: built-in tools + MCP servers (Home Assistant, …)
```

Simpler than the agy bridge because Claude Code streams **structured events**: every
model turn, tool call, tool result, rate-limit state and the final `result` (with
`is_error` and `permission_denials`) is a stdout line. No log tailing or `/proc`
sampling is needed.

### Model ids

`<model>[:<project>][-ro]`

| Id | Runs |
|---|---|
| `claude-sonnet`, `claude-opus`, `claude-haiku`, `claude-fable` | latest model of that family |
| `claude-opus-high` | `claude-opus-5-5 --effort high` |
| `claude-code` | `CC_MODEL` (default `sonnet`) |
| `claude-<full-id>` | that exact model, e.g. `claude-sonnet-5` |
| `…:ha` | inside project `ha` (see below) |
| `…-ro` | read-only role |

`@` is deliberately not used: OpenClaw parses `model@profile` as an auth-profile selector.

### Roles

- **full** — `--dangerously-skip-permissions`.
- **ro** — `--permission-mode dontAsk` (anything not allowed is denied at once, no
  hang), built-in tools narrowed with `--tools` (default `Read,Glob,Grep,WebSearch,WebFetch`;
  without it, Bash commands Claude Code classifies as read-only are still auto-approved),
  an allowlist from `ro-allow.json`, and deny rules for secrets
  (`secrets.yaml`, `.env*`, `*.pem`, `*.key`, `.ssh/`) plus per-project `roDeny`.
  A `Read` deny also hides the file from `Grep`/`Glob`. Denials are logged and appended
  as a visible `⚠️ [proxy]` note.

User settings are never loaded (`--setting-sources ""`), so personal hooks, plugins and
permission rules stay out of bridge runs. In the ro role project settings are not
loaded either — a project's own allowlist would silently widen the role.

### Projects

`~/.config/openclaw-claude/projects.json`:

```json
{ "ha": { "dir": "/home/me/projects/homeassistant",
          "roDeny": ["Read(//home/me/projects/homeassistant/config/secrets.yaml)"] } }
```

`claude-sonnet:ha` starts in that directory, so Claude Code loads the project's
`CLAUDE.md` (in both roles) and, in the full role, its `.claude/settings*.json`.

### Delegating to OpenClaw agents (`mcp/openclaw-agents.js`)

Both bridges ignore the OpenAI `tools` field, so a main agent served through them can't
call OpenClaw's `sessions_spawn`. The bundled MCP server gives it an `ask_agent` tool
instead: one synchronous turn via
`openclaw agent --agent <id> --session-key agent:<id>:cc-<uuid> --json`. The subagent
keeps its own model and permissions from `openclaw.json`. Agents and their descriptions
come from `OPENCLAW_AGENTS` (JSON). While a tool call is open the idle timeout is
suspended; only the hard limit applies.

### Setup

```bash
tools/build-claude-profile.py
# → ~/.config/openclaw-claude/mcp.json       (from agy's mcp_config.json + openclaw_agents)
#   ~/.config/openclaw-claude/ro-allow.json  (from the agy RO profile: mcp(s/t) → mcp__s__t)
#   ~/.config/openclaw-claude/projects.json  (created empty once)
node claude_proxy.js
curl -s localhost:8001/healthz
```

These files live outside the repo on purpose — MCP configs carry private URLs/tokens.

systemd user unit (`~/.config/systemd/user/openclaw-claude-proxy.service`):

```ini
[Service]
ExecStart=/usr/bin/node %h/projects/openclaw/claude_proxy.js
Restart=always
KillMode=control-group
Environment=PATH=%h/.local/bin:/usr/bin:/usr/local/bin:/bin
Environment=CC_PROXY_PORT=8001
Environment=CC_MAX_CONCURRENT=2
Environment=CC_MAX_QUEUE=4
[Install]
WantedBy=default.target
```

OpenClaw provider (`models.providers` in `openclaw.json`; also list each
`cc/<id>` in `agents.defaults.models` **without** an alias, and in `modelPolicy.allow`):

```json
"cc": {
  "baseUrl": "http://127.0.0.1:8001",
  "api": "openai-completions",
  "apiKey": "cc-local-proxy",
  "models": [{ "id": "claude-opus-high", "name": "Claude Opus (high effort)",
               "contextWindow": 200000, "maxTokens": 8192, "input": ["text"],
               "cost": { "input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0 },
               "reasoning": false }]
}
```

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `CC_PROXY_PORT` | `8001` | Listen port (127.0.0.1). |
| `CC_MODEL` / `CC_EFFORT` | `sonnet` / unset | Default model / effort. |
| `CC_MAX_CONCURRENT`, `CC_MAX_QUEUE`, `CC_QUEUE_TIMEOUT_MS` | 2, 4, 10 min | Semaphore. |
| `CC_IDLE_MS`, `CC_HARD_MS` | 15 min, 30 min | No-event timeout / absolute limit. |
| `CC_WORKDIR` | `~/.openclaw-claude/work` | cwd when no project is selected (readable in ro — keep it clean). |
| `CC_CONFIG_DIR` | `~/.config/openclaw-claude` | `mcp.json`, `ro-allow.json`, `projects.json`. |
| `CC_RO_TOOLS` | `Read,Glob,Grep,WebSearch,WebFetch` | Built-in tools in the ro role. |
| `CC_DEFAULT_ROLE` | `full` | Role for ids without `-ro`. |
| `CC_PROXY_DEBUG` | unset | Dump dir for the last system prompt / prompt / stderr. |

A rejected subscription window (`rate_limit_event` with `status: rejected`) kills the run
at once and returns `quota_exhausted` with the reset time, so OpenClaw can fall back to
another model instead of waiting.

## Antigravity backend (`proxy.js`)

A tiny, zero-dependency Node.js proxy that exposes Google **Antigravity** (the `agy` CLI)
as an **OpenAI-compatible API**, so that [OpenClaw](https://openclaw.ai) — or any other
OpenAI-API client — can use Antigravity's agentic models as a chat backend.

```
OpenClaw gateway
      │  POST /v1/chat/completions   (OpenAI format, streaming or not)
      ▼
proxy.js  (127.0.0.1:8000)           ← systemd user service
      │  spawn per request:
      │  agy --dangerously-skip-permissions --print-timeout 35m
      │      --log-file <private> [--model X] --print "<prompt>"
      ▼
agy  (Antigravity CLI)               ← its own agent loop: Gemini/Claude backend,
      │                                shell, browser, web tools…
      ▼
response → back to the client as chat.completion(.chunk)
```

**One file, no npm dependencies** — plain `node:http`. The interesting part is not the
translation itself but the production hardening around a CLI that was never designed to
be a server backend: adaptive timeouts, live progress reporting, error mining from log
files, process-tree cleanup, and per-request model routing.

### Why

`agy` is a fully agentic CLI: given a single prompt it will happily run web searches,
shell commands and multi-step investigations that take **minutes** and print *nothing*
until the very end. Wrapping that in a chat API that streams, times out sanely, retries
transient failures and reports progress requires solving a few non-obvious problems —
documented below and in the comments throughout `proxy.js`.

### Features

- **OpenAI-compatible endpoints**: `POST /v1/chat/completions` (stream and non-stream),
  `GET /v1/models`.
- **Stateless by design** — each request spawns a fresh `agy` process; the conversation
  (system prompt + capped history + latest turn) is folded into a single prompt.
  Every request is reproducible, retryable and debuggable in isolation.
- **Per-request model routing** — the OpenAI `model` field is mapped through `MODEL_MAP`
  to an exact `agy` model name (Gemini Flash/Pro, Claude Sonnet/Opus, GPT-OSS…).
  Unknown ids are a hard error, not a silent fallback.
- **Adaptive three-stage timeout** (SOFT 12 min / IDLE 5 min / HARD 30 min):
  a genuinely *active* agent is allowed to run long, a *stuck* one is killed early.
  Activity is detected by live-tailing agy's private glog file — each
  `streamGenerateContent` line is one model round of the agent loop.
- **Live progress + SSE keepalive** — while `agy` is silent, the client sees rationed
  status lines (`⏳ … round 7 …`) and invisible SSE comments keep the connection alive.
  Progress lines are stripped from future conversation history automatically.
- **Error mining** — `agy ≥ 1.1.0` swallows backend errors in `--print` mode
  (exit 0, empty stdout/stderr). The proxy gives each request a private `--log-file`
  and extracts the real error (e.g. quota `RESOURCE_EXHAUSTED 429`) from it.
- **One automatic retry** on transient failures — but never after a timeout, never
  after the first streamed token, and never for empty-output errors (quota won't
  clear on retry).
- **Process-tree hygiene** — `agy` is spawned detached in its own process group and
  killed with `kill(-pid)`, so grandchildren (tool commands, `xdg-open`, browsers)
  don't survive and hold pipes open. Completion is detected on `exit`, not `close`
  (a grandchild inheriting stdout can block `close` forever).
- **Telemetry** — every request logs prompt size, model routing, TTFT, total time,
  exit code and the number of agent-loop rounds.

### Requirements

- Node.js ≥ 18 (any version with `node:http`; no npm packages needed)
- [Antigravity CLI](https://antigravity.google) (`agy`) installed and authenticated
- Linux (uses process groups and `systemd --user`; adaptable elsewhere)

### Quick start

```bash
node proxy.js
# → listens on 127.0.0.1:8000

curl -s http://127.0.0.1:8000/v1/models | jq .

curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"Hello"}]}'
```

### Running as a systemd user service

Create `~/.config/systemd/user/openclaw-proxy.service`:

```ini
[Unit]
Description=Antigravity OpenAI Proxy for OpenClaw (agy -> :8000)
After=network-online.target
Wants=network-online.target
StartLimitBurst=5
StartLimitIntervalSec=60

[Service]
ExecStart=/usr/bin/node %h/projects/openclaw/proxy.js
WorkingDirectory=%h/projects/openclaw
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
SuccessExitStatus=0 143
KillMode=control-group
Environment=HOME=%h
Environment=TMPDIR=/tmp
# PATH must include the directory containing `agy`, or spawn fails with ENOENT.
Environment=PATH=/usr/bin:%h/.local/bin:/usr/local/bin:/bin
Environment=NO_COLOR=1
# Optional default model (name EXACTLY as printed by `agy models`):
# Environment=AGY_MODEL=Gemini 3.5 Flash (Low)

[Install]
WantedBy=default.target
```

```bash
systemctl --user daemon-reload
systemctl --user enable --now openclaw-proxy
journalctl --user -u openclaw-proxy -f        # live telemetry
loginctl enable-linger $USER                   # start at boot without login
```

Restart the service after **any** edit to `proxy.js` — and don't run `node proxy.js`
manually while the service is up (port conflict, `EADDRINUSE`).

### Configuration

All knobs are constants at the top of `proxy.js`:

| Constant | Default | Meaning |
|---|---|---|
| `PORT` | `8000` | Listen port (bound to `127.0.0.1` only). |
| `SOFT_TIMEOUT_MS` | 12 min | Past this, the request survives only while `agy` shows activity. |
| `IDLE_TIMEOUT_MS` | 5 min | No model round and no stdout for this long → SIGKILL. |
| `HARD_TIMEOUT_MS` | 30 min | Absolute ceiling regardless of activity. |
| `AGY_PRINT_TIMEOUT` | `35m` | agy's own budget — deliberately **above** HARD so the proxy owns the timeout. |
| `HISTORY_LIMIT` | `12` | How many recent history messages go into the prompt (system prompt always full). |
| `MAX_ATTEMPTS` | `2` | One automatic retry on transient failure. |
| `MODEL_MAP` | — | OpenAI model id → exact `agy` model name. |
| `AGY_MODEL` (env) | unset | Default `agy` model when the request doesn't pick one. |
| `AGY_PROXY_DEBUG` (env) | unset | Directory for `last_prompt.txt` / `last_stderr.txt` dumps. |

### OpenClaw integration notes

Two gotchas that cost real debugging time:

1. **Model aliases shadow provider/model pairs.** An alias like
   `gemini-flash → google/gemini-3-flash-preview` silently routes *around* the proxy.
   Fix: `openclaw models aliases add gemini-flash agy/gemini-flash`.
2. **A provider without auth is skipped.** The gateway requires an `apiKey` even for a
   local proxy that ignores it — any dummy value works (`"apiKey": "agy-local-proxy"`).
   Each model must also appear in **both** `models.providers.agy.models[]` *and* the
   `agents.defaults.models` allowlist.

### Known limitations

- No concurrency limit — each parallel request is a heavy `agy` process; on small
  hosts (Raspberry Pi) many simultaneous agentic tasks can exhaust RAM.
- Model rounds are the only live activity signal; a single tool execution longer than
  `IDLE_TIMEOUT_MS` with no new round would be killed as idle (measured max gap so
  far: ~47 s, so there is >6× headroom).
- Statelessness means heavy tasks re-discover their environment every turn.
- `agy` auto-updates and has broken its own CLI contract before (1.1.1 changed how
  `--print` consumes the prompt). If behavior changes overnight, check `agy --version`
  and the binary's mtime first.

### Files

| File | What it is |
|---|---|
| `proxy.js` | The Antigravity bridge. |
| `claude_proxy.js` | The Claude Code bridge. |
| `mcp/openclaw-agents.js` | MCP server: `ask_agent` → OpenClaw subagents. |
| `tools/build-claude-profile.py` | Builds the Claude Code bridge config from the agy profile. |
| `tools/build-ro-profile.sh` | Builds the agy read-only profile. |
| `antigravity_proxy.py` | Abandoned first prototype (FastAPI + hypothetical SDK). Kept for history; not used. |
| `requirements.txt` | Belongs to the abandoned prototype. |

## License

MIT — see [LICENSE](LICENSE).
