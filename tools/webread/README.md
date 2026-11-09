# WebRead MCP Tool

Bezpieczny czytnik stron WWW (MCP Server) dla agentów AI i ról operacyjnych (`ops`), zaprojektowany z myślą o architekturze odpornej na ataki SSRF (Server-Side Request Forgery), ukryte instrukcje w treści stron (CSS/Unicode stealth injection) oraz próby przejęcia kontekstu modelu (Prompt Injection & Hijacking).

Działa jako serwer MCP komunikujący się przez standardowe wejście/wyjście (`stdio`), implementując protokół JSON-RPC 2.0 **bez zewnętrznych zależności npm** (wyłącznie wbudowane moduły Node.js).

---

## Architektura i Potok Ochrony (Defense in Depth)

Odczyt zewnętrznego zasobu WWW realizowany jest w wieloetapowym, rygorystycznym potoku *fail-closed*:

```
[ Żądanie MCP: web_read(url) ]
              │
              ▼
    1. Sanityzacja URL & Query String (server.js)
       - Usunięcie fragmentów (#hash)
       - Usunięcie tokenów, kluczy API, haseł (sk-, ghp-, AKIA, hex, base64)
              │
              ▼
    2. Walidacja SSRF & Pobranie z IP Pinning (ssrf.js)
       - Blokada adresów prywatnych IPv4/IPv6, localhost, LAN, CGNAT, link-local
       - Ochrona przed DNS rebinding poprzez wstępny resolve i pinning IP socketu
       - Weryfikacja każdego skoku przekierowania (hop-by-hop revalidation, max 5)
       - Streaming limit rozmiaru (fail-closed, brak wycieku częściowego)
       - Whitelista Content-Type (HTML, text, markdown, JSON, XML)
              │
              ▼
    3. Ekstrakcja Tekstu & Oczyszczanie (extract.js)
       - Usunięcie skryptów, stylów, noscript, template, SVG, komentarzy
       - Detekcja i usuwanie ukrytych elementów CSS (display:none, visibility:hidden, opacity:0, font-size:0, zbieżne kolory)
       - Filtrowanie znaków zero-width, bidi-control oraz Unicode Tag Characters (U+E0000–U+E007F)
       - Zachowanie semantyki: tabele, kod, nagłówki, listy, odnośniki
       - Twardy limit długości (60 000 znaków) z fail-closed (too_long)
              │
              ▼
    4. Kawałkowe Skanowanie Prompt Injection CLEF (scan.js)
       - Sprawdzenie budżetu neuronów i flagi DISABLED z góry (pre-flight check)
       - Podział na nakładające się okna (~4000 znaków, overlap ~1000 znaków)
       - Analiza każdego kawałka przez model @cf/cloudflare/clef (injection & hijack)
       - Natychmiastowe przerwanie przy wykryciu skazy (p >= 0.50), błędzie lub timeout
       - Atomowe blokowanie lockfile dla współbieżnych procesów
              │
              ▼
    5. Podpis HMAC & Kwarantanna (server.js)
       - Czysty tekst: opakowanie w <external-source url=… clef=ok sha=…> + podpis HMAC
       - Wykryte zagrożenie: zapis do kwarantanny, odmowa fail-closed bez ujawniania treści
```

---

## Moduły

### 1. Ochrona SSRF i Pobieranie (`ssrf.js`)
* **Weryfikacja zakresów IP:** Pełna zgodność ze standardami RFC dla IPv4 i IPv6:
  * IPv4: `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `127.0.0.0/8`, `169.254.0.0/16` (link-local / AWS metadata), `100.64.0.0/10` (CGNAT), `0.0.0.0/8`, `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, `224.0.0.0/4`, `240.0.0.0/4`, `255.255.255.255`.
  * IPv6: `::1`, `::`, `fc00::/7` (ULA), `fe80::/10` (link-local), `ff00::/8` (multicast), `2001:db8::/32` (dokumentacja), `2001:10::/28` (ORCHID), `100::/64` (Discard), adresy mapowane IPv4 (`::ffff:x.x.x.x`), translacja SIIT (`::ffff:0:x.x.x.x`), IPv4-compatible (`::x.x.x.x`), prefiksy NAT64 (`64:ff9b::/96` oraz `64:ff9b:1::/48`).
