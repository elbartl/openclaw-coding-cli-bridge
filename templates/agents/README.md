# Uniwersalne Szablony Agentów Programistycznych OpenClaw

Kompletny zestaw szablonów ról, instrukcji wykonawczych (`SOUL.md` i `AGENTS.md`) oraz konfiguracji dla wieloagentowego zespołu inżynierii oprogramowania w środowisku [OpenClaw](https://openclaw.ai).

---

## 1. Architektura Zespołu

System opiera się na separacji obowiązków, zasadzie ograniczonego zaufania (Least Privilege) oraz bezwzględnym wymogu akceptacji człowieka przed wdrożeniem produkcyjnym (Human-in-the-Loop).

```
                      ┌─────────────────────────┐
                      │   OPERATOR (Człowiek)   │
                      └────────────┬────────────┘
                                   │
              1. Zgoda na plan     │   5. Zgoda na wdrożenie SHA
                                   ▼
                      ┌─────────────────────────┐
                      │    MASTER (Koordynator) │
                      └────────────┬────────────┘
                                   │
       ┌───────────────────────────┼───────────────────────────┐
       ▼                           ▼                           ▼
┌──────────────┐            ┌──────────────┐            ┌──────────────┐
│  DEVELOPER   │◄──────────►│    TESTER    │            │   REVIEWER   │
│  (Rola: dev) │  Wspólne   │  (Rola: dev) │            │  (Rola: rev) │
│ Implementacja│  Worktree  │ Testy skrajne│            │  Tylko odczyt│
└──────────────┘            └──────────────┘            └──────────────┘
                                                               │
                                  ┌────────────────────────────┘
                                  ▼
                      ┌─────────────────────────┐
                      │   EXECUTOR (Wdrożenie)  │
                      │  (Rola: ops / Host)     │
                      │  Merge --ff-only & Push │
                      └─────────────────────────┘
```

### Role i Odpowiedzialności

| Agent | Katalog | Rola Proxy | Uprawnienia | Zadanie główne |
|---|---|---|---|---|
| **`master`** | `master/` | `ops` | Shell / Zarządzanie sprawami | Dekompozycja problemu, pilnowanie kontraktów, koordynacja etapów, kontakt z człowiekiem. |
| **`developer`** | `developer/` | `dev` | Sandbox (worktree + bwrap, no-net) | Implementacja zmian w kodzie oraz testów jednostkowych; minimalny diff. |
| **`tester`** | `tester/` | `dev` | Sandbox (worktree + bwrap, no-net) | Niezależny, adwersaryjny audyt jakości; dopisywanie testów brzegowych i wyścigów; zakaz cichej naprawy kodu. |
| **`reviewer`** | `reviewer/` | `rev` | Sandbox read-only (brak zapisu) | Audyt architektury, zgodności z celem i bezpieczeństwa (brak wycieków sekretów, fail-closed). |
| **`executor`** | `executor/` | `ops` | Dostęp do repozytoriów docelowych | Wdrożenie na żywo: weryfikacja czystości drzewa, ścisłe dopasowanie SHA (co do znaku), merge `--ff-only`, testy docelowe, push. |

---

## 2. Pliki w Strukturze Szablonów

Dla każdego agenta przygotowano dwa komplementarne pliki:
- **`SOUL.md`** – Definiuje personę, filozofię działania, tożsamość, styl komunikacji i żelazne wartości etyczno-inżynierskie agenta.
- **`AGENTS.md`** – Szczegółowa instrukcja operacyjna: zasady pracy w piaskownicy, protokoły komunikacyjne, kryteria weryfikacji i ściśle zdefiniowany format raportu końcowego.

```text
templates/agents/
├── master/
│   ├── SOUL.md      # Persona koordynatora, architekta i strażnika bezpieczeństwa
│   └── AGENTS.md    # Instrukcja orkiestracji workflow DEV i zarządzania sprawami
├── developer/
│   ├── SOUL.md      # Persona inżyniera skupionego na czystym kodzie i minimalnym diffie
│   └── AGENTS.md    # Zasady pracy w worktree, uruchamianie testów, raport WYNIK: OK/BLOKADA
├── tester/
│   ├── SOUL.md      # Persona adwersaryjnego badacza szukającego luk i wyścigów
│   └── AGENTS.md    # Metodyka testów brzegowych, zakaz naprawiania kodu, WERDYKT: OK/DO_POPRAWY
├── reviewer/
│   ├── SOUL.md      # Persona bezstronnego audytora jakości i bezpieczeństwa (read-only)
│   └── AGENTS.md    # Checklista audytu diffu, kryteria bezpieczeństwa, WERDYKT: OK/ODRZUĆ
├── executor/
│   ├── SOUL.md      # Persona precyzyjnego inżyniera deploymentu (zero improwizacji)
│   └── AGENTS.md    # Rygorystyczna procedura wdrożenia: weryfikacja SHA, merge --ff-only
├── openclaw_agents_snippet.json # Gotowy wycinek do wklejenia w openclaw.json
└── README.md        # Niniejsza dokumentacja
```

---

## 3. Przebieg Zadania DEV (Workflow)

1. **Planowanie (`plan`):**
   - Koordynator (`master`) dekonstruuje wymaganie na kryteria akceptacji, listę plików i metodę testowania.
   - Plan jest przedstawiany Operatorowi. Po uzyskaniu zgody sprawa przechodzi do kodowania.
2. **Implementacja (`coding`):**
   - Agent `developer` w dedykowanym `git worktree` wprowadza minimalne zmiany i tworzy testy jednostkowe.
   - Po zielonych testach zatwierdza zmiany commitem na gałęzi zadania i zwraca raport: `WYNIK: OK` z pełnym 40-znakowym `SHA`.
3. **Testy Adwersaryjne (`testing`):**
   - Agent `tester` w tym samym worktree analizuje diff, szuka przypadków skrajnych i dopisuje niezależne testy.
   - Jeśli wykryje błąd: generuje raport `WERDYKT: DO_POPRAWY` z testem reprodukującym błąd → sprawa wraca do `developer` (nowa runda).
   - Jeśli kod jest stabilny: zatwierdza testy i raportuje `WERDYKT: OK` z nowym `SHA` (czubek gałęzi).
4. **Niezależna Recenzja (`review`):**
   - Agent `reviewer` (w roli `rev`, wyłącznie read-only) ocenia całokształt zmian pod kątem bezpieczeństwa, wycieku sekretów i czystości architektury.
   - Werdykt `ODRZUĆ` lub krytyczne uwagi cofają sprawę do etapu kodowania.
5. **Weryfikacja Końcowa i Skan:**
   - Koordynator sam analizuje diff oraz uruchamia automatyczne skanery podatności / lintery.
6. **Zgoda Człowieka (Human-in-the-Loop):**
   - Koordynator prezentuje Operatorowi zwięzłe podsumowanie: diff, wyniki testów, werdykt recenzenta oraz dokładny hash SHA.
   - **Operator podejmuje decyzję o zatwierdzeniu.** Żaden automat nie może ominąć tego kroku.
7. **Wdrożenie na Żywo (`deploy`):**
   - Agent `executor` sprawdza czystość repozytorium docelowego, porównuje SHA znak po znaku i wykonuje scalenie `git merge --ff-only`.
   - Uruchamiane są testy post-merge na gałęzi docelowej. W razie sukcesu następuje `git push`.
8. **Test na Żywo (Post-Deploy Smoke Test):**
   - Koordynator wykonuje ostateczny test dymny na działającym środowisku produkcyjnym.

---

## 4. Modele i Role Uprawnień w Proxy

Szablony są w pełni zintegrowane z mostami CLI OpenClaw (`proxy.js` dla Google Antigravity `agy` oraz `claude_proxy.js` dla Anthropic Claude Code `cc`).

Odpowiednia rola uprawnień jest wymuszana przez sufiks w identyfikatorze modelu:
- **`-dev`** – Uruchamia proces w dedykowanej piaskownicy roboczej (`worktree` + `bwrap`), z odciętym dostępem do sieci zewnętrznej.
- **`-rev`** – Ścisły profil audytorski tylko do odczytu (brak możliwości zapisu plików i wywoływania komend modyfikujących).
- **`-ops`** – Profil operacyjny pozwalający na zarządzanie repozytoriami i usługami, z wyłączeniem niszczących zmian konfiguracji.

---

## 5. Instrukcja Wdrożenia

### Krok 1: Przygotowanie katalogów agentów
Utwórz strukturę katalogów w swoim środowisku roboczym OpenClaw i skopiuj szablony:

```bash
# Zmienne środowiskowe
export OPENCLAW_WORKSPACE="$HOME/.openclaw/workspace"
export AGENTS_DIR="$OPENCLAW_WORKSPACE/agents"

# Utworzenie katalogów
for role in master developer tester reviewer executor; do
  mkdir -p "$AGENTS_DIR/$role"
  cp "templates/agents/$role/SOUL.md" "$AGENTS_DIR/$role/SOUL.md"
  cp "templates/agents/$role/AGENTS.md" "$AGENTS_DIR/$role/AGENTS.md"
done
```

### Krok 2: Konfiguracja `openclaw.json`
1. Wykonaj kopię zapasową pliku konfiguracyjnego:
   ```bash
   cp "$HOME/.openclaw/openclaw.json" "$HOME/.openclaw/openclaw.json.bak.$(date +%s)"
   ```
2. Otwórz `templates/agents/openclaw_agents_snippet.json`, zastąp zmienne `${OPENCLAW_WORKSPACE}` oraz `${OPENCLAW_STATE}` właściwymi ścieżkami absolutnymi w Twoim systemie i wklej zawartość do sekcji `agents.entries` w pliku `openclaw.json`.
3. Upewnij się, że modele wymienione w konfiguracji (`*-ops`, `*-dev`, `*-rev`) są dozwolone na liście allowlist modeli OpenClaw.

### Krok 3: Przeładowanie bramy OpenClaw
```bash
systemctl --user restart openclaw-gateway.service
```

### Krok 4: Test Sprawdzający (Smoke Test)
Zweryfikuj dostępność agentów za pomocą komendy lub zapytania z poziomu koordynatora:
```bash
# Sprawdzenie czy agenci odpowiadają zgodnie ze swoją rolą
ask_agent(agent="developer", task="dev_info")
ask_agent(agent="reviewer", task="Sprawdź status read-only")
```
