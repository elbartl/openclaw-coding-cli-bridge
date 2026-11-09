// OpenAI-compatible proxy for OpenClaw backed by Claude Code (`claude -p`).
// Sibling of proxy.js (agy): same client contract — model ids with a `-ro`
// suffix, concurrency semaphore + bounded queue, visible ⏳ progress ticks that
// keep OpenClaw's ~400s stall detector fed, every failure reported as an SSE
// error event (never a content delta), "— model: X" footer except on control
// sentinels (NO_REPLY, HEARTBEAT_OK, ...).
//
// What is simpler than agy: `claude -p --output-format stream-json --verbose`
// streams structured events live (model turns, tool calls, tool results, rate
// limit state, a final `result` with is_error / permission_denials). No glog
// tailing, trajectory DB or /proc sampling is needed — every agent step is a
// stdout line, so "no stdout line for IDLE" really means stuck.
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const { StringDecoder } = require('string_decoder');
const { applyPaperclipWake, ENV_KEYS: PC_ENV_KEYS } = require('./tools/paperclip_wake');
const { createWriter: createPoolWriter } = require('./tools/pools_state');
const { FAILOVER_TAG } = require('./tools/quota_error');
const { createTurnUsage, formatUsage } = require('./tools/cc_usage');

let approvalsRef = null;
function getApprovals() {
    if (approvalsRef) return approvalsRef;
    try { approvalsRef = require('./tools/paperclip_approvals.js'); } catch (e) { approvalsRef = null; }
    return approvalsRef;
}
function _setApprovals(a) { approvalsRef = a; }

let devWorkspaceRef = null;
function getDevWorkspace() {
    if (devWorkspaceRef) return devWorkspaceRef;
    try { devWorkspaceRef = require('./tools/dev_workspace.js'); } catch (e) { devWorkspaceRef = null; }
    return devWorkspaceRef;
}
function _setDevWorkspace(w) { devWorkspaceRef = w; }

const PORT = parseInt(process.env.CC_PROXY_PORT || '8001', 10);
const CLAUDE_BIN = process.env.CC_BIN || 'claude';
// Working directory for every run. Claude Code auto-allows reads inside cwd
// (also in the RO role), so it must NOT be a directory with secrets.
const WORKDIR = process.env.CC_WORKDIR || path.join(os.homedir(), '.openclaw-claude/work');
// MCP servers (Home Assistant, Nextcloud, ...) in Claude Code's --mcp-config
// format. Generated from agy's mcp_config.json by tools/build-claude-profile.py.
// Kept outside the repo: it carries private URLs/tokens.
const CONFIG_DIR = process.env.CC_CONFIG_DIR || path.join(os.homedir(), '.config/openclaw-claude');
const MCP_CONFIG = process.env.CC_MCP_CONFIG || path.join(CONFIG_DIR, 'mcp.json');
// RO allowlist: {"allow": ["mcp__ha-mcp__ha_get_state", "Read(/path)", ...]}.
const RO_ALLOW_FILE = process.env.CC_RO_ALLOW || path.join(CONFIG_DIR, 'ro-allow.json');
// Built-in tools available in the RO role. Without --tools, dontAsk mode still
// auto-approves Bash commands Claude Code classifies as read-only (verified:
// `echo hi` ran with --allowedTools Read), which would let RO `cat` anything.
const RO_BUILTIN_TOOLS = process.env.CC_RO_TOOLS || 'Read,Glob,Grep,WebSearch,WebFetch';
// Named project contexts: {"ha": {"dir": "/path/to/project",
// "roDeny": ["Read(./config/secrets.yaml)"]}} (a bare string = just "dir").
// Selected by a `:name` part of the model id (see resolveModel). The run then
// starts in that directory, so Claude Code loads the project's CLAUDE.md.
const PROJECTS_FILE = process.env.CC_PROJECTS || path.join(CONFIG_DIR, 'projects.json');
// Always denied in the RO role. Inside cwd Claude Code auto-allows reads even
// in dontAsk mode, so a project dir is readable whole; a Read deny rule also
// hides the file from Grep/Glob (verified). Per-project roDeny adds to this.
// ops role = full minus Home Assistant configuration changes. Used by `main`:
// it may drive devices (ha_call_service) but config edits go to `ha-yaml`.
// File: {"deny": ["mcp__ha-mcp__ha_restart", ...]}, re-read per run. A missing
// or broken file falls back to OPS_DENY_DEFAULT, never to an empty list.
// Bash is still available, so this is a brake, not a wall.
const OPS_DENY_FILE = process.env.CC_OPS_DENY || path.join(CONFIG_DIR, 'ops-deny.json');
// cfg role = full minus cfg-deny.json (agent ha-yaml: may change HA config, no
// ha_restart). Same format; a missing/broken file falls back to CFG_DENY_DEFAULT.
const CFG_DENY_FILE = process.env.CC_CFG_DENY || path.join(CONFIG_DIR, 'cfg-deny.json');
const CFG_DENY_DEFAULT = ['mcp__ha-mcp__ha_restart'];
const OPS_DENY_DEFAULT = [
    'set_automation', 'set_category', 'set_dashboard', 'set_dashboard_resource', 'set_group', 'set_helper',
    'set_label', 'set_scene', 'set_script', 'remove_automation', 'remove_category', 'remove_group',
    'remove_label', 'remove_scene', 'remove_script', 'delete_dashboard', 'delete_dashboard_resource',
].map(t => `mcp__ha-mcp__ha_config_${t}`).concat([
    'remove_area_or_floor', 'remove_device', 'remove_entity', 'remove_helpers_integrations', 'remove_zone',
    'set_area_or_floor', 'set_device', 'set_entity', 'set_integration', 'set_zone',
    'restart', 'reload_core', 'manage_app', 'manage_backup', 'manage_blueprints', 'manage_energy_prefs',
    'manage_hacs', 'manage_pipeline', 'manage_theme', 'manage_updates',
].map(t => `mcp__ha-mcp__ha_${t}`));
// web role (Paperclip researcher / security watcher): the internet and the
// Paperclip bridge, nothing else. No file tools at all (--tools), no HA or
// Nextcloud MCP (own --mcp-config with only `paperclip`), every fetch checked
// by tools/web_guard.js (no LAN, no loopback, no own public domain). An agent that
// reads untrusted pages must have nothing worth leaking and no way to act.
const WEB_BUILTIN_TOOLS = 'WebSearch,WebFetch';
const WEB_MCP_SERVERS = ['paperclip'];
const WEB_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-web.json');
const WEB_GUARD = path.join(__dirname, 'tools', 'web_guard.js');
// dev role (Paperclip programmer / code tester): isolated git worktree + bwrap
// sandbox via dev-sandbox MCP. No native Bash/Web/Agent tools.
const DEV_ENV_KEYS = ['DEV_WORKTREE_ROOT', 'DEV_ISSUE_KEY'];
const DEV_BUILTIN_TOOLS = 'Read,Edit,Write,Glob,Grep';
const DEV_MCP_CONFIG = path.join(CONFIG_DIR, 'mcp-dev.json');
const DEV_GUARD = path.join(__dirname, 'tools', 'dev_guard.js');
const DEV_SANDBOX_MCP = path.join(__dirname, 'mcp', 'dev-sandbox.js');
const DEV_ALLOWED_TOOLS = [
    'Read', 'Edit', 'Write', 'Glob', 'Grep',
    'mcp__paperclip__pc_context', 'mcp__paperclip__pc_finish',
    'mcp__dev-sandbox__dev_info', 'mcp__dev-sandbox__dev_exec',
    'mcp__dev-sandbox__dev_git_status', 'mcp__dev-sandbox__dev_git_diff', 'mcp__dev-sandbox__dev_git_commit',
];
const RO_DENY_DEFAULT = ['Read(**/secrets.yaml)', 'Read(**/.env)', 'Read(**/.env.*)', 'Read(**/*.pem)', 'Read(**/*.key)', 'Read(**/.ssh/**)'];

// Every step of the agent loop is a stdout line, so IDLE only has to outlast
// the longest single silent step: one Bash tool call (Claude Code's own cap is
// 10 min) or one long model turn with thinking.
// IDLE is what ends a dead run. HARD is only runaway protection: it used to be
// 30 min and killed healthy runs mid-work (29.10: a run waiting on an HA backup
// upload, tool calls every few minutes, cut at 30:00). A run that keeps
// producing events or has a tool open now lives up to HARD.
const IDLE_TIMEOUT_MS = parseInt(process.env.CC_IDLE_MS || '900000', 10);    // 15 min without any event
const HARD_TIMEOUT_MS = parseInt(process.env.CC_HARD_MS || '10800000', 10);  // 3 h absolute ceiling
// Per-call MCP cap, independent of HARD: an open tool suspends IDLE, so a hung
// MCP call must still end on its own (ask_agent itself gives up at 25 min).
const MCP_TOOL_TIMEOUT_MS = parseInt(process.env.MCP_TOOL_TIMEOUT || '1740000', 10); // 29 min
const WATCHDOG_MS = 15000;
// A rejected rate_limit_event is not proof the run is dead: the CLI also emits
// it for side calls and sub-limits (24.10: type undefined, run would have
// continued). Treat it as exhausted only if the model goes quiet this long.
const QUOTA_GRACE_MS = parseInt(process.env.CC_QUOTA_GRACE_MS || '90000', 10);
const HEARTBEAT_MS = 15000;
const STATUS_MIN_GAP_MS = parseInt(process.env.CC_STATUS_GAP_MS || '60000', 10);
const PROGRESS_MAX_GAP_MS = 180000;  // under OpenClaw's ~400s stall/abort
const MAX_ATTEMPTS = 2;              // one retry on a transient failure, only if nothing reached the client
const HISTORY_LIMIT = 12;

