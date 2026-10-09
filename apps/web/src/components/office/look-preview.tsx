"use client";

import { useEffect, useRef } from "react";
import * as THREE from "three";
import { initials, SHIRT_COLORS, type OfficeLook } from "@wfos/shared/office";
import { createChibiKit, poseChibi, textTexture, type Chibi } from "./chibi";

/** A turning character on a little floor disc, rebuilt whenever the look changes. Loaded only by the character editor. */
export default function LookPreview({ look, company, label, reducedMotion }: { look: OfficeLook; company: string; label: string; reducedMotion: boolean }) {
  const wrap = useRef<HTMLDivElement>(null);
  const setLook = useRef<(l: OfficeLook) => void>(() => {});
  const lookRef = useRef(look);
  lookRef.current = look;

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    let renderer: THREE.WebGLRenderer;
    try {
      renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    } catch {
      return; // no WebGL: the editor still works without the picture
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.shadowMap.enabled = true;
    renderer.domElement.style.display = "block";
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    scene.add(new THREE.HemisphereLight("#fff8ee", "#8a84a8", 1.6));
    const sun = new THREE.DirectionalLight("#ffe9cc", 2.2);
    sun.position.set(2, 5, 4);
    sun.castShadow = true;
    scene.add(sun);
    const discGeo = new THREE.CircleGeometry(0.75, 40);
    const discMat = new THREE.MeshStandardMaterial({ color: "#e7dcc8", roughness: 1 });
    const disc = new THREE.Mesh(discGeo, discMat);
    disc.rotation.x = -Math.PI / 2;
    disc.receiveShadow = true;
    scene.add(disc);
    const camera = new THREE.PerspectiveCamera(30, 1, 0.1, 50);
    camera.position.set(0, 1.6, 4.6);
    camera.lookAt(0, 0.95, 0);
    const kit = createChibiKit();
    const mark = initials(company);
    const badges = mark ? [textTexture(mark, { color: "#f1f0ec" }), textTexture(mark, { color: "#1f1d24" })] : [];
    let chibi: Chibi | null = null;
    const turntable = new THREE.Group();
    scene.add(turntable);
    setLook.current = (l) => {
      if (chibi) turntable.remove(chibi.root);
      const lightShirt = new THREE.Color(SHIRT_COLORS[l.shirt] ?? "#000").getHSL({ h: 0, s: 0, l: 0 }).l > 0.6;
      chibi = kit.build(l, { logo: badges[lightShirt ? 1 : 0] ?? null });
      turntable.add(chibi.root);
    };
    setLook.current(lookRef.current);

    const fit = () => {
      const w = el.clientWidth;
      const h = Math.round(w * 1.15);
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(el);
    let raf = 0;
    const frame = (t: number) => {
      if (chibi) poseChibi(chibi, "idle", t, 0, reducedMotion);
      turntable.rotation.y = reducedMotion ? 0.35 : Math.sin(t / 2200) * 0.7;
      renderer.render(scene, camera);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      setLook.current = () => {};
      kit.dispose();
      badges.forEach((b) => b.dispose());
      discGeo.dispose();
      discMat.dispose();
      renderer.dispose();
      renderer.domElement.remove();
    };
  }, [company, reducedMotion]);

  useEffect(() => setLook.current(look), [look]);

  return <div ref={wrap} role="img" aria-label={label} className="w-full overflow-hidden rounded-lg bg-muted" />;
}
