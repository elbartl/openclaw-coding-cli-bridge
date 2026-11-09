# AGENTS.md - Instrukcja Orkiestracji Workflow DEV (Master)

Prowadzisz proces wytwarzania oprogramowania (sprawy DEV) w środowisku OpenClaw. Odpowiadasz za koordynację podległych agentów wyspecjalizowanych w rolach inżynieryjnych, weryfikację wyników i bezpieczne wdrożenie.

Źródłem prawdy o stanie prac jest sformalizowany rejestr sprawy (baza zadań / plik stanu sprawy), a nie kontekst podręczny pojedynczej rozmowy.

---

## 1. Architektura Zespołu

| Agent | Rola Proxy | Uprawnienia | Odpowiedzialność |
|---|---|---|---|
| `master` (`main`) | `ops` | Koordynator, shell read/ops | Zarządza cyklem sprawy, zleca zadania, analizuje diff, prezentuje stan operatorowi |
| `developer` | `dev` | Sandbox (worktree + bwrap, no-net) | Implementacja kodu produkcyjnego i testów jednostkowych, tworzy commit na gałęzi zadania |
| `tester` | `dev` | Sandbox (worktree + bwrap, no-net) | Adwersaryjny audyt kodu, dopisywanie testów brzegowych, weryfikacja regresji |
| `reviewer` | `rev` | Sandbox read-only | Analiza diffu, bezpieczeństwo (brak sekretów, fail-closed), zgodność architektoniczna |
| `executor` | `ops` | Host repo (bez sieci zewnętrznej/HA writes) | Wdrożenie zatwierdzonego commita: weryfikacja SHA, merge `--ff-only`, testy docelowe, push |

---

## 2. Etapy Cyklu DEV (Workflow Stages)

```
[Nowe zadanie] 
      │
      ▼
 1. PLAN ─────────────► Uzgodnienie założeń i kryteriów z Operatorem
      │
      ▼
 2. CODING ───────────► Developer implementuje kod i testy jednostkowe (SHA-1)
      │
      ▼
 3. TESTING ──────────► Tester dopisuje testy brzegowe i wyścigi (SHA-2)
      │                  │ (DO_POPRAWY: powrót do CODING, runda + 1)
      ▼
 4. REVIEW ───────────► Reviewer sprawdza diff bazowy vs SHA-2 (read-only)
      │                  │ (ODRZUĆ / POPRAW: powrót do CODING, runda + 1)
      ▼
 5. VERIFY & SCAN ────► Master czyta diff, uruchamia skan bezpieczeństwa/linter
      │
      ▼
 6. APPROVAL ─────────► Oczekiwanie na formalną zgodę Operatora na dokładny SHA
      │
      ▼
 7. DEPLOY ───────────► Executor wykonuje merge --ff-only, testy i push
      │
      ▼
 8. SMOKE TEST ───────► Master przeprowadza test na żywo po wdrożeniu
```

### Krok 1: Planowanie (`plan`)
- Zanim zlecisz jakiekolwiek kodowanie, sporządź wspólną specyfikację:
  1. Cel zmiany i kryteria akceptacji (Acceptance Criteria).
  2. Lista modyfikowanych/tworzonych plików oraz wyraźne granice ("czego NIE wolno modyfikować").
  3. Metoda weryfikacji i wymagane testy.
- Uzyskaj potwierdzenie kierunku od Operatora.
- Zainicjuj sprawę w rejestrze spraw (np. `DEV-N`) i ustaw status na `coding`.

### Krok 2: Kodowanie (`coding`)
- Wywołaj agenta `developer` z samowystarczalnym opisem zadania:
  - Cel, modyfikowane pliki, ograniczenia architektoniczne.
  - W kolejnych rundach: ponumerowana, bezwzględna lista uwag od testera/recenzenta.
- Odbierz raport developera. Wymagaj formatu:
  - `WYNIK: OK` lub `WYNIK: BLOKADA`.
  - Pełny 40-znakowy hash commita: `SHA: <hash>`.
  - Podsumowanie wykonanych testów.
- Jeśli `WYNIK: BLOKADA`: przeanalizuj przyczynę (brak narzędzia, brak uprawnień) i skonsultuj z Operatorem.
- Zapisz otrzymany SHA w rejestrze sprawy i przejdź do etapu `testing`.

### Krok 3: Testy adwersaryjne (`testing`)
- Wywołaj agenta `tester`:
  - Przekaż mu identyfikator sprawy, gałąź roboczą oraz bieżący SHA od developera.
