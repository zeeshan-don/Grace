"""Shared fixtures for the backend integration tests (grace/server)."""

import os
import threading

import pytest

from grace.server.db import set_db_for_tests
from grace.server.rate_limit import reset_rate_limiters
from tests.helpers.memory_db import create_memory_db

BACKEND_ENV_VARS = [
    "DATABASE_URL",
    "ZEESH_API_URL",
    "ZEESH_BETA_MODE",
    "ZEESH_BETA_ALLOWLIST",
    "ZEESH_CORS_ORIGIN",
    "ZEESH_SESSIONS_PER_DAY",
    "ZEESH_SESSION_DURATION_MINUTES",
    "ZEESH_DAILY_COST_LIMIT_INR",
    "ZEESH_GLOBAL_DAILY_COST_LIMIT_INR",
    "ZEESH_GLOBAL_MONTHLY_COST_LIMIT_INR",
    "ZEESH_INR_PER_USD",
    "ZEESH_PRICING_JSON",
    "ZEESH_AUTH_RATE_LIMIT_MAX",
    "ZEESH_API_RATE_LIMIT_MAX",
    "ZEESH_SERVER_ROUTING",
    "GROQ_API_KEY",
    "NVIDIA_API_KEY",
    "GEMINI_API_KEY",
    "MINIMAX_API_KEY",
    "DEEPSEEK_API_KEY",
]


@pytest.fixture(autouse=True)
def clean_backend_env(monkeypatch):
    """Isolate every backend test from the host environment."""
    for name in BACKEND_ENV_VARS:
        monkeypatch.delenv(name, raising=False)
    set_db_for_tests(None)
    reset_rate_limiters()
    yield
    set_db_for_tests(None)
    reset_rate_limiters()


@pytest.fixture
def memory_db():
    """A fresh in-memory database wired into the backend's get_db()."""
    mem = create_memory_db()
    set_db_for_tests(mem["db"])
    yield mem
    set_db_for_tests(None)


@pytest.fixture
def wsgi_app(memory_db):
    """The shared WSGI router with a fresh in-memory database wired in.
    Tests that need the no-DATABASE_URL path call `set_db_for_tests(None)`
    explicitly at the top."""
    from grace.server.wsgi import wsgi_app as app

    return app


@pytest.fixture
def live_server(memory_db):
    """A real HTTP server (wsgiref) serving the shared WSGI app on an
    ephemeral port — used to test the Python CLI (ApiClient) against the
    Python backend end-to-end."""
    from socketserver import ThreadingMixIn
    from wsgiref.simple_server import WSGIServer, make_server

    from grace.server.wsgi import wsgi_app

    class ThreadingWSGIServer(ThreadingMixIn, WSGIServer):
        daemon_threads = True

    httpd = make_server("127.0.0.1", 0, wsgi_app, server_class=ThreadingWSGIServer)
    port = httpd.server_address[1]
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{port}"
    httpd.shutdown()
    thread.join(timeout=2)
