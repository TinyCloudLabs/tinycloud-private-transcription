import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { ulid } from "ulid";
import type { AppContext } from "../context.ts";
import { attributedBatches as batchesTable, attributedTranscriptionRuns, meetings, referenceTranscripts, transcriptEvals, transcripts } from "../db/schema.ts";
import { assembleAttributedTranscript, type AttributedResult } from "../providers/transcription/attributed-assembly.ts";
import { attributedBatches, type AttributedManifest } from "../providers/transcription/attributed.ts";
import { TinfoilRateLimited, TinfoilTranscriptionProvider } from "../providers/transcription/tinfoil.ts";
import { VexaHttpError } from "../providers/vexa/client.ts";
import { replayAttributedBatches } from "../eval/replay.ts";
import { parseReferenceTranscript } from "../eval/reference.ts";
import { transcriptMetrics, type TranscriptMetrics, type TurnLike } from "../eval/metrics.ts";

/**
 * Internal transcript evaluation (TC-745).
 *
 * Shadow-transcribes a completed attributed meeting's retained audio with each configured model,
 * stores the raw batch results and the assembled transcript beside the canonical one, and scores
 * everything against a reference transcript when an operator uploads one. Nothing here changes
 * the canonical transcript, its ledger, or webhooks. Evals run in the background of the worker
 * process, one at a time, so the serial job loop keeps serving live meetings.
 */

const RETRIES = 6;
let running: Promise<void> | null = null;

const object = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const backoff = async <T>(fn: () => Promise<T>, retryable: (error: unknown) => boolean): Promise<T> => {
  for (let attempt = 0; ; attempt++) {
    try { return await fn(); } catch (error) {
      if (attempt >= RETRIES || !retryable(error)) throw error;
      await Bun.sleep(1_000 * 2 ** attempt);
    }
  }
};
// Only definite rejections are re-sent. A timeout may have been processed and billed.
const vexaRetryable = (error: unknown) => error instanceof VexaHttpError && (error.status === 429 || error.status >= 500);
const tinfoilRetryable = (error: unknown) => error instanceof TinfoilRateLimited;
const PRODUCTION_WAIT_MS = 15_000, PRODUCTION_WAIT_LIMIT_MS = 2 * 60 * 60_000, STALE_RUNNING_MS = 6 * 60 * 60_000;

/**
 * Before every batch: stop if the meeting is gone or being deleted (no audio is read or sent after
 * a deletion starts), and wait while production attributed work is queued so evals never compete
 * with a live meeting for Tinfoil capacity.
 */
async function evalGuard(ctx: AppContext, meetingId: string): Promise<void> {
  const started = Date.now();
  for (;;) {
    const [meeting] = await ctx.db.select({ dispatchBlocked: meetings.dispatchBlocked, deletionToken: meetings.deletionToken }).from(meetings).where(eq(meetings.id, meetingId));
    if (!meeting || meeting.dispatchBlocked || meeting.deletionToken) throw new Error("Meeting was deleted or is being deleted");
    const [busy] = await ctx.db.select({ id: batchesTable.id }).from(batchesTable).where(inArray(batchesTable.status, ["pending", "claimed"])).limit(1);
    if (!busy) return;
    if (Date.now() - started > PRODUCTION_WAIT_LIMIT_MS) throw new Error("Production transcription stayed busy");
    await Bun.sleep(PRODUCTION_WAIT_MS);
  }
}

/** Meetings an automatic eval may touch: listed TinyChat owners only, unless EVAL_ALL_MEETINGS. */
export function evalEligible(ctx: AppContext, meeting: typeof meetings.$inferSelect): boolean {
  const { models, allMeetings, tinychatAddresses } = ctx.config.eval;
  if (!models.length || meeting.platform !== "google_meet") return false;
  if (allMeetings) return true;
  const address = object<Record<string, unknown>>(meeting.metadata ?? {})?.tinychat_address;
  return typeof address === "string" && tinychatAddresses.includes(address.toLowerCase());
}

/** Called after a canonical attributed publication commits. Never throws into publication. */
export async function scheduleTranscriptEval(ctx: AppContext, meeting: typeof meetings.$inferSelect): Promise<void> {
  if (!evalEligible(ctx, meeting)) return;
  await ctx.queue.push({ type: "eval.meeting", meetingId: meeting.id }, ctx.config.eval.delayMs, `eval:${meeting.id}`).catch(() => {});
}

