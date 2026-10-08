"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { animationFor, moveToward, spotPoint, stableHash, type Animation, type Bubble, type Point } from "@wfos/shared/office";
import { BODY_COLORS, type OfficeViewProps } from "./office-2d";

interface Avatar {
  group: THREE.Group;
  body: THREE.Mesh;
  bubble: THREE.Sprite;
  bubbleKind: Bubble;
  pos: Point & { walking: boolean };
}

function bubbleTexture(text: string, bg: string, fg: string): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = bg;
  ctx.beginPath();
  ctx.roundRect(4, 8, 56, 48, 16);
  ctx.fill();
  ctx.fillStyle = fg;
  ctx.font = "bold 34px system-ui, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, 32, 33);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/** Low-poly 3D office (three.js). Same layout and behaviour as the 2D view; loaded only when chosen. */
export default function Office3D({ state, reducedMotion, onSelect, onUnavailable }: OfficeViewProps & { onUnavailable: () => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const stateRef = useRef(state);
  stateRef.current = state;
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
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.setClearColor(dark ? 0x0f1117 : 0xeef1f6);
    el.appendChild(renderer.domElement);
    renderer.domElement.setAttribute("aria-hidden", "true");
    renderer.domElement.style.display = "block";

    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight(0xffffff, dark ? 0x222233 : 0x99a0b0, 1.6));
    const sun = new THREE.DirectionalLight(0xffffff, 1.2);
    sun.position.set(layout.width * 0.3, 30, layout.height * 0.2);
    scene.add(sun);

    const disposables: { dispose: () => void }[] = [];
    const mat = (color: number | string) => {
      const m = new THREE.MeshLambertMaterial({ color });
      disposables.push(m);
      return m;
    };
    const geo = <G extends THREE.BufferGeometry>(g: G) => (disposables.push(g), g);
    const box = (w: number, h: number, d: number, m: THREE.Material, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(geo(new THREE.BoxGeometry(w, h, d)), m);
      mesh.position.set(x, y, z);
      scene.add(mesh);
      return mesh;
    };
    const M = {
      floor: mat(dark ? 0x1b1f2a : 0xffffff),
      ground: mat(dark ? 0x12151d : 0xdde2ea),
      wall: mat(dark ? 0x394050 : 0xc9d0dc),
      desk: mat(dark ? 0x5b4636 : 0xc8a27a),
      monitor: mat(0x334155),
      screen: mat(0x38bdf8),
      shelf: mat(dark ? 0x6b4f3a : 0x9a6b4b),
      rack: mat(0x1f2937),
      led: mat(0x22c55e),
      sofa: mat(dark ? 0x3b4a6b : 0xa5b4fc),
      chair: mat(dark ? 0x2d3444 : 0x94a3b8),
      skin: mat(0xfde2c4),
    };
    box(layout.width + 2, 0.1, layout.height + 2, M.ground, layout.width / 2, -0.06, layout.height / 2);
    for (const r of [...layout.rooms, layout.lounge]) {
      box(r.w, 0.06, r.h, M.floor, r.x + r.w / 2, 0, r.y + r.h / 2);
      // low walls on the far and side edges, so the room stays visible
      box(r.w, 0.5, 0.1, M.wall, r.x + r.w / 2, 0.25, r.y);
      box(0.1, 0.5, r.h, M.wall, r.x, 0.25, r.y + r.h / 2);
      box(0.1, 0.5, r.h, M.wall, r.x + r.w, 0.25, r.y + r.h / 2);
      if (r.kind === "lounge") continue;
      box(2, 1.4, 0.4, M.shelf, r.bookshelf.x, 0.7, r.bookshelf.y - 0.2);
      box(0.9, 1.7, 0.8, M.rack, r.rack.x, 0.85, r.rack.y - 0.1);
      box(0.1, 0.06, 0.02, M.led, r.rack.x - 0.25, 1.3, r.rack.y + 0.31);
    }
    for (const d of layout.desks) {
      box(2, 0.08, 0.9, M.desk, d.x + 1, 0.72, d.y + 0.45);
      box(0.08, 0.7, 0.8, M.desk, d.x + 0.06, 0.36, d.y + 0.45);
      box(0.08, 0.7, 0.8, M.desk, d.x + 1.94, 0.36, d.y + 0.45);
      box(0.8, 0.5, 0.06, M.monitor, d.x + 1, 1.05, d.y + 0.2);
      box(0.7, 0.4, 0.02, M.screen, d.x + 1, 1.05, d.y + 0.24);
      box(0.5, 0.45, 0.5, M.chair, d.seat.x, 0.22, d.seat.y);
    }
    for (const s of layout.lounge.seats) box(1.4, 0.45, 0.7, M.sofa, s.x, 0.22, s.y + 0.15);
    box(0.8, 1.1, 0.6, M.rack, layout.lounge.coffee.x, 0.55, layout.lounge.coffee.y);

    const textures: Record<string, THREE.CanvasTexture> = {
      "!": bubbleTexture("!", "#f59e0b", "#ffffff"),
      "…": bubbleTexture("…", "#ffffff", "#475569"),
      zz: bubbleTexture("zz", "#ffffff", "#475569"),
    };
    Object.values(textures).forEach((t) => disposables.push(t));
    const bodyGeo = geo(new THREE.CapsuleGeometry(0.22, 0.45, 4, 8));
    const headGeo = geo(new THREE.SphereGeometry(0.2, 12, 10));
    const bodyMats = new Map<string, THREE.Material>();
    const avatars = new Map<string, Avatar>();
    const ensureAvatar = (id: string, at: Point): Avatar => {
      let a = avatars.get(id);
      if (a) return a;
      const color = BODY_COLORS[stableHash(id) % BODY_COLORS.length]!;
      const bm = bodyMats.get(color) ?? bodyMats.set(color, mat(color)).get(color)!;
      const group = new THREE.Group();
      const body = new THREE.Mesh(bodyGeo, bm);
      body.position.y = 0.45;
      const head = new THREE.Mesh(headGeo, M.skin);
      head.position.y = 1.0;
      const sm = new THREE.SpriteMaterial({ map: textures["…"], depthTest: false });
      disposables.push(sm);
      const bubble = new THREE.Sprite(sm);
      bubble.scale.set(0.6, 0.6, 1);
      bubble.position.y = 1.55;
      bubble.visible = false;
      group.add(body, head, bubble);
      group.scale.setScalar(1.4);
      group.userData.id = id;
      body.userData.id = id;
      head.userData.id = id;
      scene.add(group);
      a = { group, body, bubble, bubbleKind: null, pos: { ...at, walking: false } };
      avatars.set(id, a);
      return a;
    };

    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 500);
    const center = new THREE.Vector3(layout.width / 2, 0, layout.height / 2);
    const fit = () => {
      const w = el.clientWidth;
      const h = Math.max(320, Math.min(720, Math.round(w * 0.62)));
      renderer.setSize(w, h);
      camera.aspect = w / h;
      const span = Math.max(layout.width / camera.aspect, layout.height) * 1.05 + 4;
      const dist = span / (2 * Math.tan((camera.fov * Math.PI) / 360));
      camera.position.set(center.x, dist * 0.78, center.z + dist * 0.62);
      camera.lookAt(center);
      camera.updateProjectionMatrix();
    };
    fit();
    const ro = new ResizeObserver(() => {
      fit();
      rerender.current();
    });
    ro.observe(el);

    const update = (dt: number, t: number) => {
      const s = stateRef.current;
      const people = s.people.current;
      const now = Date.now();
      for (const p of people.values()) {
        const anim: Animation = animationFor(s.activityOf(p, now), p.id, now);
        const target = spotPoint(layout, p.id, anim.spot);
        const a = ensureAvatar(p.id, target);
        const m = reducedMotion ? { pos: target, arrived: true } : moveToward(a.pos, target, dt);
        a.pos = { ...m.pos, walking: !m.arrived };
        const sitting = !a.pos.walking && (anim.pose === "sit" || anim.pose === "type" || anim.pose === "sleep");
        const phase = (stableHash(p.id) % 1000) / 160;
        const bob = reducedMotion ? 0 : a.pos.walking ? Math.abs(Math.sin(t / 110 + phase)) * 0.12 : anim.pose === "type" ? Math.sin(t / 70 + phase) * 0.03 : 0;
        a.group.position.set(a.pos.x, (sitting ? 0.15 : 0) + bob, a.pos.y);
        a.group.rotation.z = anim.pose === "sleep" ? 0.25 : 0;
        if (a.bubbleKind !== anim.bubble) {
          a.bubbleKind = anim.bubble;
          a.bubble.visible = !!anim.bubble;
          if (anim.bubble) (a.bubble.material as THREE.SpriteMaterial).map = textures[anim.bubble]!;
        }
      }
      for (const [id, a] of avatars) {
        if (!people.has(id)) {
          scene.remove(a.group);
          avatars.delete(id);
        }
      }
      renderer.render(scene, camera);
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
    rerender.current = () => {
      if (reducedMotion && !document.hidden) update(0, performance.now());
    };
    start();
    document.addEventListener("visibilitychange", start);

    const ray = new THREE.Raycaster();
    const pick = (e: MouseEvent): string | null => {
      const r = renderer.domElement.getBoundingClientRect();
      ray.setFromCamera(new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.intersectObjects([...avatars.values()].map((a) => a.group), true).find((h) => h.object.userData.id);
      return (hit?.object.userData.id as string | undefined) ?? null;
    };
    const onClick = (e: MouseEvent) => {
      const id = pick(e);
      const p = id ? stateRef.current.people.current.get(id) : undefined;
      if (p) selectRef.current(p);
    };
    const onMove = (e: MouseEvent) => {
      renderer.domElement.style.cursor = pick(e) ? "pointer" : "default";
    };
    renderer.domElement.addEventListener("click", onClick);
    renderer.domElement.addEventListener("pointermove", onMove);

    return () => {
      stop();
      ro.disconnect();
      document.removeEventListener("visibilitychange", start);
      renderer.domElement.removeEventListener("click", onClick);
      renderer.domElement.removeEventListener("pointermove", onMove);
      disposables.forEach((d) => d.dispose());
      renderer.dispose();
      renderer.domElement.remove();
    };
    // the scene is rebuilt when the layout changes; live state is read through refs
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [layout, reducedMotion]);

  useEffect(() => rerender.current(), [state.version]);

  return <div ref={wrap} className="w-full overflow-hidden rounded-lg border" />;
}
