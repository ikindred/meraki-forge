import { GitChangeCollector } from "./git-change-collector.js";
import type {
  ValidationChangeMonitor,
  ValidationGate,
} from "../../execution/src/validation-orchestrator.js";

export class GitValidationChangeMonitor implements ValidationChangeMonitor {
  readonly #collector = new GitChangeCollector();
  constructor(private readonly worktree: string) {}

  begin(grant: readonly string[]): Promise<string> {
    return this.#collector.captureBaseline(this.worktree, grant, true);
  }
  async collect(baseline: string) {
    const result = await this.#collector.collectChangedPaths(
      this.worktree,
      baseline,
    );
    return { paths: result.paths, candidate_sha: result.candidate_commit };
  }
  reject(baseline: string): Promise<void> {
    return this.#collector.rejectChanges(this.worktree, baseline);
  }
  accept(baseline: string, gate: ValidationGate): Promise<string> {
    return this.#collector.acceptChanges(
      this.worktree,
      baseline,
      `validation-${gate.toLowerCase()}`,
    );
  }
}
