import { normalizeSegments } from "../../domain/transcript.ts";
import type { TranscriptionInput, TranscriptionProvider } from "./types.ts";

/** Passthrough of Vexa's (already deduped, meeting-relative — see providers/vexa/adapter.ts) segments. */
export class VexaNativeProvider implements TranscriptionProvider {
  readonly name = "vexa";
  async transcribe(input: TranscriptionInput) {
    return normalizeSegments(
      input.vexaSegments.filter((s) => s.completed !== false),
      input.language,
    );
  }
}
