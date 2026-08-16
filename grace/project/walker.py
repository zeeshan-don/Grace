"""File walker (port of src/project/walker.ts)."""

import os
from dataclasses import dataclass

from grace.project.gitignore import is_ignored, load_gitignore_rules


@dataclass
class WalkedFile:
    rel: str
    abs: str
    size: int


def walk_files(root: str, max_files: int = 5000, max_depth: int = 12) -> list[WalkedFile]:
    """Recursively list files under `root`, respecting .gitignore files
    (including nested ones) and common ignored directories."""
    out: list[WalkedFile] = []

    # stack of (absDir, relDir, depth, rules)
    stack = [(root, "", 0, load_gitignore_rules(root, ""))]

    while stack and len(out) < max_files:
        abs_dir, rel_dir, depth, rules = stack.pop()
        try:
            entries = sorted(os.listdir(abs_dir))
        except OSError:
            continue

        for name in entries:
            abs_path = os.path.join(abs_dir, name)
            rel_path = f"{rel_dir}/{name}" if rel_dir else name
            try:
                st = os.stat(abs_path)
            except OSError:
                continue

            if os.path.isdir(abs_path):
                if is_ignored(rel_path, True, rules):
                    continue
                if depth >= max_depth:
                    continue
                nested = load_gitignore_rules(abs_path, rel_path)
                stack.append((abs_path, rel_path, depth + 1, rules + nested))
            elif os.path.isfile(abs_path):
                if is_ignored(rel_path, False, rules):
                    continue
                out.append(WalkedFile(rel=rel_path, abs=abs_path, size=st.st_size))
                if len(out) >= max_files:
                    break
    return out


def rel_from(root: str, abs_path: str) -> str:
    return os.path.relpath(abs_path, root).replace("\\", "/")


def read_file_safe(abs_path: str, max_bytes: int = 1_000_000) -> dict:
    """Read up to `max_bytes` of a file, marking when it was truncated."""
    size = os.path.getsize(abs_path)
    if size > max_bytes:
        with open(abs_path, "rb") as f:
            buf = f.read(max_bytes)
        return {"content": buf.decode("utf-8", errors="replace") + "\n… [file truncated, too large]", "truncated": True}
    with open(abs_path, encoding="utf-8", errors="replace") as f:
        return {"content": f.read(), "truncated": False}
