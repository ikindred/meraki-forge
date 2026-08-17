import { EvidenceStore } from "./evidence-store.js";
import type {
  ValidationEvidence,
  ValidationEvidenceVerifier,
} from "../../execution/src/validation-orchestrator.js";

export class StoredEvidenceVerifier implements ValidationEvidenceVerifier {
  readonly #store: EvidenceStore;
  constructor(repositoryRoot: string) {
    this.#store = new EvidenceStore(repositoryRoot);
  }

  async assertValid(
    taskId: string,
    candidateSha: string,
    evidence: readonly ValidationEvidence[],
  ): Promise<void> {
    const results = await Promise.all(
      evidence.map((item) =>
        this.#store.verifyTrustedReference({
          task_id: taskId,
          candidate_sha: candidateSha,
          reference: item.reference,
          sha256: item.digest,
          producing_gate: item.producing_gate,
          acceptance_ids: item.acceptance_ids,
        }),
      ),
    );
    if (results.some((valid) => !valid))
      throw new Error("VALIDATION_EVIDENCE_MISSING_OR_TAMPERED");
  }
}
