import type { Platform } from "../../domain/platform.ts";
import type { VexaPlatform } from "./types.ts";

const TO_VEXA: Record<Platform, VexaPlatform> = {
  google_meet: "google_meet",
  zoom: "zoom",
  microsoft_teams: "teams",
  jitsi: "jitsi",
};

export const toVexaPlatform = (p: Platform): VexaPlatform => TO_VEXA[p];
export function fromVexaPlatform(p: string): Platform {
  return p === "teams" ? "microsoft_teams" : (p as Platform);
}
