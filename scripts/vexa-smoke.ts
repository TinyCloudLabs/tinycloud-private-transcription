#!/usr/bin/env bun
/**
 * Happy-path gate for the meeting-capture rig:
 *   1. Alice (fake participant, fixtures/alice.wav on loop) joins a fresh local Jitsi room.
 *   2. We ask Vexa (upstream stack, infra/vexa) for a bot via POST /bots.
 *   3. Poll GET /bots/status + GET /transcripts/jitsi/{native_meeting_id} until the transcript
 *      contains "brown fox" (case-insensitive) with a non-empty speaker label.
 *   4. DELETE /bots/jitsi/{native_meeting_id}; wait for the meeting to reach a terminal status.
 * Raw Vexa payloads are written to tmp/ (POST /bots response, every distinct status snapshot,
 * the transcript JSON, DELETE response, final meeting record) for the API team's adapter typing.
 *
 * Env: VEXA_API_URL (http://localhost:18066)  VEXA_ADMIN_URL (http://localhost:18057)
 *      VEXA_ADMIN_TOKEN (dev-admin-token)      VEXA_API_KEY (minted via admin-api if unset)
 *      JITSI_BASE_URL (https://jitsi.local:8443) SMOKE_ROOM (random)  ALICE_SECONDS (90)
 *      SMOKE_TIMEOUT_S (240)
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { runFakeParticipant } from "./fake-participant";

const API = process.env.VEXA_API_URL ?? "http://localhost:18066";
const ADMIN = process.env.VEXA_ADMIN_URL ?? "http://localhost:18057";
const ADMIN_TOKEN = process.env.VEXA_ADMIN_TOKEN ?? "dev-admin-token";
const JITSI = (process.env.JITSI_BASE_URL ?? "https://jitsi.local:8443").replace(/\/$/, "");
const ROOM = process.env.SMOKE_ROOM ?? `ptx-smoke-${Date.now().toString(36)}`;
const ALICE_SECONDS = Number(process.env.ALICE_SECONDS ?? 90);
const TIMEOUT_S = Number(process.env.SMOKE_TIMEOUT_S ?? 240);
const EXPECT = /brown fox/i;
const OUT = "tmp";
mkdirSync(OUT, { recursive: true });

const log = (m: string) => console.log(`[vexa-smoke ${new Date().toISOString().slice(11, 19)}] ${m}`);
const save = (name: string, data: unknown) => writeFileSync(`${OUT}/${name}`, JSON.stringify(data, null, 2) + "\n");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function mintApiKey(): Promise<string> {
  const h = { "X-Admin-API-Key": ADMIN_TOKEN, "Content-Type": "application/json" };
  const email = "self-host@vexa.ai";
  let r = await fetch(`${ADMIN}/admin/users/email/${email}`, { headers: h });
  let user: any = r.ok ? await r.json() : null;
  if (!user) {
    r = await fetch(`${ADMIN}/admin/users`, { method: "POST", headers: h, body: JSON.stringify({ email, max_concurrent_bots: 5 }) });
    if (!r.ok) throw new Error(`admin create user failed: ${r.status} ${await r.text()}`);
    user = await r.json();
  }
  r = await fetch(`${ADMIN}/admin/users/${user.id}/tokens?scopes=bot,tx`, { method: "POST", headers: h });
  if (!r.ok) throw new Error(`admin mint token failed: ${r.status} ${await r.text()}`);
  const tok = (await r.json()) as { token: string };
  return tok.token;
}

async function main() {
  const apiKey = process.env.VEXA_API_KEY ?? (await mintApiKey());
  const H = { "X-API-Key": apiKey, "Content-Type": "application/json" };
  const meetingUrl = `${JITSI}/${ROOM}`;
  const nativeId = `${ROOM}@${new URL(JITSI).hostname}`; // Vexa's jitsi convention: room@host (bare room only for meet.jit.si)
  log(`room=${meetingUrl} native_meeting_id=${nativeId} api=${API}`);

  // 1. Alice joins first (a live room for the bot to walk into) and keeps talking.
  const aliceLog: string[] = [];
  const alice = runFakeParticipant({
    url: meetingUrl, name: "Alice", seconds: ALICE_SECONDS,
    log: (m) => { aliceLog.push(m); log(`alice: ${m}`); },
  }).catch((e) => { log(`alice failed: ${e}`); throw e; });
  // Give her a moment to actually be in the conference before we spawn the bot.
  const t0 = Date.now();
  while (!aliceLog.some((l) => l.startsWith("joined")) && Date.now() - t0 < 60_000) await sleep(500);
  if (!aliceLog.some((l) => l.startsWith("joined"))) throw new Error("Alice never joined the room");

  // 2. Spawn the Vexa bot.
  const botBody = { platform: "jitsi", meeting_url: meetingUrl, bot_name: "TinyCloud Notetaker", language: "en" };
  save("vexa-post-bots-request.json", botBody);
  let r = await fetch(`${API}/bots`, { method: "POST", headers: H, body: JSON.stringify(botBody) });
  const botResp = await r.json().catch(() => ({}));
  save("vexa-post-bots-response.json", { http_status: r.status, body: botResp });
  log(`POST /bots → ${r.status} ${JSON.stringify(botResp).slice(0, 300)}`);
  if (!r.ok) throw new Error(`POST /bots failed: ${r.status}`);
  const meetingId: number | undefined = (botResp as any).id;

  // 3. Poll status + transcript until the phrase shows up.
  const statusesSeen: string[] = [];
  const snapshots: any[] = [];
  let transcript: any = null;
  let matched: any = null;
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    const st = await fetch(`${API}/bots/status`, { headers: H }).then((x) => x.json()).catch(() => null);
    const mine = st?.running?.find((m: any) => m.native_meeting_id === nativeId || m.id === meetingId);
    const status = mine?.status ?? "(not running)";
    if (statusesSeen.at(-1) !== status) { statusesSeen.push(status); snapshots.push({ at: new Date().toISOString(), status, bots_status_entry: mine ?? null }); log(`bot status → ${status}`); }
    const tr = await fetch(`${API}/transcripts/jitsi/${encodeURIComponent(nativeId)}`, { headers: H });
    if (tr.ok) {
      transcript = await tr.json();
      const segs: any[] = transcript.segments ?? [];
      const hit = segs.find((s) => EXPECT.test(String(s.text ?? "")));
      if (segs.length) log(`transcript: ${segs.length} segment(s); latest: ${JSON.stringify(segs.at(-1)).slice(0, 200)}`);
      if (hit) { matched = hit; break; }
    } else if (tr.status !== 404) {
      log(`GET /transcripts → ${tr.status}`);
    }
    await sleep(5000);
  }
  save("vexa-bots-status-snapshots.json", snapshots);
  if (transcript) save("vexa-transcript.json", transcript);

  // 4. Stop the bot, wait for terminal status, capture the final meeting record.
  r = await fetch(`${API}/bots/jitsi/${encodeURIComponent(nativeId)}`, { method: "DELETE", headers: H });
  const delBody = await r.json().catch(() => ({}));
  save("vexa-delete-bot-response.json", { http_status: r.status, body: delBody });
  log(`DELETE /bots → ${r.status} ${JSON.stringify(delBody).slice(0, 200)}`);
  let finalMeeting: any = null;
  const stopDeadline = Date.now() + 90_000;
  while (Date.now() < stopDeadline) {
    const list = await fetch(`${API}/meetings`, { headers: H }).then((x) => x.json()).catch(() => null);
    finalMeeting = list?.meetings?.find((m: any) => m.id === meetingId || m.native_meeting_id === nativeId) ?? null;
    const status = finalMeeting?.status;
    if (status && statusesSeen.at(-1) !== status) { statusesSeen.push(status); log(`meeting status → ${status}`); }
    if (status === "completed" || status === "failed") break;
    await sleep(3000);
  }
  if (finalMeeting) save("vexa-meeting-final.json", finalMeeting);
  const finalTr = await fetch(`${API}/transcripts/jitsi/${encodeURIComponent(nativeId)}`, { headers: H });
  if (finalTr.ok) { transcript = await finalTr.json(); save("vexa-transcript.json", transcript); }
  await alice.catch(() => {});

  const speaker = matched?.speaker;
  const ok = Boolean(matched) && typeof speaker === "string" && speaker.trim().length > 0;
  log(`statuses seen: ${statusesSeen.join(" → ")}`);
  log(`match: ${matched ? JSON.stringify(matched) : "none"}`);
  console.log(ok
    ? `\nPASS  transcript contains "brown fox" attributed to speaker "${speaker}" (${transcript?.segments?.length ?? 0} segments). Raw JSON in ${OUT}/.`
    : `\nFAIL  ${matched ? "phrase found but no speaker label" : `phrase not found within ${TIMEOUT_S}s`}; statuses: ${statusesSeen.join(" → ")}. See ${OUT}/ and: infra/vexa/compose.sh logs runtime meeting-api; sudo docker ps -a | grep bot`);
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
