'use strict';
/**
 * tools/webread/scan.test.js
 * Testy jednostkowe dla kawałkowego skanera tekstu CLEF (sprawa DEV-2).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const {
    scanText,
    splitChunks,
    wrap,
    sign,
    verify,
    loadWebreadBudget,
    saveWebreadBudget,
} = require('./scan.js');
const core = require('../clef_scan_core.js');

const DUMMY_KEY = '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';

function makeTestEnv() {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'scan-test-'));
    const stateDir = path.join(tmpDir, 'state');
    const secretsDir = path.join(tmpDir, 'secrets');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.mkdirSync(secretsDir, { recursive: true });

    const keyFile = path.join(secretsDir, 'clef-guard.key');
    fs.writeFileSync(keyFile, DUMMY_KEY + '\n');
    const budgetPath = path.join(stateDir, 'budget.json');

    return {
        tmpDir,
        stateDir,
        secretsDir,
        keyFile,
        budgetPath,
        cleanup() {
            try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
        },
    };
}

test('splitChunks: podział tekstu na nakładające się kawałki', () => {
    assert.deepEqual(splitChunks(''), []);
    assert.deepEqual(splitChunks(null), []);

    const short = 'Krótki tekst bez podziału';
    assert.deepEqual(splitChunks(short, 100), [short]);

    // Długi tekst 7000 znaków z chunkSize=3000 i overlap=200
    const str = 'A'.repeat(7000);
    const chunks = splitChunks(str, 3000, 200);
    assert.equal(chunks.length, 3);
    assert.equal(chunks[0].length, 3000);
    assert.equal(chunks[1].length, 3000);
    assert.equal(chunks[2].length, 1400);

    // Weryfikacja nakładania: koniec pierwszego pokrywa się z początkiem drugiego
    assert.equal(chunks[0].slice(2800), chunks[1].slice(0, 200));
});

test('1. czysta strona: pełne przejście wszystkich kawałków', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Wszystkie systemy działają prawidłowo. '.repeat(200); // ~7800 znaków -> 3 kawałki
        let mockCalls = 0;

        const mockClef = async (chunk, meta) => {
            mockCalls++;
            return {
                verdict: 'ok',
                reason: 'clean',
                p: { injection: 0.01, hijack: 0.02 },
                neurons: 30,
            };
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            keyFile: env.keyFile,
            chunkSize: 3000,
            overlap: 200,
        });

        assert.equal(res.ok, true);
        assert.equal(res.verdict, 'clean');
        assert.equal(res.chunks, 3);
        assert.equal(res.scans, 3);
        assert.equal(mockCalls, 3);
    } finally {
        env.cleanup();
    }
});

test('2. injection w pierwszym kawałku: natychmiastowe odrzucenie po 1 skanie', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Kawałek 1 z atakiem. '.repeat(300); // ~6300 znaków -> 3 kawałki
        let mockCalls = 0;

        const mockClef = async (chunk, meta) => {
            mockCalls++;
            if (meta.index === 0) {
                return {
                    verdict: 'quarantine',
                    reason: 'flagged',
                    p: { injection: 0.95, hijack: 0.10 },
                    neurons: 30,
                };
            }
            return { verdict: 'ok', reason: 'clean', p: { injection: 0.01, hijack: 0.01 }, neurons: 30 };
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            chunkSize: 3000,
            overlap: 200,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'rejected');
        assert.equal(res.scans, 1, 'Musi zatrzymać się po pierwszym skażonym kawałku');
        assert.equal(mockCalls, 1);
        assert.equal(res.chunks, 3);
    } finally {
        env.cleanup();
    }
});

test('3. injection w środkowym kawałku: odrzucenie po 2 skanach', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Czysty początek tekstu. '.repeat(300); // ~7200 znaków -> 3 kawałki
        let mockCalls = 0;

        const mockClef = async (chunk, meta) => {
            mockCalls++;
            if (meta.index === 1) {
                return {
                    verdict: 'quarantine',
                    reason: 'flagged',
                    p: { injection: 0.88, hijack: 0.05 },
                    neurons: 30,
                };
            }
            return { verdict: 'ok', reason: 'clean', p: { injection: 0.01, hijack: 0.01 }, neurons: 30 };
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            chunkSize: 3000,
            overlap: 200,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'rejected');
        assert.equal(res.scans, 2, 'Musi zatrzymać się po drugim kawałku');
        assert.equal(mockCalls, 2);
        assert.equal(res.chunks, 3);
    } finally {
        env.cleanup();
    }
});

test('4. injection w OSTATNIM kawałku: odrzucenie całości po 3 skanach', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Tekst z atakiem na samym końcu. '.repeat(200); // 3 kawałki
        let mockCalls = 0;

        const mockClef = async (chunk, meta) => {
            mockCalls++;
            if (meta.index === 2) {
                return {
                    verdict: 'quarantine',
                    reason: 'flagged',
                    p: { injection: 0.02, hijack: 0.99 },
                    neurons: 30,
                };
            }
            return { verdict: 'ok', reason: 'clean', p: { injection: 0.01, hijack: 0.01 }, neurons: 30 };
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            chunkSize: 3000,
            overlap: 200,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'rejected');
        assert.equal(res.scans, 3, 'Wszystkie 3 kawałki zeskanowane, ostatni skażony');
        assert.equal(mockCalls, 3);
        assert.equal(res.chunks, 3);
    } finally {
        env.cleanup();
    }
});

test('5. błąd CLEF: fail-closed zwraca verdict error', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Jakiś artykuł do przeczytania.';
        const mockClef = async () => {
            throw new Error('Cloudflare API HTTP 500 Internal Error');
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'error');
        assert.match(res.reason, /500/);
        assert.equal(res.scans, 1);
    } finally {
        env.cleanup();
    }
});

test('6. timeout: fail-closed z reason timeout', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Jakiś artykuł do przeczytania.';
        const mockClef = async () => {
            const err = new Error('The operation was aborted');
            err.name = 'AbortError';
            throw err;
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'error');
        assert.equal(res.reason, 'timeout');
        assert.equal(res.scans, 1);
    } finally {
        env.cleanup();
    }
});

test('7. brak budżetu: zablokowanie gdy limit zużycia jest wyczerpany', async () => {
    const env = makeTestEnv();
    try {
        const text = 'Tekst do skanowania.';
        // Zapisujemy wyczerpany budżet dobowy (np. 1500 z 1500)
        saveWebreadBudget(env.budgetPath, {
            day: new Date().toISOString().slice(0, 10),
            used: 1500,
            scans: 50,
            calls: 10,
        });

        let mockCalls = 0;
        const mockClef = async () => {
            mockCalls++;
            return { verdict: 'ok', p: { injection: 0, hijack: 0 } };
        };

        const res = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            subCap: 1500,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'error');
        assert.equal(res.reason, 'budget');
        assert.equal(res.scans, 0, 'Przy braku budżetu nie wolno wykonywać zapytań');
        assert.equal(mockCalls, 0);
    } finally {
        env.cleanup();
    }
});

test('8. sub-cap egzekwowany w neuronach (przy sub-capie 100 neuronów i koszcie ~42 trzeci odrzucony)', async () => {
    const env = makeTestEnv();
    try {
        // Tekst o szacowanym koszcie 42 neuronów (ok. 3900 znaków)
        const text = 'A'.repeat(3900);
        const mockClef = async () => ({
            verdict: 'ok',
            reason: 'clean',
            p: { injection: 0, hijack: 0 },
            neurons: 42,
        });

        // 1. Pierwszy skan: subCap=100, koszt 42 -> akceptacja (used=42)
        const res1 = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            subCap: 100,
        });
        assert.equal(res1.ok, true);
        assert.equal(res1.scans, 1);

        let b = loadWebreadBudget(env.budgetPath);
        assert.equal(b.scans, 1);
        assert.equal(b.used, 42);

        // 2. Drugi skan: used=42, koszt 42 -> 84 <= 100 -> akceptacja (used=84)
        const res2 = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            subCap: 100,
        });
        assert.equal(res2.ok, true);
        assert.equal(res2.scans, 1);

        b = loadWebreadBudget(env.budgetPath);
        assert.equal(b.scans, 2);
        assert.equal(b.used, 84);

        // 3. Trzeci skan: used=84, est=42 -> 84 + 42 = 126 > 100 -> odrzucony z góry
        const res3 = await scanText(text, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            subCap: 100,
        });
        assert.equal(res3.ok, false);
        assert.equal(res3.verdict, 'error');
        assert.equal(res3.reason, 'budget');
        assert.equal(res3.scans, 0);

        b = loadWebreadBudget(env.budgetPath);
        assert.equal(b.scans, 2);
        assert.equal(b.used, 84);
    } finally {
        env.cleanup();
    }
});

test('9. DISABLED: obecność pliku DISABLED w state/webread blokuje skanowanie', async () => {
    const env = makeTestEnv();
    try {
        fs.writeFileSync(path.join(env.stateDir, 'DISABLED'), 'wyłączone przez operatora\n');
        let mockCalls = 0;
        const mockClef = async () => { mockCalls++; return { verdict: 'ok' }; };

        const res = await scanText('Dowolny tekst', {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'error');
        assert.equal(res.reason, 'disabled');
        assert.equal(res.scans, 0);
        assert.equal(mockCalls, 0);
    } finally {
        env.cleanup();
    }
});

test('10. tekst za długi względem budżetu: odmowa z góry (scans=0)', async () => {
    const env = makeTestEnv();
    try {
        // Tekst generujący 5 kawałków
        const longText = 'Bardzo długi artykuł. '.repeat(600); // ~13200 znaków -> 5 kawałków
        let mockCalls = 0;
        const mockClef = async () => { mockCalls++; return { verdict: 'ok' }; };

        // Sub-cap pozwala tylko na 2 skany
        const res = await scanText(longText, {
            clef: mockClef,
            stateDir: env.stateDir,
            budgetPath: env.budgetPath,
            subCap: 2,
            chunkSize: 3000,
            overlap: 200,
        });

        assert.equal(res.ok, false);
        assert.equal(res.verdict, 'error');
        assert.equal(res.reason, 'budget');
        assert.equal(res.scans, 0, 'Przy przekroczeniu budżetu odmowa następuje z góry');
        assert.equal(mockCalls, 0);
        assert.equal(res.chunks, 5);
    } finally {
        env.cleanup();
    }
});

test('11. poprawność podpisu i odrzucenie sfałszowanego (wrap, sign, verify)', () => {
    const keyBuf = Buffer.from(DUMMY_KEY, 'hex');
    const url = 'https://example.com/artykul';
    const text = 'Wiarygodna treść z zewnętrznej strony internetowej.';

    // 1. Poprawne opakowanie i podpisanie
    const stamped = sign(text, url, { key: keyBuf });
    assert.match(stamped, /^<external-source url="https:\/\/example\.com\/artykul" clef="ok" sha="[0-9a-f]{64}">/);
    assert.match(stamped, /<\/external-source>\n\n<!-- clef:ok:[0-9a-f]{64} -->$/);

    // 2. Poprawna weryfikacja
    const verified = verify(stamped, { key: keyBuf });
    assert.equal(verified.ok, true);
    assert.equal(verified.url, url);
    assert.equal(verified.text, text);

    // 3. Weryfikacja także przez ogólny verifyStamp z clef_guard / core
    const coreVerified = core.verifyStamp(stamped, keyBuf);
    assert.equal(coreVerified.ok, true);

    // 4. Modyfikacja treści -> odrzucenie (bad_hmac)
    const tamperedText = stamped.replace('Wiarygodna', 'Zmanipulowana');
    assert.equal(verify(tamperedText, { key: keyBuf }).ok, false);

    // 5. Modyfikacja URL -> odrzucenie (bad_hmac)
    const tamperedUrl = stamped.replace('example.com/artykul', 'evil.com/fake');
    assert.equal(verify(tamperedUrl, { key: keyBuf }).ok, false);

    // 6. Sfałszowany stempel HMAC -> odrzucenie
    const fakeStamp = stamped.replace(/<!-- clef:ok:[0-9a-f]{64} -->/, '<!-- clef:ok:' + '9'.repeat(64) + ' -->');
    assert.equal(verify(fakeStamp, { key: keyBuf }).ok, false);

    // 7. Podmiana SHA przy zachowaniu zewnętrznego stempla
    const badSha = stamped.replace(/sha="[0-9a-f]{64}"/, 'sha="' + '0'.repeat(64) + '"');
    assert.equal(verify(badSha, { key: keyBuf }).ok, false);
});
