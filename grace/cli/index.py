"""GRACE entry point (port of src/index.ts).

    grace                            Start the interactive REPL
    grace "describe a task"          One-shot run, then exit
    grace login [email]              Log in to the GRACE backend
    grace register [email]           Create an account
    grace logout                     Log out and remove the local session
    grace whoami                     Show the authenticated identity
"""

import os
import sys

from grace.cli.auth_commands import cmd_login, cmd_logout, cmd_register, cmd_whoami
from grace.cli.once import run_once
from grace.cli.repl import run_repl
from grace.cli.window import launch_in_new_window, new_window_notice
from grace.meta import PRODUCT, TAGLINE, VERSION

SUBCOMMANDS = {"login", "register", "logout", "whoami"}


def parse_args(argv: list[str]) -> dict:
    out = {"yes": False, "help": False, "version": False, "verbose": False, "newWindow": False}
    i = 0
    while i < len(argv):
        a = argv[i]
        if a in ("--yes", "-y"):
            out["yes"] = True
        elif a == "--model":
            out["model"] = argv[i + 1] if i + 1 < len(argv) else None
            i += 1
        elif a in ("--verbose", "--debug"):
            out["verbose"] = True
        elif a == "--new-window":
            out["newWindow"] = True
        elif a in ("--help", "-h"):
            out["help"] = True
        elif a in ("--version", "-v"):
            out["version"] = True
        elif a == "--":
            out["prompt"] = " ".join(argv[i + 1:])
            break
        elif not a.startswith("-"):
            rest = argv[i:]
            if rest[0] in SUBCOMMANDS:
                out["subcommand"] = rest[0]
                out["subcommandArg"] = " ".join(rest[1:]).strip()
            else:
                out["prompt"] = " ".join(rest)
            break
        else:
            print(f"Unknown option: {a}", file=sys.stderr)
            out["help"] = True
        i += 1
    return out


def usage() -> str:
    return "\n".join([
        f"{PRODUCT} v{VERSION} — {TAGLINE}",
        "",
        "Usage:",
        "  grace                            Start the interactive REPL",
        '  grace "describe a task"          One-shot run, then exit',
        "  grace login [email]              Log in to the GRACE backend",
        "  grace register [email]           Create an account",
        "  grace logout                     Log out and remove the local session",
        "  grace whoami                     Show the authenticated identity",
        "",
        "Options:",
        "  --model <id>     Override the model (e.g. openai/gpt-oss-20b)",
        "  --yes, -y        Auto-approve flagged commands (dangerous!)",
        "  --new-window     Start Grace in a new terminal window (workspace preserved)",
        "  --verbose        Show verbose diagnostics (raw output, agent details)",
        "  --debug          Alias for --verbose",
        "  --help, -h       Show this help",
        "  --version, -v    Show version",
        "",
        "Interactive commands (inside the REPL):",
        "  /help  /status  /model  /provider  /cd <path>  /diff  /clear  /reset",
        "  /undo  /debug  /login  /logout  /whoami  /exit",
        "",
        "Environment:",
        "  GROQ_API_KEY     Your Groq API key (optional when logged in — the backend provides the model)",
        "  NVIDIA_API_KEY   Server-side only (Vercel env) — never needed on the CLI",
        "  ZEESH_API_URL    GRACE backend URL (default https://grace.zeeshstudios.in; set to http://localhost:8787 for local dev)",
        "  ZEESH_SHELL      Override the shell used by run_command",
        "  NO_COLOR         Disable ANSI colors",
    ])


def _reconfigure_stdio() -> None:
    """Force UTF-8 output so box-drawing/em-dash glyphs survive on Windows
    consoles and pipes (cp1252 would raise UnicodeEncodeError)."""
    for stream in (sys.stdout, sys.stderr):
        try:
            if hasattr(stream, "reconfigure"):
                stream.reconfigure(encoding="utf-8", errors="replace")
        except Exception:
            pass


def main(argv: list[str] | None = None) -> int:
    _reconfigure_stdio()
    args = parse_args(list(sys.argv[1:] if argv is None else argv))

    if args.get("version"):
        print(f"{PRODUCT} v{VERSION}")
        return 0
    if args.get("help"):
        print(usage())
        return 0
    if args.get("newWindow"):
        launched = launch_in_new_window(os.getcwd())
        if launched:
            print(new_window_notice(os.getcwd()))
            return 0
        print("Could not open a new terminal window — starting Grace in this terminal instead.", file=sys.stderr)
        return run_repl({"yes": args.get("yes"), "model": args.get("model"), "verbose": args.get("verbose")})
    if args.get("subcommand"):
        cmd = args["subcommand"]
        arg = args.get("subcommandArg") or ""
        if cmd == "login":
            return cmd_login(arg)
        if cmd == "register":
            return cmd_register(arg)
        if cmd == "logout":
            return cmd_logout()
        if cmd == "whoami":
            return cmd_whoami()
    if args.get("prompt"):
        return run_once(args["prompt"], {"yes": args.get("yes"), "model": args.get("model"), "verbose": args.get("verbose")})
    return run_repl({"yes": args.get("yes"), "model": args.get("model"), "verbose": args.get("verbose")})


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
    except Exception as err:  # never expose a raw traceback to normal users
        print(f"Grace couldn't complete that request. ({err})", file=sys.stderr)
        sys.exit(1)
