#!/usr/bin/env bun
/**
 * Fake meeting participant for the capture rig: joins a Jitsi room in headless Chromium as
 * "Alice" with a fake microphone that plays a WAV on loop, stays N seconds, then hangs up.
 *
 *   bun run scripts/fake-participant.ts --url https://jitsi.local:8443/ptx-room-1 \
 *       [--name Alice] [--seconds 40] [--wav fixtures/alice.wav] [--resolve jitsi.local=127.0.0.1]
 *
 * Chromium flags do the heavy lifting: --use-fake-device-for-media-stream +
 * --use-fake-ui-for-media-stream (auto-grant) + --use-file-for-fake-audio-capture=<wav>
 * (16-bit PCM WAV; Chromium loops it). TLS: the local Jitsi uses a dev CA, so we ignore HTTPS
 * errors here (host side only — the Vexa bot trusts the CA properly via its image).
 */
import { chromium, type Page } from "playwright";
import { resolve } from "node:path";
import { existsSync } from "node:fs";

// Browser global used inside page.evaluate callbacks (typechecked with Bun libs only).
declare const window: any;

export interface FakeParticipantOptions {
  url: string;
  name?: string;
  seconds?: number;
  wav?: string;
  /** Pass false to force JVB from the start (multi-participant recordings; see hash config below). */
  p2p?: boolean;
  /** host=ip mapping applied via --host-resolver-rules (default jitsi.local=127.0.0.1) */
  resolve?: string;
  headless?: boolean;
  log?: (msg: string) => void;
}

export async function runFakeParticipant(opts: FakeParticipantOptions): Promise<void> {
  const name = opts.name ?? "Alice";
  const seconds = opts.seconds ?? 40;
  const wav = resolve(opts.wav ?? "fixtures/alice.wav");
  const log = opts.log ?? ((m: string) => console.log(`[fake-participant] ${m}`));
  if (!existsSync(wav)) throw new Error(`WAV fixture not found: ${wav} (run scripts/make-fixture.sh)`);
  const [rHost, rIp] = (opts.resolve ?? "jitsi.local=127.0.0.1").split("=");

  const browser = await chromium.launch({
    channel: "chromium", // full Chromium in new-headless mode (WebRTC + fake media devices work here)
    headless: opts.headless ?? true,
    args: [
      "--no-sandbox",
      "--use-fake-device-for-media-stream",
      "--use-fake-ui-for-media-stream",
      `--use-file-for-fake-audio-capture=${wav}`,
      "--autoplay-policy=no-user-gesture-required",
      `--host-resolver-rules=MAP ${rHost} ${rIp}`,
      "--disable-features=WebRtcHideLocalIpsWithMdns",
      "--ignore-certificate-errors", // dev CA; also covers worker/script fetches ignoreHTTPSErrors misses
    ],
  });
  const context = await browser.newContext({ ignoreHTTPSErrors: true, permissions: ["microphone"] });
  const page = await context.newPage();
  page.on("console", (m) => { if (m.type() === "error") log(`console.error: ${m.text().slice(0, 200)}`); });

  // Hash-config: set the display name and skip the prejoin screen so the join is deterministic.
  const u = new URL(opts.url);
  const hash = [
    `userInfo.displayName=${encodeURIComponent(JSON.stringify(name))}`,
    "config.prejoinConfig.enabled=false",
    "config.startWithAudioMuted=false",
    "config.startWithVideoMuted=true",
    "config.disableDeepLinking=true",
    // No P2P: with two humans + the bot, Jitsi would start P2P and re-negotiate to the JVB when the bot joins,
    // recreating the remote <audio> elements — Vexa v0.12's recording tap only mixes the elements present when
    // it starts, so one participant's audio would be missing from the persisted recording (docs/vexa-findings.md).
    ...(opts.p2p === false ? ["config.p2p.enabled=false"] : []),
  ].join("&");
  u.hash = hash;
  log(`navigating to ${u.toString()}`);
  await page.goto(u.toString(), { waitUntil: "domcontentloaded", timeout: 60_000 });

  await waitForJoined(page, 60_000, log);
  // Make sure the fake mic is live (a deployment may force startWithAudioMuted).
  for (let i = 0; i < 5; i++) {
    const muted = await page.evaluate(() => (window as any).APP?.conference?.isLocalAudioMuted?.());
    if (!muted) break;
    log("local audio muted after join — unmuting");
    await page.evaluate(() => (window as any).APP.conference.muteAudio(false));
    await page.waitForTimeout(1000);
  }
  const info = await page.evaluate(() => {
    const c = (window as any).APP.conference;
    return { me: c.getMyUserId?.(), participants: c.listMembers?.().length ?? null, muted: c.isLocalAudioMuted?.() };
  });
  log(`joined as "${name}" (${JSON.stringify(info)}); speaking for ${seconds}s`);

  const until = Date.now() + seconds * 1000;
  while (Date.now() < until) {
    await page.waitForTimeout(Math.min(5000, until - Date.now()));
    const n = await page.evaluate(() => (window as any).APP?.conference?.listMembers?.().length ?? -1).catch(() => -1);
    log(`… ${Math.max(0, Math.round((until - Date.now()) / 1000))}s left, remote participants=${n}`);
  }

  log("hanging up");
  await page.evaluate(() => (window as any).APP?.conference?.hangup?.(false)).catch(() => {});
  await page.waitForTimeout(1500);
  await context.close();
  await browser.close();
  log("left");
}

async function waitForJoined(page: Page, timeoutMs: number, log: (m: string) => void) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const joined = await page
      .evaluate(() => Boolean((window as any).APP?.conference?.isJoined?.()))
      .catch(() => false);
    if (joined) return;
    // Belt and braces: if a prejoin page appears anyway, fill the name and click join.
    const nameInput = page.locator("#premeeting-name-input, .prejoin-input-area input").first();
    if (await nameInput.isVisible({ timeout: 100 }).catch(() => false)) {
      log("prejoin page visible — filling name and joining");
      await nameInput.fill("");
      await nameInput.type("Alice", { delay: 20 });
      await page.locator('[data-testid="prejoin.joinMeeting"], .prejoin-preview-join-btn').first().click({ timeout: 5000 }).catch(() => {});
    }
    await page.waitForTimeout(500);
  }
  throw new Error(`fake participant did not join within ${timeoutMs}ms`);
}

function parseArgs(argv: string[]): FakeParticipantOptions {
  const o: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) { const k = a.slice(2); const v = argv[i + 1]; if (v && !v.startsWith("--")) { o[k] = v; i++; } else o[k] = "true"; }
  }
  if (!o.url) { console.error("usage: fake-participant.ts --url <jitsi room url> [--name Alice] [--seconds 40] [--wav fixtures/alice.wav] [--resolve jitsi.local=127.0.0.1] [--headed]"); process.exit(2); }
  return { url: o.url, name: o.name, seconds: o.seconds ? Number(o.seconds) : undefined, wav: o.wav, resolve: o.resolve, headless: o.headed !== "true" };
}

if (import.meta.main) {
  runFakeParticipant(parseArgs(process.argv.slice(2))).catch((e) => { console.error(e); process.exit(1); });
}
