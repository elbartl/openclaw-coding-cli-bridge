'use strict';
// Parser for `agy --print --output-format stream-json` (NDJSON on stdout).
//
// Text mode prints only the answer text, with no token counts, so OpenClaw
// could not show context usage for agy. stream-json carries the same text as
// `text_delta` fields of agent_response steps (text mode stdout == all
// text_delta joined, checked 30.10.2026) plus per-step `usage`.
//
// Events seen (agy 30.10.2026):
//   {event:"init", conversation_id, init:{model, cwd, tools}}
//   {event:"step_update", step_update:{step_index, state, step_type,
//        text_delta?, usage?:{input_tokens, output_tokens, thinking_tokens,
//        cache_read_tokens, total_tokens}, tool_info?}}
//   {event:"result", result:{status, response, num_turns, usage}}
//
// A line that is not JSON is passed through as text, so a plain notice from
// agy still reaches the client and the denial classifier like in text mode.

function collectStrings(v, acc, depth = 0) {
    if (depth > 6 || v == null) return;
    if (typeof v === 'string') { if (v.length >= 12) acc.push(v); return; }
    if (Array.isArray(v)) { for (const x of v) collectStrings(x, acc, depth + 1); return; }
    if (typeof v === 'object') for (const k of Object.keys(v)) {
        if (k === 'tools' || k === 'text_delta' || k === 'response') continue;
        collectStrings(v[k], acc, depth + 1);
    }
}

function createAgyStreamParser({ onText } = {}) {
    let buf = '';
    let text = '';
    let lastUsage = null;    // usage of the last model step = current context size
    let resultUsage = null;  // run total (sum over steps)
    let result = null;
    let modelSteps = 0;
    const notices = [];      // strings from non-text events, for denial detection

    const emit = (s) => { if (!s) return; text += s; if (onText) onText(s); };

    function handleLine(line) {
        if (!line.trim()) return;
        let ev;
        try { ev = JSON.parse(line); } catch (e) { ev = null; }
        if (!ev || typeof ev !== 'object' || !ev.event) { emit(line + '\n'); return; }
        if (ev.event === 'step_update' && ev.step_update) {
            const s = ev.step_update;
            if (typeof s.text_delta === 'string') emit(s.text_delta);
            if (s.usage && typeof s.usage === 'object') { lastUsage = { ...s.usage }; modelSteps++; }
            if (s.step_type !== 'agent_response') collectStrings(s, notices);
        } else if (ev.event === 'result' && ev.result) {
            result = ev.result;
            if (ev.result.usage) resultUsage = { ...ev.result.usage };
            collectStrings(ev.result, notices);
        } else if (ev.event !== 'init') {
            collectStrings(ev, notices);
        }
    }

    return {
        push(chunk) {
            buf += chunk;
            let i;
            while ((i = buf.indexOf('\n')) >= 0) {
                const line = buf.slice(0, i);
                buf = buf.slice(i + 1);
                handleLine(line);
            }
        },
        end() {
            if (buf) { handleLine(buf); buf = ''; }
            // Safety: a final answer with no text_delta at all.
            if (!text && result && typeof result.response === 'string' && result.response) emit(result.response);
        },
        get text() { return text; },
        get notices() { return notices.join('\n'); },
        get result() { return result; },
        usage() { return formatAgyUsage({ lastUsage, resultUsage, modelSteps }); },
    };
}

// OpenAI-style usage, same shape as the cc proxy (tools/cc_usage.js):
// prompt_tokens = context of the LAST model step (Gemini input_tokens already
// includes cached tokens); run totals go to run_usage.
function formatAgyUsage({ lastUsage, resultUsage, modelSteps }) {
    const cur = lastUsage || resultUsage;
    if (!cur) return null;
    const prompt = cur.input_tokens || 0;
    const completion = cur.output_tokens || 0;
    const out = {
        prompt_tokens: prompt,
        completion_tokens: completion,
        total_tokens: prompt + completion,
        prompt_tokens_details: { cached_tokens: cur.cache_read_tokens || 0 },
        completion_tokens_details: { reasoning_tokens: cur.thinking_tokens || 0 },
    };
    if (resultUsage) {
        out.run_usage = {
            turns: modelSteps || 0,
            input_tokens: resultUsage.input_tokens || 0,
            cache_read_input_tokens: resultUsage.cache_read_tokens || 0,
            output_tokens: resultUsage.output_tokens || 0,
            thinking_tokens: resultUsage.thinking_tokens || 0,
        };
    }
    return out.total_tokens > 0 ? out : null;
}

module.exports = { createAgyStreamParser, formatAgyUsage };
