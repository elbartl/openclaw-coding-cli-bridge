#!/usr/bin/env node
'use strict';
/**
 * tools/webread/server.js
 * MCP Server (stdio, bez zależności) dla narzędzia `web_read`.
 *
 * Umożliwia bezpieczny odczyt zewnętrznych stron WWW dla operatorów/ops:
 * 1. Filtr query string (usuwanie tokenów, haseł, sk-, ghp_, długich hex/base64).
 * 2. Walidacja URL (validateUrl - blokada sieci prywatnych, localhost, obfuskowanych IP).
 * 3. Bezpieczne pobranie HTTP/HTTPS (safeFetch - pinning DNS, streaming body limit, redirect hop validation).
 * 4. Ekstrakcja tekstu (htmlToText / extractContent - usuwanie ukrytych CSS/HTML i znaków niewidocznych, limit 60k).
 * 5. Kawałkowy skaner CLEF (scanText - prompt injection & hijack detection, fail-closed, sub-cap 1500).
 * 6. Opakowanie <external-source url=… clef=ok sha=…> i stempel HMAC.
 * 7. Zapis do kwarantanny przy odrzuceniu (quarantine/<ts>-<sha>.txt) i log JSONL bez treści.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const ssrf = require('./ssrf.js');
const extract = require('./extract.js');
const scan = require('./scan.js');

const TOOLS = [
    {
        name: 'web_read',
        description: 'Bezpieczny odczyt zewnętrznych stron WWW dla operatorów/ops z walidacją SSRF, czyszczeniem HTML i skanowaniem CLEF pod kątem prompt injection i hijackingu.',
        inputSchema: {
            type: 'object',
            properties: {
                url: { type: 'string', description: 'Pełny adres URL strony http(s) do odczytania' },
                purpose: { type: 'string', description: 'Opcjonalny cel odczytu (zapisywany w audytowym logu JSONL)' },
                summary: { type: 'boolean', description: 'Opcjonalny tryb streszczenia (na razie nieobsługiwany, planowany)' },
            },
            required: ['url'],
        },
    },
];

// Wstrzykiwalne zależności dla testów jednostkowych
const deps = {
    safeFetch: null,
    validateUrl: null,
    extractContent: null,
    htmlToText: null,
    scanText: null,
    wrap: null,
    sign: null,
    loadWebreadBudget: null,
    clef: null,
    stateDir: null,
    budgetPath: null,
    lookup: null,
    fetchImpl: null,
    keyFile: null,
    subCap: null,
};

function _setDeps(d) {
    Object.assign(deps, d);
}

function realHome() {
    try {
        return os.userInfo().homedir || os.homedir();
    } catch (_) {
        return os.homedir();
    }
}

function getPaths(customStateDir) {
    const home = realHome();
    const stateDir = customStateDir || deps.stateDir || process.env.WEBREAD_STATE_DIR || path.join(home, '.openclaw', 'state', 'webread');
    return {
        stateDir,
        budget: deps.budgetPath || path.join(stateDir, 'budget.json'),
        quarantineDir: path.join(stateDir, 'quarantine'),
        log: path.join(stateDir, 'log.jsonl'),
        disabled: path.join(stateDir, 'DISABLED'),
    };
}

/**
 * Normalizuje nazwę parametru URL (lowercase, dekodowanie procentów, usunięcie - i _).
 */
function normalizeParamName(name) {
    let s = String(name || '');
    try {
        s = decodeURIComponent(s);
    } catch (_) {}
    return s.toLowerCase().replace(/[-_]/g, '');
}

/**
 * Sprawdza czy znormalizowana nazwa parametru wskazuje na sekret / token / hasło.
 */
function isSecretParamName(normName) {
    if (!normName) return false;
    return (
        normName.includes('token') ||
        normName.includes('secret') ||
        normName.includes('password') ||
        normName.includes('passwd') ||
        normName.includes('apikey') ||
        normName.includes('auth') ||
        normName.includes('sig') ||
        normName.includes('session') ||
        normName.includes('credential') ||
        normName === 'key' ||
        normName.endsWith('key') ||
        normName.startsWith('key') ||
        normName.includes('bearer')
    );
}

/**
 * Czyści URL z fragmentu (#hash) oraz parametrów zawierających tokeny, klucze, hasła i sekrety.
 */
