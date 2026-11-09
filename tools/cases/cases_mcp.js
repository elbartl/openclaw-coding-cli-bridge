#!/usr/bin/env node
// MCP server (stdio, bez zależności) dla agenta: operacje na sprawach DEV.
// Celowo BRAK narzędzia do decyzji decydenta i do bumpMaxRounds (to robi tylko CLI / interfejs zewnętrzny).
// Źródło prawdy: cases_dev.js.
'use strict';
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const deps = {
    cases: null,
    clef: null,
    workspace: null,
    getDiff: null,   // (wtPath, sha) -> string
};
function cases() { return deps.cases || (deps.cases = require('./cases_dev.js')); }
function clef() {
    if (deps.clef === null) {
        try { deps.clef = require('../clef_guard.js'); }
        catch (e) {
            try { deps.clef = require('./clef_guard.js'); }
            catch (e2) { deps.clef = false; }
        }
    }
    return deps.clef || null;
}
function workspace() {
    if (deps.workspace === null) {
        try { deps.workspace = require('../dev_workspace.js'); }
        catch (e) {
            try { deps.workspace = require('./dev_workspace.js'); }
            catch (e2) { deps.workspace = false; }
        }
    }
    return deps.workspace || null;
}
function _setDeps(d) { Object.assign(deps, d); }

const caseProp = { type: 'string', description: 'Identyfikator sprawy, np. DEV-3' };
const shaProp = { type: 'string', description: 'SHA commita (7–40 znaków hex)' };
const TOOLS = [
    {
        name: 'case_create',
        description: 'Tworzy nową sprawę DEV (etap new). Cel musi zawierać pełny opis i kryteria akceptacji.',
        inputSchema: {
            type: 'object',
            properties: {
                title: { type: 'string', description: 'Krótki tytuł' },
                goal: { type: 'string', description: 'Pełny opis celu i kryteriów akceptacji' },
                repos: { type: 'array', items: { type: 'string' }, description: 'Repozytoria (domyślnie ["openclaw"])' },
                max_rounds: { type: 'integer', description: 'Maks. liczba rund poprawek (domyślnie 3)' },
            },
            required: ['title', 'goal'],
        },
    },
    {
        name: 'case_get',
        description: 'Zwraca pełne dane sprawy (etap, SHA, CLEF, zgoda, raporty, historia).',
        inputSchema: { type: 'object', properties: { case: caseProp }, required: ['case'] },
    },
    {
        name: 'case_list',
        description: 'Lista spraw (domyślnie bez zamkniętych).',
        inputSchema: {
            type: 'object',
            properties: {
                stages: { type: 'array', items: { type: 'string' }, description: 'Filtr etapów' },
                include_closed: { type: 'boolean' },
                limit: { type: 'integer' },
            },
        },
    },
    {
        name: 'case_stage',
        description: 'Zmienia etap sprawy według tabeli przejść. Do awaiting_approval wchodzi się tylko przez case_request_approval, a zgodę zatwierdza wyłącznie decydent. Powrót do coding zwiększa rundę (limit max_rounds: wtedy poproś decydenta o zwiększenie limitu).',
        inputSchema: {
            type: 'object',
            properties: {
                case: caseProp,
                to: { type: 'string', description: 'Etap docelowy' },
                note: { type: 'string' },
            },
            required: ['case', 'to'],
        },
    },
    {
        name: 'case_assign',
        description: 'Zapisuje, który agent aktualnie pracuje nad sprawą.',
        inputSchema: { type: 'object', properties: { case: caseProp, agent: { type: 'string' } }, required: ['case', 'agent'] },
    },
    {
        name: 'case_report',
        description: 'Dopisuje raport (od main) do sprawy. Podanie sha zmienia SHA sprawy i unieważnia ewentualną zgodę.',
        inputSchema: {
            type: 'object',
            properties: {
                case: caseProp,
                text: { type: 'string' },
                kind: { type: 'string', description: 'Rodzaj raportu (domyślnie report)' },
                sha: shaProp,
            },
            required: ['case', 'text'],
        },
    },
    {
        name: 'case_set_sha',
        description: 'Ustawia SHA sprawy (zmiana unieważnia zgodę i cofa do review).',
        inputSchema: { type: 'object', properties: { case: caseProp, sha: shaProp }, required: ['case', 'sha'] },
    },
    {
        name: 'case_scan',
        description: 'Skan CLEF diffa commita z piaskownicy sprawy; zapisuje werdykt w sprawie. Przy awarii API można podać bypass_reason (werdykt unverified z uzasadnieniem).',
        inputSchema: {
            type: 'object',
            properties: {
                case: caseProp,
                sha: shaProp,
                repo: { type: 'string', description: 'Repozytorium (domyślnie pierwsze ze sprawy)' },
                bypass_reason: { type: 'string' },
            },
            required: ['case', 'sha'],
        },
    },
    {
        name: 'case_diff',
        description: 'Diff commita z piaskownicy sprawy (do własnego przeglądu; tylko odczyt, stronicowany po 60 000 znaków).',
        inputSchema: {
            type: 'object',
            properties: {
                case: { type: 'string' },
                sha: { type: 'string', description: 'domyślnie SHA sprawy' },
                repo: { type: 'string' },
                page: { type: 'integer', description: 'Numer strony (domyślnie 1)' },
            },
            required: ['case'],
        },
    },
    {
        name: 'case_request_approval',
        description: 'Prosi decydenta o zgodę na wdrożenie (wymaga etapu review/testing, SHA i zielonego skanu CLEF dla tego SHA). Decydent dostaje powiadomienie; decyzji nie można podjąć tym narzędziem.',
        inputSchema: { type: 'object', properties: { case: caseProp, sha: shaProp }, required: ['case', 'sha'] },
    },
    {
        name: 'case_summary',
        description: 'Liczniki spraw: czekające na zgodę, aktywne, wdrożone dziś.',
        inputSchema: { type: 'object', properties: {} },
    },
];

