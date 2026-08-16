"""Undo snapshots (port of src/session/undo.ts)."""

import json
import os
from pathlib import Path


class UndoStore:
    """Records the pre-modification content of files the agent changes, so the
    user can `/undo` the most recent change. Backed by `.zeesh/undo/`."""

    def __init__(self, project_root: str) -> None:
        self.dir = os.path.join(project_root, ".zeesh", "undo")
        Path(self.dir).mkdir(parents=True, exist_ok=True)
        self.counter = len([f for f in os.listdir(self.dir) if f.endswith(".json")])

    def record(self, file: str, previous_content: str | None) -> bool:
        self.counter += 1
        stamp = __import__("datetime").datetime.now().isoformat().replace(":", "-").replace(".", "-")
        path = os.path.join(self.dir, f"{self.counter:06d}_{stamp}.json")
        snap = {"file": file, "previousContent": previous_content, "at": __import__("datetime").datetime.now().isoformat()}
        try:
            Path(path).write_text(json.dumps(snap, indent=2), encoding="utf-8")
            return True
        except Exception:
            return False

    def undo(self) -> dict | None:
        snaps = sorted(f for f in os.listdir(self.dir) if f.endswith(".json"))
        if not snaps:
            return None
        latest = snaps[-1]
        path = os.path.join(self.dir, latest)
        try:
            snap = json.loads(Path(path).read_text(encoding="utf-8"))
        except Exception:
            return None
        if snap.get("previousContent") is None:
            # File was newly created by the agent — remove it.
            try:
                os.remove(snap["file"])
            except OSError:
                pass
        else:
            Path(os.path.dirname(snap["file"])).mkdir(parents=True, exist_ok=True)
            Path(snap["file"]).write_text(snap["previousContent"], encoding="utf-8")
        try:
            os.remove(path)
        except OSError:
            pass
        return {"file": snap["file"], "hadPrevious": snap.get("previousContent") is not None}

    def pending_changes(self) -> list[str]:
        out = []
        for f in sorted(x for x in os.listdir(self.dir) if x.endswith(".json")):
            try:
                snap = json.loads(Path(os.path.join(self.dir, f)).read_text(encoding="utf-8"))
            except Exception:
                continue
            if snap.get("previousContent") is None:
                out.append(f"+ {snap['file']} (created)")
            else:
                out.append(f"~ {snap['file']} (modified)")
        return out

    @property
    def count(self) -> int:
        return len([f for f in os.listdir(self.dir) if f.endswith(".json")])
