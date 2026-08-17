"""Closed-beta gating (port of src/api/beta.ts).

  ZEESH_BETA_MODE=closed  → registration requires the email to be listed in
                            ZEESH_BETA_ALLOWLIST (comma-separated).
  (unset or 'open')       → unrestricted registration (default).

Deliberately minimal: no dashboard, no invite codes — just enough control to
let a small group of beta testers in and keep everyone else out. Existing
accounts are never locked out.
"""

import os


def beta_mode() -> str:
    """Current beta mode from ZEESH_BETA_MODE (defaults to 'open')."""
    return "closed" if (os.environ.get("ZEESH_BETA_MODE") or "").strip().lower() == "closed" else "open"


def beta_allowlist() -> set:
    """Allowlisted emails from ZEESH_BETA_ALLOWLIST (lower-cased)."""
    raw = (os.environ.get("ZEESH_BETA_ALLOWLIST") or "").strip()
    if not raw:
        return set()
    return {s.strip().lower() for s in raw.split(",") if s.strip()}


def beta_access_for(email: str) -> dict:
    """Decide beta access for a registration email (email may be un-normalized)."""
    if beta_mode() == "open":
        return {"allowed": True, "isBeta": True}
    allowed = email.strip().lower() in beta_allowlist()
    return {"allowed": allowed, "isBeta": allowed}
