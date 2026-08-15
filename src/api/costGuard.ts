/**
 * GRACE FREE internal cost guard (server-authoritative).
 *
 * Enforces the per-user daily cost ceiling (₹20/day, configurable) and the
 * global hosted spending circuit breaker BEFORE any paid provider request is
 * sent, using request RESERVATIONS so a huge model response can never
 * overshoot the ceiling:
 *
 *   remaining budget
 *       ↓
 *   estimate worst-case cost (input + max output across the provider chain)
 *       ↓
 *   cap max output tokens to the remaining budget
 *       ↓
 *   reserve a conservative amount (atomic, race-safe)
 *       ↓
 *   make the API call (max output already bounded)
 *       ↓
 *   receive actual usage → settle actual cost → release unused reservation
 *
 * Race safety: reservations are single-statement atomic UPSERTs whose WHERE
 * clause re-checks the ceiling (`spent + reserved + new <= cap`), so
 * concurrent requests — multiple Grace processes, parallel agents — can never
 * push a user over the ceiling. Money is stored as INTEGER microdollars
 * (src/costs/money.ts) and prices come from the central registry
 * (src/costs/pricing.ts). The user-facing messages never reveal spending.
 *
 * The guard runs BEFORE the free-session gate in /api/provider: a request
 * refused here consumes no session slot (\"do not waste sessions\").
 */
import { configuredProviderChain } from './providers.ts';
import type { Db, Row } from './db.ts';
import { utcDay } from './freeSessions.ts';
import { inrToUsdMicros } from '../costs/money.ts';
import { estimateCostMicros, outputMicrosPer1MFor, priceForModel, tierForContext } from '../costs/pricing.ts';
import type { ChatRequest } from './providers.ts';

/** Default per-user daily ceiling in INR (configurable via env). */
export const DEFAULT_DAILY_COST_LIMIT_INR = 20;
/** Default INR→USD rate used to convert the ceiling (configurable). */
export const DEFAULT_INR_PER_USD = 83;

/** Below this many output tokens a request is not worth starting (budget exhausted). */
const MIN_OUTPUT_TOKENS = 64;
/** Default max output when the client did not specify one (matches providers). */
const DEFAULT_MAX_OUTPUT_TOKENS = 4096;

/** A successful (reserved) gate — the caller must settle() exactly once. */
export interface CostReservation {
  userId: string;
  /** UTC day bucket (YYYY-MM-DD). */
  day: string;
  /** UTC month bucket (YYYY-MM). */
  month: string;
  /** Worst-case budget reserved, in microdollars. */
  reservedMicros: number;
  /** Free-session row id the request ran inside (for ai_usage). */
  sessionId: string | null;
}

export type CostGate =
  | { ok: true; reservation: CostReservation | null; maxTokens?: number }
  | {
      ok: false;
      status: number;
      code: 'daily_cost_exhausted' | 'global_cost_exhausted' | 'no_providers';
      error: string;
      retryAfterSeconds?: number;
    };

/** Actual usage of a completed request (for settling + ai_usage). */
export interface SettleUsage {
  provider: string;
  model: string;
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
}

export interface CostGuardOptions {
  /** Injectable clock (tests). Defaults to `new Date()`. */
  now?: () => Date;
}

/** Read a non-negative env number (INR limits are decimal currency), else fallback. */
function envNonNegativeFloat(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? raw : fallback;
}

export class CostGuardService {
  private readonly db: Db;
  private readonly options: CostGuardOptions;

  constructor(db: Db, options: CostGuardOptions = {}) {
    this.db = db;
    this.options = options;
  }

  private now(): Date {
    return this.options.now?.() ?? new Date();
  }

  /** Per-user daily ceiling in USD microdollars (0 = disabled). */
  private dailyCapMicros(): number {
    const inr = envNonNegativeFloat('ZEESH_DAILY_COST_LIMIT_INR', DEFAULT_DAILY_COST_LIMIT_INR);
    const rate = envNonNegativeFloat('ZEESH_INR_PER_USD', DEFAULT_INR_PER_USD);
    return inrToUsdMicros(inr, rate);
  }

  private globalDailyCapMicros(): number {
    return inrToUsdMicros(envNonNegativeFloat('ZEESH_GLOBAL_DAILY_COST_LIMIT_INR', 0));
  }

