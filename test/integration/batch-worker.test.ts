import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq, sql } from "drizzle-orm";
import { providerDispatchSlots, transcriptionAttempts, transcriptionRegions, transcriptionResults, transcriptions, transcriptionWorkers } from "../../src/db/schema.ts";
import { runSweep, retentionLagSeconds } from "../../src/uploads/ledger.ts";
import type { FaultPoint } from "../../src/uploads/faults.ts";
import { jobDir, jobsRoot } from "../../src/uploads/storage.ts";
import { claimNext, insertRegions, processClaim, recordWorkerHeartbeat, REGION_INSERT_CHUNK, startBatchWorker } from "../../src/uploads/worker.ts";
import { detectSpeech, frameEnergies, summarizeVad, VAD } from "../../src/uploads/vad.ts";
import { speakerTurns, UNKNOWN_SPEAKER } from "../../src/uploads/diarize.ts";
import { PCM_RATE } from "../../src/uploads/audio.ts";
import { pcmToWav } from "../../src/providers/transcription/audio.ts";
import { pcmFromLevels, quietSpeechLevels } from "../support/vad-fixtures.ts";
import { holdFence } from "../../src/uploads/fence.ts";
import { batchConfigFromEnv } from "../../src/uploads/config.ts";
import { audio, exists, startBatchHarness, TENANT_A, TENANT_B, tenant, type BatchHarness } from "./batch-harness.ts";

let h: BatchHarness;
beforeAll(async () => {
  h = await startBatchHarness();
});
afterAll(async () => h.stop());
afterEach(async () => {
  h.faults.clear();
  h.tinfoil.calls = [];
  h.tinfoil.maxActive = 0;
  h.tinfoil.handler = (call) => Response.json({ text: `words ${call}`, language: "en" });
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  await h.ctx.db.execute(sql`update provider_dispatch_slots set attempt_id = null, transcription_id = null, owner_id = null, claimed_at = null`);
  await h.ctx.db.execute(sql`update transcription_admission set mode = 'open'`);
  await h.ctx.db.delete(transcriptionWorkers);
  await recordWorkerHeartbeat(h.ctx);
  Object.assign(h.ctx.config.worker, { maxConsecutiveRateLimits: 20, retryAfterDefaultSeconds: 0, retryAfterMaxSeconds: 120, maxNotSentAttempts: 5, claimStaleSeconds: 60, maxProcessingSeconds: 14_400 });
  Object.assign(h.ctx.config.retention, { retentionLagDegradedSeconds: 300, tombstoneRetentionSeconds: 604_800 });
});

const attempts = (id: string) => h.ctx.db.select().from(transcriptionAttempts).where(eq(transcriptionAttempts.transcriptionId, id));
const regions = (id: string) => h.ctx.db.select().from(transcriptionRegions).where(eq(transcriptionRegions.transcriptionId, id));
const slot = async () => (await h.ctx.db.select().from(providerDispatchSlots))[0]!;
const result = (id: string) => h.api(`/v1/transcriptions/${id}/result`);

