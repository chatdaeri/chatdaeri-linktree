// Hana: 3D 모델(GLB)과 동작 클립, 팔 2관절 IK. 모델이 없으면 단순 도형 자리표시로 움직인다.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clamp, damp, angleDiff } from './util.js';
import { SpriteBody } from './sprite.js';

const BONES = {
  hips: ['Hips', 'mixamorig:Hips'], spine: ['Spine02', 'Spine', 'mixamorig:Spine2'], head: ['Head', 'mixamorig:Head'],
  lArm: ['LeftArm', 'mixamorig:LeftArm'], lFore: ['LeftForeArm', 'mixamorig:LeftForeArm'], lHand: ['LeftHand', 'mixamorig:LeftHand'],
  rArm: ['RightArm', 'mixamorig:RightArm'], rFore: ['RightForeArm', 'mixamorig:RightForeArm'], rHand: ['RightHand', 'mixamorig:RightHand'],
};
const LOOP = new Set(['idle', 'walk', 'fast', 'sitIdle']);

export class Hana {
  constructor(scene, config) {
    this.scene = scene; this.config = config;
    this.root = new THREE.Group(); scene.add(this.root);
    this.body = new THREE.Group(); this.root.add(this.body);
    this.heading = 0; this.speed = 0; this.state = 'idle';
    this.ik = { l: { w: 0, target: new THREE.Vector3(), want: 0 }, r: { w: 0, target: new THREE.Vector3(), want: 0 } };
    this.idleTime = 0; this.oneShot = null;
    this.ring = makeRing(); this.root.add(this.ring);
    this.held = null;
  }
  get position() { return this.root.position; }

