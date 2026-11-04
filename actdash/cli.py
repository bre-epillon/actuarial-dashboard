"""Command line entry point: build the datasets and analyse reconciliation discrepancies.

    python recon.py build                       # read inputs (see sources.json) -> data/
    python recon.py summary [--tol 100]         # the Excel "Reconciliation" table
    python recon.py top -m os -n 20             # largest policy-level deltas
    python recon.py by "Reserving LOB" -m prem  # delta by any dimension
    python recon.py policy <POLICY_REF>         # everything about one policy
    python recon.py missing                     # policies present in one source only

Filters for summary/top/by/missing:  --where "UWY=2024,2025" --where "Branch!=DUBAI"
"""

from __future__ import annotations

import argparse
import json
import logging
import sys
import time
from pathlib import Path

import pandas as pd

from .export import CLAIMS_CSV, META_JSON, POLICY_CSV, write_outputs
from .loaders import load_actuarial, load_finance
from .mapping import MEASURE_ALIASES
from .model import ALL_RECON, act_col, build_model, delta_col, fin_col, recon_summary

ROOT = Path(__file__).resolve().parent.parent
LABELS = {m.key: m.label for m in ALL_RECON}


# ------------------------------------------------------------------ helpers
def _measure(name: str) -> str:
    key = MEASURE_ALIASES.get(name.lower(), name)
    if key not in LABELS:
        raise SystemExit(f"Unknown measure '{name}'. Use one of: {', '.join(LABELS)} (or aliases {', '.join(MEASURE_ALIASES)})")
    return key


def _fmt(units: str):
    div = {"": 1, "k": 1e3, "m": 1e6}[units]
    dec = 0 if units == "" else (1 if units == "k" else 2)
    return lambda v: "" if pd.isna(v) else f"{v / div:,.{dec}f}"


def _print(df: pd.DataFrame, money: list[str], units: str = "") -> None:
    f = _fmt(units)
    out = df.copy()
    for c in money:
        out[c] = out[c].map(f)
    out = out.astype(object).where(out.notna(), "")
    for c in out.columns:
        if c not in money:
            out[c] = out[c].map(lambda v: f"{v:,}" if isinstance(v, int) and abs(v) >= 10000 else str(v).removesuffix(".0"))
    with pd.option_context("display.max_rows", None, "display.max_columns", None, "display.width", 250):
        print(out.to_string(index=False))


def _load(data: Path) -> tuple[pd.DataFrame, dict]:
    f = data / POLICY_CSV
    if not f.exists():
        raise SystemExit(f"{f} not found - run `python recon.py build` first.")
    meta = json.loads((data / META_JSON).read_text(encoding="utf-8"))
    return pd.read_csv(f, low_memory=False), meta


def _apply_where(df: pd.DataFrame, where: list[str]) -> pd.DataFrame:
    cols = {c.lower(): c for c in df.columns}
    for w in where or []:
        neg = "!=" in w
        k, v = w.split("!=" if neg else "=", 1)
        col = cols.get(k.strip().lower())
        if col is None:
            raise SystemExit(f"Unknown column '{k}'. Available: {', '.join(c for c in df.columns if not c.startswith('F: '))}")
        wanted = {x.strip().lower() for x in v.split(",")}
        hit = df[col].astype(str).str.replace(r"\.0$", "", regex=True).str.lower().isin(wanted)
        df = df[~hit if neg else hit]
    return df


def _header(meta: dict, n: int, where: list[str] | None) -> None:
    a, f = meta["actuarial"], meta["finance"]
    print(f"Actuarial: {a['file']} [{a['sheet']}] as of {a['as_of']}   |   Finance: {f['file']} [{f['sheet']}] cutoff {f['as_of']}")
    if where:
        print("Filters: " + "; ".join(where))
    print(f"Policies in scope: {n:,}   (built {meta['built_at']})")
    for w in meta.get("warnings", []):
        print(f"  ! {w}")
    print()