* **Wykrywanie obfuskacji IP:** Blokowanie notacji dziesiętnych (DWORD), ósemkowych (octal), szesnastkowych (hex) oraz poświadczeń w adresie URL (`user:pass@host`).
* **IP Pinning (ochrona przed DNS Rebinding):**
  * Resolver sprawdza wszystkie zwrócone rekordy DNS (A / AAAA). Jeśli którykolwiek wskazuje na IP prywatne, żądanie jest odrzucane.
  * Klient HTTP/HTTPS wymusza połączenie TCP bezpośrednio z przypiętym, zweryfikowanym adresem IP (`createPinnedLookup`), zapobiegając atakom typu TOCTOU (Time-of-Check to Time-of-Use).
  * SNI (Server Name Indication) oraz nagłówek `Host` są poprawnie zachowywane dla weryfikacji TLS i routingu vhostów.
* **Strumieniowanie z limitem rozmiaru:** Treść jest pobierana strumieniowo z twardym limitem bajtów (domyślnie 2 MB). W przypadku przekroczenia połączenie jest natychmiast przerywane, a częściowy bufor niszczony (`too_large`).

### 2. Ekstrakcja Tekstu i Usuwanie Ukrytych Elementów (`extract.js`)
* **Usuwanie niewidocznych znaczników:** Całkowite wycinanie sekcji `<script>`, `<style>`, `<noscript>`, `<template>`, `<svg>` oraz komentarzy HTML.
* **Detekcja ukrywania przez CSS:**
  * Właściwości stylów: `display:none`, `visibility:hidden`, `opacity:0`, `font-size:0`, `color:transparent`, `background:transparent`.
  * Analiza kontrastu i zbieżności kolorów tekstu i tła (np. biały tekst na białym tle, czarny na czarnym, w notacjach hex, rgb, rgba).
  * Atrybuty HTML: `hidden`, `aria-hidden="true"`.
* **Usuwanie znaków niewidocznych i sterujących:**
  * Znaki o zerowej szerokości: U+200B–U+200F, U+FEFF, U+2060–U+2064, U+180E, U+00AD.
  * Znaki kierunkowości tekstu (BiDi control): U+202A–U+202E, U+061C, U+2066–U+2069 (używane w atakach Trojan Source).
  * Znaki Tag Characters (U+E0000–U+E007F): używane w niewidzialnych wektorach prompt injection kierowanych w modele LLM.
* **Zachowanie struktury dokumentu:** Konwersja tabel na czytelny układ tekstowy z separatorami kolumn, zachowanie bloków kodu, nagłówków, list i odnośników w formacie `[tekst](url)`.
* **Twardy limit znaków:** Domyślnie 60 000 znaków. Przekroczenie limitu zwraca błąd `too_long` (fail-closed, brak cichego ucinania tekstu).

### 3. Kawałkowy Skaner Prompt Injection (`scan.js`)
* **Podział na nakładające się kawałki (Chunking):**
  * Domyślny rozmiar kawałka: 4000 znaków.
  * Zakładka (overlap): 1000 znaków.
  * Gwarantuje, że instrukcje injection umieszczone na granicy podziału tekstu zostaną w całości objęte co najmniej jednym oknem analizy.
* **Model CLEF:** Każdy fragment jest poddawany ewaluacji przez klasyfikator bezpieczeństwa `@cf/cloudflare/clef` w pytaniach o:
  1. Prompt Injection (próby zmiany instrukcji systemowych, wycieku sekretów, wywoływania narzędzi).
  2. Task Hijack (odchylenie od tematu i wymuszanie niebezpiecznych akcji).
