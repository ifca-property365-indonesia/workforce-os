import { describe, expect, it } from "vitest";
import {
  activityOf, animationFor, defaultLook, describeOrder, IDLE_PERIOD_MS, initials, layoutOffice, MAX_W, moveToward, resolveLook, roomOf, SKIN_TONES, spotPoint,
  STALE_STEP_MS, toolActivity, type Activity, type OfficeLayout, type OfficeMember,
} from "../src/office";
import { officeLookSchema } from "../src/index";

const NOW = Date.parse("2026-10-08T10:00:00Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const people = (n: number, f: (i: number) => Partial<OfficeMember> = () => ({})): OfficeMember[] =>
  Array.from({ length: n }, (_, i) => ({ id: `e${String(i).padStart(3, "0")}`, name: `Emp ${String(i).padStart(3, "0")}`, ...f(i) }));

describe("tool → activity", () => {
  it.each([
    ["Edit", "typing"], ["Write", "typing"], ["MultiEdit", "typing"], ["draft_document", "typing"], ["send_email", "typing"],
    ["Read", "reading"], ["Grep", "reading"], ["Glob", "reading"], ["kb_search", "reading"], ["web_fetch", "reading"],
    ["Bash", "terminal"], ["git_push", "terminal"], ["create_pull_request", "terminal"],
    ["mcp__wfos__kb_search", "reading"], ["mcp__wfos__draft_email", "typing"], ["approval_requested:Bash", "terminal"],
    ["Task", "thinking"], ["some_new_tool", "typing"],
  ] as [string, Activity][])("%s → %s", (name, want) => expect(toolActivity(name)).toBe(want));
});

describe("state → activity", () => {
  const running = { status: "RUNNING" };
  it("paused employees sleep regardless of task", () => {
    expect(activityOf({ employeeStatus: "PAUSED", task: running, now: NOW })).toBe("paused");
    expect(activityOf({ employeeStatus: "PAUSED_BUDGET", task: null, now: NOW })).toBe("paused");
  });
  it("no task, queued or finished task → idle", () => {
    for (const task of [null, { status: "QUEUED" }, { status: "DONE" }, { status: "FAILED" }, { status: "CANCELLED" }]) expect(activityOf({ employeeStatus: "ACTIVE", task, now: NOW })).toBe("idle");
  });
  it("awaiting approval → waiting, whatever the last step", () => {
    expect(activityOf({ employeeStatus: "ACTIVE", task: { status: "AWAITING_APPROVAL" }, lastStep: { kind: "tool", name: "Edit", at: ago(1000) }, now: NOW })).toBe("waiting");
  });
  it("running: the fresh last tool step decides", () => {
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: { kind: "tool", name: "Edit", at: ago(5000) }, now: NOW })).toBe("typing");
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: { kind: "tool", name: "Grep", at: ago(5000) }, now: NOW })).toBe("reading");
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: { kind: "tool", name: "Bash", at: NOW - 5000 }, now: NOW })).toBe("terminal");
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: { kind: "approval", name: "approval_requested:send_email", at: ago(1) }, now: NOW })).toBe("waiting");
  });
  it("running: llm steps, no steps or a stale step → thinking", () => {
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: { kind: "llm", name: "llm_call", at: ago(1000) }, now: NOW })).toBe("thinking");
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: null, now: NOW })).toBe("thinking");
    expect(activityOf({ employeeStatus: "ACTIVE", task: running, lastStep: { kind: "tool", name: "Edit", at: ago(STALE_STEP_MS + 1) }, now: NOW })).toBe("thinking");
  });
});

