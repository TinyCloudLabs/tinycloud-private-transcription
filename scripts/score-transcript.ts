#!/usr/bin/env bun
/**
 * Scores transcripts against a reference transcript (TC-745).
 *
 *   bun scripts/score-transcript.ts <reference.txt> replay:<replay.json> transcript:<segments.json> ...
 *
 * `replay:` files come from scripts/replay-attributed.ts and are assembled exactly as publication
 * would assemble them; `transcript:` files are a stored transcript's segments_json.
 */
import { assembleAttributedTranscript } from "../src/providers/transcription/attributed-assembly.ts";
import { attributedBatches } from "../src/providers/transcription/attributed.ts";
import { parseReferenceTranscript } from "../src/eval/reference.ts";
import { transcriptMetrics, type TurnLike } from "../src/eval/metrics.ts";

const [referencePath, ...inputs] = process.argv.slice(2);
if (!referencePath || !inputs.length) { console.error("usage: score-transcript.ts <reference.txt> replay:<file>|transcript:<file> ..."); process.exit(1); }
const reference = parseReferenceTranscript(await Bun.file(referencePath).text());
const rows: Record<string, unknown>[] = [];
for (const input of inputs) {
  const [kind, path] = input.split(/:(.*)/s) as [string, string];
  const data = await Bun.file(path).json();
  let turns: TurnLike[];
  let extra: Record<string, unknown> = {};
  if (kind === "replay") {
    const specs = attributedBatches(data.manifest, data.vexaMeetingId);
    const completed = data.batches.filter((b: { status: string }) => b.status === "completed").map((b: { ordinal: number; result: never }) => ({ spec: specs[b.ordinal]!, result: b.result }));
    const { transcript, stats } = assembleAttributedTranscript(data.manifest, completed, "en");
    turns = transcript.segments.map((s) => ({ speaker: s.speaker_name, text: s.text }));
    extra = { model: data.model, calls: data.calls, failed_batches: data.batches.filter((b: { status: string }) => b.status === "failed").length, dropped: stats.dropped_hallucinations };
    if (process.env.DUMP) await Bun.write(`${path}.transcript.txt`, transcript.segments.map((s) => `[${s.start.toFixed(1)}] ${s.speaker_name}: ${s.text}`).join("\n"));
  } else {
    const segments = (data.segments ?? data) as Array<{ speaker_name: string; text: string }>;
    turns = segments.map((s) => ({ speaker: s.speaker_name, text: s.text }));
  }
  rows.push({ input: path.split("/").at(-1), ...extra, ...transcriptMetrics(turns, reference) });
}
rows.push({ input: "reference (self)", ...transcriptMetrics(reference, null) });
console.table(rows);
