import { createHash, randomUUID } from "node:crypto";
import {
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  unlink,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { z } from "zod";

const safeTaskId = z
  .string()
  .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/)
  .refine((value) => value !== "." && value !== "..");
const nonEmpty = z.string().min(1);
const status = z.enum(["PASS", "FAIL", "NOT_APPLICABLE"]);

export const EvidenceArtifactSchema = z
  .object({
    schema_version: z.literal(1),
    task_id: safeTaskId,
    candidate_sha: nonEmpty,
    location: nonEmpty,
    kind: nonEmpty,
    producing_gate: nonEmpty,
    tool: nonEmpty,
    acceptance_ids: z.array(nonEmpty),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    byte_length: z.number().int().nonnegative(),
    captured_at: z.string().datetime(),
  })
  .strict()
  .readonly();

export type EvidenceArtifact = z.infer<typeof EvidenceArtifactSchema>;

const stringList = z.array(nonEmpty);
const domainChanges = z
  .object({
    frontend: stringList,
    backend: stringList,
    database: stringList,
    mobile: stringList,
  })
  .strict();

export const DocumentationStateSchema = z
  .object({
    task_id: safeTaskId,
    candidate_sha: nonEmpty,
    objective: nonEmpty,
    outcome: nonEmpty,
    risk: nonEmpty,
    affected_domains: stringList,
    known_limitations: stringList,
    architectural_impact: stringList,
    changes: domainChanges,
    important_contracts: stringList,
    test_suites: z.array(
      z.object({ name: nonEmpty, status, detail: nonEmpty }).strict(),
    ),
    acceptance_results: z.array(
      z.object({ id: nonEmpty, status, evidence: stringList }).strict(),
    ),
    gate_results: z.array(
      z.object({ gate: nonEmpty, status, detail: nonEmpty }).strict(),
    ),
    known_gaps: stringList,
    files_changed: stringList,
    migrations: stringList,
    dependencies: stringList,
    configuration_changes: stringList,
    environment_considerations: stringList,
  })
  .strict()
  .readonly();

export type DocumentationState = z.infer<typeof DocumentationStateSchema>;

export interface WriteArtifactInput {
  readonly task_id: string;
  readonly candidate_sha: string;
  readonly relative_path: string;
  readonly content: string | Uint8Array;
  readonly kind: string;
  readonly producing_gate: string;
  readonly tool: string;
  readonly acceptance_ids: readonly string[];
  readonly captured_at?: string;
  readonly privacy_reviewed?: boolean;
}

export interface VerificationResult {
  readonly valid: boolean;
  readonly stale: boolean;
  readonly reason:
    "candidate-commit-changed" | "digest-mismatch" | "artifact-missing" | null;
}

export class EvidenceStoreError extends Error {
  override readonly name = "EvidenceStoreError";
}

/** Repository-contained storage for candidate-bound proof artifacts. */
export class EvidenceStore {
  readonly #repositoryRoot: string;

  constructor(repositoryRoot: string) {
    if (!isAbsolute(repositoryRoot)) {
      throw new EvidenceStoreError("Repository root must be absolute");
    }
    this.#repositoryRoot = resolve(repositoryRoot);
  }

  async writeArtifact(input: WriteArtifactInput): Promise<EvidenceArtifact> {
    const taskId = parseTaskId(input.task_id);
    const relativePath = parseRelativePath(input.relative_path);
    const content =
      typeof input.content === "string"
        ? Buffer.from(input.content, "utf8")
        : Buffer.from(input.content);
    validateArtifactContent(input, content);
    const taskRoot = await this.#taskRoot(taskId);
    const artifactPath = await containedArtifactPath(
      taskRoot,
      relativePath,
      true,
    );
    await atomicWrite(artifactPath, content);
    const metadata = EvidenceArtifactSchema.parse({
      schema_version: 1,
      task_id: taskId,
      candidate_sha: nonEmpty.parse(input.candidate_sha),
      location: `.forge/artifacts/${taskId}/${relativePath}`,
      kind: nonEmpty.parse(input.kind),
      producing_gate: nonEmpty.parse(input.producing_gate),
      tool: nonEmpty.parse(input.tool),
      acceptance_ids: stringList.parse(input.acceptance_ids),
      sha256: digest(content),
      byte_length: content.byteLength,
      captured_at: input.captured_at ?? new Date().toISOString(),
    });
    await this.#writeTrustedMetadata(metadata);
    return metadata;
  }

