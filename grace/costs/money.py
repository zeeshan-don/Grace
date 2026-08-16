"""Money primitives for GRACE FREE cost accounting (port of src/costs/money.ts).

Authoritative money values are stored as INTEGER microdollars (USD × 10⁻⁶) —
never as ordinary floating-point numbers. All arithmetic here works in
integers; the only floating-point step is converting a decimal per-1M-token
price into its integer microdollar equivalent once, at configuration time.

  pricePer1M 0.30 USD  →  300_000 microdollars per 1M tokens
  cost of 1,000 tokens →  round(1000 × 300_000 / 1_000_000) = 300 micros

The ₹ (INR) daily ceiling is a *configuration boundary*: the operator
configures limits in INR, and this module converts them to USD micros using a
fixed, configurable exchange rate (ZEESH_INR_PER_USD). Internally everything
is USD micros.
"""

import os
import sys

MICROS_PER_USD = 1_000_000
MAX_SAFE_INTEGER = sys.maxsize

# Configurable exchange rate (INR per USD), same default as the TS side.
DEFAULT_INR_PER_USD = 83


def usd_per_1m_to_micros(price_per_1m_usd) -> int:
    """Convert a decimal USD price per 1M tokens to integer microdollars."""
    try:
        price = float(price_per_1m_usd)
    except (TypeError, ValueError):
        return 0
    if price != price or price in (float("inf"), float("-inf")) or price < 0:  # NaN check
        return 0
    return int(round(price * MICROS_PER_USD))


def cost_micros(tokens, micros_per_1m) -> int:
    """Estimated cost in microdollars for `tokens` at a microdollars-per-1M price."""
    try:
        tokens = int(tokens)
        micros = int(micros_per_1m)
    except (TypeError, ValueError):
        return 0
    if tokens <= 0 or micros <= 0:
        return 0
    return int(round((tokens * micros) / 1_000_000))


def inr_to_usd_micros(inr, inr_per_usd=None) -> int:
    """Convert an INR limit to USD microdollars.
    `inr_per_usd` defaults to 83 (configurable via ZEESH_INR_PER_USD)."""
    if inr_per_usd is None:
        try:
            inr_per_usd = float(os.environ.get("ZEESH_INR_PER_USD") or DEFAULT_INR_PER_USD)
        except (TypeError, ValueError):
            inr_per_usd = DEFAULT_INR_PER_USD
    try:
        inr = float(inr)
        inr_per_usd = float(inr_per_usd)
    except (TypeError, ValueError):
        return 0
    if inr != inr or inr <= 0 or inr_per_usd != inr_per_usd or inr_per_usd <= 0:
        return 0
    return int(round((inr * MICROS_PER_USD) / inr_per_usd))


def add_micros(*values) -> int:
    """Sum of non-negative integers, clamped at MAX_SAFE_INTEGER."""
    total = 0
    for v in values:
        try:
            v = int(v)
        except (TypeError, ValueError):
            continue
        if v < 0:
            continue
        total = min(MAX_SAFE_INTEGER, total + v)
    return total


def sub_micros(a, b) -> int:
    """Subtract `b` from `a`, never going below zero (reservation release)."""
    try:
        a = int(a)
    except (TypeError, ValueError):
        a = 0
    try:
        b = int(b)
    except (TypeError, ValueError):
        b = 0
    return max(0, a - max(0, b))


def format_usd_micros(micros) -> str:
    """Format microdollars as a short USD string (logs/diagnostics only — never user-facing)."""
    try:
        micros = int(micros)
    except (TypeError, ValueError):
        micros = 0
    return f"${micros / MICROS_PER_USD:.6f}"
