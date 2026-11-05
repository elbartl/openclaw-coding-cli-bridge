// CLEF decision provider (OpenClaw DecisionProviderV1).
// Translation: boolean -> CLEF `noul`, choice -> choice, score -> score.
// Budget: shared with clef_guard (same lock, same 8 500/day total) plus a
// sub-cap for decisions so the security guards always keep headroom.
// Never throws for provider problems; only caller cancellation propagates.
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const GUARD_PATH = process.env.CLEF_GUARD_MODULE || path.resolve(HERE, '../../tools/clef_guard.js');

export const PROVIDER_ID = 'clef';
export const MODELS = new Set(['clef', 'clef-flash']);
export const DEFAULT_CAP = 5000;
export const GUARD_RESERVE = 1500; // neurons/day the security guards always keep
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const BUDGET_TAG = 'decisions';
const HTTP_TIMEOUT_MS = 10000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const MAX_QUESTIONS = 64;
const MAX_CHOICES = 255;
const MIN_LEVELS = 2;
const MAX_LEVELS = 10;
const QUESTION_TOKENS = 40; // rough per-question overhead for the reservation
// Neurons per 1K input tokens (Cloudflare pricing, checked 2026-11-05; output not billed).
export const NEURONS_PER_1K = { clef: 21.818, 'clef-flash': 3.455 };

const DEFAULT_INSTRUCTIONS = {
    boolean: 'Is the statement true for the given state? Answer yes or no.',
    choice: 'Choose the option that best matches the given state.',
    score: 'Rate the given state on the ordered rubric.',
};

let guardCache = null;
function guard() {
    if (!guardCache) guardCache = require(GUARD_PATH);
    return guardCache;
}

const isEntry = v => v === null || typeof v === 'string' || typeof v === 'object';
const nonEmpty = v => v != null && !(typeof v === 'string' && v.trim() === '');

function deepMapStrings(v, fn) {
    if (typeof v === 'string') return fn(v);
    if (Array.isArray(v)) return v.map(x => deepMapStrings(x, fn));
    if (v && typeof v === 'object') {
        const o = {};
        for (const [k, x] of Object.entries(v)) {
            if (FORBIDDEN_KEYS.has(k)) throw new TypeError('forbidden key');
            o[k] = deepMapStrings(x, fn);
        }
        return o;
    }
    return v;
}

// Returns { body, keys } or null for unsupported input.
export function translateBatch(batch, model, { anonymize } = {}) {
    if (!batch || typeof batch !== 'object' || !batch.questions || typeof batch.questions !== 'object') return null;
    const entries = Object.entries(batch.questions);
    if (entries.length < 1 || entries.length > MAX_QUESTIONS) return null;
    const anon = typeof anonymize === 'function' ? (v => deepMapStrings(v, anonymize)) : (v => v);
    const keys = [];
    const questions = {};
    entries.forEach(([key, q], i) => {
        if (!q || typeof q !== 'object' || FORBIDDEN_KEYS.has(key)) throw new TypeError('bad question');
        const wire = `q${i}`;
        const instructions = nonEmpty(q.instructions) ? anon(q.instructions) : DEFAULT_INSTRUCTIONS[q.type];
        if (q.type === 'boolean') {
            const out = { type: 'noul', instructions };
            const c = q.criteria;
            if (c && typeof c === 'object') {
                const crit = {};
                if (nonEmpty(c.true)) crit.true = anon(c.true);
                if (nonEmpty(c.false)) crit.false = anon(c.false);
                if (Object.keys(crit).length) out.criteria = crit;
            }
            questions[wire] = out;
        } else if (q.type === 'choice') {
            const c = q.criteria;
            if (!c || typeof c !== 'object' || Array.isArray(c)) throw new TypeError('bad choice');
            const labels = Object.keys(c);
            if (labels.length < 2 || labels.length > MAX_CHOICES || labels.some(l => !l || FORBIDDEN_KEYS.has(l))) throw new TypeError('bad choice');
            const crit = {};
            for (const l of labels) {
                if (!isEntry(c[l])) throw new TypeError('bad choice');
                crit[l] = anon(c[l]);
            }
            questions[wire] = { type: 'choice', instructions, criteria: crit };
        } else if (q.type === 'score') {
            const c = q.criteria;
            if (!Array.isArray(c) || c.length < MIN_LEVELS || c.length > MAX_LEVELS || !c.every(isEntry)) throw new TypeError('bad score');
            questions[wire] = { type: 'score', instructions, criteria: anon(c) };
        } else {
            throw new TypeError('bad type');
        }
        keys.push({ key, wire, q });
    });
    const state = batch.state === undefined ? null : anon(batch.state);
    return { body: { model, state, questions }, keys };
}

