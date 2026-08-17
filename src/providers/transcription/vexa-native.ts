import { normalizeSegments } from "../../domain/transcript.ts";
import type { TranscriptionInput, TranscriptionProvider } from "./types.ts";

/** Passthrough of Vexa's WhisperLive segments into our transcript schema. */
export class VexaNativeProvider implements TranscriptionProvider {
  readonly name = "vexa";
  async transcribe(input: TranscriptionInput) {
    return normalizeSegments(
      input.vexaSegments.filter((s) => s.completed !== false),
      input.language,
    );
  }
}
