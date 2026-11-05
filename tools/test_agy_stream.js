// node --test tools/test_agy_stream.js
// Fixtures are real `agy --output-format stream-json` runs (30.10.2026).
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createAgyStreamParser } = require('./agy_stream');

const fx = (n) => fs.readFileSync(path.join(__dirname, 'fixtures', n), 'utf8');

function feed(data, chunkSize) {
    const got = [];
    const p = createAgyStreamParser({ onText: (s) => got.push(s) });
    for (let i = 0; i < data.length; i += chunkSize) p.push(data.slice(i, i + chunkSize));
    p.end();
    return { p, got };
}

test('text equals text-mode stdout (all text_delta joined), any chunking', () => {
    const data = fx('agy_stream_multi.jsonl');
    for (const size of [1, 7, 64, 100000]) {
        const { p, got } = feed(data, size);
        assert.strictEqual(p.text, 'Zaczynam sprawdzanie.\nWynik: abc\n');
        assert.strictEqual(got.join(''), p.text);
    }
});

test('usage: prompt_tokens = last model step, run totals in run_usage', () => {
    const { p } = feed(fx('agy_stream_tool.jsonl'), 50);
    const u = p.usage();
    assert.strictEqual(u.prompt_tokens, 8191);       // last step, not the 16184 sum
    assert.strictEqual(u.completion_tokens, 21);
    assert.strictEqual(u.total_tokens, 8212);
    assert.strictEqual(u.run_usage.input_tokens, 16184);
    assert.strictEqual(u.run_usage.turns, 2);
    assert.strictEqual(p.text, 'gotowe\n');
});

test('tool output does not leak into answer text', () => {
    const { p } = feed(fx('agy_stream_tool.jsonl'), 1000);
    assert.ok(!p.text.includes('Command output'));
    assert.ok(p.notices.includes('Command output'));   // but is visible to the denial classifier
});

test('non-JSON line passes through as text (plain notice)', () => {
    const { p } = feed('a tool required the "mcp" permission that headless mode cannot prompt for\n', 5);
    assert.match(p.text, /required the "mcp" permission/);
    assert.strictEqual(p.usage(), null);
});

test('no text_delta but result.response -> response used', () => {
    const line = JSON.stringify({ event: 'result', result: { status: 'SUCCESS', response: 'ok\n', usage: { input_tokens: 10, output_tokens: 2 } } });
    const { p } = feed(line, 3);   // no trailing newline: end() flushes
    assert.strictEqual(p.text, 'ok\n');
    assert.strictEqual(p.usage().prompt_tokens, 10);
});

test('empty run -> empty text, null usage', () => {
    const { p } = feed('', 10);
    assert.strictEqual(p.text, '');
    assert.strictEqual(p.usage(), null);
});