function brief(c) {
    return {
        id: c.id,
        title: c.title,
        stage: c.stage,
        assignee: c.assignee,
        round: c.round,
        maxRounds: c.maxRounds,
        sha: c.sha,
        clef: c.clef,
        approval: c.approval,
        workboardCardId: c.workboardCardId,
    };
}

function defaultGetDiff(wtPath, sha) {
    const run = (args) => execFileSync('git', ['-C', wtPath, ...args], {
        encoding: 'utf8',
        env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
        maxBuffer: 5 * 1024 * 1024,
    });
    // Cała gałąź sprawy względem gałęzi docelowej (od punktu rozejścia), nie tylko ostatni commit.
    for (const args of [['diff', `master...${sha}`], ['diff', `main...${sha}`], ['diff', `${sha}~1...${sha}`], ['show', '--format=', sha]]) {
        try { const d = run(args); if (d && d.trim()) return d; } catch (e) {}
    }
    return '';
}

async function scan(a) {
    const C = cases();
    const c = C.get(a.case);
    if (!c) { const e = new Error(`Nie ma sprawy ${a.case}`); e.code = 'not_found'; throw e; }
    const sha = String(a.sha || '').trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) { const e = new Error('Nieprawidłowy SHA (oczekiwano 7–40 znaków hex)'); e.code = 'no_sha'; throw e; }
    const repo = a.repo || (c.repos && c.repos[0]) || 'openclaw';
    if (!(c.repos || []).includes(repo)) { const e = new Error(`Repozytorium ${repo} nie należy do sprawy (${(c.repos || []).join(', ')})`); e.code = 'bad_input'; throw e; }
    const dw = workspace();
    const g = clef();
    if (!dw || typeof dw.inspectDevWorkspace !== 'function') throw new Error('Moduł dev_workspace nie jest dostępny');
    if (!g || typeof g.scanCodeDiff !== 'function') throw new Error('Moduł clef_guard nie jest dostępny');
    let ws;
    try { ws = dw.inspectDevWorkspace({ issueKey: c.id }); } catch (e) { throw new Error(`Brak piaskownicy sprawy ${c.id}: ${e.message}`); }
    const info = ws.repos && ws.repos[repo];
    const wtPath = info ? info.path : path.join(ws.rootDir, repo);
    if (!fs.existsSync(wtPath)) throw new Error(`Katalog repozytorium ${repo} nie istnieje w piaskownicy ${c.id}`);
    const diff = (deps.getDiff || defaultGetDiff)(wtPath, sha);
    if (!diff || !diff.trim()) throw new Error(`Nie udało się wyciągnąć diffa dla commita ${sha} w ${repo}`);
    const res = await g.scanCodeDiff({ task: `${c.title}\n${c.goal}`, diff, runId: `case-${c.id}-${sha}`, commitSha: sha });
    const verdict = ['ok', 'quarantine'].includes(res && res.verdict) ? res.verdict : 'unverified';
    const bypass = verdict === 'unverified' && typeof a.bypass_reason === 'string' && a.bypass_reason.trim() ? a.bypass_reason.trim() : undefined;
    const updated = C.setClef(c.id, { verdict, sha, reason: (res && res.reason) || '', bypassReason: bypass });
    return { ...brief(updated), scan: { verdict, reason: res && res.reason, p: res && res.p, bypass: !!bypass, repo } };
}

