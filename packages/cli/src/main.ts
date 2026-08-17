#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { ProjectPolicySchema } from "../../kernel/src/policy.js";

async function main(argv: readonly string[]): Promise<number> {
  const [command, file] = argv;
  if (command !== "validate-policy" || !file) {
    console.error("Usage: forge validate-policy <policy.json>");
    return 2;
  }
  try {
    ProjectPolicySchema.parse(JSON.parse(await readFile(file, "utf8")));
    console.log("PASS policy");
    return 0;
  } catch (error) {
    console.error(
      "FAIL policy",
      error instanceof Error ? error.message : String(error),
    );
    return 1;
  }
}
process.exitCode = await main(process.argv.slice(2));
