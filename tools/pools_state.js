// Pool usage state written by the proxies (DOM-30, plan v2 §1–2).
//
// Each proxy owns one file: ~/.openclaw/state/pools/{cc,agy}.json. Readers
// (tools/pools_read.js) never write. Nothing here may slow down or break a
// request: every entry point is wrapped in try/catch, writes are async and
// coalesced (at most one per WRITE_GAP_MS, one in flight at a time).
//
// Off by default: nothing is written unless ~/.openclaw/state/pools/ENABLED
// exists. The flag is checked on every write, so removing it stops writing
// without a restart; readers then report "nieznane" after STALE (10 min).
//
// What goes into the file is built field by field from validated values
// (sanitize*). Event objects are never copied and no raw text (stderr,
// prompts, session ids) is ever stored.
const fs = require('fs');
const os = require('os');
const path = require('path');

const REAL_HOME = (() => { try { return os.userInfo().homedir; } catch (e) { return os.homedir(); } })();
const STATE_DIR = process.env.POOLS_STATE_DIR || path.join(REAL_HOME, '.openclaw', 'state', 'pools');
const WRITE_GAP_MS = 5000;
const HEARTBEAT_MS = 180000;
const RUNS_MAX = 20;
const VERSION = 1;

// Shared with pools_read.js.
const STATUSES = ['allowed', 'allowed_warning', 'rejected'];
const OUTCOMES = ['ok', 'limit', 'error', 'timeout', 'denied'];
const MODEL_RE = /^[A-Za-z0-9._:/() -]{1,80}$/;     // agy names have spaces and parens: "Claude Opus 5.5 (High)"
const TYPE_RE = /^[a-z0-9_]{1,40}$/;
const POOL_RE = /^[a-z0-9-]{1,30}$/;
// Sanity window for timestamps: not before 2024, not more than 30 days ahead.
const MIN_TS = Date.UTC(2024, 0, 1);
const MAX_AHEAD_MS = 30 * 86400000;

function safeModel(v) { return typeof v === 'string' && MODEL_RE.test(v) ? v : (v == null ? null : 'invalid'); }
function safeType(v) { return typeof v === 'string' && TYPE_RE.test(v) ? v : 'unknown'; }
function safeStatus(v) { return STATUSES.includes(v) ? v : 'unknown'; }
function safeOutcome(v) { return OUTCOMES.includes(v) ? v : 'error'; }
function safeTs(ms, now = Date.now()) {
    return Number.isFinite(ms) && ms >= MIN_TS && ms <= now + MAX_AHEAD_MS ? Math.round(ms) : null;
}
function safeUtil(v) { return Number.isFinite(v) && v >= 0 && v <= 10 ? Math.round(v * 1000) / 1000 : null; }
function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }
function fromIso(s) { const t = typeof s === 'string' ? Date.parse(s) : NaN; return Number.isFinite(t) ? t : null; }

// agy "Resets in 146h19m53s" / "1d 3h" / "1h 5m 30s" / "90s" -> ms; anything
// else -> null. Takes the text after "Resets in".
function parseResetIn(text) {
    if (typeof text !== 'string') return null;
    const m = text.match(/Resets in\s+((?:\d+\s*[dhms]\s*)+)/i);
    if (!m) return null;
    const mult = { d: 86400, h: 3600, m: 60, s: 1 };
    let sec = 0, parts = 0;
    for (const p of m[1].matchAll(/(\d+)\s*([dhms])/gi)) { sec += parseInt(p[1], 10) * mult[p[2].toLowerCase()]; parts++; }
    return parts ? sec * 1000 : null;
}

// agy model display name -> quota pool. Claude and Gemini quotas are separate
// in Antigravity; finer splits (Flash vs Argon) are not confirmed, so each
// family gets its own pool rather than guessing they share one.
function agyPoolFor(agyModel) {
    const s = String(agyModel || '').toLowerCase();
    if (s.startsWith('claude')) return 'claude';
    const g = s.match(/^gemini\s+[\d.]+\s+([a-z]+)/);
    if (g) return `gemini-${g[1]}`;
    if (s.startsWith('gemini')) return 'gemini';
    if (s.startsWith('gpt-oss')) return 'gpt-oss';
    return 'other';
}