const prob = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1;

// Returns answers object or null when the response does not fit the batch.
export function parseAnswers(keys, result) {
    const ans = result && result.answers;
    if (!ans || typeof ans !== 'object') return null;
    const out = {};
    for (const { key, wire, q } of keys) {
        const a = ans[wire];
        if (!a || typeof a !== 'object') return null;
        if (q.type === 'boolean') {
            if (a.type !== 'noul' || !prob(a.noul)) return null;
            out[key] = { type: 'boolean', probabilityTrue: a.noul };
        } else if (q.type === 'choice') {
            const labels = Object.keys(q.criteria);
            const p = a.probabilities;
            if (a.type !== 'choice' || !p || typeof p !== 'object') return null;
            const probabilities = {};
            for (const l of labels) {
                if (!prob(p[l])) return null;
                probabilities[l] = p[l];
            }
            if (Object.keys(p).length !== labels.length) return null;
            if (!Object.values(probabilities).some(v => v > 0)) return null;
            if (typeof a.choice !== 'string' || !labels.includes(a.choice)) return null;
            const r = { type: 'choice', choice: a.choice, probabilities };
            if (prob(a.confidence)) r.confidence = a.confidence;
            out[key] = r;
        } else {
            const n = q.criteria.length;
            const p = a.probabilities;
            if (a.type !== 'score' || !p || typeof p !== 'object') return null;
            const probabilities = [];
            for (let i = 0; i < n; i++) {
                const v = Array.isArray(p) ? p[i] : p[String(i)];
                if (!prob(v)) return null;
                probabilities.push(v);
            }
            if (!probabilities.some(v => v > 0)) return null;
            if (typeof a.score !== 'number' || !Number.isFinite(a.score) || a.score < 0 || a.score > n - 1) return null;
            const r = { type: 'score', score: a.score, probabilities };
            if (prob(a.confidence)) r.confidence = a.confidence;
            out[key] = r;
        }
    }
    return out;
}

function parseRetryAfterMs(h) {
    if (!h) return undefined;
    const s = Number(h);
    if (Number.isFinite(s) && s >= 0) return Math.round(s * 1000);
    const t = Date.parse(h);
    return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

const unavailable = (reason, extra) => ({ status: 'unavailable', reason, ...(extra || {}) });

async function readJsonBounded(res, signal) {
    const reader = res.body && res.body.getReader ? res.body.getReader() : null;
    if (!reader) return JSON.parse(await res.text());
    const chunks = [];
    let size = 0;
    for (;;) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_RESPONSE_BYTES) { try { await reader.cancel(); } catch (_) {} throw new Error('too large'); }
        chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks.map(c => Buffer.from(c))).toString('utf8'));
}