  private globalMonthlyCapMicros(): number {
    return inrToUsdMicros(envNonNegativeFloat('ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR', 0));
  }

  /**
   * Gate a chat request: estimate worst-case cost across the provider chain,
   * cap max output tokens to the remaining budget, reserve budget atomically
   * (per-user daily + global daily/monthly) and return the reservation.
   * Refusals happen BEFORE any session slot is consumed.
   */
  async guardChat(userId: string, req: ChatRequest, sessionId: string | null): Promise<CostGate> {
    const now = this.now();
    const day = utcDay(now);
    const month = day.slice(0, 7);

    const chain = configuredProviderChain(req.model, req.tier);
    if (chain.length === 0) {
      return {
        ok: false,
        status: 503,
        code: 'no_providers',
        error:
          'No server-side AI provider key is configured (set GROQ_API_KEY, NVIDIA_API_KEY, GEMINI_API_KEY and/or MINIMAX_API_KEY).',
      };
    }

    const dailyCap = this.dailyCapMicros();
    const globalDailyCap = this.globalDailyCapMicros();
    const globalMonthlyCap = this.globalMonthlyCapMicros();

    // Worst-case estimate across the chain: the highest input cost and the
    // highest output price among the providers that could serve this request.
    // The input bound is CONSERVATIVE: tokenizers never exceed ~1 token per
    // character, so the raw serialized length is a safe ceiling for input
    // tokens (a chars/4 estimate could under-reserve and let a request's
    // settled spend overshoot the ceiling).
    const inputTokens = JSON.stringify({ messages: req.messages, tools: req.tools ?? [] }).length;
    const requestedMax = req.maxTokens ?? DEFAULT_MAX_OUTPUT_TOKENS;
    const contextProbe = inputTokens + requestedMax;
    let worstInputMicros = 0;
    let worstOutputPer1M = 0;
    for (const leg of chain) {
      const price = priceForModel(leg.provider, leg.model);
      const tier = tierForContext(price, contextProbe);
      worstInputMicros = Math.max(worstInputMicros, Math.round((inputTokens * tier.inputMicrosPer1M) / 1_000_000));
      worstOutputPer1M = Math.max(worstOutputPer1M, outputMicrosPer1MFor(leg.provider, leg.model, contextProbe));
    }

    let maxOutput = requestedMax;
    if (dailyCap > 0) {
      const { spent, reserved } = await this.readDaily(userId, day);
      const available = Math.max(0, dailyCap - spent - reserved);
      if (available <= 0) {
        return {
          ok: false,
          status: 429,
          code: 'daily_cost_exhausted',
          error: 'Grace has reached today\'s usage capacity. Please try again after the daily reset.',
          retryAfterSeconds: this.secondsUntilUtcMidnight(now),
        };
      }
      const afterInput = available - worstInputMicros;
      if (afterInput <= 0) {
        return {
          ok: false,
          status: 429,
          code: 'daily_cost_exhausted',
          error: 'Grace has reached today\'s usage capacity. Please try again after the daily reset.',
          retryAfterSeconds: this.secondsUntilUtcMidnight(now),
        };
      }
      // Max output the remaining budget allows (never exceed the request's own cap).
      const budgetMax = Math.floor((afterInput * 1_000_000) / worstOutputPer1M);
      maxOutput = Math.min(requestedMax, budgetMax);
      if (maxOutput < MIN_OUTPUT_TOKENS) {
        return {
          ok: false,
          status: 429,
          code: 'daily_cost_exhausted',
          error: 'Grace has reached today\'s usage capacity. Please try again after the daily reset.',
          retryAfterSeconds: this.secondsUntilUtcMidnight(now),
        };
      }
    }

    // Reserve the worst case for the tokens we are about to allow.
    const reserveMicros =
      dailyCap > 0
        ? worstInputMicros + Math.floor((maxOutput * worstOutputPer1M) / 1_000_000)
        : 0;

    // 1. Per-user daily reservation (atomic, with the ceiling re-checked).
    if (dailyCap > 0) {
      const okDaily = await this.reserveDaily(userId, day, reserveMicros, dailyCap);
      if (!okDaily) {
        return {
          ok: false,
          status: 429,
          code: 'daily_cost_exhausted',
          error: 'Grace has reached today\'s usage capacity. Please try again after the daily reset.',
          retryAfterSeconds: this.secondsUntilUtcMidnight(now),
        };
      }
    }

    // 2. Global circuit breaker reservations (daily + monthly). Pre-read the
    // global ledger so a FRESH insert can never exceed the cap (the atomic
    // reserve then re-checks under the row lock for concurrent requests).
    if (globalDailyCap > 0) {
      const gDay = await this.readGlobal('day', day);
      if (gDay.spent + gDay.reserved + reserveMicros > globalDailyCap) {
        await this.releaseDaily(userId, day, reserveMicros);
        return this.globalRefusal(now);
      }
      const okGlobal = await this.reserveGlobal('day', day, reserveMicros, globalDailyCap);
      if (!okGlobal) {
        await this.releaseDaily(userId, day, reserveMicros);
        return this.globalRefusal(now);
      }
    }
    if (globalMonthlyCap > 0) {
      const gMonth = await this.readGlobal('month', month);
      if (gMonth.spent + gMonth.reserved + reserveMicros > globalMonthlyCap) {
        await this.releaseDaily(userId, day, reserveMicros);
        await this.releaseGlobal('day', day, reserveMicros);
        return this.globalRefusal(now);
      }
      const okGlobal = await this.reserveGlobal('month', month, reserveMicros, globalMonthlyCap);
      if (!okGlobal) {
        await this.releaseDaily(userId, day, reserveMicros);
        await this.releaseGlobal('day', day, reserveMicros);
        return this.globalRefusal(now);
      }
    }

    const reservation: CostReservation = { userId, day, month, reservedMicros: reserveMicros, sessionId };
    return { ok: true, reservation, maxTokens: maxOutput };
  }

