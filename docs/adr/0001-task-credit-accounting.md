# Task Credit Accounting

Task credit accounting uses a debit/refund model instead of credit reservations or final cost reconciliation fields. A Task stores one immutable `creditCost`, receives a Task Debit only when it is ready to move to `QUEUED`, may receive a full Task Refund only for queued cancellation or explicitly refundable failure, and may receive an optional Task Cost Adjustment debit for LLM overage. This keeps Task lifecycle state simple, avoids reservation semantics in the UI, and records all post-settlement variance in the credit ledger.
