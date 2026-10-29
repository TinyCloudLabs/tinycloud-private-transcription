import { ApiError } from "./errors.ts";

export type Platform = "google_meet" | "zoom" | "microsoft_teams" | "jitsi" | "signal";
export const PLATFORMS: Platform[] = ["google_meet", "zoom", "microsoft_teams", "jitsi", "signal"];

export interface DetectedPlatform {
  platform: Platform;
  /** Vexa's native_meeting_id when derivable from the URL, else null (Vexa derives it). */
  nativeMeetingId: string | null;
}

const singleSegment = (u: URL): string | null => {
  const parts = u.pathname.split("/").filter(Boolean);
  return parts.length === 1 && !/\s/.test(parts[0]) ? parts[0] : null;
};

const SIGNAL_KEY_ALPHABET = "bcdfghkmnpqrstxz";
const signalV0Key = new RegExp(`^[${SIGNAL_KEY_ALPHABET}]{4}(?:-[${SIGNAL_KEY_ALPHABET}]{4}){7}$`);
const signalV1Key = new RegExp(`^[${SIGNAL_KEY_ALPHABET}]{8}(?:-[${SIGNAL_KEY_ALPHABET}]{8}){3}-[${SIGNAL_KEY_ALPHABET}]{2}-[${SIGNAL_KEY_ALPHABET}]{8}$`);

/** Accept only Signal's current call-link shape without ever echoing the bearer capability. */
export function isSignalCallUrl(value: string): boolean {
  try {
    const url = new URL(value);
    const key = url.hash.startsWith("#key=") ? url.hash.slice(5) : "";
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "signal.link"
      && url.username === ""
      && url.password === ""
      && url.port === ""
      && url.pathname === "/call/"
      && url.search === ""
      && (signalV0Key.test(key) || signalV1Key.test(key));
  } catch {
    return false;
  }
}