  /**
   * Settle a reservation after the request finished (or failed).
   *   - outcome == null  → the request failed; release the whole reservation.
   *   - outcome != null  → settle the ACTUAL cost and release the unused
   *     portion of the reservation.
   * Also records the ai_usage row for internal accounting.
   */
  async settle(reservation: CostReservation | null, outcome: SettleUsage | null): Promise<void> {
    if (!reservation) return;
    const actualMicros = outcome ? estimateCostMicros(outcome.provider, outcome.model, {
      inputTokens: outcome.inputTokens,
      cachedInputTokens: outcome.cachedInputTokens,
      outputTokens: outcome.outputTokens,
    }) : 0;

    await this.db(
      `UPDATE daily_cost
          SET spent_usd_micros = spent_usd_micros + $3,
              reserved_usd_micros = GREATEST(0, reserved_usd_micros - $4),
              version = version + 1,
              updated_at = now()
        WHERE user_id = $1 AND day = $2`,
      [reservation.userId, reservation.day, actualMicros, reservation.reservedMicros],
    );

    await this.db(
      `UPDATE global_cost
          SET spent_usd_micros = spent_usd_micros + $3,
              reserved_usd_micros = GREATEST(0, reserved_usd_micros - $4),
              version = version + 1,
              updated_at = now()
        WHERE period_type = $1 AND period = $2`,
      ['day', reservation.day, actualMicros, reservation.reservedMicros],
    );
    await this.db(
      `UPDATE global_cost
          SET spent_usd_micros = spent_usd_micros + $3,
              reserved_usd_micros = GREATEST(0, reserved_usd_micros - $4),
              version = version + 1,
              updated_at = now()
        WHERE period_type = $1 AND period = $2`,
      ['month', reservation.month, actualMicros, reservation.reservedMicros],
    );

    if (outcome) {
      const total = outcome.inputTokens + outcome.outputTokens;
      await this.db(
        `INSERT INTO ai_usage
           (user_id, session_id, provider, model, input_tokens, cached_input_tokens,
            output_tokens, total_tokens, estimated_cost_usd_micros, currency, day)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'USD', $10)`,
        [
          reservation.userId,
          reservation.sessionId,
          outcome.provider,
          outcome.model,
          outcome.inputTokens,
          outcome.cachedInputTokens,
          outcome.outputTokens,
          total,
          actualMicros,
          reservation.day,
        ],
      );
    }
  }

