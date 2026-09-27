-- Run only after old-model work and outstanding clarifications are settled.
-- The NOT NULL constraint makes this single statement fail atomically if a
-- reservation remains. Never reset spend, reservations, usage counters or halt.
UPDATE budget
SET pricing_version = CASE
  WHEN reserved_micro <> 0 OR EXISTS (
    SELECT 1 FROM checks WHERE state IN ('active', 'waiting')
  ) THEN NULL
  ELSE '2026-09-26-gpt54mini-gpt55-standard'
END
WHERE id = 1 AND pricing_version = '2026-09-26-gpt6-standard';
