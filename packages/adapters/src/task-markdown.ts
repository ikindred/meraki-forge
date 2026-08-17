import YAML from "yaml";
import {
  TaskContractSchema,
  deepFreeze,
  type TaskContract,
} from "../../kernel/src/contracts.js";

export function parseTaskMarkdown(markdown: string): TaskContract {
  if (Buffer.byteLength(markdown, "utf8") > 1024 * 1024)
    throw new Error("Task Markdown exceeds 1 MiB");
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1]) return parseObsidianTask(markdown);
  const data = YAML.parse(match[1], {
    maxAliasCount: 0,
    uniqueKeys: true,
  }) as Record<string, unknown>;
  assertSafeValue(data);
  const body = match[2]?.trim() ?? "";
  const parsed = TaskContractSchema.parse({
    ...data,
    notes: data.notes ?? body,
  });
  return deepFreeze(parsed);
}

function assertSafeValue(value: unknown, depth = 0): void {
  if (depth > 32) throw new Error("Task frontmatter is too deeply nested");
  if (Array.isArray(value)) {
    if (value.length > 10_000)
      throw new Error("Task frontmatter has too many items");
    value.forEach((item) => assertSafeValue(item, depth + 1));
  } else if (value && typeof value === "object") {
    const entries = Object.entries(value);
    for (const [key, item] of entries) {
      if (["__proto__", "prototype", "constructor"].includes(key))
        throw new Error("Unsafe task frontmatter key");
      assertSafeValue(item, depth + 1);
    }
  }
}

function parseObsidianTask(markdown: string): TaskContract {
  const title = markdown.match(/^\s*\* \[ \] (.+)$/mu)?.[1]?.trim();
  const field = (name: string): string | undefined =>
    markdown
      .match(new RegExp(`^\\s*\\* ${name}:\\s*(.+)$`, "imu"))?.[1]
      ?.trim();
  const acceptanceBlock = markdown.match(
    /^\s*\* Acceptance:\s*\r?\n([\s\S]*?)(?=^\s*\* [A-Za-z][^\n]*:|(?![\s\S]))/mu,
  )?.[1];
  const criteria = [
    ...(acceptanceBlock ?? "").matchAll(/^\s*\d+\.\s+(.+)$/gmu),
  ].map((item, index) => ({ id: `AC-${index + 1}`, text: item[1]!.trim() }));
  if (!title)
    throw new Error("Task must contain YAML frontmatter or a task checkbox");
  const normalizeList = (value: string | undefined): readonly string[] =>
    !value || value.toUpperCase() === "NONE" ? [] : [value];
  const id = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return deepFreeze(
    TaskContractSchema.parse({
      schema_version: "1",
      id: id || "task",
      title,
      mode: field("Mode"),
      priority: field("Priority"),
      outcome: field("Outcome"),
      acceptance_criteria: criteria,
      constraints: normalizeList(field("Constraints")),
      known_dependencies: normalizeList(field("Known Dependencies")),
      notes: field("Notes") === "NONE" ? "" : (field("Notes") ?? ""),
    }),
  );
}
