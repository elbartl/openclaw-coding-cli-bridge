'use strict';
/**
 * tools/webread/extract.js - HTML to text extraction and invisible content stripper.
 *
 * Requirements:
 * - htmlToText(html, { baseUrl, maxChars = 60000 })
 * - Zero external dependencies.
 * - Removes: <script>, <style>, <noscript>, <template>, <svg>, HTML comments.
 * - Removes hidden elements: display:none, visibility:hidden, hidden attribute,
 *   aria-hidden="true", opacity:0, font-size:0, matching text & background colors, transparent.
 * - Strips zero-width and bidi-control characters: U+200B-200F, U+202A-202E, U+2060-2064, U+FEFF.
 * - Alt/title attributes included only when element is visible.
 * - Preserves tables (with cell separators), code blocks, headings, lists, links as `tekst (url)`.
 * - Handles non-HTML formats (text/plain, markdown, json) cleanly by stripping invisible characters.
 * - Enforces 60,000 character limit: returns reason 'too_long' without silent truncation.
 * - Returns counter of removed hidden fragments.
 */

const MAX_CHARS = 60000;

// Zero-width, bidi-control, tag characters, variation selectors, and filler characters
const INVISIBLE_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180E\u200B-\u200F\u202A-\u202E\u2060-\u206F\u2800\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}\u{E0100}-\u{E01EF}]/gu;

// HTML entities table
const NAMED_ENTITIES = {
    amp: '&',
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    ndash: '–',
    mdash: '—',
    hellip: '…',
    copy: '©',
    reg: '®',
    trade: '™',
    laquo: '«',
    raquo: '»',
    colon: ':',
    semi: ';',
    equals: '=',
    sol: '/',
    bsol: '\\',
    plus: '+',
    minus: '-',
    hyphen: '-',
    dash: '-',
    comma: ',',
    period: '.',
    excl: '!',
    quest: '?',
    num: '#',
    dollar: '$',
    percnt: '%',
    lowbar: '_',
    vert: '|',
    space: ' ',
    tab: '\t',
    newline: '\n',
};

// HTML5 void tags (no closing tag)
const VOID_TAGS = new Set([
    'area', 'base', 'br', 'col', 'embed', 'hr', 'img',
    'input', 'link', 'meta', 'param', 'source', 'track', 'wbr',
]);

// Tags whose contents must never leak into extracted text
const RAW_CONTENT_TAGS = new Set(['script', 'style', 'noscript', 'template', 'svg']);

/**
 * Decodes HTML entities (named, decimal, hexadecimal, with or without semicolon).
 */
function decodeEntities(str) {
    if (!str) return '';
    let s = str.replace(/&#([xX][0-9a-fA-F]+|\d+);?/g, (match, code) => {
        const isHex = code[0] === 'x' || code[0] === 'X';
        const num = isHex ? parseInt(code.slice(1), 16) : parseInt(code, 10);
        if (Number.isFinite(num) && num > 0 && num <= 0x10ffff) {
            try {
                return String.fromCodePoint(num);
            } catch (_) {
                return ' ';
            }
        }
        return ' ';
    });
    s = s.replace(/&([a-zA-Z]+);?/g, (match, name) => {
        const lower = name.toLowerCase();
        if (NAMED_ENTITIES[lower] !== undefined) {
            return NAMED_ENTITIES[lower];
        }
        return match;
    });
    return s;
}

/**
 * Strips zero-width and bidi control characters, returning cleaned string and count.
 */
function cleanInvisibleChars(str) {
    if (str == null) return { text: '', count: 0 };
    const s = String(str);
    const matches = s.match(INVISIBLE_RE);
    const count = matches ? matches.length : 0;
    const text = s.replace(INVISIBLE_RE, '');
    return { text, count };
}

/**
 * Normalizes CSS color values for comparison.
 */
function normalizeCssColor(val) {
    if (!val) return '';
    const v = String(val).trim().toLowerCase().replace(/\s+/g, '');
    if (v === '#fff' || v === '#ffffff' || v === 'white' || v === 'rgb(255,255,255)') return '#ffffff';
    if (v === '#000' || v === '#000000' || v === 'black' || v === 'rgb(0,0,0)') return '#000000';
    return v;
}

/**
 * Heuristic check if an inline style string hides content.
 */
