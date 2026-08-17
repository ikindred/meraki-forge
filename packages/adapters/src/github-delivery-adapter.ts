const SHA = /^[a-f0-9]{40,64}$/;
const SAFE_REPOSITORY_PART = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const SAFE_HOST =
  /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/;
const SAFE_NAME =
  /^(?!-)(?!.*(?:\.\.|@\{|\\|[~^:?*\s]))(?!.*(?:^|\/)\.)(?!.*\.$)(?!.*\.lock(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

export interface GitHubAuthStatus {
  readonly authenticated: boolean;
  readonly login?: string;
}
export interface GitHubRepositoryIdentity {
  readonly owner: string;
  readonly name: string;
}
export interface GitHubPullRequest {
  readonly number: number;
  readonly url: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly head: string;
  readonly head_sha: string;
  readonly base: string;
  readonly body: string;
  readonly state: "OPEN" | "CLOSED";
}
export interface GitHubDeliveryClient {
  authStatus(): Promise<GitHubAuthStatus>;
  repository(): Promise<GitHubRepositoryIdentity>;
  findOpenPullRequests(input: {
    readonly head: string;
    readonly base: string;
  }): Promise<readonly GitHubPullRequest[]>;
  createPullRequest(input: {
    readonly title: string;
    readonly head: string;
    readonly base: string;
    readonly body: string;
  }): Promise<GitHubPullRequest>;
  updatePullRequestBody(
    number: number,
    body: string,
  ): Promise<GitHubPullRequest>;
}
export interface GitHubDeliveryRequest {
  readonly expected_repository: GitHubRepositoryIdentity;
  readonly task_id: string;
  readonly head_branch: string;
  readonly base_branch: string;
  readonly candidate_sha: string;
  readonly title: string;
  readonly forge_body: string;
  readonly github_host?: string;
}
export interface GitHubDeliveryResult {
  readonly action: "CREATED" | "UPDATED" | "REUSED";
  readonly number: number;
  readonly url: string;
  readonly repository: GitHubRepositoryIdentity;
  readonly head: string;
  readonly head_sha: string;
  readonly base: string;
  readonly candidate_sha: string;
  readonly body: string;
}

/** Phase-4-only GitHub surface. The client intentionally has no merge/admin/deploy methods. */
export class GitHubDeliveryAdapter {
  constructor(private readonly client: GitHubDeliveryClient) {}

  async deliver(request: GitHubDeliveryRequest): Promise<GitHubDeliveryResult> {
    validateRequest(request);
    const auth = await this.client.authStatus();
    if (!auth.authenticated || !auth.login)
      throw new Error("GITHUB_AUTH_REQUIRED");
    const repository = await this.client.repository();
    if (!sameIdentity(repository, request.expected_repository))
      throw new Error("GITHUB_REPOSITORY_MISMATCH");
    const existing = await this.client.findOpenPullRequests({
      head: request.head_branch,
      base: request.base_branch,
    });
    if (existing.length > 1) throw new Error("DUPLICATE_TASK_PULL_REQUESTS");
    const section = forgeSection(request);
    const pull = existing[0];
    if (!pull) {
      const created = await this.client.createPullRequest({
        title: request.title,
        head: request.head_branch,
        base: request.base_branch,
        body: section,
      });
      return result(
        "CREATED",
        assertPull(created, request),
        request.candidate_sha,
      );
    }
    assertPull(pull, request);
    if (pull.head !== request.head_branch || pull.base !== request.base_branch)
      throw new Error("PULL_REQUEST_IDENTITY_MISMATCH");
    if (!pull.body.includes(`<!-- FORGE:BEGIN ${request.task_id} -->`))
      throw new Error("EXISTING_PR_NOT_FORGE_OWNED");
    const nextBody = replaceForgeSection(pull.body, request.task_id, section);
    if (nextBody === pull.body)
      return result("REUSED", pull, request.candidate_sha);
    const updated = await this.client.updatePullRequestBody(
      pull.number,
      nextBody,
    );
    return result(
      "UPDATED",
      assertPull(updated, request),
      request.candidate_sha,
    );
  }
}

function validateRequest(request: GitHubDeliveryRequest): void {
  if (
    !SAFE_NAME.test(request.task_id) ||
    !SAFE_NAME.test(request.head_branch) ||
    !SAFE_NAME.test(request.base_branch)
  )
    throw new Error("INVALID_DELIVERY_IDENTITY");
  if (
    !SAFE_REPOSITORY_PART.test(request.expected_repository.owner) ||
    !SAFE_REPOSITORY_PART.test(request.expected_repository.name) ||
    !SAFE_HOST.test(request.github_host ?? "github.com")
  )
    throw new Error("INVALID_GITHUB_REPOSITORY");
  if (request.head_branch === request.base_branch)
    throw new Error("DEFAULT_BRANCH_PR_PROHIBITED");
  if (!SHA.test(request.candidate_sha))
    throw new Error("INVALID_CANDIDATE_SHA");
  if (!request.title.trim() || !request.forge_body.trim())
    throw new Error("PR_CONTENT_REQUIRED");
}

function forgeSection(request: GitHubDeliveryRequest): string {
  return `<!-- FORGE:BEGIN ${request.task_id} -->\n<!-- candidate:${request.candidate_sha} -->\n${request.forge_body.trim()}\n<!-- FORGE:END ${request.task_id} -->`;
}

function replaceForgeSection(
  body: string,
  taskId: string,
  replacement: string,
): string {
  const begin = `<!-- FORGE:BEGIN ${taskId} -->`;
  const end = `<!-- FORGE:END ${taskId} -->`;
  const start = body.indexOf(begin);
  const finish = body.indexOf(end);
  if (start === -1 && finish === -1)
    return `${body.trimEnd()}${body ? "\n\n" : ""}${replacement}`;
  if (
    start === -1 ||
    finish < start ||
    body.indexOf(begin, start + begin.length) !== -1 ||
    body.indexOf(end, finish + end.length) !== -1
  )
    throw new Error("FORGE_PR_SECTION_AMBIGUOUS");
  return `${body.slice(0, start)}${replacement}${body.slice(finish + end.length)}`;
}

function sameIdentity(
  left: GitHubRepositoryIdentity,
  right: GitHubRepositoryIdentity,
): boolean {
  return (
    left.owner.toLowerCase() === right.owner.toLowerCase() &&
    left.name.toLowerCase() === right.name.toLowerCase()
  );
}

function assertPull(
  pull: GitHubPullRequest,
  request: GitHubDeliveryRequest,
): GitHubPullRequest {
  const host = request.github_host ?? "github.com";
  let url: URL;
  try {
    url = new URL(pull.url);
  } catch {
    throw new Error("GITHUB_PR_RESPONSE_INVALID");
  }
  const expectedPath = `/${request.expected_repository.owner}/${request.expected_repository.name}/pull/${pull.number}`;
  if (
    !Number.isSafeInteger(pull.number) ||
    pull.number < 1 ||
    url.protocol !== "https:" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hostname.toLowerCase() !== host.toLowerCase() ||
    url.pathname.toLowerCase() !== expectedPath.toLowerCase() ||
    url.search !== "" ||
    url.hash !== "" ||
    !sameIdentity(pull.repository, request.expected_repository) ||
    pull.head !== request.head_branch ||
    pull.base !== request.base_branch ||
    pull.head_sha !== request.candidate_sha ||
    pull.state !== "OPEN"
  )
    throw new Error("GITHUB_PR_RESPONSE_INVALID");
  return pull;
}
function result(
  action: GitHubDeliveryResult["action"],
  pull: GitHubPullRequest,
  candidate: string,
): GitHubDeliveryResult {
  return Object.freeze({
    action,
    number: pull.number,
    url: pull.url,
    repository: pull.repository,
    head: pull.head,
    head_sha: pull.head_sha,
    base: pull.base,
    candidate_sha: candidate,
    body: pull.body,
  });
}
