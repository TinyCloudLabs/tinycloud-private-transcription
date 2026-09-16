import type { Config, TranscriptionProviderName } from "../../config.ts";
import type { TranscriptionProvider } from "./types.ts";
import { VexaNativeProvider } from "./vexa-native.ts";

export type { TranscriptionProvider, TranscriptionInput } from "./types.ts";
export { VexaNativeProvider } from "./vexa-native.ts";

const PROVIDER_NAMES: Record<TranscriptionProviderName, true> = {
  vexa: true,
  tinfoil: true,
};

/**
 * This setting is a PTX compatibility label; Vexa's STT endpoint is configured separately. Both
 * values consume Vexa's completed, speaker-attributed segments, and no recording is downloaded or
 * sent to another provider here. The name is still validated so a typo in TRANSCRIPTION_PROVIDER
 * fails at boot instead of silently reporting an unknown backend through /health.
 */
export function createTranscriptionProvider(cfg: Pick<Config, "transcriptionProvider">): TranscriptionProvider {
  if (!Object.hasOwn(PROVIDER_NAMES, cfg.transcriptionProvider)) {
    throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${cfg.transcriptionProvider}`);
  }
  return new VexaNativeProvider();
}
