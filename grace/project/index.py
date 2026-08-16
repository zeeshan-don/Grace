"""Lightweight repository index (port of src/project/index.ts)."""

import json
import os
import re
import time
from dataclasses import dataclass, field

from grace.project.detect import detect_project
from grace.project.walker import walk_files

SKIP_DIRS = {"node_modules", ".git", ".zeesh", ".myagent", "dist", "build", ".next", ".venv", "venv", "__pycache__", ".cache", "coverage"}
KEY_EXTENSIONS = {".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".go", ".rs", ".java", ".rb", ".php"}
MAX_WALK_FILES = 3_000
MAX_WALK_DEPTH = 8


@dataclass
class ProjectIndex:
    root: str
    builtAt: int
    summary: str
    fileCount: int
    dirCount: int
    topLevel: list[str] = field(default_factory=list)
    keyFiles: list[str] = field(default_factory=list)
    entrypoints: list[str] = field(default_factory=list)
    testFramework: str | None = None
    testCommand: str | None = None
    buildCommand: str | None = None
    packageManager: str | None = None
    languages: list[str] = field(default_factory=list)
    sourceDirs: list[str] = field(default_factory=list)
    importantSymbols: list[dict] = field(default_factory=list)


def _try_read(p: str) -> str | None:
    try:
        with open(p, encoding="utf-8") as f:
            return f.read()
    except OSError:
        return None


def _compute_fingerprint(root: str) -> str:
    out: list[str] = []
    stack = [(root, 0)]
    scanned = 0
    while stack and scanned < 5_000:
        dir_path, depth = stack.pop()
        try:
            entries = sorted(os.listdir(dir_path))
        except OSError:
            continue
        for name in entries:
            if scanned >= 5_000:
                break
            abs_path = os.path.join(dir_path, name)
            try:
                st = os.stat(abs_path)
            except OSError:
                continue
            if os.path.isdir(abs_path):
                if name in SKIP_DIRS:
                    continue
                out.append(f"d:{name}")
                if depth < 3:
                    stack.append((abs_path, depth + 1))
            elif os.path.isfile(abs_path):
                out.append(f"f:{name}:{st.st_size}:{st.st_mtime_ns}")
            scanned += 1

    pkg = _try_read(os.path.join(root, "package.json"))
    if pkg:
        out.append(f"pkg:{pkg}")
    return "|".join(out)


def _detect_test_framework(pkg: dict | None, test_command: str | None) -> str | None:
    if not pkg:
        return test_command
    scripts = pkg.get("scripts") or {}
    if not isinstance(scripts, dict):
        scripts = {}
    all_scripts = " ".join(str(v) for v in scripts.values()).lower()
    order = [
        (re.compile(r"vitest"), "vitest"),
        (re.compile(r"jest"), "jest"),
        (re.compile(r"mocha"), "mocha"),
        (re.compile(r"ava\b"), "ava"),
        (re.compile(r"playwright"), "playwright"),
        (re.compile(r"cypress"), "cypress"),
        (re.compile(r"node --test|node:test"), "node:test"),
        (re.compile(r"pytest"), "pytest"),
        (re.compile(r"go test"), "go test"),
        (re.compile(r"cargo test"), "cargo test"),
    ]
    for pattern, name in order:
        if pattern.search(all_scripts):
            return name
    return test_command


def _extract_symbols(content: str) -> list[str]:
    symbols: list[str] = []
    re_symbol = re.compile(
        r"export\s+(?:async\s+)?(?:function|class|const|let|interface|type)\s+([A-Za-z_$][\w$]*)"
        r"|^\s*(?:export\s+)?(?:function|class|const|let)\s+([A-Za-z_$][\w$]*)",
        re.M,
    )
    for m in re_symbol.finditer(content):
        name = m.group(1) or m.group(2)
        if name:
            symbols.append(name)
        if len(symbols) >= 20:
            break
    return list(dict.fromkeys(symbols))


def _detect_dependencies(root: str, pkg: dict | None) -> list[str]:
    out: set[str] = set()

    if pkg:
        for section in ("dependencies", "devDependencies", "peerDependencies"):
            deps = pkg.get(section)
            if isinstance(deps, dict):
                out.update(deps.keys())

    req = _try_read(os.path.join(root, "requirements.txt"))
    if req:
        for raw in req.splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or line.startswith("-") or line.startswith("."):
                continue
            out.add(re.split(r"[=<>\[]|;|\s", line)[0] or line)

    pyproject = _try_read(os.path.join(root, "pyproject.toml"))
    if pyproject:
        for pattern in (re.compile(r"^dependencies\s*=\s*\[([\s\S]*?)\]", re.M), re.compile(r"^\[tool\.poetry\.dependencies\][\s\S]*?$", re.M)):
            m = pattern.search(pyproject)
            if not m:
                continue
            block = m.group(1) if m.lastindex else m.group(0)
            for q in re.finditer(r"(?:^|[,\n])\s*[\"']([A-Za-z0-9_.-]+)[\"']", block):
                out.add(q.group(1))

    return sorted(d for d in out if " " not in d)


def _build_index(root: str) -> ProjectIndex:
    info = detect_project(root)
    files = walk_files(root, max_files=MAX_WALK_FILES, max_depth=MAX_WALK_DEPTH)

    top_level: list[str] = []
    source_dirs: set[str] = set()
    file_ext_count: dict[str, int] = {}
    try:
        for name in sorted(os.listdir(root)):
            if name in SKIP_DIRS:
                continue
            top_level.append(name)
    except OSError:
        pass

    for f in files:
        ext = f.rel[f.rel.rfind("."):] if "." in f.rel else ""
        file_ext_count[ext] = file_ext_count.get(ext, 0) + 1
        if "/" in f.rel:
            source_dirs.add(f.rel.split("/", 1)[0])

    pkg_raw = _try_read(os.path.join(root, "package.json"))
    pkg: dict | None = None
    try:
        pkg = json.loads(pkg_raw) if pkg_raw else None
        if pkg is not None and not isinstance(pkg, dict):
            pkg = None
    except Exception:
        pkg = None

    entrypoints: list[str] = []
    if pkg:
        bin_entry = pkg.get("bin")
        if isinstance(bin_entry, str):
            entrypoints.append(bin_entry)
        elif isinstance(bin_entry, dict):
            entrypoints.extend(v for v in bin_entry.values() if isinstance(v, str))
        if isinstance(pkg.get("main"), str):
            entrypoints.append(pkg["main"])
    for candidate in ("src/index.ts", "src/index.js", "index.ts", "index.js", "main.py", "app.py"):
        if candidate in entrypoints:
            continue
        try:
            if os.path.isfile(os.path.join(root, candidate)):
                entrypoints.append(candidate)
        except OSError:
            pass

    key_files = list(info.configFiles)
    for e in entrypoints:
        if e not in key_files:
            key_files.append(e)
    source_files = sorted(
        [f for f in files if f.rel[f.rel.rfind("."):] in KEY_EXTENSIONS],
        key=lambda f: len(f.rel),
    )[:30]
    for sf in source_files:
        if sf.rel not in key_files:
            key_files.append(sf.rel)
    key_files.sort()

    important_symbols: list[dict] = []
    for f in source_files[:15]:
        content = (_try_read(f.abs) or "")[:64_000]
        symbols = _extract_symbols(content)
        if symbols:
            important_symbols.append({"file": f.rel, "symbols": symbols[:12]})

    test_framework = _detect_test_framework(pkg, info.testCommand)
    ext_counts = sorted(file_ext_count.items(), key=lambda kv: kv[1], reverse=True)
    dominant_ext = ext_counts[0][0] if ext_counts else ""
    deps = _detect_dependencies(root, pkg)

    summary_lines = [
        f"{info.type}{'/' + info.framework if info.framework else ''} project · pm: {info.packageManager}"
        f"{' · languages: ' + '+'.join(info.languages) if info.languages else ''}"
        f"{' · dominant: ' + dominant_ext if dominant_ext else ''}",
        f"Test: {info.testCommand or '—'}{' · Build: ' + info.buildCommand if info.buildCommand else ''} · framework: {test_framework or '—'}",
        f"Entrypoints: {', '.join(entrypoints[:5]) or '—'}",
        f"Files: {len(files)} · top-level: {', '.join(top_level[:12])}",
        f"Key files: {', '.join(key_files[:10])}",
    ]
    if deps:
        summary_lines.append(f"Deps: {', '.join(deps[:14])}")
    if important_symbols:
        summary_lines.append(
            "Symbols: " + "; ".join(
                f"{s['file']} ({', '.join(s['symbols'][:6])})" for s in important_symbols[:6]
            )
        )
    summary = "\n".join(summary_lines)

    return ProjectIndex(
        root=root,
        builtAt=int(time.time() * 1000),
        summary=summary,
        fileCount=len(files),
        dirCount=len(source_dirs) + len(top_level),
        topLevel=top_level,
        keyFiles=key_files[:25],
        entrypoints=entrypoints,
        testFramework=test_framework,
        testCommand=info.testCommand,
        buildCommand=info.buildCommand,
        packageManager=info.packageManager,
        languages=info.languages,
        sourceDirs=list(source_dirs),
        importantSymbols=important_symbols,
    )


class ProjectIndexService:
    """Maintained, fingerprint-cached repository index."""

    def __init__(self, root: str) -> None:
        self.root = root
        self._cache: ProjectIndex | None = None
        self._fingerprint: str | None = None

    def get(self) -> ProjectIndex:
        fp = _compute_fingerprint(self.root)
        if self._cache is not None and fp == self._fingerprint:
            return self._cache
        self._cache = _build_index(self.root)
        self._fingerprint = fp
        return self._cache

    def invalidate(self) -> None:
        """Force a rebuild on the next get() (e.g. after the editor ran)."""
        self._cache = None
        self._fingerprint = None
