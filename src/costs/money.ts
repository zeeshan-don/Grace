/**
 * Money primitives for GRACE FREE cost accounting.
 *
 * Authoritative money values are stored as INTEGER microdollars (USD × 10⁻⁶)
 * — never as ordinary JavaScript floating-point numbers. All arithmetic here
 * works in integers; the only floating-point step is converting a decimal
 * per-1M-token price into its integer microdollar equivalent once, at
 * configuration time.
 *
 *   pricePer1M 0.30 USD  →  300_000 microdollars per 1M tokens
 *   cost of 1,000 tokens →  round(1000 × 300_000 / 1_000_000) = 300 micros
 *
 * The ₹ (INR) daily ceiling is a *configuration boundary*: the operator
 * configures limits in INR, and this module converts them to USD micros
 * using a fixed, configurable exchange rate (ZEESH_INR_PER_USD). Internally
 * everything is USD micros.
 */

/** Microdollars per 1 USD. */
export const MICROS_PER_USD = 1_000_000;

/** Convert a decimal USD price per 1M tokens to integer microdollars. */
export function usdPer1MToMicros(pricePer1MUsd: number): number {
  if (!Number.isFinite(pricePer1MUsd) || pricePer1MUsd < 0) return 0;
  // Integer-safe: pricePer1MUsd * 1e6 stays well below 2^53.
  return Math.round(pricePer1MUsd * MICROS_PER_USD);
}

/**
 * Estimated cost in microdollars for `tokens` at a microdollars-per-1M price.
 * Integer-safe for realistic token counts (tokens × price < 2^53).
 */
export function costMicros(tokens: number, microsPer1M: number): number {
  if (tokens <= 0 || microsPer1M <= 0) return 0;
  return Math.round((tokens * microsPer1M) / 1_000_000);
}

/**
 * Convert an INR limit to USD microdollars.
 * `inrPerUsd` defaults to 83 (configurable via ZEESH_INR_PER_USD).
 */
export function inrToUsdMicros(inr: number, inrPerUsd = 83): number {
  if (!Number.isFinite(inr) || inr <= 0) return 0;
  if (!Number.isFinite(inrPerUsd) || inrPerUsd <= 0) return 0;
  return Math.round((inr * MICROS_PER_USD) / inrPerUsd);
}

/** Sum of non-negative integers, clamped at Number.MAX_SAFE_INTEGER. */
export function addMicros(...values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isFinite(v) || v < 0) continue;
    total = Math.min(Number.MAX_SAFE_INTEGER, total + v);
  }
  return total;
}

/** Subtract `b` from `a`, never going below zero (reservation release). */
export function subMicros(a: number, b: number): number {
  return Math.max(0, (Number.isFinite(a) ? a : 0) - (Number.isFinite(b) && b > 0 ? b : 0));
}

/** Format microdollars as a short USD string (logs/diagnostics only — never user-facing). */
export function formatUsdMicros(micros: number): string {
  return `$${(micros / MICROS_PER_USD).toFixed(6)}`;
}
