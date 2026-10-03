ALTER TABLE "transcription_regions" ADD COLUMN "speaker" integer;--> statement-breakpoint
ALTER TABLE "transcriptions" ADD COLUMN "diarize" boolean DEFAULT false NOT NULL;