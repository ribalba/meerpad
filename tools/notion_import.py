#!/usr/bin/env python3
"""Import a Notion export into meerpad from the command line.

In Notion: Settings, Export, "Markdown & CSV", include subpages and files.
Then either upload it to a server (the usual way):

    python tools/notion_import.py --server https://meerpad.com \\
        --token $MEERPAD_TOKEN --workspace Farm [--parent <page_id>] Export.zip

or, on the server itself (inside its container), write straight into the
database the server uses (DATABASE_URL), skipping the upload:

    python tools/notion_import.py --direct --email you@example.com \\
        --workspace Farm [--parent <page_id>] Export.zip

PATH is Notion's zip (a zip of zips is fine) or an extracted folder; a folder
is zipped on the fly for the upload. ``--workspace`` takes a workspace id or
its name. The pages land under ``--parent``, by default the workspace's root.
The API token is in the app's settings.

Upload mode needs only the standard library and httpx.
"""

import argparse
import os
import sys
import tempfile
import time
import zipfile
from pathlib import Path

# Already compressed: stored as-is when a folder is zipped, which is much faster.
STORED_EXTS = {
    ".png", ".jpg", ".jpeg", ".gif", ".webp", ".heic", ".heif", ".pdf", ".zip", ".mov",
    ".mp4", ".m4a", ".mp3", ".docx", ".xlsx", ".pptx", ".gz", ".avif",
}


def human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if n < 1024 or unit == "GB":
            return f"{n:.0f} {unit}" if unit == "B" else f"{n:.1f} {unit}"
        n /= 1024
    return f"{n:.1f} GB"


def zip_folder(folder: Path) -> Path:
    """Zip an extracted export into a temp file (the caller deletes it)."""
    fd, name = tempfile.mkstemp(prefix="notion-export-", suffix=".zip")
    os.close(fd)
    count = 0
    with zipfile.ZipFile(name, "w", allowZip64=True) as zf:
        for dirpath, dirnames, filenames in os.walk(folder):
            dirnames.sort()
            for fname in sorted(filenames):
                path = Path(dirpath) / fname
                method = zipfile.ZIP_STORED if path.suffix.lower() in STORED_EXTS else zipfile.ZIP_DEFLATED
                zf.write(path, path.relative_to(folder).as_posix(), compress_type=method)
                count += 1
    print(f"Zipped {count} files from {folder} ({human(Path(name).stat().st_size)})")
    return Path(name)


class ProgressReader:
    """A file object that reports how much of it has been read (httpx streams
    a multipart file by reading it chunk by chunk)."""

    def __init__(self, fh, total: int):
        self._fh = fh
        self.total = total
        self.sent = 0
        self._last = 0.0

    def read(self, n: int = -1) -> bytes:
        data = self._fh.read(n)
        self.sent += len(data)
        now = time.monotonic()
        if now - self._last > 0.5 or not data:
            self._last = now
            pct = 100 * self.sent / self.total if self.total else 100
            print(f"\rUploading {human(self.sent)} / {human(self.total)} ({pct:.0f}%)", end="", flush=True)
        return data

    def fileno(self) -> int:
        return self._fh.fileno()

    def seek(self, *args) -> int:
        return self._fh.seek(*args)

    def tell(self) -> int:
        return self._fh.tell()


def print_progress(stats: dict, last: list) -> None:
    phase = stats.get("phase") or ""
    line = phase
    if "done" in stats and "total" in stats:
        line = (f"{phase}: {stats['done']}/{stats['total']} items, pages {stats.get('pages', 0)}, "
                f"databases {stats.get('databases', 0)}, rows {stats.get('rows', 0)}, "
                f"files {stats.get('files', 0)}")
    if line and line != last[0]:
        print(line, flush=True)
        last[0] = line


def print_result(status: str, stats: dict, error: str | None) -> int:
    warnings = stats.get("warnings") or []
    print()
    if status == "done":
        print(f"Done: {stats.get('pages', 0)} pages, {stats.get('databases', 0)} databases, "
              f"{stats.get('rows', 0)} rows, {stats.get('blocks', 0)} blocks, {stats.get('files', 0)} files")
    else:
        print(f"Import failed: {error}")
    if warnings:
        print(f"{len(warnings)} warnings:")
        for w in warnings[:30]:
            print(f"  - {w}")
        if len(warnings) > 30:
            print(f"  ... and {len(warnings) - 30} more")
    return 0 if status == "done" else 1


