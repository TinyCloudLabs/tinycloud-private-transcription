ALTER TABLE "transcriptions" ADD COLUMN "vad_dropped_above_floor_pct" real;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "vad_fallback" boolean;