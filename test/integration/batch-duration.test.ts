import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { sql } from "drizzle-orm";
import { batchConfigFromEnv } from "../../src/uploads/config.ts";
import { audio, exists, startBatchHarness, TENANT_B, tenant, type BatchHarness } from "./batch-harness.ts";
import { jobDir } from "../../src/uploads/storage.ts";
import { PCM_RATE } from "../../src/uploads/audio.ts";
import { pcmToWav } from "../../src/providers/transcription/audio.ts";

let h: BatchHarness;
beforeAll(async () => { h = await startBatchHarness(); });
afterAll(async () => { await h.stop(); });
afterEach(async () => {
  await h.ctx.db.execute(sql`truncate table transcriptions, transcription_tenant_usage cascade`);
  Object.assign(h.ctx.config.limits, batchConfigFromEnv().limits, { diskHighWaterPercent: 99 });
  h.ctx.config.ffprobePath = "ffprobe";
  h.ctx.config.ffmpegPath = "ffmpeg";
  h.tinfoil.calls = [];
});

describe("TC-922 consumer contract", () => {
  test("public capabilities expose exact nominal/accepted/byte limits with no grace field", async () => {
    const response = await h.api("/v1/transcriptions/capabilities");
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      max_bytes: 186_496_800, max_duration_seconds: 10_800, accepted_max_duration_seconds: 11_101,
      max_channels: 2, content_types: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/mp4", "audio/webm", "audio/flac"],
      diarization: false, transcript_ttl_seconds: 86_400, admission: "open", ready: true,
    });
  });

  test("actual create accepts the full byte cap inclusively and rejects cap + 1", async () => {
    const bytes = await audio("stereo");
    const at = await h.create(bytes, { body: { byte_size: 186_496_800 } });
    expect(at.status).toBe(201);
    const over = await h.create(bytes, { tenant: TENANT_B, body: { byte_size: 186_496_801 } });
    expect(over.status).toBe(413);
    expect((await over.json()).error.code).toBe("recording_too_large");
  });

  for (const profile of ["defaults", "shipped compose"] as const) {
    const applyBudgetProfile = async () => {
      if (profile !== "shipped compose") return;
      const compose = Bun.YAML.parse(await Bun.file(new URL("../../infra/dstack-batch/app-compose.yaml", import.meta.url)).text()) as {
        services: { api: { environment: Record<string, string> } };
      };
      Object.assign(h.ctx.config.limits, {
        maxReservedBytes: Number(compose.services.api.environment.BATCH_MAX_RESERVED_BYTES),
        tenantDailyBytes: Number(compose.services.api.environment.BATCH_TENANT_DAILY_BYTES),
      });
    };
    test(`${profile}: byte reservation admits ten full-cap jobs inclusively, then rejects one extra byte`, async () => {
      await applyBudgetProfile();
      // Raise only the job-count gate so a byte-budget consumer error cannot hide behind that independent gate.
      h.ctx.config.limits.maxActiveJobs = 20;
      const bytes = await audio("stereo");
      for (let index = 1; index <= 10; index++) {
        expect((await h.create(bytes, { tenant: tenant(index), body: { byte_size: 186_496_800 } })).status).toBe(201);
      }
      const over = await h.create(bytes, { tenant: tenant(11), body: { byte_size: 1 } });
      expect(over.status).toBe(429);
      expect((await over.json()).error.code).toBe("service_busy");
    });

    test(`${profile}: daily budget admits three full-cap jobs inclusively, then rejects one extra byte`, async () => {
      await applyBudgetProfile();
      const bytes = await audio("stereo");
      for (let index = 0; index < 3; index++) {
        const created = await h.create(bytes, { body: { byte_size: 186_496_800 } });
        expect(created.status).toBe(201);
        const job = await created.json();
        expect((await h.api(`/v1/transcriptions/${job.id}/cancel`, { method: "POST" })).status).toBe(200);
      }
      const over = await h.create(bytes, { body: { byte_size: 1 } });
      expect(over.status).toBe(429);
      expect((await over.json()).error.code).toBe("quota_exceeded");
    });
  }

  test("small byte boundary exercises actual create and streamed PUT equality / one extra byte", async () => {
    const bytes = await audio("stereo");
    h.ctx.config.limits.maxBytes = bytes.byteLength;
    const at = await h.create(bytes);
    expect(at.status).toBe(201);
    const job = await at.json();
    const stream = (extra: boolean) => new ReadableStream<Uint8Array>({ start(c) {
      c.enqueue(bytes.subarray(0, 1));
      c.enqueue(bytes.subarray(1));
      if (extra) c.enqueue(new Uint8Array([0]));
      c.close();
    } });
    const overCreate = await h.create(bytes, { tenant: TENANT_B, body: { byte_size: bytes.byteLength + 1 } });
    expect(overCreate.status).toBe(413);
    const overPut = await h.put(job.id, job.upload.capability, stream(true), { contentLength: bytes.byteLength });
    expect(overPut.status).toBe(400);
    expect((await overPut.json()).error.code).toBe("upload_length_mismatch");
    expect((await h.row(job.id)).status).toBe("awaiting_upload");
    expect((await h.put(job.id, job.upload.capability, stream(false), { contentLength: bytes.byteLength })).status).toBe(201);
    expect((await h.row(job.id)).status).toBe("queued");
  });

  for (const [raw, accepted] of [["11101.000000", true], ["11101.0000625", false], ["11100.029388", true]] as const) {
    test(`PUT uses raw ffprobe ${raw} before rounding (accepted=${accepted})`, async () => {
      const command = join(h.uploadDir, "probe");
      await writeFile(command, `#!/bin/sh\ncat <<'PROBE'\n${JSON.stringify({ streams: [{ codec_type: "audio", channels: 2 }], format: { format_name: "mp3", duration: raw } })}\nPROBE\n`, { mode: 0o755 });
      h.ctx.config.ffprobePath = command;
      const bytes = await audio("stereo");
      const job = await (await h.create(bytes)).json();
      const uploaded = await h.put(job.id, job.upload.capability, bytes);
      expect(uploaded.status).toBe(accepted ? 201 : 422);
      if (accepted) {
        const row = await h.row(job.id);
        expect(row.status).toBe("queued");
        // The existing Postgres real column stores float32; admission still compares the original raw double.
        expect(row.durationSeconds).toBeCloseTo(Math.round(Number(raw) * 1000) / 1000, 3);
      } else {
        expect((await uploaded.json()).error).toMatchObject({ code: "upload_rejected", job_error: { code: "recording_too_long" } });
        expect(await h.row(job.id)).toMatchObject({ status: "failed", deletionState: "files_deleted" });
        expect(await exists(jobDir(h.uploadDir, job.id))).toBe(false);
      }
      expect(h.tinfoil.calls).toHaveLength(0);
      await rm(command);
    });
  }

  test("full accepted tail passes through real decode and provider dispatch beyond nominal (scaled fixture)", async () => {
    // Exactly 8 decoded seconds, with the only speech in the final second. A nominal cutoff loses all of it.
    const pcm = new Int16Array(8 * PCM_RATE);
    for (let sample = 7 * PCM_RATE; sample < pcm.length; sample++) pcm[sample] = Math.round(4_000 * Math.sin(2 * Math.PI * 440 * sample / PCM_RATE));
    const id = await h.submit(pcmToWav(pcm, PCM_RATE), { contentType: "audio/wav" });
    // Scale after admission so old-main RED specifically catches the worker cutting off the accepted tail.
    Object.assign(h.ctx.config.limits, { maxDurationSeconds: 3, acceptedMaxDurationSeconds: 8 });
    expect(await h.work()).toBe(true);
    const body = await (await h.api(`/v1/transcriptions/${id}/result`)).json();
    expect(body.status).toBe("completed");
    expect(body.duration_seconds).toBe(8);
    expect(body.segments.map((s: any) => [s.speaker_id, s.start, s.end])).toEqual([["channel_0", 6.75, 8]]);
    expect(body.stats.tinfoil_calls).toBe(1);
  });

  test("ordinary note keeps its channels, timestamps, model and completion behavior", async () => {
    const decoder = join(h.uploadDir, "ffmpeg");
    const calls = join(h.uploadDir, "decode-args");
    await writeFile(decoder, `#!/bin/sh\nprintf '%s\\n' "$@" >> '${calls}'\nexec ffmpeg "$@"\n`, { mode: 0o755 });
    h.ctx.config.ffmpegPath = decoder;
    const id = await h.submit(await audio("stereo"));
    await h.work();
    const body = await (await h.api(`/v1/transcriptions/${id}/result`)).json();
    expect(body).toMatchObject({ status: "completed", provider: "tinfoil", model: "whisper-large-v3-turbo", channels: 2, stats: { tinfoil_calls: 2 } });
    expect(body.segments.map((s: any) => [s.speaker_id, s.start, s.end])).toEqual([["channel_0", 0.25, 2.75], ["channel_1", 3.25, 5.75]]);
    expect(await exists(jobDir(h.uploadDir, id))).toBe(false);
    const args = (await readFile(calls, "utf8")).trim().split("\n");
    const caps = args.flatMap((arg, index) => arg === "-fs" ? [args[index + 1]] : []);
    expect(caps).toEqual(["355232000", "355232000"]); // 11101 seconds × 16000 mono samples/s × 2 bytes
    await rm(decoder);
    await rm(calls);
  });
});
