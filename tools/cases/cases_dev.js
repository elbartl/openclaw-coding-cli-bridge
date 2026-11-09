#!/usr/bin/env node
// Sprawy DEV: magazyn plikowy + maszyna stanów.
// Jedyny pisarz plików DEV-*.json. CommonJS, bez zależności.
// Zgoda decydenta (approval) jest zapisywana wyłącznie przez recordDecision().
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const ID_RE = /^DEV-\d{1,6}$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const OPEN_FOR_DEV = ['plan', 'coding', 'testing', 'review', 'changes', 'approved'];
const CLOSED = ['deployed', 'rejected'];
const STAGES = ['new', 'plan', 'coding', 'testing', 'review', 'awaiting_approval', 'approved', 'deployed', 'rejected', 'changes'];
const TRANSITIONS = {
    new: ['plan', 'coding', 'rejected'],
    plan: ['coding', 'rejected'],
    coding: ['testing', 'review', 'rejected'],
    testing: ['coding', 'review', 'rejected'],
    review: ['coding', 'testing', 'rejected'],
    changes: ['coding', 'rejected'],
    approved: ['deployed', 'coding', 'rejected'],
};
const ROUND_BUMP_FROM = ['testing', 'review', 'changes', 'approved'];
const MAX_REPORT = 20000;
const LOCK_STALE_MS = 30000;
const LOCK_WAIT_MS = 10000;
const lockWaitMs = () => Number(process.env.CASES_DEV_LOCK_WAIT_MS) || LOCK_WAIT_MS;
const MAX_REPORTS = 200;
const MAX_HISTORY = 1000;
const REPO_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,79}$/;
const SYNC_LOG_MAX = 1024 * 1024;
const clip = (v, n) => String(v == null ? '' : v).slice(0, n);

const OWNER_CHAT = process.env.CASES_DEV_NOTIFY_TARGET || '';
const BOARD_ID = process.env.CASES_DEV_BOARD_ID || 'cases';
const OWNER_NAME = process.env.CASES_OWNER_NAME || 'owner';

const ownerChat = () => (process.env.CASES_DEV_NOTIFY_TARGET !== undefined ? process.env.CASES_DEV_NOTIFY_TARGET : OWNER_CHAT);
const boardId = () => process.env.CASES_DEV_BOARD_ID || BOARD_ID;
const ownerName = () => process.env.CASES_OWNER_NAME || OWNER_NAME;

function err(code, message) {
    const e = new Error(message || code);
    e.code = code;
    return e;
}

