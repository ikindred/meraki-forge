import { execFile as execFileCallback } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFile = promisify(execFileCallback);

describe("forge launcher", () => {
  it("resolves the package runtime through npm-style global symlinks", async () => {
    const root = await mkdtemp(join(tmpdir(), "forge-launcher-"));
    const packageRoot = join(root, "source package");
    const globalRoot = join(root, "global");
    await mkdir(join(packageRoot, "bin"), { recursive: true });
    await mkdir(join(packageRoot, "dist/packages/cli/src"), {
      recursive: true,
    });
    await mkdir(join(globalRoot, "bin"), { recursive: true });
    await mkdir(join(globalRoot, "lib/node_modules"), { recursive: true });
    await copyFile(resolve("bin/forge"), join(packageRoot, "bin/forge"));
    await chmod(join(packageRoot, "bin/forge"), 0o755);
    await writeFile(
      join(packageRoot, "dist/packages/cli/src/main.js"),
      "console.log(JSON.stringify(process.argv.slice(2)))\n",
    );
    await symlink(
      packageRoot,
      join(globalRoot, "lib/node_modules/meraki-forge"),
    );
    await symlink(
      "../lib/node_modules/meraki-forge/bin/forge",
      join(globalRoot, "bin/forge"),
    );

    const { stdout } = await execFile(join(globalRoot, "bin/forge"), [
      "--help",
      "value with spaces",
    ]);
    expect(JSON.parse(stdout)).toEqual(["--help", "value with spaces"]);
  });
});
