"""Backend authentication tests (port of the TS api/auth + costGuardApi tests).

Exercises the full request → handler → service → SQL path through the WSGI
app against the in-memory database, plus the Node-scrypt compatibility that
existing accounts depend on.
"""

import hashlib

from tests.helpers.wsgi_client import wsgi_call

AUTH_HEADERS = {"Content-Type": "application/json"}

# Generated with Node's crypto.scryptSync('s3cret-pass!', salt, 64) using the
# documented defaults (N=16384, r=8, p=1) — the exact parameters the TypeScript
# backend used. Existing accounts store this format; the Python backend must
# verify it byte-for-byte.
NODE_SCRYPT_VECTOR = (
    "9e2dce9bbdd9a6ce166c2fe3e3f17047:"
    "7b8a325867bda8fdafd69ec7d76a6ae5f9de75fe3e4edb14d892c7739c5794897"
    "dd19873bdb0b3c244dc9a563c63b23df84fe2e624d926cfc61b575a3f9af2d2"
)


# ---------------------------------------------------------------------------
# Password hashing (Node compatibility)
# ---------------------------------------------------------------------------

def test_verify_node_scrypt_hash():
    from grace.server.password import verify_password

    assert verify_password("s3cret-pass!", NODE_SCRYPT_VECTOR) is True
    assert verify_password("wrong-password", NODE_SCRYPT_VECTOR) is False


def test_hash_password_roundtrip_and_format():
    from grace.server.password import hash_password, verify_password

    stored = hash_password("hunter2-hunter2")
    salt_hex, _, hash_hex = stored.partition(":")
    assert len(salt_hex) == 32  # 16 random bytes
    assert len(hash_hex) == 128  # 64-byte digest
    assert verify_password("hunter2-hunter2", stored) is True
    assert verify_password("not-the-password", stored) is False
    # Two hashes of the same password differ (fresh salt each time).
    assert hash_password("hunter2-hunter2") != stored


def test_verify_password_garbage_inputs():
    from grace.server.password import verify_password

    assert verify_password("x", "") is False
    assert verify_password("x", "no-separator") is False
    assert verify_password("x", ":") is False
    assert verify_password("x", "zz:zz") is False  # invalid hex


# ---------------------------------------------------------------------------
# Session tokens
# ---------------------------------------------------------------------------

def test_session_token_format_and_hash():
    from grace.server.sessions import generate_session_token, hash_session_token

    token = generate_session_token()
    assert len(token) == 64
    int(token, 16)  # hex
    digest = hash_session_token(token)
    assert digest == hashlib.sha256(token.encode("utf-8")).hexdigest()
    assert hash_session_token(token) != token


# ---------------------------------------------------------------------------
# Register / login / logout / me
# ---------------------------------------------------------------------------

def _register(wsgi_app, email="a@example.com", password="password123", display_name=None):
    body = {"email": email, "password": password}
    if display_name is not None:
        body["display_name"] = display_name
    return wsgi_call(wsgi_app, "POST", "/api/auth/register", headers=AUTH_HEADERS, body=body)


def test_register_creates_account_and_session(memory_db, wsgi_app):
    res = _register(wsgi_app)
    assert res.status == 201
    data = res.json
    assert data["token"]
    assert len(data["token"]) == 64
    assert data["expires_at"]
    assert data["user"]["email"] == "a@example.com"
    assert data["user"]["display_name"] is None
    # A session row exists (hashed token, never the raw token).
    assert len(memory_db["state"]["sessions"]) == 1
    assert memory_db["state"]["sessions"][0]["token_hash"] != data["token"]


def test_register_validation_errors(wsgi_app):
    assert _register(wsgi_app, email="not-an-email").status == 400
    assert _register(wsgi_app, password="short").status == 400
    assert _register(wsgi_app, email="").status == 400
    res = wsgi_call(wsgi_app, "POST", "/api/auth/register", headers=AUTH_HEADERS, body="not json")
    assert res.status == 400
    assert wsgi_call(wsgi_app, "POST", "/api/auth/register", headers=AUTH_HEADERS, body=[]).status == 400


def test_register_duplicate_email_409(wsgi_app):
    assert _register(wsgi_app).status == 201
    # Emails are case-insensitively unique.
    res = _register(wsgi_app, email="A@EXAMPLE.COM")
    assert res.status == 409
    assert "already exists" in res.json["error"]


def test_closed_beta_gate(wsgi_app, monkeypatch):
    monkeypatch.setenv("ZEESH_BETA_MODE", "closed")
    monkeypatch.setenv("ZEESH_BETA_ALLOWLIST", "beta@example.com")
    res = _register(wsgi_app, email="outsider@example.com")
    assert res.status == 403
    assert "closed beta" in res.json["error"]
    # Allowlisted email registers fine.
    res = _register(wsgi_app, email="beta@example.com")
    assert res.status == 201


