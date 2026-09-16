-- Keep these deprecated columns for rollback compatibility with the pre-native-ingestion image.
-- They are intentionally absent from src/db/schema.ts, so current code neither selects nor writes
-- the legacy retry counter or fallback provenance. Remove them only after the rollback window closes.
SELECT 1;
