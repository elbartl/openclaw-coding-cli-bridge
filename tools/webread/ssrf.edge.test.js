'use strict';
/**
 * tools/webread/ssrf.edge.test.js
 * Niezależne testy brzegowe i adwersaryjne modułu SSRF (tools/webread/ssrf.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { isPrivateIp, validateUrl, safeFetch } = require('./ssrf');

test('SSRF edge: IPv4 formy specjalne, CGNAT i granice adresacji', () => {
    // 0.0.0.0/8
    assert.strictEqual(isPrivateIp('0.0.0.0'), true, '0.0.0.0 musi być zablokowany');
    assert.strictEqual(isPrivateIp('0.255.255.255'), true, '0/8 musi być zablokowany');

    // 100.64.0.0/10 (CGNAT RFC 6598: 100.64.0.0 do 100.127.255.255)
    assert.strictEqual(isPrivateIp('100.64.0.1'), true, '100.64.0.1 (CGNAT) musi być prywatny');
    assert.strictEqual(isPrivateIp('100.127.255.254'), true, '100.127.255.254 (CGNAT górna granica) musi być prywatny');
    assert.strictEqual(isPrivateIp('100.63.255.255'), false, '100.63.x.x poza CGNAT musi być publiczny');
    assert.strictEqual(isPrivateIp('100.128.0.1'), false, '100.128.x.x poza CGNAT musi być publiczny');

    // 127.0.0.0/8 Loopback
    assert.strictEqual(isPrivateIp('127.0.0.2'), true, '127.0.0.2 musi być prywatny');
    assert.strictEqual(isPrivateIp('127.255.255.254'), true, '127.255.255.254 musi być prywatny');

    // 169.254.0.0/16 Link-local
    assert.strictEqual(isPrivateIp('169.254.1.1'), true, '169.254.1.1 musi być prywatny');
});

test('SSRF edge: IPv6 adresy zwarte, rozwinięte i specjalne', () => {
    // Unspecified ::
    assert.strictEqual(isPrivateIp('::'), true, ':: musi być prywatny');
    assert.strictEqual(isPrivateIp('0:0:0:0:0:0:0:0'), true, 'rozwinięte 0:0:0:0:0:0:0:0 musi być prywatne');

    // Loopback ::1
    assert.strictEqual(isPrivateIp('::1'), true, '::1 musi być prywatny');
    assert.strictEqual(isPrivateIp('0:0:0:0:0:0:0:1'), true, 'rozwinięte 0:0:0:0:0:0:0:1 musi być prywatne');

    // ULA fc00::/7 (fc00 do fdff)
    assert.strictEqual(isPrivateIp('fc00::1'), true, 'fc00::1 musi być prywatny');
    assert.strictEqual(isPrivateIp('fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), true, 'fdff:: musi być prywatny');

    // Link-Local fe80::/10 (fe80 do febf)
    assert.strictEqual(isPrivateIp('fe80::1'), true, 'fe80::1 musi być prywatny');
    assert.strictEqual(isPrivateIp('febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff'), true, 'febf:: musi być prywatny');

    // Multicast ff00::/8
    assert.strictEqual(isPrivateIp('ff01::1'), true, 'ff01::1 musi być prywatny');
    assert.strictEqual(isPrivateIp('ff02::1'), true, 'ff02::1 musi być prywatny');

    // IPv4-mapped z prywatnym i publicznym IPv4
    assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'), true, '::ffff:127.0.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('::ffff:10.0.0.1'), true, '::ffff:10.0.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('::ffff:93.184.216.34'), false, '::ffff:public IPv4 musi być publiczny');

    // 64:ff9b:: WKP (RFC 6052)
    assert.strictEqual(isPrivateIp('64:ff9b::127.0.0.1'), true, '64:ff9b::127.0.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('64:ff9b::93.184.216.34'), false, '64:ff9b::public musi być publiczny');
});

test('SSRF edge [REPRODUKCJA BŁĘDU]: luka weryfikacji IPv4-compatible (::127.0.0.1) oraz SIIT (::ffff:0:127.0.0.1)', () => {
    // BŁĄD 1: IPv4-compatible IPv6 (RFC 4291) - np. ::127.0.0.1 lub ::10.0.0.1
    // Funkcja isPrivateIp zwraca dla nich false (uważa je za publiczne!), umożliwiając SSRF do localhost przez AAAA.
    const isCompatPrivate = isPrivateIp('::127.0.0.1');
    assert.strictEqual(isCompatPrivate, true, 'LUKA: ::127.0.0.1 (IPv4-compatible loopback) nie może być uznany za publiczny');

    // BŁĄD 2: SIIT IPv4-translated (RFC 2765 / RFC 6052) - ::ffff:0:a.b.c.d
    // isPrivateIp sprawdza tylko w[5] === 0xffff, a dla SIIT w[4] === 0xffff && w[5] === 0, zwracając false!
    const isSiitPrivate = isPrivateIp('::ffff:0:127.0.0.1');
    assert.strictEqual(isSiitPrivate, true, 'LUKA: ::ffff:0:127.0.0.1 (SIIT IPv4-translated loopback) nie może być uznany za publiczny');
});

test('SSRF edge: validateUrl odrzuca obfuskowane IP, niebezpieczne schematy i poświadczenia', () => {
    // Obfuskowane formy IP
    assert.strictEqual(validateUrl('http://0177.0.0.1/').ok, false, 'octal IP musi być odrzucony');
    assert.strictEqual(validateUrl('http://0x7f000001/').ok, false, 'hex IP musi być odrzucony');
    assert.strictEqual(validateUrl('http://0x7f.0.0.1/').ok, false, 'mieszany hex/dec IP musi być odrzucony');
    assert.strictEqual(validateUrl('http://2130706433/').ok, false, 'dword numeric IP musi być odrzucony');
    assert.strictEqual(validateUrl('http://127.1/').ok, false, 'skrótowy IP musi być odrzucony');

    // Poświadczenia
    assert.strictEqual(validateUrl('http://user:pass@example.com/').ok, false, 'user:pass musi być odrzucony');
    assert.strictEqual(validateUrl('http://user@example.com/').ok, false, 'user@ musi być odrzucony');
    assert.strictEqual(validateUrl('http://:pass@example.com/').ok, false, ':pass@ musi być odrzucony');

    // Nietypowe schematy
    assert.strictEqual(validateUrl('file:///etc/passwd').ok, false, 'file: musi być odrzucony');
    assert.strictEqual(validateUrl('ftp://example.com/file').ok, false, 'ftp: musi być odrzucony');
    assert.strictEqual(validateUrl('gopher://example.com/').ok, false, 'gopher: musi być odrzucony');
    assert.strictEqual(validateUrl('data:text/html,test').ok, false, 'data: musi być odrzucony');
    assert.strictEqual(validateUrl('javascript:alert(1)').ok, false, 'javascript: musi być odrzucony');
});

test('SSRF edge: safeFetch obsługa przekierowań (względne, puste, zapętlone, public->private)', async () => {
    // 1. Przekierowanie z pustym nagłówkiem Location
    const mockEmptyLocationFetch = async () => ({
        status: 302,
        headers: { 'content-type': 'text/html' }, // brak Location
        body: '',
    });
    const resEmpty = await safeFetch('http://example.com/start', {
        lookup: () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: mockEmptyLocationFetch,
    });
    assert.strictEqual(resEmpty.ok, false);
    assert.strictEqual(resEmpty.reason, 'redirect_missing_location');

    // 2. Przekierowanie względne Location: /target
    let hop = 0;
    const mockRelativeRedirectFetch = async (url) => {
        hop++;
        if (hop === 1) {
            return {
                status: 302,
                headers: { 'location': '/destination', 'content-type': 'text/html' },
                body: '',
            };
        }
        return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: '<html><body>Destination reached</body></html>',
        };
    };
    const resRel = await safeFetch('http://example.com/start', {
        lookup: () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: mockRelativeRedirectFetch,
    });
    assert.strictEqual(resRel.ok, true);
    assert.strictEqual(resRel.finalUrl, 'http://example.com/destination');

    // 3. Przekierowanie publiczny -> prywatny IP
    let hopPriv = 0;
    const mockPrivRedirectFetch = async () => {
        hopPriv++;
        if (hopPriv === 1) {
            return {
                status: 302,
                headers: { 'location': 'http://127.0.0.1/admin', 'content-type': 'text/html' },
                body: '',
            };
        }
        return { status: 200, headers: { 'content-type': 'text/html' }, body: 'leak' };
    };
    const resPriv = await safeFetch('http://example.com/start', {
        lookup: () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: mockPrivRedirectFetch,
    });
    assert.strictEqual(resPriv.ok, false);
    assert.strictEqual(resPriv.reason, 'private_ip');
});

test('SSRF edge: safeFetch DNS rebinding i przypięcie IP (IP pinning)', async () => {
    // DNS rebinding: pierwsze zapytanie zwraca publiczny IP, drugie (przy przekierowaniu) zwraca prywatny IP
    let lookupCount = 0;
    const rebindingLookup = async () => {
        lookupCount++;
        if (lookupCount === 1) {
            return [{ address: '93.184.216.34', family: 4 }];
        }
        return [{ address: '192.168.1.100', family: 4 }];
    };

    let fetchCount = 0;
    const mockRedirectFetch = async () => {
        fetchCount++;
        return {
            status: 302,
            headers: { 'location': 'http://rebinding.target.com/hop2', 'content-type': 'text/html' },
            body: '',
        };
    };

    const resRebind = await safeFetch('http://rebinding.target.com/start', {
        lookup: rebindingLookup,
        fetchImpl: mockRedirectFetch,
    });
    assert.strictEqual(resRebind.ok, false);
    assert.strictEqual(resRebind.reason, 'private_ip');
});

test('SSRF edge: limit strumienia w safeFetch (too_large) i ochrona przed buforowaniem', async () => {
    // Generowanie odpowiedzi przekraczającej 2MB (2 * 1024 * 1024)
    const bigChunk = Buffer.alloc(1024 * 1024, 'a'); // 1MB
    const makeStream = () => {
        const { Readable } = require('node:stream');
        let count = 0;
        return new Readable({
            read() {
                if (count < 3) { // 3MB total
                    count++;
                    this.push(bigChunk);
                } else {
                    this.push(null);
                }
            },
        });
    };

    const mockBigFetch = async () => ({
        status: 200,
        headers: { 'content-type': 'text/plain' },
        body: makeStream(),
    });

    const res = await safeFetch('http://example.com/bigfile', {
        lookup: () => [{ address: '93.184.216.34', family: 4 }],
        fetchImpl: mockBigFetch,
        maxBytes: 2 * 1024 * 1024,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'too_large');
    assert.strictEqual(res.body, undefined, 'Treść częściowa nie może zostać zwrócona');
});

test('SSRF edge (runda 3): pobranie domyślnym klientem Node 24 (bez fetchImpl) i przekierowanie 302 z IP pinning', async () => {
    let hops = [];
    const server = http.createServer((req, res) => {
        hops.push(req.url);
        if (req.url === '/hop1') {
            res.writeHead(302, { Location: '/hop2' });
            res.end();
        } else if (req.url === '/hop2') {
            res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end('Odpowiedź z hop2');
        }
    });

    await new Promise(r => server.listen(0, '127.0.0.1', r));
    const port = server.address().port;

    try {
        const res = await safeFetch(`http://127.0.0.1:${port}/hop1`, {
            _allowPrivateForTesting: true,
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.finalUrl, `http://127.0.0.1:${port}/hop2`);
        assert.strictEqual(res.body.toString('utf8'), 'Odpowiedź z hop2');
        assert.deepStrictEqual(hops, ['/hop1', '/hop2']);
    } finally {
        await new Promise(r => server.close(r));
    }
});

test('SSRF edge (runda 3): wariant https z certyfikatem samopodpisanym odrzucany fail-closed', async () => {
    const { execSync } = require('node:child_process');
    const https = require('node:https');
    const fs = require('node:fs');
    const path = require('node:path');
    const os = require('node:os');

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cert-test-'));
    const keyFile = path.join(tmp, 'key.pem');
    const certFile = path.join(tmp, 'cert.pem');

    try {
        execSync(`openssl req -x509 -newkey rsa:2048 -keyout "${keyFile}" -out "${certFile}" -days 1 -nodes -subj "/CN=127.0.0.1"`, { stdio: 'pipe' });
        const key = fs.readFileSync(keyFile);
        const cert = fs.readFileSync(certFile);

        const server = https.createServer({ key, cert }, (req, res) => {
            res.writeHead(200, { 'Content-Type': 'text/plain' });
            res.end('https secret');
        });

        await new Promise(r => server.listen(0, '127.0.0.1', r));
        const port = server.address().port;

        try {
            const res = await safeFetch(`https://127.0.0.1:${port}/`, {
                _allowPrivateForTesting: true,
            });
            // Żądanie HTTPS z certyfikatem samopodpisanym bez dodanego CA musi być odrzucone (fail-closed)
            assert.strictEqual(res.ok, false);
            assert.ok(
                res.reason.includes('self-signed certificate') ||
                res.reason.includes('certificate') ||
                res.reason.includes('fetch_error')
            );
        } finally {
            await new Promise(r => server.close(r));
        }
    } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
    }
});

test('SSRF edge (runda 3): weryfikacja isPrivateIp dla prefiksów RFC 8215 (64:ff9b:1::/48) oraz RFC 6052 (64:ff9b::/96)', () => {
    // RFC 8215 Local-Use IPv4/IPv6 Translation Prefix: 64:ff9b:1::/48 - ZAWSZE prywatny (bez względu na końcówkę)
    assert.strictEqual(isPrivateIp('64:ff9b:1::8.8.8.8'), true, '64:ff9b:1::8.8.8.8 musi być prywatny (RFC 8215)');
    assert.strictEqual(isPrivateIp('64:ff9b:1:ffff::1'), true, '64:ff9b:1:ffff::1 musi być prywatny (RFC 8215)');
    assert.strictEqual(isPrivateIp('0064:FF9B:0001:0000:0000:0000:0808:0808'), true, 'Wielkie litery i pełna postać RFC 8215 musi być prywatna');

    // RFC 6052 Well-Known Prefix: 64:ff9b::/96 - prywatny gdy osadzony IPv4 jest prywatny, publiczny gdy IPv4 jest publiczny
    assert.strictEqual(isPrivateIp('64:ff9b::7f00:1'), true, '64:ff9b::7f00:1 (127.0.0.1) musi być prywatny');
    assert.strictEqual(isPrivateIp('64:ff9b::a00:1'), true, '64:ff9b::a00:1 (10.0.0.1) musi być prywatny');
    assert.strictEqual(isPrivateIp('64:ff9b::c0a8:101'), true, '64:ff9b::c0a8:101 (192.168.1.1) musi być prywatny');
    assert.strictEqual(isPrivateIp('64:ff9b::808:808'), false, '64:ff9b::808:808 (8.8.8.8) musi być publiczny');
    assert.strictEqual(isPrivateIp('0064:FF9B:0000:0000:0000:0000:7F00:0001'), true, 'Pełna postać z 127.0.0.1 musi być prywatna');
    assert.strictEqual(isPrivateIp('0064:FF9B:0000:0000:0000:0000:0808:0808'), false, 'Pełna postać z 8.8.8.8 musi być publiczna');
    assert.strictEqual(isPrivateIp('64:FF9B::C0A8:0101'), true, 'Wielkie litery z 192.168.1.1 muszą być prywatne');
});

