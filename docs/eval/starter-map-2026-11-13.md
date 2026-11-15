# Starter-map pilot (2026-11-13)

**Small pilot, not a benchmark.** 3 skeleton calls, judged by one person.

## Question

Given a subject and a one-line goal, does the model propose a sensible set of
concepts and prerequisite links ("starter map")? This was the gate for the
original roadmap design, which has since been replaced by the exploration
graph. The `skeleton` endpoint remains in the code outside the main flow.

## Setup

- `POST /api/subjects/{id}/skeleton` with `SKELETON_SYSTEM` as it was at
  commit `4bc1517` (8 to 15 concepts, fewer correct links over many
  speculative ones).
- Subjects:
  - A: German Language, goal "Wechselpräpositionen"
  - B: Better Call Saul, goal "Season 3 Episode 5: Chicanery"
  - C: German Language again (consistency check against A)
- 30 s between calls.

## Raw proposals (excerpt)

**Run A (German):** 8 concepts, 9 edges, 0 unlinked.
Concepts: Nominativ und Akkumusativ [sic], Dativ Case, Prepositions Basics,
Wechselpräpositionen Identification, Static Location (Wo?), Motion to a
Destination (Wohin?), Contractions, Distinguishing Static vs Motion.

**Run B (Better Call Saul):** 9 concepts, 9 edges, 0 unlinked.
Concepts: Mesa Verde Forgery, Chuck McGill Condition, Jimmy Suspension Risk,
The Tape Recording, Ernesto Role, Huell Babineaux, Bar Hearing Defense, The
Chicanery Rant, Brotherhood Resentment.

**Run C (German, repeat):** 9 concepts, 9 edges, 0 unlinked.
Concepts: Nominativ und Akkumusativ [sic], Dativ Case, Wechselpräpositionen
Basics, Akkusativ for Movement, Dativ for Position, Wohin vs Wo Questions,
Contractions, Verben der Ruhe und Bewegung, Wechselpräpositionen in
Sentences.

Consistency A vs C: 3 concepts identical by name (Nominativ und Akkumusativ,
Dativ Case, Contractions) and about 4 more equivalent in meaning (the
preposition list, Wo/dative, Wohin/accusative, static-vs-motion decision).

## Results

Marks were given by Apoorv in claude.ai; the per-edge marks were not saved in
this repository.

| Run | Concepts | Edges | Link precision |
|---|---|---|---|
| A, C (German) | 8, 9 | 9, 9 | about 80-89% |
| B (Better Call Saul) | 9 | 9 | not meaningful (see below) |

## Findings

- On a grammar topic the links were mostly right.
- One edge's reason contradicted its arrow. This led to the rule, now in the
  extraction prompt, that a prerequisite's reason must explain why the
  earlier concept comes first and match the arrow.
- The model misspelled "Akkusativ" as "Akkumusativ" in both German runs.
- A narrative subject (a TV episode) produced plot and cause links ("the
  forgery triggers the hearing"), not learning dependencies. Recorded as a
  known limit.
- Outcome: the roadmap-first design was dropped in favour of an exploration
  graph grown from the chat itself.
