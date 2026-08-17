import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execFile = promisify(execFileCallback);
const SHA = /^[a-f0-9]{40,64}$/;
const SAFE_REMOTE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SAFE_BRANCH =
  /^(?!-)(?!.*(?:\.\.|@\{|\\|[~^:?*\s]))(?!.*(?:^|\/)\.)(?!.*\.$)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface GitCommandResult {
  readonly stdout: string;
  readonly stderr: string;
}
export type GitCommandRunner = (
  args: readonly string[],
) => Promise<GitCommandResult>;

export interface TaskPushRequest {
  readonly remote: string;
  readonly expected_repository: string;
  readonly default_branch: string;
  readonly task_branch: string;
  readonly candidate_sha: string;
  readonly base_sha: string;
  readonly protected_branches?: readonly string[];
}

export interface RemoteInspection {
  readonly remote: string;
  readonly remote_url: string;
  readonly identity_verified: true;
  readonly current_branch: string;
  readonly default_branch: string;
  readonly candidate_sha: string;
  readonly base_sha: string;
  readonly remote_task_sha: string | null;
  readonly divergence:
    "UNPUSHED" | "EQUAL" | "FAST_FORWARD" | "REMOTE_DIFFERENT";
}

export interface TaskPushResult extends RemoteInspection {
  readonly status: "PUSHED" | "ALREADY_UP_TO_DATE";
  readonly pushed_sha: string;
}

/** A deliberately narrow adapter: the sole mutation is one exact task-bound ref push. */
export class GitRemoteDeliveryAdapter {
  private readonly runner: GitCommandRunner;

  constructor(repository: string, runner?: GitCommandRunner) {
    const cwd = resolve(repository);
    this.runner =
      runner ??
      (async (args) => {
        const result = await execFile("git", [...args], {
          cwd,
          encoding: "utf8",
          maxBuffer: 2 * 1024 * 1024,
          timeout: 30_000,
          killSignal: "SIGKILL",
          env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            ...(process.env.HOME ? { HOME: process.env.HOME } : {}),
            ...(process.env.SSH_AUTH_SOCK
              ? { SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK }
              : {}),
            LANG: "C",
            LC_ALL: "C",
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_CONFIG_NOSYSTEM: "1",
            GIT_ASKPASS: "/usr/bin/false",
            SSH_ASKPASS: "/usr/bin/false",
            GIT_TERMINAL_PROMPT: "0",
          },
        });
        return { stdout: result.stdout, stderr: result.stderr };
      });
  }

  async inspect(request: TaskPushRequest): Promise<RemoteInspection> {
    validateRequest(request);
    const remoteUrl = (
      await this.run(["remote", "get-url", request.remote])
    ).trim();
    assertNoCredentialUrl(remoteUrl);
    assertNoCredentialUrl(request.expected_repository);
    if (!(await sameRepository(remoteUrl, request.expected_repository)))
      throw new Error("REMOTE_IDENTITY_MISMATCH");
    const candidate = (
      await this.run(["rev-parse", "--verify", "HEAD^{commit}"])
    ).trim();
    if (candidate !== request.candidate_sha)
      throw new Error("CANDIDATE_MISMATCH");
    const currentBranch = (
      await this.run(["symbolic-ref", "--quiet", "--short", "HEAD"])
    ).trim();
    if (currentBranch !== request.task_branch)
      throw new Error("TASK_BRANCH_MISMATCH");
    if ((await this.run(["status", "--porcelain=v1", "-z"])) !== "")
      throw new Error("DELIVERY_WORKTREE_DIRTY");
    const remoteBaseLine = (
      await this.run([
        "ls-remote",
        "--heads",
        request.remote,
        `refs/heads/${request.default_branch}`,
      ])
    ).trim();
    const remoteBaseSha = remoteBaseLine.split(/\s+/)[0] ?? "";
    if (!SHA.test(remoteBaseSha)) throw new Error("REMOTE_BASE_UNKNOWN");
    if (remoteBaseSha !== request.base_sha)
      throw new Error("REMOTE_BASE_STALE");
    try {
      await this.run([
        "merge-base",
        "--is-ancestor",
        request.base_sha,
        request.candidate_sha,
      ]);
    } catch {
      throw new Error("BASE_NOT_ANCESTOR_OF_CANDIDATE");
    }
    const remoteLine = (
      await this.run([
        "ls-remote",
        "--heads",
        request.remote,
        `refs/heads/${request.task_branch}`,
      ])
    ).trim();
    const remoteTaskSha = remoteLine
      ? (remoteLine.split(/\s+/)[0] ?? null)
      : null;
    if (remoteTaskSha !== null && !SHA.test(remoteTaskSha))
      throw new Error("REMOTE_REF_INVALID");
    let divergence: RemoteInspection["divergence"] = "UNPUSHED";
    if (remoteTaskSha === candidate) divergence = "EQUAL";
    else if (remoteTaskSha !== null) {
      try {
        await this.run([
          "merge-base",
          "--is-ancestor",
          remoteTaskSha,
          candidate,
        ]);
        divergence = "FAST_FORWARD";
      } catch {
        divergence = "REMOTE_DIFFERENT";
      }
    }
    return Object.freeze({
      remote: request.remote,
      remote_url: remoteUrl,
      identity_verified: true,
      current_branch: currentBranch,
      default_branch: request.default_branch,
      candidate_sha: candidate,
      base_sha: request.base_sha,
      remote_task_sha: remoteTaskSha,
      divergence,
    });
  }

  async pushTaskBranch(request: TaskPushRequest): Promise<TaskPushResult> {
    const inspection = await this.inspect(request);
    if (inspection.divergence === "EQUAL")
      return Object.freeze({
        ...inspection,
        status: "ALREADY_UP_TO_DATE",
        pushed_sha: inspection.candidate_sha,
      });
    if (inspection.divergence === "REMOTE_DIFFERENT")
      throw new Error("REMOTE_TASK_BRANCH_DIVERGED");
    await this.run([
      "push",
      "--porcelain",
      request.remote,
      `${request.candidate_sha}:refs/heads/${request.task_branch}`,
    ]);
    const postPushLine = (
      await this.run([
        "ls-remote",
        "--heads",
        request.remote,
        `refs/heads/${request.task_branch}`,
      ])
    ).trim();
    if ((postPushLine.split(/\s+/)[0] ?? "") !== request.candidate_sha)
      throw new Error("POST_PUSH_REF_MISMATCH");
    return Object.freeze({
      ...inspection,
      status: "PUSHED",
      pushed_sha: inspection.candidate_sha,
    });
  }

  private async run(args: readonly string[]): Promise<string> {
    const result = await this.runner(Object.freeze([...args]));
    return result.stdout;
  }
}