function diffFor(a) {
    const C = cases();
    const c = C.get(a.case);
    if (!c) { const e = new Error(`Nie ma sprawy ${a.case}`); e.code = 'not_found'; throw e; }
    const sha = String(a.sha || c.sha || '').trim().toLowerCase();
    if (!/^[0-9a-f]{7,40}$/.test(sha)) { const e = new Error('Brak SHA (podaj sha albo ustaw case_set_sha)'); e.code = 'no_sha'; throw e; }
    const repo = a.repo || (c.repos && c.repos[0]) || 'openclaw';
    if (!(c.repos || []).includes(repo)) { const e = new Error(`Repozytorium ${repo} nie należy do sprawy`); e.code = 'bad_input'; throw e; }
    const dw = workspace();
    if (!dw || typeof dw.inspectDevWorkspace !== 'function') throw new Error('Moduł dev_workspace nie jest dostępny');
    let ws;
    try { ws = dw.inspectDevWorkspace({ issueKey: c.id }); } catch (e) { throw new Error(`Brak piaskownicy sprawy ${c.id}: ${e.message}`); }
    const info = ws && ws.repos && ws.repos[repo];
    const wtPath = info ? info.path : (ws && ws.rootDir ? path.join(ws.rootDir, repo) : '');
    if (!wtPath || !fs.existsSync(wtPath)) throw new Error(`Katalog repozytorium ${repo} nie istnieje w piaskownicy ${c.id}`);
    const diff = (deps.getDiff || defaultGetDiff)(wtPath, sha) || '';
    const PAGE_SIZE = 60000;
    const page = Math.max(1, parseInt(a.page, 10) || 1);
    const totalPages = Math.max(1, Math.ceil(diff.length / PAGE_SIZE));
    const start = (page - 1) * PAGE_SIZE;
    const slice = diff.slice(start, start + PAGE_SIZE);
    return { case: c.id, repo, sha, page, totalPages, totalChars: diff.length, diff: slice };
}

async function callTool(name, a) {
    const C = cases();
    switch (name) {
        case 'case_create': return brief(C.create({ title: a.title, goal: a.goal, repos: a.repos || undefined, maxRounds: a.max_rounds || undefined, by: 'main' }));
        case 'case_get': { const c = C.get(a.case); if (!c) { const e = new Error(`Nie ma sprawy ${a.case}`); e.code = 'not_found'; throw e; } return c; }
        case 'case_list': return C.list({ stages: a.stages, includeClosed: !!a.include_closed, limit: a.limit || 50 }).map(brief);
        case 'case_stage': return brief(C.setStage(a.case, a.to, { by: 'main', note: a.note || '' }));
        case 'case_assign': return brief(C.assign(a.case, a.agent, { by: 'main' }));
        case 'case_report': return brief(C.addReport(a.case, { agent: 'main', kind: a.kind || 'report', text: a.text, sha: a.sha }));
        case 'case_set_sha': return brief(C.setSha(a.case, a.sha, { by: 'main' }));
        case 'case_scan': return await scan(a);
        case 'case_diff': return diffFor(a);
        case 'case_request_approval': return brief(C.requestApproval(a.case, { sha: a.sha, by: 'main' }));
        case 'case_summary': return C.summary();
        default: { const e = new Error(`Nieznane narzędzie ${name}`); e.code = 'unknown_tool'; throw e; }
    }
}

// ---- minimal MCP stdio transport (newline-delimited JSON-RPC 2.0) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg, sendFn = send) {
    if (!msg || typeof msg !== 'object') return;
    const { id, method, params } = msg;
    if (id === undefined) return;
    if (method === 'initialize') {
        return sendFn({
            jsonrpc: '2.0',
            id,
            result: {
                protocolVersion: (params && params.protocolVersion) || '2025-06-18',
                capabilities: { tools: {} },
                serverInfo: { name: 'cases', version: '1.0.0' },
            },
        });
    }
    if (method === 'ping') return sendFn({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return sendFn({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
        const name = params && params.name;
        if (!TOOLS.some(t => t.name === name)) return sendFn({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } });
        try {
            const r = await callTool(name, (params && params.arguments) || {});
            return sendFn({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: false } });
        } catch (e) {
            return sendFn({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `BŁĄD${e.code ? ' [' + e.code + ']' : ''}: ${e.message}` }], isError: true, code: e.code || 'error' } });
        }
    }
    sendFn({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

if (require.main === module) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, nl).trim();
            buf = buf.slice(nl + 1);
            if (!line) continue;
            let msg;
            try { msg = JSON.parse(line); } catch (e) { continue; }
            handle(msg).catch(e => { if (msg && msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); });
        }
    });
    process.stdin.on('end', () => process.exit(0));
} else {
    module.exports = { TOOLS, handle, callTool, _setDeps };
}
