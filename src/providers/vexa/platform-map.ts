import type { Platform } from "../../domain/platform.ts";
import type { VexaPlatform } from "./types.ts";

const TO_VEXA: Record<Exclude<Platform, "signal">, VexaPlatform> = {
  google_meet: "google_meet",
  zoom: "zoom",
  microsoft_teams: "teams",
  jitsi: "jitsi",
};

/** Signal has a dedicated capture worker and is deliberately not representable in Vexa. */
export const toVexaPlatform = (p: Exclude<Platform, "signal">): VexaPlatform => TO_VEXA[p];
export function fromVexaPlatform(p: string): Platform {
  return p === "teams" ? "microsoft_teams" : (p as Platform);
}
