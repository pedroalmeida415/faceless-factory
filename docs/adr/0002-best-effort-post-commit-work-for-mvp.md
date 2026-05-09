# Best-Effort Post-Commit Work For MVP

Accepted. During the MVP, runtime **Post-Commit Work** is delivered inline after the database transaction commits with short task-level retries, but it is not recorded in a durable outbox and exhausted delivery failures are logged/metriced rather than returned to callers. This deliberately accepts manual recovery from rare Redis/BullMQ delivery misses so the runtime can keep its Task state durable without adding outbox schema, processors, retention, and dead-letter handling before production hardening.
