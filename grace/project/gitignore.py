"""Minimal .gitignore matcher (port of src/project/gitignore.ts).

Supports the common subset of gitignore syntax:
 - blank lines and `#` comments
 - `!` negation
 - trailing `/` (directory-only)
 - leading `/` (anchored to the .gitignore location)
 - patterns containing `/` are anchored to the .gitignore location
 - patterns without `/` match the basename at any depth
 - `*`, `?`, `**`, `[...]` globs
"""

import os
import re
from dataclasses import dataclass

ALWAYS_IGNORED = {".git", "node_modules", ".zeesh", ".myagent"}


@dataclass
class IgnoreRule:
    regex: re.Pattern
    negated: bool
    dirOnly: bool
    anchored: bool
    baseRel: str


def _glob_to_regexp(pattern: str) -> re.Pattern:
    out = ""
    i = 0
    while i < len(pattern):
        ch = pattern[i]
        if ch == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                if i + 2 < len(pattern) and pattern[i + 2] == "/":
                    out += "(?:.*/)?"
                    i += 3
                else:
                    out += ".*"
                    i += 2
            else:
                out += "[^/]*"
                i += 1
        elif ch == "?":
            out += "[^/]"
            i += 1
        elif ch == "[":
            # character class — copy until closing bracket
            j = i + 1
            cls = ""
            if j < len(pattern) and pattern[j] in ("!", "^"):
                cls += "^"
                j += 1
            while j < len(pattern) and pattern[j] != "]":
                if pattern[j] == "\\":
                    cls += "\\\\" + (pattern[j + 1] if j + 1 < len(pattern) else "")
                    j += 2
                else:
                    cls += pattern[j]
                    j += 1
            if j >= len(pattern):
                out += "\\["
                i += 1
            else:
                out += "[" + cls + "]"
                i = j + 1
        else:
            out += re.escape(ch)
            i += 1
    return re.compile("^" + out + "$")


def parse_gitignore(content: str, base_rel: str) -> list[IgnoreRule]:
    rules: list[IgnoreRule] = []
    for raw_line in content.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        if line.startswith("\\#"):
            line = line[1:]

        negated = False
        if line.startswith("!"):
            negated = True
            line = line[1:]
        if not line:
            continue

        # Trailing spaces are stripped unless escaped
        line = re.sub(r"\s+$", "", line)

        dir_only = False
        if line.endswith("/"):
            dir_only = True
            line = line[:-1]
        if not line:
            continue

        anchored = False
        if line.startswith("/"):
            anchored = True
            line = line[1:]
        elif "/" in line:
            anchored = True

        try:
            rules.append(IgnoreRule(regex=_glob_to_regexp(line), negated=negated, dirOnly=dir_only, anchored=anchored, baseRel=base_rel))
        except re.error:
            # Skip malformed patterns rather than crashing the walker
            pass
    return rules


def load_gitignore_rules(dir_path: str, base_rel: str) -> list[IgnoreRule]:
    try:
        with open(os.path.join(dir_path, ".gitignore"), encoding="utf-8") as f:
            return parse_gitignore(f.read(), base_rel)
    except OSError:
        return []


def normalize_rel(p: str) -> str:
    p = p.replace("\\", "/")
    p = re.sub(r"^\.?/", "", p)
    p = re.sub(r"^/+", "", p)
    return p


def is_ignored(rel: str, is_dir: bool, rules: list[IgnoreRule]) -> bool:
    normalized = normalize_rel(rel)
    segments = normalized.split("/")

    if any(s in ALWAYS_IGNORED for s in segments):
        return True

    # Ancestor directory prefixes (for directory-only rules). Includes the
    # path itself when it is a directory.
    dir_prefixes = []
    for i in range(1, len(segments)):
        dir_prefixes.append("/".join(segments[:i]))
    if is_dir:
        dir_prefixes.append(normalized)

    ignored = False
    for rule in rules:
        if rule.dirOnly:
            for dir_prefix in dir_prefixes:
                rel_to_base = _apply_base(rule, dir_prefix)
                if rel_to_base == "":
                    continue
                target = rel_to_base if rule.anchored else _last_segment(rel_to_base)
                if rule.regex.search(target):
                    ignored = not rule.negated
                    break
        else:
            rel_to_base = _apply_base(rule, normalized)
            if rel_to_base == "":
                continue
            target = rel_to_base if rule.anchored else _last_segment(rel_to_base)
            if rule.regex.search(target):
                ignored = not rule.negated
    return ignored


def _apply_base(rule: IgnoreRule, path: str) -> str:
    if rule.baseRel == "":
        return path
    prefix = normalize_rel(rule.baseRel) + "/"
    return path[len(prefix):] if path.startswith(prefix) else ""


def _last_segment(path: str) -> str:
    segs = path.split("/")
    return segs[-1] if segs else ""
