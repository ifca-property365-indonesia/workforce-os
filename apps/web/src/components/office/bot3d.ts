import * as THREE from "three";
import type { Pose } from "@wfos/shared/office";
import { SHAPE_BY_ID } from "@/lib/bloub/skins";
import type { BotExpression } from "@/lib/sign";

/**
 * Employees in the 3D office: their bloub bot (components/ui/bot-avatar.tsx) made solid. The body is a sphere pushed
 * out to the bot's radial profile r(θ) in the front plane and flattened front to back, in the employee's sign colour;
 * two dark eyes with a glint, two small feet. The front faces +z, like every model in the office.
 */

/** body radius (the bloub "ball" radius), world units */
export const BOT_R = 0.42;
const DEPTH = 0.74;
const FOOT_H = 0.12;

export interface Bot3D {
  root: THREE.Group;
  /** the part that bobs, leans and breathes (the feet stay on the floor) */
  body: THREE.Group;
  eyes: THREE.Mesh[];
  feet: THREE.Mesh[];
  /** standing height, floor to top of the body */
  height: number;
  /** resting eye scale for the bot's expression */
  eye: { sx: number; sy: number };
}

/** eye shape per rest expression: width, height (1 = neutral) */
const EYES: Partial<Record<BotExpression, [number, number]>> = {
  attentif: [1.05, 1.1],
  surpris: [1.25, 1.25],
  effraye: [1.2, 1.3],
  excite: [1.1, 1.2],
  heureux: [1.05, 0.7],
  hilare: [1.1, 0.55],
  fier: [1, 0.65],
  colere: [1.05, 0.6],
  mefiant: [1, 0.5],
  blase: [1, 0.45],
  somnolent: [1, 0.35],
  triste: [0.85, 0.85],
  timide: [0.85, 0.9],
  curieux: [1.1, 1.05],
  confus: [0.95, 0.95],
};

const TAU = Math.PI * 2;

/** Shared geometry and materials; one kit per scene, disposed with it. */
export function createBotKit() {
  const bodies = new Map<string, { geo: THREE.BufferGeometry; minY: number; maxY: number }>();
  const eyeGeo = new THREE.SphereGeometry(1, 16, 12);
  const glintGeo = new THREE.SphereGeometry(BOT_R * 0.035, 8, 6);
  const footGeo = new THREE.SphereGeometry(1, 14, 10);
  const eyeMat = new THREE.MeshStandardMaterial({ color: "#17121c", roughness: 0.3 });
  const glintMat = new THREE.MeshBasicMaterial({ color: "#ffffff" });
  const owned: { dispose: () => void }[] = [eyeGeo, glintGeo, footGeo, eyeMat, glintMat];

  const bodyOf = (shape: string) => {
    let b = bodies.get(shape);
    if (b) return b;
    const radii = SHAPE_BY_ID.get(shape as never)?.radii ?? SHAPE_BY_ID.get("cercle")!.radii;
    const n = radii.length;
    // profile: θ = 0 points right and grows clockwise with y down (bloub's screen convention)
    const rAt = (th: number) => {
      const t = (((th / TAU) * n) % n + n) % n;
      const a = Math.floor(t);
      const f = t - a;
      return radii[a]! * (1 - f) + radii[(a + 1) % n]! * f;
    };
    const geo = new THREE.SphereGeometry(1, 64, 40);
    const pos = geo.attributes.position!;
    let minY = 0;
    let maxY = 0;
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i);
      const y = pos.getY(i);
      const z = pos.getZ(i);
      const r = rAt(Math.atan2(-y, x));
      pos.setXYZ(i, x * r * BOT_R, y * r * BOT_R, z * BOT_R * DEPTH);
      minY = Math.min(minY, y * r * BOT_R);
      maxY = Math.max(maxY, y * r * BOT_R);
    }
    geo.computeVertexNormals();
    owned.push(geo);
    bodies.set(shape, (b = { geo, minY, maxY }));
    return b;
  };

  const build = (shape: string, color: string, expression?: BotExpression): Bot3D & { dispose: () => void } => {
    const { geo, minY, maxY } = bodyOf(shape);
    const col = new THREE.Color(color);
    const bodyMat = new THREE.MeshStandardMaterial({ color: col, roughness: 0.42 });
    const footMat = new THREE.MeshStandardMaterial({ color: col.clone().multiplyScalar(0.62), roughness: 0.6 });
    const root = new THREE.Group();
    const body = new THREE.Group();
    const mesh = new THREE.Mesh(geo, bodyMat);
    mesh.castShadow = mesh.receiveShadow = true;
    mesh.position.y = -minY + FOOT_H;
    body.add(mesh);
    const [ex, ey] = EYES[expression ?? "neutre"] ?? [1, 1];
    const eye = { sx: BOT_R * 0.11 * ex, sy: BOT_R * 0.17 * ey };
    // eyes a little above the middle, so they still show when the office is seen from above
    const lift = 0.24;
    const cy = -minY + FOOT_H + (maxY + minY) / 2 + BOT_R * lift;
    const front = BOT_R * DEPTH * Math.sqrt(1 - 0.27 ** 2 - lift ** 2) + BOT_R * 0.015;
    const eyes = [-1, 1].map((sx) => {
      const e = new THREE.Mesh(eyeGeo, eyeMat);
      e.scale.set(eye.sx, eye.sy, BOT_R * 0.06);
      e.position.set(sx * BOT_R * 0.27, cy, front);
      // the glint rides on the eye (in its unit-sphere space); undo the eye's squash so it stays round
      const g = new THREE.Mesh(glintGeo, glintMat);
      g.scale.set(1 / e.scale.x, 1 / e.scale.y, 1 / e.scale.z);
      g.position.set(0.35, 0.45, 1.05);
      e.add(g);
      body.add(e);
      return e;
    });
    const feet = [-1, 1].map((sx) => {
      const f = new THREE.Mesh(footGeo, footMat);
      f.scale.set(BOT_R * 0.2, FOOT_H * 0.9, BOT_R * 0.26);
      f.position.set(sx * BOT_R * 0.3, FOOT_H * 0.8, BOT_R * 0.05);
      f.castShadow = true;
      root.add(f);
      return f;
    });
    root.add(body);
    return {
      root,
      body,
      eyes,
      feet,
      height: maxY - minY + FOOT_H,
      eye,
      dispose: () => {
        bodyMat.dispose();
        footMat.dispose();
      },
    };
  };

  return {
    build,
    dispose: () => owned.forEach((o) => o.dispose()),
  };
}

