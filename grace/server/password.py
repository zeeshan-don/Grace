"""Password hashing (port of src/api/password.ts).

Uses scrypt with a random per-user salt, with EXACTLY the parameters Node's
`crypto.scryptSync` uses (N=16384, r=8, p=1, dklen=64), so hashes produced by
the TypeScript backend and the Python backend are byte-identical and existing
accounts keep working across the migration. Only the salted hash is ever
stored (users.password_hash) — plaintext passwords never touch the database,
the logs, or the API responses. Verification compares digests in constant
time via `hmac.compare_digest`.

Stored format: "<salt-hex>:<hash-hex>"
"""

import hashlib
import hmac
import secrets

KEY_LEN = 64
SALT_BYTES = 16
SCRYPT_N = 16384  # cost — must match Node's scryptSync default
SCRYPT_R = 8  # block size
SCRYPT_P = 1  # parallelization


def hash_password(password: str) -> str:
    """Hash a password into the "salt:hash" storage format."""
    salt = secrets.token_bytes(SALT_BYTES)
    digest = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=KEY_LEN)
    return f"{salt.hex()}:{digest.hex()}"


def verify_password(password: str, stored: str) -> bool:
    """Constant-time password check against a stored "salt:hash" value."""
    if not isinstance(stored, str):
        return False
    sep = stored.find(":")
    if sep <= 0:
        return False
    salt_hex = stored[:sep]
    hash_hex = stored[sep + 1 :]
    if not salt_hex or not hash_hex:
        return False
    try:
        salt = bytes.fromhex(salt_hex)
        expected = bytes.fromhex(hash_hex)
    except (ValueError, TypeError):
        return False
    try:
        derived = hashlib.scrypt(password.encode("utf-8"), salt=salt, n=SCRYPT_N, r=SCRYPT_R, p=SCRYPT_P, dklen=KEY_LEN)
    except (ValueError, TypeError):
        return False
    if len(derived) != len(expected):
        return False
    return hmac.compare_digest(derived, expected)