  async load(onProgress = () => {}) {
    const cfg = this.config.hana;
    // 실사 스프라이트(기본). 없으면 3D 모델 → 자리표시 순으로 쓴다.
    if (cfg.mode !== '3d' && this.config.assets?.sprites) {
      try {
        const man = await (await fetch('assets/hana/sprites/manifest.json')).json();
        this.sprite = new SpriteBody(this.root, man, cfg);
        await this.sprite.preload(onProgress);
        this.kind = 'sprite';
        this.handDummy = new THREE.Object3D(); this.handDummy.position.set(0.24, 0.98, 0.16); this.root.add(this.handDummy);
        return this;
      } catch (e) { console.warn('스프라이트를 불러오지 못해 3D 모델을 씁니다:', e.message); }
    }
    const loader = new GLTFLoader();
    try {
      if (!this.config.assets?.hana) throw new Error('모델 없음');
      const base = await loader.loadAsync(`${cfg.model}`, e => e.total && onProgress(e.loaded / e.total));
      this.model = base.scene;
      // 키 맞추기
      const box = new THREE.Box3().setFromObject(this.model), size = new THREE.Vector3(); box.getSize(size);
      const k = cfg.height / size.y; this.model.scale.setScalar(k); this.model.position.y = -box.min.y * k;
      this.model.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = false; o.frustumCulled = false; if (o.material) o.material.envMapIntensity = 0.9; } });
      this.body.add(this.model);
      this.bones = {};
      for (const [k2, names] of Object.entries(BONES)) this.bones[k2] = names.map(n => this.model.getObjectByName(n)).find(Boolean) ?? null;
      this.mixer = new THREE.AnimationMixer(this.model);
      this.actions = {};
      const entries = Object.entries(this.config.assets?.clips ?? {});
      let done = 0;
      await Promise.all(entries.map(async ([name, url]) => {
        try {
          const g = await loader.loadAsync(`${url}`);
          const clip = g.animations[0];
          if (!clip) return;
          clip.name = name;
          stripRootMotion(clip);
          const a = this.mixer.clipAction(clip);
          if (!LOOP.has(name)) { a.setLoop(THREE.LoopOnce, 1); a.clampWhenFinished = true; }
          this.actions[name] = a;
        } catch (e) { console.warn('동작 불러오기 실패', name, e); }
        finally { onProgress(0.5 + 0.5 * (++done / entries.length)); }
      }));
      // 기본 GLB에 든 동작(보통 기본 자세)은 대기 동작이 없을 때만 쓴다
      if (!this.actions.idle && base.animations[0]) { const a = this.mixer.clipAction(base.animations[0]); this.actions.idle = a; }
      this.mixer.addEventListener('finished', e => this.onFinished(e.action));
      this.current = null;
      this.kind = 'glb';
      this.fadeTo('idle', 0);
    } catch (e) {
      console.warn('Hana 모델 대신 자리표시를 씁니다:', e.message);
      this.makePlaceholder();
      this.kind = 'placeholder';
    }
    return this;
  }

  makePlaceholder() {
    const skin = new THREE.MeshStandardMaterial({ color: 0xE9CDB8, roughness: 0.7 });
    const cloth = new THREE.MeshStandardMaterial({ color: 0xF3EEE4, roughness: 0.8 });
    const hair = new THREE.MeshStandardMaterial({ color: 0x1D1A18, roughness: 0.6 });
    const g = new THREE.Group();
    const mk = (geo, mat, x, y, z) => { const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.castShadow = true; return m; };
    const hips = new THREE.Group(); hips.position.y = 0.92; g.add(hips);
    hips.add(mk(new THREE.CapsuleGeometry(0.15, 0.42, 6, 14), cloth, 0, 0.3, 0));
    const head = new THREE.Group(); head.position.y = 0.72; hips.add(head);
    head.add(mk(new THREE.SphereGeometry(0.11, 20, 16), skin, 0, 0, 0.01));
    head.add(mk(new THREE.SphereGeometry(0.118, 20, 16, 0, Math.PI * 2, 0, Math.PI * 0.62), hair, 0, 0.012, -0.012));
    const hairBack = mk(new THREE.CapsuleGeometry(0.1, 0.42, 4, 10), hair, 0, -0.26, -0.07); head.add(hairBack);
    const legs = [], arms = [];
    for (const s of [-1, 1]) {
      const leg = new THREE.Group(); leg.position.set(s * 0.085, 0.02, 0); hips.add(leg);
      leg.add(mk(new THREE.CapsuleGeometry(0.065, 0.78, 4, 10), cloth, 0, -0.44, 0));
      leg.add(mk(new THREE.BoxGeometry(0.09, 0.05, 0.22), cloth, 0, -0.9, 0.04));
      legs.push(leg);
      const arm = new THREE.Group(); arm.position.set(s * 0.2, 0.55, 0); hips.add(arm);
      const upper = mk(new THREE.CapsuleGeometry(0.045, 0.24, 4, 10), cloth, 0, -0.14, 0); arm.add(upper);
      const fore = new THREE.Group(); fore.position.y = -0.29; arm.add(fore);
      fore.add(mk(new THREE.CapsuleGeometry(0.04, 0.22, 4, 10), cloth, 0, -0.13, 0));
      const hand = new THREE.Group(); hand.position.y = -0.28; fore.add(hand);
      hand.add(mk(new THREE.SphereGeometry(0.04, 10, 8), skin, 0, -0.02, 0));
      arms.push({ arm, fore, hand });
    }
    this.ph = { g, hips, head, legs, arms, phase: 0 };
    this.body.add(g);
    this.bones = { lArm: arms[0].arm, lFore: arms[0].fore, lHand: arms[0].hand, rArm: arms[1].arm, rFore: arms[1].fore, rHand: arms[1].hand, head };
  }

  // ---------- 동작 ----------
  fadeTo(name, dur = 0.25) {
    if (this.kind !== 'glb') { this.state = name; return; }
    const a = this.actions[name] ?? this.actions.idle;
    if (!a || this.current === a) return;
    a.reset(); a.enabled = true; a.setEffectiveWeight(1); a.setEffectiveTimeScale(1);
    if (this.current) a.crossFadeFrom(this.current, dur, false); else a.play();
    a.play();
    this.current = a; this.state = name;
  }
  // 한 번 재생(인사·꺼내기·앉기·일어서기). 끝나면 next로 넘어간다.
  playOnce(name, next = 'idle') {
    return new Promise(resolve => {
      if (this.kind === 'sprite') {
        if (name === 'wave' && this.camera) this.heading = Math.atan2(this.camera.position.x - this.position.x, this.camera.position.z - this.position.z);
        const dur = { wave: this.sprite.clipDuration('wave-front') || 1.6, sitDown: 0.45, standUp: 0.4, pickLow: 0.35, look: 0 }[name] ?? 0.5;
        this.state = name; this.oneShot = { name, next, resolve, t: 0, dur };
        return;
      }
      if (this.kind !== 'glb' || !this.actions[name]) {
        this.state = name; this.oneShot = { name, next, resolve, t: 0, dur: { wave: 1.6, pickLow: 1.4, sitDown: 1.3, standUp: 1.1 }[name] ?? 1 };
        return;
      }
      this.oneShot = { name, next, resolve };
      this.fadeTo(name, 0.2);
      const o = this.config.hana.clipOptions?.[name];
      if (o && this.current) { this.current.time = o.from ?? 0; this.current.setEffectiveTimeScale(o.speed ?? 1); }
    });
  }
  onFinished(action) {
    if (!this.oneShot || this.actions[this.oneShot.name] !== action) return;
    const { next, resolve } = this.oneShot; this.oneShot = null;
    this.fadeTo(next, 0.25); resolve();
  }
  get busy() { return !!this.oneShot; }
  get seated() { return this.state === 'sitIdle' || this.state === 'sitDown'; }

  // speed m/s, dir = 이동 방향(라디안, 세계 기준)
  move(speed, dirAngle, dt, turnSeconds) {
    this.speed = speed;
    if (speed > 0.05) {
      const t = 1 - Math.exp(-dt / Math.max(0.02, turnSeconds / 3));
      this.heading += angleDiff(this.heading, dirAngle) * t;
    }
  }
  face(angle, dt, rate = 10) { this.heading += angleDiff(this.heading, angle) * (1 - Math.exp(-rate * dt)); }

  // 팔 IK: side 'l' | 'r', target 세계 좌표, want 0~1
  reach(side, target, want = 1) { this.ik[side].want = want; if (target) this.ik[side].target.copy(target); }
  release() { this.ik.l.want = 0; this.ik.r.want = 0; }

  update(dt, cfg) {
    this.root.rotation.y = this.heading;
    // 걷기 상태
    if (!this.oneShot && !this.seated) {
      const s = this.speed;
      const want = s > (cfg.walk + cfg.fast) / 2 ? 'fast' : s > 0.15 ? 'walk' : 'idle';
      if (want === 'idle') this.idleTime += dt; else this.idleTime = 0;
      if (want === 'idle' && this.idleTime > 9 && this.actions?.look && this.kind === 'glb') { // 스프라이트는 대기 클립이 이미 숨쉬기를 담고 있다
        this.idleTime = -6; this.playOnce('look', 'idle');
      } else if (this.state !== want && !(this.state === 'look' && want === 'idle')) this.fadeTo(want, 0.22);
      if (this.kind === 'glb' && this.current && (want === 'walk' || want === 'fast')) {
        // 발 미끄러짐을 줄이려 걸음 속도에 맞춰 재생 속도 조절
        const base = want === 'fast' ? cfg.fast : cfg.walk;
        this.current.setEffectiveTimeScale(clamp(s / base, 0.6, 1.5));
      }
    }
    if (this.mixer) this.mixer.update(dt);
    if (this.ph) this.updatePlaceholder(dt, cfg);
    if (this.kind === 'sprite') {
      const o = this.oneShot;
      if (o) { o.t += dt; if (o.t >= o.dur) { this.oneShot = null; this.state = o.next; o.resolve(); } }
      if (this.camera) this.sprite.update(dt, this, this.camera);
    }
    this.root.updateMatrixWorld(true);
    // IK
    for (const side of ['l', 'r']) {
      const k = this.ik[side];
      k.w = damp(k.w, k.want, 9, dt);
      if (k.w < 0.01) continue;
      const B = this.bones;
      if (!B) continue;
      const [a, b, c] = side === 'l' ? [B.lArm, B.lFore, B.lHand] : [B.rArm, B.rFore, B.rHand];
      if (a && b && c) twoBoneIK(a, b, c, k.target, this.poleFor(side), k.w);
    }
    if (this.held) this.updateHeld(dt);
    // 발밑 원
    this.ring.material.opacity = damp(this.ring.material.opacity, this.seated ? 0 : 0.55, 6, dt);
  }
  poleFor(side) {
    const s = side === 'l' ? 1 : -1;
    // 팔꿈치는 바깥·아래·뒤쪽
    return new THREE.Vector3(s * 0.6, -0.6, -0.5).applyQuaternion(this.root.quaternion).normalize();
  }
  hand(side = 'r') { if (this.handDummy) return this.handDummy; const b = side === 'l' ? this.bones?.lHand : this.bones?.rHand; return b ?? this.root; }
  chestPoint(forward = 0.32, up = 1.18) {
    const f = new THREE.Vector3(Math.sin(this.heading), 0, Math.cos(this.heading));
    return this.root.position.clone().add(f.multiplyScalar(forward)).add(new THREE.Vector3(0, up, 0));
  }

  // 책을 들고 있기: mode 'hand'(한 손) | 'read'(두 손으로 펼쳐 보기)
  hold(obj, mode = 'hand') { this.held = { obj, mode }; }
  drop() { const o = this.held?.obj; this.held = null; this.release(); return o; }
  updateHeld() {
    const { obj, mode } = this.held;
    if (mode === 'hand') {
      const p = new THREE.Vector3(); this.hand('r').getWorldPosition(p);
      obj.position.lerp(p, 0.6);
      obj.quaternion.slerp(this.root.quaternion, 0.3);
      return;
    }
    // 스프라이트로 앉아 읽을 때는 그림 안에 책이 있으므로 따로 그리지 않는다
    obj.visible = !(this.kind === 'sprite' && this.seated);
    const seatedUp = this.seated ? 0.72 : 1.16, fwd = this.seated ? 0.36 : 0.3;
    const c = this.chestPoint(fwd, seatedUp);
    obj.position.lerp(c, 0.25);
    const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.75, this.heading + Math.PI, 0, 'YXZ'));
    obj.quaternion.slerp(q, 0.25);
    const side = new THREE.Vector3(Math.cos(this.heading), 0, -Math.sin(this.heading));
    const w = (obj.userData.halfWidth ?? 0.16);
    this.reach('l', c.clone().addScaledVector(side, w), 1);
    this.reach('r', c.clone().addScaledVector(side, -w), 1);
  }

  updatePlaceholder(dt) {
    const p = this.ph, s = this.speed;
    p.phase += dt * (2 + s * 5);
    const swing = Math.min(1, s / 1.6) * 0.5;
    p.legs[0].rotation.x = Math.sin(p.phase) * swing; p.legs[1].rotation.x = -Math.sin(p.phase) * swing;
    p.hips.position.y = 0.92 + Math.abs(Math.cos(p.phase)) * 0.025 * Math.min(1, s);
    for (const [i, a] of p.arms.entries()) { if (this.ik[i ? 'r' : 'l'].w < 0.05) { a.arm.rotation.set(-Math.sin(p.phase) * swing * (i ? -1 : 1), 0, (i ? -1 : 1) * 0.12); a.fore.rotation.set(-0.15, 0, 0); } }
    if (this.oneShot) {
      const o = this.oneShot; o.t += dt;
      if (o.name === 'wave') { const a = p.arms[1]; a.arm.rotation.set(0, 0, -2.6 + Math.sin(o.t * 9) * 0.25); }
      if (o.name === 'sitDown') p.hips.position.y = 0.92 - 0.42 * Math.min(1, o.t / o.dur);
      if (o.name === 'standUp') p.hips.position.y = 0.5 + 0.42 * Math.min(1, o.t / o.dur);
      if (o.name === 'pickLow') p.hips.rotation.x = Math.sin(Math.min(1, o.t / o.dur) * Math.PI) * 0.5;
      if (o.t >= o.dur) { const { next, resolve } = o; this.oneShot = null; this.state = next; if (next !== 'sitIdle') p.hips.position.y = 0.92; p.hips.rotation.x = 0; resolve(); }
    } else if (this.state === 'sitIdle') {
      p.hips.position.y = 0.5; p.legs.forEach(l => { l.rotation.x = -1.45; });
    }
  }
}

