import type { Config, TranscriptionProviderName } from "../../config.ts";
import type { TranscriptionProvider } from "./types.ts";
import { VexaNativeProvider } from "./vexa-native.ts";

export type { TranscriptionProvider, TranscriptionInput } from "./types.ts";
export { VexaNativeProvider } from "./vexa-native.ts";

const PROVIDER_NAMES: readonly string[] = ["vexa", "tinfoil"] satisfies TranscriptionProviderName[];

/**
 * Backend selection is owned by Vexa. Both deployment selections consume Vexa's completed,
 * speaker-attributed segments; no recording is downloaded or sent to another provider here.
 * The name is still validated so a typo in TRANSCRIPTION_PROVIDER fails at boot instead of
 * silently reporting an unknown backend through /health.
 */
export function createTranscriptionProvider(cfg: Pick<Config, "transcriptionProvider">): TranscriptionProvider {
  if (!PROVIDER_NAMES.includes(cfg.transcriptionProvider)) {
    throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${cfg.transcriptionProvider}`);
  }
  return new VexaNativeProvider();
}