# ------------------------------------------------------------------ commands
def cmd_build(args) -> None:
    cfg = json.loads((ROOT / "sources.json").read_text(encoding="utf-8")) if (ROOT / "sources.json").exists() else {}
    act_spec = args.actuarial or cfg.get("actuarial")
    fin_spec = args.finance or cfg.get("finance")
    if not act_spec or not fin_spec:
        raise SystemExit("Specify --actuarial and --finance (or set them in sources.json)")
    t = time.time()
    act, act_src = load_actuarial(str(ROOT / act_spec) if not Path(act_spec.split("#")[0]).is_absolute() else act_spec)
    fin, fin_src, amounts = load_finance(str(ROOT / fin_spec) if not Path(fin_spec.split("#")[0]).is_absolute() else fin_spec)
    model = build_model(act, act_src, fin, fin_src, amounts)
    out = Path(args.out) if Path(args.out).is_absolute() else ROOT / args.out
    paths = write_outputs(model, out)
    print(f"Built in {time.time() - t:.0f}s")
    print(f"  actuarial: {act_src.path.name} [{act_src.sheet}] {act_src.rows:,} rows, as of {act_src.as_of}")
    print(f"  finance:   {fin_src.path.name} [{fin_src.sheet}] {fin_src.rows:,} rows, cutoff {fin_src.as_of}")
    print(f"  policies {len(model.policies):,} | claims {len(model.claims):,} | postings {len(model.postings):,}")
    for w in model.warnings:
        print(f"  ! {w}")
    for k, p in paths.items():
        print(f"  -> {p.relative_to(ROOT) if p.is_relative_to(ROOT) else p}  ({p.stat().st_size / 1e6:.1f} MB)")
    print()
    _print(model.summary(), ["Actuarial", "Finance", "Delta", "Abs delta"])


def cmd_summary(args) -> None:
    df, meta = _load(Path(args.data))
    df = _apply_where(df, args.where)
    _header(meta, len(df), args.where)
    s = recon_summary(df, args.tol).drop(columns="Key").rename(columns={"Policies |d|>tol": f"# |d|>{args.tol:g}"})
    _print(s, ["Actuarial", "Finance", "Delta", "Abs delta"], args.units)
    cov = df["Source"].value_counts()
    print("\nCoverage: " + ", ".join(f"{k}: {v:,}" for k, v in cov.items()))


def cmd_top(args) -> None:
    df, meta = _load(Path(args.data))
    df = _apply_where(df, args.where)
    m = _measure(args.measure)
    df = df[df[delta_col(m)].abs() > args.tol]
    _header(meta, len(df), args.where)
    print(f"{LABELS[m]}: {len(df):,} policies with |delta| > {args.tol:g}, total delta {df[delta_col(m)].sum():,.0f}\n")
    top = df.reindex(df[delta_col(m)].abs().sort_values(ascending=False).index).head(args.n)
    cols = ["Policy", "Source", "UWY", "Reserving LOB", "Branch", "Office"]
    out = top[[c for c in cols if c in top]].copy()
    out["Actuarial"], out["Finance"], out["Delta"] = top[act_col(m)], top[fin_col(m)], top[delta_col(m)]
    _print(out, ["Actuarial", "Finance", "Delta"], args.units)


def cmd_by(args) -> None:
    df, meta = _load(Path(args.data))
    df = _apply_where(df, args.where)
    cols = {c.lower(): c for c in df.columns}
    d = cols.get(args.dim.lower())
    if d is None:
        raise SystemExit(f"Unknown dimension '{args.dim}'. Try: UWY, Source, Reserving LOB, LOB, Branch, Office, Policy Type, ...")
    _header(meta, len(df), args.where)
    key = df[d].astype(str).str.replace(r"\.0$", "", regex=True).replace("nan", "(blank)")
    if args.measure:
        m = _measure(args.measure)
        g = df.groupby(key).agg(
            Policies=("Policy", "size"),
            Actuarial=(act_col(m), "sum"),
            Finance=(fin_col(m), "sum"),
            Delta=(delta_col(m), "sum"),
            AbsDelta=(delta_col(m), lambda s: s.abs().sum()),
            Discrepant=(delta_col(m), lambda s: int((s.abs() > args.tol).sum())),
        )
        g = g.rename(columns={"AbsDelta": "Abs delta", "Discrepant": f"# |d|>{args.tol:g}"})
        money = ["Actuarial", "Finance", "Delta", "Abs delta"]
        print(f"{LABELS[m]} by {d}\n")
    else:
        g = df.groupby(key)[[delta_col(x.key) for x in ALL_RECON]].sum()
        g.columns = [LABELS[c[:-2]] + " d" for c in g.columns]
        g.insert(0, "Policies", df.groupby(key).size())
        money = [c for c in g.columns if c != "Policies"]
        print(f"Delta (actuarial - finance) by {d}\n")
    g = g.reset_index().rename(columns={d: d})
    sort = "Abs delta" if args.measure else d
    g = g.sort_values(sort, ascending=not args.measure)
    _print(g.head(args.n), money, args.units)