const MAX_CONCURRENT   = parseInt(process.env.CC_MAX_CONCURRENT   || '2', 10);
const MAX_QUEUE        = parseInt(process.env.CC_MAX_QUEUE        || '4', 10);
const QUEUE_TIMEOUT_MS = parseInt(process.env.CC_QUEUE_TIMEOUT_MS || '600000', 10);

// OpenAI model id (what OpenClaw sends) -> `claude --model` value, or
// {model, effort} to also pass --effort (low|medium|high|xhigh|max). Aliases
// follow the latest model of each family; pinned ids don't drift on release.
const DEFAULT_MODEL = process.env.CC_MODEL || 'sonnet';
const MODEL_MAP = {
    'claude-code':      DEFAULT_MODEL,
    'claude-sonnet':    'sonnet',
    'claude-opus':      'opus',
    'claude-opus-high': { model: 'claude-opus-5-5', effort: 'high' },   // main agent: decides on subagent data
    'claude-haiku':     'haiku',
    'claude-fable':     'fable',
};

const DEBUG_DIR = process.env.CC_PROXY_DEBUG || null;

// ---- console ring buffer (/logs) ------------------------------------------
const LOG_BUFFER_MAX = parseInt(process.env.CC_LOG_BUFFER_LINES || '400', 10);
const logBuffer = [];
function captureLog(args) {
    try {
        const text = args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
        const line = /^\[\d{4}-\d{2}-\d{2}T/.test(text) ? text : `[${new Date().toISOString()}] ${text}`;
        logBuffer.push(line);
        if (logBuffer.length > LOG_BUFFER_MAX) logBuffer.shift();
    } catch (e) {}
}
const origConsoleLog = console.log.bind(console);
const origConsoleError = console.error.bind(console);
console.log = (...args) => { origConsoleLog(...args); captureLog(args); };
console.error = (...args) => { origConsoleError(...args); captureLog(args); };

// ---- concurrency limiter (same semantics as proxy.js) ---------------------
const sem = {
    max: MAX_CONCURRENT,
    maxQueue: MAX_QUEUE,
    active: 0,
    waiters: [],
    get queued() { return this.waiters.length; },
    _mkRelease() {
        let done = false;
        return () => { if (done) return; done = true; this._next(); };
    },
    acquire() {
        if (this.active < this.max) {
            this.active++;
            return { ok: true, slot: Promise.resolve(this._mkRelease()) };
        }
        if (this.waiters.length >= this.maxQueue) return { ok: false };
        const waiter = { cancelled: false, enqueuedAt: Date.now() };
        waiter.slot = new Promise((resolve, reject) => {
            waiter._promote = () => resolve(this._mkRelease());
            waiter.timer = setTimeout(() => {
                this._removeWaiter(waiter);
                reject(new Error('queue_timeout'));
            }, QUEUE_TIMEOUT_MS);
            waiter._reject = reject;
        });
        this.waiters.push(waiter);
        return { ok: true, slot: waiter.slot, waiter };
    },
    _next() {
        while (this.waiters.length) {
            const w = this.waiters.shift();
            clearTimeout(w.timer);
            if (w.cancelled) continue;
            w._promote();
            return;
        }
        this.active--;
    },
    _removeWaiter(w) {
        const i = this.waiters.indexOf(w);
        if (i >= 0) this.waiters.splice(i, 1);
    },
    position(w) { return this.waiters.indexOf(w); },
    cancelWaiter(w) {
        if (!w || w.cancelled) return;
        w.cancelled = true;
        clearTimeout(w.timer);
        this._removeWaiter(w);
        try { w._reject(new Error('client_gone')); } catch (e) {}
    },
};

// Pool usage state for OpenClaw/Paperclip (DOM-30). Writes only while
// ~/.openclaw/state/pools/ENABLED exists; every call is guarded inside.
let pools = null;
try { pools = createPoolWriter({ proxy: 'cc', getLoad: () => ({ active: sem.active, queued: sem.queued }) }); } catch (e) { console.error(`pools: ${e.message}`); }
const POOL_OUTCOME = { ok: 'ok', quota_exhausted: 'limit', idle_timeout: 'timeout', hard_timeout: 'timeout' };

// ---- roles ----------------------------------------------------------------
// full — --dangerously-skip-permissions: every tool auto-approved.
// ops  — full + --disallowedTools from ops-deny.json (no HA config changes).
// cfg  — full + --disallowedTools from cfg-deny.json (HA config yes, no restart).
// web  — dontAsk, only WebSearch/WebFetch + paperclip MCP, fetch guard (see WEB_*).
// ro   — --permission-mode dontAsk: anything not on the allowlist is denied
//        immediately (no hang), reported in result.permission_denials, and the
//        model continues without it. Built-in tools narrowed by --tools.
function loadRoAllow() {
    try {
        const j = JSON.parse(fs.readFileSync(RO_ALLOW_FILE, 'utf8'));
        return Array.isArray(j.allow) ? j.allow : [];
    } catch (e) { return []; }
}
function loadDeny(file, fallback) {
    try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (Array.isArray(j.deny) && j.deny.length) return j.deny;
    } catch (e) {}
    return fallback;
}
const loadOpsDeny = () => loadDeny(OPS_DENY_FILE, OPS_DENY_DEFAULT);
const loadCfgDeny = () => loadDeny(CFG_DENY_FILE, CFG_DENY_DEFAULT);
function loadProjects() {
    try {
        const j = JSON.parse(fs.readFileSync(PROJECTS_FILE, 'utf8'));
        const out = {};
        for (const [name, v] of Object.entries(j)) {
            const p = typeof v === 'string' ? { dir: v } : v;
            if (p && p.dir) out[name] = { dir: p.dir, roDeny: Array.isArray(p.roDeny) ? p.roDeny : [] };
        }
        return out;
    } catch (e) { return {}; }
}

// Setting sources differ by role on purpose. full loads the project's own
// .claude/settings(.local).json (hooks, env — permissions are moot under
// skip-permissions). ro must NOT: a project allowlist (e.g. a home-automation project
// allows ha_call_service and Bash(ssh *)) would silently widen the RO role.
// CLAUDE.md is loaded from cwd either way (verified with --setting-sources "").
// full/ops: PreToolUse hook that blocks whole-disk scans (`find /`, `grep -r x /`).
// Under / sit NFS shares and the HA sshfs mount; such a scan stalled a session
// for 12 min (22.10.2026). Passed via --settings, so it applies even with
// --setting-sources "" and --dangerously-skip-permissions (verified). RO has no Bash.
const BASH_GUARD = path.join(__dirname, 'tools', 'cc_bash_guard.js');
// ops/cfg: tools/ha_guard.js checks the ARGUMENTS of the HA tools left enabled
// (ha_call_service: homeassistant.restart, hassio.*, ws_command, device restart
// buttons; ha_call_event: core events; shell: restart via API/`ha` CLI).
// Exit 2 = deny. Script path is fixed here, its rules are read per call.
const HA_GUARD = path.join(__dirname, 'tools', 'ha_guard.js');
function guardSettings(role) {
    const hook = (file, ...a) => ({ type: 'command', command: [process.execPath, file, ...a].join(' '), timeout: 10 });
    const bash = fs.existsSync(BASH_GUARD) ? [hook(BASH_GUARD)] : [];
    const pre = [];
    if (role === 'ops' || role === 'cfg') {
        // Fail closed: ops/cfg without the guard would reopen ha_restart.
        if (!fs.existsSync(HA_GUARD)) throw new Error(`brak ${HA_GUARD}`);
        bash.push(hook(HA_GUARD, role));
        pre.push({ matcher: 'mcp__ha-mcp__ha_call_service|mcp__ha-mcp__ha_call_event|mcp__ha-mcp__ha_bulk_control', hooks: [hook(HA_GUARD, role)] });
    }
    if (bash.length) pre.unshift({ matcher: 'Bash', hooks: bash });
    return pre.length ? JSON.stringify({ hooks: { PreToolUse: pre } }) : null;
}
// Appended to every run's system prompt: where chat attachments live.
const PROXY_SYSTEM_NOTE = '\n\n## Pliki z czatu (proxy)\n' +
    'Załącznik `media://inbound/NAZWA` to plik `~/.openclaw/media/inbound/NAZWA---<uuid>.<ext>` ' +
    '(np. `ls ~/.openclaw/media/inbound/ | grep NAZWA`). Nie przeszukuj całego dysku (`find /`): ' +
    'pod / są udziały NFS i sshfs, skan trwa wiele minut i zawiesza sesję.\n';