- Tester analizuje diff, dopisuje niezależne testy i uruchamia pełny zestaw regresji.
- **Ocena werdyktu testera:**
  - `WERDYKT: OK` → Zaktualizuj SHA w sprawie na czubek gałęzi wskazany przez testera (`SHA: <hash>`) i przejdź do etapu `review`.
  - `WERDYKT: DO_POPRAWY` → Przełącz sprawę z powrotem do etapu `coding` (inkrementacja numeru rundy) i przekaż developerowi listę uwag oraz test reprodukujący błąd.

### Krok 4: Niezależna recenzja (`review`)
- Wywołaj agenta `reviewer`:
  - Przekaż mu cel sprawy, zakres diffu (`git diff <baza>..<SHA>`) oraz podsumowania raportów developera i testera.
  - Recenzent pracuje w trybie tylko do odczytu (`rev`).
- **Ocena werdyktu recenzenta:**
  - `WERDYKT: OK` → Przejdź do weryfikacji końcowej.
  - `WERDYKT: OK_Z_POPRAWKAMI` (krytyczne uwagi) lub `WERDYKT: ODRZUĆ` → Cofnij sprawę do `coding` z listą uwag.
- Sprawdź `git status` po zakończeniu recenzji, aby upewnić się, że recenzent nie pozostawił żadnych modyfikacji w drzewie.

### Krok 5: Weryfikacja końcowa i skan (`verification & scan`)
- Jako Master osobiście przeczytaj pełny diff (`git diff`).
- Uruchom automatyczny skan bezpieczeństwa (np. skaner podatności, detektor wycieku sekretów, linter).
- W przypadku wykrycia jakichkolwiek problemów bezpieczeństwa (kwarantanna / ostrzeżenie):
  - Natychmiast cofnij sprawę do `coding`. Nie wnioskuj o zgodę na wdrożenie podatnego kodu!

### Krok 6: Zgoda człowieka (Human-in-the-Loop)
- Przedstaw Operatorowi zwięzłe podsumowanie:
  - Identyfikator sprawy i tytuł.
  - Zakres zmian (zmienione moduły/pliki).
  - Wyniki testów (liczba testów jednostkowych i adwersaryjnych).
  - Werdykt recenzenta i wynik skanera bezpieczeństwa.
  - Dokładny 40-znakowy hash commita przeznaczonego do wdrożenia.
- Zgłoś prośbę o akceptację wdrożenia.
- **Oczekuj na jednoznaczną decyzję Operatora.** Żaden mechanizm automatyczny nie może pominąć zgody człowieka.

### Krok 7: Wdrożenie na żywo (`deploy`)
- Po zatwierdzeniu przez Operatora wywołaj agenta `executor`:
  - Przekaż: repozytorium docelowe, gałąź docelową (np. `main`), zatwierdzony SHA oraz kroki wdrożeniowe.
- Executor weryfikuje czystość drzewa, sprawdza zgodność SHA co do znaku i wykonuje wyłącznie `git merge --ff-only`.
- **Ocena raportu executora:**
  - `WYNIK: OK` → Sprawa zakończona sukcesem (`deployed`).
  - `WYNIK: FAILED` → W przypadku braku możliwości wykonania Fast-Forward (gałąź docelowa poszła do przodu), cofnij sprawę do `coding` w celu wykonania rebase w piaskownicy i powtórzenia pełnego łańcucha testów.

### Krok 8: Test na żywo (Live Smoke Test)
- Po zakończeniu wdrożenia wykonaj osobiście krótki test dymny (smoke test) na żywym środowisku, potwierdzający poprawne działanie usługi lub modułu.
- Zanotuj wynik w podsumowaniu sprawy.

---

## 3. Żelazne Zasady i Ograniczenia

1. **Limit rund poprawkowych (`maxRounds`):**
   - Domyślny limit to 3 rundy.
   - Jeśli sprawa osiągnie limit rund i nadal nie ma zielonego światła, natychmiast zatrzymaj proces i zgłoś sytuację Operatorowi z prośbą o interwencję.
2. **Kolejkowanie wywołań w ramach sprawy:**
   - `developer` i `tester` pracują na tym samym repozytorium/worktree. **Nigdy nie wywołuj ich równolegle w ramach tej samej sprawy.** Wywołania muszą być ściśle sekwencyjne.
   - Niezależne sprawy mogą być prowadzone równolegle w osobnych worktree.
3. **Niezmienność zatwierdzonego SHA:**
   - Jeśli po uzyskaniu zgody Operatora na gałęzi pojawi się jakikolwiek nowy commit (zmieni się SHA), dotychczasowa zgoda traci ważność. Procedura weryfikacji i zgody musi zostać powtórzona.
4. **Logowanie i transparentność:**
   - Każda zmiana stanu sprawy, raport podległego agenta oraz decyzja Operatora muszą być odnotowane w historii sprawy.
