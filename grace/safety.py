"""
Safety policy (port of src/safety/policy.ts).

 - Dangerous commands require explicit user confirmation before execution.
 - Protected files (.env, keys, credentials, SSH material) are never
   read/written by file tools, and references to them in shell commands
   are flagged.
 - Secret-like values are redacted from command output before it is
   sent back to the model.
"""

import os
import re
from dataclasses import dataclass, field

# ---------------------------------------------------------------------------
# Dangerous command patterns
# ---------------------------------------------------------------------------

DANGEROUS_PATTERNS: list[tuple[re.Pattern, str]] = [
    (re.compile(r"(^|\s)rm\s+(-{1,2}[a-zA-Z]*[rf][a-zA-Z]*\s+)+", re.I), "recursive/forced file deletion"),
    (re.compile(r"(^|\s)rm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*(\/|~|\*|\.\s|\.\*)"), "deleting root/home/wildcard paths"),
    # `rm file -rf` / `rmdir --recursive --force` — flags anywhere in the invocation
    (re.compile(r"(^|\s)(rm|rmdir)\s+[^\n;|&]*\s+-{1,2}[a-zA-Z]*[rfR][a-zA-Z]*\b", re.I), "recursive/forced file deletion"),
    (re.compile(r"(^|\s)(rm|rmdir)\s+[^\n;|&]*(--recursive|--force|--dir)\b", re.I), "recursive/forced file deletion"),
    (re.compile(r"(^|\s)(rmdir|unlink)\s+", re.I), "directory/file removal"),
    (re.compile(r"(^|\s)(sudo|pkexec|doas)\s+", re.I), "privilege escalation"),
    (re.compile(r"(^|\s)su\s+-", re.I), "switch user (root)"),
    (re.compile(r"\bgit\s+(push|pull|fetch)\b", re.I), "network git operation"),
    (re.compile(r"\bgit\s+reset\s+(--hard|-{1,2}h)\b", re.I), "hard git reset (destroys commits)"),
    (re.compile(r"\bgit\s+clean\s+-[a-z]*f", re.I), "git clean -f (deletes untracked files)"),
    (re.compile(r"\bgit\s+checkout\s+(--|\.)"), "discards working-tree changes"),
    (re.compile(r"\bgit\s+(merge|rebase|cherry-pick|revert)\b", re.I), "history-modifying git operation"),
    (re.compile(r"\bgit\s+push\s+(-f|--force)", re.I), "force push (rewrites remote history)"),
    (re.compile(r"\bdrop\s+(database|table|schema|view)\b", re.I), "database destruction"),
    (re.compile(r"\btruncate\s+(table|database)\b", re.I), "database data deletion"),
    (re.compile(r"\bDELETE\s+FROM\b", re.I), "bulk database row deletion"),
    (re.compile(r"\b(dd|mkfs|fdisk|mkswap)\b", re.I), "low-level disk operation"),
    (re.compile(r"\b(shutdown|reboot|poweroff|halt|init\s+0)\b", re.I), "system shutdown/reboot"),
    (re.compile(r"\bkill\s+-9\b", re.I), "force-kill process"),
    (re.compile(r"\b(chmod|chown)\s+-R\b", re.I), "recursive permission change"),
    (re.compile(r"\bcurl\b[^|]*\|\s*(ba)?sh\b", re.I), "pipe remote script into shell"),
    (re.compile(r"\bwget\b[^|]*\|\s*(ba)?sh\b", re.I), "pipe remote script into shell"),
    (re.compile(r"\bnpm\s+(publish|uninstall\s+-g|install\s+-g|rm\s+-g)\b", re.I), "global/remote package operation"),
    (re.compile(r"\b(terraform|tofu)\s+.*\b(apply|destroy)\b", re.I), "terraform apply/destroy (infra)"),
    (re.compile(r"\bkubectl\s+.*\b(delete|apply|replace)\b", re.I), "kubectl mutate (infra)"),
    (re.compile(r"\bhelm\s+.*\b(delete|upgrade|install)\b", re.I), "helm mutate (infra)"),
    (re.compile(r"\b(systemctl|service)\s+\S+\s+(stop|kill|reset-failed)\b", re.I), "stops a system service"),
    (re.compile(r"\b(dropdb|createdb)\b", re.I), "database create/drop"),
    # Dependency installation is a project mutation: the agent must never install
    # a framework merely because it cannot find one.
    (re.compile(r"(^|\s)(pip|pip3|pipx)\s+install\b", re.I), "installs a Python package (dependency change)"),
    (re.compile(r"python(\d+(\.\d+)?)?\s+(-m\s+)?pip\s+install\b", re.I), "installs a Python package (dependency change)"),
    (re.compile(r"\buv\s+pip\s+install\b", re.I), "installs a Python package (dependency change)"),
    (re.compile(r"\bpoetry\s+add\b", re.I), "adds a Python dependency"),
    (re.compile(r"\b(cargo|gem)\s+(add|install)\b", re.I), "adds/installs a dependency"),
    (re.compile(r"\b(npm|pnpm|yarn|bun)\s+(i|install|add)\s+\S+", re.I), "installs a package (dependency change)"),
]

