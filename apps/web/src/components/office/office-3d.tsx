"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { animationFor, initials, moveToward, resolveLook, SHIRT_COLORS, spotPoint, stableHash, type Activity, type OfficeLook, type Pose, type Spot, type Point } from "@wfos/shared/office";
import { type OfficeViewProps } from "./office-2d";
import { createChibiKit, poseChibi, textTexture, type Chibi } from "./chibi";
import { loadOfficeAssets, type OfficeAssets } from "./office-assets";
import type { OfficePerson } from "./use-office";

// start fetching the models as soon as this chunk loads, while React mounts the view
if (typeof window !== "undefined") void loadOfficeAssets().catch(() => {});

// One floor tile of the shared layout is one world unit: layout x → world x, layout y → world z.
// Every model faces +z at rotation 0. Scales bring the packs to that unit:
const K = 2.5; // Kenney furniture kit
const KK = 0.62; // KayKit furniture
const TAG_Y = 2.05;
const WALL_H = 1.15;
const WALL_T = 0.18;
const BASE_H = 0.4;
const ROOM_COLORS = ["#7c5cff", "#f0b429", "#1fae7a", "#2fb5d0", "#e25385", "#ef8a4a"];
const C = {
  ground: "#2a2838",
  grid: "#34304a",
  floor: "#e7dcc8",
  lobby: "#efe6d6",
  corridor: "#efe7d8",
  base: "#ece8e1",
  wall: "#f1eee8",
  glass: "#bcd3e3",
  sign: "#24222b",
  planter: "#b98a5a",
};
/** the person behind the reception desk */
const RECEPTIONIST: OfficeLook = { skin: 1, hair: "bun", hairColor: 2, beard: "none", glasses: "none", hat: "none", shirt: 0, logo: true };
/** screen glow per activity: colour, intensity */
const GLOW: Record<Activity, [string, number]> = {
  typing: ["#7dd3fc", 1.4],
  terminal: ["#86efac", 1.3],
  reading: ["#7dd3fc", 0.9],
  thinking: ["#c4b5fd", 1.0],
  waiting: ["#fbbf24", 1.3],
  paused: ["#7f1d1d", 0.6],
  idle: ["#1e2533", 0.35],
};
const STATUS_COLOR: Record<Activity, string> = {
  typing: "#5ad1f0",
  terminal: "#5ad1f0",
  reading: "#5ad1f0",
  thinking: "#5ad1f0",
  waiting: "#fbbf24",
  paused: "#f87171",
  idle: "#a3acbd",
};
const SEATED: Pose[] = ["type", "sit", "chat", "sleep"];
/** which way a character faces once it has arrived at a spot (radians around y; 0 faces the camera side) */
const FACING: Record<Spot, number> = { desk: Math.PI, bookshelf: Math.PI, rack: Math.PI, coffee: Math.PI, lounge: 0 };

interface Avatar {
  c: Chibi;
  lookKey: string;
  pos: Point & { walking: boolean };
  heading: number;
  phase: number;
  tag: HTMLDivElement;
  tagKey: string;
  card: boolean;
}

const pick = <T,>(arr: readonly T[], h: number): T => arr[h % arr.length]!;
const light = (hex: string) => new THREE.Color(hex).getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;

