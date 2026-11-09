"""Tiny local web server for the browser tools (standard library only, no pandas needed).

* serves the tool pages (`*.html`), `web/` and `data/` - never `inputs/`;
* `/api/ggwp/latest` and `/api/ggwp` expose the most recent CSV of the GGWP extract folder, so the
  GGWP page picks up a new file without any build step.
Binds to 127.0.0.1 only: nothing is reachable from other machines.
"""

from __future__ import annotations

import datetime as dt
import json
import re
import socket
import threading
import webbrowser
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import urlparse

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_GGWP_DIR = "inputs/ggwp-pyramid"
DATE_IN_NAME = re.compile(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")


def ggwp_dir() -> Path:
    cfg = ROOT / "sources.json"
    rel = DEFAULT_GGWP_DIR
    if cfg.exists():
        try:
            rel = json.loads(cfg.read_text(encoding="utf-8")).get("ggwp_dir", rel)
        except ValueError:
            pass
    p = Path(rel)
    return p if p.is_absolute() else ROOT / p


def latest_csv(folder: Path) -> Path | None:
    """Most recent CSV: by the date written in the file name (2026-11-09), then by modification time."""
    files = [f for f in folder.glob("*.csv") if f.is_file() and not f.name.startswith("~$")]
    if not files:
        return None

    def key(f: Path):
        m = DATE_IN_NAME.search(f.name)
        name_date = "".join(m.groups()) if m else ""
        return (name_date, f.stat().st_mtime)

    return max(files, key=key)


def file_info(f: Path) -> dict:
    st = f.stat()
    return {
        "file": f.name,
        "folder": str(f.parent.relative_to(ROOT)) if f.is_relative_to(ROOT) else str(f.parent),
        "modified": dt.datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds"),
        "size": st.st_size,
    }


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=str(ROOT), **kw)

    # -- helpers
    def _json(self, obj, status=200):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def log_message(self, fmt, *args):  # keep the console quiet
        pass

    # -- routing
    def do_GET(self):
        path = urlparse(self.path).path
        if path in ("/api/ggwp/latest", "/api/ggwp"):
            folder = ggwp_dir()
            f = latest_csv(folder) if folder.exists() else None
            if f is None:
                return self._json({"error": f"No .csv file found in {folder}"}, 404)
            info = file_info(f)
            if path == "/api/ggwp":
                info["csv"] = f.read_text(encoding="utf-8-sig", errors="replace")
            return self._json(info)
        if path == "/":
            self.path = "/explorer.html"
        elif not self._allowed(path):
            return self.send_error(404)
        return super().do_GET()

    @staticmethod
    def _allowed(path: str) -> bool:
        parts = [p for p in path.split("/") if p]
        if not parts or ".." in parts:
            return False
        if len(parts) == 1:
            return parts[0].endswith(".html")
        return parts[0] in ("web", "data")


def free_port(start: int) -> int:
    for port in range(start, start + 30):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) != 0:
                return port
    raise SystemExit(f"No free port between {start} and {start + 29}")


def serve(port: int = 8770, page: str | None = None) -> None:
    port = free_port(port)
    httpd = ThreadingHTTPServer(("127.0.0.1", port), Handler)
    url = f"http://127.0.0.1:{port}/"
    print(f"Serving {ROOT.name} at {url}")
    print(f"GGWP extracts read from: {ggwp_dir()}")
    print("Leave this window open while you use the tools; close it (or Ctrl+C) to stop.")
    if page:
        threading.Timer(0.6, lambda: webbrowser.open(url + page)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
