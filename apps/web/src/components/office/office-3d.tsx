"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { animationFor, moveToward, spotPoint, stableHash, type Activity, type Pose, type Spot, type Point } from "@wfos/shared/office";
import { BODY_COLORS, type OfficeViewProps } from "./office-2d";
import type { OfficePerson } from "./use-office";

// One floor tile of the shared layout is one world unit: layout x → world x, layout y → world z.
const S = 1.3; // character scale
const WALL_H = 1.15;
const WALL_T = 0.18;
const BASE_H = 0.4;
const ROOM_COLORS = ["#7c5cff", "#f0b429", "#1fae7a", "#2fb5d0", "#e25385", "#ef8a4a"];
const SKINS = ["#f3cba7", "#e2ae86", "#c78b62", "#9a6644", "#f6d8be", "#b67a52"];
const HAIRS = ["#1d1917", "#2e221b", "#3d2a1e", "#14131a", "#5a3a24", "#c99a5b", "#7a4a2a"];
const STYLES = ["short", "bob", "bun", "tail", "afro"] as const;
const C = {
  floor: "#e7dcc8",
  corridor: "#efe7d8",
  base: "#ece8e1",
  wall: "#f1eee8",
  glass: "#bcd3e3",
  wood: "#e6cfa8",
  woodDark: "#b98a5a",
  metal: "#3a3742",
  screen: "#22202a",
  leaf: "#5aa35f",
  leaf2: "#3f8a4d",
  pot: "#eee8dd",
  chairs: ["#b9cba9", "#efede7", "#e2aa70", "#efede7"],
};
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

interface Rig {
  root: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  head: THREE.Group;
  book: THREE.Mesh;
}
interface Avatar extends Rig {
  pos: Point & { walking: boolean };
  heading: number;
  phase: number;
  tag: HTMLDivElement;
  tagKey: string;
  card: boolean;
}

const pick = <T,>(arr: readonly T[], h: number): T => arr[h % arr.length]!;

