'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-dev-test-'));
process.env.CASES_DEV_DIR = TMP;
process.env.CASES_DEV_NO_SYNC = '1';
const C = require('./cases_dev.js');
const OWNER_NAME = C.OWNER_NAME || process.env.CASES_OWNER_NAME || 'owner';

const SHA = 'a'.repeat(40);
const SHA2 = 'b'.repeat(40);
const mk = (o = {}) => C.create({ title: 't', goal: 'g', ...o });
const code = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };
// doprowadza sprawę do review z czystym CLEF dla SHA
function toReview(sha = SHA) {
    const c = mk();
    C.setStage(c.id, 'coding'); C.setSha(c.id, sha); C.setStage(c.id, 'review');
    C.setClef(c.id, { verdict: 'ok', sha, reason: 'ok' });
    return c.id;
}
function toAwaiting() {
    const id = toReview();
    C.requestApproval(id, { sha: SHA });
    return id;
}

test('sekwencja identyfikatorów i format', () => {
    const a = mk(), b = mk();
    const na = +a.id.slice(4), nb = +b.id.slice(4);
    assert.equal(nb, na + 1);
    assert.match(a.id, /^DEV-\d+$/);
    assert.equal(a.stage, 'new'); assert.equal(a.type, 'dev'); assert.equal(a.maxRounds, 3);
    assert.deepEqual(a.repos, ['openclaw']);
    assert.equal(C.get(a.id).title, 't');
    assert.equal(C.get('DEV-999999'), null);
    assert.equal(code(() => C.get('../x')), 'bad_id');
    assert.equal(code(() => C.setStage('DEV-999998', 'plan')), 'not_found');
    assert.equal(code(() => C.create({ title: '', goal: 'x' })), 'bad_input');
});

const ALLOWED = {
    new: ['plan', 'coding', 'rejected'], plan: ['coding', 'rejected'], coding: ['testing', 'review', 'rejected'],
    testing: ['coding', 'review', 'rejected'], review: ['coding', 'testing', 'rejected'], changes: ['coding', 'rejected'],
};
// ustawia sprawę w danym etapie bez omijania API
function atStage(stage) {
    const c = mk({ maxRounds: 20 });
    const id = c.id;
    const pth = {
        new: [], plan: ['plan'], coding: ['coding'], testing: ['coding', 'testing'], review: ['coding', 'review'],
    }[stage];
    if (pth) { pth.forEach(s => C.setStage(id, s)); return id; }
    if (stage === 'changes' || stage === 'approved') {
        C.setStage(id, 'coding'); C.setSha(id, SHA); C.setStage(id, 'review'); C.setClef(id, { verdict: 'ok', sha: SHA });
        C.requestApproval(id, { sha: SHA });
        C.recordDecision(id, { decision: stage === 'approved' ? 'approve' : 'changes', sha: SHA, by: 't', via: 'command' });
        return id;
    }
    if (stage === 'deployed') { const i = atStage('approved'); C.setStage(i, 'deployed'); return i; }
    if (stage === 'rejected') { C.setStage(id, 'rejected'); return id; }
    throw new Error(stage);
}

test('dozwolone przejścia setStage', () => {
    for (const [from, tos] of Object.entries(ALLOWED)) {
        for (const to of tos) {
            const id = atStage(from);
            const c = C.setStage(id, to, { by: 'x', note: 'n' });
            assert.equal(c.stage, to, `${from}->${to}`);
            assert.equal(c.history.at(-1).to, to);
        }
    }
    // approved -> deployed / coding / rejected
    assert.equal(C.setStage(atStage('approved'), 'deployed').stage, 'deployed');
    assert.equal(C.setStage(atStage('approved'), 'coding').stage, 'coding');
    assert.equal(C.setStage(atStage('approved'), 'rejected').stage, 'rejected');
});

test('zabronione przejścia setStage', () => {
    const all = C.STAGES;
    for (const from of ['new', 'plan', 'coding', 'testing', 'review', 'changes']) {
        for (const to of all) {
            if ((ALLOWED[from] || []).includes(to)) continue;
            const id = atStage(from);
            assert.equal(code(() => C.setStage(id, to)), 'bad_transition', `${from}->${to}`);
            assert.equal(C.get(id).stage, from);
        }
    }
    for (const closed of ['deployed', 'rejected']) {
        for (const to of all) {
            const id = atStage(closed);
            assert.equal(code(() => C.setStage(id, to)), 'bad_transition', `${closed}->${to}`);
        }
    }
    const ap = atStage('approved');
    for (const to of ['new', 'plan', 'testing', 'review', 'changes', 'approved', 'awaiting_approval']) {
        assert.equal(code(() => C.setStage(ap, to)), 'bad_transition', `approved->${to}`);
    }
    assert.equal(code(() => C.setStage(atStage('new'), 'nonsens')), 'bad_transition');
});

