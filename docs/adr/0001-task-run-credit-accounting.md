# Task Run Credit Accounting

Task Run credit accounting uses a debit/refund model instead of credit reservations or final cost reconciliation fields. A Task Run stores one immutable `creditCost`, receives a Task Run Debit only when it is ready to move to `QUEUED`, may receive a full Task Run Refund only for queued cancellation or explicitly refundable failure, and may receive an optional Task Run Cost Adjustment debit for LLM overage. This keeps Task Run lifecycle state simple, avoids reservation semantics in the UI, and records all post-settlement variance in the credit ledger.
