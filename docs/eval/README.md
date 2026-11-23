# Pilot results

Small, hand-run pilots used to decide what to build next. Each one is a
handful of model calls on `gemini-3.5-flash-lite` (free tier), reviewed by
one person (Apoorv); the starter-map edge marks were Claude's second-opinion
estimate in claude.ai. **They are not benchmarks**: sample sizes are tiny, model
output varies between runs, and the tutor replies differed between reruns.

| File | What | Date |
|---|---|---|
| [starter-map-2026-11-13.md](starter-map-2026-11-13.md) | Starter-map (skeleton) proposals, link precision | 2026-11-13 |
| [extraction-german-2026-11-13.md](extraction-german-2026-11-13.md) | Evidence-checked extraction, 6-message German chat, 3 runs | 2026-11-13 |
| [extraction-pokemon-2026-11-14.md](extraction-pokemon-2026-11-14.md) | Origin overview reply and extraction, "starter Pokemon of all regions" | 2026-11-14 |
| [canvas-german-2026-11-22.md](canvas-german-2026-11-22.md) | M3 branch canvas: a live German session with three branches, a note and a stopped reply | 2026-11-22 |

Sources: numbers come from the commit messages of the changes each pilot
informed, plus the raw output printed during the runs. The raw log files
were kept in a temporary folder that no longer exists, so excerpts here are
what was captured at the time.
