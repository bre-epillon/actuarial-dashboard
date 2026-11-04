"""Build the policy / claim / posting tables and the policy-level reconciliation."""

from __future__ import annotations

from dataclasses import dataclass, field

import numpy as np
import pandas as pd

from .loaders import Source, _iso
from .mapping import (
    ACTUARIAL_ATTRIBUTES,
    FINANCE_ATTRIBUTES,
    FINANCE_NON_AMOUNTS,
    INCURRED,
    RECON_MEASURES,
)

ALL_RECON = RECON_MEASURES + [INCURRED]


def act_col(key: str) -> str:
    return f"{key}_A"


def fin_col(key: str) -> str:
    return f"{key}_F"


def delta_col(key: str) -> str:
    return f"{key}_D"


@dataclass
class Model:
    policies: pd.DataFrame  # one row per policy (union of both sources)
    claims: pd.DataFrame  # one row per (policy, claim) from actuarial data
    postings: pd.DataFrame  # actuarial rows (long format)
    finance_amounts: list[str]  # finance amount columns kept on `policies` (prefixed "F: ")
    actuarial: Source
    finance: Source
    warnings: list[str] = field(default_factory=list)

    def summary(self, policies: pd.DataFrame | None = None, tol: float = 1.0) -> pd.DataFrame:
        return recon_summary(self.policies if policies is None else policies, tol)


def recon_summary(p: pd.DataFrame, tol: float = 1.0) -> pd.DataFrame:
    rows = []
    for m in ALL_RECON:
        a, f, d = p[act_col(m.key)], p[fin_col(m.key)], p[delta_col(m.key)]
        rows.append(
            {
                "Key": m.key,
                "Measure": m.label,
                "Actuarial": a.sum(),
                "Finance": f.sum(),
                "Delta": d.sum(),
                "Abs delta": d.abs().sum(),
                "Policies |d|>tol": int((d.abs() > tol).sum()),
            }
        )
    return pd.DataFrame(rows)


def _first_non_null(g: pd.core.groupby.DataFrameGroupBy, cols: list[str]) -> pd.DataFrame:
    return g[cols].first()