function sanitizeUrl(urlString) {
    if (typeof urlString !== 'string') return urlString;
    // Zawsze usuwamy fragment (#hash) przed lub w trakcie parsowania
    const withoutHash = urlString.split('#')[0];
    let u;
    try {
        u = new URL(withoutHash);
    } catch (_) {
        return withoutHash;
    }

    u.hash = '';

    const SECRET_PREFIX_RE = /^(?:sk-|ghp_|xox[baprs]-|AKIA|Bearer\s+)/i;
    const LONG_SECRET_RE = /^[A-Za-z0-9+/=_-]{24,}$/;

    const keysToDelete = new Set();
    for (const [name, val] of u.searchParams.entries()) {
        const normName = normalizeParamName(name);
        if (isSecretParamName(normName)) {
            keysToDelete.add(name);
            continue;
        }
        if (SECRET_PREFIX_RE.test(val)) {
            keysToDelete.add(name);
            continue;
        }
        if (val.length >= 24 && LONG_SECRET_RE.test(val)) {
            keysToDelete.add(name);
            continue;
        }
    }

    for (const name of keysToDelete) {
        u.searchParams.delete(name);
    }
    return u.toString();
}

/**
 * Zwraca URL bez query string i hasha (do bezpiecznego logowania).
 */
function stripQuery(urlString) {
    try {
        const u = new URL(urlString);
        u.search = '';
        u.hash = '';
        return u.toString();
    } catch (_) {
        return String(urlString).split('?')[0].split('#')[0];
    }
}

/**
 * Zapisuje wpis audytowy JSONL bez treści strony.
 */
function writeLog(logPath, entry) {
    try {
        fs.mkdirSync(path.dirname(logPath), { recursive: true, mode: 0o700 });
        const line = JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n';
        fs.appendFileSync(logPath, line, { mode: 0o600 });
    } catch (_) {
        // Logowanie nigdy nie przerywa działania narzędzia
    }
}

/**
 * Zapisuje odrzuconą treść do kwarantanny.
 */
function saveQuarantine(quarantineDir, text) {
    try {
        fs.mkdirSync(quarantineDir, { recursive: true, mode: 0o700 });
        const ts = new Date().toISOString().replace(/[:.]/g, '-');
        const sha = crypto.createHash('sha256').update(String(text || ''), 'utf8').digest('hex');
        const filePath = path.join(quarantineDir, `${ts}-${sha}.txt`);
        fs.writeFileSync(filePath, text, { mode: 0o600 });
        return filePath;
    } catch (_) {
        return null;
    }
}

/**
 * Główna logika pobierania i weryfikacji strony web_read.
 */
