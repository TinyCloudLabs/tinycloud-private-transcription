/** Speaker evidence normalized onto the saved recording's clock, in seconds.
 * This partitions audio; it never filters audio by whether a speaker was recognized.
 */
import type { SpeakerAttribution } from "../../domain/transcript.ts";
export type { SpeakerAttribution } from "../../domain/transcript.ts";

export interface SpeakerInterval {
  start: number;
  end: number;
  participantId: string | null;
  name: string | null;
  attribution: SpeakerAttribution;
}

/** Exact, disjoint coverage of [0, duration). Conflicting names or missing evidence remain
 * unknown; simultaneous different participants remain overlap rather than a majority-vote name.
 * Sweep-line counters bound work to O(n log n), including many overlapping duplicate uploads.
 * Invalid/oversized metadata throws so the caller can explicitly use unattributed full audio.
 */
export function partitionSpeakerTimeline(
  duration: number,
  intervals: readonly SpeakerInterval[],
  opts: { maxIntervals?: number } = {},
): SpeakerInterval[] {
  const max = opts.maxIntervals ?? 50_000;
  if (!Number.isFinite(duration) || duration < 0) throw new Error("Invalid recording duration");
  if (!Number.isSafeInteger(max) || max < 0 || intervals.length > max) throw new Error("Speaker timeline exceeds interval budget");

  type Edge = { time: number; delta: number; interval: SpeakerInterval };
  const edges: Edge[] = [];
  for (const interval of intervals) {
    const { start, end, attribution, participantId, name } = interval;
    if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) throw new Error("Invalid speaker interval time");
    if (!["identified", "unknown", "overlap"].includes(attribution)) throw new Error("Invalid speaker attribution");
    if (attribution === "identified" && (
      typeof participantId !== "string" || !participantId.trim() || participantId.length > 256 ||
      typeof name !== "string" || !name.trim() || name.length > 256
    )) throw new Error("Identified interval requires participant identity and name");
    const from = Math.max(0, start);
    const to = Math.min(duration, end);
    if (to <= from) continue;
    edges.push({ time: from, delta: 1, interval }, { time: to, delta: -1, interval });
  }
  edges.sort((a, b) => a.time - b.time);

  const identities = new Map<string, number>();
  const labels = new Map<string, { count: number; participantId: string; name: string }>();
  let unknown = 0;
  let overlap = 0;
  const apply = ({ interval, delta }: Edge) => {
    if (interval.attribution === "unknown") { unknown += delta; return; }
    if (interval.attribution === "overlap") { overlap += delta; return; }
    const participantId = interval.participantId!;
    const name = interval.name!.trim();
    const count = (identities.get(participantId) ?? 0) + delta;
    if (count) identities.set(participantId, count); else identities.delete(participantId);
    const key = JSON.stringify([participantId, name]);
    const labelCount = (labels.get(key)?.count ?? 0) + delta;
    if (labelCount) labels.set(key, { count: labelCount, participantId, name }); else labels.delete(key);
  };
  const result: SpeakerInterval[] = [];
  const append = (start: number, end: number) => {
    if (end <= start) return;
    let attribution: SpeakerAttribution = "unknown";
    let participantId: string | null = null;
    let name: string | null = null;
    if (overlap > 0 || identities.size > 1) attribution = "overlap";
    else if (unknown === 0 && labels.size === 1) {
      attribution = "identified";
      const label = labels.values().next().value!;
      participantId = label.participantId;
      name = label.name;
    }
    const previous = result.at(-1);
    if (previous && previous.end === start && previous.attribution === attribution &&
      previous.participantId === participantId && previous.name === name) previous.end = end;
    else result.push({ start, end, participantId, name, attribution });
  };

  let cursor = 0;
  for (let i = 0; i < edges.length;) {
    const time = edges[i]!.time;
    append(cursor, time);
    while (i < edges.length && edges[i]!.time === time) apply(edges[i++]!);
    cursor = time;
  }
  append(cursor, duration);
  return result;
}