// mcp-web.json = mcp.json filtered to WEB_MCP_SERVERS, rewritten per run so it
// follows mcp.json. Fails closed: no file, no web run.
function webMcpConfig() {
    const src = JSON.parse(fs.readFileSync(MCP_CONFIG, 'utf8'));
    const servers = Object.fromEntries(Object.entries(src.mcpServers || {}).filter(([k]) => WEB_MCP_SERVERS.includes(k)));
    fs.writeFileSync(WEB_MCP_CONFIG, JSON.stringify({ mcpServers: servers }, null, 1), { mode: 0o600 });
    return WEB_MCP_CONFIG;
}
function devMcpConfig() {
    const sandboxMcp = process.env.CC_DEV_SANDBOX_MCP || DEV_SANDBOX_MCP;
    const cfgDir = process.env.CC_CONFIG_DIR || CONFIG_DIR;
    const mcpCfgPath = process.env.CC_MCP_CONFIG || (process.env.CC_CONFIG_DIR ? path.join(cfgDir, 'mcp.json') : MCP_CONFIG);
    const devMcpCfgPath = process.env.CC_DEV_MCP_CONFIG || (process.env.CC_CONFIG_DIR ? path.join(cfgDir, 'mcp-dev.json') : DEV_MCP_CONFIG);
    if (!fs.existsSync(sandboxMcp)) throw new Error(`brak ${sandboxMcp}`);
    const defaultPaperclipMcp = path.join(__dirname, 'mcp', 'paperclip.js');
    let pcEntry = null;
    if (fs.existsSync(mcpCfgPath)) {
        const src = JSON.parse(fs.readFileSync(mcpCfgPath, 'utf8'));
        if (src && src.mcpServers && src.mcpServers.paperclip && typeof src.mcpServers.paperclip === 'object') {
            pcEntry = src.mcpServers.paperclip;
        }
    }
    if (!pcEntry) {
        if (!fs.existsSync(defaultPaperclipMcp)) throw new Error(`brak ${defaultPaperclipMcp}`);
        pcEntry = { command: process.execPath, args: [defaultPaperclipMcp] };
    } else if (Array.isArray(pcEntry.args) && pcEntry.args[0] && !fs.existsSync(pcEntry.args[0])) {
        throw new Error(`brak pliku MCP paperclip: ${pcEntry.args[0]}`);
    }
    const dir = path.dirname(devMcpCfgPath);
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const tmp = `${devMcpCfgPath}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({
        mcpServers: {
            paperclip: pcEntry,
            'dev-sandbox': { command: process.execPath, args: [sandboxMcp] },
        },
    }, null, 2), { mode: 0o600 });
    try { fs.chmodSync(tmp, 0o600); } catch (e) {}
    fs.renameSync(tmp, devMcpCfgPath);
    try { fs.chmodSync(devMcpCfgPath, 0o600); } catch (e) {}
    return devMcpCfgPath;
}
function formatDevReposList(repos) {
    if (Array.isArray(repos) && repos.length) {
        const names = repos.map(r => (typeof r === 'string' ? r : (r && (r.name || r.repo || r.subdir || '')))).filter(Boolean);
        if (names.length) return names.map(n => n.startsWith('./') ? n : `./${n}`).join(', ');
    }
    if (repos && typeof repos === 'object') {
        const keys = Object.keys(repos).filter(Boolean);
        if (keys.length) return keys.map(k => k.startsWith('./') ? k : `./${k}`).join(', ');
    }
    return './openclaw, ./infra-monitor, ./scratch';
}
function buildDevSystemNote(devCtx) {
    if (!devCtx || !devCtx.worktreeRoot) return '';
    const reposText = formatDevReposList(devCtx.repos);
    return [
        '',
        '## Piaskownica wykonawcza (rola dev)',
        `- Twój przydzielony katalog roboczy (worktreeRoot): \`${devCtx.worktreeRoot}\` (sprawa: \`${devCtx.issueKey || '-'}\`).`,
        `- Podkatalogi repozytoriów wewnątrz worktreeRoot: ${reposText} (oraz \`./scratch\`). Pracuj wyłącznie wewnątrz \`${devCtx.worktreeRoot}\` — odwołania poza ten katalog są blokowane przez strażnika.`,
        '- Natywne narzędzie `Bash` oraz dostęp do internetu są wyłączone. Do uruchamiania testów, lintera, skryptów oraz operacji Git używaj wyłącznie narzędzi MCP `dev-sandbox`: `dev_info`, `dev_exec`, `dev_git_status`, `dev_git_diff`, `dev_git_commit`.',
        '',
    ].join('\n');
}
function roleArgs(role, project, devCtx) {
    if (role === 'dev') {
        if (!devCtx || typeof devCtx.worktreeRoot !== 'string' || !devCtx.worktreeRoot.trim()) {
            throw new Error("Rola 'dev' wymaga devCtx.worktreeRoot");
        }
        const guardPath = process.env.CC_DEV_GUARD || DEV_GUARD;
        const sandboxMcp = process.env.CC_DEV_SANDBOX_MCP || DEV_SANDBOX_MCP;
        if (!fs.existsSync(guardPath)) throw new Error(`brak ${guardPath}`);
        if (!fs.existsSync(sandboxMcp)) throw new Error(`brak ${sandboxMcp}`);
        const hook = { type: 'command', command: [process.execPath, guardPath].join(' '), timeout: 15 };
        return [
            '--setting-sources', '',
            '--permission-mode', 'dontAsk',
            '--tools', DEV_BUILTIN_TOOLS,
            '--settings', JSON.stringify({
                hooks: {
                    PreToolUse: [{
                        matcher: '.*',
                        hooks: [hook],
                    }],
                },
            }),
            '--allowedTools', DEV_ALLOWED_TOOLS.join(','),
            '--mcp-config', devMcpConfig(),
            '--strict-mcp-config',
        ];
    }
    if (role === 'web') {
        if (!fs.existsSync(WEB_GUARD)) throw new Error(`brak ${WEB_GUARD}`);
        const hook = { type: 'command', command: [process.execPath, WEB_GUARD].join(' '), timeout: 15 };
        const allow = [...WEB_BUILTIN_TOOLS.split(','), ...loadRoAllow().filter(t => t.startsWith('mcp__paperclip__'))];
        return ['--setting-sources', '', '--permission-mode', 'dontAsk', '--tools', WEB_BUILTIN_TOOLS,
            '--settings', JSON.stringify({ hooks: { PreToolUse: [{ matcher: 'WebFetch', hooks: [hook] }] } }),
            '--allowedTools', allow.join(','),
            '--mcp-config', webMcpConfig(), '--strict-mcp-config'];
    }
    if (role === 'ro') {
        const allow = loadRoAllow();   // re-read per run: editing the file needs no restart
        const deny = [...RO_DENY_DEFAULT, ...(project ? project.roDeny : [])];
        const args = ['--setting-sources', '', '--permission-mode', 'dontAsk', '--tools', RO_BUILTIN_TOOLS,
            '--disallowedTools', deny.join(',')];
        if (allow.length) args.push('--allowedTools', allow.join(','));
        return args;
    }
    const args = ['--setting-sources', project ? 'project,local' : '', '--dangerously-skip-permissions'];
    const guards = guardSettings(role);
    if (guards) args.push('--settings', guards);
    if (role === 'ops') args.push('--disallowedTools', loadOpsDeny().join(','));
    if (role === 'cfg') args.push('--disallowedTools', loadCfgDeny().join(','));
    return args;
}
const DEFAULT_ROLE = (process.env.CC_DEFAULT_ROLE === 'full') ? 'full' : 'ro';
// --- full-role grant ---
// Bez sufiksu = rola 'ro'. Rola 'full' tylko przez sufiks -full i ważny grant
// w /etc/openclaw/full-grant (epoch wygaśnięcia; właściciel root lub użytkownik
// proxy; bez zapisu dla grupy/innych). Modele nie mają zapisu w /etc.
const FULL_GRANT_FILE = process.env.OC_FULL_GRANT_FILE || '/etc/openclaw/full-grant';
function fullGrantValid() {
    try {
        const st = fs.statSync(FULL_GRANT_FILE);
        if (!st.isFile()) return false;
        if (st.uid !== 0 && st.uid !== process.getuid()) return false;
        if (st.mode & 0o022) return false;
        const exp = parseInt(fs.readFileSync(FULL_GRANT_FILE, 'utf8').trim(), 10);
        return Number.isFinite(exp) && exp > Math.floor(Date.now() / 1000);
    } catch (e) { return false; }
}
const FULL_DENIED = 'Rola -full wymaga ważnego grantu (/etc/openclaw/full-grant). Użyj sufiksu -ops albo poproś administratora o grant.';
const roleActive = { full: 0, ops: 0, ro: 0, cfg: 0, web: 0, dev: 0 };

