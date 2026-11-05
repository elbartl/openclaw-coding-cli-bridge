// node --test plugins/clef-decision/test_provider.mjs  (no network)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'clef-dec-'));
process.env.CLEF_STATE_DIR = path.join(tmp, 'state');
process.env.CLEF_ENV_FILE = path.join(tmp, 'cf.env');
fs.writeFileSync(process.env.CLEF_ENV_FILE, 'CF_ACCOUNT_ID=acc123\nCF_API_TOKEN=tok-secret-xyz\n');
const budgetFile = () => path.join(process.env.CLEF_STATE_DIR, 'budget.json');
const readBudget = () => JSON.parse(fs.readFileSync(budgetFile(), 'utf8'));

const { buildClefProvider, translateBatch } = await import('./provider.js');

const BATCH = {
    state: { message: 'Backup na serwer 192.168.0.50 nie powiódł się, bart.win' },
    questions: {
        escalate: { type: 'boolean', instructions: 'Wake the user?', criteria: { true: 'Data loss risk', false: 'Routine' } },
        'route key!': { type: 'choice', criteria: { infra: 'Infra', backup: 'Backup' } },
        urgency: { type: 'score', criteria: ['none', 'some', 'high'] },
    },
};
const OK_BODY = model => ({
    success: true,
    result: {
        model,
        answers: {
            q0: { type: 'noul', noul: 0.91 },
            q1: { type: 'choice', choice: 'backup', probabilities: { infra: 0.2, backup: 0.8 }, confidence: 0.4 },
            q2: { type: 'score', score: 1.7, legend: {}, probabilities: { 0: 0.05, 1: 0.2, 2: 0.75 }, confidence: 0.6 },
        },
        usage: { input_tokens: 400, output_tokens: 0 },
    },
});
const ctx = (over = {}) => ({ model: 'clef', signal: new AbortController().signal, deadlineMonotonicMs: performance.now() + 20000, ...over });
const resp = (status, body, headers = {}) => new Response(JSON.stringify(body), { status, headers });

test('translation: boolean->noul, wire ids, default instructions, anonymized values, labels kept', () => {
    const anon = s => s.replace(/192\.168\.\d+\.\d+/g, 'IP');
    const { body, keys } = translateBatch(BATCH, 'clef-flash', { anonymize: anon });
    assert.equal(body.model, 'clef-flash');
    assert.deepEqual(Object.keys(body.questions), ['q0', 'q1', 'q2']);
    assert.equal(body.questions.q0.type, 'noul');
    assert.equal(body.questions.q1.instructions.length > 0, true);
    assert.deepEqual(Object.keys(body.questions.q1.criteria), ['infra', 'backup']);
    assert.match(body.state.message, /IP/);
    assert.equal(keys[1].key, 'route key!');
});

test('translation rejects unsupported shapes', () => {
    const bad = [
        { state: 'x', questions: {} },
        { state: 'x', questions: { a: { type: 'choice', criteria: { only: 'one' } } } },
        { state: 'x', questions: { a: { type: 'score', criteria: ['a'] } } },
        { state: 'x', questions: { a: { type: 'score', criteria: Array.from({ length: 11 }, (_, i) => String(i)) } } },
        { state: 'x', questions: { a: { type: 'weird' } } },
    ];
    for (const b of bad) {
        let r; try { r = translateBatch(b, 'clef'); } catch (_) { r = null; }
        assert.equal(r, null);
    }
});

test('ok path maps answers back, records usage and settles budget to actual', async () => {
    let sent;
    const p = buildClefProvider({ fetchImpl: async (url, init) => { sent = { url, init }; return resp(200, OK_BODY('clef')); } });
    assert.equal(p.isReady(), true);
    const out = await p.evaluate(BATCH, ctx());
    assert.equal(out.status, 'ok');
    assert.match(sent.url, /accounts\/acc123\/ai\/run\/@cf\/cloudflare\/clef$/);
    assert.ok(!sent.init.body.includes('192.168.0.50'), 'evidence anonymized by default');
    const a = out.result.answers;
    assert.deepEqual(a.escalate, { type: 'boolean', probabilityTrue: 0.91 });
    assert.equal(a['route key!'].choice, 'backup');
    assert.deepEqual(a.urgency.probabilities, [0.05, 0.2, 0.75]);
    assert.equal(out.result.usage.inputTokens, 400);
    const b = readBudget();
    assert.ok(Math.abs(b.ext.decisions.used - 400 * 21.818 / 1000) < 1e-6);
    assert.equal(b.ext.decisions.calls, 1);
});