function validateRequest(request: TaskPushRequest): void {
  if (!SAFE_REMOTE.test(request.remote)) throw new Error("INVALID_REMOTE_NAME");
  if (
    !SAFE_BRANCH.test(request.default_branch) ||
    !SAFE_BRANCH.test(request.task_branch)
  )
    throw new Error("INVALID_TASK_BRANCH");
  if (request.task_branch === request.default_branch)
    throw new Error("DEFAULT_BRANCH_PUSH_PROHIBITED");
  if (request.protected_branches?.includes(request.task_branch))
    throw new Error("PROTECTED_BRANCH_PUSH_PROHIBITED");
  for (const branch of request.protected_branches ?? [])
    if (!SAFE_BRANCH.test(branch)) throw new Error("INVALID_PROTECTED_BRANCH");
  if (!SHA.test(request.candidate_sha))
    throw new Error("INVALID_CANDIDATE_SHA");
  if (!SHA.test(request.base_sha)) throw new Error("INVALID_BASE_SHA");
  if (!request.expected_repository.trim())
    throw new Error("EXPECTED_REPOSITORY_REQUIRED");
}

function assertNoCredentialUrl(value: string): void {
  const scp = value.trim().match(/^([^@/:]+)@[^:]+:/);
  if (scp && scp[1] !== "git")
    throw new Error("REMOTE_CREDENTIAL_URL_PROHIBITED");
  try {
    const url = new URL(value);
    if (url.password || (url.username && url.username !== "git"))
      throw new Error("REMOTE_CREDENTIAL_URL_PROHIBITED");
  } catch (error) {
    if ((error as Error).message === "REMOTE_CREDENTIAL_URL_PROHIBITED")
      throw error;
  }
}

async function sameRepository(
  actual: string,
  expected: string,
): Promise<boolean> {
  return (
    (await repositoryIdentity(actual)) === (await repositoryIdentity(expected))
  );
}

async function repositoryIdentity(value: string): Promise<string> {
  const trimmed = value.trim().replace(/\/$/, "");
  const scp = trimmed.match(/^git@([^:]+):(.+)$/);
  if (scp) return `${scp[1]!.toLowerCase()}/${stripGit(scp[2]!)}`;
  try {
    const url = new URL(trimmed);
    if (url.protocol === "https:" || url.protocol === "ssh:")
      return `${url.hostname.toLowerCase()}/${stripGit(url.pathname.replace(/^\//, ""))}`;
  } catch {
    /* Local filesystem remote. */
  }
  try {
    return await realpath(resolve(trimmed));
  } catch {
    return resolve(trimmed);
  }
}

function stripGit(path: string): string {
  return path.replace(/\.git$/i, "").toLowerCase();
}
