/**
 * Optional sponsorship/ad abstraction (GRACE FREE).
 *
 * This is a clean, optional extension point — NOT fake ads and NOT an ad
 * network. It is disabled by default (no provider configured) and has zero
 * effect on model reasoning or agent behavior: sponsors are rendered by the
 * CLI purely as presentation, after a task completes.
 *
 * Safety guarantees (enforced by design, not by convention):
 *   - Sponsor messages are static text selected from configuration only —
 *     no source code, no uploaded files, no repository context, no secrets,
 *     and no user data are ever sent anywhere.
 *   - No network calls at all in this module. Impression/click tracking is an
 *     in-memory counter behind a `SponsorTracker` interface so a real ad
 *     platform can be plugged in later without touching agent code.
 *   - Frequency caps (per run and per UTC day) keep sponsors rare; a sponsor
 *     can never block or delay coding.
 *
 * Configuration (all optional; disabled unless ZEESH_SPONSOR_ENABLED=true):
 *   ZEESH_SPONSOR_ENABLED       'true' enables sponsor selection
 *   ZEESH_SPONSOR_MESSAGES      JSON array of { id, text } (static sponsor copy)
 *   ZEESH_SPONSOR_MAX_PER_RUN   max sponsors rendered after one task (default 1)
 *   ZEESH_SPONSOR_MAX_PER_DAY   max sponsors per UTC day (default 3)
 */

export interface SponsorMessage {
  id: string;
  /** Static, operator-authored copy — never derived from user content. */
  text: string;
}

export interface SponsorTracker {
  recordImpression(sponsorId: string): void;
  recordClick(sponsorId: string): void;
}

/** In-memory tracker (default). Swap for a real platform later if desired. */
class InMemorySponsorTracker implements SponsorTracker {
  readonly impressions = new Map<string, number>();
  readonly clicks = new Map<string, number>();

  recordImpression(sponsorId: string): void {
    this.impressions.set(sponsorId, (this.impressions.get(sponsorId) ?? 0) + 1);
  }

  recordClick(sponsorId: string): void {
    this.clicks.set(sponsorId, (this.clicks.get(sponsorId) ?? 0) + 1);
  }
}

function envBool(name: string): boolean {
  return process.env[name]?.trim().toLowerCase() === 'true';
}

function envInt(name: string, fallback: number): number {
  const raw = Number(process.env[name]);
  return Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** The UTC day bucket (YYYY-MM-DD) used for the per-day frequency cap. */
export function sponsorUtcDay(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10);
}

export class SponsorService {
  private readonly tracker: SponsorTracker;
  private readonly perDayCounts = new Map<string, number>();

  constructor(tracker: SponsorTracker = new InMemorySponsorTracker()) {
    this.tracker = tracker;
  }

  /** Sponsors are opt-in per deployment — disabled unless explicitly enabled. */
  enabled(): boolean {
    return envBool('ZEESH_SPONSOR_ENABLED');
  }

  private configuredMessages(): SponsorMessage[] {
    const raw = process.env.ZEESH_SPONSOR_MESSAGES?.trim();
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter((m): m is SponsorMessage => {
          if (!m || typeof m !== 'object') return false;
          const candidate = m as Record<string, unknown>;
          return typeof candidate.id === 'string' && typeof candidate.text === 'string';
        })
        .map((m) => ({ id: m.id, text: m.text }));
    } catch {
      return [];
    }
  }

  /**
   * Select up to `maxPerRun` sponsor messages for the end of a task run,
   * honoring the per-day frequency cap. Returns [] when disabled, when no
   * sponsors are configured, or when the daily cap is exhausted.
   */
  selectForRun(now: Date = new Date()): SponsorMessage[] {
    if (!this.enabled()) return [];
    const messages = this.configuredMessages();
    if (messages.length === 0) return [];
    const day = sponsorUtcDay(now);
    const dayCount = this.perDayCounts.get(day) ?? 0;
    const maxPerDay = envInt('ZEESH_SPONSOR_MAX_PER_DAY', 3);
    const maxPerRun = envInt('ZEESH_SPONSOR_MAX_PER_RUN', 1);
    if (dayCount >= maxPerDay || maxPerRun <= 0) return [];

    const selected: SponsorMessage[] = [];
    for (const message of messages) {
      if (selected.length >= maxPerRun || dayCount + selected.length >= maxPerDay) break;
      selected.push(message);
    }
    for (const s of selected) this.tracker.recordImpression(s.id);
    this.perDayCounts.set(day, dayCount + selected.length);
    return selected;
  }

  /** Optional click tracking hook (callers decide what a \"click\" means). */
  recordClick(sponsorId: string): void {
    this.tracker.recordClick(sponsorId);
  }

  /** Exposure for tests/diagnostics (counts are not user-facing). */
  impressionCount(sponsorId: string): number {
    return this.tracker instanceof InMemorySponsorTracker ? (this.tracker.impressions.get(sponsorId) ?? 0) : 0;
  }
}