  /** Read-only daily totals for a user (used by tests + the refusal path). */
  async readDaily(userId: string, day: string): Promise<{ spent: number; reserved: number }> {
    const rows = await this.db(
      'SELECT spent_usd_micros, reserved_usd_micros FROM daily_cost WHERE user_id = $1 AND day = $2',
      [userId, day],
    );
    const row = rows[0] as Row | undefined;
    return {
      spent: Number(row?.spent_usd_micros ?? 0),
      reserved: Number(row?.reserved_usd_micros ?? 0),
    };
  }

  // -------------------------------------------------------------------------
  // Atomic ledger operations (single statements — race-safe)
  // -------------------------------------------------------------------------

  /**
   * Reserve `micros` for a user/day, refusing (false) when the ceiling would
   * be exceeded. Atomic: the WHERE clause re-checks the ceiling under the
   * row lock, so concurrent requests can never overshoot.
   */
  private async reserveDaily(userId: string, day: string, micros: number, capMicros: number): Promise<boolean> {
    if (micros <= 0) return true;
    const rows = await this.db(
      `INSERT INTO daily_cost (user_id, day, spent_usd_micros, reserved_usd_micros, version)
       VALUES ($1, $2, 0, $3, 1)
       ON CONFLICT (user_id, day) DO UPDATE
         SET reserved_usd_micros = daily_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros,
             version = daily_cost.version + 1,
             updated_at = now()
         WHERE daily_cost.spent_usd_micros + daily_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros <= $4
       RETURNING user_id`,
      [userId, day, micros, capMicros],
    );
    return rows.length === 1;
  }

  /** Release a reservation (request failed, or a later gate refused it). */
  private async releaseDaily(userId: string, day: string, micros: number): Promise<void> {
    if (micros <= 0) return;
    await this.db(
      `UPDATE daily_cost
          SET reserved_usd_micros = GREATEST(0, reserved_usd_micros - $3),
              version = version + 1,
              updated_at = now()
        WHERE user_id = $1 AND day = $2`,
      [userId, day, micros],
    );
  }

  /** Read-only global totals for a period (used by the circuit breaker). */
  private async readGlobal(periodType: string, period: string): Promise<{ spent: number; reserved: number }> {
    const rows = await this.db(
      'SELECT spent_usd_micros, reserved_usd_micros FROM global_cost WHERE period_type = $1 AND period = $2',
      [periodType, period],
    );
    const row = rows[0] as Row | undefined;
    return {
      spent: Number(row?.spent_usd_micros ?? 0),
      reserved: Number(row?.reserved_usd_micros ?? 0),
    };
  }

  private async reserveGlobal(periodType: string, period: string, micros: number, capMicros: number): Promise<boolean> {
    if (micros <= 0) return true;
    const rows = await this.db(
      `INSERT INTO global_cost (period_type, period, spent_usd_micros, reserved_usd_micros, version)
       VALUES ($1, $2, 0, $3, 1)
       ON CONFLICT (period_type, period) DO UPDATE
         SET reserved_usd_micros = global_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros,
             version = global_cost.version + 1,
             updated_at = now()
         WHERE global_cost.spent_usd_micros + global_cost.reserved_usd_micros + EXCLUDED.reserved_usd_micros <= $4
       RETURNING period_type`,
      [periodType, period, micros, capMicros],
    );
    return rows.length === 1;
  }

  private async releaseGlobal(periodType: string, period: string, micros: number): Promise<void> {
    if (micros <= 0) return;
    await this.db(
      `UPDATE global_cost
          SET reserved_usd_micros = GREATEST(0, reserved_usd_micros - $3),
              version = version + 1,
              updated_at = now()
        WHERE period_type = $1 AND period = $2`,
      [periodType, period, micros],
    );
  }

  private globalRefusal(now: Date): CostGate {
    return {
      ok: false,
      status: 429,
      code: 'global_cost_exhausted',
      error: 'Grace is temporarily at capacity. Please try again shortly.',
      retryAfterSeconds: this.secondsUntilUtcMidnight(now),
    };
  }

  private secondsUntilUtcMidnight(now: Date): number {
    const next = new Date(now);
    next.setUTCHours(24, 0, 0, 0);
    return Math.max(1, Math.ceil((next.getTime() - now.getTime()) / 1000));
  }
}
