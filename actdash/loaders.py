"""Read the actuarial data and the finance production extract from Excel."""

from __future__ import annotations

import datetime as dt
import logging
from dataclasses import dataclass, field
from pathlib import Path

import openpyxl
import pandas as pd
from openpyxl.utils import get_column_letter

from .mapping import ACTUARIAL_MEASURES, FINANCE_POLICY_HEADERS

log = logging.getLogger(__name__)

ACTUARIAL_REQUIRED = ("PolicyReference", "Measure", "value")
FINANCE_MARKER = "Total Paid Claims"  # header that identifies a finance production sheet


@dataclass
class Source:
    path: Path
    sheet: str
    rows: int = 0
    as_of: str | None = None  # audit date (actuarial) / cutoff (finance), ISO date
    warnings: list[str] = field(default_factory=list)

    def describe(self) -> dict:
        return {"file": self.path.name, "sheet": self.sheet, "rows": self.rows, "as_of": self.as_of}


def parse_spec(spec: str) -> tuple[Path, str | None]:
    """'file.xlsx#Sheet name' -> (Path, 'Sheet name'); sheet is optional."""
    if "#" in spec:
        f, s = spec.rsplit("#", 1)
        return Path(f), (s or None)
    return Path(spec), None


def _iso(v) -> str | None:
    if v is None or (not isinstance(v, str) and pd.isna(v)):
        return None
    if isinstance(v, (int, float)) and 20000 < v < 80000:  # Excel serial date
        v = dt.datetime(1899, 12, 30) + dt.timedelta(days=float(v))
    if isinstance(v, (dt.datetime, dt.date, pd.Timestamp)):
        return pd.Timestamp(v).strftime("%Y-%m-%d")
    return str(v)


def _header_rows(path: Path, max_rows: int = 15) -> dict[str, list[list]]:
    wb = openpyxl.load_workbook(path, read_only=True, data_only=True)
    try:
        out = {}
        for ws in wb.worksheets:
            out[ws.title] = [list(r) for r in ws.iter_rows(max_row=max_rows, values_only=True)]
        return out
    finally:
        wb.close()


def _find_sheet(path: Path, sheet: str | None, predicate, what: str) -> tuple[str, int]:
    heads = _header_rows(path)
    names = [sheet] if sheet else list(heads)
    if sheet and sheet not in heads:
        raise SystemExit(f"Sheet '{sheet}' not found in {path.name}. Sheets: {', '.join(heads)}")
    for name in names:
        for i, row in enumerate(heads[name]):
            if predicate(row):
                return name, i
    raise SystemExit(f"Could not find the {what} sheet in {path.name} (looked in: {', '.join(names)})")


def load_actuarial(spec: str) -> tuple[pd.DataFrame, Source]:
    path, sheet = parse_spec(spec)
    name, hdr = _find_sheet(
        path,
        sheet,
        lambda row: all(c in [str(v).strip() for v in row if v is not None] for c in ACTUARIAL_REQUIRED),
        "actuarial data",
    )
    log.info("Reading actuarial data: %s [%s]", path.name, name)
    df = pd.read_excel(path, sheet_name=name, header=hdr)
    df.columns = [str(c).strip() for c in df.columns]
    src = Source(path, name)

    df = df[df["PolicyReference"].notna()].copy()
    df["PolicyReference"] = df["PolicyReference"].astype(str).str.strip()
    df = df[df["PolicyReference"] != ""]
    df["ClaimReference"] = df.get("ClaimReference", "").fillna("").astype(str).str.strip()
    df["value"] = pd.to_numeric(df["value"], errors="coerce").fillna(0.0)

    raw = df["Measure"].astype(str).str.strip()
    df["Measure"] = raw.str.upper().map(ACTUARIAL_MEASURES)
    unknown = sorted(raw[df["Measure"].isna()].unique())
    if unknown:
        src.warnings.append(f"Actuarial: unknown measure codes ignored: {', '.join(unknown)}")
        df = df[df["Measure"].notna()]

    src.rows = len(df)
    if "AuditDate" in df:
        src.as_of = _iso(df["AuditDate"].mode().iloc[0]) if df["AuditDate"].notna().any() else None
    return df.reset_index(drop=True), src


def load_finance(spec: str) -> tuple[pd.DataFrame, Source, list[str]]:
    """Returns (frame indexed by row, source, list of amount columns)."""
    path, sheet = parse_spec(spec)
    name, hdr = _find_sheet(
        path,
        sheet,
        lambda row: FINANCE_MARKER in [str(v).strip() for v in row if v is not None],
        "finance production",
    )
    log.info("Reading finance data: %s [%s]", path.name, name)
    raw = pd.read_excel(path, sheet_name=name, header=None, skiprows=hdr)
    header = raw.iloc[0].tolist()
    cols, seen = [], {}
    for j, h in enumerate(header):
        h = str(h).strip() if h is not None and not (isinstance(h, float) and pd.isna(h)) else ""
        h = h or f"[{get_column_letter(j + 1)}]"
        if h in seen:
            seen[h] += 1
            h = f"{h} ({seen[h]})"
        else:
            seen[h] = 1
        cols.append(h)
    df = raw.iloc[1:].copy()
    df.columns = cols
    src = Source(path, name)

    pol = next((c for c in cols if c.lower() in FINANCE_POLICY_HEADERS), cols[0])
    df = df.rename(columns={pol: "Policy"})
    df["Policy"] = df["Policy"].map(lambda v: str(v).strip() if isinstance(v, str) else None)
    df = df[df["Policy"].notna() & (df["Policy"] != "")].copy()

    if "Cutoff" in df:
        cut = df["Cutoff"].map(_iso).dropna()
        src.as_of = cut.mode().iloc[0] if len(cut) else None

    # Amount columns: everything that is mostly numeric (excluding attributes).
    amounts = []
    for c in df.columns:
        if c == "Policy":
            continue
        num = pd.to_numeric(df[c], errors="coerce")
        if num.notna().mean() > 0.9 or (num.notna().sum() > 0 and df[c].map(lambda v: isinstance(v, str)).sum() == 0):
            if df[c].map(lambda v: isinstance(v, (dt.datetime, pd.Timestamp))).any():
                continue
            df[c] = num
            amounts.append(c)

    dups = int(df["Policy"].duplicated().sum())
    if dups:
        src.warnings.append(f"Finance: {dups} duplicated policy rows were summed")
    src.rows = len(df)
    return df.reset_index(drop=True), src, amounts
