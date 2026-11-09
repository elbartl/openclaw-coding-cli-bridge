# Autonomous Installation & Setup Guide for OpenClaw Agents

> **Target Audience:** OpenClaw AI Agents (`main`, `ops`, or subagents) executing on behalf of an operator.  
> **Mission:** Autonomously inspect host capabilities, deploy the Coding CLI Bridge proxies (`proxy.js` for Antigravity `agy`, `claude_proxy.js` for Claude Code `claude`), configure systemd user services, and wire the bridge into `openclaw.json` with least-privilege security roles.

---

## 1. Safety & Execution Mandates

1. **Idempotence:** Always inspect before writing or modifying. Never duplicate configuration blocks or systemd services.
2. **Mandatory Backups:** Create a timestamped copy before modifying any existing file (e.g., `cp openclaw.json openclaw.json.bak.$(date +%s)`).
3. **No Secret Ingestion or Leaks:** Never log, print, or commit API keys, tokens, or credential files.
4. **Least Privilege by Default:** Default proxy roles are set to `ro` (read-only) or `-ops` (operational actions without destructive configuration changes). Unrestricted `-full` mode requires an explicit, time-bound system grant.

---

## 2. Step 1: Pre-Flight Environment Inspection

Run the following checks via shell:

```bash
# 1. Verify Node.js runtime (requires Node >= 18 for native node:http and WebCrypto)
node -v

# 2. Check available CLI backends on PATH
which agy >/dev/null 2>&1 && echo "CLI_AGY=available" || echo "CLI_AGY=missing"
which claude >/dev/null 2>&1 && echo "CLI_CLAUDE=available" || echo "CLI_CLAUDE=missing"

# 3. Check port availability (8000 for agy proxy, 8001 for Claude Code proxy)
ss -tulpn | grep -E ':(8000|8001)\b' || echo "PORTS_FREE=ok"

# 4. Check OpenClaw configuration file location
test -f "$HOME/.openclaw/openclaw.json" && echo "OPENCLAW_CONFIG=found" || echo "OPENCLAW_CONFIG=missing"
```

### Decision Logic:
- If **both** `agy` and `claude` are missing: Stop and inform the user that at least one CLI backend must be installed and authenticated.
- If **only one** backend is present: Configure only the proxy for that available backend.
- If a port (8000 or 8001) is already in use by an existing proxy service, verify whether the service is already running. If used by an unrelated process, configure an alternative port via environment variable (`PORT` or `CC_PROXY_PORT`).

---

## 3. Step 2: Systemd User Services Configuration

Locate the repository checkout directory (e.g., `$PWD` or `$HOME/openclaw-coding-cli-bridge`).

Create systemd user units under `~/.config/systemd/user/`.

### A. Antigravity Proxy (`openclaw-agy-proxy.service`)
*(Deploy if `agy` is available)*

```ini
[Unit]
Description=Antigravity OpenAI Proxy for OpenClaw (agy -> :8000)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node %h/openclaw-coding-cli-bridge/proxy.js
WorkingDirectory=%h/openclaw-coding-cli-bridge
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
KillMode=control-group
Environment=HOME=%h
Environment=TMPDIR=/tmp
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin:%h/.npm-global/bin
Environment=NO_COLOR=1
Environment=AGY_DEFAULT_ROLE=ro

[Install]
WantedBy=default.target
```

### B. Claude Code Proxy (`openclaw-claude-proxy.service`)
*(Deploy if `claude` is available)*

```ini
[Unit]
Description=Claude Code OpenAI Proxy for OpenClaw (claude -> :8001)
After=network-online.target
Wants=network-online.target

[Service]
ExecStart=/usr/bin/env node %h/openclaw-coding-cli-bridge/claude_proxy.js
WorkingDirectory=%h/openclaw-coding-cli-bridge
Restart=always
RestartSec=5
TimeoutStopSec=30
TimeoutStartSec=30
KillMode=control-group
Environment=HOME=%h
Environment=TMPDIR=/tmp
Environment=PATH=/usr/local/bin:/usr/bin:/bin:%h/.local/bin:%h/.npm-global/bin
Environment=NO_COLOR=1
Environment=CC_DEFAULT_ROLE=ro

[Install]
WantedBy=default.target
```

### C. Enable and Start Services

```bash
mkdir -p "$HOME/.config/systemd/user"
systemctl --user daemon-reload

# Enable and start available services:
# (Replace with the services being deployed)
systemctl --user enable --now openclaw-agy-proxy.service 2>/dev/null || true
systemctl --user enable --now openclaw-claude-proxy.service 2>/dev/null || true

# Enable user lingering so proxies persist when user logs out
loginctl enable-linger "$USER" 2>/dev/null || true
```

---

## 4. Step 3: Wire into OpenClaw (`openclaw.json`)

1. Locate and back up `~/.openclaw/openclaw.json`:
   ```bash
   cp "$HOME/.openclaw/openclaw.json" "$HOME/.openclaw/openclaw.json.bak.$(date +%s)"
   ```

2. Merge the provider configurations into `models.providers`:

