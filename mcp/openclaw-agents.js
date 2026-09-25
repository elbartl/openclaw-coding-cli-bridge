#!/usr/bin/env node
// MCP server (stdio, no dependencies): lets a Claude Code run behind
// claude_proxy.js delegate to OpenClaw agents. The proxy drops OpenAI `tools`,
// so a main agent served through it can never call OpenClaw's sessions_spawn;
// this bridge gives it the same capability through its own MCP tool list.
//
// Each call runs one synchronous turn via the Gateway:
//   openclaw agent --agent <id> --session-key agent:<id>:cc-<uuid> --message-file <f> --json
// The subagent keeps its own model and permissions from openclaw.json, so
// e.g. ha-diag stays on agy/gemini-flash-ro with its read-only role.
const { spawn } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const OPENCLAW_BIN = process.env.OPENCLAW_BIN || 'openclaw';
const CALL_TIMEOUT_MS = parseInt(process.env.OPENCLAW_AGENT_TIMEOUT_MS || '1500000', 10); // 25 min, under claude_proxy HARD
// id -> one-line description shown to the model. Override with
// OPENCLAW_AGENTS='{"ha-diag":"...", ...}'.
const DEFAULT_AGENTS = {
    'ha-diag': 'Home Assistant, tylko odczyt: ekstrakcja danych (stany, historia, szeregi czasowe, konfiguracja). Zwraca fakty, nie diagnozuje.',
    'ha-log': 'Home Assistant, tylko odczyt: logi, ślady automatyzacji, błędy integracji.',
    'ha-yaml': 'Home Assistant z prawem zapisu: zmiany YAML/konfiguracji, automatyzacji i skryptów. Używaj tylko gdy decyzja o zmianie już zapadła.',
};
let AGENTS = DEFAULT_AGENTS;
try { if (process.env.OPENCLAW_AGENTS) AGENTS = JSON.parse(process.env.OPENCLAW_AGENTS); } catch (e) {}

const TOOLS = [{
    name: 'ask_agent',
    description: 'Deleguje zadanie do subagenta OpenClaw i czeka na jego odpowiedź (zwykle 10 s – kilka min). '
        + 'Kilka niezależnych zadań wywołuj równolegle. Zadanie musi być samowystarczalne: subagent nie widzi tej rozmowy. '
        + 'Agenci: ' + Object.entries(AGENTS).map(([k, v]) => `${k} — ${v}`).join(' | '),
    inputSchema: {
        type: 'object',
        properties: {
            agent: { type: 'string', enum: Object.keys(AGENTS), description: 'Id subagenta' },
            task: { type: 'string', description: 'Pełna treść zadania: co zebrać, zakres czasu, format wyniku.' },
            session_key: { type: 'string', description: 'Opcjonalnie: session_key z poprzedniej odpowiedzi, by kontynuować tę samą sesję subagenta (dopytanie).' },
        },
        required: ['agent', 'task'],
    },
}];

function findKey(obj, key, depth = 0) {
    if (!obj || typeof obj !== 'object' || depth > 12) return undefined;
    if (Object.prototype.hasOwnProperty.call(obj, key)) return obj[key];
    for (const v of Object.values(obj)) {
        const r = findKey(v, key, depth + 1);
        if (r !== undefined) return r;
    }
    return undefined;
}

// Drop the agy proxy's own progress ticks and footer: they are transport
// noise for the calling model, and the winning model is reported separately.
function cleanText(t) {
    return String(t || '')
        .replace(/^[⏳⌛][^\n]*\n?/gm, '')
        .replace(/⚠️?\s*\[proxy\][^\n]*/g, '')
        .replace(/\n+— model: [^\n]*\s*$/, '')
        .trim();
}