def build_model(act: pd.DataFrame, act_src: Source, fin: pd.DataFrame, fin_src: Source, fin_amounts: list[str]) -> Model:
    warnings = list(act_src.warnings) + list(fin_src.warnings)

    # ---------------- actuarial: policy level ----------------
    piv = act.pivot_table(index="PolicyReference", columns="Measure", values="value", aggfunc="sum", fill_value=0.0)
    for code in ("GClmP", "GClmO", "GPrmB", "GGWP", "GPrmR", "GBrok", "GDed"):
        if code not in piv:
            piv[code] = 0.0
    a_attr_cols = [c for c in ["UWY", *ACTUARIAL_ATTRIBUTES] if c in act]
    a_attr = act.groupby("PolicyReference")[a_attr_cols].first()

    # ---------------- finance: policy level ----------------
    amounts = [c for c in fin_amounts if c not in FINANCE_NON_AMOUNTS]
    missing = sorted({c for m in RECON_MEASURES for c in m.finance} - set(fin.columns))
    if missing:
        warnings.append("Finance: mapped columns not found (treated as 0): " + ", ".join(missing))
    unnamed = [c for c in amounts if c.startswith("[") and abs(fin[c].fillna(0).sum()) > 0.005]
    if unnamed:
        warnings.append("Finance: columns without header carry non-zero amounts and are not mapped: " + ", ".join(unnamed))
    f_num = fin.groupby("Policy")[amounts].sum(min_count=1).fillna(0.0)
    f_attr_cols = [c for c in [*FINANCE_ATTRIBUTES, "YEAR"] if c in fin]
    f_attr = fin.groupby("Policy")[f_attr_cols].first()

    # ---------------- union of policies ----------------
    pols = sorted(set(piv.index) | set(f_num.index))
    p = pd.DataFrame(index=pd.Index(pols, name="Policy"))
    in_a = p.index.isin(piv.index)
    in_f = p.index.isin(f_num.index)
    p["Source"] = np.select([in_a & in_f, in_a], ["Both", "Actuarial only"], "Finance only")

    uwy_a = a_attr["UWY"].reindex(p.index) if "UWY" in a_attr else pd.Series(np.nan, index=p.index)
    uwy_f = pd.to_numeric(f_attr["YEAR"], errors="coerce").reindex(p.index) if "YEAR" in f_attr else np.nan
    p["UWY"] = pd.to_numeric(uwy_a, errors="coerce").fillna(uwy_f).astype("Int64")

    for src, label in ACTUARIAL_ATTRIBUTES.items():
        if src in a_attr:
            p[label] = a_attr[src].reindex(p.index)
    for src, label in FINANCE_ATTRIBUTES.items():
        if src in f_attr:
            p[label] = f_attr[src].reindex(p.index)

    a = piv.reindex(p.index).fillna(0.0)
    f = f_num.reindex(p.index).fillna(0.0)
    for m in ALL_RECON:
        av = sum(sign * a[code] for code, sign in m.actuarial.items())
        if m is INCURRED:
            fv = p[fin_col("GClmP")] + p[fin_col("GClmO")]
        else:
            cols = [c for c in m.finance if c in f]
            fv = f[cols].sum(axis=1) if cols else pd.Series(0.0, index=p.index)
        p[act_col(m.key)] = av
        p[fin_col(m.key)] = fv
        p[delta_col(m.key)] = av - fv
    p["GGWP_A"] = a["GGWP"]

    # ---------------- claims ----------------
    cl = act[act["ClaimReference"] != ""].copy()
    cl["Period"] = _period(cl)
    g = cl.groupby(["PolicyReference", "ClaimReference"], sort=True)
    cp = cl.pivot_table(
        index=["PolicyReference", "ClaimReference"], columns="Measure", values="value", aggfunc="sum", fill_value=0.0
    )
    claims = pd.DataFrame(index=cp.index)
    claims["Paid"] = cp["GClmP"] if "GClmP" in cp else 0.0
    claims["Case Reserves"] = cp["GClmO"] if "GClmO" in cp else 0.0
    claims["Postings"] = g.size()
    claims["Incurred"] = claims["Paid"] + claims["Case Reserves"]
    attrs = g[["TypeClaim", "Threshold"]].first() if "TypeClaim" in cl else pd.DataFrame(index=claims.index)
    periods = g["Period"].agg(["min", "max"]).rename(columns={"min": "First Period", "max": "Last Period"})
    claims = claims.join(attrs).join(periods).reset_index()
    claims = claims.rename(columns={"PolicyReference": "Policy", "ClaimReference": "Claim", "TypeClaim": "Claim Type"})
    claims["Claim Status"] = np.where(claims["Case Reserves"].abs() > 0.005, "Open", "Closed")
    n_claims = claims.groupby("Policy").size()
    n_open = claims[claims["Claim Status"] == "Open"].groupby("Policy").size()
    p["Claims_N"] = n_claims.reindex(p.index).fillna(0).astype(int)
    p["OpenClaims_N"] = n_open.reindex(p.index).fillna(0).astype(int)

    # ---------------- finance amount columns (all) ----------------
    p = pd.concat([p, f[amounts].add_prefix("F: ")], axis=1)

    # ---------------- postings ----------------
    post = act.rename(columns={"PolicyReference": "Policy", "ClaimReference": "Claim", "TypeClaim": "Claim Type"}).copy()
    post["Period"] = _period(post)

    cutoff_a, cutoff_f = act_src.as_of, fin_src.as_of
    if cutoff_a and cutoff_f and cutoff_a != cutoff_f:
        warnings.append(
            f"Cut-off mismatch: actuarial audit date {cutoff_a} vs finance cutoff {cutoff_f}. "
            "Deltas will include timing differences."
        )

    return Model(
        policies=p.reset_index(),
        claims=claims,
        postings=post,
        finance_amounts=amounts,
        actuarial=act_src,
        finance=fin_src,
        warnings=warnings,
    )


def _period(df: pd.DataFrame) -> pd.Series:
    y = pd.to_numeric(df.get("Year"), errors="coerce")
    m = pd.to_numeric(df.get("Month"), errors="coerce")
    out = y.astype("Int64").astype(str) + "-" + m.astype("Int64").astype(str).str.zfill(2)
    return out.where(y.notna() & m.notna(), None)


def date_str(s: pd.Series) -> pd.Series:
    return s.map(_iso)