async function webRead(args = {}) {
    const startTime = Date.now();
    const paths = getPaths(deps.stateDir);
    const logPath = paths.log;
    const bPath = paths.budget;

    // 0. Sprawdzenie flagi summary (not_implemented)
    if (args && args.summary) {
        const e = new Error('Tryb streszczenia (summary=true) jest zaplanowany i nie został jeszcze zaimplementowany');
        e.code = 'not_implemented';
        throw e;
    }

    const rawUrl = String(args && args.url || '').trim();
    if (!rawUrl) {
        const e = new Error('Brak wymaganego parametru url');
        e.code = 'bad_input';
        throw e;
    }

    const urlNoQuery = stripQuery(rawUrl);

    // 1. Filtr query string
    const sanitizedUrl = sanitizeUrl(rawUrl);

    // 2. Walidacja URL (validateUrl)
    const validator = deps.validateUrl || ssrf.validateUrl;
    const v = validator(sanitizedUrl);
    if (!v.ok) {
        const timeMs = Date.now() - startTime;
        writeLog(logPath, {
            url: urlNoQuery,
            verdict: 'error',
            reason: v.reason,
            length: 0,
            scans: 0,
            timeMs,
            purpose: args.purpose || undefined,
        });
        const e = new Error(`Adres URL odrzucony przez walidator SSRF (${v.reason})`);
        e.code = v.reason;
        throw e;
    }

    // 3. Pobranie strony (safeFetch)
    const fetcher = deps.safeFetch || ssrf.safeFetch;
    let fetchRes;
    try {
        fetchRes = await fetcher(sanitizedUrl, {
            lookup: deps.lookup,
            fetchImpl: deps.fetchImpl,
        });
    } catch (err) {
        const timeMs = Date.now() - startTime;
        writeLog(logPath, {
            url: urlNoQuery,
            verdict: 'error',
            reason: err.message,
            length: 0,
            scans: 0,
            timeMs,
            purpose: args.purpose || undefined,
        });
        const e = new Error(`Błąd połączenia: ${err.message}`);
        e.code = 'fetch_failed';
        throw e;
    }

    if (!fetchRes.ok) {
        const timeMs = Date.now() - startTime;
        writeLog(logPath, {
            url: urlNoQuery,
            verdict: 'error',
            reason: fetchRes.reason,
            length: 0,
            scans: 0,
            timeMs,
            purpose: args.purpose || undefined,
        });
        const e = new Error(`Błąd pobierania strony (${fetchRes.reason})`);
        e.code = fetchRes.reason;
        throw e;
    }

    // 4. Ekstrakcja tekstu i czyszczenie znaków ukrytych (extractContent / htmlToText)
    const extractor = deps.extractContent || extract.extractContent;
    const extractRes = extractor(fetchRes.body, fetchRes.contentType, {
        baseUrl: fetchRes.finalUrl || sanitizedUrl,
    });

    if (!extractRes.ok) {
        const timeMs = Date.now() - startTime;
        writeLog(logPath, {
            url: urlNoQuery,
            verdict: 'error',
            reason: extractRes.reason,
            length: extractRes.length || 0,
            scans: 0,
            timeMs,
            purpose: args.purpose || undefined,
        });
        const e = new Error(`Błąd ekstrakcji treści strony (${extractRes.reason})`);
        e.code = extractRes.reason;
        throw e;
    }

    const cleanText = extractRes.text;

    // 5. Kawałkowy skaner CLEF (scanText)
    const subCapNeurons = (Number.isFinite(deps.subCap)
        ? deps.subCap
        : (Number.isFinite(Number(process.env.WEBREAD_SUBCAP))
            ? Number(process.env.WEBREAD_SUBCAP)
            : scan.DEFAULT_SUB_CAP));

    const scanner = deps.scanText || scan.scanText;
    const scanRes = await scanner(cleanText, {
        clef: deps.clef,
        stateDir: paths.stateDir,
        budgetPath: bPath,
        keyFile: deps.keyFile,
        subCap: subCapNeurons,
    });

    const timeMs = Date.now() - startTime;

    if (scanRes.verdict !== 'clean') {
        if (scanRes.verdict === 'rejected') {
            // Zapis do kwarantanny
            saveQuarantine(paths.quarantineDir, cleanText);
            writeLog(logPath, {
                url: urlNoQuery,
                verdict: 'rejected',
                reason: scanRes.reason,
                length: cleanText.length,
                scans: scanRes.scans,
                timeMs,
                purpose: args.purpose || undefined,
            });
            const e = new Error(`Treść strony została zablokowana przez filtr bezpieczeństwa CLEF (${scanRes.reason})`);
            e.code = 'rejected';
            e.reason = scanRes.reason;
            throw e;
        }

        // Werdykt 'error' (fail-closed: timeout, brak budżetu, DISABLED)
        writeLog(logPath, {
            url: urlNoQuery,
            verdict: 'error',
            reason: scanRes.reason,
            length: cleanText.length,
            scans: scanRes.scans,
            timeMs,
            purpose: args.purpose || undefined,
        });
        const e = new Error(`Błąd weryfikacji bezpieczeństwa CLEF [fail-closed] (${scanRes.reason})`);
        e.code = scanRes.reason || 'error';
        e.reason = scanRes.reason || 'error';
        throw e;
    }

    // 6. Opakowanie i stempel HMAC (sign - fail-closed przy błędzie podpisu)
    const signer = deps.sign || scan.sign;
    let wrappedText;
    try {
        wrappedText = signer(cleanText, sanitizedUrl, {
            keyFile: deps.keyFile,
            stateDir: paths.stateDir,
        });
    } catch (err) {
        const timeMs = Date.now() - startTime;
        writeLog(logPath, {
            url: urlNoQuery,
            verdict: 'error',
            reason: 'sign_failed',
            length: cleanText.length,
            scans: scanRes.scans,
            timeMs,
            purpose: args.purpose || undefined,
        });
        const e = new Error(`Błąd stemplowania podpisem HMAC (${err && err.message || 'sign_failed'})`);
        e.code = 'sign_failed';
        throw e;
    }

    const loadBudget = deps.loadWebreadBudget || scan.loadWebreadBudget;
    const budget = loadBudget(bPath);
    const usedNeurons = budget.used || 0;
    const remainingNeurons = Math.max(0, subCapNeurons - usedNeurons);
    const scansToday = budget.scans || 0;

    writeLog(logPath, {
        url: urlNoQuery,
        verdict: 'clean',
        length: cleanText.length,
        scans: scanRes.scans,
        timeMs,
        purpose: args.purpose || undefined,
    });

    return {
        ok: true,
        verdict: 'clean',
        text: wrappedText,
        subCapNeurons,
        usedNeurons,
        remainingNeurons,
        scans: scansToday,
    };
}

