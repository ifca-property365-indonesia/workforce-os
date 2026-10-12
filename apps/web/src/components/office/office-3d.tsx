"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { animationFor, initials, moveToward, spotPoint, stableHash, type Activity, type Desk, type Pose, type Spot, type Point } from "@wfos/shared/office";
import { useEmployees } from "@/lib/hooks";
import { employeeLooks, signVars, type BotExpression, type SignColor } from "@/lib/sign";
import { createBotKit, poseBot, type Bot3D } from "./bot3d";
import { loadOfficeAssets, type OfficeAssets } from "./office-assets";
import type { OfficePerson, OfficeState } from "./use-office";

// start fetching the models as soon as this chunk loads, while React mounts the view
if (typeof window !== "undefined") void loadOfficeAssets().catch(() => {});

export interface OfficeViewProps {
  state: OfficeState;
  reducedMotion: boolean;
  onSelect: (p: OfficePerson) => void;
  labels: { lounge: string; reception: string; activity: (p: OfficePerson) => string };
}
export interface Office3DProps extends OfficeViewProps {
  onUnavailable: () => void;
  /** "page" (default): the framed block on the Office page. "wallpaper": fills its positioned parent as the desktop background */
  variant?: "page" | "wallpaper";
  /** wallpaper: stop the render loop while true (windows cover it); resume when false */
  paused?: boolean;
  /** fly the camera to this employee (bump n to repeat); id "home" resets the framing */
  focus?: { id: string; n: number } | null;
}

// One floor tile of the shared layout is one world unit: layout x → world x, layout y → world z.
// Every model faces +z at rotation 0. Scales bring the packs to that unit:
const K = 2.5; // Kenney furniture kit
const KK = 0.62; // KayKit furniture
const WALL_H = 1.15;
const WALL_T = 0.18;
const BASE_H = 0.4;
/** desktop chrome the wallpaper framing keeps clear of: menubar on top, dock at the bottom (px) */
const WALLPAPER_INSET = { top: 76, bottom: 104 };

/**
 * Clay: every model is redrawn in a handful of milk-white (day) or graphite (night) tones picked by how light its
 * original colour was, so the office reads as one quiet object and the employees' colours carry the information.
 * The palette follows the app theme (html.dark).
 */
interface Palette {
  ground: string;
  grid: string;
  floor: string;
  lobby: string;
  base: string;
  wall: string;
  glass: string;
  rug: string;
  ink: string;
  panel: string;
  rack: string;
  tones: [string, string, string, string, string];
  hemi: [string, string, number];
  sun: number;
  lamps: number;
  exposure: number;
  screen: number;
}
const PALETTES: Record<"day" | "night", Palette> = {
  day: {
    ground: "#dedae3",
    grid: "#d3ced9",
    floor: "#efedf2",
    lobby: "#f4f2f6",
    base: "#cbc5d1",
    wall: "#f8f7fa",
    glass: "#c6dcf2",
    rug: "#e3dfe8",
    ink: "#8a8094",
    panel: "#3a3442",
    rack: "#c2bcc9",
    tones: ["#fdfcfe", "#eeecf1", "#dcd8e1", "#c2bcc9", "#a49dac"],
    hemi: ["#ffffff", "#b9b0c4", 1.35],
    sun: 2.4,
    lamps: 0,
    exposure: 1,
    screen: 0.7,
  },
  night: {
    ground: "#1a1620",
    grid: "#2a2431",
    floor: "#4a4352",
    lobby: "#4e4756",
    base: "#2c2733",
    wall: "#5a5363",
    glass: "#3a4a6a",
    rug: "#544c5c",
    ink: "#857a8f",
    panel: "#2c2733",
    rack: "#3c3644",
    tones: ["#7a7284", "#6c6476", "#5e5768", "#504a5a", "#423c4b"],
    hemi: ["#b9acd9", "#3a3046", 1.7],
    sun: 0.9,
    lamps: 4.5,
    exposure: 1.3,
    screen: 1.6,
  },
};
const isNight = () => document.documentElement.classList.contains("dark");
const cssVar = (name: string, fallback: string) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

const SEATED: Pose[] = ["type", "sit", "chat", "sleep"];
/** which way a character faces once it has arrived at a spot (radians around y; 0 faces the camera side) */
const FACING: Record<Spot, number> = { desk: 0, bookshelf: Math.PI, rack: Math.PI, coffee: Math.PI, lounge: 0 };
/**
 * Desks are drawn turned around: the employee sits on the near side of the desk, facing the camera over their
 * monitor, so faces show while people work. The shared layout's desk cell (desk, chair, walkway) stays the same.
 */
const deskZ = (d: Desk) => d.y + 1.4;
const deskSeat = (d: Desk): Point => ({ x: d.seat.x, y: d.y + 0.45 });

