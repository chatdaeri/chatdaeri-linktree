// 평면도 투어 본체: scene.json → 집·가구·Hana, 따라가기/위에서 보기 카메라, 바닥 클릭 이동, 자동 투어, 방 목록·미니맵
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { loadLook, viewEnvironment, viewBackdrop, Post } from './look.js';
import { House } from './house.js';
import { Furniture } from './furniture.js';
import { Nav } from './nav.js';
import { SpriteBody } from './sprite.js';

const $ = s => document.querySelector(s);
const damp = (a, b, k, dt) => a + (b - a) * (1 - Math.exp(-k * dt));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };

class Tour {
  async boot() {
    const bar = $('#load i'), txt = $('#load p');
    const step = (p, t) => { bar.style.width = `${Math.round(p * 100)}%`; if (t) txt.textContent = t; };
    step(0.05, '평면도를 읽는 중');
    const S = this.S = await (await fetch('scene.json')).json();
    document.title = `${S.name} · 3D 투어`;
    $('#title').textContent = S.name;
    const total = S.rooms.reduce((n, r) => n + (r.stated ?? r.area), 0);
    $('#sub').textContent = `${S.rooms.filter(r => r.type === 'bedroom').length}룸 · 실내 ${total.toFixed(1)}㎡`;
    // 렌더러
    const R = this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    R.setPixelRatio(Math.min(2, devicePixelRatio)); R.outputColorSpace = THREE.SRGBColorSpace;
    R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = 1.08;
    R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFSoftShadowMap;
    $('#stage').append(R.domElement);
    this.scene = new THREE.Scene(); this.scene.background = new THREE.Color(0xECE8DE);
    this.camera = new THREE.PerspectiveCamera(60, 1, 0.05, 300);
    step(0.15, '재질을 불러오는 중');
    await loadLook(R, S.view);
    this.scene.environment = viewEnvironment(R); this.scene.environmentIntensity = 1.0;
    const [W, D] = S.size, C = { x: W / 2, z: D / 2 };
    this.backdrop = viewBackdrop(C, Math.max(W, D) / 2 + 16, -4); this.scene.add(this.backdrop); // 창밖(따라가기에서만)
    step(0.35, '벽을 세우는 중');
    this.house = new House(this.scene, S).build();
    this.lights(S);
    step(0.5, '가구를 들이는 중');
    this.furn = await new Furniture(this.scene, S).build();
    // 카메라가 멈출 것: 벽 + 열린 문짝 + 1m 넘는 가구(장·냉장고·TV·상부장 등)
    this.blockers = [...this.house.walls, ...this.house.doors.flatMap(d => d.children), ...this.furn.group.children.filter(o => o.userData.h >= 1.0)];
    this.nav = new Nav(S.nav);
    step(0.75, 'Hana를 부르는 중');
    await this.makeHana();
    this.post = new Post(R, this.scene, this.camera);
    this.orbit = new OrbitControls(this.camera, R.domElement);
    this.orbit.enabled = false; this.orbit.enableDamping = true; this.orbit.target.set(C.x, 0, C.z);
    this.orbit.minPolarAngle = 0.15; this.orbit.maxPolarAngle = 1.25; this.orbit.minDistance = 4; this.orbit.maxDistance = Math.max(W, D) * 2.2;
    this.cam = { yaw: Math.PI, dist: 2.4, manualT: -10, pitch: 0.24 };
    this.mode = 'follow'; this.frameNo = 0;
    this.ui(); this.input();
    const [sx, sz] = this.nav.nearest(...S.start) ?? S.start;
    this.hana.position.set(sx, 0, sz);
    // 처음 방향: 가장 넓은 방 쪽
    const big = [...S.rooms].sort((a, b) => b.area - a.area)[0];
    if (big) this.hana.heading = this.cam.yaw = Math.atan2(big.center[0] - sx, big.center[1] - sz);
    this.onResize(); addEventListener('resize', () => this.onResize());
    this.clock = new THREE.Timer(); this.clock.connect?.(document);
    R.setAnimationLoop(() => this.loop());
    step(1, '준비됨');
    setTimeout(() => $('#load').classList.add('done'), 200);
    setTimeout(() => { $('#load').hidden = true; }, 900);
    window.tour = this;
  }