  async verifyArtifact(
    supplied: EvidenceArtifact,
    currentCandidateSha: string,
  ): Promise<VerificationResult> {
    const metadata = EvidenceArtifactSchema.parse(supplied);
    if (metadata.candidate_sha !== currentCandidateSha) {
      return { valid: false, stale: true, reason: "candidate-commit-changed" };
    }
    const prefix = `.forge/artifacts/${metadata.task_id}/`;
    if (!metadata.location.startsWith(prefix)) {
      throw new EvidenceStoreError(
        "Artifact metadata location does not match its task",
      );
    }
    const relativePath = parseRelativePath(
      metadata.location.slice(prefix.length),
    );
    const taskRoot = await this.#taskRoot(metadata.task_id);
    const path = await containedArtifactPath(taskRoot, relativePath, false);
    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (error) {
      if (isNodeError(error, "ENOENT")) {
        return { valid: false, stale: false, reason: "artifact-missing" };
      }
      throw error;
    }
    if (
      content.byteLength !== metadata.byte_length ||
      digest(content) !== metadata.sha256
    ) {
      return { valid: false, stale: false, reason: "digest-mismatch" };
    }
    return { valid: true, stale: false, reason: null };
  }

  async verifyReference(
    taskIdInput: string,
    reference: string,
    expectedSha256: string,
  ): Promise<boolean> {
    const taskId = parseTaskId(taskIdInput);
    const prefix = `.forge/artifacts/${taskId}/`;
    if (!reference.startsWith(prefix)) return false;
    const relativePath = parseRelativePath(reference.slice(prefix.length));
    const taskRoot = await this.#taskRoot(taskId);
    const path = await containedArtifactPath(taskRoot, relativePath, false);
    try {
      return digest(await readFile(path)) === expectedSha256;
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw error;
    }
  }

  async verifyTrustedReference(input: {
    readonly task_id: string;
    readonly candidate_sha: string;
    readonly reference: string;
    readonly sha256: string;
    readonly producing_gate: string;
    readonly acceptance_ids: readonly string[];
  }): Promise<boolean> {
    const taskId = parseTaskId(input.task_id);
    const metadataPath = await this.#metadataPath(taskId, input.reference);
    let metadata: EvidenceArtifact;
    try {
      metadata = EvidenceArtifactSchema.parse(
        JSON.parse(await readFile(metadataPath, "utf8")),
      );
    } catch (error) {
      if (isNodeError(error, "ENOENT")) return false;
      throw new EvidenceStoreError("Trusted evidence metadata is invalid");
    }
    return (
      metadata.task_id === taskId &&
      metadata.candidate_sha === input.candidate_sha &&
      metadata.location === input.reference &&
      metadata.sha256 === input.sha256 &&
      metadata.producing_gate === input.producing_gate &&
      sameStrings(metadata.acceptance_ids, input.acceptance_ids) &&
      (await this.verifyReference(taskId, input.reference, input.sha256))
    );
  }

  async generateDocumentation(
    supplied: unknown,
  ): Promise<readonly EvidenceArtifact[]> {
    const state = DocumentationStateSchema.parse(supplied);
    const documents: readonly [string, string][] = [
      ["SUMMARY.md", summaryDocument(state)],
      ["IMPLEMENTATION.md", implementationDocument(state)],
      ["TESTING.md", testingDocument(state)],
      ["CHANGES.md", changesDocument(state)],
    ];
    return Promise.all(
      documents.map(([relative_path, content]) =>
        this.writeArtifact({
          task_id: state.task_id,
          candidate_sha: state.candidate_sha,
          relative_path,
          content,
          kind: "documentation",
          producing_gate: "EVIDENCE",
          tool: "forge-documentation-generator",
          acceptance_ids: state.acceptance_results.map((item) => item.id),
        }),
      ),
    );
  }

