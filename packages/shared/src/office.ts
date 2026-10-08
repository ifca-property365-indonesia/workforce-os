/**
 * Live office: pure layout and behaviour logic shared by the 2D and 3D views (no DOM, no rendering).
 * Units are floor tiles; renderers choose the pixel/metre scale.
 */

export type Activity = "typing" | "reading" | "terminal" | "thinking" | "waiting" | "idle" | "paused";
export type Spot = "desk" | "bookshelf" | "rack" | "lounge" | "coffee";
export type Pose = "type" | "sit" | "read" | "operate" | "stand" | "chat" | "sleep";
export type Bubble = "!" | "…" | "zz" | null;

export interface Animation {
  spot: Spot;
  pose: Pose;
  bubble: Bubble;
}

/** A step older than this while the task is still running means the model is thinking, not using the tool. */
export const STALE_STEP_MS = 90_000;
/** Idle employees change between lounge, coffee and chatting this often. */
export const IDLE_PERIOD_MS = 45_000;

const WRITE_TOOLS = new Set([
  "Write", "Edit", "MultiEdit", "NotebookEdit", "TodoWrite",
  "draft_document", "draft_email", "draft_invoice", "memory_save", "create_task", "delegate_subtask", "request_revision",
  "message_teammate", "send_email", "send_invoice", "post_webhook",
]);
const READ_TOOLS = new Set([
  "Read", "Grep", "Glob", "LS", "WebFetch", "WebSearch", "Skill",
  "kb_search", "memory_search", "list_clients", "get_client", "list_tasks", "web_fetch",
]);
const TERMINAL_TOOLS = new Set(["Bash", "BashOutput", "KillShell", "KillBash", "git_push", "create_pull_request"]);

/** Tool name → what the character does. MCP prefixes are ignored; unknown tools count as desk work. */
export function toolActivity(name: string): Activity {
  const bare = name.replace(/^approval_requested:/, "").replace(/^mcp__.+?__/, "");
  if (TERMINAL_TOOLS.has(bare)) return "terminal";
  if (READ_TOOLS.has(bare)) return "reading";
  if (WRITE_TOOLS.has(bare)) return "typing";
  if (bare === "Task") return "thinking"; // delegating to a subagent
  return "typing";
}

export interface ActivityInput {
  employeeStatus: string;
  task?: { status: string } | null;
  lastStep?: { kind: string; name: string; at: string | number | Date } | null;
  now: number;
}

/** Live state → activity. The task status wins over the last step; a stale step means thinking. */
export function activityOf(i: ActivityInput): Activity {
  if (i.employeeStatus === "PAUSED" || i.employeeStatus === "PAUSED_BUDGET") return "paused";
  const status = i.task?.status;
  if (status === "AWAITING_APPROVAL") return "waiting";
  if (status !== "RUNNING") return "idle";
  const s = i.lastStep;
  if (!s) return "thinking";
  if (i.now - new Date(s.at).getTime() > STALE_STEP_MS) return "thinking";
  if (s.kind === "approval") return "waiting";
  if (s.kind === "tool") return toolActivity(s.name);
  return "thinking";
}

/** Small stable hash (FNV-1a) so the same employee behaves the same on every client. */
export function stableHash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Activity → where the character goes, how it stands and what floats above it. */
export function animationFor(activity: Activity, employeeId: string, now: number): Animation {
  switch (activity) {
    case "typing":
      return { spot: "desk", pose: "type", bubble: null };
    case "reading":
      return { spot: "bookshelf", pose: "read", bubble: null };
    case "terminal":
      return { spot: "rack", pose: "operate", bubble: null };
    case "thinking":
      return { spot: "desk", pose: "sit", bubble: "…" };
    case "waiting":
      return { spot: "desk", pose: "stand", bubble: "!" };
    case "paused":
      return { spot: "desk", pose: "sleep", bubble: "zz" };
    case "idle": {
      const v = stableHash(`${employeeId}:${Math.floor(now / IDLE_PERIOD_MS)}`) % 3;
      if (v === 0) return { spot: "lounge", pose: "sit", bubble: null };
      if (v === 1) return { spot: "coffee", pose: "stand", bubble: null };
      return { spot: "lounge", pose: "chat", bubble: null };
    }
  }
}