// Model id grammar: <model>[:<project>][-ro|-ops|-cfg|-web|-dev]
//   claude-sonnet          sonnet, full role, neutral WORKDIR
//   claude-sonnet-ro       read-only role
//   claude-sonnet:ha       runs inside project "ha" (projects.json)
//   claude-sonnet:ha-ro    project "ha", read-only
//   claude-opus-high-ops   full minus HA config changes (agent main)
//   claude-sonnet:ha-cfg   project "ha", full minus ha_restart (agent ha-yaml)
// Not "@": OpenClaw reads "model@profile" as an auth-profile selector.
function resolveModel(requested) {
    if (!requested) return { model: DEFAULT_MODEL, effort: process.env.CC_EFFORT || null, role: DEFAULT_ROLE, project: null };
    let id = requested.includes('/') ? requested.split('/').pop() : requested;
    let role = DEFAULT_ROLE;
    if (id.endsWith('-ro')) { role = 'ro'; id = id.slice(0, -3); }
    else if (id.endsWith('-full')) { role = 'full'; id = id.slice(0, -5); }
    else if (id.endsWith('-ops')) { role = 'ops'; id = id.slice(0, -4); }
    else if (id.endsWith('-cfg')) { role = 'cfg'; id = id.slice(0, -4); }
    else if (id.endsWith('-web')) { role = 'web'; id = id.slice(0, -4); }
    else if (id.endsWith('-dev')) { role = 'dev'; id = id.slice(0, -4); }
    let project = null, projectName = null;
    const colon = id.indexOf(':');
    if (colon >= 0) {
        projectName = id.slice(colon + 1);
        id = id.slice(0, colon);
        const projects = loadProjects();
        project = projects[projectName] || null;
        if (!project) return { error: `Nieznany projekt "${projectName}" w modelu "${requested}". Dostępne: ${Object.keys(projects).join(', ') || '(brak — ' + PROJECTS_FILE + ')'}` };
        if (!fs.existsSync(project.dir)) return { error: `Katalog projektu "${projectName}" nie istnieje: ${project.dir}` };
    }
    let model = null, effort = process.env.CC_EFFORT || null;
    const entry = MODEL_MAP[id];
    if (entry && typeof entry === 'object') { model = entry.model; effort = entry.effort || effort; }
    else if (entry) model = entry;
    else if (/^claude-[a-z0-9-]+$/.test(id)) model = id;   // full model id, e.g. claude-sonnet-5
    if (!model) return { error: `Nieznany model "${requested}". Dostępne id: ${Object.keys(MODEL_MAP).join(', ')} lub pełne claude-*; opcjonalnie :projekt i sufiks -ro/-ops/-cfg/-web/-dev` };
    return { model, effort, role, project, projectName };
}

// Footer label in the same style as the agy proxy: "claude-opus-5-5" + effort
// "high" -> "Claude Opus 5.5 (High)". Unknown ids pass through unchanged.
function prettyModel(id, effort) {
    const cap = (w) => w.charAt(0).toUpperCase() + w.slice(1);
    const m = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(id || '');
    const name = m ? `Claude ${cap(m[1])} ${m[2]}.${m[3]}` : (id || 'claude');
    return effort ? `${name} (${cap(String(effort))})` : name;
}

// ---- prompt ---------------------------------------------------------------
function contentToText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) return content.filter(c => c && c.type === 'text').map(c => c.text).join('\n');
    if (content == null) return '';
    return JSON.stringify(content);
}
function stripTimestamp(text) { return text.replace(/^\[.*?\]\s*/, '').trim(); }

const CONTROL_SENTINELS = ['NO_REPLY', 'HEARTBEAT_OK'];
const CONTROL_PREFIXES = ['WATCHDOG_FAIL', 'CANARY-'];
function isControlSentinel(text) {
    const t = text.trim();
    return CONTROL_SENTINELS.includes(t) || CONTROL_PREFIXES.some(p => t.startsWith(p));
}
function stripProgress(text) {
    return text
        .replace(/\/home\/…HDOG\.md/g, (process.env.WATCHDOG_DIR || '/opt/workspace') + '/WATCHDOG.md')
        .replace(/\/home\/…TITY\.md/g, (process.env.WATCHDOG_DIR || '/opt/workspace') + '/IDENTITY.md')
        .replace(/\r?[⏳⌛][^\r\n]*/g, '')
        .replace(/⚠️?\s*\[proxy\][^\r\n]*/g, '')
        .replace(/\n\n— model: [^\r\n]*$/, '')
        .replace(/\r/g, '')
        .replace(/^\n+/, '')
        .trim();
}

// OpenClaw lists its own tools (cron, sessions_*, ...) in the system prompt,
// but a CLI backend only has Claude Code's built-ins plus --mcp-config
// servers. Say so, or the model narrates calls to tools it cannot reach.
const IDENTITY_NOTE = [
    '## Środowisko wykonania (nadrzędne)',
    'Jesteś asystentem OpenClaw uruchomionym przez Claude Code jako backend modelu.',
    'Narzędzia OpenClaw wymienione wyżej, których nie masz na własnej liście narzędzi, są niedostępne w tym trybie — nie udawaj ich wywołania. Używaj swoich narzędzi (w tym serwerów MCP, np. Home Assistant) bezpośrednio.',
    'Odpowiedź końcowa trafia do użytkownika dosłownie — bez komentarza o narzędziach i o tym trybie.',
].join('\n');

// System messages go to --append-system-prompt-file (keeps Claude Code's own
// tool-usage guidance); history + latest turn go on stdin. Neither goes in
// argv: a 90k-char Polish prompt exceeds Linux MAX_ARG_STRLEN (128 KiB).
function buildPrompt(messages) {
    const systemParts = [];
    const history = [];
    let lastUser = '';
    messages.forEach((msg, idx) => {
        const role = (msg.role || 'user').toLowerCase();
        const text = stripProgress(stripTimestamp(contentToText(msg.content)));
        if (!text) return;
        if (role === 'system' || role === 'developer') systemParts.push(text);
        else if (idx === messages.length - 1 && role === 'user') lastUser = text;
        else history.push(`[${role.toUpperCase()}]: ${text}`);
    });
    const cappedHistory = history.slice(-HISTORY_LIMIT);
    const system = [...systemParts, IDENTITY_NOTE].join('\n\n');
    if (!cappedHistory.length) return { system, prompt: lastUser };
    const sections = ['Kontekst poprzednich wiadomości:\n' + cappedHistory.join('\n')];
    if (lastUser) sections.push('Aktualne zapytanie użytkownika:\n' + lastUser);
    return { system, prompt: sections.join('\n\n') };
}

// ---- helpers --------------------------------------------------------------
function withoutPaperclipEnv(env) {
    const out = { ...env };
    for (const k of PC_ENV_KEYS) delete out[k];
    for (const k of DEV_ENV_KEYS) delete out[k];
    return out;
}
function fmtDuration(ms) {
    if (ms == null) return 'nieznany czas';
    const totalSec = Math.max(0, Math.round(ms / 1000));
    const h = Math.floor(totalSec / 3600), m = Math.floor((totalSec % 3600) / 60), s = totalSec % 60;
    if (h) return `${h}h ${m}m`;
    if (m) return `${m}m ${s}s`;
    return `${s}s`;
}

// One-line human label for a tool call, for the ⏳ status line. Tool name plus
// a short, bounded hint — never the full input (could carry secrets/paths).
function toolLabel(block) {
    const name = String(block.name || 'narzędzie');
    const inp = block.input || {};
    const mcp = name.match(/^mcp__(.+?)__(.+)$/);
    if (mcp) return `MCP ${mcp[1]}: ${mcp[2]}`;
    const hint = inp.description || inp.pattern || inp.query || (inp.file_path ? path.basename(inp.file_path) : '') || '';
    return hint ? `${name}: ${String(hint).replace(/\s+/g, ' ').slice(0, 60)}` : name;
}

function failureCode({ spawnErr, timedOut, code, emptyFail, quota, apiError }) {
    if (spawnErr) return 'spawn_error';
    if (quota) return 'quota_exhausted';
    if (timedOut === 'idle') return 'idle_timeout';
    if (timedOut === 'hard') return 'hard_timeout';
    if (apiError) return 'claude_error';
    if (emptyFail) return 'empty_output';
    if (code !== 0) return 'nonzero_exit';
    return 'claude_error';
}