test('setStage nigdy nie wchodzi/wychodzi z awaiting_approval ani do approved', () => {
    const aw = toAwaiting();
    for (const to of C.STAGES) assert.equal(code(() => C.setStage(aw, to)), 'bad_transition', `awaiting->${to}`);
    assert.equal(C.get(aw).stage, 'awaiting_approval');
    for (const from of ['new', 'plan', 'coding', 'testing', 'review', 'changes']) {
        const id = atStage(from);
        assert.equal(code(() => C.setStage(id, 'awaiting_approval')), 'bad_transition');
        assert.equal(code(() => C.setStage(id, 'approved')), 'bad_transition');
    }
});

test('deployed wymaga zgody i zgodności SHA', () => {
    const id = atStage('approved');
    // ręczne zepsucie pliku: SHA sprawy inne niż zatwierdzone
    const f = path.join(TMP, id + '.json');
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    raw.sha = SHA2; fs.writeFileSync(f, JSON.stringify(raw));
    assert.equal(code(() => C.setStage(id, 'deployed')), 'sha_mismatch');
});

test('rundy i max_rounds', () => {
    const c = mk({ maxRounds: 2 });
    C.setStage(c.id, 'coding');
    assert.equal(C.get(c.id).round, 1);
    C.setStage(c.id, 'testing'); assert.equal(C.setStage(c.id, 'coding').round, 2);
    C.setStage(c.id, 'review');
    assert.equal(code(() => C.setStage(c.id, 'coding')), 'max_rounds');
    assert.equal(C.get(c.id).stage, 'review');
    assert.equal(C.get(c.id).round, 2);
    // podniesienie limitu odblokowuje
    C.bumpMaxRounds(c.id, 3, { by: 'op' });
    assert.equal(C.setStage(c.id, 'coding').round, 3);
    assert.equal(code(() => C.bumpMaxRounds(c.id, 0)), 'bad_input');
});

test('requestApproval: warunki wstępne', () => {
    // zły etap
    const n = mk(); C.setSha(n.id, SHA);
    assert.equal(code(() => C.requestApproval(n.id, { sha: SHA })), 'bad_transition');
    // brak/zły sha
    const id = toReview();
    assert.equal(code(() => C.requestApproval(id, {})), 'no_sha');
    assert.equal(code(() => C.requestApproval(id, { sha: 'zzzz' })), 'no_sha');
    // sha różny od sprawy
    assert.equal(code(() => C.requestApproval(id, { sha: SHA2 })), 'sha_mismatch');
    // brak clef
    const c2 = mk(); C.setStage(c2.id, 'coding'); C.setSha(c2.id, SHA); C.setStage(c2.id, 'review');
    assert.equal(code(() => C.requestApproval(c2.id, { sha: SHA })), 'clef_required');
    // clef na innym sha
    C.setClef(c2.id, { verdict: 'ok', sha: SHA2 });
    assert.equal(code(() => C.requestApproval(c2.id, { sha: SHA })), 'sha_mismatch');
    // quarantine
    C.setClef(c2.id, { verdict: 'quarantine', sha: SHA, reason: 'x' });
    assert.equal(code(() => C.requestApproval(c2.id, { sha: SHA })), 'clef_required');
    // unverified bez bypassu
    C.setClef(c2.id, { verdict: 'unverified', sha: SHA, reason: 'no_credentials' });
    assert.equal(code(() => C.requestApproval(c2.id, { sha: SHA })), 'clef_required');
    // unverified z bypassem
    C.setClef(c2.id, { verdict: 'unverified', sha: SHA, reason: 'api', bypassReason: 'awaria API' });
    const r = C.requestApproval(c2.id, { sha: SHA, by: 'main' });
    assert.equal(r.stage, 'awaiting_approval');
    assert.equal(r.approval.status, 'pending'); assert.equal(r.approval.sha, SHA);
    assert.equal(r.clef.bypassReason, 'awaria API');
    // ok
    const o = C.requestApproval(id, { sha: SHA });
    assert.equal(o.stage, 'awaiting_approval');
    // dwa razy nie
    assert.equal(code(() => C.requestApproval(id, { sha: SHA })), 'bad_transition');
});

test('requestApproval z etapu testing', () => {
    const c = mk(); C.setStage(c.id, 'coding'); C.setSha(c.id, SHA); C.setStage(c.id, 'testing');
    C.setClef(c.id, { verdict: 'ok', sha: SHA });
    assert.equal(C.requestApproval(c.id, { sha: SHA }).stage, 'awaiting_approval');
});

test('recordDecision: trzy wyniki', () => {
    let id = toAwaiting();
    let c = C.recordDecision(id, { decision: 'approve', sha: SHA, by: 'telegram:1', via: 'telegram', note: 'ok' });
    assert.equal(c.stage, 'approved'); assert.equal(c.approval.status, 'approved');
    assert.equal(c.approval.decidedBy, 'telegram:1'); assert.equal(c.approval.via, 'telegram'); assert.ok(c.approval.decidedAt);
    assert.equal(C.setStage(id, 'deployed').stage, 'deployed');

    id = toAwaiting();
    c = C.recordDecision(id, { decision: 'reject', sha: SHA, by: 'cmd', via: 'command' });
    assert.equal(c.stage, 'rejected'); assert.equal(c.approval.status, 'rejected');

    id = toAwaiting();
    c = C.recordDecision(id, { decision: 'changes', sha: SHA, by: 'cmd', via: 'command', note: 'popraw X' });
    assert.equal(c.stage, 'changes'); assert.equal(c.approval.status, 'changes');
    const r = c.reports.at(-1);
    assert.equal(r.agent, OWNER_NAME); assert.match(r.text, /popraw X/);
    assert.equal(C.setStage(id, 'coding').stage, 'coding');
});

