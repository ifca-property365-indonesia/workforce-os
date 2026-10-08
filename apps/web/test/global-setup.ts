import type { TestProject } from "vitest/node";
import { createTestDatabase } from "@wfos/db/testing";

declare module "vitest" {
  export interface ProvidedContext {
    databaseUrl: string;
  }
}

/** One throwaway database per test run, dropped afterwards. There is deliberately no "skip". */
export default async function setup(project: TestProject) {
  const db = await createTestDatabase();
  project.provide("databaseUrl", db.url);
  return db.drop;
}