function isStyleHidden(styleStr) {
    if (!styleStr || typeof styleStr !== 'string') return false;
    const s = styleStr.toLowerCase();

    // display: none
    if (/display\s*:\s*none\b/.test(s)) return true;

    // visibility: hidden | collapse
    if (/visibility\s*:\s*(hidden|collapse)\b/.test(s)) return true;

    // opacity: 0 (or 0.0)
    if (/opacity\s*:\s*0(?:\.0+)?(?![0-9])/.test(s)) return true;

    // font-size: 0
    if (/font-size\s*:\s*0(?:px|em|rem|%|pt|vw|vh)?(?![0-9])/.test(s)) return true;

    // zero size with hidden overflow
    if (/(?:height|width)\s*:\s*0(?:px)?\b[^;]*;\s*overflow\s*:\s*hidden/.test(s) ||
        /overflow\s*:\s*hidden\b[^;]*;\s*(?:height|width)\s*:\s*0(?:px)?\b/.test(s)) {
        return true;
    }

    // off-screen positioning tricks
    if (/text-indent\s*:\s*-[0-9]{3,}/.test(s)) return true;
    if (/(?:left|top)\s*:\s*-[0-9]{3,}(?:px|em)/.test(s) && /position\s*:\s*absolute/.test(s)) return true;

    // transparent text
    if (/color\s*:\s*transparent\b/.test(s)) return true;
    if (/color\s*:\s*rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(?:\.0+)?\s*\)/.test(s)) return true;

    // matching text and background color
    const colorMatch = s.match(/(?:^|;)\s*color\s*:\s*([^;]+)/);
    const bgMatch = s.match(/(?:^|;)\s*(?:background|background-color)\s*:\s*([^;]+)/);
    if (colorMatch && bgMatch) {
        const c = normalizeCssColor(colorMatch[1]);
        const bg = normalizeCssColor(bgMatch[1]);
        if (c && bg && c === bg) return true;
    }

    return false;
}

/**
 * Checks if attributes hide an element.
 * Decodes HTML entities (named, decimal, hex, without semicolons) in attribute names and values
 * before analyzing style, hidden, and aria-hidden attributes.
 */
