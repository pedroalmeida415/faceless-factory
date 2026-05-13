# Task Credit Accounting

Task credit accounting uses a debit/refund model instead of credit reservations or final cost reconciliation fields. A Task stores one immutable `creditCost`, receives a Task Debit only when it is ready to move to `QUEUED`, and may receive a full Task Refund only for queued cancellation or explicitly refundable failure. LLM Tasks use a fixed quoted credit cost for this MVP; provider usage overage does not create post-settlement debits. This keeps Task lifecycle state simple and avoids reservation or reconciliation semantics in the UI.