// ---------- store ----------
function dir() {
    return process.env.CASES_DEV_DIR || path.join(os.homedir(), '.openclaw', 'state', 'cases', 'dev');
}
function casePath(id) { return path.join(dir(), id + '.json'); }
function checkId(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw err('bad_id', `Nieprawidłowy identyfikator sprawy: ${JSON.stringify(id)} (oczekiwano DEV-n)`);
    return id;
}
function writeAtomic(file, data) {
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}.tmp`;
    fs.writeFileSync(tmp, data, { mode: 0o600 });
    fs.renameSync(tmp, file);
}
function sleepSync(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }
function pidAlive(pid) {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function withLock(fn) {
    const d = dir();
    fs.mkdirSync(d, { recursive: true, mode: 0o700 });
    const lock = path.join(d, '.lock');
    const deadline = Date.now() + lockWaitMs();
    for (;;) {
        try {
            fs.mkdirSync(lock);
            try { fs.writeFileSync(path.join(lock, 'pid'), String(process.pid)); } catch (e) {}
            break;
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            // stara blokada po martwym PID
            let timedOut = false;
            try {
                const st = fs.statSync(lock);
                if (Date.now() - st.mtimeMs > LOCK_STALE_MS) {
                    let raw = '';
                    try { raw = fs.readFileSync(path.join(lock, 'pid'), 'utf8'); } catch (e2) {}
                    if (!pidAlive(parseInt(raw, 10))) {
                        const trash = `${lock}.stale.${process.pid}.${Date.now()}`;
                        let moved = false;
                        try { fs.renameSync(lock, trash); moved = true; } catch (e3) {}
                        if (moved) {
                            // ktoś mógł w międzyczasie zdjąć starą i założyć świeżą blokadę: nie kradniemy cudzej
                            let now2 = '';
                            try { now2 = fs.readFileSync(path.join(trash, 'pid'), 'utf8'); } catch (e4) {}
                            if (now2 !== raw) { try { fs.renameSync(trash, lock); } catch (e5) {} }
                            else { try { fs.rmSync(trash, { recursive: true, force: true }); } catch (e5) {} }
                        }
                        if (Date.now() > deadline) timedOut = true; else continue;
                    }
                }
            } catch (e2) { if (Date.now() > deadline) timedOut = true; else continue; }   // zniknęła w międzyczasie
            if (timedOut || Date.now() > deadline) throw err('locked', 'Magazyn spraw jest zablokowany przez inny proces');
            sleepSync(15 + Math.floor(Math.random() * 25));
        }
    }
    try { return fn(); } finally { try { fs.rmSync(lock, { recursive: true, force: true }); } catch (e) {} }
}

function validCase(c, id) {
    return c && typeof c === 'object' && !Array.isArray(c) && c.id === id && typeof c.stage === 'string'
        && Array.isArray(c.history) && Array.isArray(c.reports);
}
function readCase(id) {
    let raw;
    try { raw = fs.readFileSync(casePath(id), 'utf8'); } catch (e) {
        if (e.code === 'ENOENT') return null;
        throw e;
    }
    let c;
    try { c = JSON.parse(raw); } catch (e) { throw err('corrupt', `Plik sprawy ${id} jest uszkodzony: ${e.message}`); }
    if (!validCase(c, id)) throw err('corrupt', `Plik sprawy ${id} ma nieprawidłową strukturę`);
    return c;
}
function save(c) {
    c.updatedAt = new Date().toISOString();
    writeAtomic(casePath(c.id), JSON.stringify(c, null, 2) + '\n');
}
function mustGet(id) {
    checkId(id);
    const c = readCase(id);
    if (!c) throw err('not_found', `Nie ma sprawy ${id}`);
    return c;
}
const now = () => new Date().toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));

// mutate(c) w blokadzie; zwraca { c, events } lub samo c. Hook po zwolnieniu blokady.
function mutate(id, fn) {
    let events = [];
    const res = withLock(() => {
        const c = mustGet(id);
        const ev = fn(c);
        save(c);
        events = ev ? (Array.isArray(ev) ? ev : [ev]) : [];
        return clone(c);
    });
    for (const e of events) emit(res, e);
    return res;
}
function pushHistory(c, from, to, by, note) {
    c.history.push({ at: now(), from, to, by: clip(by || 'system', 100), note: clip(note, 2000) });
    if (c.history.length > MAX_HISTORY) c.history.splice(1, c.history.length - MAX_HISTORY);
}

// ---------- API ----------
function nextSeq() {
    const f = path.join(dir(), 'seq.json');
    let last = 0;
    try { last = parseInt(JSON.parse(fs.readFileSync(f, 'utf8')).last, 10) || 0; } catch (e) {}
    let n = last + 1;
    while (fs.existsSync(casePath('DEV-' + n))) n++;
    if (n > 999999) throw err('bad_id', 'Wyczerpano numerację spraw DEV');
    writeAtomic(f, JSON.stringify({ last: n }) + '\n');
    return n;
}

function create({ title, goal, repos = ['openclaw'], maxRounds = 3, by = 'main' } = {}) {
    title = String(title || '').trim();
    goal = String(goal || '').trim();
    if (!title) throw err('bad_input', 'Brak tytułu sprawy');
    if (!goal) throw err('bad_input', 'Brak celu sprawy');
    if (!Array.isArray(repos) || !repos.length || repos.length > 10 || repos.some(r => typeof r !== 'string' || !REPO_RE.test(r))) throw err('bad_input', 'repos musi być listą (do 10) prostych nazw repozytoriów');
    maxRounds = Number.isInteger(maxRounds) && maxRounds >= 1 && maxRounds <= 20 ? maxRounds : 3;
    let res;
    withLock(() => {
        const id = 'DEV-' + nextSeq();
        const t = now();
        const c = {
            id, type: 'dev', title: title.slice(0, 180), goal: goal.slice(0, 20000), repos, stage: 'new',
            assignee: null, round: 0, maxRounds, sha: null, clef: null, approval: null,
            reports: [], history: [{ at: t, from: null, to: 'new', by, note: 'utworzona' }],
            workboardCardId: null, createdAt: t, updatedAt: t,
        };
        save(c);
        res = clone(c);
    });
    emit(res, { type: 'created' });
    return res;
}

function get(id) { checkId(id); return readCase(id); }

function listAll() {
    let names = [];
    try { names = fs.readdirSync(dir()); } catch (e) { return []; }
    const out = [];
    for (const n of names) {
        if (!/^DEV-\d{1,6}\.json$/.test(n)) continue;
        try { const c = JSON.parse(fs.readFileSync(path.join(dir(), n), 'utf8')); if (validCase(c, n.slice(0, -5))) out.push(c); } catch (e) {}
    }
    return out;
}
function list({ stages, includeClosed = false, limit = 50 } = {}) {
    let cs = listAll();
    if (Array.isArray(stages) && stages.length) cs = cs.filter(c => stages.includes(c.stage));
    else if (!includeClosed) cs = cs.filter(c => !CLOSED.includes(c.stage));
    cs.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    return cs.slice(0, Math.max(1, limit | 0 || 50));
}

function invalidateApproval(c, by, why) {
    if (!c.approval || (c.approval.status !== 'pending' && c.approval.status !== 'approved')) return false;
    const prev = c.stage;
    c.approval = { ...c.approval, status: 'stale', staleAt: now(), staleReason: why };
    if (prev === 'awaiting_approval' || prev === 'approved') {
        c.stage = 'review';
        pushHistory(c, prev, 'review', by, `zgoda unieważniona: ${why}`);
    }
    return true;
}

function setStage(id, to, { by = 'main', note = '' } = {}) {
    return mutate(id, (c) => {
        const from = c.stage;
        if (!STAGES.includes(to)) throw err('bad_transition', `Nieznany etap: ${to}`);
        if (from === 'awaiting_approval') throw err('bad_transition', 'Z etapu awaiting_approval wychodzi tylko decyzja decydenta (/sprawa lub przycisk)');
        if (to === 'awaiting_approval') throw err('bad_transition', 'Do awaiting_approval wchodzi się tylko przez case_request_approval');
        if (to === 'approved') throw err('bad_transition', 'Etap approved ustawia wyłącznie decyzja decydenta');
        const allowed = TRANSITIONS[from] || [];
        if (!allowed.includes(to)) throw err('bad_transition', `Przejście ${from} → ${to} niedozwolone`);
        if (to === 'deployed') {
            if (!c.approval || c.approval.status !== 'approved') throw err('bad_transition', 'Wdrożenie wymaga zgody (approval.status = approved)');
            if (!c.sha || c.approval.sha !== c.sha) throw err('sha_mismatch', 'SHA sprawy różni się od zatwierdzonego');
        }
        if (to === 'coding') {
            if (ROUND_BUMP_FROM.includes(from)) {
                if (c.round + 1 > c.maxRounds) throw err('max_rounds', `Limit rund (${c.maxRounds}) wyczerpany. Poproś decydenta o zwiększenie limitu.`);
                c.round += 1;
            } else if (c.round < 1) c.round = 1;
            if (from === 'approved' && c.approval && c.approval.status === 'approved') {
                c.approval = { ...c.approval, status: 'stale', staleAt: now(), staleReason: 'powrót do coding' };
            }
        }
        c.stage = to;
        pushHistory(c, from, to, by, note);
        return { type: 'stage', from, to };
    });
}

function assign(id, agent, { by = 'main' } = {}) {
    return mutate(id, (c) => {
        const prev = c.assignee;
        c.assignee = agent ? clip(agent, 100) : null;
        pushHistory(c, c.stage, c.stage, by, `przypisano: ${prev || '-'} → ${c.assignee || '-'}`);
        return { type: 'assign' };
    });
}

function normSha(sha) {
    const s = String(sha || '').trim().toLowerCase();
    return SHA_RE.test(s) ? s : null;
}
function applySha(c, sha, by) {
    if (c.sha === sha) return;
    const old = c.sha;
    c.sha = sha;
    pushHistory(c, c.stage, c.stage, by, `sha: ${old ? old.slice(0, 12) : '-'} → ${sha.slice(0, 12)}`);
    invalidateApproval(c, by, 'zmiana SHA');
}

function addReport(id, { agent, kind = 'report', text, sha, model } = {}) {
    return mutate(id, (c) => {
        text = String(text == null ? '' : text);
        if (text.length > MAX_REPORT) text = text.slice(0, MAX_REPORT) + '\n…[obcięto]';
        const r = { at: now(), agent: clip(agent || 'main', 100), kind: clip(kind || 'report', 40), text };
        const currentOwner = ownerName();
        if (r.agent === currentOwner || r.kind === 'decision') throw err('bad_input', `agent „${currentOwner}” i rodzaj „decision” są zarezerwowane dla decyzji decydenta`);
        if (sha) {
            const s = normSha(sha);
            if (!s) throw err('no_sha', `Nieprawidłowy SHA: ${sha}`);
            if (CLOSED.includes(c.stage)) throw err('bad_transition', `Sprawa jest zamknięta (${c.stage})`);
            r.sha = s;
        }
        if (model) r.model = String(model);
        c.reports.push(r);
        if (c.reports.length > MAX_REPORTS) c.reports.splice(0, c.reports.length - MAX_REPORTS);
        if (r.sha) applySha(c, r.sha, r.agent);
        return { type: 'report', report: r };
    });
}

function setSha(id, sha, { by = 'main' } = {}) {
    const s = normSha(sha);
    if (!s) throw err('no_sha', `Nieprawidłowy SHA (oczekiwano 7–40 znaków hex): ${sha}`);
    return mutate(id, (c) => {
        if (CLOSED.includes(c.stage)) throw err('bad_transition', `Sprawa jest zamknięta (${c.stage})`);
        applySha(c, s, by);
        return { type: 'sha' };
    });
}

function setClef(id, { verdict, sha, reason = '', bypassReason } = {}) {
    if (!['ok', 'quarantine', 'unverified'].includes(verdict)) throw err('bad_input', `Nieprawidłowy werdykt CLEF: ${verdict}`);
    const s = normSha(sha);
    if (!s) throw err('no_sha', 'setClef wymaga prawidłowego SHA');
    const bypass = typeof bypassReason === 'string' ? bypassReason.trim().slice(0, 1000) : '';
    return mutate(id, (c) => {
        if (CLOSED.includes(c.stage)) throw err('bad_transition', `Sprawa jest zamknięta (${c.stage})`);
        c.clef = { verdict, sha: s, at: now(), reason: String(reason || '').slice(0, 1000) };
        if (bypass) c.clef.bypassReason = bypass;
        // nowy wynik niezgodny z oczekującą/udzieloną zgodą ją unieważnia
        if (c.approval && (c.approval.status === 'pending' || c.approval.status === 'approved')) {
            if (!clefAcceptable(c.clef, c.approval.sha)) invalidateApproval(c, 'system', 'zmiana wyniku CLEF');
        }
        pushHistory(c, c.stage, c.stage, 'system', `CLEF ${verdict} dla ${s.slice(0, 12)}`);
        return { type: 'clef' };
    });
}
function clefAcceptable(clef, sha) {
    if (!clef || clef.sha !== sha) return false;
    if (clef.verdict === 'ok') return true;
    return clef.verdict === 'unverified' && !!clef.bypassReason;
}

function requestApproval(id, { sha, by = 'main' } = {}) {
    return mutate(id, (c) => {
        const s = normSha(sha);
        if (!s || s.length !== 40) throw err('no_sha', 'Do prośby o zgodę potrzebny pełny SHA (40 znaków hex)');
        if (c.stage !== 'review' && c.stage !== 'testing') throw err('bad_transition', `Zgodę można zgłosić z etapu review/testing, a sprawa jest w ${c.stage}`);
        if (c.sha && c.sha !== s) throw err('sha_mismatch', `SHA sprawy (${c.sha.slice(0, 12)}) różni się od podanego (${s.slice(0, 12)})`);
        if (!c.clef) throw err('clef_required', 'Brak skanu CLEF (case_scan)');
        if (c.clef.sha !== s) throw err('sha_mismatch', `Skan CLEF dotyczy innego SHA (${c.clef.sha.slice(0, 12)})`);
        if (!clefAcceptable(c.clef, s)) {
            throw err('clef_required', c.clef.verdict === 'unverified'
                ? 'Skan CLEF niezweryfikowany: wymagany ponowny skan albo bypass_reason'
                : `Werdykt CLEF „${c.clef.verdict}” blokuje prośbę o zgodę`);
        }
        const from = c.stage;
        c.sha = s;
        c.approval = { status: 'pending', sha: s, requestedAt: now() };
        c.stage = 'awaiting_approval';
        pushHistory(c, from, 'awaiting_approval', by, `prośba o zgodę dla ${s.slice(0, 12)}`);
        return { type: 'approval_requested', from, to: 'awaiting_approval' };
    });
}

// Wywołuje interfejs decyzyjny (i CLI operatora).
function recordDecision(id, { decision, sha, by, via, note = '' } = {}) {
    if (!['approve', 'reject', 'changes'].includes(decision)) throw err('bad_transition', `Nieznana decyzja: ${decision}`);
    return mutate(id, (c) => {
        if (c.stage !== 'awaiting_approval' || !c.approval || c.approval.status !== 'pending') throw err('not_pending', `Sprawa ${c.id} nie czeka na decyzję`);
        const s = normSha(sha);
        if (!s || s !== c.approval.sha || s !== c.sha) throw err('sha_mismatch', 'Decyzja dotyczy innego SHA niż aktualny (zgoda nieaktualna)');
        const status = { approve: 'approved', reject: 'rejected', changes: 'changes' }[decision];
        const to = { approve: 'approved', reject: 'rejected', changes: 'changes' }[decision];
        c.approval = { ...c.approval, status, decidedAt: now(), decidedBy: by || 'unknown', via: via || 'command', note: String(note || '').slice(0, 2000) };
        c.stage = to;
        pushHistory(c, 'awaiting_approval', to, by || 'unknown', `decyzja: ${decision}${note ? ' — ' + note : ''}`);
        const evs = [{ type: 'decision', decision, from: 'awaiting_approval', to }];
        if (decision === 'changes' && note) {
            const r = { at: now(), agent: ownerName(), kind: 'decision', text: String(note).slice(0, MAX_REPORT) };
            c.reports.push(r);
            if (c.reports.length > MAX_REPORTS) c.reports.splice(0, c.reports.length - MAX_REPORTS);
            evs.push({ type: 'report', report: r });
        }
        return evs;
    });
}

function bumpMaxRounds(id, n, { by = 'operator' } = {}) {
    if (!Number.isInteger(n) || n < 1 || n > 20) throw err('bad_input', 'maxRounds musi być liczbą całkowitą 1–20');
    return mutate(id, (c) => {
        pushHistory(c, c.stage, c.stage, by, `maxRounds: ${c.maxRounds} → ${n}`);
        c.maxRounds = n;
        return { type: 'max_rounds' };
    });
}

function isDevOpen(id) {
    if (typeof id !== 'string' || !ID_RE.test(id)) return { ok: false, reason: `Nieprawidłowy identyfikator sprawy: ${id}` };
    let c;
    try { c = readCase(id); } catch (e) { return { ok: false, reason: `Błąd odczytu sprawy ${id}: ${e.message}` }; }
    if (!c) return { ok: false, reason: `Nie ma sprawy ${id}` };
    if (!OPEN_FOR_DEV.includes(c.stage)) return { ok: false, case: c, reason: `Sprawa ${id} jest na etapie „${c.stage}” (piaskownica niedostępna)` };
    return { ok: true, case: c };
}

function summary() {
    const cs = listAll();
    const day = new Date(); day.setHours(0, 0, 0, 0);
    let awaiting = 0, active = 0, deployedToday = 0;
    for (const c of cs) {
        if (c.stage === 'awaiting_approval') awaiting++;
        if (!CLOSED.includes(c.stage)) active++;
        if (c.stage === 'deployed') {
            const h = [...(c.history || [])].reverse().find(x => x.to === 'deployed');
            if (h && new Date(h.at) >= day) deployedToday++;
        }
    }
    return { awaiting, active, deployedToday };
}

// ---------- synchronizacja Workboard + Telegram (best effort) ----------
const WB_STATUS = { new: 'triage', plan: 'todo', coding: 'running', testing: 'running', changes: 'running', review: 'review', awaiting_approval: 'blocked', approved: 'ready', deployed: 'done', rejected: 'done' };
const OPENCLAW_BIN = () => process.env.OPENCLAW_BIN || 'openclaw';

// Domyślny spawner: odłączony proces, zbiera stdout, timeout. Zwraca Promise<{code,stdout,stderr}>.
function defaultSpawner(cmd, args, { timeoutMs = 15000 } = {}) {
    return new Promise((resolve) => {
        let out = '', er = '', done = false, child;
        const fin = (code) => { if (done) return; done = true; clearTimeout(timer); resolve({ code, stdout: out, stderr: er }); };
        const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {} fin(null); }, timeoutMs);
        try {
            child = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1' } });
        } catch (e) { er = e.message; return fin(-1); }
        child.stdout.on('data', d => { out += d; if (out.length > 200000) out = out.slice(-200000); });
        child.stderr.on('data', d => { er += d; if (er.length > 20000) er = er.slice(-20000); });
        child.on('error', e => { er += e.message; fin(-1); });
        child.on('close', code => fin(code));
        child.unref(); child.stdout.unref(); child.stderr.unref();
    });
}
let spawner = defaultSpawner;
function _setSpawner(fn) { spawner = fn || defaultSpawner; boardReady = false; }

const pending = new Set();       // trwające synchronizacje (dla testów)
const chains = new Map();        // id -> Promise, serializacja w obrębie procesu
let boardReady = false;
function _idle() { return Promise.all([...pending]).then(() => undefined); }

function syncLog(msg) {
    try {
        const f = path.join(dir(), 'sync.log');
        try { if (fs.statSync(f).size > SYNC_LOG_MAX) fs.renameSync(f, f + '.1'); } catch (e) {}
        fs.appendFileSync(f, `${now()} ${msg}\n`);
    } catch (e) {}
}
function shortSha(s) { return s ? String(s).slice(0, 12) : '-'; }

function wbLabels(c) {
    const l = ['dev', `etap:${c.stage}`];
    if (c.assignee) l.push(`agent:${c.assignee}`);
    if (c.stage === 'awaiting_approval') l.push('czeka-na-akceptacje');
    if (c.stage === 'rejected') l.push('odrzucona');
    return l.map(x => x.slice(0, 40)).slice(0, 12);
}
const STAGE_PL = { new: 'nowa', plan: 'plan', coding: 'programowanie', testing: 'testy', changes: 'poprawki', review: 'recenzja', awaiting_approval: 'czeka na zgodę', approved: 'zatwierdzona', deployed: 'wdrożona', rejected: 'odrzucona' };
const APPROVAL_PL = { pending: 'czeka', approved: 'zatwierdzona', rejected: 'odrzucona', changes: 'do poprawy' };
function wbNotes(c) {
    const clef = c.clef ? c.clef.verdict : '-';
    const ap = c.approval ? (APPROVAL_PL[c.approval.status] || c.approval.status) : '-';
    const head = [
        `Etap: ${STAGE_PL[c.stage] || c.stage} · runda ${c.round}/${c.maxRounds}`,
        `Commit: ${shortSha(c.sha)} · CLEF: ${clef} · zgoda: ${ap}`,
    ].join('\n');
    return `${head}\n\nCel:\n${c.goal}`.slice(0, 4000);
}
function wbTitle(c) { return `[${c.id}] ${c.title}`.slice(0, 180); }

async function gw(method, params) {
    const r = await spawner(OPENCLAW_BIN(), ['gateway', 'call', method, '--params', JSON.stringify(params), '--json'], { timeoutMs: 15000 });
    if (r.code !== 0) throw new Error(`${method}: kod ${r.code}: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
    let j = null;
    const s = String(r.stdout || '');
    try { j = JSON.parse(s.slice(s.indexOf('{'))); } catch (e) {}
    return j;
}
function findCardId(j, depth = 0) {
    if (!j || typeof j !== 'object' || depth > 4) return null;
    if (typeof j.id === 'string' && j.id && (j.title !== undefined || j.status !== undefined)) return j.id;
    if (j.card) { const x = findCardId(j.card, depth + 1); if (x) return x; }
    if (typeof j.id === 'string' && j.id) return j.id;
    for (const v of Object.values(j)) { const x = findCardId(v, depth + 1); if (x) return x; }
    return null;
}

