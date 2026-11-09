'use strict';
/**
 * tools/webread/ssrf.js - SSRF validation and safe HTTP/HTTPS fetch module.
 *
 * Implements strict SSRF protection:
 * - RFC-compliant private/local/multicast IP detection for IPv4 & IPv6.
 * - URL validation (http/https only, no credentials, blocked internal hostnames & numeric/hex/octal forms).
 * - Safe fetch with manual redirect handling, per-hop revalidation, DNS resolution checking all records,
 *   IP pinning to prevent DNS rebinding, streaming body size limits (fail-closed, no partial body),
 *   content-type whitelisting, timeout, and optional allowHosts.
 */

const http = require('node:http');
const https = require('node:https');
const dns = require('node:dns');
const dnsPromises = dns.promises;
const net = require('node:net');
const { URL } = require('node:url');

const ALLOWED_CONTENT_TYPES = new Set([
    'text/html',
    'text/plain',
    'text/markdown',
    'application/json',
    'application/xml',
    'text/xml',
    'application/xhtml+xml',
]);

const BLOCKED_DOMAINS_SUFFIXES = [
    '.local',
    '.internal',
    '.localhost',
    '.lan',
    '.home',
    '.home.arpa',
    '.localdomain',
    '.ts.net',
];

const BLOCKED_HOSTNAMES = new Set([
    'localhost',
    'ip6-localhost',
    'ip6-loopback',
    'local',
    'internal',
]);

/**
 * Checks if an IPv4 address is in a private, loopback, link-local, multicast or reserved range.
 * @param {string} ip
 * @returns {boolean}
 */
function ipv4Private(ip) {
    if (!net.isIPv4(ip)) return true;
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) {
        return true;
    }
    const [a, b, c] = parts;
    // 0.0.0.0/8 (Current network)
    if (a === 0) return true;
    // 10.0.0.0/8 (Private-Use)
    if (a === 10) return true;
    // 100.64.0.0/10 (Shared Address Space / CGNAT)
    if (a === 100 && b >= 64 && b <= 127) return true;
    // 127.0.0.0/8 (Loopback)
    if (a === 127) return true;
    // 169.254.0.0/16 (Link Local, including 169.254.169.254 cloud metadata)
    if (a === 169 && b === 254) return true;
    // 172.16.0.0/12 (Private-Use)
    if (a === 172 && b >= 16 && b <= 31) return true;
    // 192.168.0.0/16 (Private-Use)
    if (a === 192 && b === 168) return true;
    // 224.0.0.0/4 and above (Multicast 224/4, Reserved 240/4, Broadcast 255.255.255.255)
    if (a >= 224) return true;
    // 192.0.0.0/24 (IETF Protocol Assignments) & 192.0.2.0/24 (TEST-NET-1)
    if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
    // 198.18.0.0/15 (Benchmarking)
    if (a === 198 && (b === 18 || b === 19)) return true;
    // 198.51.100.0/24 (TEST-NET-2)
    if (a === 198 && b === 51 && c === 100) return true;
    // 203.0.113.0/24 (TEST-NET-3)
    if (a === 203 && b === 0 && c === 113) return true;

    return false;
}

/**
 * Parses an IPv6 string into 8 16-bit word integers.
 * @param {string} ip
 * @returns {number[]|null}
 */