def test_login_ok_and_bad_credentials(wsgi_app):
    _register(wsgi_app, email="u@example.com", password="password123")
    res = wsgi_call(wsgi_app, "POST", "/api/auth/login", headers=AUTH_HEADERS, body={"email": "u@example.com", "password": "password123"})
    assert res.status == 200
    assert res.json["user"]["email"] == "u@example.com"
    assert len(res.json["token"]) == 64

    wrong = wsgi_call(wsgi_app, "POST", "/api/auth/login", headers=AUTH_HEADERS, body={"email": "u@example.com", "password": "wrongpass123"})
    assert wrong.status == 401
    unknown = wsgi_call(wsgi_app, "POST", "/api/auth/login", headers=AUTH_HEADERS, body={"email": "ghost@example.com", "password": "password123"})
    assert unknown.status == 401


def test_me_requires_valid_session(memory_db, wsgi_app):
    token = _register(wsgi_app).json["token"]

    res = wsgi_call(wsgi_app, "GET", "/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert res.status == 200
    assert res.json["user"]["email"] == "a@example.com"

    assert wsgi_call(wsgi_app, "GET", "/api/auth/me").status == 401
    assert wsgi_call(wsgi_app, "GET", "/api/auth/me", headers={"Authorization": "Bearer bogus-token"}).status == 401


def test_logout_invalidates_session(memory_db, wsgi_app):
    token = _register(wsgi_app).json["token"]
    res = wsgi_call(wsgi_app, "POST", "/api/auth/logout", headers={"Authorization": f"Bearer {token}"})
    assert res.status == 200
    assert res.json == {"logged_out": True}
    assert len(memory_db["state"]["sessions"]) == 0
    me = wsgi_call(wsgi_app, "GET", "/api/auth/me", headers={"Authorization": f"Bearer {token}"})
    assert me.status == 401


def test_auth_requires_database(wsgi_app):
    from grace.server.db import set_db_for_tests

    set_db_for_tests(None)  # simulate a server without DATABASE_URL
    res = _register(wsgi_app)
    assert res.status == 503
    assert "DATABASE_URL" in res.json["error"]


def test_auth_rate_limit(wsgi_app, monkeypatch):
    monkeypatch.setenv("ZEESH_AUTH_RATE_LIMIT_MAX", "3")
    for i in range(3):
        assert _register(wsgi_app, email=f"rate{i}@example.com").status == 201
    res = _register(wsgi_app, email="rate3@example.com")
    assert res.status == 429
    assert res.retry_after
    assert "Too many requests" in res.json["error"]


# ---------------------------------------------------------------------------
# Middleware / routing behavior
# ---------------------------------------------------------------------------

def test_health_reports_not_configured(wsgi_app):
    from grace.server.db import set_db_for_tests

    set_db_for_tests(None)  # simulate a server without DATABASE_URL
    res = wsgi_call(wsgi_app, "GET", "/api/health")
    assert res.status == 200
    body = res.json
    assert body["status"] == "ok"
    assert body["service"] == "zeesh-api"
    assert body["version"] == "0.1.0"
    assert body["database"] == "not_configured"
    assert body["auth"] == "not_configured"


def test_health_connected_with_db(memory_db, wsgi_app):
    res = wsgi_call(wsgi_app, "GET", "/api/health")
    assert res.json["database"] == "connected"


def test_unknown_route_and_methods(wsgi_app):
    assert wsgi_call(wsgi_app, "GET", "/api/nope").status == 404
    res = wsgi_call(wsgi_app, "POST", "/api/auth/me")
    assert res.status == 405
    assert res.headers.get("allow") == "GET"
    # /api/usage is routed as ANY; the handler itself rejects other methods
    # with its own Allow list (same as the TS backend).
    res = wsgi_call(wsgi_app, "DELETE", "/api/usage")
    assert res.status == 405
    assert res.headers.get("allow") == "POST, GET"


def test_options_preflight_204_with_cors(wsgi_app):
    res = wsgi_call(wsgi_app, "OPTIONS", "/api/auth/login")
    assert res.status == 204
    assert res.headers.get("access-control-allow-origin") == "*"
    assert wsgi_call(wsgi_app, "OPTIONS", "/api/nope").status == 404


def test_bearer_token_extraction():
    from grace.server.auth import bearer_token

    assert bearer_token({"headers": {"authorization": "Bearer abc123"}}) == "abc123"
    assert bearer_token({"headers": {"authorization": "bearer  abc123 "}}) == "abc123"
    assert bearer_token({"headers": {"authorization": "Basic abc"}}) == ""
    assert bearer_token({"headers": {}}) == ""