/** Low-poly 3D office (three.js). Same layout and behaviour as the 2D view; loaded only when chosen. */
export default function Office3D({ state, reducedMotion, labels, onSelect, onUnavailable }: OfficeViewProps & { onUnavailable: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
  const labelsRef = useRef(labels);
  labelsRef.current = labels;
  const selectRef = useRef(onSelect);
  selectRef.current = onSelect;
  const rerender = useRef<() => void>(() => {});
  const { layout } = state;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      onUnavailable();
      return;
    }
    const dark = document.documentElement.classList.contains("dark");
    const groundColor = dark ? "#2b2740" : "#d9d4ea";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(groundColor);
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
    scene.background = new THREE.Color(groundColor);
    const center = new THREE.Vector3(layout.width / 2, 0, layout.height / 2);
    const span = Math.max(layout.width, layout.height);
    scene.add(new THREE.HemisphereLight("#fff8ee", dark ? "#3d3858" : "#8a84a8", 1.3));
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

    // ---------- materials, geometry, helpers (everything created here is disposed on cleanup) ----------
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
    const cyl = (rt: number, rb: number, h: number, color: string, x: number, y: number, z: number, parent?: THREE.Object3D) =>
      add(track(new THREE.CylinderGeometry(rt, rb, h, 14)), mat(color), x, y, z, parent);
    const group = (parent: THREE.Object3D, x: number, z: number, rotY = 0) => {
      const g = new THREE.Group();
      g.position.set(x, 0, z);
      g.rotation.y = rotY;
      parent.add(g);
      return g;
    };
    const plane = (w: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const p = new THREE.Mesh(track(new THREE.PlaneGeometry(w, d)), m);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x, y, z);
      p.receiveShadow = true;
      scene.add(p);
      return p;
    };
    const tint = (hex: string, toward: string, k: number) => "#" + new THREE.Color(hex).lerp(new THREE.Color(toward), k).getHexString();
    const roomColor = (key: string) => pick(ROOM_COLORS, stableHash(key));
    const ledMat = track(new THREE.MeshStandardMaterial({ color: "#14532d", emissive: "#22c55e", emissiveIntensity: 1 }));

    // ---------- ground and building base ----------
    plane(600, 600, track(new THREE.MeshStandardMaterial({ color: groundColor, roughness: 1 })), center.x, -BASE_H, center.z);
    const gridColor = dark ? "#3b3654" : "#c4bedb";
    const grid = track(new THREE.GridHelper(400, 200, gridColor, gridColor));
    grid.position.set(center.x, -BASE_H + 0.005, center.z);
    scene.add(grid);
    const baseSide = mat(C.base);
    const base = add(boxGeo(layout.width + 2, BASE_H, layout.height + 2), [baseSide, baseSide, mat(C.corridor), baseSide, baseSide, baseSide], center.x, -BASE_H / 2, center.z);
    base.castShadow = false;

    // ---------- furniture ----------
    const leafGeo = track(new THREE.IcosahedronGeometry(0.2, 0));
    const potGeo = track(new THREE.CylinderGeometry(0.17, 0.13, 0.3, 14));
    const plant = (x: number, z: number, s = 1) => {
      const g = group(scene, x, z);
      g.scale.setScalar(s);
      add(potGeo, mat(C.pot), 0, 0.15, 0, g);
      [[0, 0.45, 0, 1], [0.13, 0.4, 0.1, 0.8], [-0.12, 0.42, -0.07, 0.85], [0.02, 0.62, -0.04, 0.8]].forEach(([a, b, c, k], i) =>
        add(leafGeo, mat(i % 2 ? C.leaf : C.leaf2, { flatShading: true }), a!, b!, c!, g).scale.setScalar(k!),
      );
    };
    const chair = (x: number, z: number, rotY: number, color: string) => {
      const g = group(scene, x, z, rotY);
      g.scale.setScalar(S);
      for (let i = 0; i < 5; i++) {
        const leg = box(0.05, 0.04, 0.26, C.metal, 0, 0.04, 0, g);
        leg.rotation.y = (i * Math.PI * 2) / 5;
        leg.translateZ(0.12);
      }
      box(0.05, 0.26, 0.05, C.metal, 0, 0.17, 0, g);
      box(0.44, 0.07, 0.42, color, 0, 0.32, 0, g);
      box(0.42, 0.42, 0.07, color, 0, 0.6, -0.2, g).rotation.x = -0.08;
    };
    const sofa = (x: number, z: number, rotY: number, color: string, w = 1.5) => {
      const g = group(scene, x, z, rotY);
      box(w, 0.3, 0.75, color, 0, 0.22, 0, g);
      box(w, 0.5, 0.2, color, 0, 0.5, -0.3, g);
      box(0.2, 0.42, 0.75, color, -w / 2 + 0.1, 0.34, 0, g);
      box(0.2, 0.42, 0.75, color, w / 2 - 0.1, 0.34, 0, g);
    };
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

    // walls: the far wall has windows; side walls are solid; the near edge is a low curb with a doorway, so rooms stay visible
    const wallX = (x0: number, x1: number, z: number, windows: boolean) => {
      const len = x1 - x0;
      const cx = (x0 + x1) / 2;
      if (!windows || len < 3) return void box(len + WALL_T, WALL_H, WALL_T, C.wall, cx, WALL_H / 2, z);
      box(len + WALL_T, 0.45, WALL_T, C.wall, cx, 0.225, z);
      box(len + WALL_T, 0.2, WALL_T, C.wall, cx, WALL_H - 0.1, z);
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i <= n; i++) box(i === 0 || i === n ? 0.4 : 0.2, WALL_H - 0.65, WALL_T, C.wall, x0 + (i * len) / n, 0.45 + (WALL_H - 0.65) / 2, z);
      const glass = new THREE.Mesh(boxGeo(len, WALL_H - 0.65, 0.04), mat(C.glass, { transparent: true, opacity: 0.45, roughness: 0.1 }));
      glass.position.set(cx, 0.45 + (WALL_H - 0.65) / 2, z);
      scene.add(glass);
    };
    const wallZ = (z0: number, z1: number, x: number) => box(WALL_T, WALL_H, z1 - z0 + WALL_T, C.wall, x, WALL_H / 2, (z0 + z1) / 2);
    const curb = (x0: number, x1: number, z: number) => box(x1 - x0 + WALL_T, 0.22, WALL_T, C.wall, (x0 + x1) / 2, 0.11, z);

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
      plant(r.x + 0.5, r.y + r.h - 0.5, 0.9);
      plant(r.x + r.w - 0.5, r.y + r.h - 0.5, 0.9);
      const name = r.kind === "lounge" ? labelsRef.current.lounge : stateRef.current.roomLabel(r.key);
      if (name) floorLabel(name, r.x + 0.95, r.y + r.h - 0.95);

      if (r.kind === "lounge") {
        const lg = layout.lounge;
        plane(r.w - 1.2, r.h - 2.6, mat(tint(color, "#ffffff", 0.45), { roughness: 1 }), r.x + r.w / 2, 0.008, r.y + 2.3 + (r.h - 2.6) / 2);
        for (const s of lg.seats) sofa(s.x, s.y - 0.05, 0, tint(color, "#efe6d6", 0.3), 1.6);
        // coffee corner
        box(1.6, 0.9, 0.6, C.woodDark, lg.coffee.x - 0.4, 0.45, lg.coffee.y - 0.1);
        box(0.45, 0.55, 0.4, "#2a2833", lg.coffee.x - 0.1, 1.17, lg.coffee.y - 0.15);
        box(0.12, 0.12, 0.12, "#f1f0ec", lg.coffee.x - 0.8, 0.96, lg.coffee.y - 0.05);
        continue;
      }
      // work area rug, bookshelf, server rack
      plane(r.w - 1.2, r.h - 3.7, mat(color, { roughness: 1 }), r.x + r.w / 2, 0.008, r.y + 2.6 + (r.h - 3.7) / 2);
      const shelf = group(scene, r.bookshelf.x, r.bookshelf.y - 0.2);
      box(2, 1.4, 0.4, C.woodDark, 0, 0.7, 0, shelf);
      const books = ["#c0504d", "#4f81bd", "#9bbb59", "#e7c26a", "#8064a2", "#efe9df"];
      for (let row = 0; row < 3; row++)
        for (let i = 0; i < 11; i++) {
          const h = 0.24 + ((i * 7 + row * 3) % 5) * 0.025;
          box(0.13, h, 0.26, books[(i + row * 2) % books.length]!, -0.8 + i * 0.16, 0.12 + row * 0.45 + h / 2, 0.1, shelf);
        }
      box(0.9, 1.6, 0.8, "#1f2937", r.rack.x, 0.8, r.rack.y - 0.1);
      for (let i = 0; i < 4; i++) add(boxGeo(0.5, 0.05, 0.02), ledMat, r.rack.x - 0.1, 0.4 + i * 0.32, r.rack.y + 0.31);
    }

    // desks: wood top, metal legs, monitors that glow with what the person is doing, keyboard, office chair
    const screens = new Map<string, THREE.MeshStandardMaterial>();
    for (const d of layout.desks) {
      const cx = d.x + 1;
      const h = stableHash(d.employeeId);
      box(1.9, 0.06, 0.9, C.wood, cx, 0.8, d.y + 0.5);
      for (const [a, b] of [[-1, -1], [1, -1], [-1, 1], [1, 1]] as const) box(0.06, 0.78, 0.06, C.metal, cx + a * 0.88, 0.39, d.y + 0.5 + b * 0.38);
      const scr = track(new THREE.MeshStandardMaterial({ color: "#0d0d12", emissive: GLOW.idle[0], emissiveIntensity: GLOW.idle[1], roughness: 0.35 }));
      screens.set(d.employeeId, scr);
      for (const off of h % 3 === 0 ? [0] : [-0.32, 0.32]) {
        box(0.05, 0.22, 0.05, C.metal, cx + off, 0.94, d.y + 0.22);
        const frame = box(0.58, 0.36, 0.04, C.screen, cx + off, 1.2, d.y + 0.22);
        frame.rotation.y = -off * 0.5;
        const face = new THREE.Mesh(boxGeo(0.52, 0.3, 0.01), scr);
        face.position.set(cx + off, 1.2, d.y + 0.245);
        face.rotation.y = -off * 0.5;
        scene.add(face);
      }
      box(0.55, 0.025, 0.17, "#f3f1ec", cx, 0.84, d.y + 0.68);
      box(0.08, 0.025, 0.12, "#f3f1ec", cx + 0.45, 0.84, d.y + 0.68);
      if (h % 4 === 0) cyl(0.05, 0.045, 0.12, pick(["#e07a5f", "#f2cc8f", "#81b29a"], h >>> 3), cx - 0.7, 0.89, d.y + 0.55);
      chair(d.seat.x, d.seat.y + 0.05, Math.PI, pick(C.chairs, h >>> 5));
    }

    // ---------- characters ----------
    const G = {
      leg: track(new THREE.CylinderGeometry(0.085, 0.08, 0.26, 10)),
      shoe: boxGeo(0.13, 0.07, 0.19),
      torso: track(new THREE.CapsuleGeometry(0.2, 0.16, 6, 14)),
      arm: track(new THREE.CapsuleGeometry(0.065, 0.17, 4, 8)),
      hand: track(new THREE.SphereGeometry(0.065, 10, 8)),
      head: track(new THREE.SphereGeometry(0.36, 32, 24)),
      eye: track(new THREE.SphereGeometry(0.04, 12, 8)),
      cap: track(new THREE.SphereGeometry(0.378, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.56)),
      back: track(new THREE.SphereGeometry(0.385, 32, 16, Math.PI, Math.PI, Math.PI * 0.15, Math.PI * 0.62)),
      bun: track(new THREE.SphereGeometry(0.15, 16, 12)),
      tail: track(new THREE.CapsuleGeometry(0.08, 0.22, 4, 8)),
      afro: track(new THREE.SphereGeometry(0.43, 32, 16, 0, Math.PI * 2, 0, Math.PI * 0.6)),
      book: boxGeo(0.26, 0.2, 0.05),
    };
    const pickables: THREE.Object3D[] = [];
    const buildRig = (id: string): Rig => {
      const h = stableHash(id);
      const skin = mat(pick(SKINS, h));
      const hair = mat(pick(HAIRS, h >>> 3), { side: THREE.DoubleSide, roughness: 0.9 });
      const style = pick(STYLES, h >>> 7);
      const hoodie = mat(tint(pick(BODY_COLORS, h), "#1f1d24", 0.7));
      const root = new THREE.Group();
      root.scale.setScalar(S);
      scene.add(root);
      const tag = (m: THREE.Mesh) => {
        m.userData.id = id;
        pickables.push(m);
        return m;
      };
      const limb = (x: number, y: number) => {
        const g = new THREE.Group();
        g.position.set(x, y, 0);
        root.add(g);
        return g;
      };
      const legL = limb(-0.1, 0.28);
      const legR = limb(0.1, 0.28);
      for (const leg of [legL, legR]) {
        tag(add(G.leg, mat("#2c2a35"), 0, -0.13, 0, leg));
        tag(add(G.shoe, mat("#f1f0ec"), 0, -0.26, 0.03, leg));
      }
      tag(add(G.torso, hoodie, 0, 0.5, 0, root)).scale.set(1, 1, 0.85);
      tag(box(0.08, 0.06, 0.02, pick(BODY_COLORS, h), 0.08, 0.6, 0.17, root));
      const armL = limb(-0.25, 0.64);
      const armR = limb(0.25, 0.64);
      for (const arm of [armL, armR]) {
        tag(add(G.arm, hoodie, 0, -0.13, 0, arm));
        tag(add(G.hand, skin, 0, -0.28, 0, arm));
      }
      const book = add(G.book, mat("#4f81bd"), 0, 0.55, 0.32, root);
      book.rotation.x = -0.6;
      book.visible = false;
      const head = limb(0, 1.0);
      tag(add(G.head, skin, 0, 0, 0, head));
      for (const sx of [-1, 1]) tag(add(G.eye, mat("#18161d"), sx * 0.125, -0.03, 0.33, head)).scale.set(1, 1.45, 0.6);
      if (style === "afro") tag(add(G.afro, hair, 0, 0.04, -0.03, head)).rotation.x = -0.32;
      else tag(add(G.cap, hair, 0, 0.01, -0.01, head)).rotation.x = -0.42;
      if (style === "bob") tag(add(G.back, hair, 0, -0.02, 0, head));
      if (style === "bun") tag(add(G.bun, hair, 0, 0.33, -0.16, head));
      if (style === "tail") {
        tag(add(G.bun, hair, 0, 0.12, -0.36, head)).scale.setScalar(0.7);
        tag(add(G.tail, hair, 0, -0.08, -0.42, head));
      }
      return { root, legL, legR, armL, armR, head, book };
    };

    const avatars = new Map<string, Avatar>();
    const ensureAvatar = (p: OfficePerson, at: Point): Avatar => {
      let a = avatars.get(p.id);
      if (a) return a;
      const tag = document.createElement("div");
      tag.addEventListener("click", () => {
        const person = stateRef.current.people.current.get(p.id);
        if (person) selectRef.current(person);
      });
      overlay.appendChild(tag);
      a = { ...buildRig(p.id), pos: { ...at, walking: false }, heading: Math.PI, phase: (stableHash(p.id) % 1000) / 160, tag, tagKey: "", card: false };
      avatars.set(p.id, a);
      return a;
    };
    const removeAvatar = (id: string, a: Avatar) => {
      scene.remove(a.root);
      a.tag.remove();
      for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i]!.userData.id === id) pickables.splice(i, 1);
      avatars.delete(id);
    };

    const pose = (a: Avatar, kind: Pose | "walk", t: number) => {
      const ph = t / 1000 + a.phase;
      const k = reducedMotion ? 0 : 1;
      let legX = 0,
        swing = 0,
        armL = 0,
        armR = 0,
        armRz = 0,
        armLz = 0,
        headX = 0,
        headY = 0,
        bob = 0;
      switch (kind) {
        case "walk":
          swing = Math.sin(ph * 10) * 0.7 * k;
          armL = -swing * 0.8;
          armR = swing * 0.8;
          bob = Math.abs(Math.sin(ph * 10)) * 0.05 * k;
          break;
        case "type":
          legX = -1.45;
          armL = -1.25 + Math.sin(ph * 22) * 0.08 * k;
          armR = -1.25 + Math.sin(ph * 22 + 1.7) * 0.08 * k;
          headX = 0.1;
          break;
        case "sit":
          legX = -1.45;
          armL = armR = -0.45;
          headY = Math.sin(ph * 0.6) * 0.35 * k;
          break;
        case "chat":
          legX = -1.45;
          armL = -0.3;
          armR = -0.9 + Math.sin(ph * 3) * 0.3 * k;
          headY = Math.sin(ph * 0.9) * 0.5 * k;
          break;
        case "sleep":
          legX = -1.45;
          armL = armR = -0.15;
          headX = 0.45;
          break;
        case "read":
          armL = armR = -1.0;
          armLz = -0.35;
          armRz = 0.35;
          headX = 0.25;
          break;
        case "operate":
          armL = -1.3 + Math.sin(ph * 6) * 0.1 * k;
          armR = -1.3 + Math.sin(ph * 6 + 2) * 0.1 * k;
          break;
        case "stand":
          armRz = 2.6 + Math.sin(ph * 8) * 0.3 * k;
          bob = Math.abs(Math.sin(ph * 4)) * 0.05 * k;
          headX = -0.15;
          break;
      }
      a.legL.rotation.x = legX + swing;
      a.legR.rotation.x = legX - swing;
      a.armL.rotation.set(armL, 0, armLz);
      a.armR.rotation.set(armR, 0, armRz);
      a.head.rotation.set(headX, headY, 0);
      a.book.visible = kind === "read";
      a.root.position.y = (legX ? 0.1 : 0) + bob;
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
        const reach = Math.max(...corners.map((c) => {
          const v = c.clone().project(camera);
          return Math.max(Math.abs(v.x), Math.abs(v.y));
        }));
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
        proj.set(a.root.position.x, a.root.position.y + 2.05, a.root.position.z);
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
        a.root.rotation.y = a.heading;
        // someone waiting for approval stands beside their chair, waving
        const standOff = !a.pos.walking && anim.pose === "stand" && anim.spot === "desk" ? 0.6 : 0;
        a.root.position.x = a.pos.x + standOff;
        a.root.position.z = a.pos.y + (a.pos.walking || SEATED.includes(anim.pose) ? 0 : 0.15);
        pose(a, a.pos.walking ? "walk" : anim.pose, t);
        const scr = screens.get(p.id);
        if (scr) {
          scr.emissive.set(GLOW[act][0]);
          scr.emissiveIntensity = GLOW[act][1];
        }
        const desk = layout.desks.find((d) => d.employeeId === p.id);
        renderTag(a, p, act, desk ? s.roomLabel(desk.room) : "");
      }
      for (const [id, a] of avatars) if (!people.has(id)) removeAvatar(id, a);
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
      controls.dispose();
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      dom.remove();
      overlay.remove();
    };
    // the scene is rebuilt when the layout changes; live state is read through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, reducedMotion]);

  useEffect(() => rerender.current(), [state.version]);

  return <div ref={wrap} className="relative w-full overflow-hidden rounded-lg border" />;
}