// Spawn one `claude -p` attempt. Callbacks:
//   onText(chunk)   — text of the FINAL assistant message (see below)
//   onStatus(ev)    — {type:'tool', label} | {type:'narration', text} | {type:'turn', turns}
//   cb(result)      — exactly once, after the process exits or is killed
// Text of an assistant message that ends in tool_use is intermediate
// narration ("Sprawdzę stan..."), not the answer. It is buffered per message
// and routed to onStatus when the message stops with stop_reason=tool_use,
// or to onText when it stops with end_turn. Streaming narration as content
// would glue it into the answer and break exact-match sentinels (NO_REPLY).
function runClaude({ model, effort, role, project, devCtx, system, prompt, pcEnv, onText, onStatus, onChild }, cb) {
    let stderr = '';
    let spawnErr = null;
    let timedOut = false;
    let done = false;
    let turns = 0;
    let result = null;         // final `result` event
    let usedModel = null;      // from message_start
    const turnUsage = createTurnUsage(); // context size of the last top-level turn
    let quota = null;          // {resetsAt, type} once a rejected rate limit is seen
    let quotaPendingAt = 0;    // when that rejection arrived; cleared if the model keeps going
    let msgText = '';          // text of the in-flight assistant message (top level only)
    let sentText = '';
    const tools = [];
    // tool_use ids awaiting their tool_result. A delegated subagent call
    // (openclaw_agents ask_agent) or a long MCP tool emits no event for
    // minutes; while one is open, only HARD applies.
    const openTools = new Set();
    const attemptStart = Date.now();
    let lastEventAt = Date.now();

    const sysFile = path.join(os.tmpdir(), `cc-proxy-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.sys.txt`);
    const devNote = (role === 'dev' && devCtx) ? buildDevSystemNote(devCtx) : '';
    try { fs.writeFileSync(sysFile, system + PROXY_SYSTEM_NOTE + devNote, { mode: 0o600 }); } catch (e) { spawnErr = e; }

    let rArgs = [];
    try { rArgs = roleArgs(role, project, devCtx); } catch (e) { spawnErr = e; }   // e.g. guard missing: refuse, never run unguarded
    const args = [
        '-p',
        '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
        '--no-session-persistence',
        // Never user settings: keeps the operator's personal hooks, plugins
        // and permission rules out of OpenClaw runs (see roleArgs).
        '--model', model,
        '--append-system-prompt-file', sysFile,
        ...rArgs,
    ];
    if (effort) args.push('--effort', effort);
    if (role === 'web' || role === 'dev') { /* own --mcp-config from roleArgs */ }
    else if (fs.existsSync(MCP_CONFIG)) args.push('--mcp-config', MCP_CONFIG, '--strict-mcp-config');
    else args.push('--strict-mcp-config');

    if (spawnErr) { setImmediate(() => finish(-1)); return; }
    const cwd = (role === 'dev' && devCtx) ? devCtx.worktreeRoot : (project ? project.dir : WORKDIR);
    if (role !== 'dev' && !project) { try { fs.mkdirSync(WORKDIR, { recursive: true }); } catch (e) {} }

    const childEnv = {
        ...withoutPaperclipEnv(process.env),
        NO_COLOR: '1',
        CLAUDE_CODE_ENTRYPOINT: 'openclaw-proxy',
        MCP_TOOL_TIMEOUT: String(MCP_TOOL_TIMEOUT_MS),
        ...(pcEnv || {}),
    };
    if (role === 'dev' && devCtx) {
        childEnv.DEV_WORKTREE_ROOT = devCtx.worktreeRoot;
        childEnv.DEV_ISSUE_KEY = devCtx.issueKey;
    }

    const child = spawn(process.env.CC_BIN || CLAUDE_BIN, args, {
        cwd,
        stdio: ['pipe', 'pipe', 'pipe'],
        detached: true,   // own process group: kill(-pid) also reaps tool/MCP grandchildren
        // MCP_TOOL_TIMEOUT: a subagent turn can take many minutes, but a hung
        // MCP call must not hold the run open until HARD (see MCP_TOOL_TIMEOUT_MS).
        // pcEnv: Paperclip run context for the MCP bridge mcp/paperclip.js (from
        // the wake text, see tools/paperclip_wake.js); never inherited otherwise.
        env: childEnv,
    });
    if (onChild) onChild(child);
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);

    const killTree = () => {
        try { process.kill(-child.pid, 'SIGKILL'); } catch (e) { try { child.kill('SIGKILL'); } catch (e2) {} }
    };

    const flushText = (text) => {
        if (!text) return;
        sentText += text;
        if (onText) onText(text);
    };

    const handleEvent = (ev) => {
        lastEventAt = Date.now();
        if (ev.type === 'stream_event' && !ev.parent_tool_use_id) {
            const e = ev.event || {};
            // Any model output after the rejection means the run is alive.
            if (quotaPendingAt) {
                console.log(`⏱ claude LIMIT (${quota.type || '?'}) zgłoszony, ale model odpowiada dalej — ignoruję`);
                quotaPendingAt = 0;
                quota.ignored = true;
            }
            turnUsage.onStreamEvent(e);
            if (e.type === 'message_start') {
                turns++;
                msgText = '';
                if (e.message && e.message.model) usedModel = e.message.model;
                if (onStatus) onStatus({ type: 'turn', turns });
            } else if (e.type === 'content_block_delta' && e.delta && e.delta.type === 'text_delta') {
                msgText += e.delta.text;
            } else if (e.type === 'message_delta' && e.delta && e.delta.stop_reason) {
                const text = msgText;
                msgText = '';
                if (e.delta.stop_reason === 'tool_use') {
                    if (text.trim() && onStatus) onStatus({ type: 'narration', text: text.trim() });
                } else {
                    // end_turn / max_tokens / stop_sequence: this is answer text.
                    // Separate consecutive answer messages the way the CLI does.
                    flushText(sentText && text ? '\n\n' + text : text);
                }
            }
        } else if (ev.type === 'assistant' && !ev.parent_tool_use_id && ev.message) {
            for (const b of ev.message.content || []) {
                if (b.type === 'tool_use') {
                    tools.push(b.name);
                    openTools.add(b.id);
                    if (onStatus) onStatus({ type: 'tool', label: toolLabel(b) });
                }
            }
        } else if (ev.type === 'user' && !ev.parent_tool_use_id && ev.message && Array.isArray(ev.message.content)) {
            for (const b of ev.message.content) if (b.type === 'tool_result') openTools.delete(b.tool_use_id);
        } else if (ev.type === 'rate_limit_event' && ev.rate_limit_info) {
            const info = ev.rate_limit_info;
            if (pools) pools.rateLimit(info);
            // Paid overage covering the overflow is not a stop either.
            if (info.status === 'rejected' && !info.isUsingOverage && !quotaPendingAt && !(quota && !quota.ignored)) {
                quota = { resetsAt: info.resetsAt ? info.resetsAt * 1000 : null, type: info.rateLimitType || null };
                quotaPendingAt = Date.now();
                console.log(`⏱ claude LIMIT (${quota.type || '?'}) odrzucony — reset za ${fmtDuration(quota.resetsAt ? quota.resetsAt - Date.now() : null)}, czekam ${QUOTA_GRACE_MS / 1000}s czy model odpowie`);
            }
        } else if (ev.type === 'result') {
            result = ev;
        }
    };

    const decoder = new StringDecoder('utf8');
    let lineBuf = '';
    child.stdout.on('data', (d) => {
        lineBuf += decoder.write(d);
        let nl;
        while ((nl = lineBuf.indexOf('\n')) >= 0) {
            const line = lineBuf.slice(0, nl).trim();
            lineBuf = lineBuf.slice(nl + 1);
            if (!line) continue;
            let ev;
            try { ev = JSON.parse(line); } catch (e) { stderr += `[non-json stdout] ${line.slice(0, 200)}\n`; continue; }
            try { handleEvent(ev); } catch (e) { console.error('event handler error:', e.message); }
        }
    });
    child.stderr.on('data', (d) => { stderr += d.toString(); if (stderr.length > 20000) stderr = stderr.slice(-20000); });

    const watchdog = setInterval(() => {
        const now = Date.now();
        if (now - attemptStart > HARD_TIMEOUT_MS) timedOut = 'hard';
        else if (quotaPendingAt && !openTools.size && now - quotaPendingAt > QUOTA_GRACE_MS) timedOut = 'quota';
        else if (!openTools.size && now - lastEventAt > IDLE_TIMEOUT_MS) timedOut = 'idle';
        if (timedOut) {
            console.log(`⏱ claude timeout=${timedOut} po ${((now - attemptStart) / 1000).toFixed(0)}s (tur: ${turns})`);
            clearInterval(watchdog);
            killTree();
        }
    }, WATCHDOG_MS);

    child.on('error', (e) => { spawnErr = e; finish(-1); });
    // 'exit', not 'close': an MCP grandchild holding the pipe would stall 'close'.
    child.on('exit', (code, signal) => {
        // Let buffered stdout drain (the final result line) before finishing.
        setTimeout(() => finish(code == null ? (signal ? -1 : 0) : code), 200);
    });

    function finish(code) {
        if (done) return;
        done = true;
        clearInterval(watchdog);
        try { fs.unlinkSync(sysFile); } catch (e) {}
        // Any stragglers (MCP servers, tools) in the group die with the run.
        if (child && child.pid) { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {} }
        // A result that arrived without a final end_turn message (e.g. max
        // turns) still carries its text — surface it if nothing was sent.
        if (result && !sentText && typeof result.result === 'string' && !result.is_error) flushText(result.result);
        if (DEBUG_DIR) {
            try { fs.writeFileSync(path.join(DEBUG_DIR, 'last_stderr.txt'), stderr); } catch (e) {}
        }
        cb({ code, stderr, spawnErr, timedOut, result, turns, tools, usedModel, quota, sentText, lastTurnUsage: turnUsage.last, durationMs: Date.now() - attemptStart });
    }
}

