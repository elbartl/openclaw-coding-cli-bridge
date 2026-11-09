'use strict';
/**
 * tools/webread/server.edge.test.js
 * Niezależne testy brzegowe i adwersaryjne serwera MCP (tools/webread/server.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { handle, webRead, sanitizeUrl, _setDeps } = require('./server');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'webread-server-edge-'));
}

test('Server edge [REPRODUKCJA BŁĘDU]: awaria serwera MCP przy komunikacie null (TypeError unhandled)', async () => {
    // Protokół JSON-RPC pozwala na wysłanie wartości null jako JSON w strumieniu stdio.
    // W server.js w handle(msg) na linii 375: const { id, method, params } = msg;
    // oraz w sekcji obsługi błędów na linii 456: if (msg.id !== undefined)
    // brakuje sprawdzenia if (!msg || typeof msg !== 'object').
    // Wysłanie null powoduje rzucenie nieschwyconego wyjątku TypeError, który zabija cały proces serwera!
    let caughtError = null;
    try {
        await handle(null, () => {});
    } catch (e) {
        caughtError = e;
    }
    assert.strictEqual(caughtError, null, 'LUKA: handle(null) nie może rzucać nieobsłużonego TypeError zabijającego proces');
});

test('Server edge [REPRODUKCJA BŁĘDU]: wyciek tokenów w fragmencie URL (#token=...) oraz parametrach z myślnikiem', () => {
    // BŁĄD 1: Wyciek tokenu we fragmencie URL (#token=..., #access_token=...)
    // sanitizeUrl modyfikuje wyłącznie searchParams, ignorując całkowicie hash fragment!
    // Tokeny przekazywane po znaku # (np. OAuth 2.0 Implicit Flow, SPA) nie są czyszczone
    // i wyciekają do podpisanego stempla oraz logów/odpowiedzi!
    const urlWithHashToken = 'https://example.com/oauth/callback#access_token=sk-123456789012345678901234&token_type=bearer';
    const cleanedHash = sanitizeUrl(urlWithHashToken);
    assert.ok(!cleanedHash.includes('sk-1234567890'), 'LUKA: Fragment #access_token z tokenem sk- nie może pozostać w URL');

    // BŁĄD 2: Parametry z myślnikiem, np. api-key=...
    // Wyrażenie regularne w sanitizeUrl sprawdza /apikey|api_key/, ale pomija api-key (z myślnikiem).
    const urlWithHyphen = 'https://api.example.com/data?api-key=secret123456';
    const cleanedHyphen = sanitizeUrl(urlWithHyphen);
    assert.ok(!cleanedHyphen.includes('api-key'), 'LUKA: Parametr api-key nie może pozostać w URL');
});

test('Server edge: filtr query string usuwa standardowe tokeny, sekrety i prefiksy sk-, ghp-, AKIA', () => {
    const dirtyUrl = 'https://api.example.com/v1/search?q=test&token=secretToken1234567890&auth=pass123&sk=sk-abc12345678901234567890&ghp=ghp_abcdefghijklmnop123456&aws=AKIAIOSFODNN7EXAMPLE';
    const cleaned = sanitizeUrl(dirtyUrl);
    const u = new URL(cleaned);

    assert.strictEqual(u.searchParams.get('q'), 'test', 'Niewrażliwy parametr q musi zostać zachowany');
    assert.strictEqual(u.searchParams.get('token'), null);
    assert.strictEqual(u.searchParams.get('auth'), null);
    assert.strictEqual(u.searchParams.get('sk'), null);
    assert.strictEqual(u.searchParams.get('ghp'), null);
    assert.strictEqual(u.searchParams.get('aws'), null);
});

test('Server edge: walidacja protokołu MCP (brakujące pola, nieznane narzędzie, nieobsługiwana metoda)', async () => {
    const responses = [];
    const send = (msg) => responses.push(msg);

    // 1. Nieznana metoda
    await handle({ id: 1, method: 'unknown/method', params: {} }, send);
    assert.strictEqual(responses[0].error.code, -32601);

    // 2. Nieznane narzędzie w tools/call
    await handle({ id: 2, method: 'tools/call', params: { name: 'unknown_tool', arguments: {} } }, send);
    assert.strictEqual(responses[1].error.code, -32602);

    // 3. Brak argumentu url w tools/call dla web_read
    await handle({ id: 3, method: 'tools/call', params: { name: 'web_read', arguments: {} } }, send);
    assert.strictEqual(responses[2].result.isError, true);
    assert.ok(responses[2].result.content[0].text.includes('BŁĄD [bad_input]'));
});

test('Server edge: gwarancja braku treści strony w komunikatach odmowy i błędów (fail-closed)', async () => {
    const tmpDir = makeTmpDir();
    try {
        const secretPageContent = 'TAJNE_DANE_KORPORACYJNE_KTORE_NIE_MOGA_WYCIEC_PRZY_BLĘDZIE';

        // Mock safeFetch zwracający treść, która następnie zostanie odrzucona przez skaner CLEF
        _setDeps({
            stateDir: tmpDir,
            safeFetch: async () => ({
                ok: true,
                status: 200,
                contentType: 'text/plain',
                body: Buffer.from(secretPageContent),
            }),
            validateUrl: () => ({ ok: true, url: 'https://example.com/test' }),
            scanText: async () => ({ ok: false, verdict: 'rejected', reason: 'prompt_injection_flagged', scans: 1 }),
        });

        const responses = [];
        await handle({
            id: 10,
            method: 'tools/call',
            params: { name: 'web_read', arguments: { url: 'https://example.com/test' } },
        }, (msg) => responses.push(msg));

        assert.strictEqual(responses[0].result.isError, true);
        const errorText = responses[0].result.content[0].text;

        // Odpowiedź zawiera wyłącznie komunikat błędu, ZERO treści strony!
        assert.ok(!errorText.includes(secretPageContent), 'BŁĄD BEZPIECZEŃSTWA: Treść strony wyciekła w komunikacie błędu!');
        assert.ok(errorText.includes('prompt_injection_flagged'));
    } finally {
        _setDeps({ safeFetch: null, validateUrl: null, scanText: null, stateDir: null });
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Server edge (runda 3): KRYTYCZNE BEZPIECZEŃSTWO - _allowPrivateForTesting nieosiągalne z zewnątrz MCP ani przez ENV', async () => {
    // 1. Wywołanie tools/call z adresem 127.0.0.1 oraz różnymi wariantami flagi _allowPrivateForTesting
    const testArgs = [
        { url: 'http://127.0.0.1:8080/', _allowPrivateForTesting: true },
        { url: 'http://localhost:8080/', _allowPrivateForTesting: true },
        { url: 'http://127.0.0.1:8080/', allowPrivateForTesting: true },
        { url: 'http://127.0.0.1:8080/', options: { _allowPrivateForTesting: true } },
        { url: 'http://[::1]:8080/', _allowPrivateForTesting: true },
    ];

    for (let i = 0; i < testArgs.length; i++) {
        let resp = null;
        await handle({
            jsonrpc: '2.0',
            id: 100 + i,
            method: 'tools/call',
            params: { name: 'web_read', arguments: testArgs[i] },
        }, (out) => { resp = out; });

        assert.strictEqual(resp.result.isError, true, `Próba ${i} musi zakończyć się odmową`);
        assert.ok(
            resp.result.code === 'private_ip' || resp.result.code === 'localhost_not_allowed',
            `Oczekiwano private_ip lub localhost_not_allowed, otrzymano ${resp.result.code}`
        );
    }

    // 2. Próba włączenia przez zmienną środowiskową
    const oldEnv = process.env.ALLOW_PRIVATE_FOR_TESTING;
    try {
        process.env.ALLOW_PRIVATE_FOR_TESTING = '1';
        let resp = null;
        await handle({
            jsonrpc: '2.0',
            id: 200,
            method: 'tools/call',
            params: { name: 'web_read', arguments: { url: 'http://127.0.0.1:8080/' } },
        }, (out) => { resp = out; });

        assert.strictEqual(resp.result.isError, true);
        assert.strictEqual(resp.result.code, 'private_ip');
    } finally {
        if (oldEnv === undefined) delete process.env.ALLOW_PRIVATE_FOR_TESTING;
        else process.env.ALLOW_PRIVATE_FOR_TESTING = oldEnv;
    }
});

test('Server edge (runda 3): fail-closed podpisu HMAC (błąd signera i brak pliku klucza -> sign_failed, brak treści)', async () => {
    const tmpDir = makeTmpDir();
    try {
        const secretText = 'Poufna tresc strony nie moze wyciec przy awarii podpisu!';

        // A. Signer rzuca wyjątek
        _setDeps({
            stateDir: tmpDir,
            safeFetch: async () => ({ ok: true, status: 200, contentType: 'text/plain', body: Buffer.from(secretText) }),
            validateUrl: () => ({ ok: true, url: 'http://example.com/test' }),
            extractContent: () => ({ ok: true, text: secretText, length: secretText.length, hiddenCount: 0 }),
            scanText: async () => ({ ok: true, verdict: 'clean', scans: 1, chunks: 1 }),
            sign: () => { throw new Error('Kryptograficzny błąd modułu HSM'); },
        });

        let respA = null;
        await handle({
            jsonrpc: '2.0',
            id: 301,
            method: 'tools/call',
            params: { name: 'web_read', arguments: { url: 'http://example.com/test' } },
        }, (out) => { respA = out; });

        assert.strictEqual(respA.result.isError, true);
        assert.strictEqual(respA.result.code, 'sign_failed');
        assert.strictEqual(JSON.stringify(respA).includes(secretText), false, 'Treść strony nie może wyciec przy błędzie signera');

        // B. Brak pliku klucza (keyFile nie istnieje)
        _setDeps({
            stateDir: tmpDir,
            safeFetch: async () => ({ ok: true, status: 200, contentType: 'text/plain', body: Buffer.from(secretText) }),
            validateUrl: () => ({ ok: true, url: 'http://example.com/test' }),
            extractContent: () => ({ ok: true, text: secretText, length: secretText.length, hiddenCount: 0 }),
            scanText: async () => ({ ok: true, verdict: 'clean', scans: 1, chunks: 1 }),
            sign: null, // użyj domyślnego scan.sign
            keyFile: path.join(tmpDir, 'brak_klucza.key'),
        });

        let respB = null;
        await handle({
            jsonrpc: '2.0',
            id: 302,
            method: 'tools/call',
            params: { name: 'web_read', arguments: { url: 'http://example.com/test' } },
        }, (out) => { respB = out; });

        assert.strictEqual(respB.result.isError, true);
        assert.strictEqual(respB.result.code, 'sign_failed');
        assert.strictEqual(JSON.stringify(respB).includes(secretText), false, 'Treść strony nie może wyciec przy braku pliku klucza');
    } finally {
        _setDeps({ safeFetch: null, validateUrl: null, extractContent: null, scanText: null, sign: null, keyFile: null, stateDir: null });
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Server edge (runda 3): spójność sub-capu w neuronach i równoległe wywołania (Promise.all 5 skanów przy sub-capie na 2)', async () => {
    const tmpDir = makeTmpDir();
    const core = require('../clef_scan_core');
    const scan = require('./scan');
    const bPath = path.join(tmpDir, 'budget.json');
    const keyFile = path.join(tmpDir, 'clef.key');
    fs.writeFileSync(keyFile, '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef\n');

    try {
        const text = 'Krótki tekst testowy strony';
        const est = core.estimateNeurons(core.buildState('External web page content', text));

        _setDeps({
            stateDir: tmpDir,
            budgetPath: bPath,
            keyFile,
            subCap: est * 2, // Sub-cap dokładnie na 2 skany
            safeFetch: async () => ({ ok: true, status: 200, contentType: 'text/plain', body: Buffer.from(text) }),
            validateUrl: () => ({ ok: true, url: 'http://example.com/' }),
            extractContent: () => ({ ok: true, text, length: text.length, hiddenCount: 0 }),
            clef: async () => {
                await new Promise(r => setTimeout(r, 25));
                return { verdict: 'clean', neurons: est };
            },
        });

        // 1. Równoległe 5 wywołań przy budżecie na 2
        const parallel = await Promise.all([1, 2, 3, 4, 5].map(async (i) => {
            let resp = null;
            await handle({
                jsonrpc: '2.0',
                id: 400 + i,
                method: 'tools/call',
                params: { name: 'web_read', arguments: { url: `http://example.com/${i}` } },
            }, (out) => { resp = out; });
            return resp;
        }));

        const okCalls = parallel.filter(p => !p.result.isError);
        const errCalls = parallel.filter(p => p.result.isError);

        assert.strictEqual(okCalls.length, 2, 'Dokładnie 2 wywołania powinny się powieść');
        assert.strictEqual(errCalls.length, 3, 'Dokładnie 3 wywołania powinny zostać odrzucone z brakiem budżetu');
        assert.ok(errCalls.every(p => p.result.code === 'budget'));

        // 2. Sprawdzenie stanu ewidencji budżetowej i spójności pól
        const b = scan.loadWebreadBudget(bPath);
        assert.strictEqual(b.scans, 2);
        assert.strictEqual(b.used, est * 2);
        assert.strictEqual(b.reservedScans || 0, 0);
        assert.strictEqual(b.reservedNeurons || 0, 0);

        // 3. Sprawdzenie wartości zwracanych w udanych odpowiedziach
        for (const succ of okCalls) {
            assert.strictEqual(succ.result.subCapNeurons, est * 2);
            assert.ok(succ.result.usedNeurons >= est && succ.result.usedNeurons <= est * 2);
            assert.ok(succ.result.remainingNeurons >= 0, 'remainingNeurons nie może być ujemne');
        }

        // 4. Kolejne wywołanie po wyczerpaniu natychmiast odrzucone z code: budget
        let extra = null;
        await handle({
            jsonrpc: '2.0',
            id: 499,
            method: 'tools/call',
            params: { name: 'web_read', arguments: { url: 'http://example.com/extra' } },
        }, (out) => { extra = out; });

        assert.strictEqual(extra.result.isError, true);
        assert.strictEqual(extra.result.code, 'budget');
    } finally {
        _setDeps({ stateDir: null, budgetPath: null, keyFile: null, subCap: null, safeFetch: null, validateUrl: null, extractContent: null, clef: null });
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

