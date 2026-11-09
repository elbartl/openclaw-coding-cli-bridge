'use strict';
/**
 * tools/cases/test_cases_cross_edge.js
 * Niezależny zestaw testów brzegowych dla modułu Spraw DEV (cases_dev.js) i serwera MCP (cases_mcp.js).
 * Weryfikuje:
 * - Odporność transportu MCP na zniekształcone dane (null, prymitywy, prototypy, brak argumentów)
 * - Niezmienniki maszyny stanów (brama decydenta, unieważnianie zgody przy zmianie SHA/CLEF, blokada modyfikacji spraw zamkniętych)
 * - Ochronę przed podszywaniem się pod decydenta (owner/decision) i manipulacją rundami
 * - Odporność współbieżną lockfile na porzucone/uszkodzone blokady i sekwencjonowanie identyfikatorów
 * - Maskowanie wrażliwych ścieżek i tokenów w raportach / Workboard (plainText)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cases-cross-edge-'));
process.env.CASES_DEV_DIR = TMP;
process.env.CASES_DEV_NO_SYNC = '1';
process.env.CASES_OWNER_NAME = 'custom_owner';

const C = require('./cases_dev.js');
const M = require('./cases_mcp.js');

const SHA_VALID = '1234567890abcdef1234567890abcdef12345678';
const SHA_NEW = 'abcdef1234567890abcdef1234567890abcdef12';

async function rpc(msg) {
    let response = null;
    await M.handle(msg, (m) => { response = m; });
    return response;
}

async function callMcp(name, args = {}) {
    const r = await rpc({
        jsonrpc: '2.0',
        id: Math.floor(Math.random() * 100000),
        method: 'tools/call',
        params: { name, arguments: args },
    });
    const res = r.result;
    return {
        isError: res.isError,
        raw: res,
        text: res.content && res.content[0] ? res.content[0].text : '',
        json: (!res.isError && res.content && res.content[0]) ? JSON.parse(res.content[0].text) : null,
        code: res.code,
    };
}

// ---------------------------------------------------------------------------
// 1. ODPORNOŚĆ MCP NA ZŁOŚLIWE / ZNIEKSZTAŁCONE PAKIETY JSON-RPC
// ---------------------------------------------------------------------------

test('MCP Edge: obsługa komunikatów null, typów prymitywnych i brakujących nagłówków', async () => {
    // 1. null / undefined / prymitywy nie mogą wywołać nieobsłużonego wyjątku (TypeError destructuring)
    let errOccurred = false;
    try {
        await M.handle(null, () => {});
        await M.handle(undefined, () => {});
        await M.handle(12345, () => {});
        await M.handle('raw string', () => {});
        await M.handle(true, () => {});
    } catch (e) {
        errOccurred = true;
    }
    assert.strictEqual(errOccurred, false, 'Serwer MCP nie może rzucać nieobsłużonych wyjątków przy null/prymitywach');

    // 2. Komunikat bez id (powiadomienie) nie powinien generować odpowiedzi zwrotnej
    let notified = false;
    await M.handle({ jsonrpc: '2.0', method: 'ping' }, () => { notified = true; });
    assert.strictEqual(notified, false, 'Powiadomienie bez id nie może generować odpowiedzi');

    // 3. Odwołanie do metod prototypu obiektu (prototype pollution / property shadow)
    const protoChecks = ['__proto__', 'constructor', 'toString', 'valueOf', 'hasOwnProperty'];
    for (const p of protoChecks) {
        const resp = await rpc({ jsonrpc: '2.0', id: 99, method: 'tools/call', params: { name: p, arguments: {} } });
        assert.ok(resp.error, `Narzędzie ${p} powinno zwrócić błąd`);
        assert.strictEqual(resp.error.code, -32602, `Narzędzie ${p} musi mieć kod -32602 (Unknown tool)`);
    }

    // 4. tools/call z params.arguments = null lub brakującymi polami
    const nullArgs = await rpc({ jsonrpc: '2.0', id: 100, method: 'tools/call', params: { name: 'case_summary', arguments: null } });
    assert.strictEqual(nullArgs.result.isError, false, 'case_summary z arguments=null powinien zadziałać domyślnie');

    // 5. Złośliwe / niepoprawne formaty id spraw w zapytaniach MCP
    const maliciousIds = [
        '../DEV-1',
        'DEV-1/../../etc/passwd',
        'DEV-1; rm -rf /',
        'DEV-0',
        'DEV-abc',
        'DEV-99999999',
        '',
        null,
    ];
    for (const badId of maliciousIds) {
        const getRes = await callMcp('case_get', { case: badId });
        assert.strictEqual(getRes.isError, true, `case_get z identyfikatorem ${badId} musi zwrócić błąd`);
        assert.ok(getRes.text.includes('bad_id') || getRes.text.includes('not_found'), `Oczekiwano bad_id lub not_found, otrzymano: ${getRes.text}`);
    }
});

// ---------------------------------------------------------------------------
// 2. NIEZMIENNIKI MASZYNY STANÓW I BRAMY DECYZYJNEJ
// ---------------------------------------------------------------------------

test('State Machine Edge: rygorystyczna blokada samozatwierdzenia i niedozwolonych skoków', async () => {
    // Utwórz sprawę
    const cr = await callMcp('case_create', { title: 'Security Case', goal: 'Audyt bezpieczeństwa' });
    const id = cr.json.id;

    // Próba nielegalnych przeskoków z etapu 'new':
    const illegalFromNew = ['approved', 'awaiting_approval', 'deployed', 'testing', 'review', 'changes'];
    for (const targetStage of illegalFromNew) {
        const jump = await callMcp('case_stage', { case: id, to: targetStage });
        assert.strictEqual(jump.isError, true, `Przejście new -> ${targetStage} musi być zablokowane`);
        assert.ok(jump.text.includes('bad_transition'), `Oczekiwano błędu bad_transition dla new -> ${targetStage}`);
    }

    // Przejdź do coding -> review
    await callMcp('case_stage', { case: id, to: 'coding' });
    await callMcp('case_set_sha', { case: id, sha: SHA_VALID });
    await callMcp('case_stage', { case: id, to: 'review' });

    // Próba zgłoszenia do decydenta, gdy werdykt CLEF to 'quarantine' (atak injection)
    C.setClef(id, { verdict: 'quarantine', sha: SHA_VALID, reason: 'prompt injection detected' });
    const reqQuarantine = await callMcp('case_request_approval', { case: id, sha: SHA_VALID });
    assert.strictEqual(reqQuarantine.isError, true, 'Zgoda nie może być zgłoszona przy werdykcie CLEF quarantine');
    assert.ok(reqQuarantine.text.includes('clef_required'), 'Oczekiwano błędu clef_required dla skażonego diffa');

    // Próba ominięcia 'quarantine' przez bypass_reason w MCP (musi być odrzucona przez logikę scan)
    M._setDeps({
        clef: { scanCodeDiff: async () => ({ verdict: 'quarantine', reason: 'malicious prompt' }) },
        workspace: { inspectDevWorkspace: () => ({ rootDir: TMP, repos: { openclaw: { path: TMP } } }) },
        getDiff: () => 'malicious diff',
    });
    const scanMalicious = await callMcp('case_scan', { case: id, sha: SHA_VALID, bypass_reason: 'fałszywy bypass' });
    assert.strictEqual(scanMalicious.json.clef.verdict, 'quarantine');
    assert.strictEqual(scanMalicious.json.clef.bypassReason, undefined, 'bypassReason nie może być przyjęty przy werdykcie quarantine');

    // Ustaw czysty skan CLEF (ok) i zgłoś prośbę o zgodę do decydenta
    C.setClef(id, { verdict: 'ok', sha: SHA_VALID, reason: 'clean' });
    const reqClean = await callMcp('case_request_approval', { case: id, sha: SHA_VALID });
    assert.strictEqual(reqClean.isError, false);
    assert.strictEqual(reqClean.json.stage, 'awaiting_approval');

    // Próba wymuszenia wdrożenia z etapu awaiting_approval (brak zgody decydenta)
    const illegalDeploy = await callMcp('case_stage', { case: id, to: 'deployed' });
    assert.strictEqual(illegalDeploy.isError, true);
    assert.ok(illegalDeploy.text.includes('bad_transition'), 'Wdrożenie bez zatwierdzenia przez decydenta musi być zablokowane');
});

test('State Machine Edge: unieważnienie zatwierdzenia (stale) przy zmianie SHA lub werdyktu CLEF', async () => {
    const c = C.create({ title: 'Approval Invalidation Test', goal: 'Weryfikacja unieważniania' });
    const id = c.id;

    C.setStage(id, 'coding');
    C.setSha(id, SHA_VALID);
    C.setStage(id, 'review');
    C.setClef(id, { verdict: 'ok', sha: SHA_VALID });
    C.requestApproval(id, { sha: SHA_VALID });

    // Decydent zatwierdza wdrożenie dla SHA_VALID
    C.recordDecision(id, { decision: 'approve', sha: SHA_VALID, by: 'operator', via: 'cli' });
    let current = C.get(id);
    assert.strictEqual(current.stage, 'approved');
    assert.strictEqual(current.approval.status, 'approved');

    // 1. Zmiana SHA sprawy przez setSha -> automatyczne cofnięcie do review i unieważnienie zgody (stale)
    C.setSha(id, SHA_NEW);
    current = C.get(id);
    assert.strictEqual(current.stage, 'review', 'Po zmianie SHA etap musi cofnąć się do review');
    assert.strictEqual(current.approval.status, 'stale', 'Zgoda musi uzyskać status stale');
    assert.strictEqual(current.sha, SHA_NEW);

    // Ponowne zatwierdzenie dla SHA_NEW
    C.setClef(id, { verdict: 'ok', sha: SHA_NEW });
    C.requestApproval(id, { sha: SHA_NEW });
    C.recordDecision(id, { decision: 'approve', sha: SHA_NEW, by: 'operator', via: 'cli' });
    assert.strictEqual(C.get(id).stage, 'approved');

    // 2. Dodanie raportu z innym SHA (nowy commit programisty) -> natychmiastowe unieważnienie
    C.addReport(id, { agent: 'programista', text: 'Nowe poprawki', sha: SHA_VALID });
    current = C.get(id);
    assert.strictEqual(current.stage, 'review');
    assert.strictEqual(current.approval.status, 'stale');

    // 3. Zmiana werdyktu CLEF na nieakceptowalny podczas stanu approved unieważnia zgodę
    C.setClef(id, { verdict: 'ok', sha: SHA_VALID });
    C.requestApproval(id, { sha: SHA_VALID });
    C.recordDecision(id, { decision: 'approve', sha: SHA_VALID, by: 'operator', via: 'cli' });
    assert.strictEqual(C.get(id).stage, 'approved');

    C.setClef(id, { verdict: 'unverified', sha: SHA_VALID, reason: 'timeout' });
    current = C.get(id);
    assert.strictEqual(current.stage, 'review');
    assert.strictEqual(current.approval.status, 'stale');
});

test('Security Edge: podszywanie się pod decydenta i modyfikacja spraw zamkniętych', () => {
    const c = C.create({ title: 'Impersonation & Immutability Test', goal: 'Cel testu' });
    const id = c.id;

    // Próba dodania raportu z agentem = OWNER_NAME lub rodzajem 'decision'
    assert.throws(() => {
        C.addReport(id, { agent: 'custom_owner', text: 'Podrobiona zgoda decydenta' });
    }, { code: 'bad_input' });

    assert.throws(() => {
        C.addReport(id, { agent: 'programista', kind: 'decision', text: 'Zatwierdzam' });
    }, { code: 'bad_input' });

    // Dokończenie sprawy do wdrożenia (zamknięcie)
    C.setStage(id, 'coding');
    C.setSha(id, SHA_VALID);
    C.setStage(id, 'review');
    C.setClef(id, { verdict: 'ok', sha: SHA_VALID });
    C.requestApproval(id, { sha: SHA_VALID });
    C.recordDecision(id, { decision: 'approve', sha: SHA_VALID, by: 'operator', via: 'cli' });
    C.setStage(id, 'deployed');
    assert.strictEqual(C.get(id).stage, 'deployed');

    // Próba modyfikacji sprawy po zamknięciu:
    assert.throws(() => {
        C.setSha(id, SHA_NEW);
    }, { code: 'bad_transition' });

    assert.throws(() => {
        C.addReport(id, { agent: 'main', text: 'Post-deploy commit', sha: SHA_NEW });
    }, { code: 'bad_transition' });

    assert.throws(() => {
        C.setClef(id, { verdict: 'ok', sha: SHA_NEW });
    }, { code: 'bad_transition' });

    assert.throws(() => {
        C.setStage(id, 'coding');
    }, { code: 'bad_transition' });
});

// ---------------------------------------------------------------------------
// 3. ODPORNOŚĆ LOCKFILE, WSPÓŁBIEŻNOŚĆ I PRZETRWANIE AWARII
// ---------------------------------------------------------------------------

test('Concurrency & Lockfile Edge: przejęcie przeterminowanej blokady bez pid lub ze śmieciowym pid', () => {
    const lockDir = path.join(TMP, '.lock');

    // 1. Symulacja starej blokady (> 30s) po procesie, który nie istnieje (martwy PID 999999)
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'pid'), '9999999');
    const pastTime = (Date.now() - 35000) / 1000;
    fs.utimesSync(lockDir, pastTime, pastTime);

    // Nowa operacja powinna wykryć martwy PID, przejąć blokadę i pomyślnie wykonać akcję
    const newCase = C.create({ title: 'Lock Recovery Case', goal: 'Odzyskiwanie blokady' });
    assert.ok(newCase.id);
    assert.strictEqual(fs.existsSync(lockDir), false, 'Blokada powinna zostać zwolniona w finally');

    // 2. Symulacja starej blokady z uszkodzonym/pustym plikiem pid
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(path.join(lockDir, 'pid'), 'nie-liczba');
    fs.utimesSync(lockDir, pastTime, pastTime);

    const recoveryCase = C.create({ title: 'Corrupted PID Recovery', goal: 'Odzyskiwanie uszkodzonego pid' });
    assert.ok(recoveryCase.id);
    assert.strictEqual(fs.existsSync(lockDir), false);
});

test('Resilience Edge: odporność isDevOpen i magazynu na uszkodzone pliki JSON', () => {
    // Utwórz plik ze zniekształconym JSON
    const corruptId = 'DEV-888';
    const corruptPath = path.join(TMP, `${corruptId}.json`);
    fs.writeFileSync(corruptPath, '{ to nie jest poprawny json', { mode: 0o600 });

    const openCheck = C.isDevOpen(corruptId);
    assert.strictEqual(openCheck.ok, false);
    assert.ok(openCheck.reason.includes('Błąd odczytu') || openCheck.reason.includes('uszkodzony'));

    // Błędna struktura pliku (brak wymaganych pól history/reports)
    const invalidStructId = 'DEV-889';
    const invalidStructPath = path.join(TMP, `${invalidStructId}.json`);
    fs.writeFileSync(invalidStructPath, JSON.stringify({ id: invalidStructId, stage: 'new' }), { mode: 0o600 });

    const openCheck2 = C.isDevOpen(invalidStructId);
    assert.strictEqual(openCheck2.ok, false);
    assert.ok(openCheck2.reason.includes('nieprawidłową strukturę') || openCheck2.reason.includes('Błąd'));

    // Sprzątanie po teście
    try { fs.unlinkSync(corruptPath); } catch (_) {}
    try { fs.unlinkSync(invalidStructPath); } catch (_) {}
});

// ---------------------------------------------------------------------------
// 4. SANITYZACJA ŚCIEŻEK I POUFNYCH DANYCH (plainText)
// ---------------------------------------------------------------------------

test('Sanitization Edge: maskowanie ścieżek sekretów, kluczy SSH i piaskownic w plainText', () => {
    const rawReport = `
WYNIK: OK
Przetestowano integrację z kluczem w ~/.openclaw/secrets/clef-guard.key oraz certyfikatem.
Podglądano konfigurację $HOME/.openclaw/secrets/prod.json oraz /home/administrator/.openclaw/secrets/db.key.
Dodatkowo zweryfikowano klucz /home/user/.ssh/id_rsa i ~/.ssh/known_hosts.
Ścieżka robocza worktree: /home/user/projects/openclaw/.worktrees/DEV-10/openclaw/src/index.js.
Odnośnik: [plik konfiguracyjny](file:///etc/hosts).
    `.trim();

    const cleaned = C._plainText(rawReport);

    assert.ok(!cleaned.includes('.openclaw/secrets'), 'Żadna ścieżka .openclaw/secrets nie może wyciec');
    assert.ok(!cleaned.includes('.ssh/id_rsa'), 'Ścieżka klucza SSH nie może wyciec');
    assert.ok(!cleaned.includes('.worktrees/DEV-10/openclaw/'), 'Wewnętrzna ścieżka piaskownicy nie może wyciec');
    assert.ok(!cleaned.includes('file:///etc/hosts'), 'Protokół file:// musi zostać usunięty');
    assert.ok(cleaned.includes('[ścieżka sekretu]'), 'Zastąpiono zmaskowanym znacznikiem [ścieżka sekretu]');
});