test('recordDecision: sha_mismatch, not_pending, zła decyzja', () => {
    const id = toAwaiting();
    assert.equal(code(() => C.recordDecision(id, { decision: 'approve', sha: SHA2, by: 'x', via: 'command' })), 'sha_mismatch');
    assert.equal(code(() => C.recordDecision(id, { decision: 'approve', by: 'x', via: 'command' })), 'sha_mismatch');
    assert.equal(C.get(id).stage, 'awaiting_approval');
    assert.equal(code(() => C.recordDecision(id, { decision: 'yolo', sha: SHA })), 'bad_transition');
    C.recordDecision(id, { decision: 'approve', sha: SHA, by: 'x', via: 'command' });
    assert.equal(code(() => C.recordDecision(id, { decision: 'approve', sha: SHA, by: 'x', via: 'command' })), 'not_pending');
    const r = toReview();
    assert.equal(code(() => C.recordDecision(r, { decision: 'approve', sha: SHA, by: 'x', via: 'command' })), 'not_pending');
});

test('zmiana SHA unieważnia zgodę i cofa do review', () => {
    // pending
    let id = toAwaiting();
    let c = C.setSha(id, SHA2);
    assert.equal(c.stage, 'review'); assert.equal(c.approval.status, 'stale');
    assert.equal(code(() => C.recordDecision(id, { decision: 'approve', sha: SHA, by: 'x', via: 'command' })), 'not_pending');
    assert.equal(code(() => C.requestApproval(id, { sha: SHA2 })), 'sha_mismatch'); // clef dla starego sha
    C.setClef(id, { verdict: 'ok', sha: SHA2 });
    assert.equal(C.requestApproval(id, { sha: SHA2 }).approval.sha, SHA2);

    // approved + raport z sha
    id = toAwaiting();
    C.recordDecision(id, { decision: 'approve', sha: SHA, by: 'x', via: 'command' });
    c = C.addReport(id, { agent: 'programista', text: 'poprawka', sha: SHA2 });
    assert.equal(c.stage, 'review'); assert.equal(c.approval.status, 'stale'); assert.equal(c.sha, SHA2);
    assert.equal(code(() => C.setStage(id, 'deployed')), 'bad_transition');

    // ten sam sha nie unieważnia
    id = toAwaiting();
    c = C.setSha(id, SHA);
    assert.equal(c.stage, 'awaiting_approval'); assert.equal(c.approval.status, 'pending');
});

test('setClef z nowym wynikiem unieważnia oczekującą zgodę', () => {
    const id = toAwaiting();
    const c = C.setClef(id, { verdict: 'quarantine', sha: SHA, reason: 'x' });
    assert.equal(c.stage, 'review'); assert.equal(c.approval.status, 'stale');
});

test('raporty: obcinanie, model, assign', () => {
    const c = mk();
    const r = C.addReport(c.id, { agent: 'programista', text: 'x'.repeat(30000), model: 'agy/m' });
    assert.ok(r.reports[0].text.length < 20100); assert.equal(r.reports[0].model, 'agy/m'); assert.equal(r.reports[0].kind, 'report');
    assert.equal(C.assign(c.id, 'tester-kodu').assignee, 'tester-kodu');
    assert.equal(code(() => C.addReport(c.id, { agent: 'a', text: 't', sha: 'nie-sha' })), 'no_sha');
});

test('isDevOpen, list, summary', () => {
    const n = mk();
    assert.equal(C.isDevOpen(n.id).ok, false);
    assert.equal(C.isDevOpen('xx').ok, false);
    assert.equal(C.isDevOpen('DEV-888888').ok, false);
    C.setStage(n.id, 'plan');
    const o = C.isDevOpen(n.id); assert.equal(o.ok, true); assert.equal(o.case.id, n.id);
    for (const st of ['coding', 'testing', 'review', 'changes', 'approved']) assert.equal(C.isDevOpen(atStage(st)).ok, true, st);
    assert.equal(C.isDevOpen(toAwaiting()).ok, false);
    assert.equal(C.isDevOpen(atStage('deployed')).ok, false);
    assert.equal(C.isDevOpen(atStage('rejected')).ok, false);

    const open = C.list({ limit: 1000 });
    assert.ok(open.every(c => !['deployed', 'rejected'].includes(c.stage)));
    assert.ok(C.list({ includeClosed: true, limit: 1000 }).some(c => c.stage === 'deployed'));
    assert.ok(C.list({ stages: ['rejected'], limit: 1000 }).every(c => c.stage === 'rejected'));
    assert.equal(C.list({ limit: 2 }).length, 2);
    const s = C.summary();
    assert.ok(s.awaiting >= 1 && s.active >= 1 && s.deployedToday >= 1);
});

