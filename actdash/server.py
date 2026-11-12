"""Tiny local web server for the browser tools.

* serves the tool pages (`*.html`), `web/` and `data/` - never `inputs/`;
* `/api/ggwp/latest` and `/api/ggwp` expose the most recent Underwriting Report (Production) workbook of
  the GGWP folder, so the GGWP page picks up a new file without any build step. The workbook is read
  with openpyxl and summarised by underwriting year / month / class (our share, USD).
Binds to 127.0.0.1 only: nothing is reachable from other machines.
"""

from __future__ import annotations

import csv
import datetime as dt
import io
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
DATE_ISO = re.compile(r"(20\d{2})[-_.]?(\d{2})[-_.]?(\d{2})")  # 2026-11-12, 20261112
DATE_DMY = re.compile(r"(\d{2})[-_.]?(\d{2})[-_.]?(20\d{2})")  # 12112026, 12-11-2026


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


def name_date(name: str) -> str:
    m = DATE_ISO.search(name)
    if m:
        return "".join(m.groups())
    m = DATE_DMY.search(name)
    if m:
        d, mo, y = m.groups()
        return y + mo + d
    return ""


def latest_file(folder: Path) -> Path | None:
    """Most recent Underwriting Report workbook (.xlsx): by the date written in the file name, then by
    modification time. Falls back to the newest .csv (legacy GGWP extract) when there is no workbook."""
    for pattern in ("*.xlsx", "*.csv"):
        files = [f for f in folder.glob(pattern) if f.is_file() and not f.name.startswith("~$")]
        if files:
            return max(files, key=lambda f: (name_date(f.name), f.stat().st_mtime))
    return None


# ------------------------------------------------------------ Underwriting Report
COLS = {
    "ggwp": "Expected GGWP Share (USD)",  # column BV
    "gnwp": "Expected GNWP Share (USD)",  # column BY
    "uwy": "UWY",
    "inc": "Inception Date",
    "cls": "Class of Business",
}
_cache: dict = {}


def _month_year(v):
    if isinstance(v, (dt.datetime, dt.date)):
        return v.year, v.month
    if isinstance(v, str):
        for fmt in ("%Y-%m-%d", "%Y-%m-%d %H:%M:%S", "%d/%m/%Y", "%m/%d/%Y"):
            try:
                d = dt.datetime.strptime(v.strip(), fmt)
                return d.year, d.month
            except ValueError:
                pass
    return None


def read_uw_report(path: Path) -> dict:
    """Summarise the workbook: sum of expected GGWP / GNWP (our share, USD) by UWY, inception month, class."""
    st = path.stat()
    key = (str(path), st.st_mtime_ns, st.st_size)
    if key in _cache:
        return _cache[key]
    from openpyxl import load_workbook  # imported here so the server starts without openpyxl

    wb = load_workbook(io.BytesIO(path.read_bytes()), read_only=True, data_only=True)
    ws = head = start = None
    for sh in wb.worksheets:
        for i, row in enumerate(sh.iter_rows(min_row=1, max_row=10, values_only=True), start=1):
            names = [str(c).strip() if c is not None else "" for c in row]
            if all(c in names for c in COLS.values()):
                ws, head, start = sh, names, i + 1
                break
        if ws:
            break
    if ws is None:
        raise ValueError("no sheet has the columns: " + ", ".join(COLS.values()))
    ix = {k: head.index(v) for k, v in COLS.items()}
    agg: dict = {}
    n = skipped = mismatch_n = 0
    mismatch = 0.0
    for row in ws.iter_rows(min_row=start, values_only=True):
        if not row or row[ix["uwy"]] is None:
            continue
        n += 1
        my = _month_year(row[ix["inc"]])
        try:
            uwy = int(row[ix["uwy"]])
        except (TypeError, ValueError):
            skipped += 1
            continue
        if my is None:
            skipped += 1
            continue
        g = float(row[ix["ggwp"]] or 0)
        gn = float(row[ix["gnwp"]] or 0)
        cls = str(row[ix["cls"]]).strip() if row[ix["cls"]] is not None else "(blank)"
        a = agg.setdefault((uwy, my[1], cls), [0.0, 0.0])
        a[0] += g
        a[1] += gn
        if my[0] != uwy:
            mismatch_n += 1
            mismatch += g
    out = io.StringIO()
    w = csv.writer(out, quoting=csv.QUOTE_ALL)
    w.writerow([COLS["ggwp"], COLS["gnwp"], "Policy Underwriting Month", "Policy Underwriting Year", COLS["cls"]])
    for (uwy, m, cls), (g, gn) in sorted(agg.items()):
        w.writerow([f"{g:.2f}", f"{gn:.2f}", m, uwy, cls])
    warnings = []
    if skipped:
        warnings.append(f"{skipped} policy row(s) without a usable UWY or inception date were left out.")
    if mismatch_n:
        warnings.append(
            f"{mismatch_n} policy row(s) have an inception year different from their UWY "
            f"(expected GGWP {mismatch:,.0f}): they are shown under their UWY, in their inception month."
        )
    res = {
        "csv": out.getvalue(),
        "unit": "USD",
        "policy_rows": n,
        "warnings": warnings,
        "note": (
            "Expected premium, our share (USD): GGWP = Expected GGWP Share (column BV), GNWP = Expected GNWP Share "
            "(column BY). Underwriting year = UWY, underwriting month = month of the inception date, class = Class of Business."
        ),
    }
    _cache.clear()
    _cache[key] = res
    return res


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
            f = latest_file(folder) if folder.exists() else None
            if f is None:
                return self._json({"error": f"No Underwriting Report (.xlsx) found in {folder}"}, 404)
            info = file_info(f)
            if path == "/api/ggwp":
                try:
                    if f.suffix.lower() == ".xlsx":
                        info.update(read_uw_report(f))
                    else:
                        info["csv"] = f.read_text(encoding="utf-8-sig", errors="replace")
                except ImportError:
                    return self._json({"error": "openpyxl is not installed - run build.bat once (or pip install -r requirements.txt)."}, 500)
                except Exception as e:  # unreadable file or unexpected layout
                    return self._json({"error": f"Could not read {f.name}: {e}"}, 500)
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
    print(f"Underwriting Report read from: {ggwp_dir()}")
    print("Leave this window open while you use the tools; close it (or Ctrl+C) to stop.")
    if page:
        threading.Timer(0.6, lambda: webbrowser.open(url + page)).start()
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nStopped.")
