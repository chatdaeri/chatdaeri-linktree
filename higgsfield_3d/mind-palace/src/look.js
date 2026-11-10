// 실사 보기: 생성 재질 사진(assets/tex) 불러오기, 미터 단위 UV, 숲 배경·하늘 조명, 후처리(다중 표본 버퍼·주변광 가림·빛 번짐)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 재질 사진 한 장이 덮는 실제 크기(m)
export const TILE = { travertine: 2.4, limestone: 1.5, plaster: 2.0, oak: 1.0, oakfloor: 1.6, gravel: 1.5, moss: 5.0, pine: 1.4, birch: 1.0 };
export const TEX = {};

export async function loadLook(renderer) {
  const loader = new THREE.TextureLoader();
  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const load = (url, srgb) => new Promise(res => loader.load(url, t => {
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = aniso;
    if (srgb) t.colorSpace = THREE.SRGBColorSpace;
    res(t);
  }, undefined, () => res(null)));
  await Promise.all(Object.keys(TILE).map(async n => {
    const [map, normal] = await Promise.all([load(`assets/tex/${n}.jpg`, true), load(`assets/tex/${n}_n.jpg`, false)]);
    TEX[n] = { map, normal };
  }));
  TEX.spine = await load('assets/tex/spine.jpg', false); // 밝기 배수로 쓰므로 선형
  TEX.forest = await load('assets/tex/forest.jpg', true);
  if (TEX.forest) TEX.forest.wrapT = THREE.ClampToEdgeWrapping;
  return TEX;
}

// 재질 사진을 입힌 MeshStandardMaterial
export function texMat(name, opt = {}) {
  const t = TEX[name] ?? {};
  const m = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.85, metalness: 0, ...opt });
  if (t.map) m.map = t.map;
  if (t.normal) { m.normalMap = t.normal; m.normalScale = new THREE.Vector2(opt.bump ?? 0.6, opt.bump ?? 0.6); }
  delete m.bump;
  return m;
}

// 형상의 지역 좌표로 UV를 다시 매긴다(면 방향에 따라 xz·zy·xy 투영, tile m마다 한 번 반복). off = 지역 좌표에 더할 값(옆 조각과 줄눈 맞춤)
export function meterUV(geo, tile, off = [0, 0, 0]) {
  const p = geo.attributes.position, n = geo.attributes.normal, uv = geo.attributes.uv;
  if (!p || !n || !uv) return geo;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i) + off[0], y = p.getY(i) + off[1], z = p.getZ(i) + off[2];
    const ax = Math.abs(n.getX(i)), ay = Math.abs(n.getY(i)), az = Math.abs(n.getZ(i));
    if (ay >= ax && ay >= az) uv.setXY(i, x / tile, -z / tile);
    else if (ax >= az) uv.setXY(i, (n.getX(i) > 0 ? -z : z) / tile, y / tile);
    else uv.setXY(i, (n.getZ(i) > 0 ? x : -x) / tile, y / tile);
  }
  uv.needsUpdate = true;
  return geo;
}

// 숲 띠로 하늘 조명(둘레 = 숲, 위 = 밝은 하늘, 아래 = 숲 바닥 색)
export function forestEnvironment(renderer) {
  const W = 2048, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H * 0.42);
  sky.addColorStop(0, '#F6F1E6'); sky.addColorStop(1, '#EDE6D4');
  g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.5);
  g.fillStyle = '#6E6A4A'; g.fillRect(0, H * 0.5, W, H * 0.5);
  const img = TEX.forest?.image;
  if (img) { // 띠를 두 번 둘러 수평선 위 0~35°에
    const bandH = H * 0.2, y0 = H * 0.5 - bandH;
    for (let k = 0; k < 2; k++) g.drawImage(img, k * W / 2, y0, W / 2, bandH + H * 0.03);
  }
  const t = new THREE.CanvasTexture(cv); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(t).texture;
  t.dispose(); pmrem.dispose();
  return env;
}