test('blokada: stara blokada po martwym PID jest usuwana', () => {
    const lock = path.join(TMP, '.lock');
    fs.mkdirSync(lock); fs.writeFileSync(path.join(lock, 'pid'), '99999999');
    const old = new Date(Date.now() - 60000); fs.utimesSync(lock, old, old);
    const c = mk();
    assert.ok(c.id);
    assert.ok(!fs.existsSync(lock));
});

test('równoległe zapisy z wielu procesów: unikalne id, brak uszkodzeń', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-conc-'));
    const script = `const C=require(${JSON.stringify(path.join(__dirname, 'cases_dev.js'))});
        const ids=[];for(let i=0;i<8;i++){const c=C.create({title:'p'+process.pid+'-'+i,goal:'g'});C.addReport(c.id,{agent:'a',text:'r'});ids.push(c.id);}
        console.log(JSON.stringify(ids));`;
    const run = () => new Promise((res, rej) => {
        const p = spawn(process.execPath, ['-e', script], { env: { ...process.env, CASES_DEV_DIR: dir, CASES_DEV_NO_SYNC: '1' } });
        let o = '', e = '';
        p.stdout.on('data', d => o += d); p.stderr.on('data', d => e += d);
        p.on('close', k => k === 0 ? res(JSON.parse(o)) : rej(new Error(e)));
    });
    const all = (await Promise.all(Array.from({ length: 6 }, run))).flat();
    assert.equal(all.length, 48);
    assert.equal(new Set(all).size, 48);
    const files = fs.readdirSync(dir).filter(f => /^DEV-\d+\.json$/.test(f));
    assert.equal(files.length, 48);
    for (const f of files) { const j = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); assert.equal(j.reports.length, 1); }
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'seq.json'), 'utf8')).last, 48);
    assert.ok(!fs.existsSync(path.join(dir, '.lock')));
});

test('CLI: show/list/summary/decide', () => {
    const { execFileSync } = require('child_process');
    const env = { ...process.env, CASES_DEV_DIR: TMP, CASES_DEV_NO_SYNC: '1' };
    const id = toAwaiting();
    const run = (...a) => execFileSync(process.execPath, [path.join(__dirname, 'cases_dev.js'), ...a], { env, encoding: 'utf8' });
    assert.equal(JSON.parse(run('show', id)).id, id);
    assert.ok(Array.isArray(JSON.parse(run('list'))));
    assert.ok('awaiting' in JSON.parse(run('summary')));
    assert.throws(() => run('decide', id, 'approve', '--sha', SHA2), /sha_mismatch/);
    const out = JSON.parse(run('decide', id, 'approve', '--sha', SHA, '--note', 'cli'));
    assert.equal(out.stage, 'approved');
    assert.match(out.approval.decidedBy, /^cli:/);
});

// ---- synchronizacja z wstrzykniętym spawnerem ----
test('Workboard + Telegram: argumenty poleceń i przyciski', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-sync-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    process.env.CASES_DEV_NOTIFY_TARGET = 'test-notify-chat';
    const calls = [];
    C._setSpawner(async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[0] === 'gateway' && args[2] === 'workboard.cards.create') return { code: 0, stdout: JSON.stringify({ card: { id: 'card-1', title: 'x', status: 'triage' } }), stderr: '' };
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        const c = C.create({ title: 'Tytuł', goal: 'Cel' });
        await C._idle();
        assert.equal(calls[0].args[2], 'workboard.boards.upsert');
        const cr = calls.find(x => x.args[2] === 'workboard.cards.create');
        const p = JSON.parse(cr.args[cr.args.indexOf('--params') + 1]);
        assert.equal(p.title, `[${c.id}] Tytuł`); assert.equal(p.status, 'triage'); assert.equal(p.boardId, C.BOARD_ID || 'cases');
        assert.ok(p.labels.includes('dev') && p.labels.includes('etap:new'));
        assert.ok(cr.args.includes('--json'));
        assert.equal(C.get(c.id).workboardCardId, 'card-1');

        calls.length = 0;
        C.setStage(c.id, 'coding'); C.assign(c.id, 'programista');
        await C._idle();
        const upd = calls.filter(x => x.args[2] === 'workboard.cards.update');
        const mv = calls.filter(x => x.args[2] === 'workboard.cards.move');
        assert.equal(upd.length, 2); assert.equal(mv.length, 2);
        const mp = JSON.parse(mv[0].args[mv[0].args.indexOf('--params') + 1]);
        assert.deepEqual(mp, { id: 'card-1', status: 'running' });
        assert.equal(calls.filter(x => x.args[2] === 'workboard.cards.create').length, 0);

        calls.length = 0;
        C.addReport(c.id, { agent: 'programista', text: 'zrobione' });
        await C._idle();
        const cm = calls.find(x => x.args[2] === 'workboard.cards.comment');
        assert.match(JSON.parse(cm.args[cm.args.indexOf('--params') + 1]).body, /^programista · .*\n\nzrobione$/);

        // prośba o zgodę -> telegram z przyciskami
        C.setSha(c.id, SHA); C.setStage(c.id, 'review'); C.setClef(c.id, { verdict: 'ok', sha: SHA });
        await C._idle();
        calls.length = 0;
        C.requestApproval(c.id, { sha: SHA });
        await C._idle();
        const mv2 = calls.find(x => x.args[2] === 'workboard.cards.move');
        assert.deepEqual(JSON.parse(mv2.args[mv2.args.indexOf('--params') + 1]), { id: 'card-1', status: 'blocked' });
        const tg = calls.find(x => x.args[0] === 'message');
        assert.deepEqual(tg.args.slice(0, 6), ['message', 'send', '--channel', 'telegram', '--target', 'test-notify-chat']);
        const pres = JSON.parse(tg.args[tg.args.indexOf('--presentation') + 1]);
        const btns = pres.blocks.find(b => b.type === 'buttons').buttons;
        const sha12 = SHA.slice(0, 12);
        assert.deepEqual(btns.map(b => b.value), [`sprawa:${c.id}:approve:${sha12}`, `sprawa:${c.id}:reject:${sha12}`, `sprawa:${c.id}:changes:${sha12}`]);
        assert.equal(btns[0].style, 'success'); assert.equal(btns[1].style, 'danger');
        assert.match(pres.blocks[0].text, /workboard\.local/);
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
        delete process.env.CASES_DEV_NOTIFY_TARGET;
    }
});

