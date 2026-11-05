# Actuarial data explorer

Lightweight replacement for the Excel `DataReconciliation` workbook and for ad-hoc
pivoting of the reserving inputs.

* **`recon.py`** - reads the two Excel sources, rebuilds the policy-level
  reconciliation (same logic as the `Policy level` sheet) and lets you query the
  discrepancies from the terminal.
* **`reconciliation.html`** - browser tool 1: actuarial vs finance. Discrepancies by
  measure, dimension and policy.
* **`explorer.html`** - browser tool 2: search any policy, claim, broker or reinsured and
  see premium booking and claim development over time; pivot over policies, claims
  and postings.

Both are single-folder static pages (no install, no internet needed).

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
| `recon_data.js` | data of `reconciliation.html`: policies, Actuarial / Finance / Delta, all finance columns |
| `explorer_data.js` | data of `explorer.html`: policies, claims, individual postings |
| `recon_policy_level.csv` | one row per policy: attributes, Actuarial / Finance / Delta per measure, all finance columns |
| `recon_summary.csv` | the summary table of the Excel `Reconciliation` sheet |
| `claims.csv` | one row per (policy, claim): paid, case reserves, incurred, type, status |
| `meta.json` | sources, cut-off dates, warnings, measure mapping |

## 2. Reconciliation tool (`reconciliation.html`)

Open it in Edge or Chrome (double-click works; it loads `data/recon_data.js`).

* **Reconciliation** - the Excel summary (Actuarial, Finance, Delta per measure),
  Delta by any dimension, coverage (policies in one source only) and the list of
  discrepant policies, sorted by |Delta|. Click a measure to focus on it; set the
  tolerance in the top bar.
* **Policies** - pivot over the policy level with Actuarial / Finance / Delta values:
  group by any dimensions, spread one across columns, filter like in Excel but fast.
  Ready-made views (`Views`): reconciliation by reserving LOB or broker, incurred by UWY...
* A policy opens a card (reconciliation per measure, attributes from both sources,
  every non-zero finance column) with a link to the same policy in the Explorer.
* Left panel: free-text search, filters with live counts (include or exclude) and
  amount filters (e.g. `|Case Reserves Delta| > 1000`).

## 3. Explorer (`explorer.html`)

Open it in Edge or Chrome (it loads `data/explorer_data.js`).

* **Search bar (top, `/` to focus)** - type any string: matching policies, claims,
  brokers, reinsureds and original insureds appear immediately; pick one (click, or
  arrows + Enter) to scope everything to it. The tables are also filtered live by the text.
* **Overview** - for the current scope (whole portfolio, a policy, a claim, a broker...):
  * KPIs: written, booked and pipeline premium, paid, case reserves, incurred, each with the finance figure.
  * **Premium booking over time**: written (`GGWP`), booked (`GPrmB`) and pipeline
    (`GGWP - GPrmB - GPrmR`) from the actuarial postings, against the finance
    *booked*, *pipeline* and *booked + pipeline* totals (dashed lines).
  * **Claim development over time**: incurred, paid (`GClmP`) and case reserves
    (`GClmO`) against the finance paid / outstanding totals.
  * Time axis: month, quarter, year or development year since UWY; cumulative on/off;
    hover for values; `Table` shows the numbers behind each chart.
  * Largest policies and claims in scope; click one to scope to it.
  * Losses are shown as positive amounts here; the finance file has no time dimension, so it is drawn as totals.
* **Policies / Claims / Postings** - pivot-style explorer: *Aggregate* (group by any
  dimensions, optionally spread one across columns with a cumulative option for
  triangles) or *List rows*; click a group to drill down, a policy or claim to open it in
  the Overview. Ready-made views (`Views`): paid / incurred / GWP triangles, broker
  league table, large claims, open claims...
* Left panel: filters on any dimension with live counts and amount filters; they apply
  to every tab. `CSV` downloads the current table; `Back` (Alt+Left) undoes the last
  change; the layout is remembered in the browser.
* Deep links: `explorer.html#policy=<ref>`, `#broker=<name>`, `#reinsured=<name>`, `#q=<text>`.

## 4. Command line

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
actdash/export.py   CSV outputs and the two data bundles
actdash/cli.py      commands
reconciliation.html browser tool 1: actuarial vs finance
explorer.html       browser tool 2: search, charts, pivots
web/core.js|css     shared code: data decoding, filters, aggregation, grid, pivot
web/recon.js        reconciliation tool
web/explorer.js     explorer tool (search, overview)
web/charts.js       line chart used by the explorer
sources.json        default input files
```