test('clef-flash is billed at its own (cheaper) rate', async () => {
    const before = readBudget().ext?.decisions?.used || 0;
    const p = buildClefProvider({ fetchImpl: async () => resp(200, OK_BODY('clef-flash')) });
    const out = await p.evaluate(BATCH, ctx({ model: 'clef-flash' }));
    assert.equal(out.status, 'ok');
    const used = readBudget().ext.decisions.used - before;
    assert.ok(Math.abs(used - 400 * 3.455 / 1000) < 1e-6, `flash used ${used}`);
});

test('http errors map to contract reasons', async () => {
    const cases = [[401, 'authentication'], [403, 'authentication'], [429, 'rate-limited'], [422, 'unsupported-input'], [400, 'unsupported-input'], [500, 'transport']];
    for (const [st, reason] of cases) {
        const p = buildClefProvider({ fetchImpl: async () => resp(st, { success: false }, st === 429 ? { 'retry-after': '7' } : {}) });
        const out = await p.evaluate(BATCH, ctx());
        assert.equal(out.status, 'unavailable');
        assert.equal(out.reason, reason, `status ${st}`);
        if (st === 429) assert.equal(out.retryAfterMs, 7000);
    }
});

test('malformed answers -> invalid-response', async () => {
    const bodies = [
        { success: true, result: { answers: {} } },
        { success: true, result: { answers: { ...OK_BODY().result.answers, q1: { type: 'choice', choice: 'nope', probabilities: { infra: 0.5, backup: 0.5 } } } } },
        { success: true, result: { answers: { ...OK_BODY().result.answers, q2: { type: 'score', score: 5, probabilities: { 0: 0.3, 1: 0.3, 2: 0.4 } } } } },
        { success: true, result: { answers: { ...OK_BODY().result.answers, q0: { type: 'noul', noul: 1.5 } } } },
        { success: true, result: { echo: 'tok-secret-xyz', ...OK_BODY().result } },
    ];
    for (const body of bodies) {
        const p = buildClefProvider({ fetchImpl: async () => resp(200, body) });
        const out = await p.evaluate(BATCH, ctx());
        assert.equal(out.reason, 'invalid-response', JSON.stringify(body).slice(0, 80));
    }
});

test('network error -> transport; unknown model -> unsupported-input; no fetch when not admissible', async () => {
    let calls = 0;
    const p = buildClefProvider({ fetchImpl: async () => { calls++; throw new Error('ECONNRESET'); } });
    assert.equal((await p.evaluate(BATCH, ctx())).reason, 'transport');
    assert.equal((await p.evaluate(BATCH, ctx({ model: 'gpt' }))).reason, 'unsupported-input');
    const before = calls;
    const used0 = readBudget().used;
    await assert.rejects(p.evaluate(BATCH, ctx({ isAdmissible: () => false })));
    assert.equal(calls, before, 'no I/O after admission is closed');
    assert.ok(Math.abs(readBudget().used - used0) < 1e-9, 'reservation refunded');
});

test('caller cancellation propagates (rejects)', async () => {
    const ac = new AbortController();
    const p = buildClefProvider({ fetchImpl: (url, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(init.signal.reason))) });
    const pr = p.evaluate(BATCH, ctx({ signal: ac.signal }));
    setTimeout(() => ac.abort(new Error('cancelled')), 20);
    await assert.rejects(pr);
});

test('sub-cap: decisions stop at dailyNeuronCap, total untouched beyond it', async () => {
    const p = buildClefProvider({ getPluginConfig: () => ({ dailyNeuronCap: 0 }), fetchImpl: async () => resp(200, OK_BODY('clef')) });
    const before = readBudget().used;
    const out = await p.evaluate(BATCH, ctx());
    assert.equal(out.reason, 'rate-limited');
    assert.equal(readBudget().used, before);
});

test('global total cap shared with guards is respected', async () => {
    const b = readBudget(); b.used = 8499; fs.writeFileSync(budgetFile(), JSON.stringify(b));
    const p = buildClefProvider({ fetchImpl: async () => resp(200, OK_BODY('clef')) });
    assert.equal((await p.evaluate(BATCH, ctx())).reason, 'rate-limited');
    b.used = 0; fs.writeFileSync(budgetFile(), JSON.stringify(b));
});

test('DISABLED kill switch blocks; missing creds -> not ready', async () => {
    fs.writeFileSync(path.join(process.env.CLEF_STATE_DIR, 'DISABLED'), '');
    const p = buildClefProvider({ fetchImpl: async () => resp(200, OK_BODY('clef')) });
    assert.equal((await p.evaluate(BATCH, ctx())).reason, 'credentials-unavailable');
    fs.unlinkSync(path.join(process.env.CLEF_STATE_DIR, 'DISABLED'));
    const keep = process.env.CLEF_ENV_FILE;
    process.env.CLEF_ENV_FILE = path.join(tmp, 'missing.env');
    assert.equal(p.isReady(), false);
    assert.equal((await p.evaluate(BATCH, ctx())).reason, 'credentials-unavailable');
    process.env.CLEF_ENV_FILE = keep;
});

