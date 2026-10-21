// Differential privacy for the weekly vote (docs/DATA-POLICY.md, "The weekly vote and noise").
//
// What is released: once a week, after the week's ballots are fixed, the split of effort between projects. One ballot is 100 points
// spread over the projects, so adding or removing one ballot changes the vector of per-project point totals by at most 100 points in
// total (L1 sensitivity 100; at most 100 for any single project). Adding Laplace noise of scale 100 / EPSILON to every project's total
// therefore makes the release EPSILON-differentially private for one ballot (added, removed or, at twice the cost, changed).
//
// The noised split is THE official allocation. It is what the public sees AND what the scheduler follows, so nothing downstream
// (a routed-units chart, a receipt count) can reveal the exact tally. The exact tally is computed, noised and dropped in one function
// call; it is never written to the database, a log or a cache.
//
// Budget: EPSILON = 1 per weekly release. Releases about the same people compose: 52 weekly releases are epsilon 52 in the worst case
// under basic composition (about 7.2 * sqrt(ln(1/delta)) of advanced composition at delta = 1e-5, roughly 25). A voter whose ballot stays
// the same all year is therefore protected much less over a year than in one week. See DATA-POLICY.md for the plain statement.

export const EPSILON = 1;                 // per weekly release
export const BALLOT_POINTS = 100;         // every ballot is exactly 100 points, so one ballot moves the totals by at most 100
export const BASIS_POINTS = 10000;
export const WEEKLY_RELEASES_PER_YEAR = 52;
export const NOISE_SCALE = BALLOT_POINTS / EPSILON;

// A uniform number in the open interval (0, 1) from the platform's secure random source. 53 random bits, never 0 and never 1.
export function secureRng() {
  const [hi, lo] = crypto.getRandomValues(new Uint32Array(2));
  return ((hi >>> 5) * 67108864 + (lo >>> 6) + 0.5) / 9007199254740992;
}

// One draw from Laplace(0, scale), by inverse transform. `rng` returns a uniform number in (0, 1); tests inject a seeded one.
export function laplace(scale, rng = secureRng) {
  const u = rng() - 0.5;
  return -scale * Math.sign(u) * Math.log(1 - 2 * Math.abs(u));
}

// Round non-negative weights to integers that add up to `total`, by the largest remainder method (ties by key, so the result is stable).
export function largestRemainder(weights, total = BASIS_POINTS) {
  const keys = Object.keys(weights);
  const sum = keys.reduce((a, k) => a + weights[k], 0);
  if (!(sum > 0)) return null;
  const parts = keys.map((k) => { const exact = (weights[k] * total) / sum; return { k, base: Math.floor(exact), rem: exact - Math.floor(exact) }; });
  let left = total - parts.reduce((a, p) => a + p.base, 0);
  for (const p of [...parts].sort((a, b) => b.rem - a.rem || (a.k < b.k ? -1 : 1))) { if (left <= 0) break; p.base += 1; left -= 1; }
  return Object.fromEntries(parts.map((p) => [p.k, p.base]));
}

// The released split, in basis points, from exact per-project point totals ({ project: points }): add Laplace noise to every total,
// clamp at zero, renormalise to 10000 by the largest remainder method. Returns null when every noised total is zero or less (the
// caller then publishes the provisional fallback instead). The input is not kept.
export function noisedAllocation(points, { rng = secureRng, epsilon = EPSILON } = {}) {
  const scale = BALLOT_POINTS / epsilon;
  const noised = {};
  for (const k of Object.keys(points).sort()) noised[k] = Math.max(0, points[k] + laplace(scale, rng));
  return largestRemainder(noised, BASIS_POINTS);
}

// The weekly personal-direction total (work people steered by their own ballot or picked themselves, added together). One person's
// contribution to it is capped at this many units a week, so one person moves the total by at most this much; the noise has scale
// cap / EPSILON. 16 is two of the largest tasks (8 units each).
export const PERSONAL_CAP_UNITS = 16;
