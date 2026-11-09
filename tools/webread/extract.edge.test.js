'use strict';
/**
 * tools/webread/extract.edge.test.js
 * Niezależne testy brzegowe i adwersaryjne modułu ekstrakcji HTML (tools/webread/extract.js).
 */
const test = require('node:test');
const assert = require('node:assert');
const { htmlToText, extractContent, cleanInvisibleChars, decodeEntities } = require('./extract');

test('Extract edge: standardowe warianty ukrywania tekstu CSS/HTML', () => {
    // hidden attribute wielkimi literami
    const r1 = htmlToText('<div HIDDEN>ukryty tekst</div><p>widoczny</p>');
    assert.strictEqual(r1.text, 'widoczny');
    assert.strictEqual(r1.hiddenCount, 1);

    // aria-hidden="true"
    const r2 = htmlToText('<div aria-hidden="true">ukryty aria</div><p>widoczny</p>');
    assert.strictEqual(r2.text, 'widoczny');

    // display:none wielkimi literami
    const r3 = htmlToText('<div style="DISPLAY: NONE">ukryty display</div><p>widoczny</p>');
    assert.strictEqual(r3.text, 'widoczny');

    // visibility:collapse
    const r4 = htmlToText('<div style="visibility: collapse">ukryty collapse</div><p>widoczny</p>');
    assert.strictEqual(r4.text, 'widoczny');

    // font-size: 0px / opacity: 0
    const r5 = htmlToText('<span style="font-size: 0px">zero font</span><span style="opacity: 0">zero opacity</span><p>widoczny</p>');
    assert.strictEqual(r5.text, 'widoczny');

    // off-screen text-indent
    const r6 = htmlToText('<div style="text-indent: -9999px">offscreen</div><p>widoczny</p>');
    assert.strictEqual(r6.text, 'widoczny');
});

test('Extract edge [REPRODUKCJA BŁĘDU]: encje HTML w atrybutach omijają detektor ukrytej treści', () => {
    // BŁĄD 1: Encja hex w stylu (np. display&#x3a;none)
    // Przeglądarka dekoduje encje w wartościach atrybutów HTML przed parsowaniem CSS,
    // więc użytkownik NIE widzi tekstu na ekranie. Jednak extract.js nie dekoduje encji
    // w atrybutach i traktuje element jako w 100% widoczny!
    const rHex = htmlToText('<div style="display&#x3a;none">ukryty przez hex encje</div><p>widoczny</p>');
    assert.strictEqual(rHex.text, 'widoczny', 'LUKA: display&#x3a;none nie może wyciekać do tekstu widocznego');

    // BŁĄD 2: Nazwana encja &colon;
    const rNamed = htmlToText('<div style="display&colon;none">ukryty przez colon encje</div><p>widoczny</p>');
    assert.strictEqual(rNamed.text, 'widoczny', 'LUKA: display&colon;none nie może wyciekać do tekstu widocznego');

    // BŁĄD 3: Encja w nazwie atrybutu (np. &#104;idden)
    const rAttr = htmlToText('<div &#104;idden>ukryty przez encje w nazwie atrybutu</div><p>widoczny</p>');
    assert.strictEqual(rAttr.text, 'widoczny', 'LUKA: &#104;idden nie może wyciekać do tekstu widocznego');
});

test('Extract edge [REPRODUKCJA BŁĘDU]: znaki tag-characters U+E0000-U+E007F (niewidzialne instrukcje LLM)', () => {
    // Unicode Plane 14 Tag Characters (U+E0001, U+E0020-U+E007E) to niewidoczne znaki
    // mapujące bajty ASCII, używane powszechnie do niewidzialnych prompt injection.
    // cleanInvisibleChars filtruje tylko U+200B-200F, U+202A-202E, U+2060-2064, U+FEFF,
    // pomijając całkowicie znaki tag characters!
    const tagPayload = 'Widoczny tekst \u{E0001}\u{E0020}\u{E0041}\u{E0042}\u{E0043} koniec';
    const cleaned = cleanInvisibleChars(tagPayload);
    assert.strictEqual(cleaned.text, 'Widoczny tekst  koniec', 'LUKA: tag-characters U+E0000-U+E007F muszą zostać wycięte');
    assert.ok(cleaned.count >= 4, 'Licznik usuniętych znaków niewidocznych musi wzrosnąć');
});