export function buildClefProvider({ getPluginConfig = () => ({}), fetchImpl } = {}) {
    let readyCache = { at: -Infinity, value: false };
    const doFetch = fetchImpl || ((...a) => fetch(...a));
    const cfg = () => {
        const c = getPluginConfig() || {};
        const max = 8500 - GUARD_RESERVE;
        const cap = Number.isFinite(c.dailyNeuronCap) ? Math.max(0, Math.min(c.dailyNeuronCap, max)) : DEFAULT_CAP;
        return { cap, anonymize: c.anonymize !== false };
    };
    return {
        id: PROVIDER_ID,
        contractVersion: 1,
        // Local, synchronous, network-free: credentials file present and guard not disabled.
        isReady() {
            const now = Date.now();
            if (now - readyCache.at < 30000) return readyCache.value;
            let value = false;
            try { value = !!guard().loadCreds() && !guard().isDisabled(); } catch (_) { value = false; }
            readyCache = { at: now, value };
            return value;
        },
        async evaluate(batch, context) {
            context.signal.throwIfAborted();
            const G = (() => { try { return guard(); } catch (_) { return null; } })();
            if (!G) return unavailable('credentials-unavailable');
            const model = String(context.model || '').trim();
            if (!MODELS.has(model)) return unavailable('unsupported-input');
            const creds = G.loadCreds();
            if (!creds) return unavailable('credentials-unavailable');
            const { cap, anonymize } = cfg();

            let tr;
            try { tr = translateBatch(batch, model, { anonymize: anonymize ? G.anonymize : null }); } catch (_) { tr = null; }
            if (!tr) return unavailable('unsupported-input');
            const bodyText = JSON.stringify(tr.body);

            // Upper estimate (~2.8 bytes/token + per-question overhead), settled to real usage after.
            const estTokens = Buffer.byteLength(bodyText, 'utf8') / 2.8 + 200 + QUESTION_TOKENS * tr.keys.length;
            const reserved = Math.ceil(estTokens * NEURONS_PER_1K[model] / 1000);
            const r = await G.reserveNeurons({ tag: BUDGET_TAG, reserved, cap });
            if (!r || !r.ok) {
                context.signal.throwIfAborted();
                return unavailable(r && r.reason === 'disabled' ? 'credentials-unavailable' : 'rate-limited', r && r.reason === 'budget' ? { retryAfterMs: 60000 } : undefined);
            }

            let actual = 0; // nothing sent yet: refund the whole reservation
            const ac = new AbortController();
            const onAbort = () => ac.abort(context.signal.reason);
            let timer = null;
            try {
                context.signal.throwIfAborted();
                context.signal.addEventListener('abort', onAbort, { once: true });
                const hasDeadline = typeof context.deadlineMonotonicMs === 'number' && Number.isFinite(context.deadlineMonotonicMs);
                const remaining = hasDeadline ? context.deadlineMonotonicMs - performance.now() : HTTP_TIMEOUT_MS;
                const timeoutMs = Math.max(1, Math.min(HTTP_TIMEOUT_MS, remaining));
                timer = setTimeout(() => ac.abort(new Error('timeout')), timeoutMs);
                // Final synchronous admission check right before external I/O (terminal, like the OpenAI reference).
                if ((hasDeadline && remaining <= 0) || (context.isAdmissible && !context.isAdmissible())) {
                    throw new Error('CLEF decision is no longer admitted.');
                }
                actual = null; // from here the request may be billed; unknown cost keeps the reservation
                let res;
                try {
                    res = await doFetch(`https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(creds.account)}/ai/run/@cf/cloudflare/${model}`, {
                        method: 'POST',
                        headers: { Authorization: `Bearer ${creds.token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
                        body: bodyText,
                        signal: ac.signal,
                        redirect: 'error',
                    });
                } catch (fetchErr) {
                    context.signal.throwIfAborted();
                    if (hasDeadline && performance.now() >= context.deadlineMonotonicMs) {
                        return unavailable('deadline');
                    }
                    return unavailable('transport');
                }
                if (!res.ok) {
                    try { await res.body?.cancel(); } catch (_) {}
                    // CF validation errors are not billed.
                    if ([400, 401, 403, 413, 422, 429].includes(res.status)) actual = 0;
                    if (res.status === 401 || res.status === 403) return unavailable('authentication');
                    if (res.status === 429) {
                        const ms = parseRetryAfterMs(res.headers.get('retry-after'));
                        return unavailable('rate-limited', ms === undefined ? undefined : { retryAfterMs: ms });
                    }
                    return unavailable([400, 413, 422].includes(res.status) ? 'unsupported-input' : 'transport');
                }
                let json;
                try { json = await readJsonBounded(res, ac.signal); } catch (_) {
                    context.signal.throwIfAborted();
                    return unavailable('invalid-response');
                }
                context.signal.throwIfAborted();
                if (!json || typeof json !== 'object' || JSON.stringify(json).includes(creds.token)) return unavailable('invalid-response');
                const result = json.result;
                const inTok = result && result.usage && result.usage.input_tokens;
                if (Number.isFinite(inTok) && inTok >= 0) actual = inTok * NEURONS_PER_1K[model] / 1000;
                if (json.success === false) return unavailable('invalid-response');
                const answers = parseAnswers(tr.keys, result);
                if (!answers) return unavailable('invalid-response');
                const out = { model: typeof result.model === 'string' && result.model && result.model.length <= 256 ? result.model : model, answers };
                if (Number.isFinite(inTok)) {
                    const outTok = result.usage.output_tokens;
                    out.usage = { inputTokens: inTok, ...(Number.isFinite(outTok) ? { outputTokens: outTok } : {}) };
                }
                return { status: 'ok', result: out };
            } finally {
                if (timer) clearTimeout(timer);
                context.signal.removeEventListener('abort', onAbort);
                await G.settleNeurons({ tag: BUDGET_TAG, day: r.day, reserved, actual });
            }
        },
    };
}