function isTagHidden(attrStr) {
    if (!attrStr) return false;
    const decoded = decodeEntities(attrStr);

    // hidden attribute (with or without value, case-insensitive: hidden, HIDDEN, Hidden)
    if (/(?:^|[\s/])hidden(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?(?=[\s/>]|$)/i.test(decoded)) {
        return true;
    }

    // aria-hidden="true" or aria-hidden (case-insensitive)
    if (/(?:^|[\s/])aria-hidden(?:\s*=\s*["']?true["']?|(?=[\s/>]|$))/i.test(decoded)) {
        return true;
    }

    // style attribute check
    const styleMatch = decoded.match(/(?:^|[\s/])style\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
    if (styleMatch) {
        const style = decodeEntities(styleMatch[1] || styleMatch[2] || styleMatch[3] || '');
        if (isStyleHidden(style)) return true;
    }

    return false;
}

/**
 * Parses HTML and extracts clean readable text with hidden fragments removed.
 *
 * @param {string|Buffer} html
 * @param {object} [options]
 * @param {string} [options.baseUrl]
 * @param {number} [options.maxChars=60000]
 * @returns {{ ok: boolean, text?: string, hiddenCount: number, length: number, reason?: string }}
 */
function htmlToText(html, options = {}) {
    const maxChars = options.maxChars || MAX_CHARS;
    const baseUrl = options.baseUrl || '';

    let raw = String(html || '');

    // 1. Strip <script>, <style>, <noscript>, <template>, <svg> and their contents (including unclosed to end of doc)
    raw = raw.replace(/<(script|style|noscript|template|svg)\b[^>]*>(?:[\s\S]*?<\/\1>|[\s\S]*$)/gi, '');

    // 2. Strip HTML comments
    raw = raw.replace(/<!--[\s\S]*?-->/g, '');

    // 3. Clean zero-width and bidi characters
    const { text: cleanRaw, count: invisCount } = cleanInvisibleChars(raw);
    let hiddenCount = invisCount;

    // 4. Tokenize HTML into tags and text chunks
    const TAG_RE = /<\/?([a-zA-Z0-9:-]+)([^>]*?)>/g;
    const stack = [];
    let output = '';
    let lastIndex = 0;
    let match;

    while ((match = TAG_RE.exec(cleanRaw)) !== null) {
        const textBefore = cleanRaw.slice(lastIndex, match.index);
        lastIndex = TAG_RE.lastIndex;

        const isCurrentlyHidden = stack.length > 0 && stack[stack.length - 1].hidden;

        if (textBefore.length > 0 && !isCurrentlyHidden) {
            const inCode = stack.some(el => el.tag === 'pre' || el.tag === 'code');
            const decoded = decodeEntities(textBefore);
            if (inCode) {
                output += decoded;
            } else {
                output += decoded;
            }
        }

        const fullTag = match[0];
        const isCloseTag = fullTag.startsWith('</');
        const tagName = match[1].toLowerCase();
        const attrStr = match[2] || '';
        const isVoid = VOID_TAGS.has(tagName) || fullTag.endsWith('/>');

        if (isCloseTag) {
            // Find matching open tag in stack
            let foundIdx = -1;
            for (let i = stack.length - 1; i >= 0; i--) {
                if (stack[i].tag === tagName) {
                    foundIdx = i;
                    break;
                }
            }

            if (foundIdx >= 0) {
                const popped = stack[foundIdx];
                const wasHidden = popped.hidden;
                stack.length = foundIdx; // unwind stack

                if (!wasHidden) {
                    if (tagName === 'a' && popped.href) {
                        const linkText = output.slice(popped.textStart).trim();
                        if (linkText) {
                            output = output.slice(0, popped.textStart) + `${linkText} (${popped.href})`;
                        } else {
                            output = output.slice(0, popped.textStart) + `(${popped.href})`;
                        }
                    } else if (tagName === 'tr') {
                        output += '\n';
                    } else if (tagName === 'table') {
                        output += '\n\n';
                    } else if (['p', 'div', 'section', 'article', 'header', 'footer', 'title'].includes(tagName)) {
                        output += '\n\n';
                    } else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
                        output += '\n\n';
                    } else if (tagName === 'ul' || tagName === 'ol') {
                        output += '\n';
                    }
                }
            }
        } else {
            // Open tag
            const isRawTag = RAW_CONTENT_TAGS.has(tagName);
            const tagHidden = isTagHidden(attrStr) || isRawTag;
            const hidden = isCurrentlyHidden || tagHidden;

            if (tagHidden && !isCurrentlyHidden) {
                hiddenCount++;
            }

            if (isVoid) {
                if (!hidden) {
                    if (tagName === 'br') {
                        output += '\n';
                    } else if (tagName === 'hr') {
                        output += '\n---\n';
                    } else if (tagName === 'img') {
                        const altMatch = attrStr.match(/\balt\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
                        const alt = altMatch ? (altMatch[1] || altMatch[2] || altMatch[3]) : '';
                        if (alt) {
                            output += ` [${decodeEntities(alt)}] `;
                        }
                    }
                }
            } else {
                let href = null;
                if (tagName === 'a') {
                    const hrefMatch = attrStr.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i);
                    let rawHref = hrefMatch ? (hrefMatch[1] || hrefMatch[2] || hrefMatch[3]) : '';
                    if (rawHref && baseUrl) {
                        try {
                            rawHref = new URL(rawHref, baseUrl).href;
                        } catch (_) {
                            // keep rawHref as-is
                        }
                    }
                    href = rawHref;
                }

                if (!hidden) {
                    if (tagName === 'title') {
                        if (output.length > 0 && !output.endsWith('\n\n')) {
                            output += output.endsWith('\n') ? '\n' : '\n\n';
                        }
                    } else if (['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].includes(tagName)) {
                        output += '\n\n';
                    } else if (tagName === 'li') {
                        output += '\n- ';
                    } else if (tagName === 'td' || tagName === 'th') {
                        const currentTr = stack.slice().reverse().find(el => el.tag === 'tr');
                        if (currentTr && currentTr.cells > 0) {
                            output += ' | ';
                        }
                        if (currentTr) currentTr.cells = (currentTr.cells || 0) + 1;
                    }
                }

                stack.push({
                    tag: tagName,
                    hidden,
                    href,
                    textStart: output.length,
                    cells: tagName === 'tr' ? 0 : undefined,
                });
            }
        }
    }

    // Trailing text after last tag
    if (lastIndex < cleanRaw.length && !(stack.length > 0 && stack[stack.length - 1].hidden)) {
        output += decodeEntities(cleanRaw.slice(lastIndex));
    }

    // 5. Whitespace normalization
    let normalized = output
        .replace(/[ \t\f\v\u00a0]+/g, ' ')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

    // 6. Check maxChars limit (60,000)
    if (normalized.length > maxChars) {
        return {
            ok: false,
            reason: 'too_long',
            length: normalized.length,
            hiddenCount,
        };
    }

    return {
        ok: true,
        text: normalized,
        length: normalized.length,
        hiddenCount,
    };
}

/**
 * Extracts content according to Content-Type (HTML, text/plain, markdown, JSON).
 */
function extractContent(body, contentType = 'text/html', options = {}) {
    const raw = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
    const ct = String(contentType || '').toLowerCase();

    if (ct.includes('html') || ct.includes('xml')) {
        return htmlToText(raw, options);
    }

    // For plain text, markdown, json: preserve content, strip invisible control characters
    const { text: cleaned, count: invisCount } = cleanInvisibleChars(raw);
    const maxChars = options.maxChars || MAX_CHARS;

    if (cleaned.length > maxChars) {
        return {
            ok: false,
            reason: 'too_long',
            length: cleaned.length,
            hiddenCount: invisCount,
        };
    }

    return {
        ok: true,
        text: cleaned,
        length: cleaned.length,
        hiddenCount: invisCount,
    };
}

module.exports = {
    htmlToText,
    extractContent,
    cleanInvisibleChars,
    isStyleHidden,
    isTagHidden,
    decodeEntities,
    MAX_CHARS,
};