// Classify a finished attempt. Returns null on success or {msg, code, retry, status}.
function classify(r, model) {
    const { code, stderr, spawnErr, timedOut, result, turns, quota, sentText } = r;
    if (spawnErr) return { msg: `Nie udało się uruchomić claude: ${spawnErr.message}`, code: 'spawn_error', status: 502 };
    // A limit counts only if the run actually failed; a successful run that saw
    // a stray rejection is a success. A 429 result without the event counts too.
    const failed = timedOut === 'quota' || !sentText.trim() || (result && result.is_error);
    const apiQuota = result && result.is_error && (result.api_error_status === 429 || /usage limit|rate limit/i.test(String(result.result || '')));
    if ((quota && !quota.ignored && failed) || apiQuota) {
        if (!quota) quota = { resetsAt: null, type: null };
        const eta = quota.resetsAt ? fmtDuration(quota.resetsAt - Date.now()) : 'nieznany czas';
        return { msg: `Limit subskrypcji Claude (${quota.type || 'okno'}) wyczerpany — reset za ${eta}. Wybierz inny model/provider lub poczekaj. ${FAILOVER_TAG}`, code: 'quota_exhausted', status: 429, resetMs: quota.resetsAt ? quota.resetsAt - Date.now() : null };
    }
    if (timedOut === 'idle') return { msg: `claude przerwany — brak zdarzeń przez ${IDLE_TIMEOUT_MS / 60000} min (tur: ${turns})`, code: 'idle_timeout', retry: true, status: 504 };
    if (timedOut === 'hard') return { msg: `Przekroczono absolutny limit czasu (${HARD_TIMEOUT_MS / 60000} min, tur: ${turns})`, code: 'hard_timeout', status: 504 };
    if (result && (result.is_error || (result.subtype && result.subtype !== 'success'))) {
        const detail = (typeof result.result === 'string' && result.result) || (result.errors && result.errors.join('; ')) || result.subtype;
        const apiStatus = result.api_error_status ? ` (HTTP ${result.api_error_status})` : '';
        // 5xx/overloaded from the API are worth one retry; 4xx and max-turns are not.
        const retry = !sentText && (!result.api_error_status || result.api_error_status >= 500);
        return { msg: `claude zakończył się błędem${apiStatus}: ${String(detail).slice(0, 400)}`, code: 'claude_error', retry, status: 502 };
    }
    if (code !== 0) {
        return { msg: `claude zakończył się błędem (kod ${code})${stderr.trim() ? ': ' + stderr.trim().slice(-300) : ''}`, code: 'nonzero_exit', retry: !sentText, status: 500 };
    }
    if (!sentText.trim()) return { msg: `claude nie zwrócił treści${stderr.trim() ? ': ' + stderr.trim().slice(-300) : ''}`, code: 'empty_output', status: 500 };
    return null;
}

// In full/ops a denial comes from a hook (cc_bash_guard.js) or ops-deny, not an allowlist.
function denialNote(r, role) {
    const d = (r.result && r.result.permission_denials) || [];
    if (!d.length) return null;
    const names = [...new Set(d.map(x => x.tool_name))].join(', ');
    return role === 'ro' ? `odmowa uprawnień (rola ro) dla: ${names}` : `zablokowane przez proxy (rola ${role}) dla: ${names}`;
}