test('błąd spawnera: sprawa zapisana, wpis w sync.log', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-synclog-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    C._setSpawner(async () => { throw new Error('boom'); });
    try {
        const c = C.create({ title: 'a', goal: 'b' });
        await C._idle();
        assert.equal(C.get(c.id).workboardCardId, null);
        assert.match(fs.readFileSync(path.join(dir, 'sync.log'), 'utf8'), /boom/);
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('persist workboardCardId nie nadpisuje nowszych danych', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-persist-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    let release;
    const gate = new Promise(r => { release = r; });
    C._setSpawner(async (cmd, args) => {
        if (args[2] === 'workboard.cards.create') { await gate; return { code: 0, stdout: '{"id":"c9","title":"t"}', stderr: '' }; }
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        const c = C.create({ title: 'a', goal: 'b' });
        C.addReport(c.id, { agent: 'x', text: 'między' });   // zmiana w trakcie create
        release();
        await C._idle();
        const f = C.get(c.id);
        assert.equal(f.workboardCardId, 'c9');
        assert.equal(f.reports.length, 1);
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('dowód na karcie po deployed/rejected, tylko raz', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-proof-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    const calls = [];
    let n = 0;
    C._setSpawner(async (cmd, args) => {
        calls.push({ cmd, args });
        if (args[2] === 'workboard.cards.create') return { code: 0, stdout: JSON.stringify({ card: { id: 'card-' + (++n), title: 'x' } }), stderr: '' };
        return { code: 0, stdout: '{}', stderr: '' };
    });
    const proofs = () => calls.filter(x => x.args[2] === 'workboard.cards.proof').map(x => JSON.parse(x.args[x.args.indexOf('--params') + 1]));
    try {
        const id = toAwaiting();
        C.addReport(id, { agent: 'tester-kodu', text: 'PASS  wszystko' });
        C.addReport(id, { agent: 'recenzent', text: 'WERDYKT: OK' });
        C.recordDecision(id, { decision: 'approve', sha: SHA, by: OWNER_NAME, via: 'telegram' });
        await C._idle();
        assert.equal(proofs().length, 0);                    // approved ≠ zamknięta
        C.setStage(id, 'deployed');
        await C._idle();
        const p = proofs();
        assert.deepEqual(p.map(x => x.label), ['Testy: ? · tester-kodu', 'Recenzja: OK · recenzent', 'Skan CLEF: ok', 'Zgoda: zatwierdzona', 'Wdrożono ' + SHA.slice(0, 12)]);
        assert.ok(p.every(x => x.id === C.get(id).workboardCardId));
        assert.deepEqual(p.map(x => x.status), ['unknown', 'passed', 'passed', 'passed', 'passed']);
        assert.match(p[0].note, /^PASS wszystko/);
        assert.match(p[3].note, /przycisk w Telegramie/);
        assert.equal(p[4].url, SHA);
        assert.ok(p.every(x => !/\n/.test(x.note) && x.key === undefined));
        assert.equal(C.get(id).workboardProof.complete, true);
        // kolejna synchronizacja (np. raport po wdrożeniu) nie dubluje dowodu
        C.addReport(id, { agent: 'main', text: 'po' });
        await C._idle();
        assert.equal(proofs().length, 5);

        calls.length = 0;
        const r = toAwaiting();
        C.recordDecision(r, { decision: 'reject', sha: SHA, by: OWNER_NAME, via: 'command' });
        await C._idle();
        const pr = proofs();
        const last = pr[pr.length - 1];
        assert.equal(last.status, 'skipped'); assert.equal(last.label, 'Sprawa odrzucona');
        assert.equal(pr.find(x => x.label.startsWith('Zgoda')).status, 'failed');
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('błąd dodania dowodu: brak znacznika, ponowiony przy następnej synchronizacji', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-proof-err-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    let fail = true, proofCalls = 0;
    C._setSpawner(async (cmd, args) => {
        if (args[2] === 'workboard.cards.create') return { code: 0, stdout: '{"id":"cp","title":"t"}', stderr: '' };
        if (args[2] === 'workboard.cards.proof') { proofCalls++; if (fail) return { code: 1, stdout: '', stderr: 'nope' }; }
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        const id = toAwaiting();
        C.recordDecision(id, { decision: 'reject', sha: SHA, by: OWNER_NAME });
        await C._idle();
        assert.equal(proofCalls, 1);
        assert.notEqual(C.get(id).workboardProof && C.get(id).workboardProof.complete, true);
        assert.match(fs.readFileSync(path.join(dir, 'sync.log'), 'utf8'), /workboard\.cards\.proof/);
        fail = false;
        C.addReport(id, { agent: 'main', text: 'x' });
        await C._idle();
        assert.ok(proofCalls >= 2);
        assert.equal(C.get(id).workboardProof.stage, 'rejected');
        assert.equal(C.get(id).workboardProof.complete, true);
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('częściowy błąd dowodów: ponowienie dopisuje tylko brakujące rekordy', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-proof-part-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    const labels = []; let failOn = 'Skan CLEF: ok';
    C._setSpawner(async (cmd, args) => {
        if (args[2] === 'workboard.cards.create') return { code: 0, stdout: '{"id":"cq","title":"t"}', stderr: '' };
        if (args[2] === 'workboard.cards.proof') {
            const l = JSON.parse(args[args.indexOf('--params') + 1]).label;
            if (l === failOn) return { code: 1, stdout: '', stderr: 'chwilowy błąd' };
            labels.push(l);
        }
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        const id = toAwaiting();
        C.recordDecision(id, { decision: 'approve', sha: SHA, by: OWNER_NAME, via: 'telegram' });
        C.setStage(id, 'deployed');
        await C._idle();
        assert.equal(labels.length, 2);
        failOn = null;
        C.addReport(id, { agent: 'main', text: 'x' });
        await C._idle();
        assert.equal(labels.length, 5);
        assert.equal(new Set(labels).size, 5);
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('rebuild: usuwa starą kartę, zakłada nową, odtwarza komentarze i dowody', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-rebuild-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    const calls = []; let n = 0;
    C._setSpawner(async (cmd, args) => {
        calls.push({ m: args[2], p: JSON.parse(args[args.indexOf('--params') + 1] || '{}') });
        if (args[2] === 'workboard.cards.create') return { code: 0, stdout: JSON.stringify({ card: { id: 'k' + (++n), title: 'x' } }), stderr: '' };
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        const id = toAwaiting();
        C.addReport(id, { agent: 'tester-kodu', text: 'WERDYKT: OK\n\n### Wyniki\n- **PASS** `a.js` [plik](file:///home/x/.worktrees/DEV-1/openclaw/a.js)' });
        C.recordDecision(id, { decision: 'approve', sha: SHA, by: OWNER_NAME, via: 'telegram' });
        C.setStage(id, 'deployed');
        await C._idle();
        const old = C.get(id).workboardCardId;
        calls.length = 0;
        process.env.CASES_DEV_NO_SYNC = '1';
        await C._rebuildCard(id);
        const del = calls.find(x => x.m === 'workboard.cards.delete');
        assert.equal(del.p.id, old);
        const cr = calls.find(x => x.m === 'workboard.cards.create');
        assert.match(cr.p.idempotencyKey, new RegExp('^' + id + ':rebuild:'));
        const nid = C.get(id).workboardCardId;
        assert.notEqual(nid, old);
        const cms = calls.filter(x => x.m === 'workboard.cards.comment');
        assert.equal(cms.length, C.get(id).reports.length);
        const tc = cms.find(x => x.p.body.startsWith('tester-kodu'));
        assert.ok(!/\*\*|`|###|file:\/\//.test(tc.p.body));
        assert.match(tc.p.body, /- PASS a\.js plik/);
        const pf = calls.filter(x => x.m === 'workboard.cards.proof');
        assert.equal(pf.length, 5);
        assert.ok(pf.every(x => x.p.id === nid));
        assert.equal(pf[0].p.label, 'Testy: OK · tester-kodu');
        assert.match(cr.p.notes, /^Etap: wdrożona · runda/);
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('przycięte dowody (limit metadanych karty) -> automatyczna przebudowa z krótszymi komentarzami', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-trim-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    const calls = []; let n = 0; const proofsBy = {};
    C._setSpawner(async (cmd, args) => {
        const m = args[2], p = JSON.parse(args[args.indexOf('--params') + 1] || '{}');
        calls.push({ m, p });
        if (m === 'workboard.cards.create') return { code: 0, stdout: JSON.stringify({ card: { id: 'z' + (++n), title: 'x' } }), stderr: '' };
        if (m === 'workboard.cards.proof') proofsBy[p.id] = (proofsBy[p.id] || 0) + 1;
        if (m === 'workboard.cards.list') {
            // pierwsza karta „traci” dwa dowody, przebudowana ma wszystkie
            const cards = Object.entries(proofsBy).map(([id, k]) => ({ id, metadata: { proof: Array(id === 'z1' ? k - 2 : k).fill({}) } }));
            return { code: 0, stdout: JSON.stringify({ cards }), stderr: '' };
        }
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        const id = toAwaiting();
        for (let i = 0; i < 30; i++) C.addReport(id, { agent: 'programista', text: 'WYNIK: OK\n' + 'x '.repeat(900) });
        C.recordDecision(id, { decision: 'approve', sha: SHA, by: OWNER_NAME, via: 'telegram' });
        C.setStage(id, 'deployed');
        await C._idle();
        assert.equal(calls.filter(x => x.m === 'workboard.cards.delete').length, 1);
        assert.equal(C.get(id).workboardCardId, 'z2');
        const cms = calls.filter(x => x.m === 'workboard.cards.comment' && x.p.id === 'z2');
        assert.equal(cms.length, 30);
        const total = cms.reduce((a, x) => a + Buffer.byteLength(x.p.body), 0);
        assert.ok(total < 14000, 'komentarze w budżecie: ' + total);
        assert.match(cms[0].p.body, /skrócono; pełny raport: cases_dev\.js show DEV-/);
        assert.equal(proofsBy.z2, 5);
        const live = calls.filter(x => x.m === 'workboard.cards.comment' && x.p.id === 'z1');
        assert.ok(live.every(x => x.p.body.length < 1200));
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('kryteria Workboard: błąd gatewaya nie blokuje setStage/addReport, idempotencja resync, ucinanie etykiet i notatek', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-criteria-'));
    const prevDir = process.env.CASES_DEV_DIR;
    process.env.CASES_DEV_DIR = dir; delete process.env.CASES_DEV_NO_SYNC;
    const calls = [];
    let shouldFail = false;
    C._setSpawner(async (cmd, args) => {
        const m = args[2], p = JSON.parse(args[args.indexOf('--params') + 1] || '{}');
        calls.push({ m, p });
        if (shouldFail) throw new Error('Workboard gateway unavailable');
        if (m === 'workboard.cards.create') return { code: 0, stdout: JSON.stringify({ card: { id: 'card-crit', title: 't' } }), stderr: '' };
        return { code: 0, stdout: '{}', stderr: '' };
    });
    try {
        // 1. Awaria gatewaya nie blokuje setStage ani addReport
        const c = C.create({ title: 'test-crit', goal: 'cel' });
        await C._idle();
        shouldFail = true;
        assert.doesNotThrow(() => C.setStage(c.id, 'plan'));
        assert.doesNotThrow(() => C.addReport(c.id, { agent: 'programista', text: 'raport w trakcie awarii' }));
        await C._idle();
        assert.equal(C.get(c.id).stage, 'plan');
        assert.equal(C.get(c.id).reports.length, 1);
        assert.match(fs.readFileSync(path.join(dir, 'sync.log'), 'utf8'), /Workboard gateway unavailable/);

        // 2. Ucinanie etykiet (120) i notatek (600) w dowodach oraz zwykły tekst
        shouldFail = false;
        const id = toAwaiting();
        const longReport = 'WERDYKT: OK\n\n' + 'bardzo_dluga_tresc_raportu_'.repeat(50);
        C.addReport(id, { agent: 'tester-kodu', text: longReport });
        C.recordDecision(id, { decision: 'approve', sha: SHA, by: OWNER_NAME, via: 'telegram', note: 'Zgoda '.repeat(100) });
        C.setStage(id, 'deployed');
        await C._idle();
        const proofs = calls.filter(x => x.m === 'workboard.cards.proof').map(x => x.p);
        assert.equal(proofs.length, 5);
        for (const p of proofs) {
            assert.ok(p.label.length <= 120, `label <= 120: ${p.label.length}`);
            assert.ok(p.note.length <= 600, `note <= 600: ${p.note.length}`);
            assert.ok(!/\n/.test(p.note), 'notatka dowodu bez znaków nowej linii');
        }

        // 3. Idempotencja: wielokrotny resync nie dubluje dowodów
        const countBefore = calls.filter(x => x.m === 'workboard.cards.proof').length;
        C.onChange(C.get(id), { type: 'resync' });
        await C._idle();
        C.onChange(C.get(id), { type: 'resync' });
        await C._idle();
        const countAfter = calls.filter(x => x.m === 'workboard.cards.proof').length;
        assert.equal(countAfter, countBefore, 'dowody nie zostały zduplikowane po resync');
    } finally {
        C._setSpawner(null);
        process.env.CASES_DEV_DIR = prevDir; process.env.CASES_DEV_NO_SYNC = '1';
    }
});

test('verdictOf / wbProofs: werdykt wyłącznie z pierwszej niepustej linii raportu', () => {
    const baseCase = (reports) => ({
        id: 'DEV-1', title: 't', stage: 'deployed', round: 1, maxRounds: 3, sha: SHA,
        reports, approval: { status: 'approved', sha: SHA, via: 'telegram', decidedBy: OWNER_NAME },
    });

    // 1. WERDYKT: DO_POPRAWY z cytatem WERDYKT: OK niżej -> failed
    let proofs = C._wbProofs(baseCase([
        { agent: 'tester-kodu', text: 'WERDYKT: DO_POPRAWY\nPoprzedni raport miał:\nWERDYKT: OK\nWYNIK: OK' },
        { agent: 'recenzent', text: '  ### **WERDYKT: DO_POPRAWY**\nCytat:\nWERDYKT: OK' },
    ]));
    assert.equal(proofs.find(p => p.key === 'tests').status, 'failed');
    assert.equal(proofs.find(p => p.key === 'tests').label, 'Testy: DO_POPRAWY · tester-kodu');
    assert.equal(proofs.find(p => p.key === 'review').status, 'failed');
    assert.equal(proofs.find(p => p.key === 'review').label, 'Recenzja: DO_POPRAWY · recenzent');

    // 2. Raport bez werdyktu w 1. linii, z WERDYKT: OK niżej -> unknown
    proofs = C._wbProofs(baseCase([
        { agent: 'tester-kodu', text: 'Podsumowanie testów:\nWERDYKT: OK' },
        { agent: 'recenzent', text: '\n  Uwagi wstępne\nWERDYKT: OK' },
    ]));
    assert.equal(proofs.find(p => p.key === 'tests').status, 'unknown');
    assert.equal(proofs.find(p => p.key === 'tests').label, 'Testy: ? · tester-kodu');
    assert.equal(proofs.find(p => p.key === 'review').status, 'unknown');
    assert.equal(proofs.find(p => p.key === 'review').label, 'Recenzja: ? · recenzent');

    // 3. Zwykły WERDYKT: OK (także z wiodącymi #, *, spacjami) -> passed
    proofs = C._wbProofs(baseCase([
        { agent: 'tester-kodu', text: 'WERDYKT: OK\nWszystkie testy przeszły.' },
        { agent: 'recenzent', text: '\n  * **WERDYKT: OK**\nBrak uwag.' },
    ]));
    assert.equal(proofs.find(p => p.key === 'tests').status, 'passed');
    assert.equal(proofs.find(p => p.key === 'tests').label, 'Testy: OK · tester-kodu');
    assert.equal(proofs.find(p => p.key === 'review').status, 'passed');
    assert.equal(proofs.find(p => p.key === 'review').label, 'Recenzja: OK · recenzent');

    // 4. WYNIK: OK wykonawcy (oraz w bramce) -> passed
    proofs = C._wbProofs(baseCase([
        { agent: 'tester-kodu', text: 'WYNIK: OK\nTesty wykonano.' },
        { agent: 'wykonawca', text: 'WYNIK: OK\nWdrożono na produkcję.' },
    ]));
    assert.equal(proofs.find(p => p.key === 'tests').status, 'passed');
    assert.equal(proofs.find(p => p.key === 'deploy').status, 'passed');
    assert.match(proofs.find(p => p.key === 'deploy').note, /Wdrożono na produkcję\./);
});

test('plainText: maskowanie ścieżek sekretów (~/.openclaw/secrets, /home/<user>/.openclaw/secrets, $HOME/.openclaw/secrets, ~/.ssh, /home/<user>/.ssh) przed ucinaniem', () => {
    const variants = [
        ['~/.openclaw/secrets/token.json', 'Klucz w ~/.openclaw/secrets/token.json jest tajny'],
        ['/home/user/.openclaw/secrets/api_key.pem', 'Ścieżka /home/user/.openclaw/secrets/api_key.pem w logu'],
        ['$HOME/.openclaw/secrets/db/pass.txt', 'Zmienna $HOME/.openclaw/secrets/db/pass.txt użyta'],
        ['~/.ssh/id_ed25519', 'Klucz SSH ~/.ssh/id_ed25519 odrzucony'],
        ['/home/jan_kowalski/.ssh/authorized_keys', 'Plik /home/jan_kowalski/.ssh/authorized_keys zmieniony'],
    ];

    for (const [secretPath, sample] of variants) {
        const cleaned = C._plainText(sample);
        assert.ok(!cleaned.includes(secretPath), `Ścieżka ${secretPath} powinna zostać zamaskowana w: ${cleaned}`);
        assert.ok(cleaned.includes('[ścieżka sekretu]'), `Brak znacznika [ścieżka sekretu] dla ${secretPath} w: ${cleaned}`);
    }

    // Sprawdzenie maskowania przed ucinaniem w dowodach karty (wbProofs)
    const longPrefix = 'A'.repeat(230) + ' ';
    const reportText = 'WERDYKT: OK\n' + longPrefix + '/home/user/.openclaw/secrets/super_secret_long_filename_token.json';
    const proofs = C._wbProofs({
        id: 'DEV-1', title: 't', stage: 'deployed', round: 1, maxRounds: 3, sha: SHA,
        reports: [{ agent: 'tester-kodu', text: reportText }],
        approval: { status: 'approved', sha: SHA, via: 'telegram', decidedBy: OWNER_NAME },
    });
    const note = proofs.find(p => p.key === 'tests').note;
    assert.ok(!note.includes('.openclaw/secrets'), `Fragment ścieżki sekretu nie może wyciec przy ucinaniu: ${note}`);
    assert.ok(!note.includes('super_secret'), `Nazwa pliku sekretu nie może wyciec: ${note}`);
});
