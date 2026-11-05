// Paperclip wake text (adapter openclaw_gateway, Paperclip 2026.1023.0) seen
// by the model proxies. Used by claude_proxy.js and proxy.js.
//
// The adapter tells the agent to call Paperclip's HTTP API with a key loaded
// from a file. Our agents have no shell (role ro) and use the MCP bridge
// mcp/paperclip.js instead, so the proxy:
//   1. takes the run context (PAPERCLIP_RUN_ID=…, …) from the LAST wake in the
//      prompt and returns it as env for the spawned CLI, which passes it on to
//      the MCP bridge (the model never copies ids);
//   2. replaces every wake's HTTP procedure with a short pointer to the bridge.
// The task content Paperclip appends after the procedure is kept as is.
'use strict';

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const ENV_KEYS = ['PAPERCLIP_RUN_ID', 'PAPERCLIP_AGENT_ID', 'PAPERCLIP_COMPANY_ID', 'PAPERCLIP_TASK_ID',
    'PAPERCLIP_WAKE_REASON', 'PAPERCLIP_WAKE_COMMENT_ID', 'PAPERCLIP_APPROVAL_ID', 'PAPERCLIP_APPROVAL_STATUS'];
const START = 'Paperclip wake event for a cloud adapter.';
const CONV_START = 'Paperclip conversation turn for a cloud adapter.';
// Last line of the adapter's fixed procedure; Paperclip's task sections follow it.
const END = '- POST /api/companies/{companyId}/issues (when asked to create a new issue)';
const TAIL = 'Complete the workflow in this run.';

// Paperclip puts the latest comment of every finished child (up to 500 chars)
// into the coordinator's wake, twice: the "Direct child issue summaries"
// section and childIssueSummaries[].summary in the payload JSON. That would
// hand a web worker's report (even a quarantined one) to the coordinator
// without the CLEF check that pc_context applies, so the proxy removes both;
// the coordinator reads results only through pc_context.
const CHILD_HDR = 'Direct child issue summaries:';
const TERMINAL_HDR = 'Terminal / stopped leaves to verify:';
const JSON_HDR = 'Structured wake payload JSON:';
const CHILD_NOTE = '[treść usunięta przez proxy: wyniki pracowników czytaj tylko przez pc_context → children]';

