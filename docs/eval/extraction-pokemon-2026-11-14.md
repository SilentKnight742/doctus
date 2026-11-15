# Extraction pilot: "starter Pokemon of all regions" (2026-11-14)

**Small pilot, not a benchmark.** One learner message per run, 3 runs of the
extraction prompt, each with a fresh database.

## Background

In manual testing, the question "I want to know all the starter pokemon of
all the regions" got a drip-fed answer: one region, then a quiz, then the
next region. The tutor prompt was changed to answer the whole question in
the first reply (an overview of every part in the origin chat), and the
origin's first exchange now triggers extraction straight away.

## Setup

- Subject "Starter Pokemon of all regions", goal "Know all the evolutions of
  all starter pokemon of all regions".
- One learner message in the origin chat; extraction runs on the first
  reply. 2 Gemini calls per run.

## Results

| Run | Extraction prompt | Covered nodes (excl. origin) | Frontier | Quotes verified / dropped |
|---|---|---|---|---|
| 1 | as of `9fd68f1` | 0 | 1 (Kanto Starter Evolutions) | 2 / 0 |
| 2 | + "an overview, list or table yields one covered node per part"; table rows are valid quotes | 3 (abstract: Grass/Fire/Water types, three-stage lines, a "master list") | 1 | 4 / 0 |
| 3 | + "name concepts after the subject's own items, not how they were presented" | 10 | 1 | 11 / 0 |

Run 3 is what was committed (`76ce0af` before the author rewrite).

In every run the tutor's first reply was a single table of all 9 regions
with each starter's full evolution line.

## Run 3 graph

Covered, all at distance 1 from the origin, each linked `related` to it:
Kanto, Johto, Hoenn, Sinnoh, Unova, Kalos, Alola, Galar and Paldea
starters, each with its own table row as evidence (for example
"| Kanto (Gen 1) | Grass | Bulbasaur | Ivysaur | Venusaur |"), plus
"Evolution level requirements".

Frontier: "Kanto starter detailed lines" (redundant with "Kanto starters").

## Findings

- With the overview rule and item naming, one reply produced one grounded
  node per region.
- Each region's evidence is a single table row (its Grass starter); the
  Fire and Water rows were not quoted.
- The tutor wrote "Grovile" for Grovyle. The evidence check verifies that a
  quote is in the chat, not that the chat is factually correct.
- The regions were linked as `related`. With `part_of` (planned for M1) they
  would be parts of the origin, which is what semantic zoom needs.
