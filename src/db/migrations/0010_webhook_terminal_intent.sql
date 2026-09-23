-- One immutable terminal delivery intent makes publication recoverable after commit.
-- Keep the earliest historical intent if an older deployment wrote duplicates.
DELETE FROM "webhook_deliveries" a
USING "webhook_deliveries" b
WHERE a."meeting_id" = b."meeting_id"
  AND a."event_type" = b."event_type"
  AND (a."created_at", a."id") > (b."created_at", b."id");
--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_deliveries_meeting_event_idx"
  ON "webhook_deliveries" USING btree ("meeting_id", "event_type");