/**
 * Pose a bot for a frame. `seated` lifts nothing here (the caller sets root.y for the chair or sofa); it hides the
 * feet. `t` in ms, `phase` desynchronises bots, `still` (reduced motion) freezes everything but the pose itself.
 */
export function poseBot(b: Bot3D, kind: Pose | "walk" | "idle", seated: boolean, t: number, phase: number, still: boolean) {
  const ph = t / 1000 + phase;
  const k = still ? 0 : 1;
  let bob = 0;
  let leanX = 0;
  let tiltZ = 0;
  let turnY = 0;
  let eyeY = 1;
  let eyeX = 1;
  switch (kind) {
    case "walk":
      bob = Math.abs(Math.sin(ph * 10)) * 0.07 * k;
      leanX = 0.08;
      break;
    case "idle":
      turnY = Math.sin(ph * 0.5) * 0.3 * k;
      break;
    case "type":
      bob = Math.sin(ph * 14) * 0.015 * k;
      leanX = -0.06;
      break;
    case "sit":
      turnY = Math.sin(ph * 0.6) * 0.25 * k;
      break;
    case "chat":
      bob = Math.abs(Math.sin(ph * 3)) * 0.04 * k;
      turnY = Math.sin(ph * 0.9) * 0.45 * k;
      break;
    case "sleep":
      tiltZ = 0.28;
      leanX = 0.1;
      eyeY = 0.08;
      break;
    case "read":
      leanX = -0.12;
      eyeX = 1.05;
      break;
    case "operate":
      bob = Math.sin(ph * 6) * 0.02 * k;
      leanX = 0.1;
      break;
    case "stand":
      // waiting for approval: bounce and sway, eyes wide
      bob = Math.abs(Math.sin(ph * 4)) * 0.05 * k;
      tiltZ = Math.sin(ph * 3) * 0.08 * k;
      eyeY = 1.3;
      eyeX = 1.15;
      break;
  }
  const breathe = Math.sin(ph * 2) * 0.018 * k;
  b.body.position.y = bob;
  b.body.rotation.set(leanX, turnY, tiltZ);
  b.body.scale.set(1 - breathe * 0.5, 1 + breathe, 1 - breathe * 0.5);
  // a blink every few seconds, each bot on its own beat
  const blink = !still && kind !== "sleep" && (ph * 0.9) % 4.3 < 0.12;
  for (const e of b.eyes) {
    e.scale.x = b.eye.sx * eyeX;
    e.scale.y = blink ? b.eye.sy * 0.1 : b.eye.sy * eyeY;
  }
  b.feet.forEach((f, i) => {
    f.visible = !seated;
    f.position.z = BOT_R * 0.05 + (kind === "walk" ? Math.sin(ph * 10 + i * Math.PI) * 0.12 * k : 0);
  });
}