  async #taskRoot(taskId: string): Promise<string> {
    const canonicalRepository = await realpath(this.#repositoryRoot);
    const forgeRoot = join(canonicalRepository, ".forge");
    const artifactRoot = join(forgeRoot, "artifacts");
    const taskRoot = join(artifactRoot, taskId);
    for (const directory of [forgeRoot, artifactRoot, taskRoot]) {
      await ensureRealDirectory(directory);
    }
    assertContained(canonicalRepository, taskRoot);
    return taskRoot;
  }

  async #metadataPath(taskId: string, reference: string): Promise<string> {
    const canonicalRepository = await realpath(this.#repositoryRoot);
    const root = join(
      canonicalRepository,
      ".forge",
      "state",
      "evidence",
      taskId,
    );
    for (const directory of [
      join(canonicalRepository, ".forge"),
      join(canonicalRepository, ".forge", "state"),
      join(canonicalRepository, ".forge", "state", "evidence"),
      root,
    ])
      await ensureRealDirectory(directory);
    return join(root, `${digest(Buffer.from(reference))}.json`);
  }

  async #writeTrustedMetadata(metadata: EvidenceArtifact): Promise<void> {
    await atomicWrite(
      await this.#metadataPath(metadata.task_id, metadata.location),
      Buffer.from(JSON.stringify(metadata)),
    );
  }
}

function validateArtifactContent(
  input: WriteArtifactInput,
  content: Buffer,
): void {
  if (content.byteLength > 256 * 1024 * 1024)
    throw new EvidenceStoreError("Artifact exceeds the 256 MiB limit");
  if (
    (input.kind === "screenshot" || input.kind === "video") &&
    input.privacy_reviewed !== true
  )
    throw new EvidenceStoreError("Media evidence requires privacy review");
  if (
    input.kind === "screenshot" &&
    !/\.(?:png|jpe?g)$/i.test(input.relative_path)
  )
    throw new EvidenceStoreError(
      "Screenshot evidence has an invalid file type",
    );
  if (input.kind === "video" && !/\.(?:webm|mp4)$/i.test(input.relative_path))
    throw new EvidenceStoreError("Video evidence has an invalid file type");
  if (typeof input.content === "string") {
    const forbidden =
      /(?:sk-[A-Za-z0-9_-]{12,}|api[_-]?key\s*[:=]|password\s*[:=]|authorization:\s*bearer)/i;
    if (forbidden.test(input.content))
      throw new EvidenceStoreError(
        "Artifact contains secret-like content and must be redacted",
      );
  }
}

function sameStrings(left: readonly string[], right: readonly string[]) {
  return (
    left.length === right.length &&
    [...left].sort().every((value, index) => value === [...right].sort()[index])
  );
}

function parseTaskId(value: string): string {
  const parsed = safeTaskId.safeParse(value);
  if (!parsed.success) throw new EvidenceStoreError("Unsafe task ID");
  return parsed.data;
}

function parseRelativePath(value: string): string {
  if (
    !value ||
    isAbsolute(value) ||
    value.includes("\\") ||
    value
      .split("/")
      .some((segment) => !segment || segment === "." || segment === "..")
  ) {
    throw new EvidenceStoreError("Unsafe artifact path");
  }
  return value;
}

async function containedArtifactPath(
  taskRoot: string,
  relativePath: string,
  createParents: boolean,
): Promise<string> {
  const segments = relativePath.split("/");
  const filename = segments.pop();
  if (!filename) throw new EvidenceStoreError("Artifact path has no filename");
  let parent = taskRoot;
  for (const segment of segments) {
    parent = join(parent, segment);
    if (createParents) await ensureRealDirectory(parent);
    else await assertRealDirectoryIfPresent(parent);
  }
  const path = resolve(parent, filename);
  assertContained(taskRoot, path);
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new EvidenceStoreError("Artifact must not be a symbolic link");
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
  return path;
}

