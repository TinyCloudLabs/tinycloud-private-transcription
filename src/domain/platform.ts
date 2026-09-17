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
