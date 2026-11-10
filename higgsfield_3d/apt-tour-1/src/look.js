// 실사 보기(마인드 팰리스 게임판에서 가져옴): 재질 사진 불러오기, 미터 단위 UV, 창밖 배경·하늘 조명, 후처리(MSAA·주변광 가림·빛 번짐)
import * as THREE from 'three';
import { EffectComposer } from 'three/addons/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/addons/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/addons/postprocessing/GTAOPass.js';
import { UnrealBloomPass } from 'three/addons/postprocessing/UnrealBloomPass.js';
import { OutputPass } from 'three/addons/postprocessing/OutputPass.js';

// 재질 사진 한 장이 덮는 실제 크기(m)
export const TILE = { plaster: 2.0, oak: 1.0, oakfloor: 1.6, limestone: 1.2, travertine: 1.8 };
export const TEX = {};

export async function loadLook(renderer, view = 'forest') {
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
  TEX.view = await load(`assets/tex/${view}.jpg`, true) ?? await load('assets/tex/forest.jpg', true);
  if (TEX.view) TEX.view.wrapT = THREE.ClampToEdgeWrapping;
  return TEX;
}

export function texMat(name, opt = {}) {
  const t = TEX[name] ?? {};
  const { bump, ...rest } = opt;
  const m = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.85, metalness: 0, ...rest });
  if (t.map) m.map = t.map;
  if (t.normal) { m.normalMap = t.normal; m.normalScale = new THREE.Vector2(bump ?? 0.5, bump ?? 0.5); }
  return m;
}

// 형상의 지역 좌표로 UV를 다시 매긴다(면 방향에 따라 xz·zy·xy 투영, tile m마다 한 번)
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

// 창밖 띠로 하늘 조명
export function viewEnvironment(renderer) {
  const W = 2048, H = 1024, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  const sky = g.createLinearGradient(0, 0, 0, H * 0.5);
  sky.addColorStop(0, '#F7F4EC'); sky.addColorStop(1, '#ECE8DC');
  g.fillStyle = sky; g.fillRect(0, 0, W, H * 0.5);
  g.fillStyle = '#8A8670'; g.fillRect(0, H * 0.5, W, H * 0.5);
  const img = TEX.view?.image;
  if (img) for (let k = 0; k < 2; k++) g.drawImage(img, k * W / 2, H * 0.32, W / 2, H * 0.22);
  const t = new THREE.CanvasTexture(cv); t.mapping = THREE.EquirectangularReflectionMapping; t.colorSpace = THREE.SRGBColorSpace;
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromEquirectangular(t).texture;
  t.dispose(); pmrem.dispose();
  return env;
}

// 집을 두르는 창밖 배경(원기둥 안쪽 면). floorY = 배경 사진 아래끝 높이(고층이면 바닥보다 아래)
export function viewBackdrop(center, R, floorY = -1.2) {
  const tex = TEX.view;
  if (!tex) return new THREE.Group();
  tex.repeat.set(3, 1);
  const Hc = (2 * Math.PI * R) / 3 / (tex.image.width / tex.image.height);
  const cyl = new THREE.Mesh(new THREE.CylinderGeometry(R, R, Hc, 96, 1, true), new THREE.MeshBasicMaterial({ map: tex, side: THREE.BackSide, fog: false, toneMapped: false, depthWrite: false }));
  cyl.position.set(center.x, floorY + Hc / 2, center.z);
  cyl.renderOrder = -10; cyl.userData.noAO = true;
  return cyl;
}

export class Post {
  constructor(renderer, scene, camera) {
    const size = renderer.getSize(new THREE.Vector2());
    // MSAA 4배: 벽·가구 모서리 계단 현상을 줄인다(Hana 판 가장자리는 sprite.js에서 알파 섞기로 처리)
    const rt = new THREE.WebGLRenderTarget(size.x * renderer.getPixelRatio(), size.y * renderer.getPixelRatio(), { type: THREE.HalfFloatType, samples: 4 });
    this.composer = new EffectComposer(renderer, rt);
    this.composer.addPass(new RenderPass(scene, camera));
    this.ao = new GTAOPass(scene, camera, size.x, size.y);
    this.ao.updateGtaoMaterial({ radius: 0.45, distanceExponent: 1.4, thickness: 1.0, scale: 1.0, samples: 12 });
    this.ao.updatePdMaterial({ lumaPhi: 10, depthPhi: 2, normalPhi: 3, radius: 6, rings: 2, samples: 12 });
    this.ao.blendIntensity = 0.8;
    this.composer.addPass(this.ao);
    this.bloom = new UnrealBloomPass(size, 0.16, 0.5, 0.93);
    this.composer.addPass(this.bloom);
    this.composer.addPass(new OutputPass());
    this.enabled = true;
  }
  setSize(w, h, dpr) { this.composer.setPixelRatio(dpr); this.composer.setSize(w, h); }
  render(dt) { this.composer.render(dt); }
}
