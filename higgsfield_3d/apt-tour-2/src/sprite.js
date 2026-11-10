// Hana 2.5D 실사 스프라이트: 카메라를 향한 판 하나에 방향(5방향 + 좌우 반전 = 8방향)·상태(대기·걷기·인사·앉아 읽기)별 사진 프레임을 바꿔 그린다.
import * as THREE from 'three';

const DIRS = ['back', 'backL', 'left', 'frontL', 'front'];
const STATE_CLIP = { idle: 'idle', walk: 'walk', fast: 'walk', look: 'idle', pickLow: 'idle', wave: 'wave', sitDown: 'read', sitIdle: 'read', standUp: 'idle' };

export class SpriteBody {
  constructor(root, manifest, cfg) {
    this.root = root; this.man = manifest; this.cfg = cfg;
    this.tex = new Map(); this.loader = new THREE.TextureLoader();
    const geo = new THREE.PlaneGeometry(1, 1); geo.translate(0, 0.5, 0);
    this.mat = new THREE.MeshBasicMaterial({ transparent: false, alphaTest: 0.5, alphaToCoverage: true, side: THREE.DoubleSide, toneMapped: false, color: new THREE.Color(0.99, 0.97, 0.93) });
    this.mesh = new THREE.Mesh(geo, this.mat);
    this.mesh.renderOrder = 1;
    // 주변광 가림(GTAO) 계산용: 오린 모양 그대로, 카메라를 향한 평평한 면(노멀 0,0,1)
    const ao = new THREE.MeshBasicMaterial({ alphaTest: 0.5, side: THREE.DoubleSide, toneMapped: false });
    ao.onBeforeCompile = sh => { sh.fragmentShader = sh.fragmentShader.replace('#include <dithering_fragment>', '#include <dithering_fragment>\n\tgl_FragColor = vec4(0.5, 0.5, 1.0, 1.0);'); };
    this.mesh.userData.aoMaterial = ao;
    // 햇빛 그림자: 오린 모양으로
    this.mesh.castShadow = true;
    this.mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking, alphaTest: 0.5, side: THREE.DoubleSide });
    // 판은 Hana 회전과 상관없이 카메라를 본다 → 장면에 직접 붙인다
    this.holder = new THREE.Group(); this.holder.add(this.mesh);
    root.parent.add(this.holder);
    this.shadow = blobShadow(); root.add(this.shadow);
    this.frame = 0; this.time = 0; this.sector = 0; this.mirror = false; this.clipKey = null;
    this.seatPose = null;
  }
  async preload(onProgress = () => {}) {
    const keys = Object.keys(this.man); let done = 0;
    await Promise.all(keys.map(k => new Promise(res => {
      this.loader.load(`${this.man[k].file}`, t => {
        t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter;
        t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
        this.tex.set(k, t); onProgress(++done / keys.length); res();
      }, undefined, () => { onProgress(++done / keys.length); res(); });
    })));
  }
  // 방향: 카메라 → Hana 시선과 Hana가 보는 방향 사이 각
  pickDirection(pos, heading, cam) {
    const vx = pos.x - cam.position.x, vz = pos.z - cam.position.z, L = Math.hypot(vx, vz) || 1;
    const v = { x: vx / L, z: vz / L }, right = { x: -v.z, z: v.x };
    const f = { x: Math.sin(heading), z: Math.cos(heading) };
    const d = f.x * v.x + f.z * v.z, s = f.x * right.x + f.z * right.z;
    const theta = Math.atan2(Math.abs(s), d); // 0 = 뒷모습, π = 앞모습
    const raw = theta / (Math.PI / 4);
    // 경계에서 깜빡이지 않게 6° 여유
    if (Math.abs(raw - this.sector) > 0.5 + 0.13) this.sector = Math.round(raw);
    this.mirror = s > 0.02 ? true : s < -0.02 ? false : this.mirror; // 화면 오른쪽을 보면 왼쪽 그림을 뒤집는다
    return DIRS[Math.max(0, Math.min(4, this.sector))];
  }
  clipFor(state, dir) {
    const base = STATE_CLIP[state] ?? 'idle';
    if (base === 'read') return this.man['read-seated'] ? 'read-seated' : this.clipFor('idle', dir);
    if (base === 'wave') return this.man['wave-front'] ? 'wave-front' : this.clipFor('idle', 'front');
    // 그 방향 클립이 없으면 가까운 방향으로
    const order = [dir, ...DIRS.slice().sort((a, b) => Math.abs(DIRS.indexOf(a) - DIRS.indexOf(dir)) - Math.abs(DIRS.indexOf(b) - DIRS.indexOf(dir)))];
    for (const d of order) { if (this.man[`${base}-${d}`]) return `${base}-${d}`; if (base === 'idle' && this.man[`walk-${d}`]) return `walk-${d}`; }
    return Object.keys(this.man)[0];
  }
  update(dt, hana, cam) {
    const state = hana.state;
    const seated = state === 'sitIdle' || state === 'sitDown';
    const dir = seated ? 'frontL' : state === 'wave' ? 'front' : this.pickDirection(hana.position, hana.heading, cam);
    const key = this.clipFor(state, dir);
    const clip = this.man[key];
    if (!clip) return;
    if (key !== this.clipKey) { this.clipKey = key; this.time = 0; const t = this.tex.get(key); if (t) { this.mat.map = t; this.mat.needsUpdate = true; this.mesh.customDepthMaterial.map = t; this.mesh.customDepthMaterial.needsUpdate = true; } }
    const t = this.mat.map; if (!t) return;
    // 재생 속도: 걷기는 이동 속도에 맞춰(발 미끄러짐 줄이기)
    let rate = 1;
    if (key.startsWith('walk-') && (state === 'walk' || state === 'fast')) rate = Math.max(0.6, Math.min(2.2, hana.speed / 1.25));
    else if (key.startsWith('walk-')) rate = 0; // 대기 클립이 없으면 걷기 첫 칸으로 서 있기
    this.time += dt * rate;
    let f = Math.floor(this.time * clip.fps);
    f = clip.mode === 'loop' ? f % clip.frames : Math.min(clip.frames - 1, f);
    const rows = Math.ceil(clip.frames / clip.cols);
    t.repeat.set(1 / clip.cols, 1 / rows);
    t.offset.set((f % clip.cols) / clip.cols, 1 - (Math.floor(f / clip.cols) + 1) / rows);
    // 크기: 사람 키(서 있을 때 1.65m, 앉아 있을 때 의자 포함 약 1.32m)
    const personH = seated ? 1.32 : this.cfg.height;
    const h = personH / clip.personFrac, w = h * (clip.w / clip.h);
    this.mesh.scale.set(this.mirror && !seated && state !== 'wave' ? -w : w, h, 1);
    if (seated && this.seatMirror != null) this.mesh.scale.x = this.seatMirror ? -w : w;
    this.mesh.position.y = -clip.footFrac * h;
    // 카메라를 향해 세운다(세로축만 회전)
    const p = seated && this.seatPose ? this.seatPose : hana.position;
    this.holder.position.set(p.x, hana.position.y, p.z);
    this.holder.rotation.y = Math.atan2(cam.position.x - p.x, cam.position.z - p.z);
    this.shadow.visible = !seated;
  }
  clipDuration(name) { const c = this.man[name]; return c ? c.frames / c.fps : 0; }
  dispose() { this.holder.removeFromParent(); this.shadow.removeFromParent(); }
}

function blobShadow() {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128;
  const g = cv.getContext('2d'); const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, 'rgba(40,30,20,0.42)'); gr.addColorStop(0.55, 'rgba(40,30,20,0.18)'); gr.addColorStop(1, 'rgba(40,30,20,0)');
  g.fillStyle = gr; g.fillRect(0, 0, 128, 128);
  const t = new THREE.CanvasTexture(cv);
  const m = new THREE.Mesh(new THREE.PlaneGeometry(0.9, 0.6), new THREE.MeshBasicMaterial({ map: t, transparent: true, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.01; m.renderOrder = 1;
  return m;
}
