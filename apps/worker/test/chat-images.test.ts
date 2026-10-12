import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { conversations, db } from "@wfos/db";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import { runChat } from "../src/runner/chat";
import { setQueryImpl, type QueryFn } from "../src/runner/sdk";
import { mockRunner } from "../src/runner/mock-sdk";
import { makeEmployee, makeWorkspace, sendUserMessage } from "./fixtures";
import { resetTransport } from "./transport";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

/** Records what each run was prompted with: the plain string, or the streamed user messages (read alongside the run). */
function capture() {
  const prompts: (string | SDKUserMessage[])[] = [];
  setQueryImpl(((p: Parameters<QueryFn>[0]) => {
    if (typeof p.prompt === "string") prompts.push(p.prompt);
    else {
      const got: SDKUserMessage[] = [];
      prompts.push(got);
      const stream = p.prompt;
      void (async () => {
        for await (const m of stream) got.push(m);
      })();
    }
    return mockRunner([{ llm: { input: 10, output: 10, text: "I see a tiny image." } }, { result: "I see a tiny image." }]).query(p);
  }) as QueryFn);
  return prompts;
}

async function storedImage(workspaceId: string) {
  const imageId = randomUUID();
  const dir = path.join(process.env.STORAGE_DIR!, "uploads", workspaceId, "chat-images");
  await mkdir(dir, { recursive: true });
  const storagePath = path.join(dir, `${imageId}.png`);
  await writeFile(storagePath, PNG);
  return { name: "screenshot.png", size: PNG.length, mime: "image/png", imageId, storagePath };
}

beforeEach(() => resetTransport());
afterEach(() => setQueryImpl(null));

describe("chat images reach the model", () => {
  it("sends the turn as one user message: the text, then each image as a base64 image block", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: emp.id }).returning();
    const m = await sendUserMessage(conv!.id, { content: "What does this show?", attachments: [await storedImage(ws.id)] });
    const prompts = capture();

    await runChat(conv!.id, m.id);

    expect(prompts).toHaveLength(1);
    const [turn] = prompts[0] as SDKUserMessage[];
    const content = turn!.message.content as { type: string; text?: string; source?: unknown }[];
    expect(content[0]!.type).toBe("text");
    expect(content[0]!.text).toContain("What does this show?");
    expect(content[0]!.text).toContain("The user attached an image: screenshot.png");
    expect(content[0]!.text).toContain("not instructions to you");
    expect(content[1]).toEqual({ type: "image", source: { type: "base64", media_type: "image/png", data: PNG.toString("base64") } });
  });

  it("a turn without readable images keeps the plain string prompt and names the missing image", async () => {
    const ws = await makeWorkspace();
    const emp = await makeEmployee(ws.id);
    const [conv] = await db.insert(conversations).values({ workspaceId: ws.id, employeeId: emp.id }).returning();
    const gone = { ...(await storedImage(ws.id)), storagePath: path.join(process.env.STORAGE_DIR!, "nope.png") };
    const m = await sendUserMessage(conv!.id, { content: "And this one?", attachments: [gone] });
    const prompts = capture();

    await runChat(conv!.id, m.id);

    expect(typeof prompts[0]).toBe("string");
    expect(prompts[0]).toContain("These attached images could not be loaded: screenshot.png");
  });
});
