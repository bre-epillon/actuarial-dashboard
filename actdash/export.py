"""Write the build outputs: CSV extracts for the CLI and the data bundles of the two browser tools
(reconciliation.html -> recon_data.js, explorer.html -> explorer_data.js)."""

from __future__ import annotations

import datetime as dt
import json
import math
from pathlib import Path

import numpy as np
import pandas as pd

from .loaders import _iso
from .mapping import ACTUARIAL_LABELS
from .model import ALL_RECON, Model, act_col, delta_col, fin_col

RECON_JS = "recon_data.js"
EXPLORER_JS = "explorer_data.js"
META_JSON = "meta.json"
POLICY_CSV = "recon_policy_level.csv"
SUMMARY_CSV = "recon_summary.csv"
CLAIMS_CSV = "claims.csv"


# ----------------------------------------------------------------- CSV / meta
def write_outputs(model: Model, out: Path) -> dict[str, Path]:
    out.mkdir(parents=True, exist_ok=True)
    paths = {}
    pol = model.policies.copy()
    for c in pol.columns:
        if pol[c].dtype == object:
            pol[c] = pol[c].map(lambda v: _iso(v) if isinstance(v, (dt.datetime, pd.Timestamp)) else v)
    paths["policies"] = out / POLICY_CSV
    pol.to_csv(paths["policies"], index=False, float_format="%.2f")
    paths["summary"] = out / SUMMARY_CSV
    model.summary().to_csv(paths["summary"], index=False, float_format="%.2f")
    paths["claims"] = out / CLAIMS_CSV
    model.claims.to_csv(paths["claims"], index=False, float_format="%.2f")
    paths["meta"] = out / META_JSON
    paths["meta"].write_text(json.dumps(meta(model), indent=2), encoding="utf-8")
    paths["recon_bundle"] = out / RECON_JS
    write_recon_bundle(model, paths["recon_bundle"])
    paths["explorer_bundle"] = out / EXPLORER_JS
    write_explorer_bundle(model, paths["explorer_bundle"])
    return paths


def meta(model: Model) -> dict:
    return {
        "built_at": dt.datetime.now().strftime("%Y-%m-%d %H:%M"),
        "actuarial": model.actuarial.describe(),
        "finance": model.finance.describe(),
        "warnings": model.warnings,
        "recon_measures": [
            {
                "key": m.key,
                "label": m.label,
                "actuarial": m.actuarial,
                "finance": list(m.finance),
                "note": m.note,
            }
            for m in ALL_RECON
        ],
    }


# ----------------------------------------------------------- column encoders
def _clean(v):
    if v is None or v is pd.NaT or v is pd.NA:
        return None
    if isinstance(v, float):
        if math.isnan(v):
            return None
        return int(v) if v.is_integer() else v
    if isinstance(v, (np.integer,)):
        return int(v)
    if isinstance(v, (np.floating,)):
        return _clean(float(v))
    if isinstance(v, (dt.datetime, dt.date, pd.Timestamp)):
        return _iso(v)
    if v is pd.NA:
        return None
    s = str(v).strip()
    return s if s else None


def dim(name: str, series: pd.Series, group: str = "", label: str | None = None) -> dict:
    vals = [_clean(v) for v in series.tolist()]
    nums = [v for v in vals if v is not None]
    numeric = bool(nums) and all(isinstance(v, (int, float)) for v in nums)
    if not numeric:
        vals = [None if v is None else str(v) for v in vals]
    uniq = sorted({v for v in vals if v is not None}, key=(lambda x: x) if numeric else (lambda x: x.lower()))
    if any(v is None for v in vals):
        uniq.append(None)
    index = {v: i for i, v in enumerate(uniq)}
    return {
        "name": name,
        "label": label or name,
        "kind": "dim",
        "group": group,
        "numeric": numeric,
        "dict": uniq,
        "codes": [index[v] for v in vals],
    }


def num(name: str, series: pd.Series, group: str = "", label: str | None = None, src: str | None = None) -> dict:
    v = np.round(pd.to_numeric(series, errors="coerce").fillna(0.0).to_numpy(dtype=float), 2)
    v[np.abs(v) < 0.005] = 0.0
    col = {"name": name, "label": label or name, "kind": "num", "group": group}
    if src:
        col["src"] = src
    nz = np.flatnonzero(v)
    if len(nz) < 0.4 * len(v):
        col["sparse"] = [nz.tolist(), [_clean(x) for x in v[nz].tolist()]]
    else:
        col["values"] = [_clean(x) for x in v.tolist()]
    return col


def ref(name: str, series: pd.Series, keys: pd.Index) -> dict:
    idx = pd.Index(keys).get_indexer(series)
    return {"name": name, "kind": "ref", "table": "policies", "values": idx.tolist()}


# ---------------------------------------------------------------- bundles
ACT_ATTRS = ["Reserving LOB", "LOB", "Branch", "Status", "UWQ", "Inception", "Duration (m)", "Act Comment"]
FIN_ATTRS = [
    "Office", "Fin Line of Business", "Policy Type", "Prop Indicator", "Underwriter", "Reinsured",
    "Reinsured Country", "Risk Country", "Broker", "Broker Location", "Placement", "Currency",
    "Profit Center", "Cost Center", "In Force", "Risk Description", "Original Insured",
    "Policy Valid From", "Policy Valid To",
]
# Finance values the explorer keeps as reference lines on its charts (premium booked / pipeline, paid / outstanding)
EXPLORER_FIN = ("GPrmB", "Pipeline", "GClmP", "GClmO", "Incurred")


