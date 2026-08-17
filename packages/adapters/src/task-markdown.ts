import YAML from "yaml";
import {
  TaskContractSchema,
  deepFreeze,
  type TaskContract,
} from "../../kernel/src/contracts.js";

export function parseTaskMarkdown(markdown: string): TaskContract {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match?.[1]) throw new Error("Task must contain YAML frontmatter");
  const data = YAML.parse(match[1]) as Record<string, unknown>;
  const body = match[2]?.trim() ?? "";
  const parsed = TaskContractSchema.parse({
    ...data,
    notes: data.notes ?? body,
  });
  return deepFreeze(parsed);
}
