"""
Per-run tool-result cache (port of src/agent/toolCache.ts).

Stops the loop from re-reading the same file / re-listing the same directory
/ re-running the same search when nothing changed — the "tool loop
thrashing" problem. Correctness rules:

 - read_file is keyed by path and re-validated against the file's mtime +
   size, so an agent edit (or an external edit) instantly invalidates it.
 - list_directory is keyed by path + depth and re-validated against the
   directory's mtime.
 - search_files is keyed by the full normalized query + an "epoch" that is
   bumped whenever the agent mutates the repository.

Only successful (non-"Error:") results are cached, so transient failures are
never masked. The cache lives for one agent run.
"""

import os


class ToolCache:
    def __init__(self) -> None:
        self.reads: dict[str, dict] = {}
        self.listings: dict[str, dict] = {}
        self.searches: dict[str, str] = {}
        self.epoch = 0

    @property
    def epoch_value(self) -> int:
        return self.epoch

    def invalidate(self) -> None:
        """Call after any tool that can change repository state. Invalidates
        search hits so they are recomputed. read/list caches self-invalidate
        via mtime."""
        self.epoch += 1
        self.searches.clear()
        self.listings.clear()

    # read_file -------------------------------------------------------------

    def get_cached_read(self, abs_path: str) -> str | None:
        st = _stat_safe(abs_path)
        if not st or not os.path.isfile(abs_path):
            return None
        entry = self.reads.get(abs_path)
        if entry and entry["mtimeMs"] == st.st_mtime_ns // 1_000_000 and entry["size"] == st.st_size:
            return entry["result"]
        return None

    def set_read(self, abs_path: str, result: str) -> None:
        st = _stat_safe(abs_path)
        if not st or not os.path.isfile(abs_path):
            return
        self.reads[abs_path] = {"mtimeMs": st.st_mtime_ns // 1_000_000, "size": st.st_size, "result": result}

    # list_directory ---------------------------------------------------------

    def get_cached_listing(self, abs_path: str, depth: int) -> str | None:
        st = _stat_safe(abs_path)
        if not st or not os.path.isdir(abs_path):
            return None
        entry = self.listings.get(_key(abs_path, depth))
        if entry and entry["epoch"] == self.epoch and entry["mtimeMs"] == st.st_mtime_ns // 1_000_000:
            return entry["result"]
        return None

    def set_listing(self, abs_path: str, depth: int, result: str) -> None:
        st = _stat_safe(abs_path)
        if not st or not os.path.isdir(abs_path):
            return
        self.listings[_key(abs_path, depth)] = {"mtimeMs": st.st_mtime_ns // 1_000_000, "epoch": self.epoch, "result": result}

    # search_files -----------------------------------------------------------

    def get_cached_search(self, query_key: str) -> str | None:
        return self.searches.get(f"{self.epoch}::{query_key}")

    def set_search(self, query_key: str, result: str) -> None:
        self.searches[f"{self.epoch}::{query_key}"] = result


def _key(abs_path: str, depth: int) -> str:
    return f"{abs_path}@{depth}"


def _stat_safe(p: str):
    try:
        return os.stat(p)
    except OSError:
        return None
