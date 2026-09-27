-- Change only the reviewed model pricing configuration. Historical spend,
-- including conservative unknown-billing charges, remains untouched.
-- NOT NULL rejects this statement atomically while any prior work is reserved.
UPDATE budget
SET pricing_version = CASE
  WHEN reserved_micro <> 0 OR EXISTS (
    SELECT 1 FROM checks WHERE state IN ('active', 'waiting')
  ) THEN NULL
  ELSE '2026-09-26-gpt54mini-gpt54-standard'
END
WHERE id = 1 AND pricing_version = '2026-09-26-gpt54mini-gpt55-standard';
