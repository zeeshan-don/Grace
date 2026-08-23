"""
The GRACE agent loop (port of src/agent/loop.ts).

reason → act → observe: streams model turns, executes tool calls with
validation + dedup caching, classifies failures, and stops cleanly at the
iteration limit or after repeated unparseable tool calls.
"""

import json
import time

from grace.agent.compact import maybe_compact_messages
from grace.agent.context import (
    DEFAULT_CONTEXT_BUDGET,
    build_system_prompt,
    project_bits,
    task_scope_hint,
    trim_messages,
)
from grace.agent.errors import classify_provider_error, format_run_error, provider_error
from grace.agent.steering import SteeringQueue
from grace.agent.tool_cache import ToolCache
from grace.agent.tool_call import (
    ToolCallParseError,
    parse_tool_call_arguments,
    sanitize_arguments_for_wire,
    sanitize_raw_for_log,
)
from grace.git import git_awareness
from grace.providers.errors import scrub
from grace.providers.types import ToolCallParam, ToolDefinition
from grace.safety import is_protected_path, resolve_in_project
from grace.util_text import truncate_middle
from grace.verbose import debug_log

DEFAULT_MAX_ITERATIONS = 30

# After this many consecutive turns where NO tool executed, fail cleanly.
MAX_CONSECUTIVE_BROKEN_TURNS = 2


class TaskCancelledError(Exception):
    def __init__(self) -> None:
        super().__init__("Task cancelled by the user.")


class AbortSignal:
    """Minimal abort signal (Ctrl+C during a task cancels the run safely)."""

    def __init__(self) -> None:
        self._aborted = False

    def abort(self) -> None:
        self._aborted = True

    @property
    def aborted(self) -> bool:
        return self._aborted