# ---------------------------------------------------------------------------
# Protected paths
# ---------------------------------------------------------------------------


def is_protected_path(abs_path: str) -> bool:
    """Filenames / path fragments that file tools must never touch."""
    name = os.path.basename(abs_path)
    norm = abs_path.replace("\\", "/")

    if name.startswith(".env"):
        return True
    if re.search(r"\.(pem|p12|pfx|key|p8|keystore|jks)$", name, re.I):
        return True
    if re.match(r"^(id_rsa|id_ed25519|id_ecdsa|id_dsa)(\.pub)?$", name):
        return True
    if re.match(r"^credentials?$", name, re.I):
        return True
    if re.match(r"^(\.netrc|\.npmrc|\.pypirc|\.htpasswd)$", name):
        return True
    if re.match(r"^secret", name) and re.search(r"\.(ya?ml|json|env|txt)$", name, re.I):
        return True
    if re.search(r"\.docker[\\/]config\.json$", norm):
        return True
    if ".ssh/" in norm:
        return True
    return False


# Characters that terminate a filename token in a shell command.
_TOKEN_END = r"[;\s$&|<>'\"(){}]"


def command_touches_protected(command: str) -> bool:
    """True when a command string references a protected file (may leak secrets)."""
    env_like = re.compile(rf"(^|\s|['\"])[^\s'\"]*\.env(\.[\w-]+)?($|{_TOKEN_END})", re.I)
    key_like = re.compile(rf"\.(pem|p12|pfx|key|p8)($|{_TOKEN_END})", re.I)
    return (
        bool(env_like.search(command))
        or bool(key_like.search(command))
        or bool(re.search(r"\b(id_rsa|id_ed25519|\.ssh)\b", command, re.I))
    )


# ---------------------------------------------------------------------------
# Command assessment
# ---------------------------------------------------------------------------


@dataclass
class CommandAssessment:
    level: str  # 'safe' | 'flagged'
    reasons: list[str] = field(default_factory=list)


def assess_command(command: str) -> CommandAssessment:
    reasons: list[str] = []
    for pattern, reason in DANGEROUS_PATTERNS:
        if pattern.search(command):
            reasons.append(reason)
    if command_touches_protected(command):
        reasons.append("references a protected file (.env / key / credential) — may expose secrets")
    return CommandAssessment(level="flagged" if reasons else "safe", reasons=list(dict.fromkeys(reasons)))


# ---------------------------------------------------------------------------
# Secret redaction
# ---------------------------------------------------------------------------


def redact_secrets(text: str) -> str:
    """Redact secret-like values from text (applied to command output and search hits)."""
    text = re.sub(
        r"-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----",
        "[REDACTED PRIVATE KEY]",
        text,
    )
    text = re.sub(r"\bsk-[A-Za-z0-9_-]{20,}\b", "[REDACTED]", text)
    text = re.sub(r"\bgsk_[A-Za-z0-9]{20,}\b", "[REDACTED]", text)
    text = re.sub(r"\bnvapi-[A-Za-z0-9_-]{16,}\b", "[REDACTED]", text)
    text = re.sub(r"\bAIza[0-9A-Za-z_-]{20,}\b", "[REDACTED]", text)
    text = re.sub(r"\bAKIA[0-9A-Z]{16}\b", "[REDACTED]", text)
    text = re.sub(r"(xox[baprs]-)[A-Za-z0-9-]{10,}", r"\1[REDACTED]", text)
    text = re.sub(r"(github_pat_|ghp_|gho_)[A-Za-z0-9_]{20,}", r"\1[REDACTED]", text)
    return text


# ---------------------------------------------------------------------------
# Path containment
# ---------------------------------------------------------------------------


def resolve_in_project(root: str, p: str) -> dict:
    """
    Resolve a tool-provided path and ensure it stays inside the project root.
    Containment is checked against BOTH the lexical path and the resolved
    realpath, so symlinks that point outside the root (or at protected files)
    are caught. Windows paths are compared case-insensitively.
    """
    is_absolute = p.startswith("/") or p.startswith("\\") or bool(re.match(r"^[a-zA-Z]:[\\/]", p))
    abs_path = os.path.normpath(p if is_absolute else os.path.join(root, p))
    real = _resolve_real(abs_path)
    if not _is_within(root, abs_path) or not _is_within(root, real):
        return {"abs": abs_path, "ok": False, "reason": f'path "{p}" escapes the project root ({root})'}
    return {"abs": abs_path, "real": real, "ok": True}


def _is_within(root: str, target: str) -> bool:
    root_norm = _norm_case(os.path.normpath(root))
    t_norm = _norm_case(os.path.normpath(target))
    if t_norm == root_norm:
        return True
    prefix = root_norm if root_norm.endswith(os.sep) else root_norm + os.sep
    return t_norm.startswith(prefix)


def _norm_case(p: str) -> str:
    return p.lower() if os.name == "nt" else p


def _resolve_real(abs_path: str) -> str:
    try:
        return os.path.realpath(abs_path)
    except Exception:
        return abs_path  # file may not exist yet (write_file) — lexical check still applies