// ---- HTTP server ----------------------------------------------------------
const server = http.createServer((req, res) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);

    if (req.url === '/v1/models' || req.url === '/models') {
        res.setHeader('Content-Type', 'application/json');
        const baseIds = Object.keys(MODEL_MAP);
        const withProjects = [...baseIds, ...Object.keys(loadProjects()).flatMap(p => baseIds.map(id => `${id}:${p}`))];
        const ids = [...withProjects, ...["ro", "full", "ops", "cfg", "web", "dev"].flatMap(r => withProjects.map(id => `${id}-${r}`))];
        res.end(JSON.stringify({ object: 'list', data: ids.map(id => ({ id, object: 'model', owned_by: 'claude-code' })) }));
        return;
    }
    if (req.url === '/healthz') {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({
            active: sem.active, queued: sem.queued, maxConcurrent: MAX_CONCURRENT, maxQueue: MAX_QUEUE,
            roles: { ...roleActive }, defaultRole: DEFAULT_ROLE, defaultModel: DEFAULT_MODEL,
            mcpConfig: fs.existsSync(MCP_CONFIG) ? MCP_CONFIG : null,
            roAllow: loadRoAllow().length, opsDeny: loadOpsDeny().length, workdir: WORKDIR,
            projects: Object.fromEntries(Object.entries(loadProjects()).map(([k, v]) => [k, v.dir])),
            uptimeSec: Math.round(process.uptime()),
        }));
        return;
    }
    if (req.url === '/logs' || req.url.startsWith('/logs?')) {
        const n = parseInt(new URL(req.url, 'http://localhost').searchParams.get('n'), 10);
        const lines = (Number.isFinite(n) && n > 0) ? logBuffer.slice(-n) : logBuffer;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ lines, total: logBuffer.length, max: LOG_BUFFER_MAX }));
        return;
    }
    if (!(req.method === 'POST' && (req.url === '/v1/chat/completions' || req.url === '/chat/completions'))) {
        res.statusCode = 404;
        res.end('Not Found');
        return;
    }

    let body = '';
    req.on('data', chunk => { body += chunk.toString(); });
    req.on('end', async () => {
        let isStream = false;
        try {
            let data;
            try { data = JSON.parse(body); } catch (e) {
                res.statusCode = 400;
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({ error: { message: 'Błędny format JSON', type: 'invalid_request_error' } }));
                return;
            }
            const messages = data.messages || [];
            isStream = data.stream === true;
        const modelName = data.model || 'claude-code';
        const resolved = resolveModel(data.model);
        const requestId = `chatcmpl-${Date.now()}`;
        const createdTime = Math.floor(Date.now() / 1000);

        const jsonError = (status, message, code, extra = {}) => {
            res.statusCode = status;
            res.setHeader('Content-Type', 'application/json');
            res.end(JSON.stringify({ error: { message, type: 'claude_proxy_error', code, ...extra } }));
        };

        if (resolved.error) {
            console.error(`✗ ${resolved.error}`);
            return jsonError(400, resolved.error, 'unknown_model');
        }
        if (!messages.length) return jsonError(400, 'Brak wiadomości w zapytaniu', 'no_messages');

        const { model, effort, project, projectName } = resolved;
        const role = resolved.role;
        if (role === 'full' && !fullGrantValid()) {
            console.error(`✗ ${FULL_DENIED}`);
            if (isStream) {
                res.setHeader('Content-Type', 'text/event-stream');
                res.setHeader('Cache-Control', 'no-cache');
                res.setHeader('Connection', 'keep-alive');
                res.write(`data: ${JSON.stringify({
                    id: requestId,
                    object: 'chat.completion.chunk',
                    created: createdTime,
                    model: modelName,
                    choices: [{ delta: { content: `🛑 ${FULL_DENIED}` }, index: 0, finish_reason: 'stop' }],
                })}\n\n`);
                res.write('data: [DONE]\n\n');
                res.end();
                return;
            }
            return jsonError(403, FULL_DENIED, 'full_grant_required');
        }
        const built = buildPrompt(messages);
        const system = built.system;
        const pc = applyPaperclipWake(built.prompt);
        const prompt = pc.text;
        const pcEnv = pc.env;
        if (pcEnv) console.log(`  paperclip: run=${pcEnv.PAPERCLIP_RUN_ID} agent=${pcEnv.PAPERCLIP_AGENT_ID} task=${pcEnv.PAPERCLIP_TASK_ID || '-'} powód=${pcEnv.PAPERCLIP_WAKE_REASON || '-'} przepisano=${pc.rewritten}`);
        let pcCheck = null;
        if (pcEnv && role !== 'ro' && role !== 'web') {
            let check;
            try {
                const approvals = getApprovals();
                if (!approvals) throw new Error('brak modułu paperclip_approvals');
                check = await approvals.verifyProxyExecRun({ pcEnv, role });
            } catch (e) {
                check = { ok: false, code: 'paperclip_approval_denied', reason: e.message };
            }
            if (res.destroyed || res.writableEnded) return;
            if (!check.ok) {
                if (check.idle === true) {
                    console.log(`ℹ paperclip exec idle: run=${pcEnv.PAPERCLIP_RUN_ID} rola=${role} (brak zadania, zwrot odpowiedzi gotowości)`);
                    if (isStream) {
                        res.setHeader('Content-Type', 'text/event-stream');
                        res.setHeader('Cache-Control', 'no-cache');
                        res.setHeader('Connection', 'keep-alive');
                        res.write(`data: ${JSON.stringify({
                            id: requestId,
                            object: 'chat.completion.chunk',
                            created: createdTime,
                            model: modelName,
                            choices: [{ delta: { content: check.reason }, index: 0, finish_reason: 'stop' }],
                        })}\n\n`);
                        res.write('data: [DONE]\n\n');
                        res.end();
                    } else {
                        res.statusCode = 200;
                        res.setHeader('Content-Type', 'application/json');
                        res.end(JSON.stringify({
                            id: requestId,
                            object: 'chat.completion',
                            created: createdTime,
                            model: modelName,
                            choices: [{ message: { role: 'assistant', content: check.reason }, finish_reason: 'stop', index: 0 }],
                        }));
                    }
                    return;
                }
                console.error(`✗ paperclip: przebieg ${pcEnv.PAPERCLIP_RUN_ID} w roli ${role} odrzucony (${check.code}): ${check.reason}`);
                if (isStream) {
                    res.setHeader('Content-Type', 'text/event-stream');
                    res.setHeader('Cache-Control', 'no-cache');
                    res.setHeader('Connection', 'keep-alive');
                    res.write(`data: ${JSON.stringify({
                        id: requestId,
                        object: 'chat.completion.chunk',
                        created: createdTime,
                        model: modelName,
                        choices: [{ delta: { content: `🛑 [Paperclip Governance] Przebieg w roli ${role} zablokowany (${check.code}): ${check.reason}` }, index: 0, finish_reason: 'stop' }],
                    })}\n\n`);
                    res.write('data: [DONE]\n\n');
                    res.end();
                    return;
                }
                return jsonError(403, check.reason || `Przebieg z Paperclipa w roli ${role} jest zablokowany.`, check.code || 'paperclip_role_denied');
            }
            pcCheck = check;
            console.log(`✓ paperclip exec: run=${pcEnv.PAPERCLIP_RUN_ID} grant=${check.grantId} confirmation=${check.confirmationId} rola=${role}`);
        }
        let devCtx = null;
        if (role === 'dev') {
            let issueKey = null;
            let allowLocal = false;
            if (pcEnv) {
                issueKey = (pcCheck && (pcCheck.parentIdentifier || pcCheck.parentIssueId)) || null;
                if (!issueKey) {
                    return jsonError(403, 'Brak identyfikatora sprawy nadrzędnej dla roli dev.', 'paperclip_approval_denied');
                }
            } else {
                const rawLocalKey = Array.isArray(req.headers['x-dev-issue-key'])
                    ? req.headers['x-dev-issue-key'][0]
                    : req.headers['x-dev-issue-key'];
                const localKey = typeof rawLocalKey === 'string' ? rawLocalKey.trim() : '';
                if (process.env.CC_ALLOW_LOCAL_DEV === '1' && localKey) {
                    issueKey = localKey;
                    allowLocal = true;
                } else {
                    console.error(`✗ rola 'dev' wymaga przebiegu z Paperclipa z zatwierdzoną kartą zgody właściciela.`);
                    return jsonError(403, "Rola 'dev' wymaga przebiegu z Paperclipa z zatwierdzoną kartą zgody właściciela.", 'dev_requires_paperclip_issue');
                }
            }
            try {
                const devWs = getDevWorkspace();
                if (!devWs || typeof devWs.ensureDevWorkspace !== 'function') {
                    throw new Error('brak modułu dev_workspace');
                }
                const wsOpts = { issueKey, allowLocal };
                if (process.env.DEV_WORKTREES_BASE) wsOpts.worktreesBase = process.env.DEV_WORKTREES_BASE;
                const ws = await devWs.ensureDevWorkspace(wsOpts);
                if (res.destroyed || res.writableEnded) return;
                if (!ws || !ws.ok || !ws.rootDir) {
                    throw new Error((ws && ws.reason) || 'ensureDevWorkspace nie zwróciło rootDir');
                }
                devCtx = {
                    worktreeRoot: ws.rootDir,
                    issueKey: ws.issueKey || issueKey,
                    repos: ws.repos || null,
                };
            } catch (e) {
                if (res.destroyed || res.writableEnded) return;
                console.error(`✗ błąd piaskownicy dev (${issueKey}): ${e.message}`);
                return jsonError(500, `Nie udało się przygotować piaskownicy dev: ${e.message}`, 'dev_workspace_error');
            }
        }
        const startedAt = Date.now();
        console.log(`→ claude | stream=${isStream} | rola=${role} | model=${modelName} → ${model}${effort ? ` [effort=${effort}]` : ''}${projectName ? ` @ ${project.dir}` : ''} | system=${system.length} zn. prompt=${prompt.length} zn. | "${prompt.substring(0, 80).replace(/\n/g, ' ')}..."`);
        if (DEBUG_DIR) {
            try { fs.writeFileSync(path.join(DEBUG_DIR, 'last_system.txt'), system); fs.writeFileSync(path.join(DEBUG_DIR, 'last_prompt.txt'), prompt); } catch (e) {}
        }

        let currentChild = null;
        let clientGone = false;
        let heartbeat = null;
        let queueWaiter = null;
        let heldRelease = null;
        const holdSlot = (release) => { heldRelease = release; roleActive[role] = (roleActive[role] || 0) + 1; };
        const freeSlot = () => { if (heldRelease) { const r = heldRelease; heldRelease = null; roleActive[role] = Math.max(0, (roleActive[role] || 0) - 1); r(); } };
        // Flag lives in res 'close': after a client abort res.writableEnded stays
        // false, only res.destroyed flips (see proxy.js).
        res.on('close', () => {
            if (res.writableFinished) return;
            clientGone = true;
            if (heartbeat) { clearInterval(heartbeat); heartbeat = null; }
            if (currentChild && currentChild.exitCode === null && currentChild.signalCode === null) {
                try { process.kill(-currentChild.pid, 'SIGKILL'); } catch (e) {}
            }
            if (queueWaiter) { sem.cancelWaiter(queueWaiter); queueWaiter = null; }
            freeSlot();
        });
        const elapsed = () => ((Date.now() - startedAt) / 1000).toFixed(2);
        const finalLog = (r, outcome) => {
            console.log(`${outcome === 'ok' ? '✓' : '✗'} claude ${outcome} | ${elapsed()}s | tur=${r.turns} | narzędzia=${r.tools.length}${r.tools.length ? ' [' + [...new Set(r.tools)].slice(0, 8).join(',') + ']' : ''} | model=${r.usedModel || model}${r.result && r.result.total_cost_usd != null ? ` | $${r.result.total_cost_usd.toFixed(4)}` : ''}`);
            if (pools) pools.run({ requested: modelName, actual: r.usedModel || model, pool: 'claude', outcome: POOL_OUTCOME[outcome] || 'error', code: Number.isInteger(r.code) ? r.code : null });
        };
        const footer = (r) => `\n\n— model: ${prettyModel(r.usedModel || model, resolved.effort)}`;
        const acq = sem.acquire();

        if (isStream) {
            res.setHeader('Content-Type', 'text/event-stream');
            res.setHeader('Cache-Control', 'no-cache');
            res.setHeader('Connection', 'keep-alive');
            const sendDelta = (content, finish = null) => {
                if (clientGone || res.writableEnded) return;
                res.write(`data: ${JSON.stringify({
                    id: requestId, object: 'chat.completion.chunk', created: createdTime, model: modelName,
                    choices: [{ delta: content == null ? {} : { content }, index: 0, finish_reason: finish }],
                })}\n\n`);
            };
            const sendError = (err) => {
                res.write(`data: ${JSON.stringify({ error: { message: err.msg, type: 'claude_proxy_error', code: err.code, ...(err.status ? { status: err.status } : {}), role, ...(err.resetMs != null ? { resetMs: err.resetMs } : {}) } })}\n\n`);
            };
            const endStream = () => { if (!res.writableEnded) { res.write('data: [DONE]\n\n'); res.end(); } };

            let sentAny = false;
            let fullOut = '';
            let lastVisibleAt = 0;
            let lastShown = null;
            let pending = null;
            const elapsedMin = () => Math.max(1, Math.round((Date.now() - startedAt) / 60000));
            const showStatus = (text) => {
                if (clientGone || res.writableEnded || sentAny) return;
                sendDelta(text);
                lastVisibleAt = Date.now();
            };
            heartbeat = setInterval(() => {
                if (clientGone || res.writableEnded || sentAny) return;
                if (queueWaiter) {
                    if (!lastVisibleAt || Date.now() - lastVisibleAt >= PROGRESS_MAX_GAP_MS) {
                        showStatus(`⏳ [kolejka] czekam na wolny slot claude (pozycja ${sem.position(queueWaiter) + 1})…\n`);
                    } else { sendDelta(null); res.write(`: queued ${elapsed()}s\n\n`); }
                    return;
                }
                if (!lastVisibleAt) showStatus('⏳ Pracuję nad zadaniem, może potrwać kilka minut…\n');
                else if (pending && Date.now() - lastVisibleAt >= STATUS_MIN_GAP_MS) {
                    const label = pending; pending = null; lastShown = label;
                    showStatus(`⏳ [${elapsedMin()} min] ${label}…\n`);
                } else if (Date.now() - lastVisibleAt >= PROGRESS_MAX_GAP_MS) showStatus(`⏳ [${elapsedMin()} min] pracuję nad zadaniem…\n`);
                else { sendDelta(null); res.write(`: keepalive ${elapsed()}s\n\n`); }
            }, HEARTBEAT_MS);

            // Rationed status lines: OpenClaw stacks every visible line, so at
            // most one per STATUS_MIN_GAP_MS; the latest label waits for the window.
            const onStatus = (ev) => {
                let label = null;
                if (ev.type === 'tool') label = `claude → ${ev.label}`;
                else if (ev.type === 'narration') label = `claude: ${ev.text.replace(/\s+/g, ' ').slice(0, 90)}`;
                if (!label || label === lastShown) return;
                if (lastVisibleAt && Date.now() - lastVisibleAt >= STATUS_MIN_GAP_MS) {
                    lastShown = label; pending = null;
                    showStatus(`⏳ [${elapsedMin()} min] ${label}…\n`);
                } else pending = label;
            };

            const attempt = (n) => {
                runClaude({
                    model, effort, role, project, devCtx, system, prompt, pcEnv, onStatus,
                    onChild: (c) => { currentChild = c; },
                    onText: (chunk) => {
                        // First answer text: start content on a fresh line after status ticks.
                        if (!sentAny && lastVisibleAt) chunk = '\n' + chunk;
                        sentAny = true; fullOut += chunk; sendDelta(chunk);
                    },
                }, (r) => {
                    currentChild = null;
                    if (clientGone) { freeSlot(); return; }
                    const err = classify(r, model);
                    if (err && err.retry && !sentAny && n < MAX_ATTEMPTS) {
                        console.log(`↻ claude próba ${n} nieudana (${err.code}) — ponawiam. ${err.msg.slice(0, 200)}`);
                        return attempt(n + 1);
                    }
                    clearInterval(heartbeat);
                    if (err) {
                        console.error(`✗ ${err.msg}`);
                        // Error EVENT, not a content delta: a delta with
                        // finish_reason 'stop' is booked upstream as a success.
                        sendError(err);
                        endStream();
                        finalLog(r, err.code);
                        freeSlot();
                        return;
                    }
                    const note = denialNote(r, role);
                    if (note) console.log(`⚠ ${note}`);
                    if (!isControlSentinel(fullOut.trim())) {
                        if (note) sendDelta(`\n\n⚠️ [proxy] ${note}`);
                        sendDelta(footer(r));
                    }
                    sendDelta(null, 'stop');
                    const usage = formatUsage(r);
                    if (usage.total_tokens > 0) {
                        res.write(`data: ${JSON.stringify({
                            id: requestId, object: 'chat.completion.chunk', created: createdTime, model: modelName,
                            choices: [],
                            usage,
                        })}\n\n`);
                    }
                    endStream();
                    finalLog(r, 'ok');
                    freeSlot();
                });
            };

            if (!acq.ok) {
                clearInterval(heartbeat);
                console.error(`✗ busy — ${sem.active} aktywnych, ${sem.queued} w kolejce`);
                sendError({ msg: `Wszystkie sloty claude zajęte (${sem.active} aktywnych, ${sem.queued} w kolejce) — spróbuj za chwilę.`, code: 'busy' });
                endStream();
                return;
            }
            queueWaiter = acq.waiter || null;
            acq.slot.then((release) => {
                queueWaiter = null;
                if (clientGone) { release(); clearInterval(heartbeat); return; }
                holdSlot(release);
                attempt(1);
            }).catch(() => {
                queueWaiter = null;
                clearInterval(heartbeat);
                if (!clientGone && !res.writableEnded) {
                    sendError({ msg: `Przekroczono limit oczekiwania w kolejce (${Math.round(QUEUE_TIMEOUT_MS / 60000)} min) — spróbuj ponownie.`, code: 'queue_timeout' });
                    endStream();
                }
            });
            return;
        }

        // ---- buffered (non-stream) path ----
        const attempt = (n) => {
            let out = '';
            runClaude({ model, effort, role, project, devCtx, system, prompt, pcEnv, onText: (c) => { out += c; }, onChild: (c) => { currentChild = c; } }, (r) => {
                currentChild = null;
                if (clientGone) { freeSlot(); return; }
                const err = classify(r, model);
                if (err && err.retry && n < MAX_ATTEMPTS) {
                    console.log(`↻ claude próba ${n} nieudana (${err.code}) — ponawiam.`);
                    return attempt(n + 1);
                }
                if (err) {
                    console.error(`✗ ${err.msg}`);
                    if (err.resetMs != null) res.setHeader('Retry-After', String(Math.max(1, Math.ceil(err.resetMs / 1000))));
                    jsonError(err.status || 500, err.msg, err.code, { role, ...(err.resetMs != null ? { resetMs: err.resetMs } : {}) });
                    finalLog(r, err.code);
                    freeSlot();
                    return;
                }
                const trimmed = out.trim();
                const note = denialNote(r, role);
                if (note) console.log(`⚠ ${note}`);
                const content = isControlSentinel(trimmed) ? trimmed : `${trimmed}${note ? `\n\n⚠️ [proxy] ${note}` : ''}${footer(r)}`;
                const usage = formatUsage(r);
                res.setHeader('Content-Type', 'application/json');
                res.end(JSON.stringify({
                    id: requestId, object: 'chat.completion', created: createdTime, model: modelName,
                    choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop', index: 0 }],
                    usage,
                }));
                finalLog(r, 'ok');
                freeSlot();
            });
        };
        if (!acq.ok) {
            res.setHeader('Retry-After', '60');
            return jsonError(429, `Wszystkie sloty claude zajęte (${sem.active} aktywnych, ${sem.queued} w kolejce)`, 'busy');
        }
        queueWaiter = acq.waiter || null;
        acq.slot.then((release) => {
            queueWaiter = null;
            if (clientGone) { release(); return; }
            holdSlot(release);
            attempt(1);
        }).catch(() => {
            queueWaiter = null;
            if (!clientGone && !res.writableEnded) {
                res.setHeader('Retry-After', '60');
                jsonError(503, `Przekroczono limit oczekiwania w kolejce (${Math.round(QUEUE_TIMEOUT_MS / 60000)} min)`, 'queue_timeout');
            }
        });
        } catch (unhandledErr) {
            if (!res.destroyed && !res.writableEnded) {
                console.error(`✗ claude-proxy nieobsłużony błąd zapytania: ${unhandledErr.message}`);
                try {
                    res.statusCode = 500;
                    res.setHeader('Content-Type', 'application/json');
                    res.end(JSON.stringify({ error: { message: `Nieoczekiwany błąd serwera proxy: ${unhandledErr.message}`, type: 'claude_proxy_error', code: 'internal_error' } }));
                } catch (_) {}
            }
        }
    });
});

if (require.main === module) {
    server.listen(PORT, '127.0.0.1', () => {
        console.log(`claude-proxy na http://127.0.0.1:${PORT} | model domyślny=${DEFAULT_MODEL} | rola domyślna=${DEFAULT_ROLE} | sloty=${MAX_CONCURRENT}+${MAX_QUEUE} | mcp=${fs.existsSync(MCP_CONFIG) ? MCP_CONFIG : '(brak)'} | ro-allow=${loadRoAllow().length} | cwd=${WORKDIR}`);
    });
    for (const sig of ['SIGTERM', 'SIGINT']) {
        process.on(sig, () => { server.close(); process.exit(0); });
    }
} else {
    module.exports = {
        server,
        getApprovals,
        _setApprovals,
        getDevWorkspace,
        _setDevWorkspace,
        DEV_BUILTIN_TOOLS,
        DEV_ALLOWED_TOOLS,
        DEV_MCP_CONFIG,
        DEV_GUARD,
        DEV_SANDBOX_MCP,
        devMcpConfig,
        buildDevSystemNote,
        roleArgs,
        withoutPaperclipEnv,
        resolveModel,
    };
}