function createWriter({ proxy, getLoad, dir = STATE_DIR, now = () => Date.now(), log = (m) => console.error(m) }) {
    if (!['cc', 'agy'].includes(proxy)) throw new Error('proxy must be cc or agy');
    const file = path.join(dir, `${proxy}.json`);
    const flag = path.join(dir, 'ENABLED');
    const startedAt = now();
    const st = { pools: {}, runs: [] };
    let timer = null, writing = false, dirty = false, lastWriteAt = 0, hb = null, lastErr = null;

    const warn = (m) => { if (m !== lastErr) { lastErr = m; try { log(`pools: ${m}`); } catch (e) {} } };
    const enabled = () => { try { return fs.existsSync(flag); } catch (e) { return false; } };
    const pool = (name) => {
        if (!POOL_RE.test(name)) name = 'other';
        if (!st.pools[name]) st.pools[name] = { limits: {}, status: 'unknown', resets_at: null, observed_at: null, message_at: null, last_ok_at: null, overage: false };
        return st.pools[name];
    };

    // Previous state survives a restart; anything that fails validation is dropped.
    try {
        const prev = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (prev && prev.v === VERSION && prev.proxy === proxy) {
            for (const [name, p] of Object.entries(prev.pools || {})) {
                if (!POOL_RE.test(name) || !p) continue;
                const q = pool(name);
                q.status = safeStatus(p.status);
                q.resets_at = safeTs(fromIso(p.resets_at), now());
                q.observed_at = safeTs(fromIso(p.observed_at), now());
                q.message_at = safeTs(fromIso(p.message_at), now());
                q.last_ok_at = safeTs(fromIso(p.last_ok_at), now());
                q.overage = p.overage === true;
                for (const [t, l] of Object.entries(p.limits || {})) {
                    if (!TYPE_RE.test(t) || !l) continue;
                    q.limits[t] = { status: safeStatus(l.status), resets_at: safeTs(fromIso(l.resets_at), now()), utilization: safeUtil(l.utilization), observed_at: safeTs(fromIso(l.observed_at), now()) };
                }
            }
            for (const r of Array.isArray(prev.runs) ? prev.runs.slice(-RUNS_MAX) : []) {
                const at = safeTs(fromIso(r && r.at), now());
                if (at) st.runs.push({ at, requested: safeModel(r.requested), actual: safeModel(r.actual), pool: POOL_RE.test(r.pool) ? r.pool : 'other', outcome: safeOutcome(r.outcome), code: Number.isInteger(r.code) ? r.code : null });
            }
        }
    } catch (e) { /* no file or broken: start empty = "nieznane" */ }

    function serialize() {
        let load = null;
        try { const l = getLoad ? getLoad() : null; if (l && Number.isInteger(l.active) && Number.isInteger(l.queued)) load = { active: l.active, queued: l.queued }; } catch (e) {}
        const pools = {};
        for (const [name, p] of Object.entries(st.pools)) {
            const limits = {};
            for (const [t, l] of Object.entries(p.limits)) limits[t] = { status: l.status, resets_at: iso(l.resets_at), utilization: l.utilization, observed_at: iso(l.observed_at) };
            pools[name] = { status: p.status, resets_at: iso(p.resets_at), observed_at: iso(p.observed_at), message_at: iso(p.message_at), last_ok_at: iso(p.last_ok_at), overage: p.overage, limits };
        }
        const runs = st.runs.map(r => ({ at: iso(r.at), requested: r.requested, actual: r.actual, pool: r.pool, outcome: r.outcome, code: r.code }));
        return { v: VERSION, proxy, updated_at: iso(now()), started_at: iso(startedAt), load, pools, runs };
    }

    async function flush() {
        timer = null;
        if (writing) { dirty = true; return; }
        if (!enabled()) { dirty = false; return; }
        writing = true; dirty = false;
        const tmp = path.join(dir, `.${proxy}.json.tmp-${process.pid}`);
        try {
            await fs.promises.mkdir(dir, { recursive: true, mode: 0o700 });
            await fs.promises.chmod(dir, 0o700);
            await fs.promises.writeFile(tmp, JSON.stringify(serialize(), null, 1) + '\n', { mode: 0o600 });
            await fs.promises.rename(tmp, file);
            lastErr = null;
        } catch (e) {
            warn(`zapis ${file} nieudany: ${e.message}`);
            try { await fs.promises.unlink(tmp); } catch (e2) {}
        } finally {
            writing = false;
            lastWriteAt = now();
            if (dirty) schedule();
        }
    }
    function schedule() {
        try {
            if (timer) return;
            const wait = Math.max(0, lastWriteAt + WRITE_GAP_MS - now());
            timer = setTimeout(() => { flush().catch(e => warn(e.message)); }, wait);
            if (timer.unref) timer.unref();
        } catch (e) { warn(e.message); }
    }
    const guard = (fn) => (...a) => { try { fn(...a); } catch (e) { warn(`${fn.name || 'pools'}: ${e.message}`); } };

    // cc: one `rate_limit_event.rate_limit_info` (schema of CLI 2.1.303:
    // status allowed|allowed_warning|rejected, resetsAt in epoch seconds,
    // utilization as a 0–1 fraction, optional unifiedWindows). A stray
    // rejection the run survives (see QUOTA_GRACE_MS in claude_proxy.js) is
    // cleared by run() when the request ends ok.
    const rateLimit = guard(function rateLimit(info) {
        if (!info || typeof info !== 'object') return;
        const t = now();
        const p = pool('claude');
        const type = info.rateLimitType == null ? 'unknown' : safeType(info.rateLimitType);
        const status = safeStatus(info.status);
        const resetsAt = Number.isFinite(info.resetsAt) ? safeTs(info.resetsAt * 1000, t) : null;
        p.limits[type] = { status, resets_at: resetsAt, utilization: safeUtil(info.utilization), observed_at: t };
        // Per-window usage the CLI attaches from the unified rate-limit headers.
        const w = info.unifiedWindows;
        if (w && typeof w === 'object') {
            for (const k of ['five_hour', 'seven_day', 'seven_day_overage_included']) {
                const x = w[k];
                if (!x || typeof x !== 'object') continue;
                const cur = p.limits[k] || { status: 'unknown' };
                const u = safeUtil(x.utilization);
                const r = Number.isFinite(x.resetsAt) ? safeTs(x.resetsAt * 1000, t) : null;
                p.limits[k] = { status: k === type ? status : cur.status, resets_at: r != null ? r : cur.resets_at || null, utilization: u, observed_at: t };
            }
        }
        if (info.isUsingOverage === true) p.overage = true;
        else if (info.isUsingOverage === false) p.overage = false;
        p.observed_at = t;
        schedule();
    });

    // agy: quota exhaustion seen in glog/stderr. resetMs from the proxy, or
    // parsed here from the message text; message time is when the proxy saw it.
    const quota = guard(function quota(poolName, resetMs, text) {
        const t = now();
        const p = pool(poolName);
        let ms = Number.isFinite(resetMs) && resetMs >= 0 ? resetMs : parseResetIn(text);
        p.status = 'rejected';
        p.message_at = t;
        p.observed_at = t;
        p.resets_at = ms != null ? safeTs(t + ms + 60000, t) : null;
        schedule();
    });

    // End of one request (after the proxy's own retries). Success on a pool
    // clears its exhaustion; cc: generic windows, plus the model's own weekly bucket.
    const run = guard(function run({ requested, actual, pool: poolName, outcome, code }) {
        const t = now();
        const o = safeOutcome(outcome);
        const name = POOL_RE.test(poolName || '') ? poolName : 'other';
        const p = pool(name);
        if (o === 'ok') {
            p.last_ok_at = t;
            p.observed_at = t;
            if (proxy === 'agy') { p.status = 'allowed'; p.resets_at = null; }
            else {
                const fam = String(actual || '').match(/opus|sonnet|fable|haiku/);
                for (const [k, l] of Object.entries(p.limits)) {
                    const specific = /opus|sonnet|fable|haiku/.exec(k);
                    if (l.status === 'rejected' && (!specific || (fam && specific[0] === fam[0]))) { l.status = 'allowed'; l.observed_at = t; }
                }
            }
        }
        st.runs.push({ at: t, requested: safeModel(requested), actual: safeModel(actual), pool: name, outcome: o, code: Number.isInteger(code) ? code : null });
        if (st.runs.length > RUNS_MAX) st.runs.splice(0, st.runs.length - RUNS_MAX);
        schedule();
    });

    // Liveness: updated_at moves even when nothing happens, so readers can tell
    // "quiet" from "proxy dead". First write right after start.
    try {
        hb = setInterval(() => schedule(), HEARTBEAT_MS);
        if (hb.unref) hb.unref();
        schedule();
    } catch (e) {}

    return { rateLimit, quota, run, file, _state: st, _flush: flush, _stop: () => { clearInterval(hb); if (timer) clearTimeout(timer); timer = null; } };
}

module.exports = { createWriter, parseResetIn, agyPoolFor, STATE_DIR, STATUSES, OUTCOMES, MODEL_RE, TYPE_RE, POOL_RE, fromIso };
