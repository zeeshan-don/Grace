"""Session tokens (port of src/api/sessions.ts).

The raw token (64 hex chars from a CSPRNG) is handed to the client once and
never stored server-side. The database keeps only `SHA-256(token)` in
sessions.token_hash, so a leaked database cannot be replayed as sessions.
"""

import hashlib
import secrets


def generate_session_token() -> str:
    """Generate a fresh opaque session token (64 hex chars)."""
    return secrets.token_hex(32)


def hash_session_token(token: str) -> str:
    """The only representation of a token that is stored or compared server-side."""
    return hashlib.sha256(token.encode("utf-8")).digest().hex()
