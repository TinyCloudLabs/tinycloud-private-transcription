import type { Config } from "../../config.ts";
import type { TranscriptionProvider } from "./types.ts";
import { VexaNativeProvider } from "./vexa-native.ts";

export type { TranscriptionProvider, TranscriptionInput } from "./types.ts";
export { VexaNativeProvider } from "./vexa-native.ts";

/**
 * Backend selection is owned by Vexa. Both deployment selections consume Vexa's completed,
 * speaker-attributed segments; no recording is downloaded or sent to another provider here.
 */
export function createTranscriptionProvider(_cfg: Pick<Config, "transcriptionProvider">): TranscriptionProvider {
  return new VexaNativeProvider();
}