// 건물을 두르는 숲 배경(원기둥 안쪽 면) + 숲 바닥
export function forestBackdrop(center, R) {
  const group = new THREE.Group();
  const tex = TEX.forest;
  if (tex) {
    tex.repeat.set(3, 1);
    const Hc = (2 * Math.PI * R) / 3 / (tex.image.width / tex.image.height);
    const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, Hc, 96, 1, true), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false }));
    cyl.position.set(center.x, Hc / 2 - Hc * 0.1, center.z);
    cyl.renderOrder = -10; cyl.userData.noAO = true;
    group.add(cyl);
  }
  const ground = new THREE.Mesh(meterUV(new THREE.CircleGeometry(R + 2, 96).rotateX(-Math.PI / 2), TILE.moss), texMat('moss', { roughness: 1, bump: 1.0, color: 0xC9C3A6 }));
  ground.position.set(center.x, -0.03, center.z); ground.receiveShadow = true;
  group.add(ground);
  return group;
}

// 건물 둘레 나무줄기(소나무·자작나무). blocked(x, z) = 심으면 안 되는 자리
export function forestTrees(center, Rin, Rout, blocked) {
  const group = new THREE.Group();
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const kinds = [
    { tex: TEX.pine, n: 150, r: [0.22, 0.38], h: [22, 30], tile: 1.4 },
    { tex: TEX.birch, n: 45, r: [0.12, 0.2], h: [16, 22], tile: 1.0 },
  ];
  for (const k of kinds) {
    const geo = new THREE.CylinderGeometry(0.75, 1, 1, 14, 1, true); geo.translate(0, 0.5, 0);
    const map = k.tex?.map?.clone(); const nrm = k.tex?.normal?.clone();
    for (const t of [map, nrm]) if (t) { t.repeat.set(1, 14); t.needsUpdate = true; }
    const mat = new THREE.MeshStandardMaterial({ map, normalMap: nrm, roughness: 0.95, color: map ? 0xFFFFFF : 0x7A6652 });
    const mesh = new THREE.InstancedMesh(geo, mat, k.n);
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(), p = new THREE.Vector3();
    let i = 0, tries = 0;
    while (i < k.n && tries++ < k.n * 40) {
      const a = rnd() * Math.PI * 2, d = Math.sqrt(Rin * Rin + rnd() * (Rout * Rout - Rin * Rin));
      const x = center.x + Math.cos(a) * d, z = center.z + Math.sin(a) * d;
      if (blocked(x, z)) continue;
      const r = k.r[0] + rnd() * (k.r[1] - k.r[0]), h = k.h[0] + rnd() * (k.h[1] - k.h[0]);
      q.setFromAxisAngle(new THREE.Vector3(0, 1, 0), rnd() * 6.28);
      m.compose(p.set(x, -0.2, z), q, s.set(r, h, r));
      mesh.setMatrixAt(i++, m);
    }
    mesh.count = i; mesh.castShadow = true; mesh.receiveShadow = true;
    mesh.computeBoundingSphere();
    group.add(mesh);
  }
  return group;
}

// 후처리 묶음
export class Post {
  constructor(renderer, scene, camera) {
    this.renderer = renderer;
    const size = renderer.getSize(new THREE.Vector2());
    // 다중 표본(MSAA 4배) 버퍼: 벽·가구 모서리 계단 현상을 줄인다(Hana 판 가장자리는 sprite.js에서 알파 섞기로 처리)
    const rt = new THREE.WebGLRenderTarget(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new GTAOPass(scene, camera, size.x, size.y);
    this.ao.updateGtaoMaterial({ radius: 0.6, distanceExponent: 1.4, thickness: 1.2, scale: 1.0, samples: 12 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.85;
    this.composer.addPass(this.ao);
    this.bloom = new UnrealBloomPass(size, 0.18, 0.5, 0.92);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.enabled = true;
  }
  setSize(w, h, dpr) {
    this.composer.setPixelRatio(dpr);
    this.composer.setSize(w, h);
  }
  render(dt) { this.composer.render(dt); }
}