// ---------------------------------------------------------------------------
// Layout
// ---------------------------------------------------------------------------

export interface OfficeMember {
  id: string;
  name: string;
  department?: string | null;
  /** teams the employee belongs to, any order */
  teams?: { id: string; name: string }[];
}

export interface Point {
  x: number;
  y: number;
}
export interface Room {
  key: string;
  label: string;
  kind: "team" | "department" | "general" | "lounge";
  x: number;
  y: number;
  w: number;
  h: number;
  bookshelf: Point;
  rack: Point;
}
export interface Desk {
  employeeId: string;
  room: string;
  /** desk top-left corner (the desk is DESK_W × 1) */
  x: number;
  y: number;
  /** where the character sits */
  seat: Point;
}
export interface Lounge extends Room {
  coffee: Point;
  seats: Point[];
}
export interface OfficeLayout {
  width: number;
  height: number;
  rooms: Room[];
  desks: Desk[];
  lounge: Lounge;
}

export const CELL = 3; // one desk cell is 3 × 3 tiles: desk, chair, walkway
export const DESK_W = 2;
const PAD = 1; // inner padding of a room
const TOP = 2; // strip along the top wall: bookshelf and server rack
export const MAX_W = 36; // office width before rooms wrap to the next row
const GAP = 1; // corridor between rooms

/** Room of an employee: first team (by name), else department, else the general room. */
export function roomOf(m: OfficeMember, departmentLabel?: (key: string) => string): { key: string; label: string; kind: Room["kind"] } {
  const team = [...(m.teams ?? [])].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id))[0];
  if (team) return { key: `team:${team.id}`, label: team.name, kind: "team" };
  if (m.department) return { key: `dept:${m.department}`, label: departmentLabel?.(m.department) ?? m.department, kind: "department" };
  return { key: "general", label: "", kind: "general" };
}

function columnsFor(n: number): number {
  return Math.max(2, Math.min(5, Math.ceil(Math.sqrt(n * 1.5))));
}

/**
 * Rooms and desks from the actual employee list (any count). Rooms are packed left to right and wrap at MAX_W;
 * desks fill each room in rows. The lounge comes last and grows with the headcount. Same input → same layout.
 */
export function layoutOffice(members: OfficeMember[], departmentLabel?: (key: string) => string): OfficeLayout {
  const groups = new Map<string, { label: string; kind: Room["kind"]; ids: string[] }>();
  const sorted = [...members].sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  for (const m of sorted) {
    const r = roomOf(m, departmentLabel);
    const g = groups.get(r.key) ?? groups.set(r.key, { label: r.label, kind: r.kind, ids: [] }).get(r.key)!;
    g.ids.push(m.id);
  }
  // teams first, then departments, then the general room; alphabetical inside each kind
  const order = { team: 0, department: 1, general: 2, lounge: 3 };
  const keys = [...groups.keys()].sort(
    (a, b) => order[groups.get(a)!.kind] - order[groups.get(b)!.kind] || groups.get(a)!.label.localeCompare(groups.get(b)!.label) || a.localeCompare(b),
  );

  const rooms: Room[] = [];
  const desks: Desk[] = [];
  let cx = 0;
  let cy = 0;
  let rowH = 0;
  const place = (w: number, h: number): Point => {
    if (cx > 0 && cx + w > MAX_W) {
      cx = 0;
      cy += rowH + GAP;
      rowH = 0;
    }
    const p = { x: cx, y: cy };
    cx += w + GAP;
    rowH = Math.max(rowH, h);
    return p;
  };

  for (const key of keys) {
    const g = groups.get(key)!;
    const cols = columnsFor(g.ids.length);
    const rows = Math.ceil(g.ids.length / cols);
    const w = cols * CELL + 2 * PAD;
    const h = rows * CELL + TOP + 2 * PAD;
    const p = place(w, h);
    rooms.push({ key, label: g.label, kind: g.kind, x: p.x, y: p.y, w, h, bookshelf: { x: p.x + PAD + 1, y: p.y + PAD + 0.5 }, rack: { x: p.x + w - PAD - 1, y: p.y + PAD + 0.5 } });
    g.ids.forEach((employeeId, i) => {
      const x = p.x + PAD + (i % cols) * CELL + (CELL - DESK_W) / 2;
      const y = p.y + PAD + TOP + Math.floor(i / cols) * CELL;
      desks.push({ employeeId, room: key, x, y, seat: { x: x + DESK_W / 2, y: y + 1.6 } });
    });
  }

  // lounge: sofas in rows, coffee machine top right; a seat for everyone
  const seatsN = Math.max(4, members.length);
  const lw = Math.max(10, Math.min(MAX_W, Math.ceil(seatsN / 2) * 2 + 2 * PAD));
  const seatCols = Math.floor((lw - 2 * PAD) / 2);
  const lh = TOP + 2 * PAD + Math.ceil(seatsN / seatCols) * 2;
  const lp = place(lw, lh);
  const seats: Point[] = [];
  for (let i = 0; i < seatsN; i++) seats.push({ x: lp.x + PAD + 1 + (i % seatCols) * 2, y: lp.y + PAD + TOP + 1 + Math.floor(i / seatCols) * 2 });
  const lounge: Lounge = {
    key: "lounge",
    label: "",
    kind: "lounge",
    x: lp.x,
    y: lp.y,
    w: lw,
    h: lh,
    bookshelf: { x: lp.x + PAD + 1, y: lp.y + PAD + 0.5 },
    rack: { x: lp.x + lw - PAD - 1, y: lp.y + PAD + 0.5 },
    coffee: { x: lp.x + lw - PAD - 1, y: lp.y + PAD + 0.5 },
    seats,
  };
  const all: Room[] = [...rooms, lounge];
  return { width: Math.max(...all.map((r) => r.x + r.w)), height: Math.max(...all.map((r) => r.y + r.h)), rooms, desks, lounge };
}