def upload(args: argparse.Namespace, path: Path) -> int:
    import httpx

    token = args.token or os.environ.get("MEERPAD_TOKEN")
    if not token:
        print("An API token is needed: --token or MEERPAD_TOKEN (see the app's settings)", file=sys.stderr)
        return 2
    server = args.server.rstrip("/")
    tmp = None
    if path.is_dir():
        tmp = path = zip_folder(path)
    try:
        data = {"workspace": args.workspace}
        if args.parent:
            data["parent_page_id"] = args.parent
        with open(path, "rb") as fh, httpx.Client(timeout=httpx.Timeout(120.0)) as client:
            reader = ProgressReader(fh, path.stat().st_size)
            r = client.post(
                f"{server}/api/import/notion", params={"token": token}, data=data,
                files={"file": (path.name, reader, "application/zip")},
            )
        print()
        if r.status_code != 200:
            print(f"Upload refused ({r.status_code}): {detail(r)}", file=sys.stderr)
            return 1
        job = r.json()
        print(f"Uploaded; import {job['id']} started")
        last = [""]
        with httpx.Client(timeout=httpx.Timeout(30.0)) as client:
            while True:
                time.sleep(2)
                try:
                    r = client.get(f"{server}/api/import/{job['id']}", params={"token": token})
                except httpx.HTTPError as exc:
                    print(f"(poll failed: {exc}; retrying)", file=sys.stderr)
                    continue
                if r.status_code != 200:
                    print(f"Polling failed ({r.status_code}): {detail(r)}", file=sys.stderr)
                    return 1
                job = r.json()
                print_progress(job.get("stats") or {}, last)
                if job["status"] in ("done", "error"):
                    return print_result(job["status"], job.get("stats") or {}, job.get("error"))
    finally:
        if tmp is not None:
            tmp.unlink(missing_ok=True)


def detail(r) -> str:
    try:
        return str(r.json().get("detail"))
    except ValueError:
        return r.text[:300]


def direct(args: argparse.Namespace, path: Path) -> int:
    """Import into DATABASE_URL in this process (run inside the server container)."""
    sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
    from sqlalchemy import select

    from app.database import SessionLocal
    from app.models import User, Workspace
    from app.notion_import import ImportFailed, import_notion

    if not args.email:
        print("--direct needs --email (the account to import into)", file=sys.stderr)
        return 2
    with SessionLocal() as db:
        user = db.scalar(select(User).where(User.email == args.email.strip().lower()))
        if user is None:
            print(f"No account with the email {args.email}", file=sys.stderr)
            return 1
        wanted = args.workspace.strip()
        workspaces = db.scalars(select(Workspace).where(Workspace.owner_id == user.id,
                                                        Workspace.deleted.is_(False))).all()
        matches = [w for w in workspaces if w.id == wanted] or [
            w for w in workspaces if w.name.strip().casefold() == wanted.casefold()
        ]
        if len(matches) != 1:
            names = ", ".join(sorted(w.name for w in workspaces))
            print(f"Workspace {wanted!r} {'is ambiguous' if matches else 'not found'} (have: {names})",
                  file=sys.stderr)
            return 1
        ws = matches[0]
        user_id, ws_id, parent = user.id, ws.id, args.parent or ws.root_page_id

    last = [""]
    try:
        stats = import_notion(user_id, ws_id, parent, path, lambda p: print_progress(p, last))
    except ImportFailed as exc:
        return print_result("error", {}, str(exc))
    return print_result("done", stats, None)


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description="Import a Notion export (Markdown & CSV) into meerpad.")
    ap.add_argument("path", type=Path, help="Notion's export zip, or the extracted folder")
    ap.add_argument("--workspace", required=True, help="workspace id or name")
    ap.add_argument("--parent", help="page id to import under (default: the workspace's root page)")
    ap.add_argument("--server", default=os.environ.get("MEERPAD_SERVER", "https://meerpad.com"),
                    help="meerpad server (default: $MEERPAD_SERVER or https://meerpad.com)")
    ap.add_argument("--token", help="API token (default: $MEERPAD_TOKEN)")
    ap.add_argument("--direct", action="store_true",
                    help="import straight into DATABASE_URL instead of uploading (inside the server container)")
    ap.add_argument("--email", help="with --direct: the account to import into")
    args = ap.parse_args(argv)

    path = args.path.expanduser()
    if not path.exists():
        print(f"{path} does not exist", file=sys.stderr)
        return 2
    return direct(args, path) if args.direct else upload(args, path)


if __name__ == "__main__":
    sys.exit(main())
