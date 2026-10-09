"use client";

import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { clone as cloneSkinned } from "three/examples/jsm/utils/SkeletonUtils.js";

/** CC0 model packs in public/office (see the README there): every model is a top-level node named after its file. */
const PACKS = ["characters", "office", "furniture", "city"] as const;

export const CHARACTERS = ["male-a", "male-b", "male-c", "male-d", "male-e", "male-f", "female-a", "female-b", "female-c", "female-d", "female-e", "female-f"].map(
  (k) => `character-${k}`,
);

export interface OfficeAssets {
  /** a fresh copy of a model, centred on its footprint and standing on y = 0; geometry and materials are shared */
  place: (name: string, scale: number) => THREE.Group;
  /** footprint of a model at scale 1: width (x), height (y), depth (z) */
  size: (name: string) => THREE.Vector3;
  clips: THREE.AnimationClip[];
}

interface Template {
  node: THREE.Object3D;
  box: THREE.Box3;
  skinned: boolean;
}

let loading: Promise<OfficeAssets> | null = null;

/** Loads the packs once per page; later scenes reuse them. A failed load is retried by the next caller. */
export function loadOfficeAssets(): Promise<OfficeAssets> {
  loading ??= load().catch((e: unknown) => {
    loading = null;
    throw e;
  });
  return loading;
}

async function load(): Promise<OfficeAssets> {
  const loader = new GLTFLoader();
  const gltfs = await Promise.all(PACKS.map((p) => loader.loadAsync(`/office/${p}.glb`)));
  // the loader makes node names unique across the merged characters (root, root_1, …); every character has the same
  // skeleton, so strip the suffix from bones and clip tracks and one clip set drives them all
  const base = (name: string) => name.replace(/_\d+$/, "");
  for (const clip of gltfs[0]!.animations) for (const t of clip.tracks) t.name = t.name.replace(/^([^.]+)_\d+\./, "$1.");
  const templates = new Map<string, Template>();
  for (const g of gltfs)
    for (const node of g.scene.children) {
      node.updateMatrixWorld(true);
      let skinned = false;
      node.traverse((o) => {
        if (o !== node) o.name = base(o.name);
        if (!(o instanceof THREE.Mesh)) return;
        o.castShadow = o.receiveShadow = true;
        if (o instanceof THREE.SkinnedMesh) skinned = true;
      });
      const box = new THREE.Box3().setFromObject(node, true);
      templates.set(node.name, { node, box, skinned });
    }
  const get = (name: string) => {
    const t = templates.get(name);
    if (!t) throw new Error(`office model missing: ${name}`);
    return t;
  };
  return {
    clips: gltfs[0]!.animations,
    size: (name) => get(name).box.getSize(new THREE.Vector3()),
    place: (name, scale) => {
      const t = get(name);
      const copy = t.skinned ? cloneSkinned(t.node) : t.node.clone();
      const c = t.box.getCenter(new THREE.Vector3());
      copy.position.set(-c.x * scale, -t.box.min.y * scale, -c.z * scale);
      copy.scale.setScalar(scale);
      const pivot = new THREE.Group();
      pivot.name = name;
      pivot.add(copy);
      return pivot;
    },
  };
}
