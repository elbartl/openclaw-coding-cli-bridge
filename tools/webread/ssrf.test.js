'use strict';
const test = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { Readable } = require('node:stream');
const { isPrivateIp, validateUrl, safeFetch, ALLOWED_CONTENT_TYPES, createPinnedLookup, buildRequestOptions } = require('./ssrf');

const MOCK_PUBLIC_IP = '93.184.216.34';
const mockPublicLookup = () => [{ address: MOCK_PUBLIC_IP, family: 4 }];

test('isPrivateIp: blokuje adresy prywatne IPv4, IPv6, localhost i nieparsowalne (fail-closed)', () => {
    // IPv4 spec test cases
    assert.strictEqual(isPrivateIp('127.0.0.1'), true, '127.0.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('192.168.1.5'), true, '192.168.1.5 musi być prywatny');
    assert.strictEqual(isPrivateIp('10.0.0.1'), true, '10.0.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('169.254.169.254'), true, '169.254.169.254 musi być prywatny');
    assert.strictEqual(isPrivateIp('0.0.0.0'), true, '0.0.0.0 musi być prywatny');
    assert.strictEqual(isPrivateIp('100.64.0.1'), true, '100.64.0.1 (CGNAT) musi być prywatny');
    assert.strictEqual(isPrivateIp('172.16.0.1'), true, '172.16.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('172.31.255.254'), true, '172.31.255.254 musi być prywatny');
    assert.strictEqual(isPrivateIp('172.32.0.1'), false, '172.32.0.1 musi być publiczny');
    assert.strictEqual(isPrivateIp('224.0.0.1'), true, '224.0.0.1 (multicast) musi być prywatny/zablokowany');
    assert.strictEqual(isPrivateIp('240.0.0.1'), true, '240.0.0.1 (reserved) musi być zablokowany');
    assert.strictEqual(isPrivateIp('255.255.255.255'), true, '255.255.255.255 musi być zablokowany');

    // IPv6 spec test cases
    assert.strictEqual(isPrivateIp('::1'), true, '::1 musi być prywatny');
    assert.strictEqual(isPrivateIp('[::1]'), true, '[::1] musi być prywatny');
    assert.strictEqual(isPrivateIp('::'), true, ':: musi być prywatny');
    assert.strictEqual(isPrivateIp('fc00::1'), true, 'fc00::1 (ULA) musi być prywatny');
    assert.strictEqual(isPrivateIp('fd12:3456::1'), true, 'fd12::1 (ULA) musi być prywatny');
    assert.strictEqual(isPrivateIp('fe80::1'), true, 'fe80::1 (Link-local) musi być prywatny');
    assert.strictEqual(isPrivateIp('ff02::1'), true, 'ff02::1 (Multicast) musi być prywatny');

    // IPv4-mapped IPv6
    assert.strictEqual(isPrivateIp('::ffff:127.0.0.1'), true, '::ffff:127.0.0.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('[::ffff:127.0.0.1]'), true, '[::ffff:127.0.0.1] musi być prywatny');
    assert.strictEqual(isPrivateIp('::ffff:192.168.1.1'), true, '::ffff:192.168.1.1 musi być prywatny');
    assert.strictEqual(isPrivateIp('::ffff:93.184.216.34'), false, '::ffff:public IPv4 musi być publiczny');

    // RFC 8215 (64:ff9b:1::/48) oraz RFC 6052 (64:ff9b::/96)
    assert.strictEqual(isPrivateIp('64:ff9b:1::8.8.8.8'), true, '64:ff9b:1::/48 musi być bezwarunkowo prywatny');
    assert.strictEqual(isPrivateIp('64:ff9b::7f00:1'), true, '64:ff9b::7f00:1 (127.0.0.1) musi być prywatny');
    assert.strictEqual(isPrivateIp('64:ff9b::808:808'), false, '64:ff9b::808:808 (8.8.8.8) musi być publiczny');

    // Fail-closed dla nazw, hex, octal i śmieciowych wejść
    assert.strictEqual(isPrivateIp('localhost'), true, 'localhost nie jest parsowalnym IP -> fail-closed');
    assert.strictEqual(isPrivateIp('0x7f000001'), true, '0x7f000001 nie jest standardowym IP -> fail-closed');
    assert.strictEqual(isPrivateIp('2130706433'), true, '2130706433 nie jest standardowym IP -> fail-closed');
    assert.strictEqual(isPrivateIp(''), true, 'pusty string -> fail-closed');
    assert.strictEqual(isPrivateIp(null), true, 'null -> fail-closed');
    assert.strictEqual(isPrivateIp(undefined), true, 'undefined -> fail-closed');
    assert.strictEqual(isPrivateIp('invalid.ip.address'), true, 'niepoprawny format -> fail-closed');

    // Adresy publiczne
    assert.strictEqual(isPrivateIp('93.184.216.34'), false, '93.184.216.34 musi być publiczny');
    assert.strictEqual(isPrivateIp('8.8.8.8'), false, '8.8.8.8 musi być publiczny');
    assert.strictEqual(isPrivateIp('2606:2800:220:1:248:1893:25c8:1946'), false, 'publiczny IPv6 musi być publiczny');
});

test('validateUrl: odrzuca niebezpieczne schematy, poświadczenia, nazwy lokalne i formy numeryczne/hex/octal', () => {
    const blockedList = [
        ['http://127.0.0.1/', 'private_ip'],
        ['http://192.168.1.5/', 'private_ip'],
        ['http://10.0.0.1/', 'private_ip'],
        ['http://169.254.169.254/latest/meta-data/', 'private_ip'],
        ['http://localhost/', 'localhost_not_allowed'],
        ['http://sub.localhost/', 'localhost_not_allowed'],
        ['http://[::1]/', 'private_ip'],
        ['http://[::ffff:127.0.0.1]/', 'private_ip'],
        ['http://0x7f000001/', 'hex_ip_not_allowed'],
        ['http://2130706433/', 'numeric_ip_not_allowed'],
        ['http://0177.0.0.1/', 'octal_ip_not_allowed'],
        ['http://printer.local/', 'local_not_allowed'],
        ['http://db.internal/', 'internal_not_allowed'],
        ['http://nas.lan/', 'private_domain_not_allowed'],
        ['http://ha.home/', 'private_domain_not_allowed'],
        ['http://device.home.arpa/', 'private_domain_not_allowed'],
        ['http://vpn.ts.net/', 'private_domain_not_allowed'],
        ['http://user:secret@public.example.com/', 'credentials_not_allowed'],
        ['ftp://public.example.com/', 'unsupported_protocol'],
        ['file:///etc/passwd', 'unsupported_protocol'],
        ['javascript:alert(1)', 'unsupported_protocol'],
        ['http://singlelabel/', 'single_label_host_not_allowed'],
    ];

    for (const [url, expectedReason] of blockedList) {
        const res = validateUrl(url);
        assert.strictEqual(res.ok, false, `URL ${url} powinien być odrzucony`);
        if (expectedReason) {
            assert.strictEqual(res.reason, expectedReason, `URL ${url} powód ${res.reason} != ${expectedReason}`);
        }
    }

    // Poprawne adresy URL
    const validList = [
        'http://example.com/',
        'https://example.com/path?query=1#hash',
        'https://docs.python.org/3/library/os.html',
        'http://93.184.216.34/index.html',
    ];
    for (const url of validList) {
        const res = validateUrl(url);
        assert.strictEqual(res.ok, true, `URL ${url} powinien być poprawny`);
        assert.strictEqual(typeof res.url, 'string');
    }
});

test('validateUrl: opcja allowHosts zezwala tylko na dozwolone hosty', () => {
    const allowHosts = ['example.com', 'docs.python.org'];

    const denied = validateUrl('https://malicious.org/page', { allowHosts });
    assert.strictEqual(denied.ok, false);
    assert.strictEqual(denied.reason, 'host_not_allowed');

    const allowed1 = validateUrl('https://example.com/test', { allowHosts });
    assert.strictEqual(allowed1.ok, true);

    const allowedSub = validateUrl('https://sub.example.com/test', { allowHosts });
    assert.strictEqual(allowedSub.ok, true);

    const allowedDoc = validateUrl('https://docs.python.org/3/', { allowHosts });
    assert.strictEqual(allowedDoc.ok, true);
});

test('safeFetch: natychmiastowa odmowa dla adresów prywatnych z listy wymagań', async () => {
    const urls = [
        'http://127.0.0.1/',
        'http://192.168.1.5/',
        'http://10.0.0.1/',
        'http://169.254.169.254/',
        'http://localhost/',
        'http://[::1]/',
        'http://[::ffff:127.0.0.1]/',
        'http://0x7f000001/',
        'http://2130706433/',
    ];

    for (const url of urls) {
        const res = await safeFetch(url);
        assert.strictEqual(res.ok, false, `URL ${url} powinien zostać zablokowany`);
        assert.ok(res.reason, `URL ${url} musi mieć podany powód odmowy`);
    }
});

test('safeFetch: DNS rebinding - odrzucenie hosta z mieszaną listą adresów publiczny + prywatny', async () => {
    const mixedLookup = () => [
        { address: '93.184.216.34', family: 4 },
        { address: '127.0.0.1', family: 4 },
    ];

    let fetchCalled = false;
    const fetchImpl = async () => {
        fetchCalled = true;
        return { status: 200, headers: { 'content-type': 'text/html' }, body: 'OK' };
    };

    const res = await safeFetch('http://rebind-mixed.example.com/', {
        lookup: mixedLookup,
        fetchImpl,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'private_ip');
    assert.strictEqual(fetchCalled, false, 'fetchImpl nie może być wywołany, jeśli DNS zawiera prywatny IP');
});

test('safeFetch: DNS rebinding - lookup zwraca publiczny za 1. razem, prywatny za 2. razem przy przekierowaniu', async () => {
    let lookupCount = 0;
    const rebindLookup = (hostname) => {
        lookupCount++;
        if (lookupCount === 1) {
            return [{ address: '93.184.216.34', family: 4 }];
        }
        return [{ address: '192.168.1.100', family: 4 }];
    };

    const fetchImpl = async (url) => {
        return {
            status: 302,
            headers: { location: 'http://rebind-step2.example.com/target' },
            body: '',
        };
    };

    const res = await safeFetch('http://rebind-step1.example.com/', {
        lookup: rebindLookup,
        fetchImpl,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'private_ip');
    assert.strictEqual(lookupCount, 2, 'lookup musiał być sprawdzony dla obu hopów');
});

test('safeFetch: przekierowanie publiczny -> prywatny zostaje zablokowane', async () => {
    const fetchImpl = async (url) => {
        return {
            status: 302,
            headers: { location: 'http://192.168.1.5/admin' },
            body: '',
        };
    };

    const res = await safeFetch('http://public.example.com/', {
        lookup: mockPublicLookup,
        fetchImpl,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'private_ip');
});

test('safeFetch: przekroczenie limitu przekierowań (>5) zwraca reason: too_many_redirects', async () => {
    let hop = 0;
    const fetchImpl = async (url) => {
        hop++;
        return {
            status: 302,
            headers: { location: `http://public.example.com/redirect-${hop}` },
            body: '',
        };
    };

    const res = await safeFetch('http://public.example.com/start', {
        lookup: mockPublicLookup,
        fetchImpl,
        maxRedirects: 5,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'too_many_redirects');
    assert.strictEqual(hop, 6, 'Powinno wykonać dokładnie 6 prób przekierowania przed odmową');
});

test('safeFetch: limit bajtów w trakcie strumienia (too_large) bez częściowej treści', async () => {
    const fetchImpl = async () => {
        const stream = new Readable({
            read() {
                this.push(Buffer.alloc(40, 'a'));
                this.push(Buffer.alloc(40, 'b'));
                this.push(Buffer.alloc(40, 'c')); // total 120 bytes
                this.push(null);
            },
        });
        return {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: stream,
        };
    };

    const res = await safeFetch('http://public.example.com/large', {
        lookup: mockPublicLookup,
        fetchImpl,
        maxBytes: 100, // Limit 100 bytes
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'too_large');
    assert.strictEqual(res.body, undefined, 'Brak częściowej treści przy przekroczeniu rozmiaru');
});

test('safeFetch: niedozwolony typ zawartości zwraca reason: bad_content_type', async () => {
    const fetchImpl = async () => {
        return {
            status: 200,
            headers: { 'content-type': 'application/octet-stream; charset=binary' },
            body: 'binary-data',
        };
    };

    const res = await safeFetch('http://public.example.com/file.bin', {
        lookup: mockPublicLookup,
        fetchImpl,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'bad_content_type');
    assert.strictEqual(res.contentType, 'application/octet-stream; charset=binary');
});

test('safeFetch: wszystkie dozwolone typy zawartości są akceptowane', async () => {
    for (const ct of ALLOWED_CONTENT_TYPES) {
        const fetchImpl = async () => {
            return {
                status: 200,
                headers: { 'content-type': `${ct}; charset=utf-8` },
                body: 'sample content',
            };
        };

        const res = await safeFetch('http://public.example.com/page', {
            lookup: mockPublicLookup,
            fetchImpl,
        });

        assert.strictEqual(res.ok, true, `Content-type ${ct} powinien być dozwolony`);
        assert.ok(Buffer.isBuffer(res.body));
        assert.strictEqual(res.body.toString('utf8'), 'sample content');
    }
});

test('safeFetch: timeout przerywa pobieranie i zwraca reason: timeout', async () => {
    const fetchImpl = async () => {
        await new Promise(r => setTimeout(r, 200));
        return {
            status: 200,
            headers: { 'content-type': 'text/html' },
            body: 'hello',
        };
    };

    const res = await safeFetch('http://public.example.com/slow', {
        lookup: mockPublicLookup,
        fetchImpl,
        timeoutMs: 50,
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'timeout');
});

test('safeFetch: opcja allowHosts blokuje niedozwolone domeny', async () => {
    const res = await safeFetch('https://unauthorized.org/page', {
        allowHosts: ['authorized.org'],
    });

    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'host_not_allowed');
});

test('safeFetch: udane pobranie zwraca status, contentType i Buffer body', async () => {
    const expectedHtml = '<html><body><h1>Witaj świecie</h1></body></html>';
    const fetchImpl = async (url) => {
        return {
            status: 200,
            headers: { 'content-type': 'text/html; charset=utf-8' },
            body: Buffer.from(expectedHtml, 'utf8'),
        };
    };

    const res = await safeFetch('https://example.com/index.html', {
        lookup: mockPublicLookup,
        fetchImpl,
    });

    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.contentType, 'text/html; charset=utf-8');
    assert.strictEqual(res.finalUrl, 'https://example.com/index.html');
    assert.ok(Buffer.isBuffer(res.body));
    assert.strictEqual(res.body.toString('utf8'), expectedHtml);
});

test('safeFetch: IP pinning - przekazuje zwalidowany pinnedIp do opcji połączenia', async () => {
    let capturedPinnedIp = null;
    const fetchImpl = async (url, opts) => {
        capturedPinnedIp = opts.pinnedIp;
        return {
            status: 200,
            headers: { 'content-type': 'text/plain' },
            body: 'pinned-ok',
        };
    };

    const res = await safeFetch('http://public-pinned.example.com/api', {
        lookup: () => [{ address: '198.51.100.200', family: 4 }], // public IP
        fetchImpl,
    });

    // 198.51.100/24 jest TEST-NET-2 więc jest zablokowane jako reserved!
    // Użyjmy prawdziwego adresu publicznego:
    const res2 = await safeFetch('http://public-pinned.example.com/api', {
        lookup: () => [{ address: '1.1.1.1', family: 4 }],
        fetchImpl,
    });

    assert.strictEqual(res2.ok, true);
    assert.strictEqual(capturedPinnedIp, '1.1.1.1', 'pinnedIp musi odpowiadać zwalidowanemu adresowi DNS');
});

test('createPinnedLookup: obsługa wariantów opts {all:true}, {all:false} oraz brak opts (funkcja jako opts)', (t, done) => {
    const lookup = createPinnedLookup('93.184.216.34', 4);

    // 1. Bez opts (drugi argument to callback)
    lookup('example.com', (err1, addr1, fam1) => {
        assert.ifError(err1);
        assert.strictEqual(addr1, '93.184.216.34');
        assert.strictEqual(fam1, 4);

        // 2. Z pustym opts {}
        lookup('example.com', {}, (err2, addr2, fam2) => {
            assert.ifError(err2);
            assert.strictEqual(addr2, '93.184.216.34');
            assert.strictEqual(fam2, 4);

            // 3. Z opts { all: true } (Node 24 autoSelectFamily)
            lookup('example.com', { all: true }, (err3, list) => {
                assert.ifError(err3);
                assert.deepStrictEqual(list, [{ address: '93.184.216.34', family: 4 }]);
                done();
            });
        });
    });
});

test('safeFetch bez sieci: lokalny serwer http.createServer na 127.0.0.1 z domyślną ścieżką klienta Node i Accept-Encoding', async () => {
    let receivedAcceptEncoding = null;
    const server = http.createServer((req, res) => {
        receivedAcceptEncoding = req.headers['accept-encoding'];
        res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Pobrano bezpiecznie przez klienta Node!');
    });

    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    const port = server.address().port;

    try {
        // safeFetch wywołany z domyślną ścieżką klienta Node (BEZ fetchImpl)
        // _allowPrivateForTesting to jawna opcja testowa (domyślnie false, nieosiągalna z MCP)
        const res = await safeFetch(`http://test-local.internal:${port}/api/data`, {
            _allowPrivateForTesting: true,
            lookup: () => [{ address: '127.0.0.1', family: 4 }],
        });

        assert.strictEqual(res.ok, true);
        assert.strictEqual(res.status, 200);
        assert.strictEqual(res.contentType, 'text/plain; charset=utf-8');
        assert.ok(Buffer.isBuffer(res.body));
        assert.strictEqual(res.body.toString('utf8'), 'Pobrano bezpiecznie przez klienta Node!');
        assert.strictEqual(receivedAcceptEncoding, 'identity', 'Klient Node musi wysyłać Accept-Encoding: identity');
    } finally {
        await new Promise((resolve) => server.close(resolve));
    }
});

test('buildRequestOptions: nagłówek Accept-Encoding: identity oraz servername dla domen i IP (v4/v6)', (t, done) => {
    const optsDomain = buildRequestOptions(new URL('https://example.com/test?q=1'), '93.184.216.34', 4);
    assert.strictEqual(optsDomain.headers['Accept-Encoding'], 'identity');
    assert.strictEqual(optsDomain.headers['Host'], 'example.com');
    assert.strictEqual(optsDomain.servername, 'example.com');

    const optsIpv4 = buildRequestOptions(new URL('https://93.184.216.34/test'), '93.184.216.34', 4);
    assert.strictEqual(optsIpv4.headers['Accept-Encoding'], 'identity');
    assert.strictEqual(optsIpv4.servername, undefined);

    const optsIpv6 = buildRequestOptions(new URL('https://[2606:2800:220:1:248:1893:25c8:1946]/test'), '2606:2800:220:1:248:1893:25c8:1946', 6);
    assert.strictEqual(optsIpv6.headers['Accept-Encoding'], 'identity');
    assert.strictEqual(optsIpv6.servername, undefined);

    // Weryfikacja lookup wbudowanego w reqOptions (dla {all:true} i bez)
    optsDomain.lookup('example.com', { all: true }, (err1, resAll) => {
        assert.ifError(err1);
        assert.deepStrictEqual(resAll, [{ address: '93.184.216.34', family: 4 }]);
        optsDomain.lookup('example.com', (err2, ip, fam) => {
            assert.ifError(err2);
            assert.strictEqual(ip, '93.184.216.34');
            assert.strictEqual(fam, 4);
            done();
        });
    });
});
