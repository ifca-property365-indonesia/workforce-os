import * as THREE from "three";
import { HAIR_COLORS, SHIRT_COLORS, SKIN_TONES, type OfficeLook, type Pose } from "@wfos/shared/office";

/** Height multiplier of a character: about 1.75 floor tiles tall. */
export const CHIBI_SCALE = 1.3;

export interface Chibi {
  root: THREE.Group;
  legL: THREE.Group;
  legR: THREE.Group;
  armL: THREE.Group;
  armR: THREE.Group;
  head: THREE.Group;
  book: THREE.Mesh;
}

/**
 * Builds big-headed office characters from a look (shared/office.ts). Geometry and materials are shared between all
 * characters of one kit; dispose() frees them.
 */
export function createChibiKit() {
  const owned: { dispose: () => void }[] = [];
  const own = <T extends { dispose: () => void }>(x: T) => (owned.push(x), x);
  const mats = new Map<string, THREE.Material>();
  const mat = (color: string, extra?: THREE.MeshStandardMaterialParameters) => {
    const k = color + (extra ? JSON.stringify(extra) : "");
    let m = mats.get(k);
    if (!m) mats.set(k, (m = own(new THREE.MeshStandardMaterial({ color, roughness: 0.85, ...extra }))));
    return m;
  };
  const sphere = (r: number, phi0 = 0, phiLen = Math.PI * 2, theta0 = 0, thetaLen = Math.PI) => own(new THREE.SphereGeometry(r, 32, 16, phi0, phiLen, theta0, thetaLen));
  // sphere segments: phi = π/2 is the face (+z), π…2π the back of the head
  const G = {
    leg: own(new THREE.CylinderGeometry(0.085, 0.08, 0.26, 10)),
    shoe: own(new THREE.BoxGeometry(0.13, 0.07, 0.19)),
    torso: own(new THREE.CapsuleGeometry(0.2, 0.16, 6, 14)),
    arm: own(new THREE.CapsuleGeometry(0.065, 0.17, 4, 8)),
    hand: own(new THREE.SphereGeometry(0.065, 10, 8)),
    head: own(new THREE.SphereGeometry(0.36, 32, 24)),
    ear: own(new THREE.SphereGeometry(0.07, 12, 8)),
    eye: own(new THREE.SphereGeometry(0.04, 12, 8)),
    brow: own(new THREE.BoxGeometry(0.1, 0.022, 0.02)),
    mouth: own(new THREE.TorusGeometry(0.05, 0.011, 6, 14, Math.PI)),
    cap: sphere(0.378, 0, Math.PI * 2, 0, Math.PI * 0.56),
    back: sphere(0.385, Math.PI, Math.PI, Math.PI * 0.15, Math.PI * 0.62),
    long: sphere(0.39, Math.PI * 0.95, Math.PI * 1.1, Math.PI * 0.15, Math.PI * 0.75),
    fringe: own(new THREE.SphereGeometry(0.2, 16, 10)),
    spike: own(new THREE.ConeGeometry(0.08, 0.2, 8)),
    bun: own(new THREE.SphereGeometry(0.15, 16, 12)),
    tail: own(new THREE.CapsuleGeometry(0.08, 0.22, 4, 8)),
    afro: sphere(0.43, 0, Math.PI * 2, 0, Math.PI * 0.6),
    beard: sphere(0.372, Math.PI / 2 - 0.9, 1.8, Math.PI * 0.64, Math.PI * 0.24),
    moustache: own(new THREE.CapsuleGeometry(0.025, 0.12, 4, 8)),
    lensRound: own(new THREE.TorusGeometry(0.075, 0.013, 8, 20)),
    lensSquare: own(new THREE.TorusGeometry(0.085, 0.013, 4, 4)),
    lensFill: own(new THREE.CircleGeometry(0.072, 20)),
    bridge: own(new THREE.BoxGeometry(0.08, 0.015, 0.015)),
    hatTop: sphere(0.395, 0, Math.PI * 2, 0, Math.PI * 0.5),
    brim: own(new THREE.CylinderGeometry(0.24, 0.24, 0.025, 20, 1, false, -Math.PI / 2, Math.PI)),
    beanieRim: own(new THREE.TorusGeometry(0.37, 0.05, 8, 28)),
    pom: own(new THREE.SphereGeometry(0.08, 12, 8)),
    band: own(new THREE.TorusGeometry(0.41, 0.03, 8, 24, Math.PI)),
    cup: own(new THREE.CylinderGeometry(0.1, 0.1, 0.07, 16)),
    logo: own(new THREE.PlaneGeometry(0.2, 0.1)),
    book: own(new THREE.BoxGeometry(0.26, 0.2, 0.05)),
  };

  const build = (look: OfficeLook, opts: { logo?: THREE.Texture | null } = {}): Chibi => {
    const skin = mat(SKIN_TONES[look.skin] ?? SKIN_TONES[0]);
    const hairColor = HAIR_COLORS[look.hairColor] ?? HAIR_COLORS[0];
    const hair = mat(hairColor, { side: THREE.DoubleSide, roughness: 0.9 });
    const shirtColor = SHIRT_COLORS[look.shirt] ?? SHIRT_COLORS[0];
    const shirt = mat(shirtColor);
    // headwear a shade darker than the shirt, so it reads as a hat and not as part of the head
    const hat = mat("#" + new THREE.Color(shirtColor).lerp(new THREE.Color("#000000"), 0.35).getHexString());
    const dark = mat("#18161d");
    const root = new THREE.Group();
    root.scale.setScalar(CHIBI_SCALE);
    const add = (geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, parent: THREE.Object3D) => {
      const mesh = new THREE.Mesh(geo, m);
      mesh.position.set(x, y, z);
      mesh.castShadow = mesh.receiveShadow = true;
      parent.add(mesh);
      return mesh;
    };
    const limb = (x: number, y: number) => {
      const g = new THREE.Group();
      g.position.set(x, y, 0);
      root.add(g);
      return g;
    };

    // body
    const legL = limb(-0.1, 0.28);
    const legR = limb(0.1, 0.28);
    for (const leg of [legL, legR]) {
      add(G.leg, mat("#2c2a35"), 0, -0.13, 0, leg);
      add(G.shoe, mat("#f1f0ec"), 0, -0.26, 0.03, leg);
    }
    add(G.torso, shirt, 0, 0.5, 0, root).scale.set(1, 1, 0.85);
    if (look.logo && opts.logo) {
      const badge = new THREE.Mesh(G.logo, mat("#ffffff", { map: opts.logo, transparent: true, roughness: 1 }));
      badge.position.set(0, 0.56, 0.176);
      root.add(badge);
    }
    const armL = limb(-0.25, 0.64);
    const armR = limb(0.25, 0.64);
    for (const arm of [armL, armR]) {
      add(G.arm, shirt, 0, -0.13, 0, arm);
      add(G.hand, skin, 0, -0.28, 0, arm);
    }
    const book = add(G.book, mat("#4f81bd"), 0, 0.55, 0.32, root);
    book.rotation.x = -0.6;
    book.visible = false;

    // head and face
    const head = limb(0, 1.0);
    add(G.head, skin, 0, 0, 0, head);
    for (const sx of [-1, 1]) {
      add(G.ear, skin, sx * 0.35, -0.02, 0, head).scale.set(0.6, 1, 0.8);
      add(G.eye, dark, sx * 0.125, -0.03, 0.33, head).scale.set(1, 1.45, 0.6);
      add(G.brow, mat(hairColor), sx * 0.125, 0.07, 0.335, head).rotation.z = sx * -0.12;
    }
    const mouth = add(G.mouth, mat("#7a3b32"), 0, -0.13, 0.33, head);
    mouth.rotation.z = Math.PI;
    mouth.scale.set(1, 0.6, 1);

    // hair (under a cap or beanie only what shows below it: no fringe, spikes, bun or afro crown)
    const covered = look.hat === "cap" || look.hat === "beanie";
    const h = covered && (look.hair === "afro" || look.hair === "spiky" || look.hair === "side" || look.hair === "bun") ? "short" : look.hair;
    if (h === "afro") add(G.afro, hair, 0, 0.04, -0.03, head).rotation.x = -0.32;
    else if (h !== "bald") add(G.cap, hair, 0, 0.01, -0.01, head).rotation.x = -0.42;
    if (h === "bob") add(G.back, hair, 0, -0.02, 0, head);
    if (h === "long") add(G.long, hair, 0, -0.06, -0.01, head).scale.set(1, 1.25, 1);
    if (h === "bun") add(G.bun, hair, 0, 0.33, -0.16, head);
    if (h === "tail") {
      add(G.bun, hair, 0, 0.12, -0.36, head).scale.setScalar(0.7);
      add(G.tail, hair, 0, -0.08, -0.42, head);
    }
    if (h === "side") add(G.fringe, hair, -0.12, 0.2, 0.2, head).scale.set(1.3, 0.55, 0.8);
    if (h === "spiky")
      for (const [x, z, rx, rz] of [[0, 0.05, -0.3, 0], [-0.15, 0, -0.1, 0.5], [0.15, 0, -0.1, -0.5], [-0.08, -0.17, 0.4, 0.3], [0.08, -0.17, 0.4, -0.3]] as const)
        add(G.spike, hair, x, 0.36, z, head).rotation.set(rx, 0, rz);

    // beard
    if (look.beard === "stubble") add(G.beard, mat(hairColor, { transparent: true, opacity: 0.45, side: THREE.DoubleSide }), 0, 0, 0, head);
    if (look.beard === "full") add(G.beard, hair, 0, -0.01, 0.005, head).scale.setScalar(1.04);
    if (look.beard === "moustache" || look.beard === "full") add(G.moustache, hair, 0, -0.085, 0.345, head).rotation.z = Math.PI / 2;

    // glasses
    if (look.glasses !== "none") {
      const frame = mat("#222028", { metalness: 0.3, roughness: 0.4 });
      for (const sx of [-1, 1]) {
        const lens = add(look.glasses === "square" ? G.lensSquare : G.lensRound, frame, sx * 0.125, -0.03, 0.355, head);
        if (look.glasses === "square") lens.rotation.z = Math.PI / 4;
        if (look.glasses === "sun") add(G.lensFill, mat("#16151b", { roughness: 0.2, metalness: 0.4 }), sx * 0.125, -0.03, 0.353, head);
      }
      add(G.bridge, frame, 0, -0.02, 0.36, head);
    }

    // hats (the hat's shell covers the hair under it)
    if (look.hat === "cap") {
      add(G.hatTop, hat, 0, 0.02, 0, head).rotation.x = -0.12;
      add(G.brim, hat, 0, 0.1, 0.3, head).rotation.x = 0.1;
    }
    if (look.hat === "beanie") {
      add(G.hatTop, hat, 0, 0.06, 0, head).scale.set(1, 1.1, 1);
      add(G.beanieRim, hat, 0, 0.11, 0, head).rotation.x = Math.PI / 2;
      add(G.pom, mat("#f1f0ec"), 0, 0.5, 0, head);
    }
    if (look.hat === "headphones") {
      add(G.band, dark, 0, 0, 0, head);
      for (const sx of [-1, 1]) add(G.cup, dark, sx * 0.38, -0.02, 0, head).rotation.z = Math.PI / 2;
    }
    return { root, legL, legR, armL, armR, head, book };
  };

  return { build, dispose: () => owned.forEach((o) => o.dispose()) };
}

