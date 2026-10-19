-- A newly hired employee's daily credit budget: 1000 (was 200). Existing employees keep theirs.
ALTER TABLE "employees" ALTER COLUMN "daily_budget" SET DEFAULT 1000;