async function syncWorkboard(c, event) {
    const status = WB_STATUS[c.stage] || 'todo';
    let cardId = c.workboardCardId;
    if (!cardId) { try { const f = readCase(c.id); cardId = f && f.workboardCardId; } catch (e) {} }
    const fresh = !cardId;
    if (!cardId) {
        if (!boardReady) {
            try { await gw('workboard.boards.upsert', { id: boardId(), name: 'Cases' }); } catch (e) { syncLog(`board upsert: ${e.message}`); }
            boardReady = true;
        }
        const j = await gw('workboard.cards.create', {
            title: wbTitle(c), notes: wbNotes(c), status, labels: wbLabels(c),
            boardId: boardId(), idempotencyKey: event && event.type === 'rebuild' ? `${c.id}:rebuild:${Date.now()}` : c.id,
        });
        cardId = findCardId(j);
        if (!cardId) throw new Error('create: brak id karty w odpowiedzi');
        persistCardId(c.id, cardId);
    }
    // Zawsze aktualizacja + przesunięcie (create jest idempotentne i może zwrócić starą kartę).
    await gw('workboard.cards.update', { id: cardId, title: wbTitle(c), notes: wbNotes(c), labels: wbLabels(c) });
    await gw('workboard.cards.move', { id: cardId, status });
    if (fresh && event && event.type === 'rebuild') {
        const cap = Math.max(250, Math.min(COMMENT_MAX, Math.floor(REBUILD_COMMENTS_BUDGET / Math.max(1, c.reports.length))));
        for (const r of c.reports) await gw('workboard.cards.comment', { id: cardId, body: wbComment(r, c.id, cap) });
    } else if (event && event.type === 'report' && event.report) {
        await gw('workboard.cards.comment', { id: cardId, body: wbComment(event.report, c.id) });
    }
    const added = await addProofOnce(c, cardId);
    if (added && !(event && event.type === 'rebuild')) await ensureProofKept(c, cardId, added);
}