describe("activity → animation", () => {
  it("maps work to places and bubbles", () => {
    expect(animationFor("typing", "e1", NOW)).toEqual({ spot: "desk", pose: "type", bubble: null });
    expect(animationFor("reading", "e1", NOW)).toEqual({ spot: "bookshelf", pose: "read", bubble: null });
    expect(animationFor("terminal", "e1", NOW)).toEqual({ spot: "rack", pose: "operate", bubble: null });
    expect(animationFor("waiting", "e1", NOW)).toEqual({ spot: "desk", pose: "stand", bubble: "!" });
    expect(animationFor("thinking", "e1", NOW)).toEqual({ spot: "desk", pose: "sit", bubble: "…" });
    expect(animationFor("paused", "e1", NOW)).toEqual({ spot: "desk", pose: "sleep", bubble: "zz" });
  });
  it("idle varies between lounge, coffee and chatting, stable within a period", () => {
    const seen = new Set<string>();
    for (let i = 0; i < 60; i++) {
      const a = animationFor("idle", `e${i}`, NOW);
      expect(["lounge", "coffee"]).toContain(a.spot);
      expect(a.bubble).toBeNull();
      seen.add(`${a.spot}/${a.pose}`);
      expect(animationFor("idle", `e${i}`, NOW + 1000)).toEqual(animationFor("idle", `e${i}`, NOW + 2000));
    }
    expect(seen).toEqual(new Set(["lounge/sit", "coffee/stand", "lounge/chat"]));
    const changes = Array.from({ length: 20 }, (_, i) => animationFor("idle", "e7", i * IDLE_PERIOD_MS).pose);
    expect(new Set(changes).size).toBeGreaterThan(1);
  });
});

function overlaps(a: { x: number; y: number; w: number; h: number }, b: { x: number; y: number; w: number; h: number }) {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}
function checkLayout(l: OfficeLayout, n: number) {
  expect(l.desks).toHaveLength(n);
  expect(new Set(l.desks.map((d) => d.employeeId)).size).toBe(n);
  const all = [...l.rooms, l.lounge];
  for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) expect(overlaps(all[i]!, all[j]!), `${all[i]!.key} vs ${all[j]!.key}`).toBe(false);
  for (const r of all) expect(r.x + r.w).toBeLessThanOrEqual(Math.max(MAX_W, r.w));
  for (const d of l.desks) {
    const r = l.rooms.find((x) => x.key === d.room)!;
    expect(d.x).toBeGreaterThanOrEqual(r.x);
    expect(d.x + 2).toBeLessThanOrEqual(r.x + r.w);
    expect(d.seat.y).toBeLessThan(r.y + r.h);
    expect(d.y).toBeGreaterThan(r.bookshelf.y); // desks sit below the shelf strip
  }
  for (const a of l.desks) for (const b of l.desks) if (a !== b) expect(overlaps({ x: a.x, y: a.y, w: 2, h: 1 }, { x: b.x, y: b.y, w: 2, h: 1 })).toBe(false);
  expect(l.lounge.seats.length).toBeGreaterThanOrEqual(n);
  for (const s of l.lounge.seats) expect(overlaps({ x: s.x, y: s.y, w: 0.01, h: 0.01 }, l.lounge)).toBe(true);
  expect(l.width).toBeGreaterThan(0);
  // the reception is in front of every room, centred, inside the office
  const rc = { key: "reception", ...l.reception };
  for (const r of all) expect(overlaps(r, rc), r.key).toBe(false);
  for (const r of all) expect(r.y + r.h).toBeLessThan(rc.y);
  expect(rc.x).toBeGreaterThanOrEqual(0);
  expect(rc.x + rc.w).toBeLessThanOrEqual(l.width);
  expect(rc.x + rc.w / 2).toBeCloseTo(l.width / 2);
  expect(rc.y + rc.h).toBe(l.height);
  expect(overlaps({ x: rc.desk.x, y: rc.desk.y, w: 0.01, h: 0.01 }, rc)).toBe(true);
}