test('cancellation right after reserve refunds the reservation', async () => {
    const ac = new AbortController();
    let calls = 0;
    const p = buildClefProvider({ fetchImpl: async () => { calls++; return resp(200, OK_BODY('clef')); } });
    const used0 = readBudget().used;
    queueMicrotask(() => ac.abort(new Error('cancel')));
    await assert.rejects(p.evaluate(BATCH, ctx({ signal: ac.signal })));
    assert.equal(calls, 0);
    assert.ok(Math.abs(readBudget().used - used0) < 1e-9);
});

test('__proto__ keys rejected before any spend', async () => {
    const evil = JSON.parse('{"state":"x","questions":{"a":{"type":"choice","criteria":{"__proto__":"p","ok":"o"}}}}');
    const evil2 = JSON.parse('{"state":{"__proto__":{"x":1}},"questions":{"a":{"type":"boolean"}}}');
    const p = buildClefProvider({ fetchImpl: async () => resp(200, OK_BODY('clef')) });
    assert.equal((await p.evaluate(evil, ctx())).reason, 'unsupported-input');
    assert.equal((await p.evaluate(evil2, ctx())).reason, 'unsupported-input');
});

test('model name from response is bounded', async () => {
    const body = OK_BODY('x'.repeat(300));
    const p = buildClefProvider({ fetchImpl: async () => resp(200, body) });
    const out = await p.evaluate(BATCH, ctx());
    assert.equal(out.result.model, 'clef');
});

test('guard reserve/settle: sub-cap keeps guard headroom, rollover, bad args, concurrency', async () => {
    const { createRequire } = await import('node:module');
    const G = createRequire(import.meta.url)('../../tools/clef_guard.js');
    fs.writeFileSync(budgetFile(), JSON.stringify({ day: new Date().toISOString().slice(0, 10), used: 0, calls: 0, runs: [], log: [] }));
    assert.equal((await G.reserveNeurons({ tag: 'd', reserved: 1, cap: NaN })).reason, 'bad_args');
    assert.equal((await G.reserveNeurons({ tag: 'day', reserved: 1, cap: 10 })).reason, 'bad_args');
    // cap above (total - guard reserve) is clamped: 7000 max
    assert.equal((await G.reserveNeurons({ tag: 'd', reserved: 7001, cap: 8500 })).reason, 'budget');
    // concurrency: 20 parallel reserves of 10 under cap 100 -> exactly 10 succeed
    const rs = await Promise.all(Array.from({ length: 20 }, () => G.reserveNeurons({ tag: 'd', reserved: 10, cap: 100 })));
    assert.equal(rs.filter(r => r.ok).length, 10);
    let b = readBudget();
    assert.equal(b.used, 100); assert.equal(b.ext.d.used, 100);
    await G.settleNeurons({ tag: 'd', day: rs[0].day, reserved: 10, actual: 4 });
    b = readBudget(); assert.equal(b.used, 94); assert.equal(b.ext.d.used, 94);
    // settle for another day is ignored
    await G.settleNeurons({ tag: 'd', day: '1999-01-01', reserved: 10, actual: 0 });
    assert.equal(readBudget().used, 94);
    // rollover: yesterday's ext does not count today
    b.day = '2000-01-01'; b.ext.day = '2000-01-01'; fs.writeFileSync(budgetFile(), JSON.stringify(b));
    const r = await G.reserveNeurons({ tag: 'd', reserved: 50, cap: 100 });
    assert.equal(r.ok, true);
    b = readBudget(); assert.equal(b.used, 50); assert.equal(b.ext.d.used, 50); assert.equal(b.ext.day, r.day);
    // corrupt budget: reserve denied, settle does not "heal" it
    fs.writeFileSync(budgetFile(), '{broken');
    assert.equal((await G.reserveNeurons({ tag: 'd', reserved: 1, cap: 100 })).ok, false);
    // like the guards: corrupt file is healed to "today fully spent" (fail safe)
    assert.ok(readBudget().used >= 8500);
    assert.equal((await G.reserveNeurons({ tag: 'd', reserved: 1, cap: 100 })).ok, false);
    fs.writeFileSync(budgetFile(), JSON.stringify({ day: r.day, used: 0, calls: 0, runs: [], log: [] }));
});
