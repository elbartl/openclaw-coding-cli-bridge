'use strict';
/**
 * tools/webread/scan.edge.test.js
 * Niezależne testy brzegowe i adwersaryjne modułu skanera CLEF (tools/webread/scan.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { scanText, splitChunks, wrap, sign, verify } = require('./scan');

function makeTmpDir() {
    return fs.mkdtempSync(path.join(os.tmpdir(), 'webread-scan-edge-'));
}

test('Scan edge: podział na kawałki i gwarancje nakładania (overlap)', () => {
    // 1. Instrukcja o długości <= 200 znaków (overlap)
    const chunkSize = 3000;
    const overlap = 200;
    const prefix = 'A'.repeat(2950);
    const injection = 'INJECTION_COMMAND_UNDER_200_CHARS_X'.repeat(4); // ~140 znaków
    assert.ok(injection.length <= overlap);

    const fullText = prefix + injection + 'B'.repeat(1000);
    const chunks = splitChunks(fullText, chunkSize, overlap);
    assert.strictEqual(chunks.length, 2);

    // Kawałek 2 zaczyna się od 2800, więc zawiera całą instrukcję od 2950 do 3090
    assert.ok(chunks[1].includes(injection), 'Kawałek 2 musi zawierać pełną instrukcję dzięki nakładaniu');
});

test('Scan edge [ANALIZA BRZEGOWA]: instrukcja injection dłuższa niż overlap (200 znaków) na granicy okna', () => {
    // Gdy payload injection jest dłuższy niż overlap (np. 250 znaków) i przecina granicę 3000 znaków
    // (od znaku 2780 do 3030), kawałek 0 zawiera tylko [2780..3000) (ucięty koniec),
    // a kawałek 1 zawiera tylko [2800..3030) (ucięty początek).
    const chunkSize = 3000;
    const overlap = 200;
    const prefix = 'A'.repeat(2780);
    const longInjection = 'SYSTEM_PROMPT_OVERRIDE_PAYLOAD_'.repeat(8); // 248 znaków
    assert.ok(longInjection.length > overlap);

    const fullText = prefix + longInjection + 'B'.repeat(500);
    const chunks = splitChunks(fullText, chunkSize, overlap);

    // Żaden z kawałków nie zawiera pełnego 248-znakowego ciągu
    const chunk0HasFull = chunks[0].includes(longInjection);
    const chunk1HasFull = chunks[1].includes(longInjection);
    assert.strictEqual(chunk0HasFull, false, 'Kawałek 0 ma ucięty koniec instrukcji');
    assert.strictEqual(chunk1HasFull, false, 'Kawałek 1 ma ucięty początek instrukcji');
});

test('Scan edge [REPRODUKCJA BŁĘDU]: wyścig równoległych zapytań do budget.json (brak użycia lockfile)', async () => {
    // Plik budget.lock jest zdefiniowany w getWebreadPaths, ale NIGDY nie jest używany.
    // Przy równoległych zapytaniach jednoczesny odczyt i zapis gubi liczniki used/scans/calls!
    const tmpDir = makeTmpDir();
    const budgetPath = path.join(tmpDir, 'budget.json');

    try {
        const slowClef = async () => {
            await new Promise(r => setTimeout(r, 40));
            return { verdict: 'ok', p: { injection: 0, hijack: 0 }, neurons: 10 };
        };

        // 5 równoległych wywołań po 1 kawałku
        const tasks = [1, 2, 3, 4, 5].map(i => scanText('Raport pracownika ' + i, {
            clef: slowClef,
            budgetPath,
            stateDir: tmpDir,
        }));

        await Promise.all(tasks);

        assert.ok(fs.existsSync(budgetPath), 'Plik budget.json musi istnieć');
        const b = JSON.parse(fs.readFileSync(budgetPath, 'utf8'));

        // LUKA: Wszystkie 5 wątków odczytało used=0 na początku i nadpisało plik,
        // w efekcie used=10 zamiast 50, a calls=1 zamiast 5!
        assert.strictEqual(b.calls, 5, `LUKA WYŚCIGU: Oczekiwano calls=5, zapisano ${b.calls}`);
        assert.strictEqual(b.scans, 5, `LUKA WYŚCIGU: Oczekiwano scans=5, zapisano ${b.scans}`);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Scan edge: puste wejście, ogromne wejście i wyłącznik awaryjny (DISABLED)', async () => {
    const tmpDir = makeTmpDir();
    try {
        // 1. Puste wejście
        const resEmpty = await scanText('', { stateDir: tmpDir });
        assert.strictEqual(resEmpty.ok, true);
        assert.strictEqual(resEmpty.scans, 0);
        assert.strictEqual(resEmpty.reason, 'empty');

        // 2. Wyłącznik awaryjny DISABLED
        fs.writeFileSync(path.join(tmpDir, 'DISABLED'), 'emergency stop');
        const resDisabled = await scanText('Normalny tekst', { stateDir: tmpDir });
        assert.strictEqual(resDisabled.ok, false);
        assert.strictEqual(resDisabled.verdict, 'error');
        assert.strictEqual(resDisabled.reason, 'disabled');
        assert.strictEqual(resDisabled.scans, 0);
    } finally {
        fs.rmSync(tmpDir, { recursive: true, force: true });
    }
});

test('Scan edge: kryptograficzna weryfikacja podpisu, integralności tekstu i URL', () => {
    const key = crypto.randomBytes(32);
    const url = 'https://docs.example.com/security';
    const text = 'Wszystkie systemy operacyjne są zaktualizowane.';

    const signed = sign(text, url, { key });
    assert.ok(signed.includes('<!-- clef:ok:'));

    // 1. Poprawny podpis
    const vOk = verify(signed, { key });
    assert.strictEqual(vOk.ok, true);
    assert.strictEqual(vOk.url, url);
    assert.strictEqual(vOk.text, text);

    // 2. Sfałszowany stempel HMAC
    const fakeHmac = signed.replace(/<!-- clef:ok:[0-9a-fA-F]{64} -->/, '<!-- clef:ok:' + '0'.repeat(64) + ' -->');
    const vFake = verify(fakeHmac, { key });
    assert.strictEqual(vFake.ok, false);
    assert.strictEqual(vFake.reason, 'bad_hmac');

    // 3. Zmodyfikowana treść przy zachowaniu stempla
    const tamperedText = signed.replace('są zaktualizowane', 'są ZAINFEKOWANE');
    const vTampered = verify(tamperedText, { key });
    assert.strictEqual(vTampered.ok, false);
    assert.strictEqual(vTampered.reason, 'bad_hmac');

    // 4. Podmieniony URL w wrapperze przy zachowaniu stempla
    const tamperedUrl = signed.replace(url, 'https://evil.com/phishing');
    const vTamperedUrl = verify(tamperedUrl, { key });
    assert.strictEqual(vTamperedUrl.ok, false);
    assert.strictEqual(vTamperedUrl.reason, 'bad_hmac');
});