async function callTool(name, a) {
    if (name === 'web_read') {
        return await webRead(a);
    }
    const e = new Error(`Nieznane narzędzie ${name}`);
    e.code = 'unknown_tool';
    throw e;
}

// ---- Standardowy transport stdio MCP (newline-delimited JSON-RPC 2.0) ----
function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg, sendFn = send) {
    try {
        if (!msg || typeof msg !== 'object' || Array.isArray(msg)) {
            const maybeId = (msg && typeof msg === 'object' && msg.id !== undefined) ? msg.id : undefined;
            if (maybeId !== undefined) {
                return sendFn({
                    jsonrpc: '2.0',
                    id: maybeId,
                    error: { code: -32600, message: 'Invalid Request: message must be a JSON object' },
                });
            }
            return;
        }

        const { id, method, params } = msg;
        if (id === undefined) return;

        if (method === 'initialize') {
            return sendFn({
                jsonrpc: '2.0',
                id,
                result: {
                    protocolVersion: (params && params.protocolVersion) || '2025-06-18',
                    capabilities: { tools: {} },
                    serverInfo: { name: 'webread', version: '1.0.0' },
                },
            });
        }

        if (method === 'ping') {
            return sendFn({ jsonrpc: '2.0', id, result: {} });
        }

        if (method === 'tools/list') {
            return sendFn({ jsonrpc: '2.0', id, result: { tools: TOOLS } });
        }

        if (method === 'tools/call') {
            const name = params && params.name;
            if (!TOOLS.some(t => t.name === name)) {
                return sendFn({
                    jsonrpc: '2.0',
                    id,
                    error: { code: -32602, message: `Unknown tool ${name}` },
                });
            }
            try {
                const r = await callTool(name, (params && params.arguments) || {});
                return sendFn({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
                        isError: false,
                        subCapNeurons: r.subCapNeurons,
                        usedNeurons: r.usedNeurons,
                        remainingNeurons: r.remainingNeurons,
                        scans: r.scans,
                    },
                });
            } catch (e) {
                return sendFn({
                    jsonrpc: '2.0',
                    id,
                    result: {
                        content: [{ type: 'text', text: `BŁĄD${e.code ? ' [' + e.code + ']' : ''}: ${e.message}` }],
                        isError: true,
                        code: e.code || 'error',
                    },
                });
            }
        }

        sendFn({
            jsonrpc: '2.0',
            id,
            error: { code: -32601, message: `Method not found: ${method}` },
        });
    } catch (err) {
        try {
            if (msg && typeof msg === 'object' && msg.id !== undefined) {
                sendFn({
                    jsonrpc: '2.0',
                    id: msg.id,
                    error: { code: -32603, message: 'Internal error: ' + (err && err.message || 'unknown') },
                });
            }
        } catch (_) {}
    }
}

if (require.main === module) {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (d) => {
        try {
            buf += d;
            let nl;
            while ((nl = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, nl).trim();
                buf = buf.slice(nl + 1);
                if (!line) continue;
                let msg;
                try {
                    msg = JSON.parse(line);
                } catch (_) {
                    continue;
                }
                handle(msg).catch((e) => {
                    try {
                        if (msg && typeof msg === 'object' && msg.id !== undefined) {
                            send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } });
                        }
                    } catch (_) {}
                });
            }
        } catch (_) {
            // never kill the process
        }
    });
    process.stdin.on('error', () => {});
    process.stdin.on('end', () => process.exit(0));
} else {
    module.exports = {
        TOOLS,
        handle,
        callTool,
        webRead,
        sanitizeUrl,
        stripQuery,
        getPaths,
        _setDeps,
    };
}
