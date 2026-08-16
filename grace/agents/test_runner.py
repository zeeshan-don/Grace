"""Deterministic Test Runner (port of src/agents/testRunner.ts, NO_LLM tier)."""

from grace.agents.capabilities import TEST_PREFIXES
from grace.agents.types import SubagentResult
from grace.tools.run_command import matches_prefix, run_shell_command

RUN_TIMEOUT_SEC = 300
MAX_SUMMARY_CHARS = 600

# Per-project-type fallback commands when no test command was detected.
TEST_COMMANDS_BY_TYPE = {
    "node": "npm test",
    "python": "python -m pytest",
    "go": "go test ./...",
    "rust": "cargo test",
    "java": "mvn test",
    "ruby": "bundle exec rspec",
}


def _one_liner(text: str) -> str:
    flat = " ".join(text.split()).strip()
    return flat[:MAX_SUMMARY_CHARS - 1] + "…" if len(flat) > MAX_SUMMARY_CHARS else flat


def run_deterministic_test_runner(project_root: str, project) -> SubagentResult:
    base = SubagentResult(
        agent="test-runner",
        label="Test Runner",
        status="skipped",
        summary="",
    )

    command = project.testCommand or TEST_COMMANDS_BY_TYPE.get(project.type)
    if not command:
        return SubagentResult(agent="test-runner", label="Test Runner", status="skipped", summary="No test framework detected — nothing to run.")
    if not matches_prefix(command, TEST_PREFIXES):
        return SubagentResult(
            agent="test-runner",
            label="Test Runner",
            status="skipped",
            summary=f'Tests need explicit approval ("{command}") — run them manually or approve first.',
        )

    result = run_shell_command(command, cwd=project_root, timeout_sec=RUN_TIMEOUT_SEC)
    output = "\n".join(x for x in [result["stdout"], result["stderr"]] if x).strip()

    if result["timedOut"]:
        return SubagentResult(agent="test-runner", label="Test Runner", status="failed", summary=f"Tests timed out after {RUN_TIMEOUT_SEC}s.")
    if result["exitCode"] == 0:
        return SubagentResult(
            agent="test-runner",
            label="Test Runner",
            status="completed",
            summary=f"Passed — {_one_liner(output)}" if output else "All tests passed.",
        )
    detail = _one_liner(output or "No output captured.")
    error = f"Tests failed (exit {result['exitCode'] if result['exitCode'] is not None else 'unknown'}): {detail}"
    return SubagentResult(
        agent="test-runner",
        label="Test Runner",
        status="failed",
        summary=error,
        error=error,
        findings=[f"Tests failed with exit code {result['exitCode'] if result['exitCode'] is not None else 'unknown'}."],
    )