function parseIpv6Words(ip) {
    let clean = ip.toLowerCase();
    if (clean.startsWith('[') && clean.endsWith(']')) {
        clean = clean.slice(1, -1);
    }
    if (!net.isIPv6(clean)) return null;

    const parts = clean.split('::');
    if (parts.length > 2) return null;

    const left = parts[0] ? parts[0].split(':') : [];
    const right = parts.length === 2 && parts[1] ? parts[1].split(':') : [];

    // Check for IPv4 embedded notation in last segment
    const lastList = right.length > 0 ? right : left;
    if (lastList.length > 0 && lastList[lastList.length - 1].includes('.')) {
        const v4Str = lastList.pop();
        if (!net.isIPv4(v4Str)) return null;
        const v4Parts = v4Str.split('.').map(Number);
        const w0 = (v4Parts[0] << 8) | v4Parts[1];
        const w1 = (v4Parts[2] << 8) | v4Parts[3];
        lastList.push(w0.toString(16), w1.toString(16));
    }

    const words = [];
    for (const s of left) {
        if (!s) return null;
        const n = parseInt(s, 16);
        if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
        words.push(n);
    }

    const rightWords = [];
    for (const s of right) {
        if (!s) return null;
        const n = parseInt(s, 16);
        if (Number.isNaN(n) || n < 0 || n > 0xffff) return null;
        rightWords.push(n);
    }

    if (parts.length === 2) {
        const fill = 8 - (words.length + rightWords.length);
        if (fill < 0) return null;
        for (let i = 0; i < fill; i++) words.push(0);
        words.push(...rightWords);
    }

    if (words.length !== 8) return null;
    return words;
}

/**
 * Checks whether an IP address is private/reserved.
 * Fail-closed: unparseable input returns true.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateIp(ip) {
    if (typeof ip !== 'string') return true;
    let s = ip.trim();
    if (s.startsWith('[') && s.endsWith(']')) {
        s = s.slice(1, -1);
    }
    if (!s) return true;

    if (net.isIPv4(s)) {
        return ipv4Private(s);
    }

    if (net.isIPv6(s)) {
        const w = parseIpv6Words(s);
        if (!w) return true; // fail-closed

        // :: (Unspecified)
        if (w.every(x => x === 0)) return true;

        // ::1 (Loopback)
        if (w.slice(0, 7).every(x => x === 0) && w[7] === 1) return true;

        // IPv4-compatible (::a.b.c.d, first 6 words = 0)
        if (w.slice(0, 6).every(x => x === 0)) {
            const v4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
            return ipv4Private(v4);
        }

        // ::ffff:a.b.c.d (IPv4-mapped)
        if (w.slice(0, 5).every(x => x === 0) && w[5] === 0xffff) {
            const v4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
            return ipv4Private(v4);
        }

        // SIIT (Stateless IP/ICMP Translation: ::ffff:0:a.b.c.d)
        if (w.slice(0, 4).every(x => x === 0) && w[4] === 0xffff && w[5] === 0) {
            const v4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
            return ipv4Private(v4);
        }

        // 6to4 (2002::/16) - embedded IPv4 in words 1 and 2
        if (w[0] === 0x2002) {
            const v4 = `${w[1] >> 8}.${w[1] & 0xff}.${w[2] >> 8}.${w[2] & 0xff}`;
            return ipv4Private(v4);
        }

        // Teredo (2001::/32) - blokuj tunelowanie Teredo 2001:0000::/32
        if (w[0] === 0x2001 && w[1] === 0x0000) {
            return true;
        }

        // 64:ff9b:1::/48 (RFC 8215, Local-Use IPv4/IPv6 Translation Prefix) - bezwarunkowo prywatny
        if (w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0x0001) {
            return true;
        }

        // 64:ff9b::/96 (RFC 6052, Well-Known Prefix for IPv4/IPv6 translation)
        if (w[0] === 0x0064 && w[1] === 0xff9b && w.slice(2, 6).every(x => x === 0)) {
            const v4 = `${w[6] >> 8}.${w[6] & 0xff}.${w[7] >> 8}.${w[7] & 0xff}`;
            return ipv4Private(v4);
        }

        // fc00::/7 (Unique Local Address: fc00..fdff)
        if ((w[0] & 0xfe00) === 0xfc00) return true;

        // fe80::/10 (Link-Local Unicast: fe80..febf)
        if ((w[0] & 0xffc0) === 0xfe80) return true;

        // fec0::/10 (Site-Local, deprecated RFC 3879)
        if ((w[0] & 0xffc0) === 0xfec0) return true;

        // ff00::/8 (Multicast: ff00..ffff)
        if ((w[0] & 0xff00) === 0xff00) return true;

        // 2001:db8::/32 (Documentation)
        if (w[0] === 0x2001 && w[1] === 0x0db8) return true;

        return false;
    }

    // Fail-closed for non-standard, numeric, hex, or unparseable IP representations
    return true;
}

/**
 * Extracts the raw host part from a URL string before WHATWG URL normalizes it.
 * @param {string} urlString
 * @returns {string|null}
 */
