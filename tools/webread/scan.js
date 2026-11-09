'use strict';
/**
 * tools/webread/scan.js
 * Kawałkowy skaner tekstu CLEF dla serwera MCP webread.
 *
 * Odpowiada za:
 * - Podział tekstu na nakładające się kawałki (~3000 znaków).
 * - Sprawdzenie fail-closed z góry (plik DISABLED, rezerwa dla clef_guard, sub-cap webread).
 * - Skanowanie każdego kawałka pod kątem prompt injection i hijackingu.
 * - Natychmiastowe przerwanie (fail-closed) przy wykryciu skazy (>= 0.50), błędzie API lub timeout.
 * - Ewidencję zużycia dobowego w ~/.openclaw/state/webread/budget.json.
 * - Opakowanie <external-source url=… clef=ok sha=…> i kryptograficzny podpis HMAC zgodny ze schematem CLEF.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const core = require('../clef_scan_core.js');

const DEFAULT_SUB_CAP = 1500;
const DEFAULT_CHUNK_SIZE = 4000;
const DEFAULT_OVERLAP = 1000;
const DEFAULT_GUARD_RESERVE = 1500;

function realHome() {
    try { return os.userInfo().homedir || os.homedir(); } catch (e) { return os.homedir(); }
}

function getWebreadPaths(customStateDir, customBudgetPath) {
    const home = realHome();
    const stateDir = customStateDir || (customBudgetPath ? path.dirname(customBudgetPath) : (process.env.WEBREAD_STATE_DIR || path.join(home, '.openclaw', 'state', 'webread')));
    const budget = customBudgetPath || path.join(stateDir, 'budget.json');
    const lock = path.join(path.dirname(budget), 'budget.lock');
    return {
        stateDir,
        budget,
        lock,
        disabled: path.join(stateDir, 'DISABLED'),
        quarantineDir: path.join(stateDir, 'quarantine'),
    };
}

function todayKey(nowMs) {
    const d = nowMs ? new Date(nowMs) : new Date();
    return d.toISOString().slice(0, 10);
}

function loadWebreadBudget(budgetPath, nowMs) {
    const day = todayKey(nowMs);
    try {
        if (!fs.existsSync(budgetPath)) {
            return { day, used: 0, scans: 0, calls: 0, reservedScans: 0, reservedNeurons: 0 };
        }
        const raw = fs.readFileSync(budgetPath, 'utf8');
        const data = JSON.parse(raw);
        if (!data || typeof data !== 'object' || Array.isArray(data)) {
            return { error: 'corrupt_budget', corrupt: true };
        }
        if (data.day !== day) {
            return { day, used: 0, scans: 0, calls: 0, reservedScans: 0, reservedNeurons: 0 };
        }
        return {
            day: data.day,
            used: Number.isFinite(data.used) ? data.used : 0,
            scans: Number.isFinite(data.scans) ? data.scans : 0,
            calls: Number.isFinite(data.calls) ? data.calls : 0,
            reservedScans: Number.isFinite(data.reservedScans) ? data.reservedScans : 0,
            reservedNeurons: Number.isFinite(data.reservedNeurons) ? data.reservedNeurons : 0,
        };
    } catch (e) {
        return { error: 'corrupt_budget', corrupt: true };
    }
}

function saveWebreadBudget(budgetPath, budget) {
    try {
        const dir = path.dirname(budgetPath);
        fs.mkdirSync(dir, { recursive: true });
        const tmp = `${budgetPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(budget, null, 2), { mode: 0o600 });
        fs.renameSync(tmp, budgetPath);
    } catch (e) {
        // fail-safe ignore
    }
}

function splitChunks(text, chunkSize = DEFAULT_CHUNK_SIZE, overlap = DEFAULT_OVERLAP) {
    if (text == null) return [];
    const str = String(text);
    if (str.length === 0) return [];
    if (str.length <= chunkSize) return [str];

    const chunks = [];
    const step = Math.max(1, chunkSize - overlap);
    let start = 0;
    while (start < str.length) {
        const end = Math.min(start + chunkSize, str.length);
        chunks.push(str.slice(start, end));
        if (end >= str.length) break;
        start += step;
    }
    return chunks;
}

function wrap(text, url) {
    const rawUrl = String(url || '').replace(/[\r\n"<>]/g, '');
    const str = String(text == null ? '' : text);
    const sha = crypto.createHash('sha256').update(str, 'utf8').digest('hex');
    return `<external-source url="${rawUrl}" clef="ok" sha="${sha}">\n${str}\n</external-source>`;
}

function sign(text, url, options = {}) {
    const wrapped = wrap(text, url);
    const key = options.key || core.loadKey(options.keyFile);
    if (!key) throw new Error('clef key missing');
    const n = core.norm(wrapped);
    const hmac = core.hmacHex(key, n);
    return `${n}\n\n<!-- clef:ok:${hmac} -->`;
}

function verify(stampedText, options = {}) {
    const key = options.key || core.loadKey(options.keyFile);
    if (!key) return { ok: false, reason: 'missing_key' };

    // Najpierw weryfikujemy sygnaturę HMAC
    const n = core.norm(stampedText);
    const m = n.match(/<!-- clef:ok:([0-9a-fA-F]{64}) -->$/);
    if (!m) return { ok: false, reason: 'missing_stamp' };

    const content = core.norm(n.slice(0, m.index));
    const want = Buffer.from(core.hmacHex(key, content), 'hex');
    const got = Buffer.from(m[1], 'hex');
    if (want.length !== 32 || got.length !== 32 || !crypto.timingSafeEqual(want, got)) {
        return { ok: false, reason: 'bad_hmac' };
    }

    // Następnie weryfikujemy strukturę opakowania <external-source>
    const matchWrapper = content.match(/^<external-source url="([^"]*)" clef="ok" sha="([0-9a-fA-F]{64})">\n?([\s\S]*?)\n?<\/external-source>$/);
    if (!matchWrapper) return { ok: false, reason: 'bad_wrapper' };

    const [, url, sha, text] = matchWrapper;
    if (options.expectedUrl && url !== options.expectedUrl) {
        return { ok: false, reason: 'url_mismatch', url, expectedUrl: options.expectedUrl };
    }
    const expectedSha = crypto.createHash('sha256').update(text, 'utf8').digest('hex');
    if (sha.toLowerCase() !== expectedSha.toLowerCase()) {
        return { ok: false, reason: 'sha_mismatch' };
    }
    return { ok: true, url, sha, text, content };
}

async function scanText(text, options = {}) {
    const {
        clef,
        subCap = (Number.isFinite(options.subCap) ? options.subCap : DEFAULT_SUB_CAP),
        chunkSize = DEFAULT_CHUNK_SIZE,
        overlap = DEFAULT_OVERLAP,
        reserveForGuard = DEFAULT_GUARD_RESERVE,
        now = Date.now,
        budgetPath: customBudgetPath,
        stateDir: customStateDir,
        task = 'External web page content',
        keyFile,
    } = options;

    const paths = getWebreadPaths(customStateDir, customBudgetPath);
    const bPath = customBudgetPath || paths.budget;
    const nowTime = typeof now === 'function' ? now() : (now || Date.now());

    // 1. Sprawdzenie DISABLED (state/webread/DISABLED lub ogólne CLEF)
    if (fs.existsSync(paths.disabled) || core.isDisabled()) {
        return { ok: false, verdict: 'error', reason: 'disabled', scans: 0, chunks: 0 };
    }

    // 2. Podział na kawałki
    if (text == null || String(text).trim().length === 0) {
        return { ok: true, verdict: 'clean', scans: 0, reason: 'empty', chunks: 0 };
    }
    const chunks = splitChunks(text, chunkSize, overlap);
    const totalChunks = chunks.length;

    // 3. Budżet i rezerwacja z góry pod blokadą budget.lock (fail-closed)
    const estNeurons = chunks.reduce((acc, c) => acc + core.estimateNeurons(core.buildState(task, c)), 0);

    let reservedOk = false;
    let upfrontError = null;

    await core.withLock(paths.lock, async () => {
        const b = loadWebreadBudget(bPath, nowTime);
        if (b.corrupt) {
            upfrontError = { ok: false, verdict: 'error', reason: 'corrupted_budget', scans: 0, chunks: totalChunks };
            return;
        }

        // Sprawdzenie limitu sub-cap webread (w neuronach) z uwzględnieniem aktywnych rezerwacji
        const activeNeurons = (b.used || 0) + (b.reservedNeurons || 0);
        const remainingNeurons = Math.max(0, subCap - activeNeurons);
        if (estNeurons > remainingNeurons || activeNeurons >= subCap) {
            upfrontError = { ok: false, verdict: 'error', reason: 'budget', scans: 0, chunks: totalChunks };
            return;
        }

        // Sprawdzenie rezerwy dla clef_guard w łącznym budżecie dziennym (8500)
        const globalStatus = core.budgetStatus();
        if (globalStatus && Number.isFinite(globalStatus.used)) {
            const globalMax = globalStatus.max || core.MAX_DAILY_NEURONS;
            if (globalStatus.used + estNeurons > (globalMax - reserveForGuard)) {
                upfrontError = { ok: false, verdict: 'error', reason: 'budget', scans: 0, chunks: totalChunks };
                return;
            }
        }

        // Rezerwacja zasobów przed wykonaniem skanów
        b.reservedScans = (b.reservedScans || 0) + totalChunks;
        b.reservedNeurons = (b.reservedNeurons || 0) + estNeurons;
        saveWebreadBudget(bPath, b);
        reservedOk = true;
    });

    if (upfrontError) {
        return upfrontError;
    }

    // 4. Skanowanie kolejnych kawałków (poza blokadą, aby zapytania mogły biec równolegle)
    let scansUsed = 0;
    let totalNeuronsUsed = 0;
    let finalVerdict = 'clean';
    let finalReason = null;

    try {
        for (let i = 0; i < totalChunks; i++) {
            const chunk = chunks[i];
            scansUsed++;
            const runId = `webread:${crypto.randomBytes(6).toString('hex')}:${i}`;

            let scanRes;
            try {
                if (clef) {
                    if (typeof clef === 'function') {
                        scanRes = await clef(chunk, { task, index: i, total: totalChunks, runId });
                    } else if (typeof clef.scanChunk === 'function') {
                        scanRes = await clef.scanChunk({ text: chunk, task, runId, tag: 'webread', cap: subCap });
                    } else if (typeof clef.scan === 'function') {
                        scanRes = await clef.scan(chunk, { task, index: i, total: totalChunks, runId });
                    } else {
                        scanRes = { verdict: 'unverified', reason: 'bad_clef_mock' };
                    }
                } else {
                    scanRes = await core.scanChunk({
                        text: chunk,
                        task,
                        runId,
                        tag: 'webread',
                        cap: subCap,
                        keyFile,
                    });
                }
            } catch (err) {
                const isTimeout = err && (err.name === 'AbortError' || err.code === 'ETIMEDOUT' || /timeout/i.test(err.message));
                scanRes = {
                    verdict: 'unverified',
                    reason: isTimeout ? 'timeout' : 'error:' + String(err && err.message || err).slice(0, 80),
                };
            }

            const neuronsThis = (scanRes && Number.isFinite(scanRes.neurons)) ? scanRes.neurons : 35;
            totalNeuronsUsed += neuronsThis;

            // Błąd CLEF lub timeout -> fail-closed 'error'
            if (!scanRes || scanRes.verdict === 'unverified' || scanRes.verdict === 'error') {
                finalVerdict = 'error';
                finalReason = scanRes && scanRes.reason || 'error';
                break;
            }

            // Prompt injection lub hijack (>= 0.50) -> 'rejected'
            const isQuarantine = scanRes.verdict === 'quarantine' || scanRes.verdict === 'rejected';
            const pMax = scanRes.p ? Math.max(scanRes.p.injection || 0, scanRes.p.hijack || 0) : 0;
            if (isQuarantine || pMax >= core.THRESHOLD) {
                finalVerdict = 'rejected';
                finalReason = scanRes.reason || 'flagged';
                break;
            }
        }
    } finally {
        if (reservedOk) {
            await core.withLock(paths.lock, async () => {
                const b = loadWebreadBudget(bPath, nowTime);
                if (!b.corrupt) {
                    b.reservedScans = Math.max(0, (b.reservedScans || 0) - totalChunks);
                    b.reservedNeurons = Math.max(0, (b.reservedNeurons || 0) - estNeurons);
                    if (b.reservedScans === 0) delete b.reservedScans;
                    if (b.reservedNeurons === 0) delete b.reservedNeurons;
                    b.scans += scansUsed;
                    b.used += totalNeuronsUsed;
                    b.calls += 1;
                    saveWebreadBudget(bPath, b);
                }
            });
        }
    }

    if (finalVerdict === 'error') {
        return {
            ok: false,
            verdict: 'error',
            scans: scansUsed,
            reason: finalReason,
            chunks: totalChunks,
        };
    }

    if (finalVerdict === 'rejected') {
        return {
            ok: false,
            verdict: 'rejected',
            scans: scansUsed,
            reason: finalReason,
            chunks: totalChunks,
        };
    }

    return {
        ok: true,
        verdict: 'clean',
        scans: scansUsed,
        chunks: totalChunks,
    };
}

module.exports = {
    scanText,
    splitChunks,
    wrap,
    sign,
    verify,
    loadWebreadBudget,
    saveWebreadBudget,
    getWebreadPaths,
    DEFAULT_SUB_CAP,
    DEFAULT_CHUNK_SIZE,
    DEFAULT_OVERLAP,
    DEFAULT_GUARD_RESERVE,
};
