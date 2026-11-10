// 가구: 생성 3D 모델(assets/furniture/*.glb) + 상자로 짜는 가구(주방·붙박이장·가전). 앞면 = 지역 +z.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { texMat, meterUV, TILE } from './look.js';

// 모델 파일과 모델의 앞 방향 보정(라디안). 모델 앞이 +z가 아니면 여기서 돌린다.
const GLB = {
  sofa: { file: 'sofa', turn: 0 }, armchair: { file: 'armchair', turn: 0 }, tv: { file: 'tv', turn: 0 },
  bed: { file: 'bed', turn: 0 }, 'bed-single': { file: 'bed', turn: 0 },
  toilet: { file: 'toilet', turn: 0 }, vanity: { file: 'vanity', turn: 0 }, bathtub: { file: 'bathtub', turn: 0 },
  chair: { file: 'chair', turn: 0 }, table: { file: 'table', turn: 0 }, plant: { file: 'plant', turn: 0 }, lamp: { file: 'lamp', turn: 0 },
};

export class Furniture {
  constructor(scene, S) {
    this.scene = scene; this.S = S; this.group = new THREE.Group(); scene.add(this.group);
    this.cache = new Map();
    this.M = {
      oak: texMat('oak', { roughness: 0.55, bump: 0.2 }),
      oakDark: texMat('oak', { roughness: 0.55, bump: 0.2, color: 0xC9B08E }),
      white: new THREE.MeshStandardMaterial({ color: 0xF4F2EE, roughness: 0.45 }),
      greige: new THREE.MeshStandardMaterial({ color: 0xDCD6CC, roughness: 0.6 }),
      stone: texMat('limestone', { roughness: 0.25, bump: 0.1, color: 0xF2EFEA }),
      steel: new THREE.MeshStandardMaterial({ color: 0xC9CCCF, roughness: 0.3, metalness: 0.8 }),
      black: new THREE.MeshStandardMaterial({ color: 0x1E1F21, roughness: 0.2, metalness: 0.3 }),
      seam: new THREE.MeshStandardMaterial({ color: 0x8C8378, roughness: 0.8 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xEAF2F2, roughness: 0.05, transparent: true, opacity: 0.18, depthWrite: false, side: THREE.DoubleSide }),
      rug: new THREE.MeshStandardMaterial({ color: 0xD9D0C1, roughness: 1 }),
    };
    this.footprints = []; // 가구 자리(카메라 가림 판정용)
  }
  async load(names) {
    const loader = new GLTFLoader();
    await Promise.all([...new Set(names)].map(async n => {
      try { const g = await loader.loadAsync(`assets/furniture/${n}.glb`); g.scene.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; if (o.material) o.material.envMapIntensity = 0.8; } }); this.cache.set(n, g.scene); }
      catch { /* 없으면 상자 가구로 */ }
    }));
  }
  async build() {
    const items = this.S.furniture;
    const need = items.flatMap(f => f.type === 'dining' ? ['table', 'chair'] : f.type === 'nightstand' ? ['lamp'] : GLB[f.type] ? [GLB[f.type].file] : []);
    await this.load(need);
    for (const f of items) {
      const obj = this.make(f);
      if (!obj) continue;
      obj.position.set(f.x, 0, f.z); obj.rotation.y = (f.rot ?? 0) * Math.PI / 180;
      obj.traverse(o => { if (o.isMesh) { o.castShadow = o.castShadow !== false; o.receiveShadow = true; } });
      obj.userData.furniture = f.type; obj.userData.h = f.type === 'counter' && f.upper ? 2.2 : (f.h ?? 0);
      this.group.add(obj);
    }
    return this;
  }
  // 모델을 상자(w × h × d)에 맞춘다. 바닥 = y 0, 가운데 = 원점
  fit(name, w, d, h, turn = 0) {
    const src = this.cache.get(name); if (!src) return null;
    const obj = src.clone(true);
    obj.rotation.y = turn;
    const wrap = new THREE.Group(); wrap.add(obj); wrap.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(wrap), s = box.getSize(new THREE.Vector3());
    const kx = w / s.x, kz = d / s.z;
    const ky = h ? h / s.y : (kx + kz) / 2;
    const kyy = Math.min(ky, (kx + kz) / 2 * 1.25);
    if (Math.abs(Math.sin(turn)) > 0.7) obj.scale.set(kz, kyy, kx); else obj.scale.set(kx, kyy, kz); // 90° 돌린 모델은 폭·깊이 축이 바뀐다
    wrap.updateMatrixWorld(true);
    const b2 = new THREE.Box3().setFromObject(wrap), c = b2.getCenter(new THREE.Vector3());
    obj.position.x -= c.x; obj.position.z -= c.z; obj.position.y -= b2.min.y;
    const out = new THREE.Group(); out.add(wrap); return out;
  }
  make(f) {
    const { w, d, h } = f, M = this.M;
    const g = new THREE.Group();
    const box = (bw, bh, bd, mat, x = 0, y = 0, z = 0, uv = TILE.oak) => { const geo = new THREE.BoxGeometry(bw, bh, bd); if (mat.map) meterUV(geo, uv, [x, y, z]); const m = new THREE.Mesh(geo, mat); m.position.set(x, y + bh / 2, z); m.castShadow = true; m.receiveShadow = true; g.add(m); return m; };
    const glb = GLB[f.type];
    switch (f.type) {
      case 'dining': {
        const t = this.fit('table', w, d, 0.75) ?? (() => { box(w, 0.04, d, M.oak, 0, 0.71, 0); return null; })();
        if (t) g.add(t);
        const n = f.chairs ?? (w > 1.5 ? 6 : 4), perSide = Math.ceil(n / 2);
        for (let s = 0; s < 2; s++) for (let i = 0; i < perSide && s * perSide + i < n; i++) {
          const c = this.fit('chair', 0.48, 0.5, 0.86); if (!c) continue;
          const u = (i + 0.5) / perSide - 0.5;
          c.position.set(u * w * 0.85, 0, (s ? 1 : -1) * (d / 2 + 0.12)); c.rotation.y = s ? Math.PI : 0;
          g.add(c);
        }
        return g;
      }
      case 'counter': case 'island': {
        const top = 0.04, baseH = (h ?? 0.9) - top;
        box(w, 0.1, d - 0.06, M.seam, 0, 0, -0.03);                  // 걸레받이
        box(w, baseH - 0.1, d - 0.02, M.white, 0, 0.1, -0.01);         // 하부장
        for (let i = 1; i < Math.round(w / 0.6); i++) box(0.006, baseH - 0.14, 0.005, M.seam, -w / 2 + i * (w / Math.round(w / 0.6)), 0.12, d / 2 - 0.01);
        box(w + 0.02, top, d + 0.02, M.stone, 0, baseH, 0, TILE.limestone); // 상판
        if (f.sink) { const s = box(0.7, 0.012, 0.42, M.steel, w > 1.4 ? w * 0.15 : 0, baseH + top - 0.008, 0.02); s.castShadow = false; box(0.03, 0.28, 0.03, M.steel, w > 1.4 ? w * 0.15 : 0, baseH + top, -d / 2 + 0.1); }
        if (f.cooktop) { const c = box(0.6, 0.006, 0.5, M.black, w > 1.2 ? -w * 0.18 : 0, baseH + top, 0.02); c.castShadow = false; }
        if (f.upper && f.type === 'counter') {
          box(w, 0.72, 0.34, M.white, 0, 1.48, -d / 2 + 0.17);
          for (let i = 1; i < Math.round(w / 0.6); i++) box(0.006, 0.7, 0.005, M.seam, -w / 2 + i * (w / Math.round(w / 0.6)), 1.49, -d / 2 + 0.345);
          box(w, 0.58, 0.012, M.stone, 0, baseH + top, -d / 2 + 0.006, TILE.limestone); // 벽 타일(상판~상부장 사이)
        }
        return g;
      }
      case 'wardrobe': case 'shoe': {
        const H2 = h ?? 2.2, mat = f.type === 'shoe' ? M.white : (f.color === 'white' ? M.white : M.oak);
        box(w, H2, d, mat);
        const n = Math.max(1, Math.round(w / 0.5));
        for (let i = 1; i < n; i++) box(0.006, H2 - 0.06, 0.006, M.seam, -w / 2 + i * w / n, 0.03, d / 2 + 0.001);
        for (let i = 0; i < n; i++) box(0.02, 0.3, 0.025, M.steel, -w / 2 + (i + (i % 2 ? 0.12 : 0.88)) * w / n, H2 * 0.45, d / 2 + 0.012);
        return g;
      }
      case 'dresser': case 'nightstand': {
        const H2 = h ?? (f.type === 'dresser' ? 0.8 : 0.5);
        box(w, H2, d, M.oak);
        const rows = f.type === 'dresser' ? 3 : 2;
        for (let i = 1; i < rows; i++) box(w - 0.04, 0.006, 0.006, M.seam, 0, H2 * i / rows, d / 2 + 0.001);
        if (f.type === 'nightstand') { const l = this.fit('lamp', 0.26, 0.26, 0.42); if (l) { l.position.y = H2; g.add(l); } }
        return g;
      }
      case 'desk': {
        box(w, 0.035, d, M.oak, 0, 0.72, 0);
        box(0.03, 0.72, d - 0.04, M.oak, -w / 2 + 0.03, 0, 0); box(0.03, 0.72, d - 0.04, M.oak, w / 2 - 0.03, 0, 0);
        box(w - 0.08, 0.3, 0.02, M.oak, 0, 0.4, -d / 2 + 0.03);
        return g;
      }
      case 'fridge': {
        const H2 = h ?? 1.85;
        box(w, H2, d, M.steel);
        box(0.008, H2 - 0.05, 0.006, M.seam, 0, 0.02, d / 2 + 0.002);
        for (const s of [-1, 1]) box(0.02, 0.5, 0.03, M.white, s * 0.04, H2 * 0.5, d / 2 + 0.015);
        return g;
      }
      case 'washer': {
        box(w, h ?? 0.85, d, M.white);
        const door = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.2, 0.03, 40).rotateX(Math.PI / 2), M.black);
        door.position.set(0, 0.42, d / 2 + 0.01); g.add(door);
        box(w - 0.06, 0.08, 0.01, M.greige, 0, 0.72, d / 2 + 0.002);
        return g;
      }
      case 'shower': {
        box(w, 0.04, d, M.white);
        const gl = new THREE.Mesh(new THREE.BoxGeometry(w, 2.0, 0.01), M.glass); gl.position.set(0, 1.04, d / 2); gl.castShadow = false; g.add(gl);
        box(0.03, 0.03, 0.25, M.steel, 0, 1.95, -d / 2 + 0.13);
        return g;
      }
      case 'rug': { const r = box(w, 0.012, d, M.rug); r.castShadow = false; return g; }
      default: {
        if (!glb) return null;
        const o = this.fit(glb.file, w, d, f.type === 'bed' || f.type === 'bed-single' ? null : h, glb.turn);
        if (o) { g.add(o); return g; }
        box(w, h, d, M.greige); return g; // 모델이 없으면 상자
      }
    }
  }
}
