import type { Config } from "../../config.ts";
import { TinfoilTranscriptionProvider } from "./tinfoil.ts";
import type { TranscriptionProvider } from "./types.ts";
import { VexaNativeProvider } from "./vexa-native.ts";

export type { TranscriptionProvider, TranscriptionInput, AudioBlob } from "./types.ts";
export { VexaNativeProvider } from "./vexa-native.ts";
export { TinfoilTranscriptionProvider } from "./tinfoil.ts";

export function createTranscriptionProvider(cfg: Pick<Config, "transcriptionProvider" | "tinfoil">): TranscriptionProvider {
  switch (cfg.transcriptionProvider) {
    case "vexa":
      return new VexaNativeProvider();
    case "tinfoil":
      return new TinfoilTranscriptionProvider(cfg.tinfoil);
    default:
      throw new Error(`Unknown TRANSCRIPTION_PROVIDER: ${cfg.transcriptionProvider}`);
  }
}
