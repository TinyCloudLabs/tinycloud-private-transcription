import { ApiError } from "./errors.ts";

export type Platform = "google_meet" | "zoom" | "microsoft_teams" | "jitsi";
export const PLATFORMS: Platform[] = ["google_meet", "zoom", "microsoft_teams", "jitsi"];

export interface DetectedPlatform {
  platform: Platform;
  /** Vexa's native_meeting_id when derivable from the URL, else null (Vexa derives it). */
  nativeMeetingId: string | null;
}

const singleSegment = (u: URL): string | null => {
  const parts = u.pathname.split("/").filter(Boolean);
  return parts.length === 1 && !/\s/.test(parts[0]) ? parts[0] : null;
};

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