// 앞으로 나가는 움직임(뿌리 이동)을 지워 제자리 동작으로 만든다. 높이(y)는 둔다.
function stripRootMotion(clip) {
  // 리그마다 뼈 길이가 1~2cm 다르므로 회전만 옮긴다(엉덩이 위치는 높이만 남김). 크기 트랙은 뺀다.
  clip.tracks = clip.tracks.filter(t => !/\.scale$/.test(t.name) && (!/\.position$/.test(t.name) || /(^|\.|:)Hips\.position$/.test(t.name)));
  for (const t of clip.tracks) {
    if (!/(^|\.|:)Hips\.position$/.test(t.name)) continue;
    const v = t.values, x0 = v[0], z0 = v[2];
    for (let i = 0; i < v.length; i += 3) { v[i] = x0; v[i + 2] = z0; }
  }
}

// 2관절 IK(Holden 방식): a=위팔, b=아래팔, c=손. 월드 목표 t, 팔꿈치 방향 pole, 가중치 w
const _a = new THREE.Vector3(), _b = new THREE.Vector3(), _c = new THREE.Vector3(), _t = new THREE.Vector3();
const _qa = new THREE.Quaternion(), _qb = new THREE.Quaternion(), _q = new THREE.Quaternion();
function twoBoneIK(A, B, C, target, pole, w) {
  A.getWorldPosition(_a); B.getWorldPosition(_b); C.getWorldPosition(_c); _t.copy(target);
  const eps = 1e-4;
  const lab = _b.distanceTo(_a), lcb = _c.distanceTo(_b);
  const lat = clamp(_t.distanceTo(_a), eps, lab + lcb - eps);
  const ac = _c.clone().sub(_a).normalize(), ab = _b.clone().sub(_a).normalize();
  const ba = _a.clone().sub(_b).normalize(), bc = _c.clone().sub(_b).normalize();
  const at = _t.clone().sub(_a).normalize();
  const acab0 = Math.acos(clamp(ac.dot(ab), -1, 1));
  const babc0 = Math.acos(clamp(ba.dot(bc), -1, 1));
  const acat0 = Math.acos(clamp(ac.dot(at), -1, 1));
  const acab1 = Math.acos(clamp((lcb * lcb - lab * lab - lat * lat) / (-2 * lab * lat), -1, 1));
  const babc1 = Math.acos(clamp((lat * lat - lab * lab - lcb * lcb) / (-2 * lab * lcb), -1, 1));
  let axis0 = new THREE.Vector3().crossVectors(ac, pole);
  if (axis0.lengthSq() < 1e-8) axis0 = new THREE.Vector3().crossVectors(ac, ab);
  axis0.normalize();
  let axis1 = new THREE.Vector3().crossVectors(ac, at);
  if (axis1.lengthSq() < 1e-8) axis1.copy(axis0); else axis1.normalize();
  A.getWorldQuaternion(_qa); B.getWorldQuaternion(_qb);
  const invA = _qa.clone().invert(), invB = _qb.clone().invert();
  const r0 = new THREE.Quaternion().setFromAxisAngle(axis0.clone().applyQuaternion(invA), acab1 - acab0);
  const r1 = new THREE.Quaternion().setFromAxisAngle(axis0.clone().applyQuaternion(invB), babc1 - babc0);
  const r2 = new THREE.Quaternion().setFromAxisAngle(axis1.clone().applyQuaternion(invA), acat0);
  const qa0 = A.quaternion.clone(), qb0 = B.quaternion.clone();
  A.quaternion.multiply(_q.copy(r0).multiply(r2));
  B.quaternion.multiply(r1);
  if (w < 0.999) { A.quaternion.copy(qa0.slerp(A.quaternion, w)); B.quaternion.copy(qb0.slerp(B.quaternion, w)); }
  A.updateMatrixWorld(true);
}

function makeRing() {
  const m = new THREE.Mesh(new THREE.RingGeometry(0.34, 0.42, 48), new THREE.MeshBasicMaterial({ color: 0xFF7E5F, transparent: true, opacity: 0.55, depthWrite: false }));
  m.rotation.x = -Math.PI / 2; m.position.y = 0.012; m.renderOrder = 2;
  return m;
}
