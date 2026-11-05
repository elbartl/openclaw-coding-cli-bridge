// node --test tools/test_cc_usage.js
// prompt_tokens must be the context of the last turn, not the sum over the run
// (OpenClaw showed "10.5M / 180k · 100%" from the sum).
const test = require('node:test');
const assert = require('node:assert');
const { createTurnUsage, formatUsage } = require('./cc_usage');

function runTurns(turns) {
    const t = createTurnUsage();
    for (const u of turns) {
        t.onStreamEvent({ type: 'message_start', message: { model: 'x', usage: { input_tokens: u.in, cache_read_input_tokens: u.read, cache_creation_input_tokens: u.write, output_tokens: 1 } } });
        t.onStreamEvent({ type: 'content_block_delta', delta: { type: 'text_delta', text: 'a' } });
        t.onStreamEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { output_tokens: u.out } });
    }
    return t.last;
}

test('multi-turn run: prompt_tokens = last turn context, totals in run_usage', () => {
    const turns = [
        { in: 3, read: 0, write: 40000, out: 200 },
        { in: 1, read: 40000, write: 500, out: 300 },
        { in: 2, read: 40500, write: 800, out: 900 },
    ];
    const sum = (k) => turns.reduce((a, t) => a + t[k], 0);
    const r = {
        turns: 3,
        lastTurnUsage: runTurns(turns),
        result: { total_cost_usd: 0.12, usage: { input_tokens: sum('in'), cache_read_input_tokens: sum('read'), cache_creation_input_tokens: sum('write'), output_tokens: sum('out') } },
    };
    const u = formatUsage(r);
    assert.strictEqual(u.prompt_tokens, 2 + 40500 + 800);
    assert.strictEqual(u.completion_tokens, 900);
    assert.strictEqual(u.total_tokens, 41302 + 900);
    assert.strictEqual(u.prompt_tokens_details.cached_tokens, 40500);
    assert.strictEqual(u.prompt_tokens_details.cache_creation_input_tokens, 800);
    assert.ok(u.prompt_tokens < 180000, 'fits in the context window');
    assert.deepStrictEqual(u.run_usage, { turns: 3, input_tokens: 6, cache_read_input_tokens: 80500, cache_creation_input_tokens: 41300, output_tokens: 1400, cost_usd: 0.12 });
});

test('no stream usage (older CLI): falls back to the result sum', () => {
    const u = formatUsage({ turns: 1, lastTurnUsage: null, result: { usage: { input_tokens: 10, cache_read_input_tokens: 5, output_tokens: 7 } } });
    assert.strictEqual(u.prompt_tokens, 15);
    assert.strictEqual(u.completion_tokens, 7);
});

test('no result at all: zeros, no run_usage, no throw', () => {
    const u = formatUsage({});
    assert.strictEqual(u.total_tokens, 0);
    assert.strictEqual(u.run_usage, undefined);
});