/** A pose (or walking) at time t, set absolutely on the limbs: nothing accumulates from frame to frame. */
export function poseChibi(c: Chibi, kind: Pose | "walk" | "idle", t: number, phase: number, still: boolean) {
  const ph = t / 1000 + phase;
  const k = still ? 0 : 1;
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
    case "idle":
      headY = Math.sin(ph * 0.5) * 0.25 * k;
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
  c.legL.rotation.x = legX + swing;
  c.legR.rotation.x = legX - swing;
  c.armL.rotation.set(armL, 0, armLz);
  c.armR.rotation.set(armR, 0, armRz);
  c.head.rotation.set(headX, headY, 0);
  c.book.visible = kind === "read";
  c.root.position.y = (legX ? 0.1 : 0) + bob;
}

/** Text (company initials) centred on a transparent canvas: shirt badges and the reception sign use it. */
export function textTexture(text: string, opts: { color?: string; width?: number; height?: number; weight?: number } = {}): THREE.CanvasTexture {
  const c = document.createElement("canvas");
  c.width = opts.width ?? 256;
  c.height = opts.height ?? 128;
  const ctx = c.getContext("2d")!;
  ctx.fillStyle = opts.color ?? "#f1f0ec";
  ctx.font = `${opts.weight ?? 900} ${Math.round(c.height * 0.7)}px system-ui, sans-serif`;
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  ctx.fillText(text, c.width / 2, c.height / 2 + c.height * 0.04, c.width * 0.94);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}
