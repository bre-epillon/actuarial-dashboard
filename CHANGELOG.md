# Changelog

## Unreleased

- **GGWP dashboard** (`ggwp.html`, started with `ggwp.bat`): written premium before / after commissions (expected GGWP / GNWP share, USD) by underwriting year, month and class of business, read from the most recent **Underwriting Report (Production)** workbook in `inputs/ggwp-pyramid`; refreshes by itself when a newer file appears.
- `serve.py`: small local server used by the GGWP dashboard (reads the workbook with openpyxl, no other dependency).
- **Navigation**: browser Back / Forward now step through the views you visited (scope, policy, filters); the address bar holds the current scope, so a view can be bookmarked or shared; a *Back to previous view* button on the Overview. A bare `explorer.html` always opens on the whole portfolio.

## v0.1.0 - 2026-11-06

First shared version.

- **Reconciliation tool** (`reconciliation.html`): actuarial vs finance at policy level - summary by
  measure, delta by any dimension, coverage, discrepant policies, policy pivot, policy card.
  Reproduces the `Policy level` sheet of the Excel reconciliation exactly.
- **Explorer** (`explorer.html`): search a policy, claim, broker or reinsured and scope everything to it;
  premium booking (written / booked / pipeline) and claim development (incurred / paid / case reserves)
  over time against the finance totals; pivots over policies, claims and postings.
- **CLI** (`recon.py`): `build`, `summary`, `top`, `by`, `policy`, `missing`.
- **`build.bat`**: one-click build for Windows.
