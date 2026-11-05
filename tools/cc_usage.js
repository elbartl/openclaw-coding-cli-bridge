'use strict';
// Token usage reported by the cc proxy in OpenAI format.
//
// One Claude Code run is many API turns (one per tool call). The CLI's final
// `result.usage` is the SUM over those turns, so with cache reads it reaches
// millions of tokens. OpenClaw reads `prompt_tokens` as the context size, so
// the sum showed e.g. "10.5M / 180k · 100%". prompt_tokens must therefore be
// the context of the LAST turn (its message_start usage); run totals go to
// `run_usage` for cost/quota accounting.

const ctxOf = (u) => (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);

// Track per-turn usage from top-level stream events.
function createTurnUsage() {
    let last = null;
    return {
        onStreamEvent(e) {
            if (!e) return;
            if (e.type === 'message_start' && e.message && e.message.usage) {
                last = { ...e.message.usage };
            } else if (e.type === 'message_delta' && e.usage && last) {
                // message_delta carries the turn's final output_tokens.
                if (e.usage.output_tokens != null) last.output_tokens = e.usage.output_tokens;
            }
        },
        get last() { return last; },
    };
}

function formatUsage(r) {
    const total = (r && r.result && r.result.usage) || {};
    const last = r && r.lastTurnUsage;
    const cur = last || total; // older CLI without stream usage: fall back to the sum
    const promptTokens = ctxOf(cur);
    const completionTokens = cur.output_tokens || 0;
    const out = {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        prompt_tokens_details: {
            cached_tokens: cur.cache_read_input_tokens || 0,
            cache_creation_input_tokens: cur.cache_creation_input_tokens || 0,
        },
    };
    if (r && r.result && r.result.usage) {
        out.run_usage = {
            turns: (r && r.turns) || 0,
            input_tokens: total.input_tokens || 0,
            cache_read_input_tokens: total.cache_read_input_tokens || 0,
            cache_creation_input_tokens: total.cache_creation_input_tokens || 0,
            output_tokens: total.output_tokens || 0,
            ...(r.result.total_cost_usd != null ? { cost_usd: r.result.total_cost_usd } : {}),
        };
    }
    return out;
}

module.exports = { createTurnUsage, formatUsage };
