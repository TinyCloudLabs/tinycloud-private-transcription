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

/** Vexa is always the primary timeline and attribution source. */
export function createTranscriptionProvider(cfg: Pick<Config, "transcriptionProvider">): TranscriptionProvider {
  if (!Object.hasOwn(PROVIDER_NAMES, cfg.transcriptionProvider)) throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${cfg.transcriptionProvider}`);
  return new VexaNativeProvider();
}

/** Tinfoil is an optional recovery path, never the globally selected primary provider. */
export function createTranscriptRecoveryProvider(cfg: Pick<Config, "tinfoil">): TranscriptionProvider | null {
  if (!cfg.tinfoil.apiKey) return null;
  return new TinfoilTranscriptionProvider(cfg.tinfoil);
}