/** Target point of an employee for a spot; several people at one shelf or rack stand side by side. */
export function spotPoint(layout: OfficeLayout, employeeId: string, spot: Spot): Point {
  const desk = layout.desks.find((d) => d.employeeId === employeeId);
  const room = layout.rooms.find((r) => r.key === desk?.room);
  const slot = stableHash(employeeId);
  const side = ((slot % 7) - 3) * 0.5; // seven standing places, half a tile apart
  const fallback = layout.lounge.seats[slot % layout.lounge.seats.length]!;
  switch (spot) {
    case "desk":
      return desk?.seat ?? fallback;
    case "bookshelf":
      return room ? { x: room.bookshelf.x + side, y: room.bookshelf.y + 1.1 } : fallback;
    case "rack":
      return room ? { x: room.rack.x + side, y: room.rack.y + 1.1 } : fallback;
    case "coffee":
      return { x: layout.lounge.coffee.x + side - 1.5, y: layout.lounge.coffee.y + 1.1 };
    case "lounge": {
      const i = desk ? layout.desks.indexOf(desk) : slot;
      return layout.lounge.seats[i % layout.lounge.seats.length]!;
    }
  }
}

/** Walk toward a target at `speed` tiles per second. Returns the new position and whether it arrived. */
export function moveToward(pos: Point, target: Point, dtMs: number, speed = 4): { pos: Point; arrived: boolean } {
  const dx = target.x - pos.x;
  const dy = target.y - pos.y;
  const dist = Math.hypot(dx, dy);
  const stepLen = (speed * Math.max(0, dtMs)) / 1000;
  if (dist <= stepLen || dist < 1e-6) return { pos: { ...target }, arrived: true };
  return { pos: { x: pos.x + (dx / dist) * stepLen, y: pos.y + (dy / dist) * stepLen }, arrived: false };
}

/** Order for the accessible text alternative: who needs attention first, then who is working, then idle. */
export function describeOrder<T extends { name: string; activity: Activity }>(people: T[]): T[] {
  const rank: Record<Activity, number> = { waiting: 0, terminal: 1, typing: 2, reading: 3, thinking: 4, idle: 5, paused: 6 };
  return [...people].sort((a, b) => rank[a.activity] - rank[b.activity] || a.name.localeCompare(b.name));
}