const MEET_CODE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/i;
const BARE_CODE = /^[a-z]{10}$/i;
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const BARE_HOST = /^[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:[/?#:]|$)/i;
const MEET_LOOKUP_PATH = /^\/lookup\/([^/?#&=\s\x00-\x1f\x7f]+)\/?$/;

const INVITE_DELIMITERS: Readonly<Record<string, string>> = {
  "<": ">",
  "(": ")",
  "[": "]",
  '"': '"',
  "'": "'",
};

/** The canonical Meet link for a URL in one of the Meet shapes, else null. */
function meetCanonical(url: URL): string | null {
  const host = url.hostname.toLowerCase();
  if (url.protocol === "http:") {
    const code = url.pathname.slice(1);
    return host === "meet.google.com" && MEET_CODE.test(code)
      ? `https://meet.google.com/${code.toLowerCase()}` : null;
  }
  if (url.protocol !== "https:") return null;
  const segs = url.pathname.split("/").filter(Boolean);
  const canon = (code: string | undefined, keep: boolean) =>
    code !== undefined && MEET_CODE.test(code) ? `https://meet.google.com/${code.toLowerCase()}${keep ? url.search + url.hash : ""}` : null;
  if (host === "meet.google.com") {
    if (segs.length === 1) return canon(segs[0], true);
    return segs.length === 2 && (segs[0] === "meet" || segs[0] === "_meet") ? canon(segs[1], true) : null;
  }
  if (host === "google.com" || host === "www.google.com" || host === "g.co") {
    return segs.length === 2 && segs[0] === "meet" ? canon(segs[1], true) : null;
  }
  if (host === "tel.meet") return segs.length === 1 ? canon(segs[0], false) : null;
  return null;
}

const parseLoose = (value: string): URL | null => {
  const text = value.trim();
  if (!HAS_SCHEME.test(text) && !BARE_HOST.test(text)) return null;
  try {
    return new URL(HAS_SCHEME.test(text) ? text : `https://${text}`);
  } catch {
    return null;
  }
};

/**
 * Rewrites a pasted Google Meet link to `https://meet.google.com/<code>` (lowercase, no trailing
 * slash): `/meet/<code>`, `/_meet/<code>`, `google.com/meet/<code>`, `g.co/meet/<code>`,
 * `tel.meet/<code>`, a Google redirect (`google.com/url?q=`), `accounts.google.com?continue=`,
 * `meet.app.goo.gl?link=`, and a bare code with or without dashes. A wrapper whose target is not a
 * Meet link throws and is never followed. Lookup targets retain their URL and nickname identity.
 * Free text selects its first dashed-code or lookup target on the exact Meet host.
 * Other link-only inputs are returned unchanged. Details: TC-2181
 */
export function normalizeMeetingUrl(raw: string): string {
  const text = raw.trim();
  if (MEET_CODE.test(text)) return `https://meet.google.com/${text.toLowerCase()}`;
  if (BARE_CODE.test(text)) return `https://meet.google.com/${text.slice(0, 3)}-${text.slice(3, 7)}-${text.slice(7)}`.toLowerCase();
  const url = parseLoose(text);
  if (!url || !url.hostname || /\s/.test(text)) {
    for (const match of text.matchAll(/\S+/g)) {
      const token = match[0];
      const schemeStart = token.search(/https?:\/\//i);
      if (schemeStart > 0 && parseLoose(token)?.hostname) continue;
      const start = schemeStart < 0 ? token.length - token.replace(/^[<("'[]+/, "").length : schemeStart;
      let candidate = token.slice(start);
      const closing = INVITE_DELIMITERS[token[start - 1] ?? ""];
      const end = closing ? candidate.lastIndexOf(closing) : -1;
      if (end >= 0) candidate = candidate.slice(0, end);
      let target = parseLoose(candidate);
      if (!target || target.hostname.toLowerCase() !== "meet.google.com") continue;
      if (MEET_LOOKUP_PATH.test(target.pathname)) return normalizeMeetingUrl(candidate);
      candidate = candidate.replace(/[>)"'\].,;:!?]+$/, "");
      target = parseLoose(candidate);
      if (!target) continue;
      const code = singleSegment(target);
      if (code !== null && MEET_CODE.test(code)) {
        return normalizeMeetingUrl(candidate);
      }
    }
    throw new ApiError("invalid_meeting_url", "meeting_url is not a valid URL");
  }
  if (url.protocol === "http:") {
    const canonical = meetCanonical(url);
    if (!canonical) throw new ApiError("invalid_meeting_url", "meeting_url is not a valid URL");
    return canonical;
  }
  const host = url.hostname.toLowerCase();
  const wrapped = host === "accounts.google.com" ? url.searchParams.get("continue")
    : host === "meet.app.goo.gl" ? url.searchParams.get("link")
    : (host === "google.com" || host === "www.google.com") && url.pathname === "/url" ? url.searchParams.get("q") ?? url.searchParams.get("url")
    : null;
  if (wrapped !== null) {
    const target = wrapped.trim();
    const inner = parseLoose(target);
    if (inner && inner.protocol === "https:"
      && inner.hostname.toLowerCase() === "meet.google.com" && MEET_LOOKUP_PATH.test(inner.pathname)) {
      return HAS_SCHEME.test(target) ? target : `https://${target}`;
    }
    const canonical = inner ? meetCanonical(inner) : null;
    if (!canonical) throw new ApiError("invalid_meeting_url", "meeting_url redirect must point to a Google Meet link");
    return canonical;
  }
  const canonical = meetCanonical(url);
  if (!canonical) return host === "meet.google.com" && !HAS_SCHEME.test(text) ? `https://${text}` : raw;
  return HAS_SCHEME.test(text) && url.href === canonical ? text : canonical;
}

export function detectPlatform(meetingUrl: string, override?: string): DetectedPlatform {
  let u: URL;
  try {
    u = new URL(meetingUrl);
  } catch {
    throw new ApiError("invalid_meeting_url", "meeting_url is not a valid URL");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") {
    throw new ApiError("invalid_meeting_url", "meeting_url must be an http(s) URL");
  }
  const host = u.hostname.toLowerCase();
  const labels = host.split(".");

  // A caller that explicitly requests Signal must still supply a canonical Signal call link.
  // Check this before every other platform heuristic so an override cannot silently become Jitsi.
  if (override === "signal" && !isSignalCallUrl(meetingUrl)) {
    throw new ApiError("invalid_meeting_url", "Signal call link must use https://signal.link/call/ with a valid key fragment");
  }

  // Signal group-call links put the admission capability in the fragment.  A fragment is never
  // sent in a normal HTTP request, but clients POST the complete URL to us; keep it out of the
  // ordinary meeting URL and hand it only to the Signal capture worker.
  if (host === "signal.link" && u.pathname === "/call/") {
    if (!isSignalCallUrl(meetingUrl)) {
      throw new ApiError("invalid_meeting_url", "Signal call link must contain a valid key fragment");
    }
    return { platform: "signal", nativeMeetingId: null };
  }

  if (host === "meet.google.com") {
    const lookup = MEET_LOOKUP_PATH.exec(u.pathname);
    if (lookup) {
      if (u.protocol !== "https:") throw new ApiError("invalid_meeting_url", "meeting_url must use https. Details: TC-2181");
      return { platform: "google_meet", nativeMeetingId: lookup[1]! };
    }
    const code = singleSegment(u);
    if (!code) throw new ApiError("invalid_meeting_url", "Google Meet URL must contain a meeting code");
    return { platform: "google_meet", nativeMeetingId: code };
  }
  if (host === "zoom.us" || host.endsWith(".zoom.us")) {
    const m = u.pathname.match(/\/j\/(\d+)/);
    return { platform: "zoom", nativeMeetingId: m ? m[1] : null };
  }
  if (host === "teams.microsoft.com" || host.endsWith(".teams.microsoft.com") || host === "teams.live.com") {
    return { platform: "microsoft_teams", nativeMeetingId: null };
  }
  if (host === "meet.jit.si") {
    const room = singleSegment(u);
    if (!room) throw new ApiError("invalid_meeting_url", "Jitsi URL must be https://meet.jit.si/<room>");
    return { platform: "jitsi", nativeMeetingId: room };
  }
  // Lookalikes such as meet.google.com.evil.com or tel.meet.evil.com must not reach the self-hosted Jitsi rule below.
  if (/(?:^|\.)(?:meet\.google\.com|tel\.meet|g\.co)(?:\.|$)/.test(host)) throw new ApiError("unsupported_platform", `Could not determine a supported meeting platform from ${host}`);
  const looksJitsi = labels.includes("jitsi") || labels.includes("meet");
  if (looksJitsi || override === "jitsi") {
    const room = singleSegment(u);
    if (!room) throw new ApiError("invalid_meeting_url", "Jitsi URL must be https://<host>/<room>");
    // Vexa scopes self-hosted jitsi rooms as room@host.
    return { platform: "jitsi", nativeMeetingId: `${room}@${host}` };
  }
  if (override && (PLATFORMS as string[]).includes(override)) {
    return { platform: override as Platform, nativeMeetingId: null };
  }
  throw new ApiError("unsupported_platform", `Could not determine a supported meeting platform from ${host}`);
}