* **Zarządzanie budżetem i limity dobowe:**
  * Rezerwa dla strażników głównych zadań (`DEFAULT_GUARD_RESERVE = 1500` neuronów).
  * Dedykowany podlimit webread (`DEFAULT_SUB_CAP = 1500` neuronów na dobę).
  * Pre-flight check: oszacowanie kosztu i sprawdzenie dostępności neuronów przed wysłaniem zapytań HTTP.
  * Atomowe blokowanie lockfile (`budget.lock`) z obsługą czyszczenia porzuconych plików blokad (stale PID / timeout).
* **Kryptograficzny stempel integralności:**
  * Po pomyślnym przeskanowaniu wszystkich fragmentów tekst jest opatrywany nagłówkiem:
    `<external-source url="..." clef=ok sha="...">`
  * Na końcu dołączany jest stempel HMAC-SHA256:
    `<!-- clef:ok:<hmac> -->`
  * Wszelka modyfikacja treści przez niepowołany proces unieważnia weryfikację stempla.

### 4. Serwer MCP (`server.js`)
* Komunikacja JSON-RPC 2.0 przez standardowe wejście/wyjście (`stdio`).
* Udostępnia narzędzie `web_read` przyjmujące parametry:
  * `url` (wymagany): docelowy adres URL http(s).
  * `purpose` (opcjonalny): cel odczytu zapisywany w audytowym logu zdarzeń.
  * `summary` (opcjonalny): flaga zarezerwowana dla trybu streszczenia.
* **Ochrona przed wyciekiem w komunikatach błędów:** W przypadku odmowy (SSRF, zbyt duży rozmiar, błąd parsowania, wykrycie injection) treść obcej strony **nigdy** nie jest dołączana do zwracanego błędu ani logu JSONL.
* Wykryte zagrożenia są bezpiecznie izolowane w katalogu kwarantanny (`quarantine/<timestamp>-<sha256>.txt`).

---

## Uruchomienie i Konfiguracja

### Konfiguracja MCP (np. w pliku konfiguracyjnym klienta MCP / OpenClaw)

```json
{
  "mcpServers": {
    "webread": {
      "command": "node",
      "args": ["tools/webread/server.js"],
      "env": {
        "CLEF_ACCOUNT_ID": "<twoje_account_id_cloudflare>",
        "CLEF_API_TOKEN": "<twoj_api_token_cloudflare>"
      }
    }
  }
}
```

### Zmienne środowiskowe

| Zmienna | Opis | Domyślnie |
| :--- | :--- | :--- |
| `WEBREAD_STATE_DIR` | Ścieżka katalogu stanu (budżet, kwarantanna, DISABLED) | `~/.openclaw/state/webread` |
| `CLEF_KEY_FILE` | Ścieżka pliku klucza HMAC dla stempla integralności | `~/.openclaw/secrets/clef-guard.key` |
| `CLEF_ACCOUNT_ID` | Cloudflare Account ID do wywołań Workers AI | Wczytywane z pliku stanu lub env |
| `CLEF_API_TOKEN` | Cloudflare API Token do modelu `@cf/cloudflare/clef` | Wczytywane z pliku stanu lub env |

---

## Testy

Pakiet zawiera pełny zestaw testów jednostkowych i brzegowych (edge cases) opartych o wbudowany moduł `node:test`:

* `ssrf.test.js` & `ssrf.edge.test.js` – testy walidacji adresów IPv4/IPv6, bypassów hex/octal/SIIT/NAT64, DNS rebinding, przekierowań i limitów strumieniowania.
* `extract.test.js` & `extract.edge.test.js` – testy usuwania ukrytej zawartości CSS/HTML, encji HTML, znaków zero-width i tagów U+E0000.
* `scan.test.js` & `scan.edge.test.js` – testy algorytmu okienkowania (chunking & overlap), atomowości budżetu, fail-closed i weryfikacji HMAC.
* `server.test.js` & `server.edge.test.js` – testy protokołu MCP JSON-RPC, sanityzacji tokenów w URL, obsługi kwarantanny i izolacji treści błędów.

### Uruchomienie wszystkich testów

```bash
cd tools/webread
node ssrf.test.js && node ssrf.edge.test.js && node extract.test.js && node extract.edge.test.js && node scan.test.js && node scan.edge.test.js && node server.test.js && node server.edge.test.js
```
