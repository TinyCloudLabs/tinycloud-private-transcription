import type { Config, TranscriptionProviderName } from "../../config.ts";
import type { TranscriptionProvider } from "./types.ts";
import { VexaNativeProvider } from "./vexa-native.ts";
import { TinfoilTranscriptionProvider } from "./tinfoil.ts";

export type { TranscriptionProvider, TranscriptionInput, AudioBlob } from "./types.ts";
export { VexaNativeProvider } from "./vexa-native.ts";
export { TinfoilTranscriptionProvider } from "./tinfoil.ts";

const PROVIDER_NAMES: Record<TranscriptionProviderName, true> = {
  vexa: true,
  tinfoil: true,
};

/**
 * Vexa remains the primary timeline and attribution source. Tinfoil is selected only by the worker
 * for a materially incomplete Vexa timeline, where it transcribes the retained mixed recording.
 */
export function createTranscriptionProvider(cfg: Pick<Config, "transcriptionProvider"> & Partial<Pick<Config, "tinfoil">>): TranscriptionProvider {
  if (!Object.hasOwn(PROVIDER_NAMES, cfg.transcriptionProvider)) throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${cfg.transcriptionProvider}`);
  return cfg.transcriptionProvider === "tinfoil" ? new TinfoilTranscriptionProvider(cfg.tinfoil ?? { baseUrl: "https://inference.tinfoil.sh", apiKey: "", model: "voxtral-small-24b" }) : new VexaNativeProvider();
}
