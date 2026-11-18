-- Wise-Spliter Device-Local Receipt Pointer Migration (0003)
-- Enforces zero receipt binary/base64 storage in PostgreSQL or Supabase Storage.
-- Receipts live strictly on-device in IndexedDB (`local_receipt_blobs`) and share
-- only lightweight content-addressed SHA-256 pointer metadata for P2P swarm fetching.

ALTER TABLE wise_spliter.receipt_attachments
  ADD COLUMN IF NOT EXISTS sha256_hex TEXT;

ALTER TABLE wise_spliter.receipt_attachments
  ALTER COLUMN storage_bucket SET DEFAULT 'local-device-only';

-- Scrub any legacy inline base64 `data_url` payloads from PostgreSQL tables
UPDATE wise_spliter.receipt_attachments
SET data_url = NULL,
    storage_bucket = 'local-device-only'
WHERE data_url IS NOT NULL
   OR storage_bucket <> 'local-device-only';

-- Enforce DB-level invariant so even direct authenticated PostgREST inserts cannot persist receipt blobs
ALTER TABLE wise_spliter.receipt_attachments
  DROP CONSTRAINT IF EXISTS chk_receipt_local_only;
ALTER TABLE wise_spliter.receipt_attachments
  ADD CONSTRAINT chk_receipt_local_only
  CHECK (data_url IS NULL AND storage_bucket = 'local-device-only');

UPDATE wise_spliter.expenses
SET receipts = COALESCE(
  (
    SELECT jsonb_agg(
      (elem - 'dataUrl') || jsonb_build_object(
        'localDeviceOnly', true,
        'storageBucket', 'local-device-only'
      )
    )
    FROM jsonb_array_elements(receipts) AS elem
  ),
  '[]'::jsonb
)
WHERE jsonb_typeof(receipts) = 'array'
  AND jsonb_array_length(receipts) > 0;

-- Remove any legacy objects & upload policies in Supabase Storage bucket so 0 bytes are ever consumed
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    DROP POLICY IF EXISTS ws_receipts_insert_member ON storage.objects;
    DROP POLICY IF EXISTS ws_receipts_update_member ON storage.objects;
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.tables
    WHERE table_schema = 'storage' AND table_name = 'objects'
  ) THEN
    PERFORM set_config('storage.allow_delete_query', 'true', true);
    DELETE FROM storage.objects WHERE bucket_id = 'wise-spliter-receipts';
  END IF;
EXCEPTION WHEN OTHERS THEN
  NULL;
END $$;

-- Composite cursor-pagination & delta-pull indexes for 10^6-user scale
CREATE INDEX IF NOT EXISTS idx_groups_server_seq
  ON wise_spliter.groups (server_seq);
CREATE INDEX IF NOT EXISTS idx_group_members_group_seq
  ON wise_spliter.group_members (group_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_expenses_group_seq
  ON wise_spliter.expenses (group_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_expense_revisions_expense_rev
  ON wise_spliter.expense_revisions (expense_id, revision_number DESC);
CREATE INDEX IF NOT EXISTS idx_expense_revisions_group_seq
  ON wise_spliter.expense_revisions (group_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_settlements_group_seq
  ON wise_spliter.settlements (group_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_group_activity_group_seq
  ON wise_spliter.group_activity_log (group_id, server_seq);
CREATE INDEX IF NOT EXISTS idx_receipt_attachments_group_seq
  ON wise_spliter.receipt_attachments (group_id, server_seq);

NOTIFY pgrst, 'reload schema';