def cmd_policy(args) -> None:
    df, meta = _load(Path(args.data))
    hit = df[df["Policy"].str.upper() == args.ref.upper()]
    if hit.empty:
        like = df[df["Policy"].str.contains(args.ref, case=False, regex=False)]["Policy"].head(20).tolist()
        raise SystemExit(f"Policy '{args.ref}' not found." + (f" Did you mean: {', '.join(like)}" if like else ""))
    r = hit.iloc[0]
    print(f"Policy {r['Policy']}  [{r['Source']}]\n")
    skip = {"Policy", "Source"} | {c for c in df.columns if c.endswith(("_A", "_F", "_D")) or c.startswith("F: ")}
    names = {"Claims_N": "# claims", "OpenClaims_N": "# open claims", "GGWP_A": "GWP total (act)"}
    attrs = [(names.get(c, c), r[c]) for c in df.columns if c not in skip and pd.notna(r[c]) and str(r[c]) != ""]
    w = max(len(c) for c, _ in attrs)
    for c, v in attrs:
        print(f"  {c:<{w}}  {str(v).removesuffix('.0')}")
    print()
    rows = [
        {"Measure": m.label, "Actuarial": r[act_col(m.key)], "Finance": r[fin_col(m.key)], "Delta": r[delta_col(m.key)]}
        for m in ALL_RECON
    ]
    _print(pd.DataFrame(rows), ["Actuarial", "Finance", "Delta"])
    claims = pd.read_csv(Path(args.data) / CLAIMS_CSV)
    claims = claims[claims["Policy"] == r["Policy"]]
    if len(claims):
        print(f"\nClaims ({len(claims)})")
        _print(claims.drop(columns="Policy"), ["Paid", "Case Reserves", "Incurred"])
    fin = [(c[3:], r[c]) for c in df.columns if c.startswith("F: ") and pd.notna(r[c]) and abs(r[c]) > 0.005]
    if fin:
        print("\nFinance columns (non-zero)")
        w = max(len(c) for c, _ in fin)
        for c, v in fin:
            print(f"  {c:<{w}}  {v:>18,.2f}")


def cmd_missing(args) -> None:
    df, meta = _load(Path(args.data))
    df = _apply_where(df, args.where)
    df = df[df["Source"] != "Both"]
    _header(meta, len(df), args.where)
    cols = ["Policy", "Source", "UWY", "Reserving LOB", "Branch", "Office"]
    money = [act_col("GPrmB"), fin_col("GPrmB"), act_col("Incurred"), fin_col("Incurred")]
    out = df[[c for c in cols if c in df] + money].rename(
        columns={money[0]: "PrmB Act", money[1]: "PrmB Fin", money[2]: "Inc Act", money[3]: "Inc Fin"}
    )
    out = out.sort_values(["Source", "Policy"])
    _print(out.head(args.n), ["PrmB Act", "PrmB Fin", "Inc Act", "Inc Fin"], args.units)
    if len(out) > args.n:
        print(f"... {len(out) - args.n} more (use -n)")


# ------------------------------------------------------------------ parser
def main(argv: list[str] | None = None) -> None:
    try:
        sys.stdout.reconfigure(encoding="utf-8")
    except Exception:
        pass
    logging.basicConfig(level=logging.INFO, format="%(message)s")
    ap = argparse.ArgumentParser(prog="recon.py", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--data", default=str(ROOT / "data"), help="folder with the built datasets (default: data/)")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="read the Excel sources and write data/")
    b.add_argument("--actuarial", help='actuarial workbook, optionally "file.xlsx#Sheet"')
    b.add_argument("--finance", help='finance production workbook, optionally "file.xlsx#Sheet"')
    b.add_argument("--out", default="data")
    b.set_defaults(func=cmd_build)

    def common(p, measure=False):
        p.add_argument("--where", action="append", default=[], help='filter, e.g. "UWY=2024,2025" or "Branch!=UK"')
        p.add_argument("--tol", type=float, default=1.0, help="tolerance on |delta| (default 1)")
        p.add_argument("--units", choices=["", "k", "m"], default="", help="show amounts in k or m")
        if measure:
            p.add_argument("-m", "--measure", default=None, help="paid, os, prem, pipe, ret, brok, ded, inc")
        p.add_argument("-n", type=int, default=30, help="rows to show")

    s = sub.add_parser("summary", help="summary by measure (the Excel Reconciliation sheet)")
    common(s)
    s.set_defaults(func=cmd_summary)
    t = sub.add_parser("top", help="largest policy-level deltas for one measure")
    common(t, measure=True)
    t.set_defaults(func=cmd_top, measure="paid")
    y = sub.add_parser("by", help="delta by a dimension")
    y.add_argument("dim")
    common(y, measure=True)
    y.set_defaults(func=cmd_by)
    p = sub.add_parser("policy", help="show one policy")
    p.add_argument("ref")
    p.set_defaults(func=cmd_policy)
    mi = sub.add_parser("missing", help="policies present in only one source")
    common(mi)
    mi.set_defaults(func=cmd_missing)

    args = ap.parse_args(argv)
    if args.cmd == "top" and args.measure is None:
        args.measure = "paid"
    args.func(args)


if __name__ == "__main__":
    main()
