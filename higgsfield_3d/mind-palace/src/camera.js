// 3인칭 카메라: Hana 뒤 4m·높이 2.2m·내려다보는 각 20°. 벽 충돌 보정, 가리는 벽 반투명, 서가 보기 전환.
import * as THREE from 'three';
import { clamp, damp, angleDiff, smooth } from './util.js';

export class FollowCam {
  constructor(camera, config, world) {
    this.cam = camera; this.cfg = config.camera; this.world = world;
    this.yaw = 0;             // 카메라가 바라보는 수평 방향(Hana heading과 같은 기준: 앞 = (sin, cos))
    this.dist = this.cfg.distance; this.distNow = this.dist;
    this.pitch = THREE.MathUtils.degToRad(this.cfg.pitchDeg);
    this.mode = 'follow';
    this.ray = new THREE.Raycaster();
    this.faded = new Set();
    this.lastManual = -10;
    this.look = new THREE.Vector3();
    this.pose = null; // 서가 보기 자리 { pos, look }
    this.trans = null;
  }
  rotate(d, t) { this.yaw += d; this.lastManual = t; }
  zoom(d) { this.dist = clamp(this.dist + d, this.cfg.min, this.cfg.max); }
  forward() { return new THREE.Vector3(Math.sin(this.yaw), 0, Math.cos(this.yaw)); }

  followTarget(hana) { return hana.position.clone().add(new THREE.Vector3(0, hana.seated ? 0.55 : 0.75, 0)); }
  desired(hana, dist = this.distNow) {
    const T = this.followTarget(hana);
    const h = Math.tan(this.pitch) * dist;
    return { pos: T.clone().add(new THREE.Vector3(-Math.sin(this.yaw) * dist, h, -Math.cos(this.yaw) * dist)), look: T };
  }
  // 서가 보기로(또는 다시 따라가기로) 0.6초 이동
  toPose(pose, dur = this.cfg.transition) {
    this.trans = { from: { pos: this.cam.position.clone(), look: this.look.clone() }, to: pose, t: 0, dur: Math.max(0.01, dur) };
    this.pose = pose; this.mode = pose ? 'pose' : 'follow';
  }
  toFollow(hana, dur = this.cfg.transition) {
    const d = this.desired(hana, this.dist);
    this.trans = { from: { pos: this.cam.position.clone(), look: this.look.clone() }, to: null, t: 0, dur: Math.max(0.01, dur), followTo: d };
    this.pose = null; this.mode = 'follow';
  }

  update(dt, hana, now, moving) {
    let pos, look;
    if (this.mode === 'follow') {
      // 걷는 동안에는 카메라가 천천히 Hana 뒤로 돈다(직접 돌린 직후는 제외)
      if (moving && now - this.lastManual > 1.5) {
        const d = angleDiff(this.yaw, hana.heading);
        if (Math.abs(d) < 1.75) this.yaw += d * (1 - Math.exp(-0.9 * dt));
      }
      // 벽 충돌: 2.5m보다 가까이 가지 않는다. 더 가까워야 하면 가리는 벽을 반투명으로 둔다.
      const T = this.followTarget(hana);
      const want = this.desired(hana, this.dist).pos;
      const dir = want.clone().sub(T); const L = dir.length(); dir.normalize();
      this.ray.set(T, dir); this.ray.far = L;
      const hit = this.ray.intersectObjects(this.world.colliders, false)[0];
      let target = this.dist;
      if (hit) target = clamp(hit.distance / L * this.dist - 0.3, this.cfg.min, this.dist);
      this.distNow = target < this.distNow ? damp(this.distNow, target, 14, dt) : damp(this.distNow, target, 2.5, dt);
      ({ pos, look } = this.desired(hana, this.distNow));
    } else {
      pos = this.pose.pos.clone(); look = this.pose.look.clone();
    }
    if (this.trans) {
      const tr = this.trans; tr.t += dt / tr.dur;
      const k = smooth(Math.min(1, tr.t));
      pos = tr.from.pos.clone().lerp(pos, k); look = tr.from.look.clone().lerp(look, k);
      if (tr.t >= 1) this.trans = null;
    }
    this.cam.position.copy(pos); this.look.copy(look); this.cam.lookAt(look);
    this.updateOcclusion(hana, dt);
  }

  // 카메라와 Hana 사이 벽을 반투명으로
  updateOcclusion(hana, dt) {
    const hits = new Set();
    if (this.mode === 'follow') {
      for (const up of [0.4, 1.2, 1.6]) {
        const p = hana.position.clone().add(new THREE.Vector3(0, up, 0));
        const dir = p.clone().sub(this.cam.position); const L = dir.length(); dir.normalize();
        this.ray.set(this.cam.position, dir); this.ray.far = L - 0.2;
        for (const h of this.ray.intersectObjects(this.world.occluders, false)) hits.add(h.object);
      }
    }
    for (const m of hits) { if (!this.faded.has(m)) { m.material.transparent = true; m.material.depthWrite = false; this.faded.add(m); } }
    for (const m of this.faded) {
      const want = hits.has(m) ? 0.18 : 1;
      m.material.opacity = damp(m.material.opacity, want, 10, dt);
      if (want === 1 && m.material.opacity > 0.98) { m.material.opacity = 1; m.material.transparent = false; m.material.depthWrite = true; this.faded.delete(m); }
    }
  }
}