  lights(S) {
    const [W, D] = S.size, C = new THREE.Vector3(W / 2, 0, D / 2);
    this.scene.add(new THREE.HemisphereLight(0xFFFFFF, 0xE6E0D4, 0.95)); // 흰 벽이 회색으로 가라앉지 않게 고른 하늘빛
    // 해: 가장 넓은 바깥 유리(미닫이·창) 쪽에서 비스듬히
    let best = null;
    for (const o of S.openings) if (o.exterior && (o.type === 'slide' || o.type === 'window')) { const L = Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) * (o.type === 'slide' ? 2 : 1); if (!best || L > best.L) best = { o, L }; }
    let dir = new THREE.Vector3(0.35, 0.62, 0.7);
    if (best) { const m = [(best.o.a[0] + best.o.b[0]) / 2 - C.x, (best.o.a[1] + best.o.b[1]) / 2 - C.z]; const l = Math.hypot(...m) || 1; dir = new THREE.Vector3(m[0] / l * 0.75 + 0.25, 0.6, m[1] / l * 0.75 + 0.1); }
    dir.normalize();
    const sun = this.sun = new THREE.DirectionalLight(0xFFE8CC, 3.2);
    sun.position.copy(C).addScaledVector(dir, 30); sun.target.position.copy(C);
    sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.03; sun.shadow.radius = 4;
    const r = Math.max(W, D) * 0.8; Object.assign(sun.shadow.camera, { left: -r, right: r, top: r, bottom: -r, near: 1, far: 70 }); sun.shadow.camera.updateProjectionMatrix();
    this.scene.add(sun, sun.target);
    const fill = new THREE.DirectionalLight(0xFFF6EC, 0.35); fill.position.set(C.x - 3, 10, C.z - 4); fill.target.position.copy(C); this.scene.add(fill, fill.target);
  }

  async makeHana() {
    const root = new THREE.Group(); this.scene.add(root);
    const man = await (await fetch('assets/hana/sprites/manifest.json')).json();
    this.sprite = new SpriteBody(root, man, { height: 1.62 });
    await this.sprite.preload();
    this.hana = { root, get position() { return root.position; }, heading: 0, speed: 0, state: 'idle' };
  }

  // ---------- 입력 ----------
  input() {
    const el = this.renderer.domElement;
    this.keys = new Set();
    addEventListener('keydown', e => { if (e.target.closest?.('button')) return; this.keys.add(e.code); if (/^(Arrow|Key[WASD])/.test(e.code)) { this.stopTour(); this.path = null; e.preventDefault(); } });
    addEventListener('keyup', e => this.keys.delete(e.code));
    let down = null;
    el.addEventListener('pointerdown', e => { down = { x: e.clientX, y: e.clientY, yaw: this.cam.yaw, pitch: this.cam.pitch, moved: false }; });
    addEventListener('pointermove', e => {
      if (!down || this.mode !== 'follow') return;
      const dx = e.clientX - down.x, dy = e.clientY - down.y;
      if (Math.hypot(dx, dy) > 4) down.moved = true;
      if (down.moved) { this.cam.yaw = down.yaw - dx * 0.006; this.cam.pitch = Math.max(-0.1, Math.min(0.75, down.pitch + dy * 0.004)); this.cam.manualT = this.t; }
    });
    addEventListener('pointerup', e => {
      if (down && !down.moved && Math.hypot(e.clientX - down.x, e.clientY - down.y) < 5 && e.target === el) this.clickFloor(e);
      down = null;
    });
    el.addEventListener('wheel', e => { if (this.mode === 'follow') { this.cam.dist = Math.max(1.2, Math.min(4.5, this.cam.dist + e.deltaY * 0.002)); e.preventDefault(); } }, { passive: false });
  }
  clickFloor(e) {
    const r = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    const ray = new THREE.Raycaster(); ray.setFromCamera(ndc, this.camera);
    const hit = ray.intersectObjects(this.house.floors, false)[0];
    if (!hit) return;
    this.stopTour();
    this.walkTo(hit.point.x, hit.point.z);
    this.marker(hit.point.x, hit.point.z);
  }
  walkTo(x, z, then) {
    const P = this.hana.position;
    const pts = this.nav.find(P.x, P.z, x, z);
    this.path = pts ? pts.slice(1) : null; this.pathThen = then ?? null;
    if (!pts && then) then();
  }
  marker(x, z) {
    if (!this.mk) { this.mk = new THREE.Mesh(new THREE.RingGeometry(0.16, 0.22, 40).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0xFF7E5F, transparent: true, opacity: 0.9, depthWrite: false })); this.mk.userData.noAO = true; this.scene.add(this.mk); }
    this.mk.position.set(x, 0.02, z); this.mk.material.opacity = 0.9;
  }

  // ---------- 자동 투어 ----------
  startTour() {
    this.touring = true; this.tourIdx = -1; $('#btn-tour').textContent = '투어 멈춤'; $('#btn-tour').classList.add('on');
    if (this.mode !== 'follow') this.setMode('follow');
    this.nextStop();
  }
  stopTour() { if (!this.touring) return; this.touring = false; clearTimeout(this.tourTimer); $('#btn-tour').textContent = '투어 시작'; $('#btn-tour').classList.remove('on'); }
  nextStop() {
    if (!this.touring) return;
    const names = this.S.tour.length ? this.S.tour : this.S.rooms.map(r => r.name);
    this.tourIdx++;
    if (this.tourIdx >= names.length) { this.stopTour(); this.caption('투어를 마쳤습니다', '방 목록에서 다시 골라 보세요'); return; }
    const room = this.S.rooms.find(r => r.name === names[this.tourIdx]);
    if (!room) { this.nextStop(); return; }
    this.goRoom(room, () => { this.tourTimer = setTimeout(() => this.nextStop(), 2600); });
  }
  // 방 둘러보기 자리: 넓은 방 = 가운데(문에서 들어온 방향으로 본다), 5㎡ 미만 작은 방 = 문 앞에서 안을 본다
  goRoom(room, then) {
    const P = this.hana.position, doors = room.doors ?? [];
    const door = [...doors].sort((a, b) => (a.type === 'door' ? 0 : 1) - (b.type === 'door' ? 0 : 1) || Math.hypot(a.at[0] - P.x, a.at[1] - P.z) - Math.hypot(b.at[0] - P.x, b.at[1] - P.z))[0];
    let tx = room.center[0], tz = room.center[1], yaw = null;
    if (door) {
      if (room.area < 5) { tx = door.at[0] - door.in[0] * 0.35; tz = door.at[1] - door.in[1] * 0.35; yaw = Math.atan2(door.in[0], door.in[1]); }
      else yaw = Math.atan2(tx - door.at[0], tz - door.at[1]);
    }
    this.walkTo(tx, tz, () => {
      if (yaw != null) { this.hana.heading = yaw; this.turnTo = yaw; }
      this.startShot(room); then?.();
    });
  }

  // ---------- 매 프레임 ----------
  loop() {
    this.clock.update(); const dt = Math.min(0.05, this.clock.getDelta()); this.t = this.clock.getElapsed();
    const H = this.hana, P = H.position;
    let vx = 0, vz = 0, speed = 0;
    // 방향키(카메라 기준)
    let f = 0, s = 0;
    for (const k of this.keys) { if (k === 'KeyW' || k === 'ArrowUp') f++; if (k === 'KeyS' || k === 'ArrowDown') f--; if (k === 'KeyA' || k === 'ArrowLeft') s--; if (k === 'KeyD' || k === 'ArrowRight') s++; }
    const yaw = this.mode === 'follow' ? this.cam.yaw : Math.atan2(this.orbit.target.x - this.camera.position.x, this.orbit.target.z - this.camera.position.z);
    if (f || s) {
      const run = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      speed = run ? 2.2 : 1.15;
      vx = Math.sin(yaw) * f - Math.cos(yaw) * s; vz = Math.cos(yaw) * f + Math.sin(yaw) * s;
      const l = Math.hypot(vx, vz); vx /= l; vz /= l;
    } else if (this.path?.length) {
      const [tx, tz] = this.path[0], dx = tx - P.x, dz = tz - P.z, L = Math.hypot(dx, dz);
      if (L < 0.06) { this.path.shift(); if (!this.path.length) { this.path = null; const th = this.pathThen; this.pathThen = null; th?.(); } }
      else { speed = this.touring ? 1.0 : 1.15; vx = dx / L; vz = dz / L; }
    }
    if (speed) {
      const nx = P.x + vx * speed * dt, nz = P.z + vz * speed * dt;
      if (this.nav.walkable(nx, nz)) { P.x = nx; P.z = nz; }
      else if (this.nav.walkable(nx, P.z)) P.x = nx;
      else if (this.nav.walkable(P.x, nz)) P.z = nz;
      else speed = 0;
      const want = Math.atan2(vx, vz); H.heading += angDiff(H.heading, want) * (1 - Math.exp(-10 * dt));
    }
    H.speed = damp(H.speed, speed, 10, dt);
    H.state = H.speed > 0.15 ? 'walk' : 'idle';
    // 방 바뀜 → 자막
    const room = this.house.roomAt(P.x, P.z);
    if (room && room !== this.room) { this.room = room; this.caption(room.name, `${(room.stated ?? room.area).toFixed(1)}㎡`); this.markList(room); }
    this.updateCamera(dt, speed > 0);
    this.sprite.update(dt, H, this.camera);
    if (this.mk) { this.mk.material.opacity = Math.max(0, this.mk.material.opacity - dt * 0.8); this.mk.visible = this.mk.material.opacity > 0.01; }
    this.drawMini();
    if (this.post.enabled) this.post.render(dt); else this.renderer.render(this.scene, this.camera);
    this.perf(dt);
  }
  // 방 사진 구도: 방 모서리 중 Hana에서 가장 먼 곳, 천장 가까이에서 방 가운데를 넓게 본다(부동산 사진처럼)
  startShot(room) {
    if (this.mode !== 'follow') return;
    const P = this.hana.position, H = this.house.H, [cx, cz] = room.center;
    const inRoom = (x, z) => room.rects.some(([a, b, c, d]) => x >= a && x <= c && z >= b && z <= d);
    let best = null;
    for (const [a, b, c, d] of room.rects) for (const [x, z] of [[a, b], [c, b], [a, d], [c, d]]) {
      const l = Math.hypot(cx - x, cz - z) || 1, px = x + (cx - x) / l * 0.3, pz = z + (cz - z) / l * 0.3;
      if (!inRoom(px, pz)) continue;
      const score = Math.hypot(px - P.x, pz - P.z);
      if (!best || score > best.s) best = { s: score, x: px, z: pz };
    }
    if (!best || best.s < 1.2) return; // 너무 좁으면 따라가기 그대로
    const look = new THREE.Vector3((P.x + cx) / 2, 0.85, (P.z + cz) / 2);
    this.shot = { t: 0, from: this.camera.position.clone(), fromLook: this._look?.clone() ?? look.clone(), pos: new THREE.Vector3(best.x, H - 0.22, best.z), look };
  }
  updateCamera(dt, moving) {
    const P = this.hana.position, cam = this.camera;
    if (this.mode === 'dollhouse') { this.orbit.update(); return; }
    const c = this.cam;
    if (this.shot) {
      if (moving || this.t - c.manualT < 0.2) { this.shot = null; c.distNow = null; this.blend = { from: cam.position.clone(), look: this._look.clone(), t: 0 }; }
      else {
        const s = this.shot; s.t = Math.min(1, s.t + dt / 1.1); const k = s.t * s.t * (3 - 2 * s.t);
        cam.position.lerpVectors(s.from, s.pos, k);
        this._look = new THREE.Vector3().lerpVectors(s.fromLook, s.look, k);
        cam.fov = damp(cam.fov, 72, 4, dt); cam.updateProjectionMatrix();
        cam.lookAt(this._look);
        return;
      }
    }
    if (moving && this.t - c.manualT > 1.5) c.yaw += angDiff(c.yaw, this.hana.heading) * (1 - Math.exp(-2.2 * dt));
    const T = new THREE.Vector3(P.x, 1.2, P.z);
    // 뒤가 막히면(1.3m 미만) 좌우 ±45° 안에서 더 트인 쪽으로 카메라를 천천히 돌린다(손으로 돌린 직후는 그대로)
    const free = yw => { const d = new THREE.Vector3(-Math.sin(yw), Math.tan(c.pitch), -Math.cos(yw)).normalize(); const h = new THREE.Raycaster(T, d, 0.05, c.dist + 0.3).intersectObjects(this.blockers, true)[0]; return h ? h.distance : c.dist + 0.3; };
    if (this.t - c.manualT > 1.5 && this.frameNo++ % 6 === 0) {
      const f0 = free(c.yaw);
      if (f0 < 1.3) { let best = c.yaw, bf = f0; for (const o of [0.35, -0.35, 0.7, -0.7]) { const f = free(c.yaw + o); if (f > bf + 0.25) { bf = f; best = c.yaw + o; } } c.yawGoal = best; }
      else c.yawGoal = null;
    }
    if (c.yawGoal != null) c.yaw += angDiff(c.yaw, c.yawGoal) * (1 - Math.exp(-2.5 * dt));
    const back = new THREE.Vector3(-Math.sin(c.yaw), 0, -Math.cos(c.yaw));
    let dist = c.dist;
    // 벽에 닿으면 그 앞에서 멈춘다(옆방으로 넘어가면 옆방 가구가 앞을 가린다). 가까워질수록 조금 더 내려다본다
    let dirv = back.clone().add(new THREE.Vector3(0, Math.tan(c.pitch), 0)).normalize();
    const ray = new THREE.Raycaster(T, dirv, 0.05, dist + 0.3);
    const hit = ray.intersectObjects(this.blockers, true)[0];
    if (hit) {
      dist = Math.max(0.55, hit.distance - 0.22);
      const extra = Math.max(0, (c.dist - dist) / c.dist) * 0.45;
      dirv = back.clone().add(new THREE.Vector3(0, Math.tan(c.pitch + extra), 0)).normalize();
    }
    c.distNow = damp(c.distNow ?? dist, dist, hit ? 20 : 4, dt);
    const pos = T.clone().addScaledVector(dirv, c.distNow);
    pos.y = Math.min(this.house.H - 0.12, pos.y);
    // 좁을수록 넓게 본다(60° → 75°)
    const want = 60 + Math.max(0, 1 - c.distNow / c.dist) * 15;
    if (Math.abs(cam.fov - want) > 0.1) { cam.fov = damp(cam.fov, want, 4, dt); cam.updateProjectionMatrix(); }
    this._look = new THREE.Vector3(T.x, T.y - 0.15, T.z);
    if (this.blend) { // 방 사진 구도에서 따라가기로 0.7초에 걸쳐 돌아온다
      const b = this.blend; b.t = Math.min(1, b.t + dt / 0.7); const k = b.t * b.t * (3 - 2 * b.t);
      pos.lerpVectors(b.from, pos, k); this._look.lerpVectors(b.look, this._look, k);
      if (b.t >= 1) this.blend = null;
    }
    cam.position.copy(pos); cam.lookAt(this._look);
  }
  setMode(m) {
    this.mode = m;
    const doll = m === 'dollhouse';
    this.house.ceilings.visible = !doll;
    this.backdrop.visible = !doll; // 위에서 볼 때는 모형처럼 밝은 바탕
    this.orbit.enabled = doll;
    $('#btn-view').textContent = doll ? '따라가기' : '위에서 보기';
    if (doll) {
      const [W, D] = this.S.size, R = Math.max(W, D);
      this.camera.position.set(W / 2 - R * 0.15, R * 1.05, D / 2 + R * 0.75); this.orbit.target.set(W / 2, 0, D / 2); this.orbit.update();
    }
  }

  // ---------- 화면 글자 ----------
  ui() {
    const list = $('#rooms');
    for (const r of this.S.rooms.filter(r => !r.auto)) {
      const b = document.createElement('button'); b.className = 'room';
      b.innerHTML = `<span>${r.name}</span><em>${(r.stated ?? r.area).toFixed(1)}㎡</em>`;
      b.onclick = () => { this.stopTour(); if (this.mode !== 'follow') this.setMode('follow'); this.goRoom(r); };
      b.dataset.name = r.name; list.append(b);
    }
    $('#btn-tour').onclick = () => (this.touring ? this.stopTour() : this.startTour());
    $('#btn-view').onclick = () => this.setMode(this.mode === 'follow' ? 'dollhouse' : 'follow');
    // 미니맵 = 원래 평면도
    const img = new Image(); img.src = this.S.plan.image; img.onload = () => { this.planImg = img; };
    const mini = $('#mini');
    mini.addEventListener('click', e => {
      if (!this.planImg) return;
      const r = mini.getBoundingClientRect(), k = this.miniK;
      const px = (e.clientX - r.left) * devicePixelRatio / k.s + k.ox, py = (e.clientY - r.top) * devicePixelRatio / k.s + k.oy;
      const x = (px - this.S.plan.origin[0]) / this.S.plan.ppm, z = (py - this.S.plan.origin[1]) / this.S.plan.ppm;
      this.stopTour(); this.walkTo(x, z); this.marker(x, z);
    });
  }
  markList(room) { for (const b of document.querySelectorAll('.room')) b.classList.toggle('here', b.dataset.name === room.name); }
  caption(title, sub) {
    const el = $('#caption'); el.querySelector('b').textContent = title; el.querySelector('span').textContent = sub ?? '';
    el.classList.remove('show'); void el.offsetWidth; el.classList.add('show');
  }
  drawMini() {
    const cv = $('#mini'); if (!this.planImg) return;
    const dpr = devicePixelRatio, W = cv.clientWidth * dpr, Hh = cv.clientHeight * dpr;
    if (cv.width !== W) { cv.width = W; cv.height = Hh; }
    const g = cv.getContext('2d'), S = this.S, pp = S.plan;
    // 건물 범위만 잘라 보여 준다
    const bw = S.size[0] * pp.ppm, bh = S.size[1] * pp.ppm, pad = 0.04 * Math.max(bw, bh);
    const s = Math.min(W / (bw + pad * 2), Hh / (bh + pad * 2));
    const ox = pp.origin[0] - pad - (W / s - bw - pad * 2) / 2, oy = pp.origin[1] - pad - (Hh / s - bh - pad * 2) / 2;
    this.miniK = { s, ox, oy };
    g.fillStyle = '#fff'; g.fillRect(0, 0, W, Hh);
    g.drawImage(this.planImg, ox, oy, W / s, Hh / s, 0, 0, W, Hh);
    const P = this.hana.position, x = (P.x * pp.ppm + pp.origin[0] - ox) * s, y = (P.z * pp.ppm + pp.origin[1] - oy) * s;
    const yaw = this.mode === 'follow' ? this.cam.yaw : this.hana.heading;
    g.fillStyle = 'rgba(255,126,95,0.28)'; g.beginPath(); g.moveTo(x, y); g.arc(x, y, 26 * dpr, Math.atan2(Math.cos(yaw), Math.sin(yaw)) - 0.6, Math.atan2(Math.cos(yaw), Math.sin(yaw)) + 0.6); g.closePath(); g.fill();
    g.fillStyle = '#FF7E5F'; g.beginPath(); g.arc(x, y, 5 * dpr, 0, Math.PI * 2); g.fill();
    g.strokeStyle = '#fff'; g.lineWidth = 2 * dpr; g.stroke();
  }
  onResize() {
    const el = $('#stage'), w = el.clientWidth, h = el.clientHeight;
    this.renderer.setSize(w, h, false); this.camera.aspect = w / Math.max(1, h); this.camera.updateProjectionMatrix();
    this.post?.setSize(w, h, Math.min(1.5, this.renderer.getPixelRatio()));
  }
  perf() { // 2초 평균 40fps 아래면 주변광 가림 → 빛 번짐 순으로 끈다
    const p = this._pf ??= { t: 0, n: 0, last: performance.now() };
    const now = performance.now(), gap = (now - p.last) / 1000; p.last = now;
    if (gap > 0.2 || document.hidden) { p.t = 0; p.n = 0; return; }
    p.t += gap; p.n++;
    if (p.t >= 2) { if (p.n / p.t < 40) { if (this.post.ao.enabled) this.post.ao.enabled = false; else this.post.bloom.enabled = false; } p.t = 0; p.n = 0; }
  }
}

new Tour().boot().catch(e => { console.error(e); const p = document.querySelector('#load p'); if (p) p.textContent = `불러오지 못했습니다: ${e.message}`; });