/** Low-poly 3D office (three.js; CC0 furniture from public/office, characters from chibi.ts). Same layout and behaviour as the 2D view; loaded only when chosen. */
export default function Office3D({ state, reducedMotion, labels, onSelect, onUnavailable }: OfficeViewProps & { onUnavailable: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const [assets, setAssets] = useState<OfficeAssets | null>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const unavailableRef = useRef(onUnavailable);
  unavailableRef.current = onUnavailable;
  const rerender = useRef<() => void>(() => {});
  const { layout, workspaceName } = state;

  useEffect(() => {
    let live = true;
    loadOfficeAssets().then(
      (a) => live && setAssets(a),
      () => live && unavailableRef.current(),
    );
    return () => {
      live = false;
    };
  }, []);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !assets) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      unavailableRef.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(C.ground);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.style.display = "block";
    const overlay = document.createElement("div");
    overlay.className = "pointer-events-none absolute inset-0 overflow-hidden";
    el.appendChild(overlay);

    const scene = new THREE.Scene();
    scene.background = new THREE.Color(C.ground);
    const center = new THREE.Vector3(layout.width / 2, 0, layout.height / 2);
    const span = Math.max(layout.width, layout.height);
    scene.fog = new THREE.Fog(C.ground, span * 1.6 + 20, span * 3 + 50); // the grid fades out around the building
    scene.add(new THREE.HemisphereLight("#fff8ee", "#4a4568", 1.3));
    const sun = new THREE.DirectionalLight("#ffe9cc", 2.6);
    sun.position.set(center.x - span * 0.45, span * 0.8 + 10, center.z - span * 0.25);
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const half = span / 2 + 4;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: span * 2.5 + 40 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    scene.add(sun, sun.target);

    // ---------- materials, geometry, helpers (everything created here is disposed on cleanup; models are shared) ----------
    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    const mats = new Map<string, THREE.MeshStandardMaterial>();
    const mat = (color: string, extra?: THREE.MeshStandardMaterialParameters) => {
      const k = color + (extra ? JSON.stringify(extra) : "");
      let m = mats.get(k);
      if (!m) mats.set(k, (m = track(new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra }))));
      return m;
    };
    const geos = new Map<string, THREE.BufferGeometry>();
    const boxGeo = (w: number, h: number, d: number) => {
      const k = `${w},${h},${d}`;
      let g = geos.get(k);
      if (!g) geos.set(k, (g = track(new THREE.BoxGeometry(w, h, d))));
      return g;
    };
    const add = (geo: THREE.BufferGeometry, m: THREE.Material | THREE.Material[], x: number, y: number, z: number, parent: THREE.Object3D = scene) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const box = (w: number, h: number, d: number, color: string, x: number, y: number, z: number, parent?: THREE.Object3D) =>
      add(boxGeo(w, h, d), mat(color), x, y, z, parent);
    const plane = (w: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const p = new THREE.Mesh(track(new THREE.PlaneGeometry(w, d)), m);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x, y, z);
      p.receiveShadow = true;
      scene.add(p);
      return p;
    };
    /** a model from the packs, footprint centred on (x, z) */
    const put = (name: string, scale: number, x: number, z: number, rotY = 0, y = 0) => {
      const m = assets.place(name, scale);
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      scene.add(m);
      return m;
    };
    const height = (name: string, scale: number) => assets.size(name).y * scale;
    const roomColor = (key: string) => pick(ROOM_COLORS, stableHash(key));
    const ledMat = track(new THREE.MeshStandardMaterial({ color: "#14532d", emissive: "#22c55e", emissiveIntensity: 1 }));
    const canvasTexture = (w: number, h: number, draw: (ctx: CanvasRenderingContext2D) => void) => {
      const c = document.createElement("canvas");
      c.width = w;
      c.height = h;
      draw(c.getContext("2d")!);
      const t = track(new THREE.CanvasTexture(c));
      t.colorSpace = THREE.SRGBColorSpace;
      t.anisotropy = 8;
      return t;
    };
    /** a flat textured sign: on the floor (rotX −π/2) or upright */
    const sign = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, rotX = 0) => {
      const m = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })));
      m.rotation.x = rotX;
      m.position.set(x, y, z);
      scene.add(m);
      return m;
    };
    const company = workspaceName.trim();
    const mark = initials(company);
    const badgeLight = mark ? track(textTexture(mark, { color: "#f1f0ec" })) : null;
    const badgeDark = mark ? track(textTexture(mark, { color: "#1f1d24" })) : null;

    // ---------- ground and building base ----------
    plane(600, 600, track(new THREE.MeshStandardMaterial({ color: C.ground, roughness: 1 })), center.x, -BASE_H, center.z);
    const grid = track(new THREE.GridHelper(400, 100, C.grid, C.grid));
    grid.position.set(center.x, -BASE_H + 0.005, center.z);
    scene.add(grid);
    const baseSide = mat(C.base);
    const base = add(boxGeo(layout.width + 2, BASE_H, layout.height + 2), [baseSide, baseSide, mat(C.corridor), baseSide, baseSide, baseSide], center.x, -BASE_H / 2, center.z);
    base.castShadow = false;

    // ---------- walls: the far wall has windows; side walls are solid; the near edge is a low curb with a doorway ----------
    const wallX = (wx0: number, wx1: number, z: number, windows: boolean) => {
      const len = wx1 - wx0;
      const cx = (wx0 + wx1) / 2;
      if (len <= 0) return;
      if (!windows || len < 3) return void box(len + WALL_T, WALL_H, WALL_T, C.wall, cx, WALL_H / 2, z);
      box(len + WALL_T, 0.45, WALL_T, C.wall, cx, 0.225, z);
      box(len + WALL_T, 0.2, WALL_T, C.wall, cx, WALL_H - 0.1, z);
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i <= n; i++) box(i === 0 || i === n ? 0.4 : 0.2, WALL_H - 0.65, WALL_T, C.wall, wx0 + (i * len) / n, 0.45 + (WALL_H - 0.65) / 2, z);
      const glass = new THREE.Mesh(boxGeo(len, WALL_H - 0.65, 0.04), mat(C.glass, { transparent: true, opacity: 0.45, roughness: 0.1 }));
      glass.position.set(cx, 0.45 + (WALL_H - 0.65) / 2, z);
      scene.add(glass);
    };
    const wallZ = (wz0: number, wz1: number, x: number) => box(WALL_T, WALL_H, wz1 - wz0 + WALL_T, C.wall, x, WALL_H / 2, (wz0 + wz1) / 2);
    const curb = (cx0: number, cx1: number, z: number) => cx1 > cx0 && box(cx1 - cx0 + WALL_T, 0.22, WALL_T, C.wall, (cx0 + cx1) / 2, 0.11, z);

    // ---------- rooms ----------
    const floorLabel = (text: string, x: number, z: number) => {
      const tex = canvasTexture(1024, 128, (ctx) => {
        ctx.fillStyle = "#2b2740";
        ctx.font = "800 84px system-ui, sans-serif";
        ctx.textBaseline = "middle";
        ctx.fillText(text, 6, 66, 1010);
      });
      const geo = track(new THREE.PlaneGeometry(6.4, 0.8));
      geo.translate(3.2, -0.4, 0);
      const m = new THREE.Mesh(geo, track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })));
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.006, z);
      scene.add(m);
    };

    for (const r of [...layout.rooms, layout.lounge]) {
      const color = r.kind === "lounge" ? "#d9a26b" : r.kind === "general" ? "#a8a2b8" : roomColor(r.key);
      plane(r.w, r.h, mat(C.floor), r.x + r.w / 2, 0.004, r.y + r.h / 2);
      wallX(r.x, r.x + r.w, r.y, true);
      wallZ(r.y, r.y + r.h, r.x);
      wallZ(r.y, r.y + r.h, r.x + r.w);
      const door = r.x + r.w / 2;
      curb(r.x, door - 0.9, r.y + r.h);
      curb(door + 0.9, r.x + r.w, r.y + r.h);
      put("pottedPlant", 2.2, r.x + 0.5, r.y + r.h - 0.5);
      put("pottedPlant", 2.2, r.x + r.w - 0.5, r.y + r.h - 0.5);
      const name = r.kind === "lounge" ? labelsRef.current.lounge : stateRef.current.roomLabel(r.key);
      if (name) floorLabel(name, r.x + 0.95, r.y + r.h - 0.95);

      if (r.kind === "lounge") {
        const lg = layout.lounge;
        // a rug under the sofas, stretched to the seating area
        const rug = put("rug_rectangle_stripes_A", 1, r.x + r.w / 2, r.y + 2.3 + (r.h - 2.6) / 2, 0, 0.004);
        const rs = assets.size("rug_rectangle_stripes_A");
        rug.scale.set((r.w - 1.2) / rs.x, 0.3, (r.h - 2.6) / rs.z);
        lg.seats.forEach((s, i) => put(i % 3 === 2 ? "armchair_pillows" : "couch_pillows", KK, s.x, s.y - 0.15));
        put("lamp_standing", KK, r.x + 0.6, r.y + 0.7);
        put("lamp_standing", KK, r.x + r.w - 0.6, r.y + r.h - 1.6);
        // coffee corner: two cabinets, the machine and a plant on top
        const counter = height("kitchenCabinet", K);
        put("kitchenCabinet", K, lg.coffee.x - 0.95, lg.coffee.y - 0.35);
        put("kitchenCabinet", K, lg.coffee.x + 0.13, lg.coffee.y - 0.35);
        put("kitchenCoffeeMachine", K, lg.coffee.x - 0.1, lg.coffee.y - 0.45, 0, counter);
        put("plantSmall2", K, lg.coffee.x - 1.2, lg.coffee.y - 0.4, 0, counter);
        continue;
      }
      // work area rug, a cabinet with books to read at, a server rack to operate
      plane(r.w - 1.2, r.h - 3.7, mat(color, { roughness: 1 }), r.x + r.w / 2, 0.008, r.y + 2.6 + (r.h - 3.7) / 2);
      put("cabinet_medium_decorated", KK * 1.4, r.bookshelf.x, r.bookshelf.y - 0.25);
      box(0.9, 1.6, 0.8, "#1f2937", r.rack.x, 0.8, r.rack.y - 0.1);
      for (let i = 0; i < 4; i++) add(boxGeo(0.5, 0.05, 0.02), ledMat, r.rack.x - 0.1, 0.4 + i * 0.32, r.rack.y + 0.31);
    }

    // ---------- reception: company sign on the back wall, a counter with a receptionist, a waiting corner ----------
    const rc = layout.reception;
    const rcx = rc.x + rc.w / 2;
    plane(rc.w, rc.h, mat(C.lobby), rcx, 0.004, rc.y + rc.h / 2);
    // back wall with a doorway towards the offices on each side of the sign; side walls; the street side is open glass
    const signW = Math.min(6, rc.w * 0.45);
    const doorL = rc.x + Math.max(1.5, rc.w * 0.18);
    const doorR = rc.x + rc.w - Math.max(1.5, rc.w * 0.18);
    wallX(rc.x, doorL - 0.9, rc.y, false);
    wallX(doorL + 0.9, doorR - 0.9, rc.y, false);
    wallX(doorR + 0.9, rc.x + rc.w, rc.y, false);
    wallZ(rc.y, rc.y + rc.h, rc.x);
    wallZ(rc.y, rc.y + rc.h, rc.x + rc.w);
    curb(rc.x, rcx - 1.6, rc.y + rc.h);
    curb(rcx + 1.6, rc.x + rc.w, rc.y + rc.h);
    // the sign: a dark panel on the wall with the initials and the company name
    const signH = 1.55;
    box(signW, signH, 0.14, C.sign, rcx, signH / 2, rc.y + 0.15);
    if (company) {
      const signTex = canvasTexture(1024, 384, (ctx) => {
        ctx.fillStyle = "#f1f0ec";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = "900 190px system-ui, sans-serif";
        ctx.fillText(mark, 512, 150, 980);
        ctx.font = "700 64px system-ui, sans-serif";
        ctx.fillText(company, 512, 310, 980);
      });
      sign(signTex, signW * 0.92, signW * 0.92 * (384 / 1024), rcx, signH * 0.6, rc.y + 0.23);
    }
    put("pottedPlant", 2.2, rcx - signW / 2 - 0.5, rc.y + 0.5);
    put("pottedPlant", 2.2, rcx + signW / 2 + 0.5, rc.y + 0.5);
    // counter of three bar sections, a screen and a plant on it, the receptionist behind
    const counterTop = height("kitchenBar", K);
    const barW = assets.size("kitchenBar").x * K;
    for (const i of [-1, 0, 1]) put("kitchenBar", K, rc.desk.x + i * barW, rc.desk.y);
    put("computerScreen", 1.6, rc.desk.x - 0.4, rc.desk.y - 0.1, Math.PI, counterTop);
    put("plantSmall1", K, rc.desk.x + barW, rc.desk.y, 0, counterTop);
    // the floor mat at the entrance
    box(3, 0.02, 1.3, C.sign, rcx, 0.012, rc.y + rc.h - 0.9);
    if (badgeLight) sign(badgeLight, 2.4, 1.2, rcx, 0.025, rc.y + rc.h - 0.9, -Math.PI / 2);
    // waiting corners: a sofa and table on the left, armchairs and a lamp on the right
    const side = Math.min(2.4, rc.w * 0.18);
    put("rug_oval_A", KK, rc.x + side, rc.y + rc.h / 2 + 0.6, 0, 0.004);
    put("couch_pillows", KK, rc.x + 0.75, rc.y + rc.h / 2 + 0.6, Math.PI / 2);
    put("table_low", KK * 0.8, rc.x + side + 0.3, rc.y + rc.h / 2 + 0.6, Math.PI / 2);
    put("armchair_pillows", KK, rc.x + rc.w - 0.8, rc.y + rc.h / 2, -Math.PI / 2);
    put("armchair_pillows", KK, rc.x + rc.w - 0.8, rc.y + rc.h / 2 + 1.4, -Math.PI / 2);
    put("lamp_standing", KK, rc.x + rc.w - 0.6, rc.y + rc.h - 0.6);
    put("cactus_medium_A", KK, rc.x + 0.6, rc.y + rc.h - 0.6);

    // desks: monitors whose screens glow with what the person is doing, keyboard, mouse, a planter, office chair
    const screens = new Map<string, THREE.MeshStandardMaterial>();
    const top = height("desk", K);
    for (const d of layout.desks) {
      const cx = d.x + 1;
      const h = stableHash(d.employeeId);
      put("desk", K, cx, d.y + 0.5);
      const scr = track(new THREE.MeshStandardMaterial({ color: "#0d0d12", emissive: GLOW.idle[0], emissiveIntensity: GLOW.idle[1], roughness: 0.35 }));
      screens.set(d.employeeId, scr);
      for (const off of h % 3 === 0 ? [0] : [-0.34, 0.34]) {
        const mon = put("computerScreen", 1.6, cx + off, d.y + 0.3, -off * 0.5, top);
        // the light face of the Kenney screen ("metal") becomes this desk's glowing screen
        mon.traverse((o) => {
          if (o instanceof THREE.Mesh && (o.material as THREE.Material).name === "metal") o.material = scr;
        });
      }
      put("computerKeyboard", 2.2, cx, d.y + 0.72, 0, top);
      put("computerMouse", 2.2, cx + 0.48, d.y + 0.72, 0, top);
      // a planter along the back edge, as in shared offices
      box(1.7, 0.1, 0.16, C.planter, cx, top + 0.05, d.y + 0.08);
      for (const [i, px] of [-0.6, 0, 0.6].entries()) put(pick(["plantSmall1", "plantSmall2", "plantSmall3"], (h >>> i) & 7), K * 0.9, cx + px, d.y + 0.08, 0, top + 0.06);
      put("chairDesk", K, d.seat.x, d.seat.y - 0.3, Math.PI);
    }

    // ---------- characters ----------
    const kit = createChibiKit();
    const pickables: THREE.Object3D[] = [];
    const hitGeo = boxGeo(0.9, 1.7, 0.9);
    const hitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
    const badgeFor = (look: OfficeLook) => (light(SHIRT_COLORS[look.shirt] ?? "#000") ? badgeDark : badgeLight);
    const receptionist = kit.build(RECEPTIONIST, { logo: badgeFor(RECEPTIONIST) });
    receptionist.root.position.set(rc.desk.x + 0.3, 0, rc.desk.y - 0.9);
    scene.add(receptionist.root);

    const avatars = new Map<string, Avatar>();
    const removeAvatar = (id: string, a: Avatar) => {
      scene.remove(a.c.root);
      a.tag.remove();
      for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i]!.userData.id === id) pickables.splice(i, 1);
      avatars.delete(id);
    };
    const ensureAvatar = (p: OfficePerson, at: Point): Avatar => {
      const look = resolveLook(p.id, p.look);
      const lookKey = JSON.stringify(look);
      let a = avatars.get(p.id);
      if (a && a.lookKey === lookKey) return a;
      // a changed look rebuilds the character where it stands
      const from = a ? { pos: a.pos, heading: a.heading } : { pos: { ...at, walking: false }, heading: Math.PI };
      if (a) removeAvatar(p.id, a);
      const c = kit.build(look, { logo: badgeFor(look) });
      scene.add(c.root);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 0.65;
      hit.userData.id = p.id;
      c.root.add(hit);
      pickables.push(hit);
      const tag = document.createElement("div");
      tag.addEventListener("click", () => {
        const person = stateRef.current.people.current.get(p.id);
        if (person) selectRef.current(person);
      });
      overlay.appendChild(tag);
      a = { c, lookKey, ...from, phase: (stableHash(p.id) % 1000) / 160, tag, tagKey: "", card: false };
      avatars.set(p.id, a);
      return a;
    };

    // ---------- task cards above people (DOM; all text goes through textContent) ----------
    const node = (tag: string, className: string, text?: string) => {
      const n = document.createElement(tag);
      n.className = className;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    const renderTag = (a: Avatar, p: OfficePerson, act: Activity, room: string) => {
      const activityText = labelsRef.current.activity(p);
      const tool = p.lastStep?.kind === "tool" ? p.lastStep.name.replace(/^mcp__.+?__/, "") : "";
      const key = [act, p.name, p.avatar, p.task?.title ?? "", room, activityText, tool].join("|");
      if (key === a.tagKey) return;
      a.tagKey = key;
      a.card = !!p.task;
      a.tag.replaceChildren();
      if (p.task) {
        a.tag.className = `pointer-events-auto absolute left-0 top-0 max-w-64 min-w-40 origin-bottom cursor-pointer rounded-lg bg-[#17151d] px-2.5 pb-1.5 pt-1 text-white shadow-lg ${act === "waiting" ? "ring-2 ring-amber-400" : ""}`;
        a.tag.append(node("div", "truncate text-[10.5px] text-white/60", room ? `${p.name} · ${room}` : p.name));
        a.tag.append(node("div", "line-clamp-2 text-[14px] font-bold leading-tight", p.task.title || activityText));
        const meta = node("div", "mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-white/60");
        const st = node("span", "inline-flex items-center gap-1 font-semibold");
        st.style.color = STATUS_COLOR[act];
        st.append(
          act === "waiting"
            ? node("span", "grid size-3 place-items-center rounded-full bg-amber-400 text-[9px] font-black text-[#17151d]", "!")
            : node("span", `size-2.5 rounded-full border-[1.6px] border-current border-r-transparent ${reducedMotion ? "" : "animate-spin"}`),
          activityText,
        );
        meta.append(st);
        if (tool) meta.append(node("span", "font-mono", tool));
        a.tag.append(meta, node("div", "absolute -bottom-1.5 left-1/2 -ml-1.5 size-0 border-x-[6px] border-t-[6px] border-x-transparent border-t-[#17151d]"));
      } else {
        a.tag.className =
          "pointer-events-auto absolute left-0 top-0 flex origin-bottom cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-full bg-[#17151d]/85 px-2 py-0.5 text-[11px] font-medium text-white";
        const dot = node("span", "size-1.5 rounded-full");
        dot.style.background = STATUS_COLOR[act];
        a.tag.append(dot, node("span", "", `${p.avatar} ${p.name}`));
        if (act === "paused") a.tag.append(node("span", "text-white/60", "zz"));
      }
      a.tag.title = `${p.name} · ${activityText}${p.task?.title ? ` · ${p.task.title}` : ""}`;
    };

    // ---------- camera ----------
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 800);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.enableZoom = false; // wheel zoom only after the user clicks into the office, so the page still scrolls
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = 1.2;
    renderer.domElement.style.touchAction = "pan-y";
    const viewDir = new THREE.Vector3(-0.35, 0.78, 0.62).normalize();
    let maxDist = 200;
    const corners = [-1, layout.width + 1].flatMap((x) => [-1, layout.height + 1].flatMap((z) => [0, WALL_H].map((y) => new THREE.Vector3(x, y, z))));
    /** frame the whole office: move back until every corner of the building is on screen */
    const home = () => {
      let dist = span * 1.5;
      for (let i = 0; i < 12; i++) {
        camera.position.copy(center).addScaledVector(viewDir, dist);
        camera.lookAt(center);
        camera.updateMatrixWorld();
        const reach = Math.max(
          ...corners.map((c) => {
            const v = c.clone().project(camera);
            return Math.max(Math.abs(v.x), Math.abs(v.y));
          }),
        );
        dist *= reach / 0.94;
      }
      maxDist = dist * 2;
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(viewDir, dist);
      controls.update();
    };
    let userMoved = false;
    controls.addEventListener("start", () => {
      userMoved = true;
    });
    controls.addEventListener("change", () => rerender.current());
    const fit = () => {
      const w = el.clientWidth;
      const h = Math.max(360, Math.min(760, Math.round(w * 0.62)));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      if (!userMoved) home();
    };
    fit();
    const ro = new ResizeObserver(() => {
      fit();
      rerender.current();
    });
    ro.observe(el);

    const proj = new THREE.Vector3();
    const placeTags = () => {
      const w = el.clientWidth;
      const h = renderer.domElement.clientHeight;
      for (const a of avatars.values()) {
        const r = a.c.root;
        proj.set(r.position.x, r.position.y + TAG_Y, r.position.z);
        const dist = camera.position.distanceTo(proj);
        proj.project(camera);
        if (proj.z > 1 || Math.abs(proj.x) > 1.2 || proj.y < -1.2 || proj.y > 1.3) {
          a.tag.style.display = "none";
          continue;
        }
        a.tag.style.display = "";
        const compact = a.card && dist > 22;
        if (a.card) [0, 2].forEach((i) => ((a.tag.children[i] as HTMLElement).style.display = compact ? "none" : ""));
        a.tag.style.zIndex = String(10000 - Math.round(dist * 10));
        a.tag.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -100%) scale(${THREE.MathUtils.clamp(16 / dist, 0.45, 1)})`;
      }
    };

    // ---------- per-frame update ----------
    const update = (dt: number, t: number) => {
      const s = stateRef.current;
      const people = s.people.current;
      const now = Date.now();
      for (const p of people.values()) {
        const act = s.activityOf(p, now);
        const anim = animationFor(act, p.id, now);
        const target = spotPoint(layout, p.id, anim.spot);
        const a = ensureAvatar(p, target);
        const m = reducedMotion ? { pos: target, arrived: true } : moveToward(a.pos, target, dt);
        const dx = m.pos.x - a.pos.x;
        const dz = m.pos.y - a.pos.y;
        a.pos = { ...m.pos, walking: !m.arrived };
        const goal = a.pos.walking && Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : FACING[anim.spot];
        a.heading += Math.atan2(Math.sin(goal - a.heading), Math.cos(goal - a.heading)) * (reducedMotion ? 1 : Math.min(1, dt / 100));
        const root = a.c.root;
        root.rotation.y = a.heading;
        // someone waiting for approval stands beside their chair, waving
        const standOff = !a.pos.walking && anim.pose === "stand" && anim.spot === "desk" ? 0.6 : 0;
        root.position.x = a.pos.x + standOff;
        root.position.z = a.pos.y + (a.pos.walking ? 0 : SEATED.includes(anim.pose) ? (anim.spot === "desk" ? -0.25 : -0.05) : 0.15);
        poseChibi(a.c, a.pos.walking ? "walk" : anim.pose, t, a.phase, reducedMotion);
        const scr = screens.get(p.id);
        if (scr) {
          scr.emissive.set(GLOW[act][0]);
          scr.emissiveIntensity = GLOW[act][1];
        }
        const desk = layout.desks.find((d) => d.employeeId === p.id);
        renderTag(a, p, act, desk ? s.roomLabel(desk.room) : "");
      }
      for (const [id, a] of avatars) if (!people.has(id)) removeAvatar(id, a);
      poseChibi(receptionist, "idle", t, 0, reducedMotion);
      ledMat.emissiveIntensity = reducedMotion ? 1 : 0.6 + Math.abs(Math.sin(t / 400)) * 0.8;
      controls.update();
      renderer.render(scene, camera);
      placeTags();
    };

    // loop: rAF while visible, paused when hidden; reduced motion renders on change and every few seconds
    let raf = 0;
    let timer: ReturnType<typeof setInterval> | undefined;
    let last = performance.now();
    const frame = (t: number) => {
      update(Math.min(100, t - last), t);
      last = t;
      raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      clearInterval(timer);
    };
    const start = () => {
      stop();
      if (document.hidden) return;
      if (reducedMotion) {
        update(0, performance.now());
        timer = setInterval(() => update(0, performance.now()), 5000);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    let pending = false;
    rerender.current = () => {
      if (!reducedMotion || document.hidden || pending) return;
      pending = true;
      requestAnimationFrame(() => {
        pending = false;
        update(0, performance.now());
      });
    };
    start();
    document.addEventListener("visibilitychange", start);

    // ---------- input: click a person to open them, wheel zoom once engaged, double-click to reset the view ----------
    const ray = new THREE.Raycaster();
    const pickAt = (e: MouseEvent): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      return (ray.intersectObjects(pickables, false)[0]?.object.userData.id as string | undefined) ?? null;
    };
    let engaged = false;
    let downAt: [number, number] | null = null;
    const onDown = (e: PointerEvent) => {
      engaged = true;
      downAt = [e.clientX, e.clientY];
    };
    const onUp = (e: PointerEvent) => {
      if (!downAt || Math.hypot(e.clientX - downAt[0], e.clientY - downAt[1]) > 5) return;
      const id = pickAt(e);
      const p = id ? stateRef.current.people.current.get(id) : undefined;
      if (p) selectRef.current(p);
    };
    const onMove = (e: PointerEvent) => {
      if (!e.buttons) renderer.domElement.style.cursor = pickAt(e) ? "pointer" : "grab";
    };
    const onLeave = () => {
      engaged = false;
    };
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const onWheel = (e: WheelEvent) => {
      if (!engaged) return;
      e.preventDefault();
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const at = ray.ray.intersectPlane(floor, new THREE.Vector3()) ?? controls.target.clone();
      const dist = camera.position.distanceTo(controls.target);
      const k = THREE.MathUtils.clamp(dist * Math.exp(e.deltaY * 0.0015), 10, maxDist) / dist;
      camera.position.sub(at).multiplyScalar(k).add(at);
      controls.target.sub(at).multiplyScalar(k).add(at);
      userMoved = true;
      controls.update();
    };
    const onDblClick = () => {
      userMoved = false;
      home();
    };
    const dom = renderer.domElement;
    dom.addEventListener("pointerdown", onDown);
    dom.addEventListener("pointerup", onUp);
    dom.addEventListener("pointermove", onMove);
    dom.addEventListener("pointerleave", onLeave);
    dom.addEventListener("wheel", onWheel, { passive: false });
    dom.addEventListener("dblclick", onDblClick);

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", start);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("dblclick", onDblClick);
      for (const [id, a] of avatars) removeAvatar(id, a);
      controls.dispose();
      kit.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      dom.remove();
      overlay.remove();
    };
    // the scene is rebuilt when the layout or the company name changes; live state is read through refs
  }, [layout, workspaceName, reducedMotion, assets]);

  useEffect(() => rerender.current(), [state.version]);

  return <div ref={wrap} aria-busy={!assets} className={`relative w-full overflow-hidden rounded-lg border ${assets ? "" : "h-[360px] animate-pulse bg-muted"}`} />;
}