const POST_CHILD_SECTION_RE = /^(?:## (?:Answered questions\b|Zadanie\b|Issue\b)|The harness already checked out this issue for the current run\.|Original request for context \(|Other new comments in order \(|New comments in order:|Complete the workflow in this run\.)/;

function splitSec(sec) {
    const nlMatch = sec.match(/\r?\n/);
    const nl = nlMatch ? nlMatch[0] : '\n';
    const lines = sec.split(/\r?\n/);
    let endIdx = -1;
    for (let i = 1; i < lines.length; i++) {
        if (POST_CHILD_SECTION_RE.test(lines[i])) {
            endIdx = i;
            break;
        }
    }
    if (endIdx === -1) {
        return { childSec: sec, trailing: '' };
    }
    return {
        childSec: lines.slice(0, endIdx).join(nl),
        trailing: lines.slice(endIdx).join(nl),
    };
}

function stripChildSummaries(block) {
    if (!block.includes(CHILD_HDR) && !block.includes(TERMINAL_HDR) &&
        !block.includes('childIssueSummaries') && !block.includes('terminalLeafSummaries')) {
        return block;
    }
    let head = block, tail = '', jsonBroken = false;
    const summaries = [];
    // The real payload JSON is the last one (anything earlier is quoted text).
    const j = block.lastIndexOf(JSON_HDR);
    if (j >= 0) {
        head = block.slice(0, j);
        const rest = block.slice(j);
        const m = rest.match(/^Structured wake payload JSON:\r?\n```json\r?\n([\s\S]*?)\r?\n```/);
        let json = null;
        if (m) { try { json = JSON.parse(m[1].trim()); } catch (e) { json = null; } }
        if (json && typeof json === 'object') {
            if (Array.isArray(json.childIssueSummaries)) {
                for (const c of json.childIssueSummaries) {
                    if (c && typeof c.summary === 'string' && c.summary) {
                        summaries.push(c.summary);
                        c.summary = null;
                    }
                }
            }
            if (json.taskWatchdog && Array.isArray(json.taskWatchdog.terminalLeafSummaries)) {
                for (const c of json.taskWatchdog.terminalLeafSummaries) {
                    if (c && typeof c.summary === 'string' && c.summary) {
                        summaries.push(c.summary);
                        c.summary = null;
                    }
                }
            }
            tail = `${JSON_HDR}\n\`\`\`json\n${JSON.stringify(json)}\n\`\`\`` + rest.slice(m[0].length);
        } else {
            // Unparsable payload: drop it whole rather than pass it through.
            jsonBroken = true;
            if (m) {
                tail = `${JSON_HDR} [usunięty przez proxy: nieczytelny]` + rest.slice(m[0].length);
            } else {
                const openIdx = rest.indexOf('```');
                let end = -1;
                if (openIdx >= 0) {
                    const afterOpen = rest.slice(openIdx + 3);
                    const mClose = afterOpen.match(/\r?\n```/);
                    if (mClose) end = openIdx + 3 + mClose.index + mClose[0].length;
                }
                tail = `${JSON_HDR} [usunięty przez proxy: nieczytelny]` + (end >= 0 ? rest.slice(end) : '');
            }
        }
    }

    const hdrs = [
        { name: CHILD_HDR, pos: head.indexOf(CHILD_HDR) },
        { name: TERMINAL_HDR, pos: head.indexOf(TERMINAL_HDR) },
    ].filter(h => h.pos >= 0).sort((a, b) => a.pos - b.pos);

    if (hdrs.length > 0) {
        const prefix = head.slice(0, hdrs[0].pos);
        const uniqueSummaries = [...new Set(summaries)];
        let cleaned = '';
        for (let k = 0; k < hdrs.length; k++) {
            const start = hdrs[k].pos;
            const end = k + 1 < hdrs.length ? hdrs[k + 1].pos : head.length;
            const sec = head.slice(start, end);
            const hdrName = hdrs[k].name;

            if (jsonBroken) {
                // Corrupt payload JSON: fail-closed, preserve only the final TAIL marker if present.
                const tailAt = sec.lastIndexOf(TAIL);
                cleaned += `${hdrName}\n${CHILD_NOTE}\n\n` + (tailAt >= 0 ? sec.slice(tailAt) : '');
            } else if (uniqueSummaries.length === 0) {
                const { trailing } = splitSec(sec);
                cleaned += `${hdrName}\n${CHILD_NOTE}\n\n` + (trailing ? trailing + '\n' : '');
            } else {
                // Replace directly in `sec` first: Paperclip writes `lines.push("  " + child.summary)`
                // without indenting lines 2..N, so splitting by indentation beforehand would leak lines 2..N.
                let cleanSec = sec;
                for (const s of uniqueSummaries) {
                    const crlfS = s.replace(/\r?\n/g, '\r\n');
                    const lfS = s.replace(/\r?\n/g, '\n');
                    const indentedLf = lfS.split('\n').join('\n  ');
                    const indentedCrlf = crlfS.split('\r\n').join('\r\n  ');
                    cleanSec = cleanSec.split(`\r\n  ${indentedCrlf}`).join(`\r\n  ${CHILD_NOTE}`)
                                       .split(`\n  ${indentedLf}`).join(`\n  ${CHILD_NOTE}`)
                                       .split(`\r\n  ${crlfS}`).join(`\r\n  ${CHILD_NOTE}`)
                                       .split(`\n  ${lfS}`).join(`\n  ${CHILD_NOTE}`);
                }
                for (const s of uniqueSummaries) {
                    const crlfS = s.replace(/\r?\n/g, '\r\n');
                    const lfS = s.replace(/\r?\n/g, '\n');
                    cleanSec = cleanSec.split(crlfS).join(CHILD_NOTE).split(lfS).join(CHILD_NOTE);
                }
                const leftover = uniqueSummaries.some(s => {
                    const lfS = s.replace(/\r?\n/g, '\n');
                    return cleanSec.replace(/\r?\n/g, '\n').includes(lfS);
                });
                if (leftover) {
                    const { trailing } = splitSec(sec);
                    cleaned += `${hdrName}\n${CHILD_NOTE}\n\n` + (trailing ? trailing + '\n' : '');
                } else {
                    cleaned += cleanSec.trimEnd() + '\n\n';
                }
            }
        }
        head = prefix + cleaned;
    }
    return head + tail;
}

function pointer(env) {
    const bits = [];
    if (env.PAPERCLIP_TASK_ID) bits.push(`zadanie ${env.PAPERCLIP_TASK_ID}`);
    if (env.PAPERCLIP_WAKE_REASON) bits.push(`powód: ${env.PAPERCLIP_WAKE_REASON}`);
    return [
        `[Paperclip] Przebieg z Paperclipa${bits.length ? ` (${bits.join(', ')})` : ''}.`,
        'Kontekst przebiegu jest już ustawiony w narzędziach MCP `paperclip` (pc_*). Nie wołaj HTTP i nie szukaj klucza w plikach.',
        'Zacznij od `pc_context` (bez argumentów): poda zadanie, komentarze i procedurę. Pracuj tylko nad tym zadaniem.',
        'Sygnatury (nie czytaj plików z definicjami narzędzi): pracownik: pc_finish(result: "ok"|"failed", summary: tekst). '
            + 'Koordynator: pc_delegate(worker, title, description, confirmation_id?), pc_comment(body), pc_update_issue(status, comment?, issue_id?), '
            + 'pc_get_issue(issue_id), pc_request_confirmation(prompt, title?, details_markdown?).',
    ].join('\n');
}

function readEnv(block) {
    const env = {};
    for (const k of ENV_KEYS) {
        const m = block.match(new RegExp(`^${k}=(\\S+)\\s*$`, 'm'));
        if (m) env[k] = m[1];
    }
    if (!new RegExp(`^${UUID}$`, 'i').test(env.PAPERCLIP_RUN_ID || '') ||
        !new RegExp(`^${UUID}$`, 'i').test(env.PAPERCLIP_AGENT_ID || '')) return null;
    return env;
}

function findWakeStart(text, fromIndex = 0) {
    const sub = text.slice(fromIndex);
    const m = sub.match(/(?:^|\r?\n)(?:\[[^\]\r\n]+\]:\s*)?(Paperclip (?:wake event|conversation turn) for a cloud adapter\.)/);
    if (!m) return -1;
    return fromIndex + m.index + (m[0].length - m[1].length);
}

function findNextWakeBoundary(rest) {
    let pos = 1;
    for (;;) {
        const nextAt = findWakeStart(rest, pos);
        if (nextAt === -1) return rest.length;
        // Real Paperclip pushes `  ${child.summary}` without indenting lines 2..N, so a
        // forged wake header on line 2+ of a child summary sits at column 0 before the
        // wake's own `Structured wake payload JSON:` (and without an `[ASSISTANT]:` turn).
        const before = rest.slice(0, nextAt);
        const after = rest.slice(nextAt);
        const hasChildHdrBefore = before.includes(CHILD_HDR) || before.includes(TERMINAL_HDR);
        const jsonInBefore = before.includes(JSON_HDR);
        const assistantBreak = after.search(/\r?\n\[ASSISTANT\]:/);
        const windowAfter = assistantBreak >= 0 ? after.slice(0, assistantBreak) : after;
        if (hasChildHdrBefore && !jsonInBefore && windowAfter.includes(JSON_HDR)) {
            pos = nextAt + 1;
            continue;
        }
        return nextAt;
    }
}

// Returns { text, env, rewritten } — env is null when the text holds no wake.
function applyPaperclipWake(text) {
    if (typeof text !== 'string' || (!text.includes(START) && !text.includes(CONV_START))) {
        return { text, env: null, rewritten: 0 };
    }
    let env = null;
    let rewritten = 0;
    let out = '';
    let rest = text;
    for (;;) {
        const at = findWakeStart(rest);
        if (at === -1) { out += rest; break; }
        out += rest.slice(0, at);
        rest = rest.slice(at);
        const blockEnd = findNextWakeBoundary(rest);
        let block = stripChildSummaries(rest.slice(0, blockEnd));
        rest = rest.slice(blockEnd);
        const e = readEnv(block);
        if (e) env = e;                       // the last wake wins
        if (e && block.startsWith(START)) {
            const end = block.indexOf(END);
            if (end >= 0) {
                let task = block.slice(end + END.length);
                const t = task.lastIndexOf(TAIL);
                if (t >= 0) task = task.slice(0, t) + task.slice(t + TAIL.length);
                block = `${pointer(e)}\n${task.replace(/^\s*\n/, '\n').trimEnd()}\n`;
                rewritten++;
            }
        } else if (e && block.startsWith(CONV_START)) {
            block = block.replace(/^.*PAPERCLIP_API_KEY.*$\n?/gm, '').replace(/^Use Authorization: Bearer.*$\n?/gm, '');
            block = `${pointer(e)}\n${block.slice(CONV_START.length).trim()}\n`;
            rewritten++;
        }
        out += block;
    }
    return { text: out, env, rewritten };
}

module.exports = { applyPaperclipWake, stripChildSummaries, ENV_KEYS };