describe("layout", () => {
  it.each([0, 1, 2, 7, 30, 100])("fits %i employees without overlaps", (n) => {
    checkLayout(layoutOffice(people(n)), n);
  });

  it("gives teams and departments their own rooms; the rest share the general room", () => {
    const team = { id: "t1", name: "Growth" };
    const l = layoutOffice(people(9, (i) => (i < 3 ? { teams: [team] } : i < 6 ? { department: "finance" } : {})), (k) => (k === "finance" ? "Keuangan" : k));
    expect(l.rooms.map((r) => [r.kind, r.label])).toEqual([["team", "Growth"], ["department", "Keuangan"], ["general", ""]]);
    expect(l.desks.filter((d) => d.room === "team:t1")).toHaveLength(3);
    expect(l.desks.filter((d) => d.room === "dept:finance")).toHaveLength(3);
    checkLayout(l, 9);
  });

  it("an employee in several teams sits in the first by name; team beats department", () => {
    expect(roomOf({ id: "x", name: "X", department: "developer", teams: [{ id: "b", name: "Zeta" }, { id: "a", name: "Alpha" }] }).key).toBe("team:a");
  });

  it("is deterministic and independent of input order", () => {
    const ps = people(13, (i) => ({ department: i % 2 ? "developer" : "marketing" }));
    expect(layoutOffice([...ps].reverse())).toEqual(layoutOffice(ps));
  });

  it("wraps rooms into rows instead of growing forever sideways", () => {
    const l = layoutOffice(people(40, (i) => ({ department: `d${i % 8}` })));
    expect(l.width).toBeLessThanOrEqual(MAX_W);
    expect(new Set(l.rooms.map((r) => r.y)).size).toBeGreaterThan(1);
    checkLayout(l, 40);
  });

  it("spots: desk is the seat; shelf and rack are in the employee's own room", () => {
    const l = layoutOffice(people(5, () => ({ department: "developer" })));
    const room = l.rooms[0]!;
    for (const d of l.desks) {
      expect(spotPoint(l, d.employeeId, "desk")).toEqual(d.seat);
      for (const s of ["bookshelf", "rack"] as const) {
        const p = spotPoint(l, d.employeeId, s);
        expect(overlaps({ x: p.x, y: p.y, w: 0.01, h: 0.01 }, room)).toBe(true);
      }
      const c = spotPoint(l, d.employeeId, "lounge");
      expect(overlaps({ x: c.x, y: c.y, w: 0.01, h: 0.01 }, l.lounge)).toBe(true);
    }
  });
});

describe("movement", () => {
  it("walks at the given speed and snaps on arrival", () => {
    const r = moveToward({ x: 0, y: 0 }, { x: 10, y: 0 }, 500, 4);
    expect(r).toEqual({ pos: { x: 2, y: 0 }, arrived: false });
    expect(moveToward({ x: 9.9, y: 0 }, { x: 10, y: 0 }, 100, 4)).toEqual({ pos: { x: 10, y: 0 }, arrived: true });
    expect(moveToward({ x: 1, y: 1 }, { x: 1, y: 1 }, 16).arrived).toBe(true);
    expect(moveToward({ x: 0, y: 0 }, { x: 3, y: 4 }, -50).pos).toEqual({ x: 0, y: 0 });
  });
});

describe("text alternative order", () => {
  it("lists who needs attention first", () => {
    const out = describeOrder([
      { name: "B", activity: "idle" as Activity },
      { name: "A", activity: "typing" as Activity },
      { name: "C", activity: "waiting" as Activity },
    ]);
    expect(out.map((p) => p.name)).toEqual(["C", "A", "B"]);
  });
});

describe("character looks", () => {
  it("derives a valid, stable look from the id", () => {
    for (let i = 0; i < 200; i++) {
      const l = defaultLook(`emp-${i}`);
      expect(officeLookSchema.safeParse(l).success).toBe(true);
      expect(defaultLook(`emp-${i}`)).toEqual(l);
    }
    const shirts = new Set(Array.from({ length: 50 }, (_, i) => defaultLook(`e${i}`).shirt));
    expect(shirts.size).toBeGreaterThan(4); // varied, not one uniform
  });

  it("keeps a valid stored look and replaces a broken one with the default", () => {
    const mine = { skin: 2, hair: "afro", hairColor: 1, beard: "full", glasses: "round", hat: "cap", shirt: 3, logo: true } as const;
    expect(resolveLook("e1", mine)).toEqual(mine);
    expect(resolveLook("e1", null)).toEqual(defaultLook("e1"));
    expect(resolveLook("e1", { ...mine, hair: "mohawk" })).toEqual(defaultLook("e1"));
    expect(resolveLook("e1", { ...mine, skin: SKIN_TONES.length })).toEqual(defaultLook("e1"));
    expect(resolveLook("e1", "afro")).toEqual(defaultLook("e1"));
    expect(officeLookSchema.safeParse({ ...mine, shirt: -1 }).success).toBe(false);
  });

  it("makes logo initials from the workspace name", () => {
    expect(initials("Property 365 Indonesia")).toBe("P3I");
    expect(initials("  ifca  ")).toBe("IF");
    expect(initials("a b c d")).toBe("ABC");
    expect(initials("")).toBe("");
  });
});
