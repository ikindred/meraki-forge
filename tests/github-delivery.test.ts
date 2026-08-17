import { describe, expect, it } from "vitest";
import {
  GitHubDeliveryAdapter,
  type GitHubDeliveryClient,
  type GitHubPullRequest,
} from "../packages/adapters/src/github-delivery-adapter.js";

function fakeClient(overrides: Partial<GitHubDeliveryClient> = {}) {
  const created: unknown[] = [];
  const updated: unknown[] = [];
  const client: GitHubDeliveryClient = {
    authStatus: () =>
      Promise.resolve({ authenticated: true, login: "forge-bot" }),
    repository: () => Promise.resolve({ owner: "meraki", name: "forge" }),
    findOpenPullRequests: () => Promise.resolve([]),
    createPullRequest: (input) => {
      created.push(input);
      return Promise.resolve({
        number: 12,
        url: "https://github.com/meraki/forge/pull/12",
        repository: { owner: "meraki", name: "forge" },
        head: input.head,
        head_sha: request.candidate_sha,
        base: input.base,
        body: input.body,
        state: "OPEN",
      });
    },
    updatePullRequestBody: (number, body) => {
      updated.push({ number, body });
      return Promise.resolve({
        number,
        url: `https://github.com/meraki/forge/pull/${number}`,
        repository: { owner: "meraki", name: "forge" },
        head: "forge/MF-1",
        head_sha: request.candidate_sha,
        base: "main",
        body,
        state: "OPEN",
      });
    },
    ...overrides,
  };
  return { client, created, updated };
}

const request = {
  expected_repository: { owner: "meraki", name: "forge" },
  task_id: "MF-1",
  head_branch: "forge/MF-1",
  base_branch: "main",
  candidate_sha: "c".repeat(40),
  title: "feat: deliver MF-1",
  forge_body: "# Objective\n\nShip safely.",
} as const;

describe("GitHubDeliveryAdapter", () => {
  it("creates once, then reuses the existing task/head/base PR", async () => {
    let existing: GitHubPullRequest[] = [];
    const state = fakeClient({
      findOpenPullRequests: () => Promise.resolve(existing),
    });
    const adapter = new GitHubDeliveryAdapter(state.client);
    const first = await adapter.deliver(request);
    expect(first.action).toBe("CREATED");
    existing = [
      {
        number: 12,
        url: first.url,
        repository: request.expected_repository,
        head: request.head_branch,
        head_sha: request.candidate_sha,
        base: request.base_branch,
        body: `intro\n${first.body}`,
        state: "OPEN",
      },
    ];
    const second = await adapter.deliver(request);
    expect(second.action).toBe("REUSED");
    expect(state.created).toHaveLength(1);
  });

  it("updates only the Forge-owned marked body section", async () => {
    const old =
      "Human intro\n<!-- FORGE:BEGIN MF-1 -->\nold\n<!-- FORGE:END MF-1 -->\nHuman footer";
    const state = fakeClient({
      findOpenPullRequests: () =>
        Promise.resolve([
          {
            number: 9,
            url: "https://github.com/meraki/forge/pull/9",
            repository: request.expected_repository,
            head: request.head_branch,
            head_sha: request.candidate_sha,
            base: "main",
            body: old,
            state: "OPEN",
          },
        ]),
    });
    const result = await new GitHubDeliveryAdapter(state.client).deliver(
      request,
    );
    expect(result.action).toBe("UPDATED");
    expect((state.updated[0] as { body: string }).body).toContain(
      "Human intro",
    );
    expect((state.updated[0] as { body: string }).body).toContain(
      "Human footer",
    );
    expect((state.updated[0] as { body: string }).body).toContain(
      request.forge_body,
    );
  });

  it("fails closed for uncertain auth, identity mismatch, duplicate PRs, or unsafe branches", async () => {
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          authStatus: () => Promise.resolve({ authenticated: false }),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("GITHUB_AUTH_REQUIRED");
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          repository: () => Promise.resolve({ owner: "other", name: "forge" }),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("GITHUB_REPOSITORY_MISMATCH");
    const duplicate = {
      number: 1,
      url: "u",
      repository: request.expected_repository,
      head: request.head_branch,
      head_sha: request.candidate_sha,
      base: "main",
      body: "",
      state: "OPEN",
    } as const;
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          findOpenPullRequests: () =>
            Promise.resolve([duplicate, { ...duplicate, number: 2 }]),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("DUPLICATE_TASK_PULL_REQUESTS");
    await expect(
      new GitHubDeliveryAdapter(fakeClient().client).deliver({
        ...request,
        head_branch: "main",
      }),
    ).rejects.toThrow("DEFAULT_BRANCH_PR_PROHIBITED");
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          findOpenPullRequests: () =>
            Promise.resolve([
              {
                number: 4,
                url: "https://github.com/meraki/forge/pull/4",
                repository: request.expected_repository,
                head: request.head_branch,
                head_sha: request.candidate_sha,
                base: "main",
                body: "Human-only PR",
                state: "OPEN",
              },
            ]),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("EXISTING_PR_NOT_FORGE_OWNED");
  });

  it("rejects forged GitHub PR responses for create, update, and reuse", async () => {
    const valid = {
      number: 8,
      url: "https://github.com/meraki/forge/pull/8",
      repository: request.expected_repository,
      head: request.head_branch,
      head_sha: request.candidate_sha,
      base: request.base_branch,
      body: `<!-- FORGE:BEGIN MF-1 -->\nold\n<!-- FORGE:END MF-1 -->`,
      state: "OPEN",
    } as const;
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          createPullRequest: () =>
            Promise.resolve({
              ...valid,
              url: "https://evil.test/meraki/forge/pull/8",
            }),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("GITHUB_PR_RESPONSE_INVALID");
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          findOpenPullRequests: () =>
            Promise.resolve([{ ...valid, head_sha: "a".repeat(40) }]),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("GITHUB_PR_RESPONSE_INVALID");
    await expect(
      new GitHubDeliveryAdapter(
        fakeClient({
          findOpenPullRequests: () => Promise.resolve([valid]),
          updatePullRequestBody: () =>
            Promise.resolve({ ...valid, state: "CLOSED" }),
        }).client,
      ).deliver(request),
    ).rejects.toThrow("GITHUB_PR_RESPONSE_INVALID");
    await expect(
      new GitHubDeliveryAdapter(fakeClient().client).deliver({
        ...request,
        head_branch: "forge/../main",
      }),
    ).rejects.toThrow("INVALID_DELIVERY_IDENTITY");
  });

  it("exposes no merge, deploy, admin, or secret mutation capabilities", () => {
    const adapter = new GitHubDeliveryAdapter(
      fakeClient().client,
    ) as unknown as Record<string, unknown>;
    for (const forbidden of [
      "merge",
      "deploy",
      "admin",
      "setSecret",
      "bypassProtection",
    ])
      expect(adapter[forbidden]).toBeUndefined();
  });
});
