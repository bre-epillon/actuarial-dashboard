# Actuarial data explorer

Lightweight replacement for the Excel `DataReconciliation` workbook and for ad-hoc
pivoting of the reserving inputs.

* **`recon.py`** - reads the two Excel sources, rebuilds the policy-level
  reconciliation (same logic as the `Policy level` sheet) and lets you query the
  discrepancies from the terminal.
* **`dashboard.html`** - single-file browser app (no install, no internet needed):
  reconciliation dashboard + fast filter / group-by / pivot over policies, claims
  and individual postings.

Data never goes into git: the Excel inputs (`inputs/`, `*.xlsx`) and everything the
build produces (`data/`) are ignored.

## Setup

```bash
pip install -r requirements.txt
```

## 1. Build the datasets

Put the source workbooks in `inputs/`, point `sources.json` at them, then:

```bash
python recon.py build
```

`sources.json` uses `"file.xlsx#Sheet"`; the sheet is optional (it is auto-detected).

| Source | Default | What is read |
|---|---|---|
| actuarial | `inputs/data_202609.xlsx#Input Data` | long table: `PolicyReference`, `ClaimReference`, `Measure`, `value`, UWY, dev periods... |
| finance | `inputs/DataReconciliation_202609_v3.xlsx#ProdReport` | production report, one row per policy (`Total Data` layout) |

The finance sheet can be either the production report's **Total Data** sheet or the
**ProdReport** copy inside the reconciliation workbook: columns are matched by
header name, not letter. Override on the command line without editing the file:

```bash
python recon.py build --finance "inputs/Q2-2026 Production Report V1.xlsx#Total Data"
```

The build warns when the actuarial audit date and the finance cutoff differ
(e.g. 2026-09-30 actuarial vs a Q2 production file at 2026-06-30).

Outputs in `data/` (~25 s for a full quarter):

| File | Content |
|---|---|
| `dashboard_data.js` | data bundle loaded by `dashboard.html` |
| `recon_policy_level.csv` | one row per policy: attributes, Actuarial / Finance / Delta per measure, all finance columns |
| `recon_summary.csv` | the summary table of the Excel `Reconciliation` sheet |
| `claims.csv` | one row per (policy, claim): paid, case reserves, incurred, type, status |
| `meta.json` | sources, cut-off dates, warnings, measure mapping |

## 2. Dashboard

Open `dashboard.html` in Edge or Chrome (double-click works; it loads
`data/dashboard_data.js` next to it).

* **Reconciliation** - the Excel summary (Actuarial, Finance, Delta per measure),
  Delta by any dimension, coverage (policies in one source only) and the list of
  discrepant policies, sorted by |Delta|. Click a measure to focus on it; set the
  tolerance in the top bar.
* **Policies / Claims / Postings** - pivot-style explorer:
  * *Aggregate*: group by any dimensions, optionally spread one dimension
    across columns (with a cumulative option for triangles), choose values
    (amounts, Act/Fin/Delta, counts, distinct policies / claims).
  * *List rows*: plain table of the filtered rows.
  * Click a group value to drill down, click a policy anywhere to open its card
    (reconciliation, attributes from both sources, claims, postings by period,
    non-zero finance columns).
  * Ready-made views (`Views`): reconciliation by reserving LOB, paid / incurred /
    GWP triangles (UWY x dev year), large claims, open claims...
* Left panel: free-text search (policy, claim, reinsured, broker), filters on any
  dimension with live counts (include or exclude), amount filters
  (e.g. `|Case Reserves Delta| > 1000`). Filters apply to every tab.
* `CSV` downloads the current table; `Back` (Alt+Left) undoes the last change;
  `/` jumps to search. The layout is remembered in the browser.

## 3. Command line

```bash
python recon.py summary                       # the Excel Reconciliation table
python recon.py summary --where "UWY=2024,2025" --units m
python recon.py top -m os -n 20               # largest Case Reserves deltas
python recon.py by "Reserving LOB" -m prem    # Premiums Booked delta by reserving LOB
python recon.py by Office                     # delta of every measure by office
python recon.py policy <POLICY_REF>           # full card of one policy
python recon.py missing                       # policies present in one source only
```

Measures: `paid`, `os`, `prem`, `pipe`, `ret`, `brok`, `ded`, `inc` (incurred).
`--where` accepts any column of `recon_policy_level.csv`
(`"Branch!=DUBAI"`, `"Source=Actuarial only"`); `--tol` sets the discrepancy
threshold (default 1).

## Reconciliation mapping

Defined once in [`actdash/mapping.py`](actdash/mapping.py) (Delta = Actuarial - Finance):

| Measure | Actuarial (`Measure` codes) | Finance columns |
|---|---|---|
| Claims Paid | GClmP | Total Paid Claims |
| Case Reserves | GClmO | Total Outstanding Claims |
| Premiums Booked | GPrmB | Gross Premium + PREMIUM PORTFOLIO IN |
| Pipeline Premiums | GGWP - GPrmB - GPrmR | Pipeline Premium |
| Return Premiums | GPrmR | none |
| Brokerage | GBrok | Brokerage + Pipeline Brokerage |
| Deductibles | GDed | Commission ... Withholding Tax + Pipeline Commission ... Pipeline Tax on Premium (excl. MGA commission) |
| Incurred (derived) | GClmP + GClmO | Total Paid Claims + Total Outstanding Claims |

On the 2026-09 data this reproduces the Excel `Policy level` sheet exactly for
every policy and measure. The Excel formulas also add a few `ProdReport` columns
that have no header; they are all zero, and the build warns if an unnamed finance
column ever carries an amount.

## Layout

```
recon.py            CLI entry point
actdash/mapping.py  measure definitions and finance column mapping
actdash/loaders.py  Excel readers (sheet / header auto-detection)
actdash/model.py    policy, claim and posting tables + reconciliation
actdash/export.py   CSV outputs and the dashboard data bundle
actdash/cli.py      commands
dashboard.html      the browser app
sources.json        default input files
```