interface Avatar {
  b: Bot3D & { dispose: () => void };
  lookKey: string;
  pos: Point & { walking: boolean };
  heading: number;
  phase: number;
  tag: HTMLDivElement;
  tagKey: string;
  card: boolean;
}
interface Look {
  shape: string;
  color: SignColor;
  expression?: BotExpression;
}

const pick = <T,>(arr: readonly T[], h: number): T => arr[h % arr.length]!;

/** 3D office (three.js; CC0 furniture from public/office in clay tones, employees as their bloub bots). */
export default function Office3D({ state, reducedMotion, labels, onSelect, onUnavailable, variant = "page", paused = false, focus = null }: Office3DProps) {
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
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const focusRef = useRef(focus);
  focusRef.current = focus;
  const rerender = useRef<() => void>(() => {});
  const restart = useRef<() => void>(() => {});
  const flyTo = useRef<(id: string) => void>(() => {});
  const { layout, workspaceName } = state;

  // bot shape, colour and expression are dealt over the whole workspace, exactly like the 2D avatars
  const { data: emps } = useEmployees();
  const looks = useMemo(() => employeeLooks(emps ?? []), [emps]);
  const looksRef = useRef(looks);
  looksRef.current = looks;

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
    const wallpaper = variant === "wallpaper";
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true });
    } catch {
      unavailableRef.current();
      return;
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.style.display = "block";
    const overlay = document.createElement("div");
    overlay.className = "pointer-events-none absolute inset-0 overflow-hidden";
    el.appendChild(overlay);

    const scene = new THREE.Scene();
    const center = new THREE.Vector3(layout.width / 2, 0, layout.height / 2);
    const span = Math.max(layout.width, layout.height);
    scene.fog = new THREE.Fog("#000", span * 1.6 + 20, span * 3 + 50); // the grid fades out around the building
    const hemi = new THREE.HemisphereLight("#fff", "#000", 1);
    scene.add(hemi);
    const sun = new THREE.DirectionalLight("#fff4e8", 2);
    sun.position.set(center.x - span * 0.45, span * 0.8 + 10, center.z + span * 0.35);
    sun.target.position.copy(center);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    const half = span / 2 + 4;
    Object.assign(sun.shadow.camera, { left: -half, right: half, top: half, bottom: -half, near: 1, far: span * 2.5 + 40 });
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.03;
    sun.shadow.radius = 4;
    scene.add(sun, sun.target);
    /** warm lights that only burn at night (a few per office, never one per desk) */
    const lamps: THREE.PointLight[] = [];
    const lamp = (x: number, y: number, z: number, power: number, range: number) => {
      const l = new THREE.PointLight("#ffd2a0", 0, range, 2);
      l.position.set(x, y, z);
      l.userData.power = power;
      scene.add(l);
      lamps.push(l);
    };

    // ---------- materials, geometry, helpers (everything created here is disposed on cleanup; models are shared) ----------
    const disposables: { dispose: () => void }[] = [];
    const track = <T extends { dispose: () => void }>(x: T) => (disposables.push(x), x);
    /** palette slots: one material each, recoloured in place when the theme changes */
    type Slot = Exclude<keyof Palette, "tones" | "hemi" | "sun" | "lamps" | "exposure" | "screen">;
    const slotMats = new Map<Slot, THREE.MeshStandardMaterial>();
    const slot = (k: Slot, extra?: THREE.MeshStandardMaterialParameters) => {
      let m = slotMats.get(k);
      if (!m) slotMats.set(k, (m = track(new THREE.MeshStandardMaterial({ roughness: 0.95, ...extra }))));
      return m;
    };
    const clay = PALETTES.day.tones.map(() => track(new THREE.MeshStandardMaterial({ roughness: 0.92, metalness: 0 })));
    /** clay tone for an original material: lighter colours stay lighter */
    const toneOf = (m: THREE.Material) => {
      const c = (m as THREE.MeshStandardMaterial).color ?? new THREE.Color(1, 1, 1);
      const l = 0.299 * c.r + 0.587 * c.g + 0.114 * c.b;
      return clay[l > 0.7 ? 0 : l > 0.5 ? 1 : l > 0.32 ? 2 : l > 0.16 ? 3 : 4]!;
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
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => add(boxGeo(w, h, d), m, x, y, z);
    const plane = (w: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const p = new THREE.Mesh(track(new THREE.PlaneGeometry(w, d)), m);
      p.rotation.x = -Math.PI / 2;
      p.position.set(x, y, z);
      p.receiveShadow = true;
      scene.add(p);
      return p;
    };
    /** a model from the packs in clay, footprint centred on (x, z); a monitor's light face ("metal") can become a screen */
    const put = (name: string, scale: number, x: number, z: number, rotY = 0, y = 0, screen?: THREE.Material) => {
      const m = assets.place(name, scale);
      m.traverse((o) => {
        if (!(o instanceof THREE.Mesh)) return;
        const orig = (Array.isArray(o.material) ? o.material[0] : o.material) as THREE.Material;
        o.material = screen && orig.name === "metal" ? screen : toneOf(orig);
      });
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      scene.add(m);
      return m;
    };
    const height = (name: string, scale: number) => assets.size(name).y * scale;
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
    const sign = (tex: THREE.Texture, w: number, h: number, x: number, y: number, z: number, rotX = 0, m?: THREE.MeshBasicMaterial) => {
      const mesh = new THREE.Mesh(track(new THREE.PlaneGeometry(w, h)), m ?? track(new THREE.MeshBasicMaterial({ map: tex, transparent: true, depthWrite: false })));
      mesh.rotation.x = rotX;
      mesh.position.set(x, y, z);
      scene.add(mesh);
      return mesh;
    };
    const display = cssVar("--font-shoulders", "") || "Arial Narrow";
    const company = workspaceName.trim();
    const mark = initials(company);

    // ---------- ground and building base ----------
    plane(600, 600, slot("ground", { roughness: 1 }), center.x, -BASE_H, center.z);
    const grid = track(new THREE.GridHelper(400, 100, "#fff", "#fff"));
    grid.position.set(center.x, -BASE_H + 0.005, center.z);
    scene.add(grid);
    const base = add(boxGeo(layout.width + 2, BASE_H, layout.height + 2), [slot("base"), slot("base"), slot("floor"), slot("base"), slot("base"), slot("base")], center.x, -BASE_H / 2, center.z);
    base.castShadow = false;
    const floorGrid = track(new THREE.GridHelper(Math.ceil(span + 2), Math.ceil(span + 2), "#fff", "#fff"));
    floorGrid.position.set(center.x, 0.002, center.z);
    (floorGrid.material as THREE.Material).transparent = true;
    (floorGrid.material as THREE.Material).opacity = 0.35;
    scene.add(floorGrid);

    // ---------- walls: the far wall has windows; side walls are solid; the near edge is a low curb with a doorway ----------
    const glassMat = slot("glass", { transparent: true, opacity: 0.35, roughness: 0.08, depthWrite: false });
    const wallX = (wx0: number, wx1: number, z: number, windows: boolean) => {
      const len = wx1 - wx0;
      const cx = (wx0 + wx1) / 2;
      if (len <= 0) return;
      if (!windows || len < 3) return void box(len + WALL_T, WALL_H, WALL_T, slot("wall"), cx, WALL_H / 2, z);
      box(len + WALL_T, 0.45, WALL_T, slot("wall"), cx, 0.225, z);
      box(len + WALL_T, 0.2, WALL_T, slot("wall"), cx, WALL_H - 0.1, z);
      const n = Math.max(1, Math.round(len / 2));
      for (let i = 0; i <= n; i++) box(i === 0 || i === n ? 0.4 : 0.2, WALL_H - 0.65, WALL_T, slot("wall"), wx0 + (i * len) / n, 0.45 + (WALL_H - 0.65) / 2, z);
      const glass = new THREE.Mesh(boxGeo(len, WALL_H - 0.65, 0.04), glassMat);
      glass.position.set(cx, 0.45 + (WALL_H - 0.65) / 2, z);
      scene.add(glass);
    };
    const wallZ = (wz0: number, wz1: number, x: number) => box(WALL_T, WALL_H, wz1 - wz0 + WALL_T, slot("wall"), x, WALL_H / 2, (wz0 + wz1) / 2);
    const curb = (cx0: number, cx1: number, z: number) => cx1 > cx0 && box(cx1 - cx0 + WALL_T, 0.22, WALL_T, slot("wall"), (cx0 + cx1) / 2, 0.11, z);

    // ---------- rooms ----------
    // floor labels are drawn white and tinted by one material, so the theme recolours them in place
    const inkMat = track(new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false }));
    const floorLabel = (text: string, x: number, z: number) => {
      const tex = canvasTexture(1024, 128, (ctx) => {
        ctx.fillStyle = "#ffffff";
        ctx.font = `800 88px ${display}, "Arial Narrow", system-ui, sans-serif`;
        ctx.textBaseline = "middle";
        ctx.fillText(text.toUpperCase(), 6, 68, 1010);
      });
      const geo = track(new THREE.PlaneGeometry(6.4, 0.8));
      geo.translate(3.2, -0.4, 0);
      const m = new THREE.Mesh(geo, track(Object.assign(inkMat.clone(), { map: tex })));
      m.userData.ink = true;
      m.rotation.x = -Math.PI / 2;
      m.position.set(x, 0.006, z);
      scene.add(m);
    };
    const ledMat = track(new THREE.MeshStandardMaterial({ color: "#14532d", emissive: "#22c55e", emissiveIntensity: 1 }));

    for (const r of [...layout.rooms, layout.lounge]) {
      plane(r.w, r.h, slot("floor"), r.x + r.w / 2, 0.004, r.y + r.h / 2);
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
      lamp(r.x + r.w / 2, 2.6, r.y + r.h / 2, Math.max(14, r.w * r.h * 0.35), Math.max(r.w, r.h) * 0.9);

      if (r.kind === "lounge") {
        const lg = layout.lounge;
        // a rug under the sofas, stretched to the seating area
        plane(r.w - 1.2, r.h - 2.6, slot("rug"), r.x + r.w / 2, 0.008, r.y + 2.3 + (r.h - 2.6) / 2);
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
      plane(r.w - 1.2, r.h - 3.7, slot("rug"), r.x + r.w / 2, 0.008, r.y + 2.6 + (r.h - 3.7) / 2);
      put("cabinet_medium_decorated", KK * 1.4, r.bookshelf.x, r.bookshelf.y - 0.25);
      box(0.9, 1.6, 0.8, slot("rack"), r.rack.x, 0.8, r.rack.y - 0.1);
      for (let i = 0; i < 4; i++) add(boxGeo(0.5, 0.05, 0.02), ledMat, r.rack.x - 0.1, 0.4 + i * 0.32, r.rack.y + 0.31);
    }

    // ---------- reception: company sign on the back wall, a counter with a receptionist, a waiting corner ----------
    const rc = layout.reception;
    const rcx = rc.x + rc.w / 2;
    plane(rc.w, rc.h, slot("lobby"), rcx, 0.004, rc.y + rc.h / 2);
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
    // the sign: a panel on the wall with the initials and the company name
    const signH = 1.55;
    box(signW, signH, 0.14, slot("panel"), rcx, signH / 2, rc.y + 0.15);
    if (company) {
      const signTex = canvasTexture(1024, 384, (ctx) => {
        ctx.fillStyle = "#f7f3ee";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.font = `900 200px ${display}, "Arial Narrow", system-ui, sans-serif`;
        ctx.fillText(mark, 512, 150, 980);
        ctx.font = `800 70px ${display}, "Arial Narrow", system-ui, sans-serif`;
        ctx.fillText(company.toUpperCase(), 512, 310, 980);
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
    // the floor mat at the entrance with the initials
    box(3, 0.02, 1.3, slot("rug"), rcx, 0.012, rc.y + rc.h - 0.9);
    if (mark) {
      const badge = canvasTexture(256, 128, (ctx) => {
        ctx.fillStyle = "#ffffff";
        ctx.font = `900 90px ${display}, "Arial Narrow", system-ui, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(mark, 128, 70, 240);
      });
      sign(badge, 2.4, 1.2, rcx, 0.025, rc.y + rc.h - 0.9, -Math.PI / 2, track(Object.assign(inkMat.clone(), { map: badge }))).userData.ink = true;
    }
    // waiting corners: a sofa and table on the left, armchairs and a lamp on the right
    const side = Math.min(2.4, rc.w * 0.18);
    put("rug_oval_A", KK, rc.x + side, rc.y + rc.h / 2 + 0.6, 0, 0.004);
    put("couch_pillows", KK, rc.x + 0.75, rc.y + rc.h / 2 + 0.6, Math.PI / 2);
    put("table_low", KK * 0.8, rc.x + side + 0.3, rc.y + rc.h / 2 + 0.6, Math.PI / 2);
    put("armchair_pillows", KK, rc.x + rc.w - 0.8, rc.y + rc.h / 2, -Math.PI / 2);
    put("armchair_pillows", KK, rc.x + rc.w - 0.8, rc.y + rc.h / 2 + 1.4, -Math.PI / 2);
    put("lamp_standing", KK, rc.x + rc.w - 0.6, rc.y + rc.h - 0.6);
    put("cactus_medium_A", KK, rc.x + 0.6, rc.y + rc.h - 0.6);
    lamp(rcx, 2.6, rc.y + rc.h / 2, 18, rc.w * 0.8);

    // ---------- desks (turned so people face the camera): monitors that glow with the work, keyboard, chair ----------
    const screens = new Map<string, THREE.MeshStandardMaterial>();
    const top = height("desk", K);
    const chairSeat = height("chairDesk", K) * 0.47 - 0.12;
    const sofaSeat = height("couch_pillows", KK) * 0.42;
    for (const d of layout.desks) {
      const cx = d.x + 1;
      const z = deskZ(d);
      const h = stableHash(d.employeeId);
      put("desk", K, cx, z, Math.PI);
      const scr = track(new THREE.MeshStandardMaterial({ color: "#0d0d12", emissive: "#000", emissiveIntensity: 0, roughness: 0.35 }));
      screens.set(d.employeeId, scr);
      for (const off of h % 3 === 0 ? [0] : [-0.32, 0.32]) put("computerScreen", 1.3, cx + off, z + 0.2, Math.PI + off * 0.5, top, scr);
      put("computerKeyboard", 2.2, cx, z - 0.22, Math.PI, top);
      put("computerMouse", 2.2, cx - 0.48, z - 0.22, Math.PI, top);
      put(pick(["plantSmall1", "plantSmall2", "plantSmall3"], h & 7), K * 0.85, cx + (h % 2 ? 0.78 : -0.78), z + 0.3, 0, top);
      const seat = deskSeat(d);
      put("chairDesk", K, seat.x, seat.y, 0);
    }

    // ---------- people: bloub bots ----------
    const kit = createBotKit();
    const pickables: THREE.Object3D[] = [];
    const hitGeo = boxGeo(1, 1.3, 1);
    const hitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
    // CSS colours are read once per palette change, never per frame (getComputedStyle forces a style recalc)
    const colorCache = new Map<string, string>();
    const colorOf = (name: string, fallback: string) => {
      let c = colorCache.get(name);
      if (c === undefined) colorCache.set(name, (c = cssVar(name, fallback)));
      return c;
    };
    const signHex = (c: SignColor) => colorOf(`--sign-${c}`, "#8c8194");
    const receptionist = kit.build("cercle", cssVar("--series-other", "#8c8194"));
    receptionist.root.position.set(rc.desk.x + 0.3, 0, rc.desk.y - 0.9);
    scene.add(receptionist.root);

    const lookOf = (id: string): Look => {
      const l = looksRef.current;
      return { shape: l.shapes.get(id) ?? "cercle", color: l.colors.get(id) ?? "biru", expression: l.expressions.get(id) };
    };
    const avatars = new Map<string, Avatar>();
    const removeAvatar = (id: string, a: Avatar) => {
      scene.remove(a.b.root);
      a.b.dispose();
      a.tag.remove();
      for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i]!.userData.id === id) pickables.splice(i, 1);
      avatars.delete(id);
    };
    const ensureAvatar = (p: OfficePerson, at: Point): Avatar => {
      const look = lookOf(p.id);
      const lookKey = `${look.shape}/${look.color}/${look.expression ?? ""}`;
      let a = avatars.get(p.id);
      if (a && a.lookKey === lookKey) return a;
      // a changed look rebuilds the bot where it stands
      const from = a ? { pos: a.pos, heading: a.heading } : { pos: { ...at, walking: false }, heading: 0 };
      if (a) removeAvatar(p.id, a);
      const b = kit.build(look.shape, signHex(look.color), look.expression);
      scene.add(b.root);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 0.65;
      hit.userData.id = p.id;
      b.root.add(hit);
      pickables.push(hit);
      const tag = document.createElement("div");
      tag.addEventListener("click", () => {
        const person = stateRef.current.people.current.get(p.id);
        if (person) selectRef.current(person);
      });
      overlay.appendChild(tag);
      a = { b, lookKey, ...from, phase: (stableHash(p.id) % 1000) / 160, tag, tagKey: "", card: false };
      avatars.set(p.id, a);
      return a;
    };

    // ---------- name signs and task cards above people (DOM; all text goes through textContent) ----------
    const node = (tag: string, className: string, text?: string) => {
      const n = document.createElement(tag);
      n.className = className;
      if (text !== undefined) n.textContent = text;
      return n;
    };
    /** the employee's name as a small acrylic sign: their colour while working, amber while waiting, dark when idle */
    const nameSign = (name: string, color: SignColor, act: Activity) => {
      const n = node("span", "sign font-display whitespace-nowrap rounded-[4px] px-1.5 pb-[3px] pt-[5px] text-[14px]", name);
      n.dataset.state = act === "idle" || act === "paused" ? "off" : "lit";
      if (act === "waiting") {
        n.style.setProperty("--sign", "var(--approval)");
        n.style.setProperty("--sign-ink", "var(--approval-ink)");
      } else for (const [k, v] of Object.entries(signVars(color))) n.style.setProperty(k, String(v));
      return n;
    };
    const renderTag = (a: Avatar, p: OfficePerson, act: Activity, bubble: string | null, room: string) => {
      const activityText = labelsRef.current.activity(p);
      const tool = p.lastStep?.kind === "tool" ? p.lastStep.name.replace(/^mcp__.+?__/, "") : "";
      const color = lookOf(p.id).color;
      const key = [act, p.name, p.task?.title ?? "", room, activityText, tool, color, bubble].join("|");
      if (key === a.tagKey) return;
      a.tagKey = key;
      a.card = !!p.task;
      a.tag.replaceChildren();
      a.tag.className = "pointer-events-auto absolute left-0 top-0 flex origin-bottom cursor-pointer flex-col items-center gap-1";
      if (p.task) {
        const card = node(
          "div",
          `max-w-64 min-w-40 rounded-lg bg-[#17121c]/95 px-2.5 pb-1.5 pt-1 text-[#f7efe6] shadow-lg ${act === "waiting" ? "ring-2 ring-[var(--approval)]" : "ring-1 ring-white/10"}`,
        );
        if (room) card.append(node("div", "truncate text-[10.5px] text-white/55", room));
        card.append(node("div", "line-clamp-2 text-[14px] font-bold leading-tight", p.task.title || activityText));
        const meta = node("div", "mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-0.5 text-[10.5px] text-white/60");
        const st = node("span", "inline-flex items-center gap-1 font-semibold");
        st.style.color = act === "waiting" ? "var(--approval)" : act === "paused" ? "var(--destructive)" : "#c9bfd0";
        if (act !== "waiting") st.append(node("span", `size-2.5 rounded-full border-[1.6px] border-current border-r-transparent ${reducedMotion ? "" : "animate-spin"}`));
        st.append(activityText);
        meta.append(st);
        if (tool) meta.append(node("span", "font-mono", tool));
        card.append(meta);
        a.tag.append(card);
      }
      const row = node("div", "flex items-center gap-1");
      if (bubble === "!") row.append(node("span", "grid size-6 place-items-center rounded-[6px_6px_6px_2px] bg-[var(--approval)] font-display text-[16px] text-[var(--approval-ink)] shadow-md", "!"));
      row.append(nameSign(p.name, color, act));
      if (bubble === "zz" || bubble === "…") row.append(node("span", "rounded-full bg-[#17121c]/80 px-1.5 text-[11px] font-semibold text-white/75", bubble));
      a.tag.append(row);
      a.tag.title = `${p.name} · ${activityText}${p.task?.title ? ` · ${p.task.title}` : ""}`;
    };

    // ---------- palette (follows the app theme) ----------
    const applyPalette = () => {
      colorCache.clear();
      const P = PALETTES[isNight() ? "night" : "day"];
      scene.background = new THREE.Color(P.ground);
      scene.fog!.color.set(P.ground);
      renderer.setClearColor(P.ground);
      for (const [k, m] of slotMats) m.color.set(P[k]);
      clay.forEach((m, i) => m.color.set(P.tones[i]!));
      for (const g of [grid, floorGrid]) (g.material as THREE.LineBasicMaterial).color.set(P.grid);
      hemi.color.set(P.hemi[0]);
      hemi.groundColor.set(P.hemi[1]);
      hemi.intensity = P.hemi[2];
      sun.intensity = P.sun;
      for (const l of lamps) l.intensity = P.lamps * (l.userData.power as number);
      renderer.toneMappingExposure = P.exposure;
      scene.traverse((o) => {
        if (o instanceof THREE.Mesh && o.userData.ink) (o.material as THREE.MeshBasicMaterial).color.set(P.ink);
      });
      screenBoost = P.screen;
      rerender.current();
    };
    let screenBoost = 1;
    applyPalette();
    const themeWatch = new MutationObserver(applyPalette);
    themeWatch.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });

    // ---------- camera ----------
    const camera = new THREE.PerspectiveCamera(32, 1, 0.1, 800);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = !reducedMotion;
    controls.enableZoom = false; // our own wheel zoom (towards the cursor) below
    controls.screenSpacePanning = false;
    controls.maxPolarAngle = 1.2;
    renderer.domElement.style.touchAction = wallpaper ? "none" : "pan-y";
    // the wallpaper looks from lower down, so the building spreads across the screen and people read as characters
    const viewDir = (wallpaper ? new THREE.Vector3(-0.3, 0.56, 0.77) : new THREE.Vector3(-0.3, 0.8, 0.6)).normalize();
    const fill = wallpaper ? 0.97 : 0.94;
    let maxDist = 200;
    let homeDist = span * 1.5;
    const edge = wallpaper ? 0.2 : 1;
    const corners = [-edge, layout.width + edge].flatMap((x) => [-edge, layout.height + edge].flatMap((z) => [wallpaper ? -BASE_H : 0, WALL_H].map((y) => new THREE.Vector3(x, y, z))));
    /** frame the whole office: move back until every corner of the building is on screen (clear of the desktop chrome) */
    const home = () => {
      camera.clearViewOffset();
      const H = renderer.domElement.clientHeight || 1;
      const W = renderer.domElement.clientWidth || 1;
      const inset = wallpaper ? WALLPAPER_INSET : { top: 0, bottom: 0 };
      const usable = 2 - (2 * (inset.top + inset.bottom)) / H;
      let dist = span * 1.5;
      let mid = 0;
      for (let i = 0; i < 12; i++) {
        camera.position.copy(center).addScaledVector(viewDir, dist);
        camera.lookAt(center);
        camera.updateMatrixWorld();
        let reachX = 0;
        let lo = Infinity;
        let hi = -Infinity;
        for (const c of corners) {
          const v = c.clone().project(camera);
          reachX = Math.max(reachX, Math.abs(v.x));
          lo = Math.min(lo, v.y);
          hi = Math.max(hi, v.y);
        }
        mid = (lo + hi) / 2;
        dist *= Math.max(reachX, (hi - lo) / usable) / fill;
      }
      homeDist = dist;
      maxDist = dist * 2;
      controls.target.copy(center);
      camera.position.copy(center).addScaledVector(viewDir, dist);
      controls.update();
      // centre the office in the band between the menubar and the dock
      const want = ((2 * inset.bottom) / H - (2 * inset.top) / H) / 2;
      const shift = ((mid - want) * H) / 2;
      if (Math.abs(shift) > 0.5) camera.setViewOffset(W, H, 0, -shift, W, H);
    };
    let userMoved = false;
    controls.addEventListener("start", () => {
      userMoved = true;
      fly = null;
      controls.autoRotate = false;
    });
    controls.addEventListener("change", () => rerender.current());
    const fit = () => {
      const w = el.clientWidth;
      const h = wallpaper ? Math.max(1, el.clientHeight) : Math.max(360, Math.min(760, Math.round(w * 0.62)));
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
    // the wallpaper drifts slowly left and right until someone takes the camera
    controls.autoRotate = wallpaper && !reducedMotion;

    /** a camera flight: towards a person (closer) or back home */
    let fly: { target: THREE.Vector3; dist: number; follow?: string } | null = null;
    let pendingFocus: string | null = focusRef.current && focusRef.current.id !== "home" ? focusRef.current.id : null;
    flyTo.current = (id: string) => {
      pendingFocus = null;
      if (id === "home") {
        userMoved = false;
        fly = { target: center.clone(), dist: homeDist };
        controls.autoRotate = wallpaper && !reducedMotion;
        return;
      }
      const a = avatars.get(id);
      if (!a) {
        pendingFocus = id;
        return;
      }
      fly = { target: a.b.root.position.clone(), dist: Math.min(14, homeDist), follow: id };
      controls.autoRotate = false;
      userMoved = true;
      rerender.current();
    };
    const flyStep = (dt: number) => {
      if (pendingFocus && avatars.has(pendingFocus)) flyTo.current(pendingFocus);
      if (!fly) return;
      if (fly.follow) {
        const a = avatars.get(fly.follow);
        if (a) fly.target.copy(a.b.root.position);
      }
      const k = reducedMotion ? 1 : Math.min(1, dt / 220);
      const dir = camera.position.clone().sub(controls.target);
      const d = dir.length();
      controls.target.lerp(fly.target, k);
      camera.position.copy(controls.target).addScaledVector(dir.normalize(), d + (fly.dist - d) * k);
      if (controls.target.distanceTo(fly.target) < 0.02 && Math.abs(d - fly.dist) < 0.05) fly = null;
    };

    const proj = new THREE.Vector3();
    const placeTags = () => {
      const w = el.clientWidth;
      const h = renderer.domElement.clientHeight;
      for (const a of avatars.values()) {
        const r = a.b.root;
        proj.set(r.position.x, r.position.y + a.b.height + 0.25, r.position.z);
        const dist = camera.position.distanceTo(proj);
        proj.project(camera);
        if (proj.z > 1 || Math.abs(proj.x) > 1.2 || proj.y < -1.2 || proj.y > 1.3) {
          a.tag.style.display = "none";
          continue;
        }
        a.tag.style.display = "";
        const compact = a.card && dist > 24;
        if (a.card) (a.tag.firstElementChild as HTMLElement).style.display = compact ? "none" : "";
        a.tag.style.zIndex = String(10000 - Math.round(dist * 10));
        a.tag.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -100%) scale(${THREE.MathUtils.clamp(18 / dist, 0.6, 1)})`;
      }
    };

    // ---------- per-frame update ----------
    const glow = (act: Activity, color: SignColor): [string, number] => {
      if (act === "waiting") return [colorOf("--approval", "#f6b51e"), 1];
      if (act === "paused") return ["#7f1d1d", 0.4];
      if (act === "idle") return ["#000000", 0];
      return [signHex(color), act === "thinking" ? 0.6 : 1];
    };
    const update = (dt: number, t: number) => {
      const s = stateRef.current;
      const people = s.people.current;
      const now = Date.now();
      for (const p of people.values()) {
        const act = s.activityOf(p, now);
        const anim = animationFor(act, p.id, now);
        const desk = layout.desks.find((d) => d.employeeId === p.id);
        const target = anim.spot === "desk" && desk ? deskSeat(desk) : spotPoint(layout, p.id, anim.spot);
        const a = ensureAvatar(p, target);
        const m = reducedMotion ? { pos: target, arrived: true } : moveToward(a.pos, target, dt);
        const dx = m.pos.x - a.pos.x;
        const dz = m.pos.y - a.pos.y;
        a.pos = { ...m.pos, walking: !m.arrived };
        const goal = a.pos.walking && Math.hypot(dx, dz) > 1e-4 ? Math.atan2(dx, dz) : FACING[anim.spot];
        a.heading += Math.atan2(Math.sin(goal - a.heading), Math.cos(goal - a.heading)) * (reducedMotion ? 1 : Math.min(1, dt / 100));
        const root = a.b.root;
        root.rotation.y = a.heading;
        const seated = !a.pos.walking && SEATED.includes(anim.pose);
        // someone waiting for approval stands beside their chair, past the desk's end and a step back from it,
        // so the desk doesn't hide them from the camera
        const waitingAtDesk = !a.pos.walking && anim.pose === "stand" && anim.spot === "desk";
        root.position.x = a.pos.x + (waitingAtDesk ? 1.1 : 0);
        root.position.z = a.pos.y + (a.pos.walking || seated ? (seated && anim.spot === "lounge" ? -0.05 : 0) : waitingAtDesk ? -0.1 : anim.spot === "desk" ? 0.1 : 0.15);
        const lift = seated ? (anim.spot === "desk" ? chairSeat : sofaSeat) : 0;
        root.position.y += (lift - root.position.y) * (reducedMotion ? 1 : Math.min(1, dt / 90));
        poseBot(a.b, a.pos.walking ? "walk" : anim.pose === "stand" && anim.spot === "coffee" ? "idle" : anim.pose, seated, t, a.phase, reducedMotion);
        const scr = screens.get(p.id);
        if (scr) {
          const [c, i] = glow(act, lookOf(p.id).color);
          scr.emissive.set(c);
          scr.emissiveIntensity = i * screenBoost;
        }
        renderTag(a, p, act, anim.bubble, desk ? s.roomLabel(desk.room) : "");
      }
      for (const [id, a] of avatars) if (!people.has(id)) removeAvatar(id, a);
      poseBot(receptionist, "idle", false, t, 0, reducedMotion);
      ledMat.emissiveIntensity = reducedMotion ? 1 : 0.6 + Math.abs(Math.sin(t / 400)) * 0.8;
      if (controls.autoRotate) controls.autoRotateSpeed = 0.35 * Math.cos(t / 24000);
      flyStep(dt);
      controls.update(dt / 1000);
      renderer.render(scene, camera);
      placeTags();
    };

    // loop: rAF while visible and not covered, paused otherwise; reduced motion renders on change and every few seconds
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
      if (document.hidden || pausedRef.current) return;
      if (reducedMotion) {
        update(0, performance.now());
        timer = setInterval(() => update(0, performance.now()), 5000);
      } else {
        last = performance.now();
        raf = requestAnimationFrame(frame);
      }
    };
    restart.current = start;
    let pending = 0;
    rerender.current = () => {
      if (!reducedMotion || document.hidden || pausedRef.current || pending) return;
      pending = requestAnimationFrame(() => {
        pending = 0;
        update(0, performance.now());
      });
    };
    start();
    document.addEventListener("visibilitychange", start);

    // ---------- input: click a person to open them, wheel zoom (page: once engaged), double-click to reset the view ----------
    const ray = new THREE.Raycaster();
    const pickAt = (e: MouseEvent): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      return (ray.intersectObjects(pickables, false)[0]?.object.userData.id as string | undefined) ?? null;
    };
    let engaged = wallpaper;
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
      if (!wallpaper) engaged = false;
    };
    const floor = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
    const onWheel = (e: WheelEvent) => {
      if (!engaged) return;
      e.preventDefault();
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const at = ray.ray.intersectPlane(floor, new THREE.Vector3()) ?? controls.target.clone();
      const dist = camera.position.distanceTo(controls.target);
      const k = THREE.MathUtils.clamp(dist * Math.exp(e.deltaY * 0.0015), 8, maxDist) / dist;
      camera.position.sub(at).multiplyScalar(k).add(at);
      controls.target.sub(at).multiplyScalar(k).add(at);
      userMoved = true;
      fly = null;
      controls.autoRotate = false;
      controls.update();
    };
    const onDblClick = () => flyTo.current("home");
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
      themeWatch.disconnect();
      document.removeEventListener("visibilitychange", start);
      dom.removeEventListener("pointerdown", onDown);
      dom.removeEventListener("pointerup", onUp);
      dom.removeEventListener("pointermove", onMove);
      dom.removeEventListener("pointerleave", onLeave);
      dom.removeEventListener("wheel", onWheel);
      dom.removeEventListener("dblclick", onDblClick);
      for (const [id, a] of avatars) removeAvatar(id, a);
      receptionist.dispose();
      controls.dispose();
      kit.dispose();
      disposables.forEach((d) => d.dispose());
      cancelAnimationFrame(pending);
      rerender.current = () => {};
      sun.shadow.dispose();
      renderer.dispose();
      renderer.forceContextLoss();
      dom.remove();
      overlay.remove();
      restart.current = () => {};
      flyTo.current = () => {};
    };
    // the scene is rebuilt when the layout or the company name changes; live state is read through refs
  }, [layout, workspaceName, reducedMotion, assets, variant]);

  useEffect(() => rerender.current(), [state.version, looks]);
  useEffect(() => restart.current(), [paused]);
  useEffect(() => {
    if (focus) flyTo.current(focus.id);
  }, [focus]);

  if (variant === "wallpaper") return <div ref={wrap} aria-busy={!assets} className="absolute inset-0 overflow-hidden" />;
  return <div ref={wrap} aria-busy={!assets} className={`relative w-full overflow-hidden rounded-lg border ${assets ? "" : "h-[360px] animate-pulse bg-muted"}`} />;
}