/** Worker job: starts the eval in the background, or defers while another eval is running. */
export async function handleEvalJob(ctx: AppContext, meetingId: string, models?: string[]): Promise<"processed" | "deferred"> {
  if (running) { await ctx.queue.push({ type: "eval.meeting", meetingId, ...(models ? { models } : {}) }, 60_000, `eval:${meetingId}`); return "deferred"; }
  // A worker that stopped mid-eval leaves its row running; nothing resumes it.
  await ctx.db.update(transcriptEvals).set({ status: "failed", error: "interrupted", completedAt: new Date() })
    .where(and(eq(transcriptEvals.status, "running"), lt(transcriptEvals.createdAt, new Date(Date.now() - STALE_RUNNING_MS))));
  running = runTranscriptEval(ctx, meetingId, models ?? ctx.config.eval.models)
    .then(() => {}, (error) => { ctx.log.warn("transcript eval failed", { meetingId, stage: "transcript_eval", code: error instanceof Error ? error.name : "error" }); })
    .finally(() => { running = null; });
  return "processed";
}

async function referenceTurns(ctx: AppContext, meetingId: string): Promise<TurnLike[] | null> {
  const [reference] = await ctx.db.select().from(referenceTranscripts).where(eq(referenceTranscripts.meetingId, meetingId));
  return reference ? parseReferenceTranscript(reference.text) : null;
}

const turnsOf = (segments: Array<{ speaker_name: string; text: string }>): TurnLike[] => segments.map((s) => ({ speaker: s.speaker_name, text: s.text }));

/** Re-transcribes one meeting with each model. Runs inline (CLI) or in the worker's background. */
export async function runTranscriptEval(ctx: AppContext, meetingId: string, models: string[], log: (line: string) => void = () => {}): Promise<string[]> {
  if (!(ctx.transcriptRecovery instanceof TinfoilTranscriptionProvider)) throw new Error("Tinfoil is not configured");
  const provider = ctx.transcriptRecovery.fork();
  const [meeting] = await ctx.db.select().from(meetings).where(eq(meetings.id, meetingId));
  const [run] = await ctx.db.select().from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
  if (!meeting?.vexaMeetingId || !run || run.status === "fallback") throw new Error("Meeting has no staged attributed manifest");
  const manifest = object<AttributedManifest>(run.manifestJson);
  const specs = attributedBatches(manifest, meeting.vexaMeetingId);
  const reference = await referenceTurns(ctx, meetingId);
  const ids: string[] = [];
  for (const model of models) {
    const id = `eval_${ulid()}`;
    ids.push(id);
    await ctx.db.insert(transcriptEvals).values({ id, meetingId, provider: "tinfoil", model });
    const callsBefore = provider.calls;
    try {
      const batches = await replayAttributedBatches({
        manifest, vexaMeetingId: meeting.vexaMeetingId, concurrency: ctx.config.eval.concurrency,
        beforeBatch: () => evalGuard(ctx, meetingId),
        fetchRange: (range) => backoff(async () => (await ctx.vexa.fetchBytes(range.path!)).bytes, vexaRetryable),
        transcribe: (pcm, batch) => backoff(() => provider.transcribeAttributedPcm(pcm, batch, meeting.language, model), tinfoilRetryable),
        onBatch: (_batch, done, total) => { if (done % 25 === 0 || done === total) log(`${model}: ${done}/${total}`); },
      });
      const completed = batches.filter((b) => b.status === "completed").map((b) => ({ spec: specs[b.ordinal]!, result: b.result as AttributedResult }));
      const { transcript, stats } = assembleAttributedTranscript(manifest, completed, meeting.language);
      const metrics = { ...transcriptMetrics(turnsOf(transcript.segments), reference), ...stats, failed_batches: batches.filter((b) => b.status === "failed").length };
      await ctx.db.update(transcriptEvals).set({
        status: "completed", calls: provider.calls - callsBefore, completedAt: new Date(),
        batchesJson: batches.map(({ spec: _spec, ...rest }) => rest), transcriptJson: transcript, metricsJson: metrics,
      }).where(eq(transcriptEvals.id, id));
      log(`${model}: completed (${provider.calls - callsBefore} calls)`);
    } catch (error) {
      await ctx.db.update(transcriptEvals).set({ status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 500), completedAt: new Date(), calls: provider.calls - callsBefore })
        .where(eq(transcriptEvals.id, id));
      log(`${model}: failed`);
    }
  }
  return ids;
}