def _policy_dims(p: pd.DataFrame) -> list[dict]:
    cols = [
        dim("Policy", p["Policy"], "Key"),
        dim("Source", p["Source"], "Reconciliation"),
        dim("UWY", p["UWY"], "Actuarial"),
    ]
    cols += [dim(c, p[c], "Actuarial") for c in ACT_ATTRS if c in p]
    cols += [dim(c, p[c], "Finance") for c in FIN_ATTRS if c in p]
    return cols


def _dump(model: Model, tables: dict, path: Path) -> None:
    bundle = {"meta": meta(model), "measureLabels": ACTUARIAL_LABELS, "tables": tables}
    text = json.dumps(bundle, separators=(",", ":"), ensure_ascii=False, allow_nan=False)
    path.write_text("window.ACTDASH_DATA=" + text + ";" + chr(10), encoding="utf-8")


def write_recon_bundle(model: Model, path: Path) -> None:
    """Policy level only: Actuarial / Finance / Delta per measure, plus every finance column."""
    p = model.policies
    cols = _policy_dims(p)
    for m in ALL_RECON:
        cols.append(num(act_col(m.key), p[act_col(m.key)], "Actuarial", f"{m.label} · Act"))
    cols.append(num("GGWP_A", p["GGWP_A"], "Actuarial", "GWP total (GGWP) · Act"))
    for m in ALL_RECON:
        cols.append(num(fin_col(m.key), p[fin_col(m.key)], "Finance", f"{m.label} · Fin"))
    for m in ALL_RECON:
        cols.append(num(delta_col(m.key), p[delta_col(m.key)], "Delta", f"{m.label} · Δ"))
    cols.append(num("Claims_N", p["Claims_N"], "Counts", "# claims"))
    cols.append(num("OpenClaims_N", p["OpenClaims_N"], "Counts", "# open claims"))
    for c in model.finance_amounts:
        s = p["F: " + c]
        if (s.abs() > 0.005).any():
            cols.append(num("F: " + c, s, "Finance (all columns)", c, src=c))
    _dump(model, {"policies": {"n": len(p), "columns": cols}}, path)


def write_explorer_bundle(model: Model, path: Path) -> None:
    """Policies (attributes + actuarial amounts), claims and individual postings."""
    p = model.policies
    cols = _policy_dims(p)
    for m in ALL_RECON:
        cols.append(num(act_col(m.key), p[act_col(m.key)], "Actuarial", f"{m.label} · Act"))
    cols.append(num("GGWP_A", p["GGWP_A"], "Actuarial", "GWP total (GGWP) · Act"))
    for m in ALL_RECON:
        if m.key in EXPLORER_FIN:
            cols.append(num(fin_col(m.key), p[fin_col(m.key)], "Finance", f"{m.label} · Fin"))
    cols.append(num("Claims_N", p["Claims_N"], "Counts", "# claims"))
    cols.append(num("OpenClaims_N", p["OpenClaims_N"], "Counts", "# open claims"))

    keys = pd.Index(p["Policy"])
    c = model.claims
    claim_cols = [
        ref("_pidx", c["Policy"], keys),
        dim("Claim", c["Claim"], "Key"),
        dim("Claim Type", c["Claim Type"], "Claim") if "Claim Type" in c else None,
        dim("Threshold", c["Threshold"], "Claim") if "Threshold" in c else None,
        dim("Claim Status", c["Claim Status"], "Claim"),
        dim("First Period", c["First Period"], "Claim"),
        dim("Last Period", c["Last Period"], "Claim"),
        num("Paid", c["Paid"], "Amounts", "Claims Paid"),
        num("Case Reserves", c["Case Reserves"], "Amounts", "Case Reserves"),
        num("Incurred", c["Incurred"], "Amounts", "Incurred"),
        num("Postings", c["Postings"], "Counts", "# postings"),
    ]

    t = model.postings
    year = pd.to_numeric(t.get("Year"), errors="coerce")
    month = pd.to_numeric(t.get("Month"), errors="coerce")
    quarter = (year.astype("Int64").astype(str) + " Q" + ((month - 1) // 3 + 1).astype("Int64").astype(str)).where(
        year.notna() & month.notna(), None
    )
    post_cols = [
        ref("_pidx", t["Policy"], keys),
        dim("Claim", t["Claim"].replace("", None), "Key"),
        dim("Measure", t["Measure"], "Posting"),
        num("_value", t["value"], "Posting"),
        dim("Period", t["Period"], "Posting"),
        dim("Quarter", quarter, "Posting"),
        dim("Year", year, "Posting"),
        dim("Month", month, "Posting"),
        dim("Dev Year", t.get("DevY_UWY"), "Posting", "Dev Year (UWY)"),
        dim("Dev Month", t.get("DevM_UWY"), "Posting", "Dev Month (UWY)"),
        dim("Cut-off Date", t.get("CutOffDate"), "Posting"),
        dim("Claim Type", t["Claim Type"], "Posting") if "Claim Type" in t else None,
        dim("Threshold", t["Threshold"], "Posting") if "Threshold" in t else None,
    ]
    _dump(
        model,
        {
            "policies": {"n": len(p), "columns": cols},
            "claims": {"n": len(c), "columns": [x for x in claim_cols if x]},
            "postings": {"n": len(t), "columns": [x for x in post_cols if x]},
        },
        path,
    )
