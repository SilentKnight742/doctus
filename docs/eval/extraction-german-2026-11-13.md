# Extraction pilot: German, 6 messages (2026-11-13)

**Small pilot, not a benchmark.** 3 runs of the same scripted learner
messages; the tutor replies differ between runs because they are generated
fresh each time.

## Setup

- Subject "German Language", goal "Wechselpräpositionen". All messages sent
  in the origin node's chat.
- Extraction ran automatically after learner messages 3 and 6.
- About 6 s between messages. No 429s.
- Learner messages:
  1. I want to learn Wechselpräpositionen. What are they?
  2. Okay, so 'Ich lege das Buch auf den Tisch' is accusative because the
     book moves?
  3. And 'Das Buch liegt auf dem Tisch' is dative. Why does legen vs liegen
     matter?
  4. Is 'Ich gehe ins Kino' an example too? What is 'ins'?
  5. What about 'Ich warte an der Bushaltestelle'? I'm not moving, so dative?
  6. Let me try: Die Katze springt ___ (auf, der Stuhl). Is it 'auf den
     Stuhl'?

## Results

| | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| Code at | `c1c115e` | `58c768e` | `9fd68f1` |
| Change | first version | prompt: one covered node per taught rule; never quote learner questions | evidence check ignores markdown emphasis; covered concepts must link to the current node |
| Covered nodes (incl. origin) | 2 | 4 | 5 |
| Frontier nodes | 3 | 2 | 1 |
| Quotes verified / dropped | 4 / 0 | 6 / 2 | 8 / 0 |
| Nodes unreachable from origin | 0 | 2 | 0 |
| Quotes taken from learner questions | 2 | 0 | 0 |

(Commit hashes are from before the 2026-11-15 author rewrite; the messages
are unchanged.)

## Run 3 graph (final)

Covered, all at distance 1 from the origin:

| Node | Evidence (abridged) |
|---|---|
| German Language (origin, distance 0) | "Wechselpräpositionen are a special group of prepositions that can take either the Accusative case or the Dative case." |
| Dative vs Accusative with Two-Way Prepositions | Dative: no movement, answers "Wo?"; Accusative: movement towards a destination, answers "Wohin?" |
| Action vs State Verb Pairs | legen = actively moving something, triggers Accusative; liegen = static location, triggers Dative |
| Preposition Contractions with Articles | "in + das = ins" |
| Applying Movement to Two-Way Prepositions | the tutor confirming "Die Katze springt auf den Stuhl." and why it takes the Accusative |

Frontier: List of the Nine Two-Way Prepositions.

## Findings

- Run 1 was too coarse: concepts the tutor explained at length (verb pairs,
  the *ins* contraction) were either missed or filed as frontier, and two
  quotes were the learner's own questions.
- Run 2's two drops were false negatives: the model quoted the tutor with
  its markdown (`***Wohin?***`, `**Accusative**`) removed. Fixed in run 3.
- Run 2 left two covered nodes with no link, unreachable from the origin.
  Fixed by making the link required in the schema.
- Remaining in run 3: "Applying Movement..." overlaps "Dative vs
  Accusative..."; one prerequisite arrow ("Applying Movement" before the
  origin) is doubtful; only one frontier node.