```json
{
  "models": {
    "providers": {
      "agy": {
        "baseUrl": "http://127.0.0.1:8000/v1",
        "apiKey": "agy-local-proxy",
        "apiType": "openai",
        "models": [
          "gemini-flash-ro",
          "gemini-flash-ops",
          "gemini-pro-ro",
          "gemini-pro-ops",
          "claude-sonnet-ro",
          "claude-sonnet-ops",
          "claude-opus-ro",
          "claude-opus-ops"
        ]
      },
      "cc": {
        "baseUrl": "http://127.0.0.1:8001/v1",
        "apiKey": "cc-local-proxy",
        "apiType": "openai",
        "models": [
          "claude-sonnet-ro",
          "claude-sonnet-ops",
          "claude-opus-high-ro",
          "claude-opus-high-ops"
        ]
      }
    }
  }
}
```

3. Ensure the desired models are listed in `agents.defaults.models` allowlist so agents are permitted to use them.
4. Set model aliases under `models.aliases` if desired (for example: `"fast": "agy/gemini-flash-ops"`).

---

## 5. Step 4: Wire Built-in MCP Servers into OpenClaw

This repository bundles two critical, zero-dependency MCP servers designed for autonomous development workflows:
1. **`tools/cases/cases_mcp.js` (Cases DEV Ticketing & State Machine):** Governs software task progression across 8 states (`plan` → `coding` → `testing` → `review` → `awaiting_approval` → `approved` → `deployed`) with mandatory Human-in-the-Loop gates.
2. **`tools/webread/server.js` (WebRead MCP):** Secure web documentation reader with full SSRF protection (IP pinning, RFC validation), HTML/CSS noise reduction, zero-width character stripping, and prompt injection detection.

### Register in `openclaw.json` under `mcpServers`:

```json
{
  "mcpServers": {
    "cases": {
      "command": "node",
      "args": ["tools/cases/cases_mcp.js"],
      "cwd": "/path/to/openclaw-coding-cli-bridge",
      "env": {
        "CASES_DEV_DIR": "~/.openclaw/state/cases/dev",
        "CASES_OWNER_NAME": "owner"
      }
    },
    "webread": {
      "command": "node",
      "args": ["tools/webread/server.js"],
      "cwd": "/path/to/openclaw-coding-cli-bridge",
      "env": {
        "CLEF_BUDGET_FILE": "~/.openclaw/state/webread/budget.json"
      }
    }
  }
}
```

---

## 6. Step 5: Deploy the Multiagent Coding Team

This repository includes a battle-tested multiagent team architecture located in `templates/agents/`:
- **`master` (`-ops`):** Architectural coordinator, breaks goals into tasks, reviews diffs, requests human approvals.
- **`developer` (`-dev`):** Writes code and unit tests inside an isolated sandbox (`git worktree` + `bwrap`, no-net).
- **`tester` (`-dev`):** Adversarial tester who writes independent edge-case tests; author of code is never sole author of tests.
- **`reviewer` (`-rev`):** Strict read-only auditor verifying diffs, contract compliance, and absence of security regressions.
- **`executor` (`-ops`):** Precise deployment agent verifying the human-approved commit SHA co-incidentally, merging fast-forward (`--ff-only`), and running post-merge smoke tests.

### Inject Agent Entries:
Inspect `templates/agents/openclaw_agents_snippet.json` and merge the entries into `agents.entries` in your `~/.openclaw/openclaw.json`. Copy the agent persona files (`SOUL.md` and `AGENTS.md`) into your workspace agent directories as needed.

---

## 7. Step 6: Verification & Smoke Testing

Execute health and smoke tests before concluding:

```bash
# 1. Healthcheck verification
curl -fsS http://127.0.0.1:8000/healthz && echo "AGY Healthcheck: OK" || true
curl -fsS http://127.0.0.1:8001/healthz && echo "Claude Code Healthcheck: OK" || true

# 2. Verify advertised models
curl -fsS http://127.0.0.1:8000/v1/models | grep -q "gemini-flash" && echo "AGY Models: OK" || true
curl -fsS http://127.0.0.1:8001/v1/models | grep -q "claude-sonnet" && echo "Claude Code Models: OK" || true

# 3. Quick non-streaming completion smoke test
curl -s http://127.0.0.1:8000/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"gemini-flash-ro","messages":[{"role":"user","content":"ping"}]}' | grep -q "choices" && echo "AGY Smoke Test: OK" || true

# 4. Verify Built-in Tool Test Suites
(cd tools/cases && node test_cases_dev.js && node test_cases_mcp.js)
(cd tools/webread && node ssrf.test.js && node extract.test.js && node scan.test.js && node server.test.js)
```

---

## 8. Security Architecture & Full Privileges

- **Read-Only (`-ro`):** Suitable for background monitors, periodic checks, and reporting. Read tools only.
- **Operations (`-ops`):** Interactive assistant default. Allows reading, tools, and execution, but denies destructive system and infrastructure configuration changes.
- **Unrestricted (`-full`):**
  By default, unrestricted `-full` mode is strictly guarded. If an agent attempts to invoke a `-full` model without a valid grant file, the proxy returns `403 Forbidden` (`full_grant_required`).
  To grant temporary `-full` access:
  ```bash
  # Create a grant valid for 1 hour (3600 seconds)
  sudo mkdir -p /etc/openclaw
  date -d '+1 hour' +%s | sudo tee /etc/openclaw/full-grant
  sudo chmod 0600 /etc/openclaw/full-grant
  ```
  The grant file must contain a future Unix epoch timestamp and must not be world-writable.
