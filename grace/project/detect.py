"""Project type/framework detection (port of src/project/detect.ts)."""

import json
import os
from dataclasses import dataclass, field


@dataclass
class ProjectInfo:
    root: str
    type: str = "unknown"  # node | python | java | c-cpp | go | rust | ruby | php | other | unknown
    framework: str | None = None
    packageManager: str = "none"  # npm | yarn | pnpm | bun | poetry | uv | pip | maven | gradle | cargo | go | none
    languages: list[str] = field(default_factory=list)
    configFiles: list[str] = field(default_factory=list)
    isGitRepo: bool = False
    testCommand: str | None = None
    buildCommand: str | None = None


FRAMEWORK_HINTS: list[tuple[list[str], str]] = [
    (["next"], "next"),
    (["nuxt"], "nuxt"),
    (["react"], "react"),
    (["vue"], "vue"),
    (["svelte"], "svelte"),
    (["@nestjs/core"], "nest"),
    (["express"], "express"),
    (["fastify"], "fastify"),
    (["astro"], "astro"),
    (["remix"], "remix"),
    (["gatsby"], "gatsby"),
]


def _exists(p: str) -> bool:
    try:
        return os.path.exists(p)
    except OSError:
        return False


def _read_json(p: str) -> dict | None:
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else None
    except Exception:
        return None


def detect_project(root: str) -> ProjectInfo:
    config_files: list[str] = []
    languages: list[str] = []
    ptype: str = "unknown"
    package_manager: str = "none"
    framework: str | None = None
    test_command: str | None = None
    build_command: str | None = None

    package_json = os.path.join(root, "package.json")
    has_pkg = _exists(package_json)

    if has_pkg:
        ptype = "node"
        package_manager = "npm"
        pkg = _read_json(package_json) or {}
        scripts = pkg.get("scripts") or {}
        if not isinstance(scripts, dict):
            scripts = {}
        deps = {}
        for section in ("dependencies", "devDependencies"):
            d = pkg.get(section)
            if isinstance(d, dict):
                deps.update(d)
        for keys, name in FRAMEWORK_HINTS:
            if any(k in deps for k in keys):
                framework = name
                break
        if scripts.get("test"):
            test_command = "npm test"
        if scripts.get("build"):
            build_command = "npm run build"
        if _exists(os.path.join(root, "tsconfig.json")):
            languages.append("typescript")
        if _exists(os.path.join(root, "jsconfig.json")):
            languages.append("javascript")
        if not languages:
            languages.append("javascript")

        if _exists(os.path.join(root, "pnpm-lock.yaml")):
            package_manager = "pnpm"
        elif _exists(os.path.join(root, "yarn.lock")):
            package_manager = "yarn"
        elif _exists(os.path.join(root, "bun.lockb")) or _exists(os.path.join(root, "bun.lock")):
            package_manager = "bun"
    elif _exists(os.path.join(root, "pyproject.toml")):
        ptype = "python"
        package_manager = "uv"
        if not _exists(os.path.join(root, "uv.lock")) and _exists(os.path.join(root, "poetry.lock")):
            package_manager = "poetry"
        test_command = "python -m pytest"
        languages.append("python")
    elif _exists(os.path.join(root, "requirements.txt")) or _exists(os.path.join(root, "setup.py")):
        ptype = "python"
        package_manager = "pip"
        test_command = "python -m pytest"
        languages.append("python")
    elif _exists(os.path.join(root, "pom.xml")):
        ptype = "java"
        package_manager = "maven"
        test_command = "mvn test"
        languages.append("java")
    elif _exists(os.path.join(root, "build.gradle")) or _exists(os.path.join(root, "build.gradle.kts")):
        ptype = "java"
        package_manager = "gradle"
        test_command = "gradle test"
        languages.append("java")
    elif _exists(os.path.join(root, "go.mod")):
        ptype = "go"
        package_manager = "go"
        test_command = "go test ./..."
        languages.append("go")
    elif _exists(os.path.join(root, "Cargo.toml")):
        ptype = "rust"
        package_manager = "cargo"
        test_command = "cargo test"
        languages.append("rust")
    elif _exists(os.path.join(root, "CMakeLists.txt")):
        ptype = "c-cpp"
        languages.extend(["c", "c++"])
    elif _exists(os.path.join(root, "Makefile")) or _exists(os.path.join(root, "makefile")):
        ptype = "c-cpp"
        languages.extend(["c", "c++"])
    elif _exists(os.path.join(root, "Gemfile")):
        ptype = "ruby"
        languages.append("ruby")
    elif _exists(os.path.join(root, "composer.json")):
        ptype = "php"
        languages.append("php")
    elif _exists(os.path.join(root, "index.html")) or _exists(os.path.join(root, "src")):
        ptype = "other"

    all_configs = [
        "package.json", "tsconfig.json", "jsconfig.json", "vite.config.ts", "vite.config.js",
        "next.config.mjs", "next.config.js", "webpack.config.js", "eslint.config.js", ".eslintrc.json",
        "jest.config.js", "vitest.config.ts", "prettier.config.js", ".prettierrc", "tailwind.config.js",
        "pyproject.toml", "requirements.txt", "setup.py", "pom.xml", "build.gradle", "go.mod", "Cargo.toml",
        "Gemfile", "composer.json", ".github/workflows/ci.yml", "Dockerfile", "docker-compose.yml",
    ]
    for c in all_configs:
        if _exists(os.path.join(root, c)):
            config_files.append(c)

    if ptype == "node":
        if _exists(os.path.join(root, "vite.config.ts")) or _exists(os.path.join(root, "vite.config.js")):
            if not framework:
                framework = "vite"
        if _exists(os.path.join(root, "jest.config.js")) or _exists(os.path.join(root, "jest.config.ts")):
            if not test_command:
                test_command = "npm test"

    return ProjectInfo(
        root=root,
        type=ptype,
        framework=framework,
        packageManager=package_manager,
        languages=list(dict.fromkeys(languages)),
        configFiles=config_files,
        isGitRepo=_exists(os.path.join(root, ".git")),
        testCommand=test_command,
        buildCommand=build_command,
    )


def project_label(info: ProjectInfo) -> str:
    bits = [info.type]
    if info.framework:
        bits.append(info.framework)
    return " · ".join(bits)