/** Stores (or replaces) a meeting's reference transcript and re-scores its completed evals. */
export async function setReferenceTranscript(ctx: AppContext, meetingId: string, source: string, text: string): Promise<number> {
  const turns = parseReferenceTranscript(text);
  if (!turns.length) throw new Error("Reference transcript has no `Speaker: text` turns");
  await ctx.db.insert(referenceTranscripts).values({ meetingId, source, text })
    .onConflictDoUpdate({ target: referenceTranscripts.meetingId, set: { source, text, createdAt: new Date() } });
  const evals = await ctx.db.select().from(transcriptEvals).where(and(eq(transcriptEvals.meetingId, meetingId), eq(transcriptEvals.status, "completed")));
  for (const row of evals) {
    const transcript = object<{ segments: Array<{ speaker_name: string; text: string }> }>(row.transcriptJson);
    const previous = object<Record<string, unknown>>(row.metricsJson ?? {});
    await ctx.db.update(transcriptEvals).set({ metricsJson: { ...previous, ...transcriptMetrics(turnsOf(transcript.segments), turns) } }).where(eq(transcriptEvals.id, row.id));
  }
  return turns.length;
}

export interface EvalReportRow { source: string; status: string; created_at: string; calls: number | null; metrics: Partial<TranscriptMetrics> | Record<string, unknown> }

/** The canonical transcript first, then every eval, newest first; metrics against the reference. Coverage is the published run's speech accounting (TC-758). */
export async function transcriptEvalReport(ctx: AppContext, meetingId: string): Promise<{ reference: string | null; rows: EvalReportRow[]; coverage: Record<string, unknown> | null }> {
  const [reference] = await ctx.db.select().from(referenceTranscripts).where(eq(referenceTranscripts.meetingId, meetingId));
  const turns = reference ? parseReferenceTranscript(reference.text) : null;
  const rows: EvalReportRow[] = [];
  const [canonical] = await ctx.db.select().from(transcripts).where(eq(transcripts.meetingId, meetingId));
  if (canonical) {
    const payload = object<{ segments?: Array<{ speaker_name: string; text: string }> }>(canonical.segmentsJson);
    rows.push({ source: `published:${canonical.provider}`, status: "completed", created_at: canonical.createdAt.toISOString(), calls: null, metrics: transcriptMetrics(turnsOf(payload.segments ?? []), turns) });
  }
  for (const row of await ctx.db.select().from(transcriptEvals).where(eq(transcriptEvals.meetingId, meetingId)).orderBy(desc(transcriptEvals.createdAt))) {
    rows.push({ source: `${row.provider}:${row.model} (${row.id})`, status: row.status, created_at: row.createdAt.toISOString(), calls: row.calls, metrics: object(row.metricsJson ?? {}) });
  }
  const [run] = await ctx.db.select({ coverage: attributedTranscriptionRuns.coverageJson }).from(attributedTranscriptionRuns).where(eq(attributedTranscriptionRuns.meetingId, meetingId));
  return { reference: reference ? `${reference.source} (${turns!.length} turns)` : null, rows, coverage: run?.coverage ? object<Record<string, unknown>>(run.coverage) : null };
}

/** Plain-text view of an eval's (or the canonical) transcript for operator review on the server. */
export async function transcriptEvalText(ctx: AppContext, meetingId: string, evalId?: string): Promise<string> {
  let segments: Array<{ speaker_name: string; text: string; start: number }> = [];
  if (evalId) {
    const [row] = await ctx.db.select().from(transcriptEvals).where(and(eq(transcriptEvals.id, evalId), eq(transcriptEvals.meetingId, meetingId)));
    segments = object<{ segments?: typeof segments }>(row?.transcriptJson ?? {}).segments ?? [];
  } else {
    const [row] = await ctx.db.select().from(transcripts).where(eq(transcripts.meetingId, meetingId));
    segments = object<{ segments?: typeof segments }>(row?.segmentsJson ?? {}).segments ?? [];
  }
  const clock = (seconds: number) => new Date(seconds * 1000).toISOString().slice(11, 19);
  return segments.map((s) => `[${clock(s.start)}] ${s.speaker_name}: ${s.text}`).join("\n");
}
