'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-mcp-test-'));
process.env.CASES_DEV_DIR = TMP;
process.env.CASES_DEV_NO_SYNC = '1';
const M = require('./cases_mcp.js');
const C = require('./cases_dev.js');

const SHA = 'c'.repeat(40);
async function rpc(method, params, id = 1) {
    let out;
    await M.handle({ jsonrpc: '2.0', id, method, params }, (m) => { out = m; });
    return out;
}
async function call(name, args = {}) {
    const r = await rpc('tools/call', { name, arguments: args });
    const res = r.result;
    const text = res.content[0].text;
    return { isError: res.isError, text, json: res.isError ? null : JSON.parse(text) };
}

test('tools/list: dokładny zestaw, bez narzędzia decyzji', async () => {
    const r = await rpc('tools/list');
    const names = r.result.tools.map(t => t.name).sort();
    assert.deepEqual(names, [
        'case_assign', 'case_create', 'case_diff', 'case_get', 'case_list',
        'case_report', 'case_request_approval', 'case_scan', 'case_set_sha', 'case_stage', 'case_summary',
    ]);
    assert.ok(!names.some(n => /decid|decision|approve|bump|round/i.test(n.replace('case_request_approval', ''))));
    for (const t of r.result.tools) assert.equal(t.inputSchema.type, 'object');
    const r2 = await rpc('tools/call', { name: 'case_decide', arguments: {} });
    assert.ok(r2.error);
});

test('initialize i ping', async () => {
    const i = await rpc('initialize', { protocolVersion: '2025-06-18' });
    assert.equal(i.result.serverInfo.name, 'cases');
    assert.deepEqual((await rpc('ping')).result, {});
    assert.equal((await rpc('nope')).error.code, -32601);
});

test('pełny obieg przez MCP z wstrzykniętym CLEF i workspace', async () => {
    let scanArgs;
    M._setDeps({
        clef: { scanCodeDiff: async (a) => { scanArgs = a; return { verdict: 'ok', reason: 'czysto', p: 0.01 }; } },
        workspace: { inspectDevWorkspace: ({ issueKey }) => ({ rootDir: TMP, repos: { openclaw: { path: TMP } }, issueKey }) },
        getDiff: () => 'diff --git a/x b/x\n+x\n',
    });
    const cr = await call('case_create', { title: 'Test', goal: 'Cel', max_rounds: 2 });
    assert.equal(cr.json.stage, 'new'); assert.equal(cr.json.maxRounds, 2);
    const id = cr.json.id;

    assert.equal((await call('case_stage', { case: id, to: 'coding', note: 'start' })).json.stage, 'coding');
    assert.equal((await call('case_assign', { case: id, agent: 'programista' })).json.assignee, 'programista');
    const rep = await call('case_report', { case: id, text: 'gotowe', sha: SHA });
    assert.equal(rep.json.sha, SHA);
    assert.equal((await call('case_get', { case: id })).json.reports[0].agent, 'main');
    await call('case_stage', { case: id, to: 'review' });

    // zatwierdzenie przed skanem nie przechodzi
    const early = await call('case_request_approval', { case: id, sha: SHA });
    assert.equal(early.isError, true); assert.match(early.text, /clef_required/);

    const sc = await call('case_scan', { case: id, sha: SHA });
    assert.equal(sc.json.clef.verdict, 'ok'); assert.equal(sc.json.clef.sha, SHA);
    assert.equal(scanArgs.runId, `case-${id}-${SHA}`); assert.equal(scanArgs.commitSha, SHA);
    assert.match(scanArgs.task, /Test/); assert.match(scanArgs.diff, /\+x/);

    const ap = await call('case_request_approval', { case: id, sha: SHA });
    assert.equal(ap.json.stage, 'awaiting_approval'); assert.equal(ap.json.approval.status, 'pending');

    const df = await call('case_diff', { case: id, sha: SHA });
    assert.equal(df.isError, false);
    assert.equal(df.json.case, id);
    assert.equal(df.json.sha, SHA);
    assert.match(df.json.diff, /\+x/);

    // z awaiting_approval nie da się wyjść narzędziami
    const st = await call('case_stage', { case: id, to: 'approved' });
    assert.equal(st.isError, true); assert.match(st.text, /bad_transition/);
    assert.equal((await call('case_stage', { case: id, to: 'coding' })).isError, true);

    const list = await call('case_list', {});
    assert.ok(list.json.some(c => c.id === id));
    assert.equal((await call('case_summary')).json.awaiting, 1);
});