describe("single-slot arbiter", () => {
  test("never more than one provider call in flight, even with two worker processes and several jobs", async () => {
    h.tinfoil.handler = async (call) => {
      await Bun.sleep(15);
      return Response.json({ text: `words ${call}` });
    };
    const ids = [];
    for (const t of [TENANT_A, TENANT_B, tenant(3)]) ids.push(await h.submit(await audio("stereo_dense"), { tenant: t }));
    const second = h.withContext({ workerId: `test-worker-2:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(second);
    let concurrentJobs = 0;
    const watch = setInterval(async () => {
      const [row] = await h.ctx.db.select({ n: sql<number>`count(*)::int` }).from(transcriptions).where(eq(transcriptions.status, "processing"));
      concurrentJobs = Math.max(concurrentJobs, Number(row!.n));
    }, 5);
    const a = startBatchWorker(h.ctx, { sweep: false });
    const b = startBatchWorker(second, { sweep: false });
    await Promise.all(ids.map(async (id) => {
      for (let i = 0; i < 400 && (await h.row(id)).status !== "completed"; i++) await Bun.sleep(25);
    }));
    await a.stop();
    await b.stop();
    clearInterval(watch);
    for (const id of ids) expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.maxActive).toBe(1);
    expect(concurrentJobs).toBe(1);
    const perJob = await Promise.all(ids.map(async (id) => (await attempts(id)).length));
    expect(perJob).toEqual(await Promise.all(ids.map(async (id) => (await regions(id)).length)));
    expect(h.tinfoil.calls.length).toBe(perJob.reduce((x, y) => x + y, 0));
  }, 60_000);

  test("happy path: separate channels become speakers with region timestamps; audio is deleted and verified", async () => {
    const id = await h.submit(await audio("stereo"));
    expect(await h.work()).toBe(true);
    const body = await (await result(id)).json();
    expect(body).toMatchObject({
      status: "completed",
      provider: "tinfoil",
      model: "voxtral-small-24b",
      channels: 2,
      diarized: false,
      speakers: [{ id: "channel_0", name: "Speaker 1", channel: 0 }, { id: "channel_1", name: "Speaker 2", channel: 1 }],
      stats: { tinfoil_calls: 2 },
    });
    expect(body.segments.map((s: any) => [s.speaker_id, s.start, s.end])).toEqual([["channel_0", 0.25, 2.75], ["channel_1", 3.25, 5.75]]);
    expect(body.text).toBe("Speaker 1: words 1\nSpeaker 2: words 2");
    const status = await (await h.api(`/v1/transcriptions/${id}`)).json();
    expect(status.retention).toMatchObject({ audio: "deleted", audio_deleted_at: expect.any(String), transcript_expires_at: expect.any(String) });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
  });

  test("m4a, webm (with and without a duration, or starting at 100 s), flac and mp4 with a video track transcribe like the mp3", async () => {
    const cases = [
      ["stereo_m4a", "audio/mp4"], ["stereo_webm", "audio/webm"], ["stereo_webm_no_duration", "audio/webm"], ["stereo_webm_offset", "audio/webm"],
      ["stereo_flac", "audio/flac"], ["stereo_mp4_with_video", "audio/mp4"],
    ] as const;
    for (const [fixture, contentType] of cases) {
      const id = await h.submit(await audio(fixture), { contentType });
      expect(await h.row(id)).toMatchObject({ channels: 2, durationSeconds: expect.closeTo(7, 0) });
      await h.work();
      const body = await (await result(id)).json();
      expect({ fixture, status: body.status, speakers: body.segments.map((s: { speaker_id: string }) => s.speaker_id) })
        .toEqual({ fixture, status: "completed", speakers: ["channel_0", "channel_1"] });
    }
  });

  test("decoding stops at the duration cap even when the accepted recording is longer than its probe said", async () => {
    const id = await h.submit(await audio("stereo")); // ch0 speaks 0.5–2.5 s, ch1 3.5–5.5 s
    Object.assign(h.ctx.config.limits, { maxDurationSeconds: 2, acceptedMaxDurationSeconds: 3 });
    try {
      await h.work();
    } finally {
      Object.assign(h.ctx.config.limits, batchConfigFromEnv().limits, { diskHighWaterPercent: 99 });
    }
    const body = await (await result(id)).json();
    expect(body.segments.map((s: { speaker_id: string; end: number }) => [s.speaker_id, s.end <= 3])).toEqual([["channel_0", true]]);
  });

  test("mixed channel mode and mono recordings produce one speaker", async () => {
    const id = await h.submit(await audio("mono_wav"), { contentType: "audio/wav" });
    await h.work();
    const body = await (await result(id)).json();
    expect(body.speakers).toEqual([{ id: "channel_0", name: "Speaker 1", channel: 0 }]);
    expect(body.segments.length).toBe(1);
  });

  test("a silent recording fails no_speech without any provider call", async () => {
    const id = await h.submit(await audio("silent_wav"), { contentType: "audio/wav" });
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "no_speech", deletionState: "files_deleted" });
    expect(h.tinfoil.calls.length).toBe(0);
  });
});

describe("VAD coverage (TC-1045)", () => {
  const sentSeconds = (body: { segments: { start: number; end: number }[] }) => body.segments.reduce((sum, s) => sum + s.end - s.start, 0);

  test("narration over a steady noise floor reaches the model whole, and the result records the VAD coverage", async () => {
    const id = await h.submit(await audio("narration_mp3"));
    await h.work();
    const body = await (await result(id)).json();
    expect(body.status).toBe("completed");
    const { stats } = body;
    expect([stats.vad_fallback, typeof stats.voiced_seconds, typeof stats.dropped_above_floor_pct]).toEqual([false, "number", "number"]);
    expect(stats.voiced_seconds / body.duration_seconds).toBeGreaterThanOrEqual(0.9);
    expect(stats.dropped_above_floor_pct).toBeLessThanOrEqual(10);
    expect(stats.vad_mode).toBe("primary");
    for (const name of ["noise_floor_dbfs", "median_dbfs", "p99_dbfs", "speech_peak_s", "dropped_above_noise_pct"]) expect(typeof stats[name]).toBe("number");
    expect(stats.tinfoil_audio_seconds).toBeCloseTo(stats.voiced_seconds, 3);
    expect(sentSeconds(body)).toBeCloseTo(stats.voiced_seconds, 3);
    expect(await h.row(id)).toMatchObject({ vadFallback: false, vadDroppedAboveFloorPct: stats.dropped_above_floor_pct });
  });

  test("a quiet recording trips the coverage guard: the VAD falls back to the floor and still sends all of it", async () => {
    const id = await h.submit(await audio("quiet_narration_mp3"));
    await h.work();
    const body = await (await result(id)).json();
    expect(body.status).toBe("completed");
    expect(body.stats.vad_fallback).toBe(true);
    expect(body.stats.vad_mode).toBe("fallback");
    expect(body.stats.voiced_seconds / body.duration_seconds).toBeGreaterThanOrEqual(0.9);
    expect(body.stats.dropped_above_floor_pct).toBeLessThanOrEqual(10);
    expect(sentSeconds(body)).toBeCloseTo(body.stats.voiced_seconds, 3);
  });

  test("a recording shorter than one region fails no_speech, not processing_failed", async () => {
    const id = await h.submit(await audio("short_wav"), { contentType: "audio/wav" });
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "no_speech" });
    expect(h.tinfoil.calls.length).toBe(0);
  });

  test("when even the floor fallback leaves speech unsent, the job fails processing_failed before any call", async () => {
    const id = await h.submit(await audio("clicks_wav"), { contentType: "audio/wav" });
    // Unpadded, each 0.2 s click is shorter than a region at any threshold; the leading 2 s tone still forms one.
    const padMs = VAD.padMs;
    VAD.padMs = 0;
    try {
      await h.work();
    } finally {
      VAD.padMs = padMs;
    }
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "processing_failed", deletionState: "files_deleted" });
    expect(h.tinfoil.calls.length).toBe(0);
    expect(await regions(id)).toEqual([]);
    expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
  });

  test("regions kept across a re-claim keep their coverage stats; regions detected before TC-1045 complete with null stats", async () => {
    // Re-claim: the first claim detects and stores regions, then crashes before any dispatch.
    const resumed = await h.submit(await audio("narration_mp3"));
    h.faults.once("worker.after_regions", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash");
    const stored = await h.row(resumed);
    expect(stored.vadStats?.vad_mode).toBe("primary");
    expect([stored.vadFallback, typeof stored.vadDroppedAboveFloorPct]).toEqual([false, "number"]);
    // Sentinels: a resumed claim that re-ran detection would overwrite them.
    await h.ctx.db.update(transcriptions).set({ vadFallback: true, vadDroppedAboveFloorPct: 7.5, claimHeartbeatAt: new Date(Date.now() - 120_000) })
      .where(eq(transcriptions.id, resumed));
    expect(await h.work()).toBe(true);
    const body = await (await result(resumed)).json();
    expect([body.status, body.stats.vad_fallback, body.stats.dropped_above_floor_pct]).toEqual(["completed", true, 7.5]);
    expect(await h.row(resumed)).toMatchObject({ vadStats: stored.vadStats });
    expect(body.stats).toMatchObject(stored.vadStats!);

    // Legacy: regions inserted the way the previous image did, without the coverage columns.
    const legacy = await h.submit(await audio("stereo"));
    const claim = (await claimNext(h.ctx))!;
    await h.ctx.db.transaction(async (tx) => {
      await holdFence(tx, claim.fence);
      await insertRegions(tx, claim.fence, [{ channel: 0, startMs: 250, endMs: 2_750 }, { channel: 1, startMs: 3_250, endMs: 5_750 }]);
    });
    await processClaim(h.ctx, claim);
    const old = await (await result(legacy)).json();
    expect([old.status, old.stats.voiced_seconds, old.stats.dropped_above_floor_pct, old.stats.vad_fallback]).toEqual(["completed", 5, null, null]);
    expect(old.stats).not.toHaveProperty("vad_mode");
    expect(old.stats).not.toHaveProperty("dropped_above_noise_pct");
  });

  test("TC-1093: a crash between region insert and stats write rolls back both", async () => {
    const id = await h.submit(pcmToWav(pcmFromLevels(quietSpeechLevels()), PCM_RATE), { contentType: "audio/wav" });
    h.faults.once("worker.regions_inserted", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash at worker.regions_inserted");
    expect(await regions(id)).toEqual([]);
    expect((await h.row(id)).vadStats).toBeNull();
    expect(h.tinfoil.calls).toEqual([]);
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    expect(await h.work()).toBe(true);
    expect((await regions(id)).length).toBeGreaterThan(0);
    expect((await h.row(id)).vadStats?.vad_mode).toBe("quiet");
    const body = await (await result(id)).json();
    expect(body.status).toBe("completed");
    expect(body.stats).toMatchObject({ vad_mode: "quiet", vad_fallback: false });
  });

  test("TC-1093: quiet PCM stats survive re-claim and appear unchanged in result JSON", async () => {
    const pcm = pcmFromLevels(quietSpeechLevels());
    const energies = Float64Array.from({ length: 1_000 }, (_, f) => {
      let sum = 0;
      for (let s = f * 1_600; s < (f + 1) * 1_600; s++) sum += (pcm[s]! / 32768) ** 2;
      return 20 * Math.log10(Math.sqrt(sum / 1_600));
    });
    const expected = detectSpeech(energies).stats;
    const id = await h.submit(pcmToWav(pcm, PCM_RATE), { contentType: "audio/wav" });
    h.faults.once("worker.after_regions", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash");
    expect((await h.row(id)).vadStats).toEqual(expected);
    expect(await h.ctx.db.execute(sql`select jsonb_typeof(vad_stats) as kind from transcriptions where id = ${id}`)).toEqual([{ kind: "object" }]);
    // A retry must use the committed diagnostics even if quiet mode is switched off meanwhile.
    h.ctx.config.vad.quietMode = false;
    try {
      await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
      await h.work();
    } finally {
      h.ctx.config.vad.quietMode = true;
    }
    const body = await (await result(id)).json();
    expect(body.status).toBe("completed");
    expect(body.stats).toMatchObject({ ...expected, vad_mode: "quiet", dropped_above_noise_pct: 0, vad_fallback: false, voiced_seconds: 22, tinfoil_audio_seconds: 22 });
    expect(sentSeconds(body)).toBe(22);
  });

  test("TC-1093 rollback flag restores PR 1 regions while still reporting diagnostics", async () => {
    h.ctx.config.vad.quietMode = false;
    try {
      const id = await h.submit(pcmToWav(pcmFromLevels(quietSpeechLevels()), PCM_RATE), { contentType: "audio/wav" });
      await h.work();
      const body = await (await result(id)).json();
      expect(body.stats).toMatchObject({ vad_mode: "primary", vad_fallback: false, voiced_seconds: 1.5, dropped_above_noise_pct: 90.9 });
    } finally {
      h.ctx.config.vad.quietMode = true;
    }
  });

  test("TC-1093: separate stereo reports quiet precedence and retains the other channel's fallback flag", async () => {
    const quiet = pcmFromLevels(quietSpeechLevels());
    const fallback = pcmFromLevels(new Float64Array(1_000).fill(-46));
    const interleaved = new Int16Array(quiet.length * 2);
    for (let s = 0; s < quiet.length; s++) {
      interleaved[2 * s] = quiet[s]!;
      interleaved[2 * s + 1] = fallback[s]!;
    }
    const wav = pcmToWav(interleaved, PCM_RATE);
    const header = new DataView(wav.buffer, wav.byteOffset, wav.byteLength);
    header.setUint16(22, 2, true); // channels
    header.setUint32(28, PCM_RATE * 4, true); // byte rate
    header.setUint16(32, 4, true); // block alignment
    const id = await h.submit(wav, { contentType: "audio/wav", body: { channel_mode: "separate" } });
    await h.work();
    const body = await (await result(id)).json();
    expect(body).toMatchObject({ status: "completed", channels: 2, stats: { vad_mode: "quiet", vad_fallback: true, voiced_seconds: 122 } });
    expect((await h.row(id)).vadStats?.vad_mode).toBe("quiet");
  });
});

describe("region insert", () => {
  // Postgres binds at most 65,535 parameters per statement; ~12,000 regions is the 2 h stereo worst case.
  const many = Array.from({ length: 12_345 }, (_, i) => ({ channel: i % 2, startMs: i * 600, endMs: i * 600 + 400 }));

  test("one statement cannot hold 12,000+ regions (the bind limit this guards against)", async () => {
    await h.submit(await audio("stereo"));
    const claim = (await claimNext(h.ctx))!;
    const rows = many.map((r, ordinal) => ({ transcriptionId: claim.fence.id, ordinal, ...r, status: "pending", generation: claim.fence.generation }));
    await expect(h.ctx.db.insert(transcriptionRegions).values(rows).execute()).rejects.toThrow();
    expect((await regions(claim.fence.id)).length).toBe(0);
  });

  test("insertRegions writes 12,000+ regions in chunks inside one fenced transaction", async () => {
    await h.submit(await audio("stereo"));
    const claim = (await claimNext(h.ctx))!;
    expect(many.length).toBeGreaterThan(10 * REGION_INSERT_CHUNK);
    await h.ctx.db.transaction(async (tx) => {
      await holdFence(tx, claim.fence);
      await insertRegions(tx, claim.fence, many);
    });
    const stored = (await regions(claim.fence.id)).sort((a, b) => a.ordinal - b.ordinal);
    expect(stored.length).toBe(many.length);
    expect(stored.every((r, i) => r.ordinal === i && r.startMs === many[i]!.startMs && r.channel === many[i]!.channel && r.generation === claim.fence.generation)).toBe(true);
  });

  test("a failure in a later chunk (int4 overflow) rolls back every earlier chunk", async () => {
    await h.submit(await audio("stereo"));
    const claim = (await claimNext(h.ctx))!;
    const broken = [...many.slice(0, 2 * REGION_INSERT_CHUNK + 5), { channel: 0, startMs: 2 ** 40, endMs: 2 ** 40 + 400 }];
    await expect(h.ctx.db.transaction(async (tx) => {
      await holdFence(tx, claim.fence);
      await insertRegions(tx, claim.fence, broken);
    })).rejects.toThrow();
    expect((await regions(claim.fence.id)).length).toBe(0);
  });
});

describe("diarization", () => {
  // stereo_dense mixed down: one voice at 0–1.5, 4–5.5, 8–9.5, 12–13.5 s, the other at 2–3.5, 6–7.5, 10–11.5, 14–15.5 s.
  const alternating = [0, 2, 4, 6, 8, 10, 12, 14].map((s, i) => ({ startMs: s * 1000, endMs: s * 1000 + 1_500, speaker: i % 2 ? 3 : 7 }));
  afterEach(() => {
    h.ctx.diarizer = null;
    h.ctx.config.vad.quietMode = true;
  });

  async function synthetic(levels = quietSpeechLevels()) {
    const pcm = pcmFromLevels(levels), path = join(h.uploadDir, "expected.pcm");
    await Bun.write(path, pcm);
    const energies = await frameEnergies(path);
    await rm(path);
    return { bytes: pcmToWav(pcm, PCM_RATE), energies };
  }

  test("TC-1093: short quiet diarized PCM retains selected fallback when the peak gate misses", async () => {
    // Repo-generated single-mic envelope, not a production replay: 40 s, quiet median, just 200 ms of peaks.
    const levels = new Float64Array(400).fill(-53);
    levels.fill(-49, 50, 150); levels.fill(-49, 250, 350); levels.fill(-31, 100, 102);
    const audio = await synthetic(levels), selected = detectSpeech(audio.energies);
    expect(selected).toMatchObject({ fallback: true, covered: true, stats: { vad_mode: "fallback", speech_peak_s: 0.2 } });
    const segments = [{ startMs: 10_000, endMs: 14_000, speaker: 7 }];
    h.ctx.diarizer = { diarize: async () => segments };
    for (const enabled of [true, false]) {
      h.ctx.config.vad.quietMode = enabled;
      const id = await h.submit(audio.bytes, { contentType: "audio/wav", body: { diarize: true } });
      await h.work();
      const body = await (await result(id)).json();
      expect(body).toMatchObject({ status: "completed", diarized: true,
        stats: { vad_mode: "fallback", vad_fallback: true, speech_peak_s: 0.2, voiced_seconds: 40,
          tinfoil_audio_seconds: 40, dropped_above_floor_pct: 0, dropped_above_noise_pct: 0 },
      });
      expect(await h.row(id)).toMatchObject({ status: "completed", errorCode: null, vadFallback: true, vadDroppedAboveFloorPct: 0 });
      const saved = (await regions(id)).sort((a, b) => a.startMs - b.startMs);
      expect(saved.filter((r) => r.speaker === 7).map(({ startMs, endMs, speaker }) => ({ startMs, endMs, speaker })))
        .toEqual(speakerTurns(segments, audio.energies));
      for (const [i, r] of saved.entries()) {
        expect(r.endMs - r.startMs).toBeLessThanOrEqual(30_000);
        if (i) expect(r.startMs).toBe(saved[i - 1]!.endMs);
      }
      expect(saved[0]!.startMs).toBe(0);
      expect(saved.at(-1)!.endMs).toBe(40_000);
      expect(saved.filter((r) => r.speaker !== 7).every((r) => r.speaker === UNKNOWN_SPEAKER)).toBe(true);
    }
  });

  test("TC-1093: diarized final coverage fails closed before dispatch when selected fallback still drops speech", async () => {
    h.ctx.diarizer = { diarize: async () => [{ startMs: 0, endMs: 2_000, speaker: 7 }] };
    const id = await h.submit(await audio("clicks_wav"), { contentType: "audio/wav", body: { diarize: true } });
    const padMs = VAD.padMs;
    VAD.padMs = 0;
    try {
      await h.work();
    } finally {
      VAD.padMs = padMs;
    }
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "processing_failed",
      errorMessage: "Speech detection could not cover the recording", deletionState: "files_deleted" });
    expect(h.tinfoil.calls).toEqual([]);
    expect(await regions(id)).toEqual([]);
    expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
  });

  test("diarized quiet speech adds missed audio once, exposes quiet stats and gives unknown a valid result id", async () => {
    const audio = await synthetic();
    const segments = [{ startMs: 12_000, endMs: 13_000, speaker: 7 }, { startMs: 70_000, endMs: 70_500, speaker: 3 }];
    h.ctx.diarizer = { diarize: async () => segments };
    const id = await h.submit(audio.bytes, { contentType: "audio/wav", body: { diarize: true } });
    await h.work();
    const body = await (await result(id)).json();
    expect(body).toMatchObject({ status: "completed", diarized: true, channels: 1,
      speakers: [{ id: "speaker_0", name: "Speaker 1", channel: 0 }, { id: "speaker_1", name: "Speaker 2", channel: 0 }, { id: "speaker_2", name: "Unknown speaker", channel: 0 }],
      stats: { vad_mode: "quiet", vad_fallback: false, tinfoil_calls: 5, tinfoil_audio_seconds: 23, voiced_seconds: 23,
        dropped_above_floor_pct: 0, dropped_above_noise_pct: 0 },
    });
    const saved = (await regions(id)).sort((a, b) => a.startMs - b.startMs);
    expect(saved.some((r) => r.speaker === UNKNOWN_SPEAKER)).toBe(true);
    expect(body.stats).toMatchObject(summarizeVad([{ energies: audio.energies, regions: saved, mode: "quiet" }]));
    for (const [i, r] of saved.entries()) {
      expect(r.endMs - r.startMs).toBeLessThanOrEqual(30_000);
      if (i) expect(r.startMs).toBeGreaterThanOrEqual(saved[i - 1]!.endMs);
    }
    expect(h.tinfoil.calls.map((call) => call.filename)).toEqual(saved.map((r) => `${id}-${r.ordinal}.wav`));
    expect(body.segments.every((s: { speaker_id: string }) => body.speakers.some((p: { id: string }) => p.id === s.speaker_id))).toBe(true);
    expect(body.text).toStartWith("Unknown speaker: words 1");
    expect(body.segments.map((s: { speaker_id: string }) => s.speaker_id)).toEqual(["speaker_2", "speaker_0", "speaker_2", "speaker_2", "speaker_1"]);
    // The same known speakers have the same ids and names with quiet coverage disabled.
    h.ctx.config.vad.quietMode = false;
    const normalId = await h.submit(audio.bytes, { contentType: "audio/wav", body: { diarize: true } });
    await h.work();
    const normal = await (await result(normalId)).json();
    expect(body.speakers.filter((s: { name: string }) => s.name !== "Unknown speaker"))
      .toEqual(normal.speakers.filter((s: { name: string }) => s.name !== "Unknown speaker"));
  });

  test("an empty diarizer result recovers gated speech with one valid unknown speaker", async () => {
    const audio = await synthetic();
    h.ctx.diarizer = { diarize: async () => [] };
    const id = await h.submit(audio.bytes, { contentType: "audio/wav", body: { diarize: true } });
    await h.work();
    const body = await (await result(id)).json();
    expect(body).toMatchObject({ status: "completed", diarized: true,
      speakers: [{ id: "speaker_0", name: "Unknown speaker", channel: 0 }],
      stats: { voiced_seconds: 22, vad_mode: "quiet", dropped_above_noise_pct: 0 },
    });
  });


  test("a non-diarized quiet job retains #99 intervals and stats and never calls the diarizer", async () => {
    const audio = await synthetic();
    h.ctx.diarizer = { diarize: async () => { throw new Error("non-diarized job called diarizer"); } };
    const id = await h.submit(audio.bytes, { contentType: "audio/wav", body: { channel_mode: "mixed", diarize: false } });
    await h.work();
    const body = await (await result(id)).json(), expected = detectSpeech(audio.energies);
    expect((await regions(id)).map(({ startMs, endMs }) => ({ startMs, endMs }))).toEqual(expected.regions);
    expect(body.stats).toMatchObject(expected.stats);
    expect(body).toMatchObject({ status: "completed", diarized: false, speakers: [{ id: "channel_0", name: "Speaker 1", channel: 0 }],
      stats: { tinfoil_calls: 2, tinfoil_audio_seconds: 22, voiced_seconds: 22, vad_fallback: false },
    });
  });

  test("diarized quiet coverage and stats roll back together and survive a flag change on re-claim", async () => {
    const audio = await synthetic();
    h.ctx.diarizer = { diarize: async () => [{ startMs: 12_000, endMs: 13_000, speaker: 7 }] };
    const id = await h.submit(audio.bytes, { contentType: "audio/wav", body: { diarize: true } });
    h.faults.once("worker.regions_inserted", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash");
    expect(await regions(id)).toEqual([]);
    expect((await h.row(id)).vadStats).toBeNull();
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    h.faults.once("worker.after_regions", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash");
    const saved = await regions(id), stats = (await h.row(id)).vadStats;
    expect(stats?.vad_mode).toBe("quiet");
    h.ctx.config.vad.quietMode = false;
    h.ctx.diarizer = { diarize: async () => { throw new Error("saved regions must not be redetected"); } };
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    await h.work();
    expect((await regions(id)).map(({ startMs, endMs, speaker }) => ({ startMs, endMs, speaker })))
      .toEqual(saved.map(({ startMs, endMs, speaker }) => ({ startMs, endMs, speaker })));
    const body = await (await result(id)).json();
    expect(body.status).toBe("completed");
    expect(body.stats).toMatchObject(stats!);
  });

  test("diarize: true sends each speaker turn of the mono mix once and labels speakers by first appearance", async () => {
    h.ctx.diarizer = { diarize: async () => alternating };
    const id = await h.submit(await audio("stereo_dense"), { body: { diarize: true } });
    await h.work();
    const body = await (await result(id)).json();
    expect(body).toMatchObject({
      status: "completed",
      diarized: true,
      channels: 1,
      speakers: [{ id: "speaker_0", name: "Speaker 1", channel: 0 }, { id: "speaker_1", name: "Speaker 2", channel: 0 }],
      stats: { tinfoil_calls: 8 },
    });
    // Turns are padded 0.25 s into the 0.5 s gaps, so neighbours meet without overlapping.
    expect(body.segments.map((s: { speaker_id: string; channel: number; start: number; end: number }) => [s.speaker_id, s.channel, s.start, s.end])).toEqual([
      ["speaker_0", 0, 0, 1.75], ["speaker_1", 0, 1.75, 3.75], ["speaker_0", 0, 3.75, 5.75], ["speaker_1", 0, 5.75, 7.75],
      ["speaker_0", 0, 7.75, 9.75], ["speaker_1", 0, 9.75, 11.75], ["speaker_0", 0, 11.75, 13.75], ["speaker_1", 0, 13.75, 15.75],
    ]);
    expect(body.text.split("\n").slice(0, 2)).toEqual(["Speaker 1: words 1", "Speaker 2: words 2"]);
  });

  test("a diarizer failure fails the job before any provider call", async () => {
    h.ctx.diarizer = { diarize: async () => { throw new Error("diarizer exited 134"); } };
    const id = await h.submit(await audio("stereo"), { body: { diarize: true } });
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "processing_failed", errorMessage: "Speaker diarization failed", deletionState: "files_deleted" });
    expect(h.tinfoil.calls.length).toBe(0);
  });
});

describe("provider outcomes", () => {
  const ambiguous: [string, () => Response | Promise<Response>][] = [
    ["timeout", () => { const e = new Error("timed out"); e.name = "TimeoutError"; throw e; }],
    ["connection reset", () => { const e = new Error("reset") as Error & { code: string }; e.code = "ECONNRESET"; throw e; }],
    ["5xx", () => new Response("down", { status: 503 })],
    ["unparseable body", () => new Response("<html>", { status: 200 })],
    ["missing text", () => Response.json({ language: "en" })],
  ];
  for (const [label, respond] of ambiguous) {
    test(`ambiguous ${label}: exactly one call, never retried, job fails provider_outcome_unknown`, async () => {
      h.tinfoil.handler = respond;
      const id = await h.submit(await audio("stereo"));
      await h.work();
      expect(h.tinfoil.calls.length).toBe(1);
      expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown", deletionState: "files_deleted" });
      expect((await attempts(id)).map((a) => a.status)).toEqual(["ambiguous"]);
      expect((await regions(id)).find((r) => r.ordinal === 0)!.status).toBe("ambiguous");
      expect((await slot()).attemptId).toBeNull();
    });
  }

  test("429 storm honours Retry-After, then completes with no duplicate call per region", async () => {
    h.tinfoil.handler = (call) => call <= 3 ? new Response("busy", { status: 429, headers: { "Retry-After": call === 1 ? "1" : "0" } }) : Response.json({ text: `ok ${call}` });
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.calls.length).toBe(5);
    expect(h.tinfoil.calls[1]!.at - h.tinfoil.calls[0]!.at).toBeGreaterThanOrEqual(990);
    const statuses = (await attempts(id)).sort((a, b) => a.regionOrdinal - b.regionOrdinal || a.ordinal - b.ordinal).map((a) => `${a.regionOrdinal}:${a.status}`);
    expect(statuses).toEqual(["0:rate_limited", "0:rate_limited", "0:rate_limited", "0:succeeded", "1:succeeded"]);
  }, 30_000);

  test("20 consecutive 429s fail the job provider_unavailable after exactly 20 calls", async () => {
    h.tinfoil.handler = () => new Response("busy", { status: 429, headers: { "Retry-After": "0" } });
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect(h.tinfoil.calls.length).toBe(20);
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
  });

  test("pre-send failures are retried (at most 5 attempts); a provably-unsent request is not ambiguous", async () => {
    let n = 0;
    h.tinfoil.handler = () => {
      if (++n <= 2) { const e = new Error("refused") as Error & { code: string }; e.code = "ConnectionRefused"; throw e; }
      return Response.json({ text: "ok" });
    };
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect((await attempts(id)).filter((a) => a.status === "not_sent").length).toBe(2);

    h.tinfoil.calls = [];
    h.tinfoil.handler = () => { const e = new Error("refused") as Error & { code: string }; e.code = "ConnectionRefused"; throw e; };
    const failing = await h.submit(await audio("stereo"), { tenant: TENANT_B });
    await h.work();
    expect(h.tinfoil.calls.length).toBe(5);
    expect(await h.row(failing)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
  });

  test("definite rejections: 400 → transcription_failed, 401 → provider_unavailable (operator fault)", async () => {
    h.tinfoil.handler = () => new Response("bad", { status: 400 });
    const rejected = await h.submit(await audio("stereo"));
    await h.work();
    expect(await h.row(rejected)).toMatchObject({ status: "failed", errorCode: "transcription_failed" });
    h.tinfoil.handler = () => new Response("no", { status: 401 });
    const unauthorized = await h.submit(await audio("stereo"), { tenant: TENANT_B });
    await h.work();
    expect(await h.row(unauthorized)).toMatchObject({ status: "failed", errorCode: "provider_unavailable" });
    expect(h.tinfoil.calls.length).toBe(2);
  });
});

describe("crash recovery", () => {
  test("a worker killed while a call is admitted: the attempt is ambiguous and never re-sent", async () => {
    const { SimulatedCrash } = await import("../../src/uploads/faults.ts");
    // The process dies after the request left: the provider saw one call, the worker never saw a response.
    const dying = h.withContext({
      provider: { model: "voxtral-small-24b", transcribe: async () => { h.tinfoil.calls.push({ filename: "sent", at: Date.now() }); throw new SimulatedCrash("worker died mid-request"); } } as never,
    });
    const id = await h.submit(await audio("stereo"));
    await expect(h.work(dying)).rejects.toThrow("simulated crash");
    expect((await slot()).attemptId).toBe(`${id}:r0:a1`);
    expect((await attempts(id)).map((a) => a.status)).toEqual(["started"]);
    // The dead process's heartbeats stop.
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    await h.ctx.db.update(transcriptionWorkers).set({ observedAt: new Date(0) }).where(eq(transcriptionWorkers.id, h.ctx.workerId));
    h.tinfoil.handler = () => Response.json({ text: "second call" });
    const replacement = h.withContext({ workerId: `replacement:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(replacement);
    expect(await h.work(replacement)).toBe(false);
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown", deletionState: "files_deleted" });
    expect((await attempts(id)).map((a) => [a.status, a.outcome])).toEqual([["ambiguous", "owner_lost"]]);
    expect((await slot()).attemptId).toBeNull();
    expect(h.tinfoil.calls.length).toBe(1);
  });

  test("a worker that died before any admission is requeued and resumed without duplicate calls", async () => {
    const id = await h.submit(await audio("stereo_dense"));
    let seen = 0;
    h.faults.on("worker.before_dispatch", () => (++seen === 3 ? "crash" : undefined));
    await expect(h.work()).rejects.toThrow("simulated crash");
    const beforeCalls = h.tinfoil.calls.length;
    expect(beforeCalls).toBe(2);
    await h.ctx.db.update(transcriptions).set({ claimHeartbeatAt: new Date(Date.now() - 120_000) }).where(eq(transcriptions.id, id));
    h.faults.clear();
    expect(await h.work()).toBe(true);
    const row = await h.row(id);
    expect(row).toMatchObject({ status: "completed", claimCount: 2 });
    const all = await attempts(id);
    expect(new Set(all.map((a) => a.regionOrdinal)).size).toBe(all.length); // one call per region, ever
    expect(h.tinfoil.calls.length).toBe((await regions(id)).length);
  });

  test("a crash after the terminal commit leaves deletion pending; the sweeper finishes it and lag returns to 0", async () => {
    const id = await h.submit(await audio("stereo"));
    h.faults.once("worker.after_terminal", "crash");
    await expect(h.work()).rejects.toThrow("simulated crash");
    expect(await h.row(id)).toMatchObject({ status: "completed", deletionState: "pending" });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(true);
    await h.ctx.db.update(transcriptions).set({ terminalAt: new Date(Date.now() - 600_000) }).where(eq(transcriptions.id, id));
    expect(await retentionLagSeconds(h.ctx.db)).toBeGreaterThanOrEqual(600);
    const degraded = await h.api("/health");
    expect((await degraded.json()).checks.upload_transcription.retention_lag_seconds).toBeGreaterThanOrEqual(600);
    expect(degraded.status).toBe(503);
    await runSweep(h.ctx);
    expect(await h.row(id)).toMatchObject({ deletionState: "files_deleted" });
    expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
    expect(await retentionLagSeconds(h.ctx.db)).toBe(0);
  });

  test("a failed unlink stays pending (terminal state was committed first) and the sweeper retries it", async () => {
    const id = await h.submit(await audio("stereo"));
    h.faults.once("deletion.after_unlink", "error");
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "completed", deletionState: "pending", deletionAttempts: 1 });
    await runSweep(h.ctx);
    expect(await h.row(id)).toMatchObject({ deletionState: "files_deleted" });
  });
});