class AgentLoop:
    def __init__(self, ctx: dict) -> None:
        self.ctx = ctx
        self.tools_by_name = {t.name: t for t in ctx["tools"]}
        self.cache = ToolCache()
        self.steering = ctx.get("steering") or SteeringQueue()
        # Instrumentation accumulated across turns.
        self.metrics = {
            "modelTimeMs": 0,
            "toolTimeMs": 0,
            "duplicateToolCalls": 0,
            "failedToolCalls": 0,
            "retries": 0,
            "brokenTurns": 0,
        }
        # Sanitized raw arguments of the most recent unparseable tool call.
        self.last_invalid_call = None

    # -------------------------------------------------------------------------
    # Run
    # -------------------------------------------------------------------------

    def run(self, input_text: str) -> dict:
        session = self.ctx["session"]
        on_status = self.ctx.get("on_status")
        max_iterations = self.ctx.get("max_iterations") or DEFAULT_MAX_ITERATIONS
        budget = self.ctx.get("context_budget") or DEFAULT_CONTEXT_BUDGET
        started_at = time.monotonic()

        session.begin_run()
        session.push_message({"role": "user", "content": input_text})
        default_system = build_system_prompt(self.ctx["project"])
        if self.ctx.get("system_prompt"):
            base = f"{self.ctx['system_prompt']}\n\nProject: {project_bits(self.ctx['project'])}\nGit:\n{git_awareness(self.ctx['projectRoot'])}"
        else:
            base = f"{default_system}\n\nGit:\n{git_awareness(self.ctx['projectRoot'])}"
        # Targeted tasks ("inspect package.json") get an explicit scope rule.
        scope = task_scope_hint(input_text)
        system = f"{base}\n\n{scope}" if scope else base
        messages = [{"role": "system", "content": system}] + list(session.messages)
        tool_defs = self.tool_defs()

        usage = {"inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "cachedInputTokens": 0}
        iterations = 0
        tool_calls_count = 0
        changed_files: set[str] = set()
        final_text = ""
        reached_limit = False
        run_error = None

        if on_status:
            on_status("Thinking…")

        while iterations < max_iterations:
            self.throw_if_aborted()
            iterations += 1

            # --- Context compaction: compress long histories automatically ---
            compacted, compaction_event = maybe_compact_messages(messages, threshold=budget)
            if compaction_event:
                messages = compacted
                if on_status:
                    on_status(
                        f"Context compacted: {compaction_event['messagesDropped']} messages "
                        f"dropped ({compaction_event['estimatedTokensBefore']} → "
                        f"{compaction_event['estimatedTokensAfter']} tokens)"
                    )

            # --- Steering: inject any user messages sent mid-task ---
            drained = self.steering.drain()
            for msg in drained:
                messages.append({"role": "user", "content": msg})
                session.push_message({"role": "user", "content": msg})
                if on_status:
                    on_status(f"Steering: {msg[:60]}{'…' if len(msg) > 60 else ''}")

            trimmed = trim_messages(messages, budget)

            turn = self.run_turn(trimmed, tool_defs)
            self.throw_if_aborted()
            if turn.get("error"):
                run_error = turn["error"]
                is_provider_failure = run_error["category"] in (
                    "provider_unavailable",
                    "provider_timeout",
                    "provider_authentication",
                )
                final_text = (
                    f"I could not reach the AI provider:\n{run_error['message']}"
                    if is_provider_failure
                    else f"The task could not be completed.\n{run_error['message']}"
                )
                session.push_message({"role": "assistant", "content": final_text})
                break
            if turn.get("usage"):
                u = turn["usage"]
                usage["inputTokens"] += u.inputTokens
                usage["outputTokens"] += u.outputTokens
                usage["totalTokens"] += u.totalTokens
                usage["cachedInputTokens"] += u.cachedInputTokens

            # The assistant message is sanitized BEFORE it enters the conversation.
            calls = turn["toolCalls"]
            wire_calls = [{"id": c.id, "name": c.name, "arguments": sanitize_arguments_for_wire(c.arguments)} for c in calls]
            messages.append({"role": "assistant", "content": turn["content"], "tool_calls": wire_calls})
            session.push_message({"role": "assistant", "content": turn["content"], "tool_calls": wire_calls})

            if not calls:
                final_text = turn["content"] or ""
                break

            tool_calls_count += len(calls)
            outcomes: list[str] = []
            for call in calls:
                self.throw_if_aborted()
                outcomes.append(self.execute_tool(call, messages))
                self.track_changed_files(changed_files, call)

            # Broken-turn detection: the model kept producing tool calls that
            # could not execute with zero progress.
            all_broken = len(outcomes) > 0 and all(o in ("invalid", "unknown") for o in outcomes)
            if all_broken:
                self.metrics["brokenTurns"] += 1
                if self.metrics["brokenTurns"] >= MAX_CONSECUTIVE_BROKEN_TURNS:
                    if self.last_invalid_call:
                        detail = f'latest: tool "{self.last_invalid_call["name"]}" had invalid JSON arguments ({len(sanitize_raw_for_log(self.last_invalid_call["raw"]))} chars).'
                    else:
                        detail = "the model called tools that do not exist."
                    run_error = {
                        "category": "invalid_tool_call",
                        "message": f"The model repeatedly produced tool calls that could not be executed safely ({detail})",
                        "providerId": self.ctx["provider"].id,
                        "providerLabel": self.ctx["provider"].label,
                        "modelId": self.ctx["provider"].get_model().id,
                        "rawArguments": self.last_invalid_call["raw"] if self.last_invalid_call else None,
                    }
                    final_text = f"I stopped because the model kept producing tool calls that could not be executed safely.\n{format_run_error(run_error)}"
                    session.push_message({"role": "assistant", "content": final_text})
                    break
            else:
                self.metrics["brokenTurns"] = 0

            if iterations >= max_iterations:
                reached_limit = True
                final_text = (
                    f"I reached the {max_iterations}-iteration limit before finishing.\n"
                    f"Latest progress: {turn['content'] or '(no text)'}\n\n"
                    'Say "continue" and I will keep going.'
                )

        if not final_text:
            final_text = "Reached the iteration limit without a final answer."

        session.add_usage(usage["inputTokens"], usage["outputTokens"])
        session.save()
        if on_status:
            on_status(f"Done in {iterations} iteration(s), {tool_calls_count} tool call(s).")

        return {
            "finalText": final_text,
            "iterations": iterations,
            "toolCalls": tool_calls_count,
            "changedFiles": list(changed_files),
            "usage": usage if usage["totalTokens"] > 0 else None,
            "reachedLimit": reached_limit,
            "error": run_error,
            "durationMs": (time.monotonic() - started_at) * 1000,
            "modelTimeMs": self.metrics["modelTimeMs"],
            "toolTimeMs": self.metrics["toolTimeMs"],
            "duplicateToolCalls": self.metrics["duplicateToolCalls"],
            "failedToolCalls": self.metrics["failedToolCalls"],
            "retries": self.metrics["retries"],
        }

    # -------------------------------------------------------------------------
    # Turn
    # -------------------------------------------------------------------------

    def tool_defs(self) -> list[ToolDefinition]:
        return [
            ToolDefinition(function={"name": t.name, "description": t.description, "parameters": t.parameters})
            for t in self.ctx["tools"]
        ]

    def throw_if_aborted(self) -> None:
        signal = self.ctx.get("signal")
        if signal and getattr(signal, "aborted", False):
            raise TaskCancelledError()

    def run_turn(self, messages: list[dict], tool_defs: list[dict]) -> dict:
        provider = self.ctx["provider"]
        on_stream = self.ctx.get("on_stream")
        max_turn_attempts = 3

        for attempt in range(max_turn_attempts):
            if attempt > 0:
                self.metrics["retries"] += 1
            content = ""
            acc: dict[int, dict] = {}
            usage = None
            turn_start = time.monotonic()
            try:
                self.throw_if_aborted()
                for event in provider.stream_chat(messages, {"tools": tool_defs, "temperature": 0.2, "signal": self.ctx.get("signal")}):
                    if event.type == "content":
                        content += event.content or ""
                        if on_stream:
                            on_stream(event.content or "")
                    elif event.type == "tool_call_delta":
                        cur = acc.get(event.index)
                        # Some providers reuse the same index for a NEW tool call
                        # (the id changes) — open a fresh slot instead of merging.
                        if event.id and cur and cur.get("id") and cur["id"] != event.id:
                            free = event.index + 1
                            while free in acc:
                                free += 1
                            cur = {"index": free, "arguments": ""}
                            acc[free] = cur
                        if cur is None:
                            cur = {"index": event.index, "arguments": ""}
                            acc[event.index] = cur
                        if event.id:
                            cur["id"] = event.id
                        if event.name:
                            cur["name"] = event.name
                        if event.argumentsDelta:
                            cur["arguments"] = cur.get("arguments", "") + event.argumentsDelta
                    elif event.type == "done":
                        if event.usage:
                            usage = event.usage
                self.metrics["modelTimeMs"] += (time.monotonic() - turn_start) * 1000
                tool_calls = [
                    ToolCallParam(
                        id=a.get("id") or f"call_{a['index']}",
                        name=a.get("name") or "unknown",
                        arguments=a.get("arguments") or "{}",
                    )
                    for a in sorted(acc.values(), key=lambda a: a["index"])
                ]
                return {"content": content, "toolCalls": tool_calls, "usage": usage}
            except TaskCancelledError:
                raise
            except Exception as err:
                self.metrics["modelTimeMs"] += (time.monotonic() - turn_start) * 1000
                if getattr(self.ctx.get("signal"), "aborted", False):
                    raise TaskCancelledError()
                raw = str(err)
                parse_error = "failed to parse tool call arguments" in raw.lower()
                is_last_attempt = attempt >= max_turn_attempts - 1

                if parse_error:
                    # The MODEL emitted tool-call arguments the provider could
                    # not parse as JSON. Recover via the structured path first.
                    self.metrics["retries"] += 1
                    structured = self.try_structured_tool_call(messages, tool_defs)
                    if structured:
                        return structured
                    debug_log(f"[grace:tool-call] provider rejected malformed tool-call arguments: {scrub(raw)}")
                    if is_last_attempt:
                        error = {
                            "category": "invalid_tool_call",
                            "message": f"The model emitted tool calls with malformed JSON arguments and the provider could not parse them. {scrub(raw)}",
                            "providerId": provider.id,
                            "providerLabel": provider.label,
                            "modelId": provider.get_model().id,
                        }
                        return {"content": content, "toolCalls": [], "error": error}
                    continue

                # Provider-level failure — surface immediately with a clean message.
                category = classify_provider_error(raw)
                rate_limited = bool(__import__("re").search(r"rate.?limit|TPM|too large|429|413", raw, __import__("re").I))
                debug_log(f"[grace:provider] {provider.id} failed ({category}): {scrub(raw)}")
                message = clean_provider_message(category, rate_limited)
                if getattr(err, "safe_message", False):
                    # Already client-authored, user-safe text (e.g. the GRACE
                    # backend's real HTTP status) — keep it so a down backend
                    # is diagnosable instead of a generic "could not be
                    # reached" that blames the user's connection.
                    message = raw
                error = {
                    "category": category,
                    "message": message,
                    "providerId": provider.id,
                    "providerLabel": provider.label,
                    "modelId": provider.get_model().id,
                }
                return {"content": content, "toolCalls": [], "error": error}

        error = provider_error("The AI provider request failed.", {"id": provider.id, "label": provider.label, "modelId": provider.get_model().id})
        return {"content": "", "toolCalls": [], "error": error}

    def try_structured_tool_call(self, messages: list[dict], tool_defs: list[dict]) -> dict | None:
        provider = self.ctx["provider"]
        on_stream = self.ctx.get("on_stream")
        if "tool_calls" not in provider.get_model().supportedFeatures:
            return None
        start = time.monotonic()
        try:
            result = provider.chat(messages, {"tools": tool_defs, "temperature": 0.2, "signal": self.ctx.get("signal")})
            self.metrics["modelTimeMs"] += (time.monotonic() - start) * 1000
            if result.content and on_stream:
                on_stream(result.content)
            return {"content": result.content or "", "toolCalls": result.toolCalls, "usage": result.usage}
        except Exception:
            self.metrics["modelTimeMs"] += (time.monotonic() - start) * 1000
            return None

    # -------------------------------------------------------------------------
    # Tool execution
    # -------------------------------------------------------------------------

    def execute_tool(self, call, messages: list[dict]) -> str:
        on_status = self.ctx.get("on_status")
        on_tool_event = self.ctx.get("on_tool_event")
        session = self.ctx["session"]
        tool = self.tools_by_name.get(call.name)

        # 1. Validate arguments BEFORE execution (conservative repair only).
        try:
            parsed = parse_tool_call_arguments(call.arguments)
            args = parsed["args"]
            if parsed["repaired"]:
                debug_log(f'[grace:tool-call] {call.name} — repaired malformed arguments (fence/prose stripped): {sanitize_raw_for_log(call.arguments)}')
        except ToolCallParseError as err:
            self.last_invalid_call = {"name": call.name, "raw": err.rawArguments}
            self.metrics["failedToolCalls"] += 1
            diag = f'Tool call "{call.name}" had invalid JSON arguments. Raw (redacted): {err.rawArguments}'
            debug_log(f"[grace:tool-call] {call.name} — invalid JSON arguments, refusing to execute: {err.rawArguments}")
            reply = (
                f"Error: {diag}\n"
                "The arguments could not be parsed as a single JSON object. Re-issue this tool call with valid JSON arguments (no code fences, no extra text)."
            )
            messages.append({"role": "tool", "tool_call_id": call.id, "content": reply})
            session.record_tool_call(diag)
            if on_tool_event:
                on_tool_event({"type": "tool-end", "tool": call.name, "ok": False})
            return "invalid"

        # 2. Unknown tool (model hallucination) — same recovery channel.
        if tool is None:
            self.metrics["failedToolCalls"] += 1
            err_text = f'Unknown tool "{call.name}". Available: {", ".join(self.tools_by_name.keys())}'
            messages.append({"role": "tool", "tool_call_id": call.id, "content": f"Error: {err_text}"})
            session.record_tool_call(err_text)
            if on_tool_event:
                on_tool_event({"type": "tool-end", "tool": call.name, "ok": False})
            return "unknown"

        # 3. Mutating tools invalidate the dedup cache.
        if call.name in ("write_file", "edit_file", "run_command"):
            self.cache.invalidate()

        # 4. Dedup: an identical, unchanged read/search is served from cache.
        cached = self.try_cache_hit(call.name, args)
        if cached is not None:
            self.metrics["duplicateToolCalls"] += 1
            messages.append({"role": "tool", "tool_call_id": call.id, "content": cached})
            return "cache"

        brief = json.dumps(args)[:140]
        if on_status:
            on_status(f"→ {call.name} {brief}")
        session.record_tool_call(f"{call.name} {brief}")

        if on_tool_event:
            on_tool_event({"type": "tool-start", "tool": call.name, "args": args})
        exec_start = time.monotonic()
        try:
            result = tool.execute(args, self._tool_context())
            self.metrics["toolTimeMs"] += (time.monotonic() - exec_start) * 1000
            if on_tool_event:
                on_tool_event({"type": "tool-end", "tool": call.name, "ok": True})
            content = truncate_middle(result, 20_000)
            self.cache_result(call.name, args, result)
            messages.append({"role": "tool", "tool_call_id": call.id, "content": content})
            return "ok"
        except Exception as err:
            self.metrics["toolTimeMs"] += (time.monotonic() - exec_start) * 1000
            self.metrics["failedToolCalls"] += 1
            if on_tool_event:
                on_tool_event({"type": "tool-end", "tool": call.name, "ok": False})
            msg = f"Error executing {call.name}: {err}"
            messages.append({"role": "tool", "tool_call_id": call.id, "content": msg})
            return "error"

    def _tool_context(self):
        """Build the ToolContext handed to tool execute()."""
        from grace.tools.registry import ToolContext

        on_status = self.ctx.get("on_status")

        def ask_permission(command: str, reasons: list[str]) -> bool:
            if on_status:
                on_status('⚠ "' + command + '" flagged (' + "; ".join(reasons) + ") — asking user…")
            on_tool_event = self.ctx.get("on_tool_event")
            if on_tool_event:
                on_tool_event({"type": "permission-request", "command": command, "reasons": reasons})
            allowed = False
            ask = self.ctx.get("ask_permission")
            if ask:
                allowed = ask(command, reasons)
            if on_tool_event:
                on_tool_event({"type": "permission-result", "command": command, "allowed": allowed})
            return allowed

        def on_tool(name: str, args: dict):
            if on_status:
                on_status(f"    ⚙ {name} {json.dumps(args)[:100]}")

        return ToolContext(
            projectRoot=self.ctx["projectRoot"],
            askPermission=ask_permission,
            onTool=on_tool,
            commandPolicy=self.ctx.get("command_policy"),
            undo=self.ctx.get("undo"),
            askUser=self.ctx.get("askUser"),
        )

    # -------------------------------------------------------------------------
    # Dedup cache
    # -------------------------------------------------------------------------

    def try_cache_hit(self, tool: str, args: dict) -> str | None:
        if tool == "read_file":
            p = args.get("path")
            if not isinstance(p, str) or not p:
                return None
            resolved = resolve_in_project(self.ctx["projectRoot"], p)
            if not resolved["ok"]:
                return None
            if is_protected_path(resolved["real"]) or is_protected_path(resolved["abs"]):
                return None
            return self.cache.get_cached_read(resolved["abs"])
        if tool == "list_directory":
            raw_path = args.get("path") if isinstance(args.get("path"), str) else ""
            depth = args.get("depth") if isinstance(args.get("depth"), (int, float)) else 1
            if raw_path:
                resolved = resolve_in_project(self.ctx["projectRoot"], raw_path)
            else:
                resolved = {"abs": self.ctx["projectRoot"], "real": self.ctx["projectRoot"], "ok": True}
            if not resolved["ok"]:
                return None
            return self.cache.get_cached_listing(resolved["abs"], int(depth))
        if tool == "search_files":
            return self.cache.get_cached_search(json.dumps(args))
        return None

    def cache_result(self, tool: str, args: dict, result: str) -> None:
        # Never cache failures — a transient error must not be replayed.
        if result.startswith("Error:"):
            return
        if tool == "read_file":
            p = args.get("path")
            if not isinstance(p, str) or not p:
                return
            resolved = resolve_in_project(self.ctx["projectRoot"], p)
            if not resolved["ok"]:
                return
            if is_protected_path(resolved["real"]) or is_protected_path(resolved["abs"]):
                return
            self.cache.set_read(resolved["abs"], result)
        elif tool == "list_directory":
            raw_path = args.get("path") if isinstance(args.get("path"), str) else ""
            depth = args.get("depth") if isinstance(args.get("depth"), (int, float)) else 1
            if raw_path:
                resolved = resolve_in_project(self.ctx["projectRoot"], raw_path)
            else:
                resolved = {"abs": self.ctx["projectRoot"], "real": self.ctx["projectRoot"], "ok": True}
            if not resolved["ok"]:
                return
            self.cache.set_listing(resolved["abs"], int(depth), result)
        elif tool == "search_files":
            self.cache.set_search(json.dumps(args), result)

    def track_changed_files(self, changed: set[str], call) -> None:
        if call.name not in ("write_file", "edit_file"):
            return
        try:
            args = json.loads(call.arguments)
            if isinstance(args, dict) and args.get("path"):
                changed.add(args["path"])
                on_tool_event = self.ctx.get("on_tool_event")
                if on_tool_event:
                    on_tool_event({"type": "file-changed", "path": args["path"]})
        except Exception:
            pass


def clean_provider_message(category: str, rate_limited: bool) -> str:
    """Clean, user-safe text for a surfaced provider failure."""
    if rate_limited:
        return "The AI provider hit a rate limit or the request was too large for it. Wait a moment and try again."
    if category == "provider_timeout":
        return "The AI provider timed out. Wait a moment and try again."
    if category == "provider_authentication":
        return "The AI provider rejected the request — the server-side API key may be invalid."
    return "The AI provider could not be reached. Check your connection and try again."
