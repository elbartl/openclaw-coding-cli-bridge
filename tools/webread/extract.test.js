'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const {
    htmlToText,
    extractContent,
    cleanInvisibleChars,
    isStyleHidden,
    isTagHidden,
    MAX_CHARS,
} = require('./extract.js');

test('extract: usuwa script, style, noscript, template, svg i komentarze', () => {
    const html = `
        <div>
            <h1>Tytuł artykułu</h1>
            <script>console.log("malicious code");</script>
            <style>body { color: red; }</style>
            <noscript><p>Włącz JavaScript</p></noscript>
            <template><div>Szablon niewidoczny</div></template>
            <svg><text>Wektor</text></svg>
            <!-- Komentarz HTML z instrukcją ataku -->
            <p>Treść właściwa strony.</p>
        </div>
    `;
    const r = htmlToText(html);
    assert.equal(r.ok, true);
    assert.ok(!r.text.includes('malicious code'));
    assert.ok(!r.text.includes('color: red'));
    assert.ok(!r.text.includes('Włącz JavaScript'));
    assert.ok(!r.text.includes('Szablon niewidoczny'));
    assert.ok(!r.text.includes('Wektor'));
    assert.ok(!r.text.includes('Komentarz HTML'));
    assert.ok(r.text.includes('Tytuł artykułu'));
    assert.ok(r.text.includes('Treść właściwa strony.'));
});

test('extract: usuwa elementy ukryte przez CSS i atrybuty HTML (display, visibility, hidden, aria-hidden)', () => {
    const html = `
        <article>
            <p>Widoczny akapit 1.</p>
            <p style="display:none">Ukryty atak prompt injection display:none</p>
            <div style="display: none; font-size: 14px">Inny ukryty element</div>
            <span style="visibility:hidden">Ukryty tekst visibility:hidden</span>
            <div hidden>Ukryty atrybutem hidden</div>
            <p aria-hidden="true">Ukryty przez aria-hidden</p>
            <div style="opacity: 0">Ukryty przez opacity: 0</div>
            <span style="font-size: 0px">Ukryty przez font-size: 0</span>
            <p>Widoczny akapit 2.</p>
        </article>
    `;
    const r = htmlToText(html);
    assert.equal(r.ok, true);
    assert.ok(r.text.includes('Widoczny akapit 1.'));
    assert.ok(r.text.includes('Widoczny akapit 2.'));
    assert.ok(!r.text.includes('Ukryty atak'));
    assert.ok(!r.text.includes('Inny ukryty'));
    assert.ok(!r.text.includes('visibility:hidden'));
    assert.ok(!r.text.includes('Ukryty atrybutem hidden'));
    assert.ok(!r.text.includes('aria-hidden'));
    assert.ok(!r.text.includes('opacity: 0'));
    assert.ok(!r.text.includes('font-size: 0'));
    assert.ok(r.hiddenCount >= 7, `Oczekiwano co najmniej 7 usuniętych elementów, otrzymano: ${r.hiddenCount}`);
});

test('extract: usuwa elementy z kolorem tekstu równym tłu oraz transparent', () => {
    const html = `
        <div>
            <p>Początek tekstu.</p>
            <span style="color: #ffffff; background-color: #ffffff">Biały tekst na białym tle</span>
            <span style="color: white; background: white">Biały tekst white/white</span>
            <span style="color: transparent">Tekst przezroczysty</span>
            <span style="color: rgba(255, 0, 0, 0)">Tekst alpha 0</span>
            <p>Koniec tekstu.</p>
        </div>
    `;
    const r = htmlToText(html);
    assert.equal(r.ok, true);
    assert.ok(r.text.includes('Początek tekstu.'));
    assert.ok(r.text.includes('Koniec tekstu.'));
    assert.ok(!r.text.includes('Biały tekst'));
    assert.ok(!r.text.includes('przezroczysty'));
    assert.ok(!r.text.includes('alpha 0'));
    assert.ok(r.hiddenCount >= 4);
});

test('extract: czyści znaki zero-width oraz bidi-control', () => {
    // U+200B (ZWSP), U+200C (ZWNJ), U+202E (RLO), U+FEFF (BOM)
    const dangerous = 'Zwyk\u200Bły \u200Ctek\u202Est \uFEFFz ukrytymi znakami';
    const r = htmlToText(`<p>${dangerous}</p>`);
    assert.equal(r.ok, true);
    assert.equal(r.text, 'Zwykły tekst z ukrytymi znakami');
    assert.equal(r.hiddenCount, 4);

    const { text, count } = cleanInvisibleChars(dangerous);
    assert.equal(text, 'Zwykły tekst z ukrytymi znakami');
    assert.equal(count, 4);
});

