"""Agent loop tests (port of tests/agent.loop.test.ts) using a scripted fake
provider — no real API, no keys."""


from grace.agent.loop import AgentLoop
from grace.agent.tool_cache import ToolCache
from grace.agent.tool_call import ToolCallParseError, parse_tool_call_arguments
from grace.providers.types import ChatResult, ModelInfo, StreamEvent, Usage
from grace.session.memory import MemorySession


class FakeProject:
    """Minimal project info satisfying project_bits()."""

    type = "python"
    framework = None
    packageManager = "pip"
    languages = ["python"]
    testCommand = None
    buildCommand = None
    root = "."


FAKE_PROJECT = FakeProject()


class FakeProvider:
    """Scripted provider: replays turns from a script, defaulting to 'Done.'."""

    id = "fake"
    label = "Fake (test)"
    model = ModelInfo(id="fake-1", contextWindow=128_000, supportedFeatures=["tool_calls", "streaming"])

    def __init__(self, script=None) -> None:
        self.script = script or []
        self.call_count = 0

    def get_model(self) -> ModelInfo:
        return self.model

    def set_model(self, model_id: str) -> None:
        pass

    def list_models(self) -> list[str]:
        return [self.model.id]

    def chat(self, messages, options=None) -> ChatResult:
        raise NotImplementedError("stream_chat is used by the loop")

    def stream_chat(self, messages, options=None):
        turn = self.script[self.call_count] if self.call_count < len(self.script) else {"content": "Done."}
        self.call_count += 1
        if turn.get("error"):
            # An Exception instance is raised as-is (so attributes like
            # safe_message survive); a plain string is wrapped like a real
            # provider SDK error.
            error = turn["error"]
            raise error if isinstance(error, Exception) else RuntimeError(error)
        for tc in turn.get("toolCalls", []):
            yield StreamEvent(type="tool_call_delta", index=0, id=tc["id"], name=tc["name"], argumentsDelta=tc["arguments"])
        if turn.get("content"):
            yield StreamEvent(type="content", content=turn["content"])
        yield StreamEvent(type="done", usage=Usage(inputTokens=100, outputTokens=50, totalTokens=150))


def _make_tool(name, execute):
    from grace.tools.tool import Tool

    return Tool(name=name, description=name, parameters={"type": "object", "properties": {}}, execute=execute)


def _read_tool(tmp_path):
    def execute(args, ctx):
        return "file contents"

    return _make_tool("read_file", execute)


def test_loop_reads_edits_and_reports(tmp_path):
    """agent loop reads a file, edits it, and reports what changed."""
    writes = []

    def write_exec(args, ctx):
        writes.append(args)
        return "written"

    script = [
        {"toolCalls": [{"id": "c1", "name": "read_file", "arguments": '{"path": "a.txt"}'}]},
        {"toolCalls": [{"id": "c2", "name": "write_file", "arguments": '{"path": "a.txt", "content": "x"}'}]},
        {"content": "Done editing a.txt."},
    ]
    provider = FakeProvider(script)
    loop = AgentLoop({
        "provider": provider,
        "tools": [_read_tool(tmp_path), _make_tool("write_file", write_exec)],
        "projectRoot": str(tmp_path),
        "project": FAKE_PROJECT,
        "session": MemorySession(),
        "undo": None,
        "max_iterations": 10,
    })
    result = loop.run("update a.txt")
    assert "Done editing a.txt." in result["finalText"]
    assert len(writes) == 1
    assert "a.txt" in result["changedFiles"]
    assert result["error"] is None


def test_loop_recovers_from_bad_tool_name(tmp_path):
    script = [
        {"toolCalls": [{"id": "c1", "name": "nope_tool", "arguments": "{}"}]},
        {"content": "Recovered."},
    ]
    provider = FakeProvider(script)
    loop = AgentLoop({
        "provider": provider,
        "tools": [_read_tool(tmp_path)],
        "projectRoot": str(tmp_path),
        "project": FAKE_PROJECT,
        "session": MemorySession(),
        "undo": None,
        "max_iterations": 10,
    })
    result = loop.run("do it")
    # The unknown-tool error feeds back to the model, which recovers.
    assert result["finalText"] == "Recovered."
    assert result["error"] is None


