import "server-only";
import { count } from "drizzle-orm";
import { db, users } from "@wfos/db";
import { serverEnv } from "./env";

/** New accounts may be created when ALLOW_SIGNUP=true, or to bootstrap the very first user. */
export async function signupAllowed(): Promise<boolean> {
  if (serverEnv.allowSignup) return true;
  const [r] = await db.select({ n: count() }).from(users);
  return (r?.n ?? 0) === 0;
}
