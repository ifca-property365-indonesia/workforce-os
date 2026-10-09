"use client";

import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { animationFor, moveToward, spotPoint, stableHash, type Activity, type Pose, type Spot, type Point } from "@wfos/shared/office";
import { type OfficeViewProps } from "./office-2d";
import { CHARACTERS, loadOfficeAssets, type OfficeAssets } from "./office-assets";
import type { OfficePerson } from "./use-office";

// start fetching the models as soon as this chunk loads, while React mounts the view
if (typeof window !== "undefined") void loadOfficeAssets().catch(() => {});

// One floor tile of the shared layout is one world unit: layout x → world x, layout y → world z.
// Every model faces +z at rotation 0. Scales bring the packs to that unit:
const K = 2.5; // Kenney furniture kit
const KC = 2.0; // Kenney mini characters (≈1.4 tall)
const KK = 0.62; // KayKit furniture
const CITY = 4; // KayKit city: one road tile is 8 × 8
const TILE = 2 * CITY;
const SIT_Y = 0.4; // the sit clip is made for the floor; lift seated people onto the chair
const SEAT_IN = 0.3; // chairs stand closer to the desk than the layout's walking spot
const TAG_Y = 1.85;
const WALL_H = 1.15;
const WALL_T = 0.18;
const BASE_H = 0.4;
const ROOM_COLORS = ["#7c5cff", "#f0b429", "#1fae7a", "#2fb5d0", "#e25385", "#ef8a4a"];
// office wear only: the police officer and the character on crutches (which go through the desk) stay out
const PEOPLE = CHARACTERS.filter((n) => n !== "character-male-c" && n !== "character-female-a");
const C = {
  floor: "#e7dcc8",
  corridor: "#efe7d8",
  base: "#ece8e1",
  wall: "#f1eee8",
  glass: "#bcd3e3",
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
/** animation clip per pose; arms and head get small offsets on top (see pose()) */
const CLIP: Record<Pose | "walk", string> = {
  walk: "walk",
  type: "sit",
  sit: "sit",
  chat: "sit",
  sleep: "sit",
  read: "holding-both",
  operate: "interact-right",
  stand: "idle",
};

interface Avatar {
  root: THREE.Group;
  mixer: THREE.AnimationMixer;
  actions: Map<string, THREE.AnimationAction>;
  clip: string;
  armL: THREE.Object3D;
  armR: THREE.Object3D;
  head: THREE.Object3D;
  book: THREE.Mesh;
  pos: Point & { walking: boolean };
  heading: number;
  phase: number;
  tag: HTMLDivElement;
  tagKey: string;
  card: boolean;
}

const pick = <T,>(arr: readonly T[], h: number): T => arr[h % arr.length]!;

/** Low-poly 3D office (three.js, CC0 models from public/office). Same layout and behaviour as the 2D view; loaded only when chosen. */
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
  const { layout } = state;

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
    const dark = document.documentElement.classList.contains("dark");
    const sky = dark ? "#262338" : "#dfe9f2";
    const grass = dark ? "#2c3b33" : "#b7d39b";
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(sky);
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
    scene.background = new THREE.Color(sky);
    const center = new THREE.Vector3(layout.width / 2, 0, layout.height / 2);
    const span = Math.max(layout.width, layout.height);
    scene.fog = new THREE.Fog(sky, span * 2.2 + 40, span * 4 + 90);
    scene.add(new THREE.HemisphereLight("#fff8ee", dark ? "#3d3858" : "#8a9a84", 1.3));
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
    const put = (name: string, scale: number, x: number, z: number, rotY = 0, y = 0, parent: THREE.Object3D = scene) => {
      const m = assets.place(name, scale);
      m.position.set(x, y, z);
      m.rotation.y = rotY;
      parent.add(m);
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

    // ---------- the street around the office: lawn, a ring road, buildings behind and beside it ----------
    plane(1200, 1200, track(new THREE.MeshStandardMaterial({ color: grass, roughness: 1 })), center.x, -BASE_H, center.z);
    const baseSide = mat(C.base);
    const base = add(boxGeo(layout.width + 2, BASE_H, layout.height + 2), [baseSide, baseSide, mat(C.corridor), baseSide, baseSide, baseSide], center.x, -BASE_H / 2, center.z);
    base.castShadow = false;
    // the ring's inner edge keeps a 3-tile lawn around the building, in whole road tiles
    const nx = Math.ceil((layout.width + 8) / TILE);
    const nz = Math.ceil((layout.height + 8) / TILE);
    const x0 = center.x - (nx * TILE) / 2;
    const z0 = center.z - (nz * TILE) / 2;
    const x1 = x0 + nx * TILE;
    const z1 = z0 + nz * TILE;
    // street models stand outside the sun's shadow box, where a shadow would be cut off: they cast none
    const street = (name: string, x: number, z: number, rotY = 0, lift = 0) => {
      const m = put(name, CITY, x, z, rotY, -BASE_H + lift);
      m.traverse((o) => (o.castShadow = false));
      return m;
    };
    for (let i = 0; i < nx; i++) {
      const x = x0 + TILE / 2 + i * TILE;
      street(i === Math.floor(nx / 2) ? "road_straight_crossing" : "road_straight", x, z0 - TILE / 2, Math.PI / 2);
      street("road_straight", x, z1 + TILE / 2, Math.PI / 2);
    }
    for (let i = 0; i < nz; i++) {
      const z = z0 + TILE / 2 + i * TILE;
      street("road_straight", x0 - TILE / 2, z, 0);
      street("road_straight", x1 + TILE / 2, z, 0);
    }
    street("road_corner", x0 - TILE / 2, z0 - TILE / 2, 0);
    street("road_corner", x1 + TILE / 2, z0 - TILE / 2, -Math.PI / 2);
    street("road_corner", x1 + TILE / 2, z1 + TILE / 2, Math.PI);
    street("road_corner", x0 - TILE / 2, z1 + TILE / 2, Math.PI / 2);
    // buildings face the road: a tall row behind, lower ones at the sides; nothing in front, where the camera is
    const tall = ["building_C", "building_D", "building_G", "building_H", "building_E", "building_F"];
    const low = ["building_A", "building_B", "building_E", "building_F"];
    for (let i = -1; i <= nx; i++) street(pick(tall, i + 7), x0 + TILE / 2 + i * TILE, z0 - TILE * 1.5, 0);
    for (let i = 0; i < nz; i++) {
      const z = z0 + TILE / 2 + i * TILE;
      street(pick(low, i), x0 - TILE * 1.5, z, Math.PI / 2);
      street(pick(low, i + 2), x1 + TILE * 1.5, z, -Math.PI / 2);
    }
    // lawn: hedges and street lights along the ring, benches by the front door
    for (let x = x0 + 2; x < x1 - 1; x += 3.2) {
      street("bush", x, z0 + 1.2, 0);
      street("bush", x, z1 - 1.2, 0);
    }
    for (let i = 0; i <= nx; i++) {
      street("streetlight", x0 + i * TILE, z1 + 0.4, Math.PI);
      street("streetlight", x0 + i * TILE, z0 - 0.4, 0);
    }
    street("bench", center.x - 3, z1 - 2.6, Math.PI);
    street("bench", center.x + 3, z1 - 2.6, Math.PI);
    street("firehydrant", x1 - 1.5, z1 - 1, 0);
    // cars drive along the front and back roads (two lanes each, opposite ways), wrapping at the ends
    const carNames = ["car_sedan", "car_taxi", "car_hatchback", "car_stationwagon"];
    const roadFrom = x0 - TILE;
    const roadLen = x1 - x0 + 2 * TILE;
    const cars = [0, 1, 2, 3, 4, 5].map((i) => {
      const dir = i % 2 ? -1 : 1;
      const z = (i < 3 ? z1 + TILE / 2 : z0 - TILE / 2) + dir * 1.6;
      const car = street(pick(carNames, i), 0, z, dir * (Math.PI / 2), 0.3);
      return { car, dir, offset: (i * 0.37) % 1, speed: 2.2 + (i % 3) * 0.6 };
    });
    const moveCars = (t: number) => {
      for (const c of cars) {
        const u = (((c.offset + (reducedMotion ? 0 : ((t / 1000) * c.speed) / roadLen)) % 1) + 1) % 1;
        c.car.position.x = roadFrom + (c.dir > 0 ? u : 1 - u) * roadLen;
      }
    };

    // ---------- walls: the far wall has windows; side walls are solid; the near edge is a low curb with a doorway ----------
    const wallX = (wx0: number, wx1: number, z: number, windows: boolean) => {
      const len = wx1 - wx0;
      const cx = (wx0 + wx1) / 2;
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
    const curb = (cx0: number, cx1: number, z: number) => box(cx1 - cx0 + WALL_T, 0.22, WALL_T, C.wall, (cx0 + cx1) / 2, 0.11, z);

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

    // desks: monitors whose screens glow with what the person is doing, keyboard, mouse, office chair
    const screens = new Map<string, THREE.MeshStandardMaterial>();
    const top = height("desk", K);
    for (const d of layout.desks) {
      const cx = d.x + 1;
      const h = stableHash(d.employeeId);
      put("desk", K, cx, d.y + 0.5);
      const scr = track(new THREE.MeshStandardMaterial({ color: "#0d0d12", emissive: GLOW.idle[0], emissiveIntensity: GLOW.idle[1], roughness: 0.35 }));
      screens.set(d.employeeId, scr);
      for (const off of h % 3 === 0 ? [0] : [-0.34, 0.34]) {
        const mon = put("computerScreen", 1.6, cx + off, d.y + 0.28, -off * 0.5, top);
        // the light face of the Kenney screen ("metal") becomes this desk's glowing screen
        mon.traverse((o) => {
          if (o instanceof THREE.Mesh && (o.material as THREE.Material).name === "metal") o.material = scr;
        });
      }
      put("computerKeyboard", 2.2, cx, d.y + 0.72, 0, top);
      put("computerMouse", 2.2, cx + 0.48, d.y + 0.72, 0, top);
      if (h % 4 === 0) put(pick(["plantSmall1", "plantSmall2", "plantSmall3"], h >>> 3), K, cx - 0.72, d.y + 0.4, 0, top);
      put("chairDesk", K, d.seat.x, d.seat.y - SEAT_IN, Math.PI);
    }

    // ---------- characters ----------
    const pickables: THREE.Object3D[] = [];
    const hitGeo = boxGeo(0.9, 1.5, 0.9);
    const hitMat = track(new THREE.MeshBasicMaterial({ visible: false }));
    const bookGeo = boxGeo(0.3, 0.24, 0.06);
    const avatars = new Map<string, Avatar>();
    const ensureAvatar = (p: OfficePerson, at: Point): Avatar => {
      let a = avatars.get(p.id);
      if (a) return a;
      const h = stableHash(p.id);
      const root = assets.place(pick(PEOPLE, h), KC);
      scene.add(root);
      const hit = new THREE.Mesh(hitGeo, hitMat);
      hit.position.y = 0.75;
      hit.userData.id = p.id;
      root.add(hit);
      pickables.push(hit);
      const book = add(bookGeo, mat(pick(["#4f81bd", "#c0504d", "#9bbb59", "#8064a2"], h >>> 4)), 0, 0.62, 0.34, root);
      book.rotation.x = -0.5;
      book.visible = false;
      const mixer = new THREE.AnimationMixer(root);
      const actions = new Map(assets.clips.map((c) => [c.name, mixer.clipAction(c)]));
      const tag = document.createElement("div");
      tag.addEventListener("click", () => {
        const person = stateRef.current.people.current.get(p.id);
        if (person) selectRef.current(person);
      });
      overlay.appendChild(tag);
      a = {
        root,
        mixer,
        actions,
        clip: "",
        armL: root.getObjectByName("arm-left")!,
        armR: root.getObjectByName("arm-right")!,
        head: root.getObjectByName("head")!,
        book,
        pos: { ...at, walking: false },
        heading: Math.PI,
        phase: (h % 1000) / 160,
        tag,
        tagKey: "",
        card: false,
      };
      avatars.set(p.id, a);
      return a;
    };
    const removeAvatar = (id: string, a: Avatar) => {
      a.mixer.stopAllAction();
      a.mixer.uncacheRoot(a.root);
      scene.remove(a.root);
      a.root.traverse((o) => {
        if (o instanceof THREE.SkinnedMesh) o.skeleton.dispose();
      });
      a.tag.remove();
      for (let i = pickables.length - 1; i >= 0; i--) if (pickables[i]!.userData.id === id) pickables.splice(i, 1);
      avatars.delete(id);
    };

    /** play the pose's clip (cross-faded), then add the small arm and head movements the clips don't have */
    const pose = (a: Avatar, kind: Pose | "walk", t: number, dt: number) => {
      const clip = CLIP[kind];
      if (clip !== a.clip) {
        const next = a.actions.get(clip)!;
        const prev = a.clip ? a.actions.get(a.clip) : undefined;
        next.reset().play();
        if (prev && !reducedMotion) next.crossFadeFrom(prev, 0.25, false);
        else prev?.stop();
        a.clip = clip;
      }
      a.mixer.update(reducedMotion ? 0 : dt / 1000);
      const ph = t / 1000 + a.phase;
      const k = reducedMotion ? 0 : 1;
      switch (kind) {
        case "type":
          a.armL.rotation.x += -1.2 + Math.sin(ph * 22) * 0.08 * k;
          a.armR.rotation.x += -1.2 + Math.sin(ph * 22 + 1.7) * 0.08 * k;
          a.head.rotation.x += 0.1;
          break;
        case "sit":
          a.armL.rotation.x += -0.5;
          a.armR.rotation.x += -0.5;
          a.head.rotation.y += Math.sin(ph * 0.6) * 0.35 * k;
          break;
        case "chat":
          a.armR.rotation.x += -0.9 + Math.sin(ph * 3) * 0.3 * k;
          a.head.rotation.y += Math.sin(ph * 0.9) * 0.5 * k;
          break;
        case "sleep":
          a.head.rotation.x += 0.45;
          break;
        case "stand":
          // waiting for approval beside the chair: a raised, waving arm
          a.armR.rotation.x += -2.6 + Math.sin(ph * 8) * 0.3 * k;
          break;
      }
      a.book.visible = kind === "read";
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
        proj.set(a.root.position.x, a.root.position.y + TAG_Y, a.root.position.z);
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
        const seated = !a.pos.walking && SEATED.includes(anim.pose);
        // someone waiting for approval stands beside their chair, waving
        const standOff = !a.pos.walking && anim.pose === "stand" && anim.spot === "desk" ? 0.7 : 0;
        a.root.position.x = a.pos.x + standOff;
        a.root.position.z = a.pos.y + (seated ? (anim.spot === "desk" ? 0.1 - SEAT_IN : -0.05) : a.pos.walking ? 0 : 0.15);
        a.root.position.y = seated ? SIT_Y : 0;
        pose(a, a.pos.walking ? "walk" : anim.pose, t, dt);
        const scr = screens.get(p.id);
        if (scr) {
          scr.emissive.set(GLOW[act][0]);
          scr.emissiveIntensity = GLOW[act][1];
        }
        const desk = layout.desks.find((d) => d.employeeId === p.id);
        renderTag(a, p, act, desk ? s.roomLabel(desk.room) : "");
      }
      for (const [id, a] of avatars) if (!people.has(id)) removeAvatar(id, a);
      moveCars(t);
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
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      dom.remove();
      overlay.remove();
    };
    // the scene is rebuilt when the layout changes; live state is read through refs
  }, [layout, reducedMotion, assets]);

  useEffect(() => rerender.current(), [state.version]);

  return <div ref={wrap} aria-busy={!assets} className={`relative w-full overflow-hidden rounded-lg border ${assets ? "" : "h-[360px] animate-pulse bg-muted"}`} />;
}
