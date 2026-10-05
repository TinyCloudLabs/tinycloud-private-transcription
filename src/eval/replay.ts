import { attributedBatches, readAttributedBatch, type AttributedBatch, type AttributedManifest, type AttributedRange } from "../providers/transcription/attributed.ts";
import type { AttributedResult } from "../providers/transcription/attributed-assembly.ts";

/**
 * Re-transcribes a meeting's retained attributed audio with another model (TC-745). It reuses the
 * exact production batches, so results are comparable batch for batch, and it never touches the
 * meeting's ledger or canonical transcript.
 */
export interface ReplayedBatch { ordinal: number; spec: AttributedBatch; status: "completed" | "silence" | "failed"; result?: AttributedResult; error?: string; ms: number }
export type BatchTranscriber = (pcm: Uint8Array, batch: AttributedBatch) => Promise<AttributedResult>;

export async function replayAttributedBatches(opts: {
  manifest: AttributedManifest; vexaMeetingId: number;
  fetchRange: (range: AttributedRange) => Promise<Uint8Array>;
  transcribe: BatchTranscriber; concurrency?: number;
  onBatch?: (batch: ReplayedBatch, done: number, total: number) => void;
}): Promise<ReplayedBatch[]> {
  const specs = attributedBatches(opts.manifest, opts.vexaMeetingId);
  const out: ReplayedBatch[] = new Array(specs.length);
  let next = 0, done = 0;
  const worker = async () => {
    while (next < specs.length) {
      const ordinal = next++, spec = specs[ordinal]!, started = Date.now();
      let replayed: ReplayedBatch;
      try {
        const prepared = await readAttributedBatch(spec, opts.fetchRange);
        if (prepared.silent) replayed = { ordinal, spec, status: "silence", ms: Date.now() - started };
        else {
          const result = await opts.transcribe(prepared.pcm, spec);
          replayed = { ordinal, spec, status: result.text.trim() ? "completed" : "failed", result, ms: Date.now() - started, ...(result.text.trim() ? {} : { error: "empty_transcript" }) };
        }
      } catch (error) {
        replayed = { ordinal, spec, status: "failed", error: error instanceof Error ? error.message.slice(0, 200) : "error", ms: Date.now() - started };
      }
      out[ordinal] = replayed;
      opts.onBatch?.(replayed, ++done, specs.length);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(opts.concurrency ?? 2, specs.length)) }, worker));
  return out;
}