async function ensureRealDirectory(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink())
      throw new EvidenceStoreError(`Directory is a symbolic link: ${path}`);
    if (!entry.isDirectory())
      throw new EvidenceStoreError(`Path is not a directory: ${path}`);
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
    await mkdir(path, { mode: 0o700 }).catch((mkdirError: unknown) => {
      if (!isNodeError(mkdirError, "EEXIST")) throw mkdirError;
    });
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new EvidenceStoreError(`Unsafe artifact directory: ${path}`);
    }
  }
}

async function assertRealDirectoryIfPresent(path: string): Promise<void> {
  try {
    const entry = await lstat(path);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new EvidenceStoreError(`Unsafe artifact directory: ${path}`);
    }
  } catch (error) {
    if (!isNodeError(error, "ENOENT")) throw error;
  }
}

async function atomicWrite(path: string, content: Buffer): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, "wx", 0o600);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
  try {
    await rename(temporary, path);
    const directory = await open(resolve(path, ".."), "r");
    try {
      await directory.sync();
    } finally {
      await directory.close();
    }
  } finally {
    await unlink(temporary).catch(() => undefined);
  }
}

function digest(content: Uint8Array): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertContained(parent: string, child: string): void {
  const fromParent = relative(parent, child);
  if (
    fromParent === ".." ||
    fromParent.startsWith(`..${sep}`) ||
    isAbsolute(fromParent)
  ) {
    throw new EvidenceStoreError("Artifact path escapes canonical task root");
  }
}

function bullets(items: readonly string[]): string {
  return items.length === 0
    ? "- None recorded"
    : items.map((item) => `- ${item}`).join("\n");
}

function summaryDocument(state: DocumentationState): string {
  return `# Summary\n\n## Objective\n\n${state.objective}\n\n## Outcome\n\n${state.outcome}\n\n## Risk\n\n${state.risk}\n\n## Affected domains\n\n${bullets(state.affected_domains)}\n\n## Known limitations\n\n${bullets(state.known_limitations)}\n`;
}

function implementationDocument(state: DocumentationState): string {
  return `# Implementation\n\n## Architectural impact\n\n${bullets(state.architectural_impact)}\n\n## Frontend changes\n\n${bullets(state.changes.frontend)}\n\n## Backend changes\n\n${bullets(state.changes.backend)}\n\n## Database changes\n\n${bullets(state.changes.database)}\n\n## Mobile changes\n\n${bullets(state.changes.mobile)}\n\n## Important contracts\n\n${bullets(state.important_contracts)}\n`;
}

function testingDocument(state: DocumentationState): string {
  const suites = state.test_suites.map(
    (item) => `${item.name}: ${item.status} — ${item.detail}`,
  );
  const acceptance = state.acceptance_results.map(
    (item) =>
      `${item.id}: ${item.status}; evidence: ${item.evidence.join(", ") || "none recorded"}`,
  );
  const gates = state.gate_results.map(
    (item) => `${item.gate}: ${item.status} — ${item.detail}`,
  );
  return `# Testing\n\n## Test suites\n\n${bullets(suites)}\n\n## Acceptance results\n\n${bullets(acceptance)}\n\n## Validation gates\n\n${bullets(gates)}\n\n## Known gaps\n\n${bullets(state.known_gaps)}\n`;
}

function changesDocument(state: DocumentationState): string {
  return `# Changes\n\n## Files changed\n\n${bullets(state.files_changed)}\n\n## Migrations\n\n${bullets(state.migrations)}\n\n## Dependencies\n\n${bullets(state.dependencies)}\n\n## Configuration changes\n\n${bullets(state.configuration_changes)}\n\n## Environment considerations\n\n${bullets(state.environment_considerations)}\n`;
}

function isNodeError(
  error: unknown,
  code: string,
): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === code;
}
