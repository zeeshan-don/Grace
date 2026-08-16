"""Capability → tool grants (port of src/agents/capabilities.ts).

The permission boundary is enforced HERE: an agent only ever receives the
tools its capabilities allow, so a read-only role physically cannot call
write_file/run_command no matter what the model asks for.
"""

READ_TOOLS = ["read_file", "search_files", "list_directory"]
WRITE_TOOLS = ["write_file", "edit_file"]
EXECUTE_TOOLS = ["run_command"]
DIFF_TOOLS = ["git_diff"]
WEB_TOOLS = ["web_fetch"]
# Browser capability has no local tool today — see browser availability.

CAPABILITY_TOOLS = {
    "read": READ_TOOLS,
    "write": WRITE_TOOLS,
    "execute": EXECUTE_TOOLS,
    "diff": DIFF_TOOLS,
    "web": WEB_TOOLS,
    "browser": [],
}


def tools_for_capabilities(all_tools: list, capabilities: list[str]) -> list:
    """Filter a full tool set down to the agent's capability grant."""
    wanted = set()
    for cap in capabilities:
        for name in CAPABILITY_TOOLS.get(cap, []):
            wanted.add(name)
    return [t for t in all_tools if t.name in wanted]


def capabilities_are_read_only(capabilities: list[str]) -> bool:
    """True when a read-only role would leak a mutating tool through its grant."""
    return "write" not in capabilities and "execute" not in capabilities


# Commands the test runner may run without asking the user.
TEST_PREFIXES = [
    "npm test", "npm run test", "npm run typecheck", "npm run build", "npm run lint", "npm run smoke",
    "pnpm test", "pnpm run test", "pnpm run typecheck", "pnpm run build", "pnpm run lint",
    "yarn test", "yarn run test", "yarn typecheck", "yarn build", "yarn lint",
    "go test", "cargo test", "mvn test", "gradle test", "pytest", "python -m pytest", "node --test",
]

# Git mutations the curator must confirm even though they are not dangerous.
GIT_MUTATE_PREFIXES = [
    "git add", "git commit", "git rm", "git mv", "git restore", "git stash", "git tag", "git clean",
]


def command_policy_for_role(role: str) -> dict | None:
    """Per-role command policy applied to run_command inside the agent's tools."""
    if role in ("editor", "test-runner"):
        return {"allowPrefixes": TEST_PREFIXES}
    if role == "git-curator":
        return {"requireApprovalPrefixes": GIT_MUTATE_PREFIXES}
    return None