test('extract: atrybuty alt/title tylko gdy element jest widoczny', () => {
    const html = `
        <div>
            <img src="/logo.png" alt="Logo firmy">
            <img src="/track.png" alt="Ukryty tracking" style="display:none">
            <img src="/pixel.png" alt="Ukryty pixel" hidden>
        </div>
    `;
    const r = htmlToText(html);
    assert.equal(r.ok, true);
    assert.ok(r.text.includes('[Logo firmy]'));
    assert.ok(!r.text.includes('Ukryty tracking'));
    assert.ok(!r.text.includes('Ukryty pixel'));
    assert.equal(r.hiddenCount, 2);
});

test('extract: zachowuje tabele (z separatorami), kod, nagłówki, listy i linki', () => {
    const html = `
        <h1>Nagłówek 1</h1>
        <p>Wprowadzenie z linkiem do <a href="/kontakt">kontaktu</a> oraz do <a href="https://external.org/doc">dokumentacji</a>.</p>
        <ul>
            <li>Pierwszy punkt</li>
            <li>Drugi punkt</li>
        </ul>
        <pre><code>const a = 1;\nconst b = 2;\nreturn a + b;</code></pre>
        <table>
            <tr><th>Kolumna A</th><th>Kolumna B</th></tr>
            <tr><td>Wartość 1</td><td>Wartość 2</td></tr>
        </table>
    `;
    const r = htmlToText(html, { baseUrl: 'https://example.com/sub/' });
    assert.equal(r.ok, true);

    // Nagłówki i listy
    assert.ok(r.text.includes('Nagłówek 1'));
    assert.ok(r.text.includes('- Pierwszy punkt'));
    assert.ok(r.text.includes('- Drugi punkt'));

    // Linki: tekst (url) z rozwinięciem baseUrl dla relatywnych
    assert.ok(r.text.includes('kontaktu (https://example.com/kontakt)'));
    assert.ok(r.text.includes('dokumentacji (https://external.org/doc)'));

    // Kod
    assert.ok(r.text.includes('const a = 1;\nconst b = 2;\nreturn a + b;'));

    // Tabela: separatory komórek |
    assert.ok(r.text.includes('Kolumna A | Kolumna B'));
    assert.ok(r.text.includes('Wartość 1 | Wartość 2'));
});

test('extract: obsługuje formaty nietekstowe (text/plain, markdown, json) bez zmian poza czyszczeniem znaków niewidocznych', () => {
    const jsonStr = '{\n  "status": "ok",\n  "key": "val\u200Bue"\n}';
    const rJson = extractContent(jsonStr, 'application/json');
    assert.equal(rJson.ok, true);
    assert.equal(rJson.text, '{\n  "status": "ok",\n  "key": "value"\n}');
    assert.equal(rJson.hiddenCount, 1);

    const mdStr = '# Tytuł MD\n\n- Punkt 1\n- Punkt 2\n\n```js\nconst x = 10;\n```';
    const rMd = extractContent(mdStr, 'text/markdown');
    assert.equal(rMd.ok, true);
    assert.equal(rMd.text, mdStr);
    assert.equal(rMd.hiddenCount, 0);

    const txtStr = 'Prosty plik tekstowy bez HTML <script>nie dotykac</script>';
    const rTxt = extractContent(txtStr, 'text/plain');
    assert.equal(rTxt.ok, true);
    assert.equal(rTxt.text, txtStr);
});

test('extract: twardy limit 60 000 znaków (reason: too_long bez cichego ucinania)', () => {
    const longText = 'A'.repeat(MAX_CHARS + 50);
    const html = `<p>${longText}</p>`;
    const r = htmlToText(html);
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'too_long');
    assert.equal(r.length, MAX_CHARS + 50);
    assert.equal(r.text, undefined);

    // Test dla granicy <= 60 000
    const borderText = 'B'.repeat(1000);
    const rOk = htmlToText(`<p>${borderText}</p>`);
    assert.equal(rOk.ok, true);
    assert.equal(rOk.length, 1000);
});

test('extract: niedomknięte znaczniki <script>, <style>, <noscript>, <template>, <svg> nie wyciekają do tekstu', () => {
    const rScript = htmlToText('<p>a</p><script>alert(1)');
    assert.equal(rScript.ok, true);
    assert.ok(rScript.text.includes('a'));
    assert.ok(!rScript.text.includes('alert'));

    for (const tag of ['style', 'noscript', 'template', 'svg']) {
        const r = htmlToText(`<p>widoczne</p><${tag}>tajny_wyciek_123 <p>wewnatrz</p>`);
        assert.equal(r.ok, true, `Tag ${tag} powinien zwrócić ok`);
        assert.ok(r.text.includes('widoczne'), `Tag ${tag} powinien zachować tekst przed nim`);
        assert.ok(!r.text.includes('tajny_wyciek_123'), `Niedomknięty <${tag}> nie może wyciekać`);
        assert.ok(!r.text.includes('wewnatrz'), `Zawartość po niedomkniętym <${tag}> musi być ukryta do końca dokumentu`);
    }
});
