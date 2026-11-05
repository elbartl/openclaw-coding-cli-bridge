// Model id -> agy model name, resolved against the live `agy models` list.
//
// Why (2026-10-13): agy swapped its whole model catalogue overnight (Gemini
// 3.7 Flash -> 3.8, Claude 4.6 (Thinking) -> 5.5 (Low/Medium/High), Gemini 3.1
// Pro gone). The proxy kept sending the old hard-coded names, every call died
// with "model not recognized", OpenClaw then cooled down the whole agy:default
// auth profile and the climate watchdogs were down for ~12 h.
//
// Policy: REPLACE ONLY WHAT VANISHED. An id keeps its current model for as long
// as agy still lists it; a newer version is only reported (`newer`), never
// switched to — upgrading stays Bart's call (edit the seed in proxy.js). The
// one automatic move besides replacing a vanished model is RETURNING from a
// stand-in: an id served by a fallback (other family or non-preferred tier)
// goes back to its preferred family/tier as soon as agy lists one again.
//
// Matching runs on agy's short names (`gemini-3.8-flash-high`,
// `claude-sonnet-5-5-high`), with strict anchored patterns, so a variant like
// `-lite` or `-preview` never matches by accident. Versions compare as number
// tuples (3.10 > 3.9). Pure functions only — no I/O — so this is testable.

// Short-name grammars per family. Anything that does not match one of these
// exactly is ignored for automatic selection.
const FAMILIES = {
    'gemini-flash': /^gemini-(\d+(?:\.\d+)*)-flash-([a-z]+)$/,
    'gemini-pro':   /^gemini-(\d+(?:\.\d+)*)-pro-([a-z]+)$/,
    'gemini-argon': /^gemini-(\d+(?:\.\d+)*)-argon-([a-z]+)$/,
    'claude-sonnet': /^claude-sonnet-(\d+(?:-\d+)*)-([a-z]+)$/,
    'claude-opus':   /^claude-opus-(\d+(?:-\d+)*)-([a-z]+)$/,
    'gpt-oss':       /^gpt-oss-(\d+)b-([a-z]+)$/,
};

// Used only when none of an id's preferred tiers exists in its family: take the
// strongest tier agy offers. Unknown tier names rank last.
const TIER_STRENGTH = ['high', 'thinking', 'medium', 'low'];

function parseVersion(v) {
    return v.split(/[.-]/).map(n => parseInt(n, 10));
}
function cmpVersion(a, b) {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const d = (a[i] || 0) - (b[i] || 0);
        if (d) return d;
    }
    return 0;
}

// `agy models` stdout -> [{ short, name }]. Lines are "<short>\t<display name>";
// the "Fetching available models..." banner and blank lines are skipped.
function parseAgyModels(stdout) {
    const out = [];
    for (const line of String(stdout || '').split('\n')) {
        const m = line.match(/^([a-z0-9][a-z0-9.\-]*)\t(.+)$/);
        if (m) out.push({ short: m[1], name: m[2].trim() });
    }
    return out;
}

function classify(entry) {
    for (const [family, re] of Object.entries(FAMILIES)) {
        const m = entry.short.match(re);
        if (m) return { ...entry, family, version: parseVersion(m[1]), tier: m[2] };
    }
    return null;
}

// Best model for one rule step ({family, tiers}) or null. Preferred tiers are
// tried in order, newest version within a tier wins.
function pick(models, family, tiers) {
    const inFamily = models.filter(m => m.family === family);
    for (const tier of tiers) {
        const c = inFamily.filter(m => m.tier === tier).sort((a, b) => cmpVersion(b.version, a.version));
        if (c.length) return c[0];
    }
    return null;
}
function pickAnyTier(models, family) {
    const rank = t => { const i = TIER_STRENGTH.indexOf(t); return i < 0 ? TIER_STRENGTH.length : i; };
    const c = models.filter(m => m.family === family)
        .sort((a, b) => rank(a.tier) - rank(b.tier) || cmpVersion(b.version, a.version));
    return c[0] || null;
}

// rule: { family, tiers:[...], fallback?: { family, tiers:[...] } }
// Returns { model, how } where how = 'preferred' | 'tier-substitute' |
// 'fallback' | 'fallback-tier-substitute', or null if nothing fits at all.
function bestFor(rule, models) {
    let m = pick(models, rule.family, rule.tiers);
    if (m) return { model: m, how: 'preferred' };
    if (rule.fallback) {
        m = pick(models, rule.fallback.family, rule.fallback.tiers);
        if (m) return { model: m, how: 'fallback' };
    }
    m = pickAnyTier(models, rule.family);
    if (m) return { model: m, how: 'tier-substitute' };
    if (rule.fallback) {
        m = pickAnyTier(models, rule.fallback.family);
        if (m) return { model: m, how: 'fallback-tier-substitute' };
    }
    return null;
}

// Is this (classified) model a full match for the rule, i.e. not a stand-in?
function isPreferred(rule, m) {
    return !!m && m.family === rule.family && rule.tiers.includes(m.tier);
}

// Core step. rules: { id: rule }, current: { id: agyDisplayName },
// available: [{short,name}] from parseAgyModels.
// Returns { assignments: { id: { model, short, status, newer?, note? } }, changes: [...] }
//   status: 'ok'         current model listed and a full match
//           'substitute' served by a stand-in (fallback family or other tier)
//           'missing'    nothing fits — the id keeps its last name and will fail
function resolveAll(rules, current, available) {
    const models = available.map(classify).filter(Boolean);
    const byName = new Map(available.map(e => [e.name, e]));
    const assignments = {};
    const changes = [];

    for (const [id, rule] of Object.entries(rules)) {
        const curName = current[id];
        const curEntry = curName ? byName.get(curName) : null;
        const cur = curEntry ? classify(curEntry) : null;
        const best = bestFor(rule, models);
        let chosen, why;

        if (curEntry && (isPreferred(rule, cur) || !best || best.how !== 'preferred')) {
            // Still listed, and either a full match or nothing better to return to.
            chosen = cur || { ...curEntry };
        } else if (curEntry && best && best.how === 'preferred') {
            chosen = best.model; why = 'return-from-substitute';
        } else if (best) {
            chosen = best.model; why = 'vanished';
        } else {
            chosen = null;
        }

        if (!chosen) {
            assignments[id] = { model: curName || null, short: null, status: 'missing',
                note: `brak modelu rodziny ${rule.family}${rule.fallback ? ` ani ${rule.fallback.family}` : ''} w agy models` };
            continue;
        }
        const status = isPreferred(rule, chosen) ? 'ok' : 'substitute';
        const a = { model: chosen.name, short: chosen.short, status };
        if (status === 'ok') {
            const top = pick(models, rule.family, [chosen.tier]);
            if (top && cmpVersion(top.version, chosen.version) > 0) a.newer = top.name;
        } else {
            a.note = `zastępstwo: brak ${rule.family} (${rule.tiers.join('/')})`;
        }
        assignments[id] = a;
        if (why && chosen.name !== curName) changes.push({ id, from: curName || null, to: chosen.name, why });
    }
    return { assignments, changes };
}

module.exports = { FAMILIES, parseAgyModels, classify, resolveAll, cmpVersion, parseVersion };