describe("fencing: cancel/delete racing the worker at every boundary", () => {
  const boundaries: FaultPoint[] = ["worker.after_claim", "worker.after_decode", "worker.after_rename", "worker.after_regions", "worker.before_dispatch", "worker.after_response", "worker.before_assemble"];
  for (const action of ["cancel", "delete"] as const) {
    for (const point of boundaries) {
      test(`${action} at ${point}: no content is written, nothing is resurrected, the late response is discarded`, async () => {
        const id = await h.submit(await audio("stereo"));
        const before = (await h.row(id)).generation;
        h.faults.once(point, async () => {
          const res = action === "cancel"
            ? await h.api(`/v1/transcriptions/${id}/cancel`, { method: "POST" })
            : await h.api(`/v1/transcriptions/${id}`, { method: "DELETE" });
          expect(res.status).toBe(action === "cancel" ? 200 : 204);
        });
        await h.work();
        const row = await h.row(id);
        expect(row).toMatchObject({ status: "cancelled", tombstoned: action === "delete", deletionState: "files_deleted", claimToken: null });
        expect(row.generation).toBeGreaterThan(before + 1);
        expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
        // Cancel and delete both remove any partial text the worker committed before them.
        expect((await regions(id)).every((r) => r.text === null)).toBe(true);
        expect(row.transcriptDeletedAt).not.toBeNull();
        const settled = await attempts(id);
        if (point === "worker.after_response") expect(settled.map((a) => a.status)).toEqual(["discarded"]);
        expect(settled.every((a) => a.status !== "started")).toBe(true);
        expect((await slot()).attemptId).toBeNull();
        expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
        // A fenced-out worker cannot recreate the job directory later either.
        expect(await readdir(jobsRoot(h.uploadDir))).not.toContain(id);
        const expectedCalls = ["worker.after_response", "worker.before_assemble"].includes(point) ? (point === "worker.after_response" ? 1 : 2) : 0;
        expect(h.tinfoil.calls.length).toBe(expectedCalls);
        if (action === "delete") expect((await h.api(`/v1/transcriptions/${id}`)).status).toBe(404);
      });
    }
  }

  test("a processing timeout fences out the worker; its in-flight response is discarded", async () => {
    const id = await h.submit(await audio("stereo"));
    h.faults.once("worker.after_response", async () => {
      await h.ctx.db.update(transcriptions).set({ processingStartedAt: new Date(Date.now() - 5 * 3_600_000) }).where(eq(transcriptions.id, id));
      await runSweep(h.ctx);
    });
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "processing_timeout", deletionState: "files_deleted" });
    expect((await attempts(id)).map((a) => a.status)).toEqual(["discarded"]);
    expect(h.tinfoil.calls.length).toBe(1);
  });

  test("admission closed stops new claims; drain does not", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.ctx.db.execute(sql`update transcription_admission set mode = 'closed'`);
    expect(await claimNext(h.ctx)).toBeNull();
    await h.ctx.db.execute(sql`update transcription_admission set mode = 'drain'`);
    const claim = await claimNext(h.ctx);
    expect(claim?.job.id).toBe(id);
    await processClaim(h.ctx, claim!);
    expect((await h.row(id)).status).toBe("completed");
  });
});

