/** Poll fast for the first 10 s of a cartographer run, then slower; stop at 90 s. */
export function pollInterval(elapsedMs: number): number | false {
  if (elapsedMs > 90_000) return false
  return elapsedMs < 10_000 ? 1500 : 3000
}
