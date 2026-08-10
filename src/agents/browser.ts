/**
 * Browser-use availability (subagent coordinator).
 *
 * The browser agent must not pull in a browser automation dependency blindly.
 * GRACE ships without playwright/puppeteer (browsers are not needed for normal
 * CLI tasks), so the abstraction below reports availability, and the
 * coordinator marks the agent "unavailable" with a clear reason instead of
 * silently running a broken agent. Browser support can be added later by
 * registering a browser backend here — no other code changes.
 */
export interface BrowserAvailability {
  available: boolean;
  reason?: string;
}

export function browserAvailability(): BrowserAvailability {
  return {
    available: false,
    reason:
      'No browser automation is installed in this environment (e.g. Playwright/Puppeteer). ' +
      'Browser verification is not available from the CLI — verify rendering manually or install a browser backend.',
  };
}
