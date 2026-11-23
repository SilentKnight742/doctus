# Canvas session: German, branching (2026-11-22)

**Small live check, not a benchmark.** One scripted session on the M3
backend (real `uvicorn`, streamed replies, `gemini-3.5-flash-lite` for both
the tutor and the cartographer), on a fresh database, 12 s between exchanges.
No 429s.

## Script

1. New subject "German" (goal "get around on a trip") with the first
   question "How do German noun cases work? Give me the big picture.", then
   answer it.
2. Accept the root's first suggestion (branch A, child of the root).
3. Branch B, a sibling of A: "Explain the two-way prepositions
   (Wechselpräpositionen)."
4. A follow-up inside B: "So is it 'Ich gehe in die Stadt' or 'in der
   Stadt'?"
5. A note under B ("# My rule / Wohin -> accusative, Wo -> dative."), then a
   chat below the note (branch C, depth 3) asking for 5 travel sentences,
   stopped after about 250 characters.

## Result

| Node | Parent | Kind | Title (keyword) | Concepts homed here |
|---|---|---|---|---|
| 1 | root | chat | German Noun Cases Overview (cases) | Nominative, Accusative, Dative, Genitive case |
| 2 | 1 | chat | Definite Articles Across German Cases (articles) | Definite articles grid; masculine, feminine, neuter, plural article patterns |
| 3 | 1 | chat | Two-way prepositions (Wechselpräpositionen) (prepositions) | Two-way prepositions; accusative / dative with two-way prepositions |
| 4 | 3 | note | My rule (My) | none |
| 5 | 4 | chat | Travel Sentences for Two-way Prepositions (travel) | none (stopped at 281 characters) |

- Evidence: 5 cartographer runs, 19 quotes verified, 0 dropped.
- Dedupe: B's follow-up re-taught "Feminine definite article patterns"; it
  gained evidence in node 3 and stayed homed in node 2.
- Links: 10, 6 of them across nodes (for example `Accusative case` →
  `Accusative with two-way prepositions`, prerequisite, node 1 → node 3).
  One link was skipped because it named a concept the model had not emitted.
- Suggestions: 3 per answered chat node; the accepted one left the root's
  list. Node 5's suggestions follow from its stopped table ("Can you give me
  the rest of the hotel room example?").
- The stop kept the partial reply (`stopped: true`), and the cartographer
  ran on it after the stream ended.
- Search for "dativ": 12 hits. The branch path to node 5 is
  1 → 3 → 4 (note) → 5.

The canvas JSON (message bodies cut to 90 characters) is in
[canvas-german-2026-11-22.json](canvas-german-2026-11-22.json).

## Observations

- Titles are specific and stable; keywords are good for chat nodes. A note's
  keyword is its title's first word ("My"), which is weak for far zoom.
- The root's prerequisite links from every case to "Definite articles grid"
  are reasonable but repetitive; a later pass could cap fan-in.
