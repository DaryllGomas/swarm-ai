// Random noise on the weekly vote (docs/DATA-POLICY.md, "The weekly vote and noise").
//
// What is released: once a week, after the week's ballots are fixed, the split of effort between projects. One ballot is 100 points
// spread over the projects, so adding or removing one ballot changes the vector of per-project point totals by at most 100 points in
// total. Laplace noise of scale 100 / EPSILON is added to every project's total, so one ballot cannot be read back from the split.
//
// What this is NOT: a formal differential-privacy guarantee for the whole release. Around the noised split sit deterministic rules
// (a week needs at least 5 eligible ballots to publish a result at all, the voter count is shown as a coarse bucket, and a week with no
// usable result carries the previous split forward). Those depend on the ballots without noise, so no finite epsilon covers the release
// as a whole. The noise is a practical protection for the split itself. Nothing here, in the pages or in the docs, claims more.
//
// The noised split is THE official allocation. It is what the public sees AND what the scheduler follows, so nothing downstream
// (a routed-units chart, a receipt count) can reveal the exact tally. The exact tally is computed, noised and dropped in one function
// call; it is never written to the database, a log or a cache.
//
// Repeats: each weekly release uses epsilon = 1 for its noise. Under basic composition 52 weekly releases about the same unchanged
// ballot add up to 52 in the worst case. No tighter figure is claimed. A voter whose ballot stays the same all year is therefore
// protected much less over a year than in one week.

export const EPSILON = 1;                 // per weekly release
export const BALLOT_POINTS = 100;         // every ballot is exactly 100 points, so one ballot moves the totals by at most 100
export const BASIS_POINTS = 10000;
export const WEEKLY_RELEASES_PER_YEAR = 52;
export const NOISE_SCALE = BALLOT_POINTS / EPSILON;

// A uniform number in the open interval (0, 1) from the platform's secure random source: 52 random bits n, then (n + 0.5) / 2^52. Every
// such value is exactly representable (n + 0.5 needs 53 bits), the smallest is 2^-53 and the largest is 1 - 2^-53, so the result is never
// 0 and never 1 and the noise below is always finite.
export function secureRng() {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return ((hi >>> 6) * 67108864 + (lo >>> 6) + 0.5) / 4503599627370496;
}

// One draw from Laplace(0, scale), by inverse transform. `rng` returns a uniform number in the OPEN interval (0, 1); tests inject a seeded
// one. A value outside it (or not a number) would give an infinite or NaN draw, so it is refused instead of used.
export function laplace(scale, rng = secureRng) {
  const r = rng();
  if (!(r > 0 && r < 1)) throw new RangeError('The random source must return a number strictly between 0 and 1.');
  const u = r - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// Round non-negative weights to integers that add up to `total`, by the largest remainder method (ties by key, so the result is stable).
export function largestRemainder(weights, total = BASIS_POINTS) {
  const keys = Object.keys(weights);
  const sum = keys.reduce((a, k) => a + weights[k], 0);
  if (keys.some((k) => !Number.isFinite(weights[k]) || weights[k] < 0)) throw new RangeError('Weights must be finite and not negative.');
  if (!(sum > 0)) return null;
  const parts = keys.map((k) => { const exact = (weights[k] * total) / sum; return { k, base: Math.floor(exact), rem: exact - Math.floor(exact) }; });
  let left = total - parts.reduce((a, p) => a + p.base, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || (a.k < b.k ? -1 : 1))) { if (left <= 0) break; p.base += 1; left -= 1; }
  return Object.fromEntries(parts.map((p) => [p.k, p.base]));
}

// The released split, in basis points, from exact per-project point totals ({ project: points }): add Laplace noise to every total,
// clamp at zero, renormalise to 10000 by the largest remainder method. Returns null when every noised total is zero or less (the
// caller then carries the previous split forward instead; that is not a statement about how many ballots there were). A non-finite noised
// total throws, so nothing infinite or NaN is ever stored. The input is not kept.
export function noisedAllocation(points, { rng = secureRng, epsilon = EPSILON } = {}) {
  const scale = BALLOT_POINTS / epsilon;
  const noised = {};
  for (const k of Object.keys(points).sort()) noised[k] = Math.max(0, points[k] + laplace(scale, rng));
  return largestRemainder(noised, BASIS_POINTS);
}
