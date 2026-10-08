import { config } from "dotenv";
import { assertNotProductionTarget } from "@wfos/shared/runtime";
import path from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import { eq } from "drizzle-orm";
import { getDb, getSql } from "./index";
import { members, users, workspaces } from "./schema";
import { seedPrices, seedSampleData } from "./sample";

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.resolve(here, "../../../.env") });
assertNotProductionTarget();

async function main() {
  const db = getDb();
  await seedPrices(db);
  const email = process.env.SEED_OWNER_EMAIL ?? "owner@workforce.local";
  const password = process.env.SEED_OWNER_PASSWORD ?? "workforce-demo";
  let [user] = await db.select().from(users).where(eq(users.email, email));
  if (!user) {
    [user] = await db.insert(users).values({ email, name: "Demo Owner", passwordHash: await bcrypt.hash(password, 10) }).returning();
    console.log(`created owner ${email} / ${password}  (change it after first login)`);
  }
  let [ws] = await db.select().from(workspaces).where(eq(workspaces.slug, "demo-agency"));
  if (!ws) {
    [ws] = await db.insert(workspaces).values({ name: "Demo Agency", slug: "demo-agency", notifyEmail: email }).returning();
    await db.insert(members).values({ workspaceId: ws!.id, userId: user!.id, role: "OWNER" });
  }
  const r = await seedSampleData(db, ws!.id);
  console.log(r.created ? "sample data created" : "sample data already present");
  await getSql().end();
}
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
