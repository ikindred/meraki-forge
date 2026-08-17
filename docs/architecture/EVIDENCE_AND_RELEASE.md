# Evidence and PR delivery

Gate statuses are PASS, FAIL, NOT_APPLICABLE, and SKIPPED. SKIPPED is never PASS; NOT_APPLICABLE requires an evidence-backed applicability decision. Gate plans are frozen in the execution manifest. Discovered impact may add gates but cannot silently remove them.

Evidence maps acceptance criterion IDs to evidence IDs. Each evidence item records kind, path/URL, SHA-256 digest, tool, result, timestamp, and candidate commit. UI impact normally requires E2E, responsive screenshots, video, accessibility, QA, and review. Backend requires behavior tests; database requires migration/integrity/rollback evidence; auth requires security and negative access tests.

PR eligibility fails closed unless the exact manifest revision and candidate SHA match, ownership is clean, all required gates pass, every acceptance criterion has passing evidence, no blocker/finding/conflict remains, and summary/limitations are documented. Any production edit invalidates affected proof.

The Release Agent receives a commit-bound eligibility token and may package commits, push the feature branch, create one idempotent PR, and update task projection to REVIEW. It cannot edit implementation, merge, or deploy. The PR must end with human choices: Merge, Request Changes, Reject.