describe("dispatch slot recovery", () => {
  // State a stale claim can leave behind while its owner's process heartbeat is still fresh (recoverStaleClaims
  // then keeps the slot): the slot names a started attempt of an already-terminal job.
  async function orphanSlot(ownerId: string) {
    const x = await h.submit(await audio("stereo"), { tenant: TENANT_B });
    await h.ctx.db.update(transcriptions).set({ status: "failed", errorCode: "provider_outcome_unknown", deletionState: "pending", terminalAt: new Date() }).where(eq(transcriptions.id, x));
    await h.ctx.db.insert(transcriptionAttempts).values({ id: `${x}:r0:a1`, transcriptionId: x, regionOrdinal: 0, ordinal: 1, generation: 1, status: "started" });
    await h.ctx.db.update(providerDispatchSlots).set({ attemptId: `${x}:r0:a1`, transcriptionId: x, ownerId, claimedAt: new Date() });
    return x;
  }

  test("a slot held by a live owner is never taken: the next job waits for that owner to settle", async () => {
    const owner = h.withContext({ workerId: `live-owner:${crypto.randomUUID()}` });
    await recordWorkerHeartbeat(owner);
    await orphanSlot(owner.workerId);
    const id = await h.submit(await audio("stereo"));
    const running = h.work();
    await Bun.sleep(400);
    expect(h.tinfoil.calls.length).toBe(0);
    const released = Date.now();
    await h.ctx.db.update(providerDispatchSlots).set({ attemptId: null, transcriptionId: null, ownerId: null, claimedAt: null });
    await running;
    expect((await h.row(id)).status).toBe("completed");
    expect(h.tinfoil.calls[0]!.at).toBeGreaterThanOrEqual(released);
  }, 30_000);

  test("a slot left by a dead owner is reclaimed: its attempt becomes ambiguous and is never re-sent", async () => {
    const x = await orphanSlot(`dead-owner:${crypto.randomUUID()}`);
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.row(id)).status).toBe("completed");
    expect((await attempts(x)).map((a) => [a.status, a.outcome])).toEqual([["ambiguous", "owner_lost"]]);
    expect((await slot()).attemptId).toBeNull();
    expect(h.tinfoil.calls.length).toBe((await regions(id)).length);
    expect(h.tinfoil.calls.every((c) => c.filename.startsWith(id))).toBe(true);
  }, 30_000);
});