def test_loop_surfaces_backend_http_status(tmp_path):
    """A client-authored backend error (real HTTP status) is shown verbatim
    instead of the generic "could not be reached" fallback — so a down GRACE
    backend is diagnosable from the CLI."""
    from grace.providers.remote import RemoteProviderError

    provider = FakeProvider([{"error": RemoteProviderError(500, "The GRACE backend returned status 500.")}])
    loop = AgentLoop({
        "provider": provider,
        "tools": [_read_tool(tmp_path)],
        "projectRoot": str(tmp_path),
        "project": FAKE_PROJECT,
        "session": MemorySession(),
        "undo": None,
        "max_iterations": 10,
    })
    result = loop.run("ask something")
    assert result["error"] is not None
    assert result["error"]["category"] == "provider_unavailable"
    assert result["error"]["message"] == "The GRACE backend returned status 500."
    assert "status 500" in result["finalText"]


def test_loop_surfaces_provider_failure(tmp_path):
    """A rate-limited turn surfaces immediately — the Model Router handles
    fallback, not the client."""
    script = [{"error": "Error: 429 rate limit exceeded, Limit: 8000, Requested: 11468"}]
    provider = FakeProvider(script)
    loop = AgentLoop({
        "provider": provider,
        "tools": [_read_tool(tmp_path)],
        "projectRoot": str(tmp_path),
        "project": FAKE_PROJECT,
        "session": MemorySession(),
        "undo": None,
        "max_iterations": 10,
    })
    result = loop.run("ask something")
    assert result["error"] is not None
    assert result["error"]["category"] in ("provider_unavailable", "provider_timeout", "provider_authentication")
    assert "I could not reach the AI provider" in result["finalText"]


def test_loop_stops_at_iteration_limit(tmp_path):
    """agent loop stops at the iteration limit instead of looping forever."""
    script = [
        {"toolCalls": [{"id": f"c{i}", "name": "read_file", "arguments": '{"path": "a.txt"}'}]}
        for i in range(10)
    ]
    provider = FakeProvider(script)
    loop = AgentLoop({
        "provider": provider,
        "tools": [_read_tool(tmp_path)],
        "projectRoot": str(tmp_path),
        "project": FAKE_PROJECT,
        "session": MemorySession(),
        "undo": None,
        "max_iterations": 3,
    })
    result = loop.run("do it")
    assert result["reachedLimit"] is True
    assert "iteration limit" in result["finalText"]


# ---------------------------------------------------------------------------
# Tool-call argument parsing
# ---------------------------------------------------------------------------


def test_parse_tool_call_arguments_valid_json():
    parsed = parse_tool_call_arguments('{"path": "a.txt"}')
    assert parsed["args"] == {"path": "a.txt"}
    assert parsed["repaired"] is False


def test_parse_tool_call_arguments_repairs_fences():
    parsed = parse_tool_call_arguments('```json\n{"path": "a.txt"}\n```')
    assert parsed["args"] == {"path": "a.txt"}
    assert parsed["repaired"] is True


def test_parse_tool_call_arguments_rejects_garbage():
    import pytest

    with pytest.raises(ToolCallParseError):
        parse_tool_call_arguments("not json at all {{")


# ---------------------------------------------------------------------------
# Tool cache
# ---------------------------------------------------------------------------


def test_tool_cache_dedupes_reads(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("content v1", encoding="utf-8")
    cache = ToolCache()
    cache.set_read(str(f), "content v1")
    assert cache.get_cached_read(str(f)) == "content v1"
    assert cache.get_cached_read(str(tmp_path / "b.txt")) is None


def test_tool_cache_invalidate(tmp_path):
    f = tmp_path / "a.txt"
    f.write_text("content", encoding="utf-8")
    cache = ToolCache()
    cache.set_read(str(f), "content")
    cache.invalidate()
    # Reads self-invalidate via mtime; a cached hit requires the file to exist.
    assert cache.get_cached_read(str(f)) == "content"
    cache.set_search('{"query": "x"}', "hit")
    cache.invalidate()
    assert cache.get_cached_search('{"query": "x"}') is None
