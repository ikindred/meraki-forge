import { createHash } from "node:crypto";
import { z } from "zod";

const sha = z.string().regex(/^[a-f0-9]{40,64}$/);

export const TaskLeaseSchema = z
  .object({
    schema_version: z.literal("1"),
    task_id: z.string().min(1),
    lease_id: z.string().min(1),
    owner: z.string().min(1),
    started_at: z.string().datetime(),
    heartbeat_at: z.string().datetime(),
    updated_at: z.string().datetime(),
    lease_until: z.string().datetime(),
    branch: z.string().min(1),
    worktree: z.string().min(1),
    base_commit: sha,
    current_commit: sha,
    revision: z.number().int().nonnegative(),
  })
  .readonly();
export type TaskLease = z.infer<typeof TaskLeaseSchema>;

interface ClaimInput {
  readonly task_id: string;
  readonly status: string;
  readonly authorized: boolean;
  readonly owner: string;
  readonly now: string;
  readonly lease_until: string;
  readonly branch: string;
  readonly worktree: string;
  readonly base_commit: string;
  readonly current_commit: string;
  readonly revision: number;
  readonly existing?: TaskLease;
}

function timestamp(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error("Invalid lease timestamp");
  return parsed;
}

function leaseId(input: ClaimInput): string {
  return `LEASE-${createHash("sha256").update(`${input.task_id}:${input.owner}:${input.now}`).digest("hex").slice(0, 20)}`;
}

export function claimLease(input: ClaimInput): TaskLease {
  if (input.existing) {
    if (timestamp(input.existing.lease_until) > timestamp(input.now))
      throw new Error("Cannot claim task with active lease");
    throw new Error("Stale lease requires explicit takeover");
  }
  if (input.status !== "READY" || !input.authorized)
    throw new Error("Only READY authorized tasks may be claimed");
  if (timestamp(input.lease_until) <= timestamp(input.now))
    throw new Error("Lease must expire after claim time");
  return TaskLeaseSchema.parse({
    schema_version: "1",
    task_id: input.task_id,
    lease_id: leaseId(input),
    owner: input.owner,
    started_at: input.now,
    heartbeat_at: input.now,
    updated_at: input.now,
    lease_until: input.lease_until,
    branch: input.branch,
    worktree: input.worktree,
    base_commit: input.base_commit,
    current_commit: input.current_commit,
    revision: input.revision,
  });
}

export function heartbeatLease(
  lease: TaskLease,
  leaseIdValue: string,
  owner: string,
  now: string,
  leaseUntil: string,
  expectedRevision: number,
): TaskLease {
  if (lease.lease_id !== leaseIdValue || lease.owner !== owner)
    throw new Error("Lease identity mismatch");
  if (lease.revision !== expectedRevision)
    throw new Error("Lease revision conflict");
  if (timestamp(now) > timestamp(lease.lease_until))
    throw new Error("Cannot heartbeat an expired lease");
  if (timestamp(leaseUntil) <= timestamp(now))
    throw new Error("Heartbeat must extend into the future");
  return TaskLeaseSchema.parse({
    ...lease,
    heartbeat_at: now,
    updated_at: now,
    lease_until: leaseUntil,
    revision: lease.revision + 1,
  });
}

interface TakeoverInput {
  readonly owner: string;
  readonly now: string;
  readonly lease_until: string;
  readonly expected_revision: number;
}

export function takeOverStaleLease(
  lease: TaskLease,
  input: TakeoverInput,
): TaskLease {
  if (lease.revision !== input.expected_revision)
    throw new Error("Lease revision conflict");
  if (timestamp(lease.lease_until) > timestamp(input.now))
    throw new Error("Active lease cannot be taken over");
  if (timestamp(input.lease_until) <= timestamp(input.now))
    throw new Error("Lease must expire after takeover time");
  return TaskLeaseSchema.parse({
    ...lease,
    lease_id: `LEASE-${createHash("sha256").update(`${lease.task_id}:${input.owner}:${input.now}`).digest("hex").slice(0, 20)}`,
    owner: input.owner,
    started_at: input.now,
    heartbeat_at: input.now,
    updated_at: input.now,
    lease_until: input.lease_until,
    revision: lease.revision + 1,
  });
}