describe("retention ledger", () => {
  test("a failed job's partial transcript text is deleted at its terminal transition", async () => {
    h.tinfoil.handler = (call) => call === 1 ? Response.json({ text: "partial words" }) : new Response("down", { status: 503 });
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect(await h.row(id)).toMatchObject({ status: "failed", errorCode: "provider_outcome_unknown" });
    expect((await regions(id)).map((r) => [r.status, r.text])).toEqual([["completed", null], ["ambiguous", null]]);
    const status = await (await h.api(`/v1/transcriptions/${id}`)).json();
    expect(status.retention.transcript_deleted_at).toEqual(expect.any(String));
  });

  test("the sweeper removes partial text a failed or cancelled job still holds (caller died mid-transition)", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.api(`/v1/transcriptions/${id}/cancel`, { method: "POST" });
    await h.ctx.db.insert(transcriptionRegions).values({ transcriptionId: id, ordinal: 0, channel: 0, startMs: 0, endMs: 1000, status: "completed", text: "left behind", generation: 1 });
    await h.ctx.db.update(transcriptions).set({ transcriptDeletedAt: null }).where(eq(transcriptions.id, id));
    await runSweep(h.ctx);
    expect((await regions(id)).map((r) => r.text)).toEqual([null]);
    expect((await h.row(id)).transcriptDeletedAt).not.toBeNull();
  });

  test("DELETE nulls content now and keeps a tombstone until files are verified gone + 7 days", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.work();
    expect((await h.api(`/v1/transcriptions/${id}`, { method: "DELETE" })).status).toBe(204);
    expect((await h.api(`/v1/transcriptions/${id}`)).status).toBe(404);
    expect((await h.api(`/v1/transcriptions/${id}`, { method: "DELETE" })).status).toBe(404);
    expect(await h.row(id)).toMatchObject({ tombstoned: true, deletionState: "files_deleted", transcriptDeletedAt: expect.any(Date) });
    expect(await h.ctx.db.select().from(transcriptionResults).where(eq(transcriptionResults.transcriptionId, id))).toEqual([]);
    expect((await regions(id)).every((r) => r.text === null)).toBe(true);
    await runSweep(h.ctx);
    expect(await h.ctx.db.select().from(transcriptions).where(eq(transcriptions.id, id))).toHaveLength(1);
    h.ctx.config.retention.tombstoneRetentionSeconds = 0;
    await runSweep(h.ctx);
    expect(await h.ctx.db.select().from(transcriptions).where(eq(transcriptions.id, id))).toHaveLength(0);
    expect(await attempts(id)).toHaveLength(0);
  });

  test("transcripts are deleted 24 h after completion when the app never deleted them", async () => {
    const id = await h.submit(await audio("stereo"));
    await h.work();
    await h.ctx.db.update(transcriptions).set({ transcriptExpiresAt: new Date(Date.now() - 1000) }).where(eq(transcriptions.id, id));
    await runSweep(h.ctx);
    const res = await result(id);
    expect({ status: res.status, code: (await res.json()).error.code }).toEqual({ status: 410, code: "transcript_expired" });
    expect((await regions(id)).every((r) => r.text === null)).toBe(true);
  });

  test("orphan and stray artifacts are reconciled away; reappearance after verified deletion alerts", async () => {
    const logs: Record<string, unknown>[] = [];
    const ctx = h.withContext({ log: { debug() {}, info() {}, warn() {}, error: (_m, d) => void logs.push(d ?? {}) } });
    await mkdir(join(jobsRoot(h.uploadDir), "trn_01M3PQ71Q9YF7GSEFP6S19ZJPW"));
    const id = await h.submit(await audio("stereo"));
    await h.work();
    await mkdir(jobDir(h.uploadDir, id));
    await runSweep(ctx);
    expect(await readdir(jobsRoot(h.uploadDir))).toEqual([]);
    expect(logs.some((l) => l.alert === true && l.transcriptionId === id)).toBe(true);
  });
});