test('Extract edge: zachowanie struktury tabel, kodu, list i linków z baseUrl', () => {
    const html = `
        <table>
            <tr><th>Nagłówek 1</th><th>Nagłówek 2</th></tr>
            <tr><td>Dane A</td><td>Dane B</td></tr>
        </table>
        <ul>
            <li>Element 1</li>
            <li>Element 2</li>
        </ul>
        <pre><code>const a = 1; &amp;&amp; const b = 2;</code></pre>
        <p><a href="/dok/api">Dokumentacja</a></p>
    `;
    const res = htmlToText(html, { baseUrl: 'https://docs.example.com/v1/' });
    assert.strictEqual(res.ok, true);
    assert.ok(res.text.includes('Nagłówek 1 | Nagłówek 2'));
    assert.ok(res.text.includes('Dane A | Dane B'));
    assert.ok(res.text.includes('- Element 1'));
    assert.ok(res.text.includes('const a = 1; && const b = 2;'));
    assert.ok(res.text.includes('Dokumentacja (https://docs.example.com/dok/api)'));
});

test('Extract edge: niedomknięte i zagnieżdżone elementy HTML', () => {
    // Poprawne unwinding przy zagnieżdżonych i krzyżowo niedomkniętych tagach
    const html = '<div><span style="display:none"><b>ukryte</span>widoczne</b></div>';
    const res = htmlToText(html);
    assert.strictEqual(res.ok, true);
    assert.strictEqual(res.text, 'widoczne');

    // Dziecko ukrytego elementu nie może się samo odmaskować
    const nestedHtml = '<div style="display:none"><div style="display:block">nadal ukryte</div></div><p>widoczne</p>';
    const resNested = htmlToText(nestedHtml);
    assert.strictEqual(resNested.ok, true);
    assert.strictEqual(resNested.text, 'widoczne');
});

test('Extract edge: twardy limit 60 000 znaków (fail-closed, brak cichego obcinania)', () => {
    const longHtml = '<p>' + 'X'.repeat(60001) + '</p>';
    const res = htmlToText(longHtml, { maxChars: 60000 });
    assert.strictEqual(res.ok, false);
    assert.strictEqual(res.reason, 'too_long');
    assert.strictEqual(res.text, undefined, 'Nie wolno zwracać obciętego tekstu przy przekroczeniu limitu');
});

test('Extract edge (runda 3): warianty tagów RAW (niedomknięte script, STYLE, type=module, svg, template, komentarz ze script)', () => {
    // 1. Niedomknięty <script> w środku tekstu: tekst PRZED zostaje, nic z wnętrza nie wycieka
    const rUnclosed = htmlToText('Widoczny tekst przed <script> alert("tajny payload injection");');
    assert.strictEqual(rUnclosed.ok, true);
    assert.strictEqual(rUnclosed.text, 'Widoczny tekst przed');
    assert.strictEqual(rUnclosed.text.includes('tajny payload'), false);

    // 2. <STYLE> wielkimi literami
    const rStyle = htmlToText('Nagłówek <STYLE> body { background: red; } </STYLE> Treść artykułu');
    assert.strictEqual(rStyle.ok, true);
    assert.strictEqual(rStyle.text, 'Nagłówek Treść artykułu');
    assert.strictEqual(rStyle.text.includes('background'), false);

    // 3. <script type=module>
    const rModule = htmlToText('Tekst A <script type="module"> import { inject } from "./exploit.js"; </script> Tekst B');
    assert.strictEqual(rModule.ok, true);
    assert.strictEqual(rModule.text, 'Tekst A Tekst B');
    assert.strictEqual(rModule.text.includes('exploit'), false);

    // 4. <svg><script>
    const rSvg = htmlToText('Tekst przed <svg><script>alert(document.cookie)</script><text>ukryty wektor</text></svg> Tekst po');
    assert.strictEqual(rSvg.ok, true);
    assert.strictEqual(rSvg.text, 'Tekst przed Tekst po');
    assert.strictEqual(rSvg.text.includes('cookie'), false);
    assert.strictEqual(rSvg.text.includes('ukryty wektor'), false);

    // 5. <template> w środku tekstu
    const rTpl = htmlToText('Początek <template><div>Szablon nie powinien być w wyjściu</div></template> Koniec');
    assert.strictEqual(rTpl.ok, true);
    assert.strictEqual(rTpl.text, 'Początek Koniec');
    assert.strictEqual(rTpl.text.includes('Szablon'), false);

    // 6. Komentarz zawierający <script>
    const rComment = htmlToText('Przed <!-- komentarz z <script>payload()</script> w środku --> Po');
    assert.strictEqual(rComment.ok, true);
    assert.strictEqual(rComment.text, 'Przed Po');
    assert.strictEqual(rComment.text.includes('payload'), false);

    // 7. </script > ze spacją: tekst przed znacznikiem zostaje, nic z wnętrza nie wycieka
    const rSpaceClose = htmlToText('Początek <script>alert(1);</script > Środek');
    assert.strictEqual(rSpaceClose.ok, true);
    assert.strictEqual(rSpaceClose.text.includes('Początek'), true);
    assert.strictEqual(rSpaceClose.text.includes('alert'), false, 'Kod ze środka nie może wyciec');
});

