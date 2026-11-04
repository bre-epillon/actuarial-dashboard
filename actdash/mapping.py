"""Reconciliation mapping between the actuarial data and the finance production file.

This is the single place that encodes the logic of the Excel "Policy level" sheet
(DataReconciliation workbook). Finance columns are matched by *header name*, not by
column letter, so the same mapping works for both the production report's
"Total Data" sheet and the "ProdReport" copy inside the reconciliation workbook
(their column letters differ).

Note: the Excel sheet also adds a few ProdReport columns that have no header
(AB, AC, AD, AG, AH). They cannot be matched by name; the build warns if any
unnamed finance column carries a non-zero total, so nothing goes missing silently.
"""

from __future__ import annotations

from dataclasses import dataclass, field

# Canonical actuarial measure codes (the "Measure" column of the actuarial data).
ACTUARIAL_MEASURES = {
    "GCLMP": "GClmP",  # claims paid
    "GCLMO": "GClmO",  # case reserves (outstanding) movements
    "GPRMB": "GPrmB",  # premiums booked
    "GGWP": "GGWP",  # gross written premium = booked + pipeline + returned
    "GPRMR": "GPrmR",  # return / reinstatement premiums
    "GBROK": "GBrok",  # brokerage
    "GDED": "GDed",  # deductions (commission, taxes, charges, ...)
}

ACTUARIAL_LABELS = {
    "GClmP": "Claims Paid",
    "GClmO": "Case Reserves",
    "GPrmB": "Premiums Booked",
    "GGWP": "GWP (total)",
    "GPrmR": "Return Premiums",
    "GBrok": "Brokerage",
    "GDed": "Deductibles",
}


@dataclass(frozen=True)
class ReconMeasure:
    key: str
    label: str
    # actuarial measure code -> sign (the actuarial figure is a signed sum of measures)
    actuarial: dict[str, int]
    # finance header names summed together
    finance: tuple[str, ...] = field(default_factory=tuple)
    note: str = ""


RECON_MEASURES: list[ReconMeasure] = [
    ReconMeasure("GClmP", "Claims Paid", {"GClmP": 1}, ("Total Paid Claims",)),
    ReconMeasure("GClmO", "Case Reserves", {"GClmO": 1}, ("Total Outstanding Claims",)),
    ReconMeasure(
        "GPrmB",
        "Premiums Booked",
        {"GPrmB": 1},
        ("Gross Premium (BASE CCY)", "PREMIUM PORTFOLIO IN"),
    ),
    ReconMeasure(
        "Pipeline",
        "Pipeline Premiums",
        {"GGWP": 1, "GPrmB": -1, "GPrmR": -1},
        ("Pipeline Premium (BASE CCY)",),
        note="Actuarial = GGWP - GPrmB - GPrmR",
    ),
    ReconMeasure(
        "GPrmR",
        "Return Premiums",
        {"GPrmR": 1},
        (),
        note="No named finance column (Excel used two blank ProdReport columns, both zero)",
    ),
    ReconMeasure(
        "GBrok",
        "Brokerage",
        {"GBrok": 1},
        ("Brokerage (BASE CCY)", "Pipeline Brokerage (BASE CCY)"),
        note="Not impacting ultimates",
    ),
    ReconMeasure(
        "GDed",
        "Deductibles",
        {"GDed": 1},
        (
            "Commission (BASE CCY)",
            "Low Claims Bonus (BASE CCY)",
            "Management Expenses (BASE CCY)",
            "No Claim Bonus (BASE CCY)",
            "Continuity Credit (BASE CCY)",
            "Eng Fees (BASE CCY)",
            "Other Charges (BASE CCY)",
            "Overriding Commission (BASE CCY)",
            "Package Credit (BASE CCY)",
            "Profit Commission (BASE CCY)",
            "Prompt Pay Discount (BASE CCY)",
            "Renewal Incentive Bonus (BASE CCY)",
            "Sliding Scale Commission (BASE CCY)",
            "Tax on Premium (BASE CCY)",
            "Withholding Tax (BASE CCY)",
            "Pipeline Commission (BASE CCY)",
            "Pipeline Other Charges (BASE CCY)",
            "Pipeline Overrider (BASE CCY)",
            "Pipeline Sliding Scale Commission (BASE CCY)",
            "Pipeline Tax on Premium (BASE CCY)",
        ),
        note="Excludes MGA commission columns. Not impacting ultimates",
    ),
]

# Derived measure shown alongside the reconciled ones (not in the Excel summary).
INCURRED = ReconMeasure("Incurred", "Incurred (Paid + OS)", {"GClmP": 1, "GClmO": 1}, ())

# Aliases accepted by the CLI (-m/--measure).
MEASURE_ALIASES = {
    "paid": "GClmP",
    "gclmp": "GClmP",
    "os": "GClmO",
    "reserves": "GClmO",
    "gclmo": "GClmO",
    "prem": "GPrmB",
    "booked": "GPrmB",
    "gprmb": "GPrmB",
    "pipe": "Pipeline",
    "pipeline": "Pipeline",
    "ret": "GPrmR",
    "return": "GPrmR",
    "gprmr": "GPrmR",
    "brok": "GBrok",
    "gbrok": "GBrok",
    "ded": "GDed",
    "gded": "GDed",
    "inc": "Incurred",
    "incurred": "Incurred",
}

# Candidate header names for the policy reference column in finance extracts.
FINANCE_POLICY_HEADERS = ("policy reference", "risk_reference", "policyreference", "risk reference")

# Finance text attributes kept for filtering / display: header -> display label.
FINANCE_ATTRIBUTES = {
    "Office": "Office",
    "Line of Business": "Fin Line of Business",
    "PolicyType": "Policy Type",
    "Prop Indicator": "Prop Indicator",
    "UW": "Underwriter",
    "Reinsured": "Reinsured",
    "Reinsured Country": "Reinsured Country",
    "Risk Country": "Risk Country",
    "BrokerName": "Broker",
    "BrokerLocation": "Broker Location",
    "Method of placement": "Placement",
    "Original Currency": "Currency",
    "Profit center name": "Profit Center",
    "CostCenter": "Cost Center",
    "In force": "In Force",
    "Risk Description": "Risk Description",
    "Original Insured": "Original Insured",
    "Policy VF": "Policy Valid From",
    "Policy VT": "Policy Valid To",
}

# Finance numeric columns that are not additive amounts.
FINANCE_NON_AMOUNTS = {"MONTH", "YEAR", "In force", "Earned", "Limit", "Cutoff"}

# Actuarial policy attributes: source column -> display label.
ACTUARIAL_ATTRIBUTES = {
    "Branch": "Branch",
    "LOB": "LOB",
    "Final LOB": "Reserving LOB",
    "Status": "Status",
    "UWQ": "UWQ",
    "CPD_VALID_FROM": "Inception",
    "Duration": "Duration (m)",
    "Comment": "Act Comment",
}
