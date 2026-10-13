import type { Sql } from "postgres";
import { connect } from "./db.mjs";

const g = globalThis as unknown as { __sql?: Sql };
export function sql(): Sql {
  g.__sql ??= connect() as Sql;
  return g.__sql;
}
