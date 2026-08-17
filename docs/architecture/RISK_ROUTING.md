# Risk and task routing

Risk rules are deterministic and evidence-bearing; maximum matched severity wins. Priority never lowers risk.

- LOW: copy or isolated presentation changes; autonomous when configured.
- MEDIUM: normal features, APIs, business logic, non-destructive migration; autonomous with computed gates.
- HIGH: auth/authorization, sensitive data, infrastructure, large schema/blast radius; autonomous PR only when the project explicitly allows HIGH and mandatory security/impact gates exist.
- CRITICAL: destructive production data/infrastructure, secret mutation, destructive billing/payment, security bypass; disposition DISCUSS, no implementation or external mutation.

Router output is declarative: disposition, domains/owners, dependencies, roles, gates, evidence policy, and reason codes. It cannot dispatch or mutate state. Missing ownership blocks; it never falls back to a generalist.