function extractRawHost(urlString) {
    if (typeof urlString !== 'string') return null;
    const trimmed = urlString.trim();
    const match = trimmed.match(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/([^/?#]+)/);
    if (!match) return null;
    let auth = match[1];
    if (auth.includes('@')) {
        const parts = auth.split('@');
        auth = parts[parts.length - 1];
    }
    if (auth.startsWith('[')) {
        const end = auth.indexOf(']');
        if (end === -1) return null;
        return auth.slice(1, end);
    }
    return auth.split(':')[0];
}

/**
 * Validates a URL for SSRF risks.
 * Rejects non-http/https schemes, credentials, localhost, local/internal hostnames,
 * numeric/hex/octal IP notations, and private IP literals.
 * @param {string} urlString
 * @param {object} [options]
 * @param {string[]|null} [options.allowHosts]
 * @returns {{ok: boolean, url?: string, reason?: string, hostname?: string, urlObj?: URL}}
 */
function validateUrl(urlString, options = {}) {
    const { allowHosts = null, _allowPrivateForTesting = false } = options;
    if (typeof urlString !== 'string' || !urlString.trim()) {
        return { ok: false, reason: 'missing_url' };
    }
    const trimmed = urlString.trim();

    let u;
    try {
        u = new URL(trimmed);
    } catch (_) {
        return { ok: false, reason: 'invalid_url' };
    }

    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
        return { ok: false, reason: 'unsupported_protocol' };
    }

    if (u.username || u.password) {
        return { ok: false, reason: 'credentials_not_allowed' };
    }

    const rawHost = extractRawHost(trimmed);
    if (!rawHost) {
        return { ok: false, reason: 'invalid_url' };
    }

    // Detect numeric, hex, octal or shorthand IP representations in raw host
    if (/^\d+$/.test(rawHost)) {
        return { ok: false, reason: 'numeric_ip_not_allowed' };
    }
    if (/0x/i.test(rawHost)) {
        return { ok: false, reason: 'hex_ip_not_allowed' };
    }
    if (/(^|\.)0[0-9]+/.test(rawHost)) {
        return { ok: false, reason: 'octal_ip_not_allowed' };
    }
    if (/^\d+(\.\d+){1,2}$/.test(rawHost)) {
        return { ok: false, reason: 'shorthand_ip_not_allowed' };
    }

    const host = u.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
    if (!host) {
        return { ok: false, reason: 'empty_host' };
    }

    // Reject localhost and local/internal hosts
    if (!_allowPrivateForTesting) {
        if (BLOCKED_HOSTNAMES.has(host) || host.endsWith('.localhost')) {
            return { ok: false, reason: 'localhost_not_allowed' };
        }
        if (host.endsWith('.local')) {
            return { ok: false, reason: 'local_not_allowed' };
        }
        if (host.endsWith('.internal')) {
            return { ok: false, reason: 'internal_not_allowed' };
        }

        for (const suffix of BLOCKED_DOMAINS_SUFFIXES) {
            if (host === suffix.slice(1) || host.endsWith(suffix)) {
                return { ok: false, reason: 'private_domain_not_allowed' };
            }
        }
    }

    if (!host.includes('.') && !net.isIP(host)) {
        return { ok: false, reason: 'single_label_host_not_allowed' };
    }

    // Reject private IP literals
    if (net.isIP(host)) {
        if (!_allowPrivateForTesting && isPrivateIp(host)) {
            return { ok: false, reason: 'private_ip' };
        }
        // If rawHost was converted to an IP but didn't match canonical form
        if (rawHost.toLowerCase() !== host && rawHost.toLowerCase() !== `[${host}]`) {
            return { ok: false, reason: 'obfuscated_ip_not_allowed' };
        }
    }

    // Allowlist check if configured
    if (Array.isArray(allowHosts)) {
        const allowed = allowHosts.some(allowedPattern => {
            const pattern = allowedPattern.toLowerCase().trim().replace(/^\./, '');
            return host === pattern || host.endsWith('.' + pattern);
        });
        if (!allowed) {
            return { ok: false, reason: 'host_not_allowed' };
        }
    }

    return {
        ok: true,
        url: u.href,
        hostname: host,
        urlObj: u,
    };
}

/**
 * Normalizes lookup call to return array of { address, family }.
 * Supports async promises, sync functions, and node callback style (host, opts, cb).
 */
async function resolveLookup(lookupFn, hostname) {
    if (typeof lookupFn !== 'function') {
        throw new Error('lookupFn must be a function');
    }

    let res;
    if (lookupFn.length >= 2) {
        res = await new Promise((resolve, reject) => {
            try {
                const maybePromise = lookupFn(hostname, { all: true, verbatim: true }, (err, addresses) => {
                    if (err) return reject(err);
                    resolve(addresses);
                });
                if (maybePromise && typeof maybePromise.then === 'function') {
                    maybePromise.then(resolve, reject);
                }
            } catch (err) {
                reject(err);
            }
        });
    } else {
        res = await lookupFn(hostname, { all: true, verbatim: true });
    }

    if (!res) return [];
    if (typeof res === 'string') {
        return [{ address: res, family: net.isIP(res) || 4 }];
    }
    if (Array.isArray(res)) {
        return res.map(item => {
            if (typeof item === 'string') return { address: item, family: net.isIP(item) || 4 };
            return { address: item.address, family: item.family || (net.isIPv6(item.address) ? 6 : 4) };
        });
    }
    if (typeof res === 'object' && res.address) {
        return [{ address: res.address, family: res.family || (net.isIPv6(res.address) ? 6 : 4) }];
    }
    return [];
}

function defaultLookup(hostname) {
    return dnsPromises.lookup(hostname, { all: true, verbatim: true });
}

function createPinnedLookup(pinnedIp, pinnedFamily) {
    return (_hostname, opts, cb) => {
        if (typeof opts === 'function') { cb = opts; opts = {}; }
        if (opts && opts.all) cb(null, [{ address: pinnedIp, family: pinnedFamily }]);
        else cb(null, pinnedIp, pinnedFamily);
    };
}

function buildRequestOptions(urlObj, pinnedIp, pinnedFamily) {
    const cleanHost = urlObj.hostname.replace(/^\[|\]$/g, '');
    return {
        protocol: urlObj.protocol,
        hostname: urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === 'https:' ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: 'GET',
        headers: {
            'Host': urlObj.host,
            'User-Agent': 'OpenClaw-WebRead/1.0',
            'Accept': 'text/html, text/plain, text/markdown, application/json, application/xml, text/xml, application/xhtml+xml',
            'Accept-Encoding': 'identity',
        },
        servername: net.isIP(cleanHost) ? undefined : urlObj.hostname,
        lookup: (_hostname, opts, cb) => {
            if (typeof opts === 'function') { cb = opts; opts = {}; }
            if (opts && opts.all) cb(null, [{ address: pinnedIp, family: pinnedFamily }]);
            else cb(null, pinnedIp, pinnedFamily);
        },
    };
}

function readNodeStream(stream, maxBytes, timeoutMs) {
    return new Promise((resolve, reject) => {
        let total = 0;
        const chunks = [];
        let timer = null;

        if (timeoutMs) {
            timer = setTimeout(() => {
                if (stream.destroy) stream.destroy();
                const err = new Error('timeout');
                err.code = 'timeout';
                reject(err);
            }, timeoutMs);
        }

        stream.on('data', (chunk) => {
            total += chunk.length;
            if (total > maxBytes) {
                if (timer) clearTimeout(timer);
                if (stream.destroy) stream.destroy();
                const err = new Error('too_large');
                err.code = 'too_large';
                return reject(err);
            }
            chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        });

        stream.on('end', () => {
            if (timer) clearTimeout(timer);
            resolve(Buffer.concat(chunks));
        });

        stream.on('error', (err) => {
            if (timer) clearTimeout(timer);
            reject(err);
        });
    });
}

async function readWebStream(readableStream, maxBytes) {
    const reader = readableStream.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength || value.length;
        if (total > maxBytes) {
            await reader.cancel();
            const err = new Error('too_large');
            err.code = 'too_large';
            throw err;
        }
        chunks.push(Buffer.isBuffer(value) ? value : Buffer.from(value));
    }
    return Buffer.concat(chunks);
}

/**
 * Performs a single HTTP request hop, either using custom fetchImpl or node http(s).request.
 */
async function executeHop({ urlObj, currentUrl, pinnedIp, pinnedFamily, fetchImpl, maxBytes, timeoutMs }) {
    if (fetchImpl) {
        let timer;
        const timeoutPromise = new Promise((_, reject) => {
            timer = setTimeout(() => {
                const err = new Error('timeout');
                err.code = 'timeout';
                reject(err);
            }, timeoutMs);
        });

        try {
            const fetchCall = Promise.resolve().then(() => fetchImpl(currentUrl, {
                method: 'GET',
                redirect: 'manual',
                headers: {
                    'User-Agent': 'OpenClaw-WebRead/1.0',
                    'Accept': 'text/html, text/plain, text/markdown, application/json, application/xml, text/xml, application/xhtml+xml',
                },
                pinnedIp,
                pinnedFamily,
                timeoutMs,
                maxBytes,
            }));

            const res = await Promise.race([fetchCall, timeoutPromise]);
            clearTimeout(timer);

            const status = res.status ?? res.statusCode ?? 200;
            const headers = {};
            if (res.headers) {
                if (typeof res.headers.get === 'function') {
                    for (const key of ['content-type', 'location', 'content-length']) {
                        const val = res.headers.get(key);
                        if (val !== null && val !== undefined) headers[key] = val;
                    }
                } else if (typeof res.headers === 'object') {
                    for (const [k, v] of Object.entries(res.headers)) {
                        headers[k.toLowerCase()] = v;
                    }
                }
            }

            if ([301, 302, 303, 307, 308].includes(status)) {
                return {
                    ok: true,
                    status,
                    headers,
                    body: Buffer.alloc(0),
                };
            }

            const rawCt = headers['content-type'] || '';
            const mime = rawCt.split(';')[0].trim().toLowerCase();
            if (!ALLOWED_CONTENT_TYPES.has(mime)) {
                const err = new Error('bad_content_type');
                err.code = 'bad_content_type';
                err.status = status;
                err.contentType = rawCt;
                throw err;
            }

            let bodyBuf;
            if (res.body && typeof res.body.on === 'function') {
                bodyBuf = await readNodeStream(res.body, maxBytes, timeoutMs);
            } else if (res.body && typeof res.body.getReader === 'function') {
                bodyBuf = await readWebStream(res.body, maxBytes);
            } else if (typeof res.arrayBuffer === 'function') {
                const ab = await res.arrayBuffer();
                if (ab.byteLength > maxBytes) {
                    const err = new Error('too_large');
                    err.code = 'too_large';
                    throw err;
                }
                bodyBuf = Buffer.from(ab);
            } else if (typeof res.text === 'function') {
                const t = await res.text();
                const buf = Buffer.from(t, 'utf8');
                if (buf.length > maxBytes) {
                    const err = new Error('too_large');
                    err.code = 'too_large';
                    throw err;
                }
                bodyBuf = buf;
            } else {
                const b = res.body ?? '';
                const buf = Buffer.isBuffer(b) ? b : Buffer.from(b, 'utf8');
                if (buf.length > maxBytes) {
                    const err = new Error('too_large');
                    err.code = 'too_large';
                    throw err;
                }
                bodyBuf = buf;
            }

            return {
                ok: true,
                status,
                headers,
                body: bodyBuf,
            };
        } finally {
            clearTimeout(timer);
        }
    }

    // Default Node http / https request with IP pinning
    return new Promise((resolve, reject) => {
        const client = urlObj.protocol === 'https:' ? https : http;
        let timer = null;
        let isDone = false;

        function cleanup() {
            if (timer) {
                clearTimeout(timer);
                timer = null;
            }
        }

        const reqOptions = buildRequestOptions(urlObj, pinnedIp, pinnedFamily);

        const req = client.request(reqOptions, (res) => {
            const status = res.statusCode;
            const headers = res.headers;

            if ([301, 302, 303, 307, 308].includes(status)) {
                res.resume();
                cleanup();
                isDone = true;
                return resolve({
                    ok: true,
                    status,
                    headers,
                    body: Buffer.alloc(0),
                });
            }

            const rawCt = headers['content-type'] || '';
            const mime = rawCt.split(';')[0].trim().toLowerCase();
            if (!ALLOWED_CONTENT_TYPES.has(mime)) {
                res.destroy();
                cleanup();
                isDone = true;
                const err = new Error('bad_content_type');
                err.code = 'bad_content_type';
                err.status = status;
                err.contentType = rawCt;
                return reject(err);
            }

            const cl = headers['content-length'];
            if (cl && parseInt(cl, 10) > maxBytes) {
                res.destroy();
                cleanup();
                isDone = true;
                const err = new Error('too_large');
                err.code = 'too_large';
                return reject(err);
            }

            let received = 0;
            const chunks = [];
            res.on('data', (chunk) => {
                received += chunk.length;
                if (received > maxBytes) {
                    res.destroy();
                    cleanup();
                    isDone = true;
                    const err = new Error('too_large');
                    err.code = 'too_large';
                    return reject(err);
                }
                chunks.push(chunk);
            });

            res.on('end', () => {
                if (isDone) return;
                cleanup();
                isDone = true;
                resolve({
                    ok: true,
                    status,
                    headers,
                    body: Buffer.concat(chunks),
                });
            });

            res.on('error', (err) => {
                if (isDone) return;
                cleanup();
                isDone = true;
                reject(err);
            });
        });

        timer = setTimeout(() => {
            if (isDone) return;
            isDone = true;
            req.destroy();
            const err = new Error('timeout');
            err.code = 'timeout';
            reject(err);
        }, timeoutMs);

        req.on('error', (err) => {
            if (isDone) return;
            cleanup();
            isDone = true;
            reject(err);
        });

        req.end();
    });
}

/**
 * Fetches an external URL safely with full SSRF and DoS protections.
 * @param {string} urlString
 * @param {object} [options]
 * @param {function} [options.lookup]
 * @param {function} [options.fetchImpl]
 * @param {number} [options.maxBytes=2*1024*1024]
 * @param {number} [options.maxRedirects=5]
 * @param {number} [options.timeoutMs=15000]
 * @param {string[]|null} [options.allowHosts=null]
 * @returns {Promise<{ok: boolean, finalUrl: string, status?: number, contentType?: string, body?: Buffer, reason?: string}>}
 */
async function safeFetch(urlString, options = {}) {
    const {
        lookup = null,
        fetchImpl = null,
        maxBytes = 2 * 1024 * 1024,
        maxRedirects = 5,
        timeoutMs = 15000,
        allowHosts = null,
        // Jawny parametr testowy do weryfikacji mechanizmów bez dostępu do sieci.
        // Pozwala na połączenie z lokalnym serwerem testowym (127.0.0.1).
        // Domyślnie wyłączony (false), nieosiągalny z poziomu MCP tools/call.
        _allowPrivateForTesting = false,
    } = options;

    let currentUrl = urlString;
    let redirectCount = 0;
    const startTime = Date.now();

    while (true) {
        const remainingTimeoutMs = timeoutMs - (Date.now() - startTime);
        if (remainingTimeoutMs <= 0) {
            return { ok: false, finalUrl: currentUrl, reason: 'timeout' };
        }

        // 1. URL validation & allowlist check
        const v = validateUrl(currentUrl, { allowHosts, _allowPrivateForTesting });
        if (!v.ok) {
            return { ok: false, finalUrl: currentUrl, reason: v.reason || 'invalid_url' };
        }

        let urlObj;
        try {
            urlObj = new URL(currentUrl);
        } catch (_) {
            return { ok: false, finalUrl: currentUrl, reason: 'invalid_url' };
        }

        const host = urlObj.hostname.replace(/^\[|\]$/g, '').toLowerCase().replace(/\.$/, '');
        let pinnedIp = null;
        let pinnedFamily = 4;

        // 2. IP / DNS Resolution validation
        if (net.isIP(host)) {
            if (!_allowPrivateForTesting && isPrivateIp(host)) {
                return { ok: false, finalUrl: currentUrl, reason: 'private_ip' };
            }
            pinnedIp = host;
            pinnedFamily = net.isIP(host);
        } else {
            let addrs;
            try {
                addrs = await resolveLookup(lookup || defaultLookup, host);
            } catch (_) {
                return { ok: false, finalUrl: currentUrl, reason: 'dns_lookup_failed' };
            }

            if (!addrs || !addrs.length) {
                return { ok: false, finalUrl: currentUrl, reason: 'dns_no_records' };
            }

            // Every returned address MUST be public
            for (const item of addrs) {
                const addr = typeof item === 'string' ? item : (item && item.address);
                if (!addr || (!_allowPrivateForTesting && isPrivateIp(addr))) {
                    return { ok: false, finalUrl: currentUrl, reason: 'private_ip' };
                }
            }

            const first = addrs[0];
            pinnedIp = typeof first === 'string' ? first : first.address;
            pinnedFamily = (typeof first === 'object' && first.family) ? first.family : (net.isIPv6(pinnedIp) ? 6 : 4);
        }

        // 3. Connect using pinned IP
        let hopResult;
        try {
            hopResult = await executeHop({
                urlObj,
                currentUrl,
                pinnedIp,
                pinnedFamily,
                fetchImpl,
                maxBytes,
                timeoutMs: remainingTimeoutMs,
            });
        } catch (err) {
            if (err.code === 'too_large' || err.message === 'too_large') {
                return { ok: false, finalUrl: currentUrl, reason: 'too_large' };
            }
            if (err.code === 'timeout' || err.message === 'timeout' || err.name === 'TimeoutError') {
                return { ok: false, finalUrl: currentUrl, reason: 'timeout' };
            }
            if (err.code === 'bad_content_type' || err.message === 'bad_content_type') {
                return {
                    ok: false,
                    finalUrl: currentUrl,
                    status: err.status,
                    contentType: err.contentType,
                    reason: 'bad_content_type',
                };
            }
            return { ok: false, finalUrl: currentUrl, reason: err.message || 'fetch_error' };
        }

        if (!hopResult.ok) {
            return hopResult;
        }

        const { status, headers, body } = hopResult;

        // Redirect handling (301, 302, 303, 307, 308)
        if ([301, 302, 303, 307, 308].includes(status)) {
            redirectCount++;
            if (redirectCount > maxRedirects) {
                return { ok: false, finalUrl: currentUrl, status, reason: 'too_many_redirects' };
            }
            const location = headers['location'] || headers.location;
            if (!location) {
                return { ok: false, finalUrl: currentUrl, status, reason: 'redirect_missing_location' };
            }
            let nextUrl;
            try {
                nextUrl = new URL(location, currentUrl).href;
            } catch (_) {
                return { ok: false, finalUrl: currentUrl, status, reason: 'invalid_redirect_url' };
            }
            currentUrl = nextUrl;
            continue;
        }

        // Final Content-Type check
        const rawContentType = headers['content-type'] || headers['Content-Type'] || '';
        const mimeType = String(rawContentType).split(';')[0].trim().toLowerCase();
        if (!ALLOWED_CONTENT_TYPES.has(mimeType)) {
            return {
                ok: false,
                finalUrl: currentUrl,
                status,
                contentType: rawContentType,
                reason: 'bad_content_type',
            };
        }

        const finalOk = status >= 200 && status < 400;
        return {
            ok: finalOk,
            finalUrl: currentUrl,
            status,
            contentType: rawContentType,
            body: Buffer.isBuffer(body) ? body : Buffer.from(body || ''),
            ...(finalOk ? {} : { reason: `http_${status}` }),
        };
    }
}

module.exports = {
    isPrivateIp,
    validateUrl,
    safeFetch,
    ALLOWED_CONTENT_TYPES,
    createPinnedLookup,
    buildRequestOptions,
};