function askAgent({ agent, task, session_key }) {
    return new Promise((resolve) => {
        if (!AGENTS[agent]) return resolve({ error: `Nieznany agent "${agent}". Dostępni: ${Object.keys(AGENTS).join(', ')}` });
        if (!task || !String(task).trim()) return resolve({ error: 'Puste zadanie' });
        const prefix = `agent:${agent}:`;
        const key = session_key && session_key.startsWith(prefix) ? session_key : `${prefix}cc-${crypto.randomUUID()}`;
        const msgFile = path.join(os.tmpdir(), `oc-agent-${process.pid}-${Date.now()}.txt`);
        fs.writeFileSync(msgFile, String(task), { mode: 0o600 });
        const started = Date.now();
        const child = spawn(OPENCLAW_BIN, ['agent', '--agent', agent, '--session-key', key, '--message-file', msgFile, '--json'], {
            stdio: ['ignore', 'pipe', 'pipe'], detached: true, env: { ...process.env, NO_COLOR: '1' },
        });
        let out = '', err = '', done = false;
        child.stdout.on('data', d => { out += d; });
        child.stderr.on('data', d => { err += d; if (err.length > 20000) err = err.slice(-20000); });
        const timer = setTimeout(() => {
            try { process.kill(-child.pid, 'SIGKILL'); } catch (e) {}
            finish(null, `timeout po ${Math.round(CALL_TIMEOUT_MS / 60000)} min`);
        }, CALL_TIMEOUT_MS);
        child.on('error', e => finish(null, e.message));
        child.on('exit', code => setTimeout(() => finish(code), 100));
        function finish(code, why) {
            if (done) return;
            done = true;
            clearTimeout(timer);
            try { fs.unlinkSync(msgFile); } catch (e) {}
            const secs = ((Date.now() - started) / 1000).toFixed(0);
            if (why) return resolve({ error: `${agent}: ${why}`, session_key: key });
            let j = null;
            try { j = JSON.parse(out.slice(out.indexOf('{'))); } catch (e) {}
            const text = j ? findKey(j, 'finalAssistantVisibleText') : null;
            const trace = j ? findKey(j, 'executionTrace') : null;
            const model = trace && trace.winnerProvider ? `${trace.winnerProvider}/${trace.winnerModel}` : null;
            if (code !== 0 || !j || !text) {
                const detail = (j && (findKey(j, 'error') || findKey(j, 'message'))) || err.trim().slice(-600) || out.trim().slice(-600);
                return resolve({ error: `${agent} nie zwrócił odpowiedzi (kod ${code}, ${secs}s): ${typeof detail === 'string' ? detail : JSON.stringify(detail).slice(0, 600)}`, session_key: key });
            }
            resolve({ text: cleanText(text), session_key: key, model, seconds: Number(secs) });
        }
    });
}

// ---- minimal MCP stdio transport (newline-delimited JSON-RPC 2.0) ----
function send(msg) { process.stdout.write(JSON.stringify(msg) + '\n'); }

async function handle(msg) {
    const { id, method, params } = msg;
    if (id === undefined) return;   // notification (initialized, cancelled, ...)
    if (method === 'initialize') {
        return send({ jsonrpc: '2.0', id, result: {
            protocolVersion: (params && params.protocolVersion) || '2025-06-18',
            capabilities: { tools: {} },
            serverInfo: { name: 'openclaw-agents', version: '1.0.0' },
        } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') return send({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
    if (method === 'tools/call') {
        const name = params && params.name;
        if (name !== 'ask_agent') return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `Unknown tool ${name}` } });
        const r = await askAgent((params && params.arguments) || {});
        const header = `[${(params.arguments || {}).agent} | session_key=${r.session_key || '-'}${r.model ? ` | model=${r.model}` : ''}${r.seconds != null ? ` | ${r.seconds}s` : ''}]`;
        return send({ jsonrpc: '2.0', id, result: {
            content: [{ type: 'text', text: r.error ? `${header}\nBŁĄD: ${r.error}` : `${header}\n${r.text}` }],
            isError: !!r.error,
        } });
    }
    send({ jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${method}` } });
}

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
        handle(msg).catch(e => { if (msg.id !== undefined) send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }); });
    }
});
process.stdin.on('end', () => process.exit(0));
