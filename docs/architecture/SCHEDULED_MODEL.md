# Scheduled operating model

Schedules are deployment configuration, never hardcoded kernel time. Default templates use project timezone: weekday Daily PM at 08:00; hourly Coordinator cycles from 08:30 through 22:30; End-of-Day report at 19:15.

Prompts remain small and invoke repository-managed contracts. Leases and idempotency prevent overlapping runs. Human notifications are limited to PR_READY, DECISION_REQUIRED, and AUTOMATION_FAILED; cycle noise is summarized in the end-of-day report.
