# openclaw-coding-cli-bridge

Zero-dependency Node.js proxies that expose agentic coding CLIs as **OpenAI-compatible
chat APIs**, so that [OpenClaw](https://openclaw.ai) — or any other OpenAI-API client —
can use them as a model backend:

| Proxy | CLI behind it | Default port | Model ids |
|---|---|---|---|
| `proxy.js` | Google **Antigravity** (`agy`) | 8000 | `gemini-flash`, `gemini-pro`, `claude-sonnet`, `claude-opus`, … |
| `claude_proxy.js` | **Claude Code** (`claude -p`) | 8001 | `claude-sonnet`, `claude-opus-high`, … |

Both speak the same client contract, share the same **permission-role** model
(see [Roles](#roles-permission-profiles)) and report usage into a common pool-state file
so a gateway can fail over between them. A third piece, `plugins/clef-decision/`, is an
OpenClaw *decision-model* provider backed by Cloudflare Workers AI (see [CLEF](#clef)).

> 🤖 **Automated Setup by OpenClaw Agents:**
> If you are having your OpenClaw agent install and wire this bridge automatically, point it to [AGENT_INSTRUCTIONS.md](AGENT_INSTRUCTIONS.md). It contains step-by-step pre-flight checks, systemd user service templates, `openclaw.json` configuration, and smoke tests.

The rest of this document starts with the `agy` proxy (the original, most documented
part), then covers Claude Code, roles and CLEF.

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

## Why

`agy` is a fully agentic CLI: given a single prompt it will happily run web searches,
shell commands and multi-step investigations that take **minutes** and print *nothing*
until the very end. Wrapping that in a chat API that streams, times out sanely, retries
transient failures and reports progress requires solving a few non-obvious problems —
documented below and in the comments throughout `proxy.js`.

## Features

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

## Roles (permission profiles)

An agentic CLI behind a chat API can run shell commands, call MCP servers (home
automation, file storage, …) and browse the web. OpenClaw's own tool policy cannot
reach those tools — the CLI calls them through **its own** config. So the only real
control point is the config the CLI is started with, and the proxy picks it **per
request, from the model id**.

### How a role is selected

The role is a suffix on the model id:

```
<model>[:<project>][-ro|-ops|-cfg|-web|-dev]

claude-sonnet            default role (full, or whatever *_DEFAULT_ROLE says)
claude-sonnet-ro         read-only
claude-opus-high-ops     full minus the "ops" deny list
claude-sonnet:ha-cfg     project "ha" (Claude Code only), role cfg
gemini-flash-web         web researcher
```

Role selection is therefore **a routing decision made by the gateway, not a request
from the model**. In OpenClaw you register each `*-role` id as its own model and give
each *agent* only the ids it may use (`agents.<name>.model` primary + fallbacks, and
the `agents.defaults.models` allowlist). An agent whose chain lists only `-ro` ids can
never reach the full role — there is no id it could ask for. Fail-closed: if a role's
profile cannot be built or verified, the request is refused, never run unfiltered.

### The roles

| Role | Intended for | What it can do | How it is enforced |
|---|---|---|---|
| `full` | explicitly authorized maintenance with a human-reviewed prompt | everything: shell, all MCP servers | `agy --dangerously-skip-permissions` / `claude --dangerously-skip-permissions`. Strictly guarded: requires a valid time-bound grant file (`/etc/openclaw/full-grant`, containing a future epoch timestamp, root/proxy ownership, non-writable by group/others). Without a valid grant, proxy returns `403 Forbidden` |
| `ro` | read-only analysis, watchdogs, reporting | read tools and an explicit allowlist of read-only MCP tools | `agy`: isolated `HOME` with a narrow `permissions.allow` and no skip-permissions (a tool not on the list is auto-denied, no hang). `claude`: `--permission-mode dontAsk` + `--tools` narrowed to `Read,Glob,Grep,WebSearch,WebFetch` + allowlist file + a deny list for secrets (`.env`, `*.pem`, `.ssh`, …) |
| `ops` | the interactive "main" agent: may drive devices and run commands, but must not rewrite configuration | `full` minus a deny list of configuration-changing MCP tools | `--disallowedTools` from `ops-deny.json` (Claude Code); for `agy` an isolated `HOME` built by `tools/build-ops-profile.sh` with the tools both hidden (`disabledTools`) and denied (`permissions.deny`), plus an argument guard hook. A missing/broken deny file falls back to a built-in default list, never to an empty one |
| `cfg` | the *configuration writer* agent | like `ops`, but configuration changes are **allowed**; only the tools in `cfg-deny.json` (e.g. restart) are removed | same mechanism as `ops`, own deny file and own `agy` profile |
| `web` | researchers / watchers that read **untrusted** web pages | web search and fetch plus the task-queue MCP — nothing else | Claude Code: `--tools WebSearch,WebFetch`, own `--mcp-config` with only the task bridge, every fetch checked by a URL guard (no LAN, no loopback, no own public domain). `agy`: dedicated profile whose only network tool runs at the vendor's side. Principle: an agent that reads untrusted text must have nothing worth leaking and no way to act |
| `dev` | a coding worker that writes and tests code | read/edit/write inside **one git worktree**, commands only through a sandbox MCP | no native shell or web tools; `dev-sandbox` MCP (`dev_exec`, `dev_git_*`) runs commands in a bubblewrap sandbox; a guard hook rejects any path outside the worktree. A `dev` run must carry a task-queue issue with an **approved owner consent card**; otherwise the proxy returns `403` before anything starts |

> Some pieces referenced above are deployment-specific and are **not** part of this
> repository: the profile build scripts for `ops`/`cfg`/`dev`/`web`, the guard hooks
> (`ha_guard`, `web_guard`, `dev_guard`), the `dev-sandbox` MCP server and the
> task-queue approval module (the proxies load the optional ones in `try/catch`).
> `tools/build-ro-profile.sh` and the role plumbing in both proxies show the contract
> they have to satisfy.

### How roles are distributed in a typical setup

```
 interactive agent  "main"      → <claude-opus>-ops  → agy <opus>-ops → …other models, all -ops
 config writer      "cfg-agent" → <claude-sonnet>:ha-cfg
 background / cron / watchers   → <gemini-flash>-ro  (cheap pool, read-only; never Claude)
 researchers (untrusted input)  → <gemini-flash>-web → report scanned by CLEF before anyone reads it
 coding workers (task queue)    → <model>-dev        → diff scanned by CLEF, applied by a human-approved agent
```

Design rules behind it:

1. **Least privilege by default.** Anything automatic and recurring runs in `ro` (or
   `web`); `full` is reserved for explicitly trusted callers.
2. **A fallback must not widen privileges.** Every provider in an agent's chain uses the
   *same* role: if the Claude Code pool is exhausted and the chain falls through to
   `agy`, it falls to `agy`'s `-ops`, not to `agy`'s `full`. That is why both proxies
   implement the same role names with equivalent profiles.
3. **Protect the expensive pool.** Claude Code has a rolling usage window. Background
   agents are routed to the cheaper pool (`agy`/Gemini) and have Claude removed from
   their chain entirely (fail-closed: "agent unavailable" beats silently draining the
   interactive session's quota). `CC_MAX_CONCURRENT` / `CC_MAX_QUEUE` bound concurrency.
4. **Writers and readers are different agents.** The agent that talks to you can act
   (`ops`) but cannot edit configuration; a separate agent holds `cfg` and is only
   reachable after a reviewed plan. Untrusted-input readers (`web`, `dev`) have no
   acting tools at all and hand results over through the task queue.
5. **Every role denial is explained.** A blocked tool call is reported as
   `agy/claude refused permission '<class>(<target>)' in role '<role>'`, the model gets
   one retry with a "don't call that tool again" hint, and the final answer says what
   could not be done and why — no silent hang.

`GET /healthz` on either proxy reports live slot occupancy per role.

## Claude Code backend (`claude_proxy.js`)

Same facade as `proxy.js`, but over `claude -p --output-format stream-json --verbose`.
It is simpler in one way — every agent step is a structured stdout line (model turns,
tool calls, rate-limit events, a final `result` with `is_error` and
`permission_denials`), so there is no log tailing: "no line for `IDLE`" really means
stuck.

- **Model ids:** `claude-sonnet`, `claude-opus-high`, … (`MODEL_MAP`; a full
  `claude-*` id also works), optional `:project`, optional role suffix.
- **Projects:** `projects.json` maps `:name` → a directory. The run starts there, so
  Claude Code loads that project's own `CLAUDE.md`; `roDeny` entries hide files from
  the read-only role. Without a project the run uses a neutral `CC_WORKDIR` that must
  contain no secrets.
- **MCP servers:** `mcp.json` (Claude Code `--mcp-config` format) is kept **outside the
  repo** because it carries URLs and tokens.
- **Quota awareness:** a `rejected` rate-limit event starts a short grace timer
  (`CC_QUOTA_GRACE_MS`); if the model keeps answering, the event is ignored, otherwise
  the request fails with a tagged quota error (`quota_exhausted`, reset time in
  `resetMs`). The gateway reads that tag and moves to the next model in the agent's
  chain — see `tools/quota_error.js`.
- **Pool state:** `tools/pools_state.js` (opt-in: create `~/.openclaw/state/pools/ENABLED`)
  records per-pool outcomes (`ok` / `limit` / `timeout`) and load for `cc` and `agy`, so
  other tools can show which pool is currently usable. Nothing raw (prompts, stderr,
  session ids) is stored.
- **Usage footer:** `tools/cc_usage.js` adds per-turn token usage to progress lines;
  each reply ends with `— model: Claude Opus 5.5 (High)` except on control sentinels
  (`NO_REPLY`, `HEARTBEAT_OK`).
- **Adaptive timeouts:** `CC_IDLE_MS` / `CC_HARD_MS`; progress ticks keep the client's
  stall detector fed.
- **Config:** `CC_PROXY_PORT`, `CC_BIN`, `CC_WORKDIR`, `CC_CONFIG_DIR`, `CC_MCP_CONFIG`,
  `CC_RO_ALLOW`, `CC_OPS_DENY`, `CC_CFG_DENY`, `CC_PROJECTS`, `CC_DEFAULT_ROLE`,
  `CC_EFFORT`, `CC_MODEL`, `CC_MAX_CONCURRENT`, `CC_MAX_QUEUE`, `CC_PROXY_DEBUG`.

`model_resolver.js` (agy side) keeps model names alive when the vendor renames its
catalogue: it matches ids against the live `agy models` list by family and tier, replaces
only what vanished, reports newer versions without switching to them, and returns to a
preferred family once it reappears.

## CLEF

CLEF (`@cf/cloudflare/clef`) is a small classifier model on **Cloudflare Workers AI**
that answers structured questions (boolean / choice / score) over a piece of text. Two
parts of this repo use it, both through `tools/clef_guard.js`, which owns the budget.

### 1. Guard: scan what untrusted agents write (`tools/clef_guard.js`)

`web` and `dev` roles read untrusted content. Their output is read next by a more
privileged agent, so the output itself is a prompt-injection channel. Before the
coordinator sees a worker report (or before an executor applies a diff), `scanReport`
asks CLEF two questions:

- *injection* — does the text contain instructions aimed at the AI reader?
- *hijack / backdoor* — does it steer toward actions the task did not ask for (run
  downloaded scripts, exfiltrate, disable checks)?

A score ≥ `THRESHOLD` (0.50) quarantines the report. Every failure (network, budget,
parse) yields verdict `unverified`, never an exception and never an implicit "clean".
Text is **anonymised** before it leaves the host: private/loopback IPv4 ranges are
replaced with a documentation address, and your own domain and name are masked via
`CLEF_OWN_DOMAIN` / `CLEF_OWN_NAME_PATTERN` (unset = that step is a no-op).

**Budget:** the free tier is 10 000 neurons/day (UTC). The guard reserves neurons
*before* each call under a file lock and stops at **8 500/day** for the whole system.

### 2. Decision provider (`plugins/clef-decision/`)

An OpenClaw plugin implementing the `decisionProviders` contract, exposing two models,
`clef` and `clef-flash` (cheaper, ~6× fewer neurons per 1K tokens). It lets an agent
call `decision_evaluate` for cheap yes/no, pick-one or rate-it judgements on supplied
state — e.g. "is this alert actionable?" — without spending a frontier-model turn.
Set it as the agent's `decisionModel` (`clef/clef` or `clef/clef-flash`).

- Translates `boolean → noul`, `choice → choice`, `score → score`; up to 64 questions,
  255 alternatives, 10 score levels per request.
- **Shares the guard's budget**: same lock, same 8 500/day ceiling, plus a decision
  sub-cap (`dailyNeuronCap`, default 5 000, max 7 000) so the security guards always keep
  at least 1 500 neurons of headroom. Disable it per agent for the ones whose input is
  untrusted.
- Never throws for provider problems (it degrades to "no opinion"); only caller
  cancellation propagates.
- Test: `node plugins/clef-decision/test_provider.mjs`.

Secrets (`cloudflare-ai.env`, `clef-guard.key`) live under `~/.openclaw/secrets/` and
are never part of this repository; paths can be overridden with `CLEF_ENV_FILE`,
`CLEF_KEY_FILE`, `CLEF_STATE_DIR`.

## Requirements

- Node.js ≥ 18 (any version with `node:http`; no npm packages needed)
- [Antigravity CLI](https://antigravity.google) (`agy`) installed and authenticated
- Linux (uses process groups and `systemd --user`; adaptable elsewhere)

## Quick start

```bash
node proxy.js
# → listens on 127.0.0.1:8000

curl -s http://127.0.0.1:8000/v1/models | jq .

curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H 'Content-Type: application/json' \
  -d '{"model":"gemini-flash","messages":[{"role":"user","content":"Hello"}]}'
```

## Running as a systemd user service

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

## Configuration

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

## OpenClaw integration notes

Two gotchas that cost real debugging time:

1. **Model aliases shadow provider/model pairs.** An alias like
   `gemini-flash → google/gemini-3-flash-preview` silently routes *around* the proxy.
   Fix: `openclaw models aliases add gemini-flash agy/gemini-flash`.
2. **A provider without auth is skipped.** The gateway requires an `apiKey` even for a
   local proxy that ignores it — any dummy value works (`"apiKey": "agy-local-proxy"`).
   Each model must also appear in **both** `models.providers.agy.models[]` *and* the
   `agents.defaults.models` allowlist.

## Known limitations

- No concurrency limit — each parallel request is a heavy `agy` process; on small
  hosts (Raspberry Pi) many simultaneous agentic tasks can exhaust RAM.
- Model rounds are the only live activity signal; a single tool execution longer than
  `IDLE_TIMEOUT_MS` with no new round would be killed as idle (measured max gap so
  far: ~47 s, so there is >6× headroom).
- Statelessness means heavy tasks re-discover their environment every turn.
- `agy` auto-updates and has broken its own CLI contract before (1.1.1 changed how
  `--print` consumes the prompt). If behavior changes overnight, check `agy --version`
  and the binary's mtime first.

## Repository layout

| File | What it is |
|---|---|
| `proxy.js` | The `agy` proxy. Self-contained apart from the optional `tools/` modules. |
| `claude_proxy.js` | The Claude Code proxy (needs `tools/`). |
| `antigravity_proxy.py` | Abandoned first prototype (FastAPI + hypothetical SDK). Kept for history; not used. |
| `requirements.txt` | Belongs to the abandoned prototype. |

## License

MIT — see [LICENSE](LICENSE).

## Autonomous Multiagent Team & Ecosystem

This repository provides everything needed to turn OpenClaw into an autonomous, safe software development organization:

```
                  ┌───────────────────────────────┐
                  │   Human Operator / Decider    │
                  └───────────────┬───────────────┘
                                  │ (Human-in-the-Loop Approval)
                                  ▼
                  ┌───────────────────────────────┐
                  │    Master / Coordinator       │
                  │  (Deconstructs goals & specs) │
                  └───────┬───────────────┬───────┘
                          │               │
        ┌─────────────────▼───┐       ┌───▼─────────────────┐
        │  Developer Agent    │       │   Adversarial Tester│
        │(Worktree + Sandbox) │◀─────▶│ (Independent Tests) │
        └─────────────────┬───┘       └───┬─────────────────┘
                          │               │
                          └───────┬───────┘
                                  ▼
                      ┌───────────────────────┐
                      │    Reviewer Agent     │
                      │ (Read-only Diff Audit)│
                      └───────────┬───────────┘
                                  ▼
                      ┌───────────────────────┐
                      │    Executor Agent     │
                      │(ff-only merge & deploy│
                      └───────────────────────┘
```

### 1. Multiagent Team Templates (`templates/agents/`)
- **`master` (`-ops`):** Architectural coordinator who translates requirements into formal contracts and manages the lifecycle.
- **`developer` (`-dev`):** Operates strictly in an isolated sandbox (`git worktree` + `bwrap`, network disabled).
- **`tester` (`-dev`):** Independent adversarial tester — *the author of the code is never the sole author of its tests*.
- **`reviewer` (`-rev`):** Read-only security and architecture auditor inspecting diffs against acceptance criteria.
- **`executor` (`-ops`):** Precise deployment agent that verifies clean worktrees, matches human-approved commit SHAs co-incidentally, and executes fast-forward only merges (`git merge --ff-only`).
- Includes ready-to-paste `openclaw_agents_snippet.json`.

### 2. Software Ticketing & Governance (`tools/cases/`)
Zero-dependency Node.js state machine and stdio MCP server for governing development tasks:
- **8-Stage Lifecycle:** `new` → `plan` → `coding` → `testing` → `review` → `awaiting_approval` → `approved` → `deployed`.
- **Atomic File Store:** Safe concurrent access via directory locking (`.lock`), atomic renames, and stale PID detection.
- **Hard Gate on Human Approval:** Agents cannot bypass the approval gate; invalidating code or CLEF scans resets approval to `stale`.
- **MCP Server:** Exposes 11 tools (`case_create`, `case_get`, `case_list`, `case_stage`, `case_assign`, `case_report`, `case_set_sha`, `case_scan`, `case_diff`, `case_request_approval`, `case_summary`).

### 3. Safe Web Page Reader MCP (`tools/webread/`)
Zero-dependency stdio MCP server that allows agents to securely read web documentation:
- **SSRF Defense-in-Depth:** Full RFC coverage for private/loopback/CGNAT/ULA addresses (IPv4 & IPv6), DNS rebinding prevention via IP pinning at TCP socket level, redirect hop validation.
- **Content Hygiene:** Strips hidden elements (`display: none`, `visibility: hidden`, `opacity: 0`, matching background/foreground colors), zero-width characters, bidi-controls, and Unicode Tag Characters.
- **Prompt Injection Defense:** Chunked scanning with overlap against Cloudflare CLEF, HMAC cryptographic stamping, and automatic quarantine of malicious payloads.

---

## Also in this repo

| Path | What it is |
|---|---|
| `claude_proxy.js` | Claude Code backend ([above](#claude-code-backend-claude_proxyjs)). |
| `model_resolver.js` | Keeps `agy` model ids valid when the vendor renames models. |
| `plugins/clef-decision/` | OpenClaw decision-model provider on Cloudflare CLEF ([above](#clef)). |
| `templates/agents/` | Multiagent coding team templates and `openclaw.json` snippets. |
| `tools/cases/` | Ticketing system and state machine MCP server (`cases_dev.js`, `cases_mcp.js`). |
| `tools/webread/` | Safe web page reader MCP server with SSRF protection and prompt injection detector. |
| `tools/` | Modules the proxies load at runtime — `clef_guard`, `pools_state`, `quota_error`, `cc_usage`, `agy_stream`, `paperclip_wake`. |