// ---------- prezentacja na karcie ----------
// UI Workboard pokazuje notatkę dowodu jako jeden akapit (bez nowych linii i markdownu),
// więc dowód to kilka krótkich rekordów, po jednym na bramkę, każdy z własnym statusem.
const fmtTime = (iso) => {
    if (!iso) return '';
    try { return new Intl.DateTimeFormat('pl-PL', { timeZone: 'Europe/Warsaw', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }).format(new Date(iso)); }
    catch (e) { return String(iso); }
};
// Markdown raportu agenta -> zwykły tekst (linie zachowane).
function plainText(t) {
    return String(t || '')
        .replace(/(?:~|\$HOME|\/home\/[^/\s`'"]+)\/(?:\.openclaw\/secrets|\.ssh)(?=[/\s`'".,;:!?)]|$)(?:\/[^\s`'")]*[^\s`'".,;:!?)])?\/?/g, '[ścieżka sekretu]')
        .replace(/\[([^\]]*)\]\((?:file:\/\/)?[^)]*\)/g, '$1')
        .replace(/file:\/\/\S+/g, '')
        .replace(/\/home\/[^\s`'")]*?\/\.worktrees\/DEV-\d+\/[^/\s]+\//g, '')
        .replace(/\*\*|__|`/g, '')
        .replace(/^[ \t]*#{1,6}[ \t]*/gm, '')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}
// Werdykt z raportu: pierwsza niepusta linia „WERDYKT:/WYNIK: X”.
function verdictOf(text) {
    const lines = String(text || '').split(/\r?\n/);
    const firstNonEmpty = lines.find(l => l.trim().length > 0) || '';
    const cleaned = firstNonEmpty.replace(/^[ \t#*]+/, '');
    const m = cleaned.match(/^(?:WERDYKT|WYNIK)\s*:\s*\**\s*([A-ZĄĆĘŁŃÓŚŹŻ_]+)/);
    if (!m) return null;
    const w = m[1].toUpperCase();
    if (w === 'OK') return { word: 'OK', status: 'passed' };
    if (/^(ODRZU|FAIL|(?:DO_)?POPRAW|B[ŁL]{1}[ĄA]D|ERROR|NIE)/.test(w)) return { word: w, status: 'failed' };
    return { word: w, status: 'unknown' };
}
// Krótkie streszczenie: bez linii werdyktu i nagłówków, w jednym akapicie, ucięte na słowie.
function digest(text, max = 260) {
    const lines = plainText(text).split('\n')
        .map(l => l.replace(/^\s*(?:[-*•]|\d+\.)\s+/, '').trim())
        .filter(l => l && !/^(WERDYKT|WYNIK)\s*:/i.test(l) && !/^SHA\s*:/i.test(l));
    let s = lines.join(' · ').replace(/:\s·/g, ':').replace(/\s*(?:WERDYKT|WYNIK)\s*:\s*[A-ZĄĆĘŁŃÓŚŹŻ_]+\.?/g, '').replace(/\s+/g, ' ').trim();
    if (s.length > max) s = s.slice(0, max).replace(/\s+\S*$/, '') + '…';
    return s;
}
function lastReport(c, pred) { return [...c.reports].reverse().find(pred) || null; }
function gateRecord(c, key, name, r) {
    if (!r) return { key, status: 'unknown', label: `${name}: brak raportu`, note: 'Brak raportu w sprawie.' };
    let v = verdictOf(r.text);
    // main nie pisze formułki werdyktu; zamknięta jako wdrożona = bramka przeszła
    if (!v && r.agent === 'main' && c.stage === 'deployed') v = { word: 'OK', status: 'passed' };
    if (!v) v = { word: '?', status: 'unknown' };
    return { key, status: v.status, label: `${name}: ${v.word} · ${r.agent}`, note: [digest(r.text), fmtTime(r.at)].filter(Boolean).join(' · ') };
}
function viaPl(a) {
    const via = { telegram: 'przycisk w Telegramie', command: 'komenda /sprawa', cli: 'CLI' }[a.via] || a.via || '?';
    const who = String(a.decidedBy || '');
    const ch = who.includes(':') ? who.split(':')[0] : '';
    return ch && ch !== a.via && ch !== 'telegram' ? `${via} (${ch})` : via;
}
function wbProofs(c) {
    const out = [];
    out.push(gateRecord(c, 'tests', 'Testy', lastReport(c, r => r.agent === 'tester-kodu' || (r.agent === 'main' && r.kind === 'test'))));
    out.push(gateRecord(c, 'review', 'Recenzja', lastReport(c, r => r.agent === 'recenzent' || (r.agent === 'main' && (r.kind === 'review' || /^\s*(Przegląd main|Main po recenzji)/i.test(r.text))))));
    if (c.clef) {
        const k = c.clef;
        const st = k.bypassReason ? 'skipped' : k.verdict === 'ok' ? 'passed' : 'failed';
        const label = k.bypassReason ? 'Skan CLEF: pominięty' : `Skan CLEF: ${k.verdict}`;
        out.push({ key: 'clef', status: st, label, note: [`Commit ${shortSha(k.sha)}`, k.bypassReason ? `powód: ${k.bypassReason}` : (k.reason && k.reason !== 'clean' ? k.reason : 'bez uwag'), fmtTime(k.at)].join(' · ') });
    }
    const a = c.approval;
    if (a && a.status && a.status !== 'pending') {
        out.push({
            key: 'approval', status: a.status === 'approved' ? 'passed' : 'failed',
            label: `Zgoda: ${APPROVAL_PL[a.status] || a.status}`,
            note: [`Commit ${shortSha(a.sha)}`, viaPl(a), fmtTime(a.decidedAt), a.note].filter(Boolean).join(' · '),
        });
    }
    if (c.stage === 'deployed') {
        const w = lastReport(c, r => r.agent === 'wykonawca');
        out.push({ key: 'deploy', status: 'passed', label: `Wdrożono ${shortSha(c.sha)}`, url: c.sha || undefined, note: w ? [digest(w.text), fmtTime(w.at)].join(' · ') : 'Brak raportu wykonawcy.' });
        const live = lastReport(c, r => r.agent === 'main' && (r.kind === 'live-test' || /^\s*Test na żywo/i.test(r.text)));
        if (live) out.push(gateRecord(c, 'live', 'Test na żywo', live));
    } else if (c.stage === 'rejected') {
        out.push({ key: 'rejected', status: 'skipped', label: 'Sprawa odrzucona', note: [a && a.note, fmtTime(a && a.decidedAt)].filter(Boolean).join(' · ') || 'Bez wdrożenia.' });
    }
    return out.map(x => ({ ...x, label: x.label.slice(0, 120), note: String(x.note || '').slice(0, 600) }));
}
// Workboard trzyma metadane karty w 24 KB i przy przepełnieniu wycina najpierw dowody,
// dopiero potem komentarze. Dlatego komentarze mają limit, a przy przebudowie dzielą stały budżet.
const COMMENT_MAX = 1000;
const REBUILD_COMMENTS_BUDGET = 11000;
function wbComment(r, caseId, max = COMMENT_MAX) {
    const head = [r.agent, r.kind && r.kind !== 'report' ? r.kind : '', fmtTime(r.at)].filter(Boolean).join(' · ');
    let body = plainText(r.text) || '(pusty raport)';
    if (body.length > max) {
        body = body.slice(0, max).replace(/\s+\S*$/, '') + `\n… (skrócono; pełny raport: cases_dev.js show ${caseId})`;
    }
    return `${head}\n\n${body}`;
}

// Dowód na karcie zamkniętej sprawy (bez niego Workboard pokazuje „Done card has no proof”).
// Rekordy dopisywane pojedynczo; znacznik workboardProof.done pamięta, które już są (bez dubli po błędzie).
const PROOF_V = 2;
async function addProofOnce(c, cardId) {
    if (!CLOSED.includes(c.stage)) return 0;
    let f = null;
    try { f = readCase(c.id); } catch (e) {}
    const mark = (f && f.workboardProof) || c.workboardProof;
    const done = mark && mark.stage === c.stage && mark.v === PROOF_V && mark.cardId === cardId ? new Set(mark.done || []) : new Set();
    if (mark && mark.stage === c.stage && mark.v === PROOF_V && mark.cardId === cardId && mark.complete) return 0;
    for (const p of wbProofs(c)) {
        if (done.has(p.key)) continue;
        const { key, ...rec } = p;
        await gw('workboard.cards.proof', { id: cardId, ...rec });
        done.add(key);
        saveProofMark(c.id, { stage: c.stage, v: PROOF_V, cardId, done: [...done] });
    }
    saveProofMark(c.id, { stage: c.stage, v: PROOF_V, cardId, done: [...done], complete: true, at: now() });
    return done.size;
}
// Sprawdzenie, czy gateway nie wyciął dowodów przy przycinaniu metadanych; jeśli tak, przebudowa karty.
async function ensureProofKept(c, cardId, expected) {
    let have = null;
    try {
        const j = await gw('workboard.cards.list', { boardId: boardId() });
        const card = ((j && (j.cards || j.items)) || []).find(x => x.id === cardId);
        if (card) have = ((card.metadata && card.metadata.proof) || []).length;
    } catch (e) { syncLog(`${c.id} kontrola dowodów: ${e.message}`); return; }
    if (have === null || have >= expected) return;
    syncLog(`${c.id} karta ma ${have}/${expected} dowodów (przycięte metadane), przebudowa`);
    await rebuildCard(c.id);
}
function saveProofMark(id, mark) {
    withLock(() => {
        const x = readCase(id);
        if (!x) return;
        x.workboardProof = mark;
        save(x);
    });
}

// Przebudowa karty: kasuje starą kartę (dowody są tylko do dopisywania) i odtwarza ją od nowa
// wyłącznie z pliku sprawy (ręczne komentarze dodane w UI Workboard giną).
async function rebuildCard(id) {
    const c = readCase(id);
    if (!c) return;
    if (c.workboardCardId) {
        try { await gw('workboard.cards.delete', { id: c.workboardCardId }); }
        catch (e) { if (!/not.?found|unknown card|404/i.test(e.message)) throw e; }
    }
    withLock(() => {
        const x = readCase(id);
        if (!x) return;
        delete x.workboardCardId; delete x.workboardProof;
        save(x);
    });
    await syncWorkboard(readCase(id), { type: 'rebuild' });
}

// Zapis workboardCardId pod blokadą, bez nadpisywania nowszych danych.
function persistCardId(id, cardId) {
    withLock(() => {
        const c = readCase(id);
        if (!c || c.workboardCardId) return;
        c.workboardCardId = cardId;
        save(c);
    });
}

async function notifyTelegram(c) {
    const target = ownerChat();
    if (!target) {
        syncLog(`${c.id} notify: brak CASES_DEV_NOTIFY_TARGET, pomijam powiadomienie Telegram`);
        return;
    }
    const sha12 = shortSha(c.approval && c.approval.sha || c.sha);
    const lastRev = [...c.reports].reverse().find(r => r.agent === 'recenzent');
    const clef = c.clef ? `${c.clef.verdict}${c.clef.bypassReason ? ' (bypass: ' + c.clef.bypassReason + ')' : ''}` : '-';
    const workboardUrl = process.env.WORKBOARD_URL || 'https://workboard.local';
    const text = [
        `${c.id}: ${c.title}`,
        `SHA: ${sha12} | runda ${c.round}/${c.maxRounds} | CLEF: ${clef}`,
        `Recenzent: ${lastRev ? lastRev.text.replace(/\s+/g, ' ').slice(0, 600) : 'brak'}`,
        workboardUrl,
    ].join('\n');
    const presentation = {
        title: `Zgoda na wdrożenie ${c.id}`, tone: 'warning',
        blocks: [
            { type: 'text', text },
            { type: 'buttons', buttons: [
                { label: '✅ Wdrażaj', value: `sprawa:${c.id}:approve:${sha12}`, style: 'success' },
                { label: '❌ Odrzuć', value: `sprawa:${c.id}:reject:${sha12}`, style: 'danger' },
                { label: '↩️ Popraw', value: `sprawa:${c.id}:changes:${sha12}` },
            ] },
        ],
    };
    const r = await spawner(OPENCLAW_BIN(), ['message', 'send', '--channel', 'telegram', '--target', target, '--presentation', JSON.stringify(presentation)], { timeoutMs: 15000 });
    if (r.code !== 0) throw new Error(`telegram: kod ${r.code}: ${String(r.stderr || r.stdout).trim().slice(-300)}`);
}

// Hook po każdej zmianie; nigdy nie rzuca i nie blokuje.
// Synchronizacja w osobnym, odłączonym procesie: przeżywa zakończenie procesu
// wywołującego (MCP, CLI, wtyczka). Testy z wstrzykniętym spawnerem idą w procesie.
function syncDetached(c, event) {
    const ev = Buffer.from(JSON.stringify(event || {}), 'utf8').toString('base64');
    const child = spawn(process.execPath, [__filename, '_sync', c.id, ev], {
        stdio: 'ignore', detached: true, env: { ...process.env, CASES_DEV_DIR: dir() },
    });
    child.on('error', (e) => syncLog(`${c.id} spawn sync: ${e.message}`));
    child.unref();
}
// Kolejność synchronizacji jednej sprawy między procesami: blokada katalogowa.
async function runSyncChild(id, ev) {
    return withSyncLock(id, async () => {
        const c = readCase(id);
        if (!c) return;
        try { await syncWorkboard(c, ev); } catch (e) { syncLog(`${id} workboard: ${e.message}`); }
        if (ev && ev.type === 'approval_requested') {
            try { await notifyTelegram(c); } catch (e) { syncLog(`${id} notify: ${e.message}`); }
        }
    });
}
async function withSyncLock(id, fn) {
    if (!ID_RE.test(String(id))) return;
    const lock = path.join(dir(), `.sync-${id}.lock`);
    const deadline = Date.now() + 120000;
    for (;;) {
        try { fs.mkdirSync(lock); break; } catch (e) {
            if (e.code !== 'EEXIST') throw e;
            try { if (Date.now() - fs.statSync(lock).mtimeMs > 180000) { fs.rmdirSync(lock); continue; } } catch (_) {}
            if (Date.now() > deadline) { syncLog(`${id} sync: blokada zajęta, pomijam`); return; }
            await new Promise(r => setTimeout(r, 300));
        }
    }
    try { return await fn(); } finally { try { fs.rmdirSync(lock); } catch (e) {} }
}

function onChange(c, event) {
    if (process.env.CASES_DEV_NO_SYNC === '1') return;
    if (spawner === defaultSpawner) return syncDetached(c, event);
    const run = async () => {
        try { await syncWorkboard(c, event); } catch (e) { syncLog(`${c.id} workboard: ${e.message}`); }
        if (event && event.type === 'approval_requested') {
            try { await notifyTelegram(c); } catch (e) { syncLog(`${c.id} notify: ${e.message}`); }
        }
    };
    const prev = chains.get(c.id) || Promise.resolve();
    const p = prev.then(run, run);
    chains.set(c.id, p);
    pending.add(p);
    p.finally(() => { pending.delete(p); if (chains.get(c.id) === p) chains.delete(c.id); });
}
function emit(c, event) { try { onChange(c, event); } catch (e) {} }

module.exports = {
    create, get, list, setStage, assign, addReport, setSha, setClef, requestApproval,
    recordDecision, bumpMaxRounds, isDevOpen, summary, onChange,
    OPEN_FOR_DEV, CLOSED, STAGES, TRANSITIONS, ID_RE,
    _setSpawner, _idle, _dir: dir, dir, _wbProofs: wbProofs, _plainText: plainText, _rebuildCard: rebuildCard,
    OWNER_NAME, BOARD_ID, OWNER_CHAT,
};

// ---------- CLI ----------
if (require.main === module) {
    const [cmd, ...rest] = process.argv.slice(2);
    const out = (o) => console.log(JSON.stringify(o, null, 2));
    const fail = (e) => { console.error(`BŁĄD${e.code ? ' [' + e.code + ']' : ''}: ${e.message}`); process.exit(1); };
    if (cmd === '_sync') {
        let ev = {};
        try { ev = JSON.parse(Buffer.from(rest[1] || '', 'base64').toString('utf8') || '{}'); } catch (e) {}
        runSyncChild(rest[0], ev).catch(e => syncLog(`${rest[0]} sync: ${e.message}`)).finally(() => process.exit(0));
        return;
    }
    try {
        if (cmd === 'list') out(list({ includeClosed: rest.includes('--all') }).map(c => ({ id: c.id, stage: c.stage, round: c.round, title: c.title })));
        else if (cmd === 'show') { const c = get(rest[0]); if (!c) fail(err('not_found', `Nie ma sprawy ${rest[0]}`)); else out(c); }
        else if (cmd === 'summary') out(summary());
        else if (cmd === 'resync') {
            // Ponowna synchronizacja kart (np. uzupełnienie dowodów): resync DEV-n … | --closed
            const ids = rest.includes('--closed') ? listAll().filter(c => CLOSED.includes(c.stage)).map(c => c.id) : rest.filter(x => ID_RE.test(x));
            (async () => { for (const id of ids) await runSyncChild(id, { type: 'resync' }); })()
                .then(() => { out({ resynced: ids }); process.exit(0); }, fail);
        }
        else if (cmd === 'rebuild') {
            // Przebudowa kart: kasuje kartę i odtwarza ją wyłącznie z pliku sprawy (ręczne komentarze z UI Workboard giną): rebuild DEV-n … | --closed
            const ids = rest.includes('--closed') ? listAll().filter(c => CLOSED.includes(c.stage)).map(c => c.id) : rest.filter(x => ID_RE.test(x));
            (async () => {
                const res = {};
                for (const id of ids) {
                    try { await withSyncLock(id, () => rebuildCard(id)); res[id] = readCase(id).workboardCardId || 'brak karty'; }
                    catch (e) { res[id] = 'BŁĄD: ' + e.message; syncLog(`${id} rebuild: ${e.message}`); }
                }
                return res;
            })().then((r) => { out({ rebuilt: r }); process.exit(0); }, fail);
        }
        else if (cmd === 'decide') {
            const [id, decision] = rest;
            const opt = (k) => { const i = rest.indexOf(k); return i >= 0 ? rest[i + 1] : undefined; };
            const c = recordDecision(id, { decision, sha: opt('--sha'), note: opt('--note') || '', by: 'cli:' + os.userInfo().username, via: 'command' });
            out({ id: c.id, stage: c.stage, approval: c.approval });
            _idle().then(() => process.exit(0));
        } else {
            console.error('Użycie: cases_dev.js list [--all] | show DEV-n | summary | resync DEV-n…|--closed | rebuild DEV-n…|--closed (kasuje kartę i odtwarza wyłącznie z pliku sprawy; ręczne komentarze z UI Workboard giną) | decide DEV-n approve|reject|changes --sha <sha> [--note …]');
            process.exit(2);
        }
    } catch (e) { fail(e); }
}
