import { randomUUID } from "node:crypto";
import {
  lstat,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

export class ObsidianReviewSyncError extends Error {
  override readonly name = "ObsidianReviewSyncError";
}

export const ObsidianReviewSchema = z
  .object({
    task_id: z.string().min(1),
    status: z.literal("REVIEW"),
    pr_number: z.number().int().positive(),
    repository: z
      .object({
        host: z.string().min(1),
        owner: z.string().min(1),
        name: z.string().min(1),
      })
      .strict(),
    pr_url: z
      .string()
      .url()
      .refine((value) => {
        const url = new URL(value);
        return url.protocol === "https:" && !url.username && !url.password;
      }, "PR URL must use credential-free HTTPS"),
    candidate_sha: z.string().regex(/^[a-f0-9]{40,64}$/),
    qa: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    security: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    accessibility: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    code_review: z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]),
    evidence_summary: z.string().min(1),
    known_limitations: z.array(z.string().min(1)),
    human_action_required: z.string().min(1),
  })
  .strict()
  .superRefine((review, context) => {
    const url = new URL(review.pr_url);
    const expectedPath = `/${review.repository.owner}/${review.repository.name}/pull/${review.pr_number}`;
    if (
      url.hostname.toLowerCase() !== review.repository.host.toLowerCase() ||
      url.pathname !== expectedPath
    )
      context.addIssue({
        code: "custom",
        path: ["pr_url"],
        message: "PR URL does not match the configured repository",
      });
  })
  .readonly();
export type ObsidianReview = z.infer<typeof ObsidianReviewSchema>;

const BEGIN = "<!-- FORGE:REVIEW:BEGIN -->";
const END = "<!-- FORGE:REVIEW:END -->";

/** Atomically updates only frontmatter status and a delimited Forge-owned block. */
export async function syncObsidianReview(
  vaultPath: string,
  taskPath: string,
  input: unknown,
): Promise<void> {
  try {
    const review = ObsidianReviewSchema.parse(input);
    if (!isAbsolute(vaultPath))
      throw new ObsidianReviewSyncError("Vault path must be absolute");
    assertRelative(taskPath);
    const vault = await realpath(vaultPath);
    const target = resolve(vault, taskPath);
    assertContained(vault, target);
    await rejectSymlinkComponents(vault, target);
    const canonical = await realpath(target);
    assertContained(vault, canonical);
    const entry = await lstat(canonical);
    if (!entry.isFile() || entry.isSymbolicLink())
      throw new ObsidianReviewSyncError(
        "Task note must be a regular non-symlink file",
      );
    const original = await readFile(canonical, "utf8");
    const updated = updateReview(original, review);
    if (updated === original) return;
    const temporary = join(
      dirname(canonical),
      `.${review.task_id}.${randomUUID()}.tmp`,
    );
    const handle = await open(temporary, "wx", entry.mode & 0o777);
    try {
      await handle.writeFile(updated, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    try {
      await rename(temporary, canonical);
      const directory = await open(dirname(canonical), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } finally {
      await unlink(temporary).catch(() => undefined);
    }
  } catch (error) {
    if (error instanceof ObsidianReviewSyncError) throw error;
    throw new ObsidianReviewSyncError(
      `Unable to synchronize REVIEW: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function updateReview(source: string, review: ObsidianReview): string {
  const frontmatter = source.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u);
  if (!frontmatter)
    throw new ObsidianReviewSyncError(
      "Task note must contain YAML frontmatter",
    );
  const body = frontmatter[1] ?? "";
  const statusPattern = /(^|\r?\n)status\s*:[^\r\n]*/u;
  const revisedBody = statusPattern.test(body)
    ? body.replace(
        statusPattern,
        (_whole, prefix: string) => `${prefix}status: REVIEW`,
      )
    : `${body}\nstatus: REVIEW`;
  const revisedFrontmatter = frontmatter[0].replace(body, revisedBody);
  const withStatus = revisedFrontmatter + source.slice(frontmatter[0].length);
  const block = renderBlock(review);
  const start = withStatus.indexOf(BEGIN);
  const end = withStatus.indexOf(END);
  if ((start === -1) !== (end === -1) || (start >= 0 && end < start)) {
    throw new ObsidianReviewSyncError("Forge REVIEW markers are malformed");
  }
  if (
    start >= 0 &&
    (withStatus.indexOf(BEGIN, start + BEGIN.length) >= 0 ||
      withStatus.indexOf(END, end + END.length) >= 0)
  ) {
    throw new ObsidianReviewSyncError(
      "Task note contains duplicate Forge REVIEW markers",
    );
  }
  if (start >= 0)
    return `${withStatus.slice(0, start)}${block}${withStatus.slice(end + END.length)}`;
  const separator = withStatus.endsWith("\n") ? "\n" : "\n\n";
  return `${withStatus}${separator}${block}\n`;
}

function renderBlock(review: ObsidianReview): string {
  const limitations =
    review.known_limitations.length > 0
      ? review.known_limitations.map((item) => `- ${oneLine(item)}`).join("\n")
      : "- None recorded";
  return `${BEGIN}\n## Forge Review\n\n- Task ID: ${oneLine(review.task_id)}\n- Status: REVIEW\n- PR: [#${review.pr_number}](${review.pr_url})\n- Candidate SHA: \`${review.candidate_sha}\`\n- QA: ${review.qa}\n- Security: ${review.security}\n- Accessibility: ${review.accessibility}\n- Code Review: ${review.code_review}\n\n### Evidence\n\n${oneLine(review.evidence_summary)}\n\n### Known Limitations\n\n${limitations}\n\n### Human Action Required\n\n${oneLine(review.human_action_required)}\n${END}`;
}

function oneLine(value: string): string {
  return value
    .replace(/[\r\n]+/gu, " ")
    .replace(/[<>]/gu, "")
    .trim();
}
function assertRelative(path: string): void {
  if (
    !path ||
    isAbsolute(path) ||
    path.split(/[\\/]/u).some((part) => part === ".." || part === "")
  )
    throw new ObsidianReviewSyncError(
      "Task path must be normalized and vault-relative",
    );
}
async function rejectSymlinkComponents(
  root: string,
  target: string,
): Promise<void> {
  let current = root;
  for (const part of relative(root, target).split(sep).filter(Boolean)) {
    current = join(current, part);
    const entry = await lstat(current);
    if (entry.isSymbolicLink())
      throw new ObsidianReviewSyncError(
        "Task path must not contain symbolic links",
      );
  }
}
function assertContained(root: string, candidate: string): void {
  const rel = relative(root, candidate);
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    throw new ObsidianReviewSyncError("Task path escapes the vault");
}