test('case_scan: unverified z bypass_reason i bez; brak workspace; zły sha', async () => {
    M._setDeps({
        clef: { scanCodeDiff: async () => ({ verdict: 'unverified', reason: 'no_credentials' }) },
        workspace: { inspectDevWorkspace: () => ({ rootDir: TMP, repos: { openclaw: { path: TMP } } }) },
        getDiff: () => 'd\n+y\n',
    });
    const id = (await call('case_create', { title: 'B', goal: 'g' })).json.id;
    let s = await call('case_scan', { case: id, sha: SHA });
    assert.equal(s.json.clef.verdict, 'unverified'); assert.equal(s.json.clef.bypassReason, undefined);
    s = await call('case_scan', { case: id, sha: SHA, bypass_reason: 'API CLEF leży' });
    assert.equal(s.json.clef.bypassReason, 'API CLEF leży');

    const bad = await call('case_scan', { case: id, sha: 'xyz' });
    assert.equal(bad.isError, true); assert.match(bad.text, /no_sha/);
    const nf = await call('case_scan', { case: 'DEV-777777', sha: SHA });
    assert.match(nf.text, /not_found/);

    M._setDeps({ workspace: { inspectDevWorkspace: () => { throw new Error('Workspace nie istnieje'); } } });
    const nw = await call('case_scan', { case: id, sha: SHA });
    assert.equal(nw.isError, true); assert.match(nw.text, /piaskownicy/);
    M._setDeps({ clef: { scanCodeDiff: async () => { throw new Error('x'); } },
        workspace: { inspectDevWorkspace: () => ({ rootDir: TMP, repos: { openclaw: { path: TMP } } }) } });
    assert.equal((await call('case_scan', { case: id, sha: SHA })).isError, true);
});

test('błędy narzędzi: isError + kod + polski komunikat', async () => {
    const a = await call('case_get', { case: 'DEV-555555' });
    assert.equal(a.isError, true); assert.match(a.text, /^BŁĄD \[not_found\]: Nie ma sprawy/);
    const b = await call('case_get', { case: 'zly' });
    assert.match(b.text, /\[bad_id\]/);
    const c = await call('case_create', { title: '', goal: 'x' });
    assert.match(c.text, /\[bad_input\]/);
    const id = (await call('case_create', { title: 'X', goal: 'y' })).json.id;
    assert.match((await call('case_stage', { case: id, to: 'deployed' })).text, /\[bad_transition\]/);
});

test('max_rounds przez MCP', async () => {
    const id = (await call('case_create', { title: 'R', goal: 'y', max_rounds: 1 })).json.id;
    await call('case_stage', { case: id, to: 'coding' });
    await call('case_stage', { case: id, to: 'testing' });
    const r = await call('case_stage', { case: id, to: 'coding' });
    assert.equal(r.isError, true); assert.match(r.text, /\[max_rounds\]/);
});

test('serwer stdio: obieg JSON-RPC po procesie', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-mcp-proc-'));
    const p = spawn(process.execPath, [path.join(__dirname, 'cases_mcp.js')], { env: { ...process.env, CASES_DEV_DIR: dir, CASES_DEV_NO_SYNC: '1' } });
    let buf = ''; const waiters = new Map();
    p.stdout.on('data', d => {
        buf += d; let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const m = JSON.parse(buf.slice(0, nl)); buf = buf.slice(nl + 1);
            const w = waiters.get(m.id); if (w) { waiters.delete(m.id); w(m); }
        }
    });
    const ask = (id, method, params) => new Promise(res => { waiters.set(id, res); p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n'); });
    try {
        assert.ok((await ask(1, 'initialize', {})).result.capabilities.tools);
        p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
        assert.equal((await ask(2, 'tools/list')).result.tools.length, 11);
        const r = await ask(3, 'tools/call', { name: 'case_create', arguments: { title: 'P', goal: 'g' } });
        assert.equal(JSON.parse(r.result.content[0].text).id, 'DEV-1');
        assert.ok(fs.existsSync(path.join(dir, 'DEV-1.json')));
    } finally { p.kill(); }
});
