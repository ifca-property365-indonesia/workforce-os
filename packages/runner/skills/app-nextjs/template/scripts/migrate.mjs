// `pnpm migrate`: runs before a new version starts (Workforce OS takes a database backup first) and again on every
// deploy, so every statement must be idempotent (IF NOT EXISTS, ADD COLUMN IF NOT EXISTS, …).
import { connect } from "../lib/db.mjs";

const sql = connect();
await sql`
  CREATE TABLE IF NOT EXISTS notes (
    id serial PRIMARY KEY,
    text text NOT NULL CHECK (length(text) BETWEEN 1 AND 500),
    created_at timestamptz NOT NULL DEFAULT now()
  )
`;
console.log("migrate: notes table ready");
await sql.end();
