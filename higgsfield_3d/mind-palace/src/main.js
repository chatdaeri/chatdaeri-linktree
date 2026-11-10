// 마인드 팰리스 본체: 상태(탐험·서가 보기·꺼내기·책 카드·열람), 입력, 상호작용, 길안내, 튜토리얼, 오프닝
import * as THREE from 'three';
import { loadLook, forestEnvironment, Post } from './look.js';
import { World } from './world.js';
import { Shelves, LEVEL_Y, DEPTH, SHELF_H } from './shelves.js';
import { Hana } from './hana.js';
import { FollowCam } from './camera.js';
import { Reader } from './reader.js';
import { UI, Sound } from './ui.js';
import { PhotoMode } from './photo.js';
import { $, h, store, toast, post, clamp, damp, angleDiff, reducedMotion, isMobile, toWorld } from './util.js';

const MOVE_KEYS = { KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0], KeyA: [0, -1], ArrowLeft: [0, -1], KeyD: [0, 1], ArrowRight: [0, 1] };

class App {
  async boot() {
    this.loadingBar = $('#loading .bar i');
    this.progress(0.05, '데이터를 불러오는 중');
    const r = await fetch(window.PALACE_DATA ?? '/api/palace'); // 정적 공개판은 index.html이 PALACE_DATA를 정한다
    const { config, palace } = await r.json();
    this.config = config; this.palace = palace; this.layout = palace.layout;
    config.reduced = reducedMotion();
    $('#loading .loading-poster').style.backgroundImage = `url('${config.opening.poster}')`;
    await Promise.all([document.fonts.load('700 64px Pretendard'), document.fonts.load('500 40px Pretendard'), document.fonts.load('600 40px Pretendard')]);
    this.indexIds = new Map();
    for (const s of Object.values(palace.shelves)) this.indexIds.set(s.index, s.indexId);
    for (const rm of palace.rooms) this.indexIds.set(rm.guide, rm.guideId);
    this.byPath = new Map(); this.bookShelf = new Map();
    for (const s of Object.values(palace.shelves)) for (const b of s.books) { if (b.path && !this.byPath.has(b.path)) this.byPath.set(b.path, b); this.bookShelf.set(b.id, s); }

    // 렌더러
    const stage = $('#stage');
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 0.85;
    this.renderer.shadowMap.enabled = true; this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    stage.append(this.renderer.domElement);
    this.renderer.domElement.tabIndex = 0;
    this.scene = new THREE.Scene();
    // 실사 재질 사진·숲 배경을 먼저 불러 하늘 조명을 만든다
    this.progress(0.1, '재질을 불러오는 중');
    await loadLook(this.renderer);
    this.scene.background = new THREE.Color(0xEAE5D8);
    this.scene.fog = new THREE.Fog(0xE6E0D0, 70, 260);
    this.scene.environment = forestEnvironment(this.renderer);
    this.scene.environmentIntensity = 0.65;
    this.camera = new THREE.PerspectiveCamera(55, 1, 0.08, 400);
    this.post = new Post(this.renderer, this.scene, this.camera);

    this.progress(0.15, '건물을 짓는 중');
    this.world = new World(this.scene, { palace }, config);
    await this.world.build((p, t) => this.progress(0.15 + p * 0.4, t));
    this.progress(0.6, '서가에 책을 꽂는 중');
    this.shelves = new Shelves(this.world, config).build();
    this.progress(0.72, 'Hana를 깨우는 중');
    this.hana = await new Hana(this.scene, config).load(p => this.progress(0.72 + p * 0.22, 'Hana를 깨우는 중'));
    this.hana.camera = this.camera;
    this.cam = new FollowCam(this.camera, config, this.world);
    this.ui = new UI(this);
    this.reader = new Reader(this);
    this.sound = new Sound(config);
    this.world.onDoor = () => this.sound.play('door', 0.25);
    this.tutorial = new Tutorial(this);
    this.makeGuide();
    this.raycaster = new THREE.Raycaster();
    this.mode = 'explore';
    this.keys = new Set();
    this.path = null; this.autoFast = false; this.target = null;
    this.focus = null; this.hover = null; this.pulled = null; this.loose = null;
    this.tweens = [];
    this.labelPool = []; this.frameNo = 0; this.fps = { n: 0, t: 0, v: 0 };
    this.showFps = new URLSearchParams(location.search).has('fps');
    $('#fps').hidden = !this.showFps;
    this.setupInput();
    // 보기는 실사 재질 3D 하나(사진 모드는 config.view === 'photo'일 때만)
    this.view = config.photo && config.view === 'photo' ? 'photo' : '3d';
    if (this.view === 'photo') {
      this.progress(0.9, '사진 공간을 여는 중');
      this.photo = await new PhotoMode(this, config.photo).init(p => this.progress(0.9 + p * 0.09, '사진 공간을 여는 중'));
    }
    this.onResize();
    window.addEventListener('resize', () => this.onResize());

    // 시작 위치
    const saved = store.get('pos');
    const visited = store.get('visited', false);
    if (this.photo) this.photo.start();
    else if (saved && visited && this.world.nav.walkable(saved.x, saved.z)) this.placeHana(saved.x, saved.z, saved.heading, saved.yaw);
    else this.placeAtGate();
    this.progress(1, '준비됨');
    this.clock = new THREE.Timer(); this.clock.connect?.(document);
    this.renderer.setAnimationLoop(() => this.loop());
    await new Promise(r => setTimeout(r, 120));
    if (window.gsap) window.gsap.to('#loading', { autoAlpha: 0, duration: 0.6, ease: 'power2.out' }); else $('#loading').classList.add('done');
    window.__readyAt = performance.now(); // 조작 가능해진 시각(ms, 페이지 열린 뒤)
    setTimeout(() => { $('#loading').hidden = true; }, 600);
    // 모바일·동작 줄이기 → 2D 보기 기본
    if (isMobile() || config.reduced) { this.toggleList(true); return; }
    if (!visited) await this.playOpening(false);
    else this.focusGame();
  }
  progress(p, text) { if (this.loadingBar) this.loadingBar.style.width = `${Math.round(p * 100)}%`; if (text) $('#loading-text').textContent = text; }
  onResize() {
    const el = $('#game'); const w = el.clientWidth, hgt = el.clientHeight;
    if (!this.renderer) return;
    el.classList.toggle('narrow', w < 760);
    this.renderer.setSize(w, hgt, false);
    this.post?.setSize(w, hgt, Math.min(1.5, this.renderer.getPixelRatio())); // 후처리는 최대 1.5배 해상도
    this.camera.aspect = w / Math.max(1, hgt); this.camera.updateProjectionMatrix();
    this.photo?.resize();
  }
  focusGame() { if (this.photo?.active) { this.photo.focus(); return; } this.renderer?.domElement.focus({ preventScroll: true }); }
  bookByPath(p) { return this.byPath.get(p) ?? null; }

  placeHana(x, z, heading = Math.PI, yaw = heading) {
    this.hana.position.set(x, this.world.heightAt(x, z), z);
    this.hana.heading = heading; this.cam.yaw = yaw;
    this.cam.distNow = this.cam.dist;
    this.hana.update(0, this.config.movement);
    this.cam.update(0, this.hana, 0, false);
  }
  placeAtGate() { if (this.photo?.active) return this.photo.enter(this.config.photo.start ?? 'outside', 'default', { instant: true, walkIn: false }); const s = this.layout.spawn; this.placeHana(s.x, s.z, Math.PI, Math.PI); }
  startAtGate() { this.exitAll(); this.placeAtGate(); toast('정문 앞에서 시작합니다'); }

  // ---------- 오프닝 ----------
  async playOpening(replay) {
    const url = `${this.config.opening.video}`;
    const ok = !!this.config.assets?.video;
    const finish = async () => {
      store.set('visited', true);
      if (!replay) { await this.placeAtGate(); }
      if (this.cam.mode === 'pose') this.cam.toFollow(this.hana, this.config.opening.endCamera?.settle ?? 1.2);
      this.focusGame();
      if (!this.config.reduced) { if (this.photo?.active) this.photo.wave(); else this.hana.playOnce('wave', 'idle'); }
      this.tutorial.start();
    };
    if (!ok) { if (replay) toast('오프닝 영상이 아직 없습니다'); await finish(); return; }
    this.placeAtGate();
    // 영상 마지막 장면(Hana 뒤 눈높이)과 같은 구도로 카메라를 세워 두었다가, 영상이 사라지면 평소 자리로 내려온다
    const ec = this.config.opening.endCamera;
    if (ec) {
      const P = this.hana.position;
      this.cam.toPose({ pos: new THREE.Vector3(P.x, P.y + ec.height, P.z + ec.back), look: new THREE.Vector3(P.x, P.y + 1.35, P.z - 10) }, 0.01);
      this.step(1);
    }
    const box = $('#opening'), v = $('#opening-video'), title = box.querySelector('.opening-title');
    box.hidden = false; box.classList.remove('fade'); title.hidden = false; title.classList.remove('on');
    v.src = url; v.currentTime = 0;
    await new Promise(resolve => {
      let done = false;
      const end = () => { if (done) return; done = true; box.classList.add('fade'); setTimeout(() => { box.hidden = true; v.pause(); resolve(); }, this.config.opening.crossfade * 1000); };
      v.onended = end; v.onerror = end;
      $('#opening-skip').onclick = end;
      const onKey = e => { if (e.key === 'Escape' || e.key === 'Enter') { end(); window.removeEventListener('keydown', onKey, true); } };
      window.addEventListener('keydown', onKey, true);
      const o = this.config.opening;
      v.ontimeupdate = () => { const d = v.duration || 25; title.classList.toggle('on', v.currentTime > (o.titleFrom ?? d * 0.3) && v.currentTime < (o.titleTo ?? d * 0.62)); if (v.currentTime > d - o.crossfade) end(); };
      v.play().catch(end);
    });
    await finish();
  }

  // ---------- 입력 ----------
  setupInput() {
    const cv = this.renderer.domElement;
    window.addEventListener('keydown', e => this.onKey(e));
    window.addEventListener('keyup', e => { this.keys.delete(e.code); });
    window.addEventListener('blur', () => this.keys.clear());
    cv.addEventListener('contextmenu', e => e.preventDefault());
    let drag = null;
    cv.addEventListener('pointerdown', e => {
      cv.focus({ preventScroll: true });
      if (e.button === 2) { drag = { x: e.clientX }; cv.setPointerCapture(e.pointerId); return; }
      if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY, t: performance.now() };
    });
    cv.addEventListener('pointermove', e => {
      if (drag) { this.cam.rotate(-(e.clientX - drag.x) * 0.006, this.clock?.getElapsed?.() ?? 0); drag.x = e.clientX; return; }
      this.mouse = { x: e.clientX, y: e.clientY };
      if (this.mode === 'shelf') this.hoverShelf(e);
    });
    cv.addEventListener('pointerup', e => {
      if (drag && e.button === 2) { drag = null; return; }
      if (e.button === 0 && this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) < 6) this.onClick(e);
      this.downAt = null;
    });
    cv.addEventListener('pointerleave', () => { if (this.mode === 'shelf') this.setHover(null); });
    cv.addEventListener('wheel', e => { e.preventDefault(); if (this.mode === 'explore' || this.mode === 'read') this.cam.zoom(e.deltaY * 0.004); }, { passive: false });
    $('#card-layer').addEventListener('keydown', e => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); this.putBack(); } });
    $('#overlay').addEventListener('pointerdown', e => { if (e.target.id === 'overlay') this.ui.closeOverlay(); });
  }
  inPanel(el) { return el?.closest?.('#reader, #overlay, #card-layer, #list2d, #search-wrap, #menu'); }
  onKey(e) {
    const t = e.target;
    const typing = t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA' || t?.isContentEditable;
    if (e.key === 'Escape') {
      if (typing) return;
      e.preventDefault();
      if (this.ui.overlayOpen) return this.ui.closeOverlay();
      if (this.photo?.shelf.isOpen && this.photo.shelf.listOpen) return this.photo.shelf.toggleList(false);
      if (!$('#list2d').hidden && !this.reader.isOpen && !this.ui.cardOpen) return this.toggleList(false);
      if (this.ui.cardOpen) return this.putBack();
      if (this.reader.isOpen) return this.closeReader();
      if (this.mode === 'shelf') return this.exitShelf();
      if (this.guide.visible || this.photo?.guide) return this.clearGuide();
      return;
    }
    if (typing) return;
    const inPanel = this.inPanel(t);
    if (e.key === 'Tab' && !inPanel) { e.preventDefault(); return this.toggleList($('#list2d').hidden); }
    if (inPanel) return; // 패널이 포커스를 가진 동안 키는 패널로
    if (e.key === '/') { e.preventDefault(); return this.ui.openSearch(); }
    if (e.key === '?') { e.preventDefault(); return this.ui.showHelp(); }
    if (e.code === 'KeyM') { e.preventDefault(); return this.showPlan(); }
    if (this.mode === 'shelf') return this.photo?.active ? this.photo.shelf.key(e) : this.shelfKey(e);
    if (['KeyE', 'Enter', 'Space'].includes(e.code)) { e.preventDefault(); if (!e.repeat) this.interact(); return; }
    if (this.mode === 'card' || this.mode === 'pull') return;
    if (MOVE_KEYS[e.code] || e.code === 'BracketLeft' || e.code === 'BracketRight' || e.key === 'Shift') {
      if (MOVE_KEYS[e.code]) { e.preventDefault(); this.cancelAuto(); }
      this.keys.add(e.code);
    }
  }
  onClick(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    if (this.mode === 'shelf') { const rec = this.shelves.pick(this.raycaster, this.focus?.info.id); if (rec) { this.setFocus(rec); this.pull(); } return; }
    if (this.mode !== 'explore' && this.mode !== 'read') return;
    // 책·서가를 누르면 그 서가로
    const rec = this.shelves.pick(this.raycaster);
    if (rec && rec.info.kind === 'wall') { this.walkToShelf(rec.info, rec, false); return; }
    const hitF = this.raycaster.intersectObjects([this.shelves.frames, this.shelves.unitFrames], false)[0];
    if (hitF) { const info = this.shelves.frameOwner(hitF.object, hitF.instanceId); if (info?.kind === 'wall') { this.walkToShelf(info, null, false); return; } }
    // 바닥
    const floorY = this.hana.position.y;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -floorY);
    const p = new THREE.Vector3();
    if (!this.raycaster.ray.intersectPlane(plane, p)) return;
    // 바닥에서 가까운 안내도·방명록·책상
    const near = this.world.interactables.filter(it => it.x != null).map(it => ({ it, d: Math.hypot(it.x - p.x, it.z - p.z) })).sort((a, b) => a.d - b.d)[0];
    if (near && near.d < 1.0) { this.walkTo(near.it.x, near.it.z, { stopAt: 1.2, then: () => this.doInteract(near.it) }); return; }
    if (this.mode === 'read' && this.hana.seated) return;
    this.clickMarker(p);
    this.walkTo(p.x, p.z, {});
  }

  // ---------- 매 프레임 ----------
  tween(dur, fn) { return new Promise(res => { if (this.config.reduced || dur <= 0) { fn(1); res(); return; } this.tweens.push({ t: 0, dur, fn, res }); }); }
  runTweens(dt) { for (const tw of [...this.tweens]) { tw.t += dt; const k = Math.min(1, tw.t / tw.dur); tw.fn(k); if (k >= 1) { this.tweens.splice(this.tweens.indexOf(tw), 1); tw.res(); } } }
  // 디버그·검증용: 고정 시간 간격으로 n프레임 진행(창이 숨겨져 있어도 동작 확인 가능)
  step(n = 1, dt = 1 / 60) { for (let i = 0; i < n; i++) { this.simT = (this.simT ?? 0) + dt; this.loop(dt); } }
  loop(fixed) {
    let dt, now;
    if (fixed) { dt = fixed; now = this.simT; } else { this.clock.update(); dt = Math.min(0.05, this.clock.getDelta()); now = this.clock.getElapsed(); }
    if (this.photo?.active) {
      this.runTweens(dt);
      this.photo.update(dt);
      if (this.showFps) { this.fps.n++; this.fps.t += dt; if (this.fps.t > 0.5) { this.fps.v = this.fps.n / this.fps.t; this.fps.n = 0; this.fps.t = 0; $('#fps').textContent = `${this.fps.v.toFixed(0)} fps · 사진`; } }
      return;
    }
    const H = this.hana, M = this.config.movement;
    let moving = false;
    this.runTweens(dt);
    // 카메라 키
    if (this.keys.has('BracketLeft')) this.cam.rotate(1.6 * dt, now);
    if (this.keys.has('BracketRight')) this.cam.rotate(-1.6 * dt, now);
    // 걷기
    let speed = 0, dirA = H.heading;
    const canWalk = (this.mode === 'explore' || this.mode === 'read') && !H.busy;
    if (canWalk) {
      let f = 0, s = 0;
      for (const k of this.keys) if (MOVE_KEYS[k]) { f += MOVE_KEYS[k][0]; s += MOVE_KEYS[k][1]; }
      const fast = this.keys.has('ShiftLeft') || this.keys.has('ShiftRight');
      if (f || s) {
        if (H.seated) { this.standUpFromReading(); }
        else {
          const y = this.cam.yaw;
          const dx = Math.sin(y) * f + -Math.cos(y) * s, dz = Math.cos(y) * f + Math.sin(y) * s;
          dirA = Math.atan2(dx, dz); speed = fast ? M.fast : M.walk; moving = true;
          this.stepToward(dirA, speed, dt);
        }
      } else if (this.path) {
        const r = this.followPath(dt); speed = r.speed; dirA = r.dir; moving = speed > 0;
      }
    } else if (this.path && this.mode === 'shelf') {
      const r = this.followPath(dt); speed = r.speed; dirA = r.dir; moving = speed > 0;
    }
    H.move(speed, dirA, dt, M.turnSeconds);
    if (this.faceAngle != null && speed < 0.05) H.face(this.faceAngle, dt);
    H.position.y = damp(H.position.y, this.world.heightAt(H.position.x, H.position.z), 14, dt);
    H.update(dt, M);
    this.world.update(dt, H.position);
    const region = this.world.regionAt(H.position.x, H.position.z);
    const room = region.room ?? null;
    this.shelves.update(dt, room);
    this.cam.update(dt, H, now, moving);
    this.updateRegion(region);
    if (this.mode === 'explore' || this.mode === 'read') this.updatePrompt();
    else if (this.mode !== 'shelf') this.ui.setPrompt(null);
    this.updateGuide(dt);
    this.tutorial.update(region);
    if (++this.frameNo % 2 === 0) this.updateLabels();
    if (this.frameNo % 3 === 0) this.ui.drawMinimap(H.position, this.cam.yaw, room);
    if (this.frameNo % 120 === 0 && (this.mode === 'explore')) store.set('pos', { x: H.position.x, z: H.position.z, heading: H.heading, yaw: this.cam.yaw });
    // 서가 앞 클로즈업: 카메라 1.4m 안의 화분·의자 등 소품은 숨긴다(화면을 가리지 않게). 튜토리얼 알림도 서가에선 숨김
    const close = ['shelf', 'pull', 'card'].includes(this.mode) || this.reader?.isOpen;
    for (const p of this.world.props ?? []) p.visible = !close || p.position.distanceTo(this.camera.position) > 1.4;
    const tut = $('#tutorial'); if (tut && !tut.hidden) tut.style.visibility = this.mode === 'shelf' ? 'hidden' : '';
    if (this.post?.enabled) this.post.render(dt); else this.renderer.render(this.scene, this.camera);
    // 느린 컴퓨터: 2초 평균 40fps 아래면 주변광 가림 → 빛 번짐 순으로 끈다
    if (!fixed && this.post && !document.hidden) {
      const pf = this.perf ??= { t: 0, n: 0, last: performance.now() };
      const nowMs = performance.now(), gap = (nowMs - pf.last) / 1000; pf.last = nowMs;
      if (gap > 0.2) { pf.t = 0; pf.n = 0; } // 탭이 가려져 멈췄던 프레임은 세지 않는다
      else { pf.t += gap; pf.n++; }
      if (pf.t >= 2) { if (pf.n / pf.t < 40) { if (this.post.ao.enabled) this.post.ao.enabled = false; else this.post.bloom.enabled = false; } pf.t = 0; pf.n = 0; }
    }
    if (this.showFps) { this.fps.n++; this.fps.t += dt; if (this.fps.t > 0.5) { this.fps.v = this.fps.n / this.fps.t; this.fps.n = 0; this.fps.t = 0; $('#fps').textContent = `${this.fps.v.toFixed(0)} fps · ${this.renderer.info.render.calls} draw`; } }
  }
  stepToward(dirA, speed, dt) {
    const P = this.hana.position, nav = this.world.nav;
    const dx = Math.sin(dirA) * speed * dt, dz = Math.cos(dirA) * speed * dt;
    if (nav.walkable(P.x + dx, P.z + dz)) { P.x += dx; P.z += dz; return true; }
    if (nav.walkable(P.x + dx, P.z)) { P.x += dx; return true; }
    if (nav.walkable(P.x, P.z + dz)) { P.z += dz; return true; }
    return false;
  }
  followPath(dt) {
    const P = this.hana.position, M = this.config.movement;
    const pts = this.path.pts;
    while (pts.length && Math.hypot(pts[0].x - P.x, pts[0].z - P.z) < 0.18) pts.shift();
    const end = this.path.final;
    const remain = Math.hypot(end.x - P.x, end.z - P.z);
    if (!pts.length || remain < (this.path.stopAt ?? 0.15)) {
      const then = this.path.then; this.path = null; this.faceAngle = this.pathFace ?? null;
      if (then) then();
      return { speed: 0, dir: this.hana.heading };
    }
    const p = pts[0];
    const dir = Math.atan2(p.x - P.x, p.z - P.z);
    const speed = (this.path.fast ? M.fast : M.walk) * Math.min(1, remain / 0.6 + 0.35);
    // 방향을 먼저 돌린 뒤 걷는다
    const turn = Math.abs(angleDiff(this.hana.heading, dir));
    const s = turn > 1.2 ? speed * 0.25 : speed;
    if (!this.stepToward(dir, s, dt)) { this.path.stuck = (this.path.stuck ?? 0) + dt; if (this.path.stuck > 1.2) { this.path = null; } }
    return { speed: s, dir };
  }
  walkTo(x, z, { fast = false, stopAt = 0.15, then = null, face = null } = {}) {
    const P = this.hana.position;
    const pts = this.world.nav.findPath(P.x, P.z, x, z);
    if (!pts) { toast('그곳으로 가는 길을 찾지 못했습니다'); return false; }
    pts.shift();
    const last = pts.at(-1) ?? { x, z };
    this.path = { pts, final: last, fast, stopAt, then }; this.pathFace = face; this.faceAngle = null;
    return pts;
  }
  cancelAuto() { if (this.path) { this.path = null; } this.faceAngle = null; }

  updateRegion(region) {
    const key = `${region.kind}|${region.chamber?.id ?? ''}`;
    if (key === this.regionKey) return;
    this.regionKey = key;
    const parts = [{ text: this.config.copy.hall }];
    if (region.room) {
      const room = this.world.roomById.get(region.room), cfg = this.world.roomCfg.get(region.room);
      parts.push({ text: room.name, color: cfg.spine });
      const c = region.chamber;
      if (c.kind === 'alcove' || c.kind === 'stack' || c.kind === 'passage') parts.push({ text: c.label.replace(' · 안쪽 서고', ' 안쪽 서고').replace(' · 이동식 서가', ' 이동식 서가') });
    } else if (region.kind === 'outside') parts.splice(0, 1, { text: '정문 앞' });
    else if (region.kind === 'portico') parts.splice(0, 1, { text: '정문' });
    this.ui.setWhere(parts);
    // 그릴 방: 지금 방 + 입구가 가까운 방
    const P = this.hana.position, vis = new Set();
    if (region.room) vis.add(region.room);
    for (const c of this.layout.chambers.filter(c => c.kind === 'room')) {
      if (Math.hypot(c.x - P.x, c.z - P.z) < 20) vis.add(c.room);
    }
    this.shelves.setRoomsVisible(vis);
    if (region.room !== this.sunRoom) {
      this.sunRoom = region.room;
      const c = region.room ? this.world.chamberById.get(`c-${region.room}`) : null;
      if (c) { const m = toWorld(c, 0, c.d / 2); this.world.setSunFor({ x: m.x, z: m.z, r: Math.max(c.w, c.d) * 0.8 + 4 }); }
      else this.world.setSunFor({ x: P.x, z: P.z, r: 16 });
    }
  }
  // 그림자 영역이 Hana를 따라가게(넓은 콘텐츠 방 대비)
  // ---------- 상호작용 ----------
  nearestInteractable() {
    const P = this.hana.position, R = this.config.movement.interact;
    let best = null, bd = Infinity;
    for (const it of this.world.interactables) {
      let d;
      if (it.type === 'shelf') {
        const s = it.seg; const vx = s.bx - s.ax, vz = s.bz - s.az, L2 = vx * vx + vz * vz;
        const t = clamp(((P.x - s.ax) * vx + (P.z - s.az) * vz) / L2, 0, 1);
        const qx = s.ax + vx * t, qz = s.az + vz * t;
        // 서가 앞쪽에 있어야 한다
        const nx = -vz, nz = vx; // 서가 오른쪽 방향 기준 법선(서가 +z와 같은 쪽)
        const side = (P.x - qx) * nx + (P.z - qz) * nz;
        d = Math.hypot(P.x - qx, P.z - qz);
        if (side > 0.05 && Math.abs(side) > 0 && d > 0) { /* 앞쪽 */ } else d = Infinity;
        it._t = t;
      } else if (it.type === 'handle') {
        const info = this.shelves.byId.get(it.shelfId);
        const stack = this.shelves.stacks.get(it.stack), row = stack.rows[it.row];
        if (row.gap === it.slot + 1) {
          // 통로가 열린 칸: 통로 안에서 서가 보기
          const sp = this.shelves.standPoint(info, 0.6);
          const inAisle = Math.hypot(P.x - sp.x, P.z - sp.z);
          if (inAisle < 0.9) { d = inAisle; it._shelf = true; }
          else { d = Infinity; it._shelf = false; }
          if (!it._shelf) {
            const hp = new THREE.Vector3(-0.55, 0, 0).applyMatrix4(info.holder.matrixWorld);
            const dd = Math.hypot(P.x - hp.x, P.z - hp.z); if (dd < 1.1) { d = dd; it._shelf = false; it._open = true; }
          }
        } else {
          const hp = new THREE.Vector3(-0.55, 0, 0).applyMatrix4(info.holder.matrixWorld);
          d = Math.hypot(P.x - hp.x, P.z - hp.z); it._shelf = false; it._open = false;
          if (d > 1.1) d = Infinity;
        }
      } else d = Math.hypot(P.x - it.x, P.z - it.z) - (it.r - R);
      if (d < R && d < bd) { bd = d; best = it; }
    }
    return best;
  }
  updatePrompt() {
    const it = this.nearestInteractable();
    this.near = it;
    if (!it || (this.mode === 'read' && this.hana.seated)) { this.ui.setPrompt(null); return; }
    let label = it.label;
    if (it.type === 'handle') label = it._shelf ? this.config.copy.interactShelf : it._open ? '열린 통로로 들어가기' : `${this.config.copy.interactHandle}: ${this.shelves.byId.get(it.shelfId).s.label}`;
    if (it.type === 'shelf') { const s = this.shelves.byId.get(it.shelfId).s; label = `${label} · ${s.label || s.title}`; }
    this.ui.setPrompt(label);
    if (it.type === 'shelf' || (it.type === 'handle' && it._shelf)) this.tutorial.nearShelf(this.shelves.byId.get(it.shelfId));
  }
  interact() {
    if (this.photo?.active) return this.photo.interact();
    if (this.mode === 'read' && this.hana.seated) return;
    const it = this.near ?? this.nearestInteractable();
    if (it) this.doInteract(it);
  }
  doInteract(it) {
    switch (it.type) {
      case 'shelf': return this.enterShelf(this.shelves.byId.get(it.shelfId));
      case 'handle': {
        const info = this.shelves.byId.get(it.shelfId);
        if (it._shelf) return this.enterShelf(info);
        if (it._open) { const sp = this.shelves.standPoint(info, 0.6); this.walkTo(sp.x, sp.z, { then: () => this.enterShelf(info) }); return; }
        if (this.shelves.openAisle(it.stack, it.row, it.slot)) { this.sound.play('door', 0.2); toast(`${info.s.label} 칸 앞으로 통로를 엽니다`, 1400); }
        return;
      }
      case 'map': return this.showPlan();
      case 'guestbook': return this.ui.showGuestbook(this.palace.log);
      case 'skills': return this.ui.showSkills(it.room);
      default:
    }
  }
  showPlan() { if (this.mode === 'shelf') this.exitShelf(); this.ui.showPlan(this.photo?.active ? this.photo.planPos() : this.hana.position); }

  // ---------- 서가 보기 ----------
  enterShelf(info, focusRec = null, { glow = false } = {}) {
    if (!info) return;
    this.cancelAuto();
    this.mode = 'shelf'; this.shelfInfo = info;
    this.ui.setPrompt(null);
    const grid = this.shelves.grid(info);
    let rec = focusRec;
    if (!rec) {
      const along = this.alongShelf(info, this.hana.position);
      const level = grid[3].length ? 3 : [2, 4, 1, 5].find(l => grid[l].length);
      rec = level ? nearestX(grid[level], along) : null;
    }
    const actions = [];
    if (info.s.inner?.length) actions.push({ label: this.config.copy.innerStack, run: () => this.goInner(info) });
    this.ui.shelfBar(info, actions);
    if (!rec) { toast('이 서가에는 책이 없습니다'); }
    this.setFocus(rec, true);
    if (glow && rec) this.shelves.glowBook(rec);
    this.sound.play('pull', 0.12);
  }
  alongShelf(info, p) {
    const inv = new THREE.Matrix4().copy(info.holder.matrixWorld).invert();
    return new THREE.Vector3(p.x, 0, p.z).applyMatrix4(inv).x;
  }
  setFocus(rec, first = false) {
    if (this.focus && this.focus !== rec && this.focus !== this.pulled) this.shelves.setOffset(this.focus, 0);
    this.focus = rec;
    const info = this.shelfInfo;
    if (rec) this.shelves.setOffset(rec, 0.01);
    // 카메라: 서가 정면
    const x = rec ? rec.x : info.bays / 2;
    const y = rec ? LEVEL_Y[rec.level - 1] + 0.2 : 1.3;
    const zFace = info.kind === 'unit' ? 0.25 : DEPTH;
    const look = new THREE.Vector3(x, y, zFace).applyMatrix4(info.holder.matrixWorld);
    const n = this.shelves.shelfNormal(info);
    const dist = info.kind === 'unit' ? 0.85 : this.config.camera.shelfDistance;
    const pos = look.clone().addScaledVector(n, dist).add(new THREE.Vector3(0, 0.12, 0));
    this.cam.toPose({ pos, look }, first ? this.config.camera.transition : 0.22);
    // Hana는 카메라 뒤(화면 밖)에 서서 따라 걷는다. 카메라는 Hana에게서 가까워도 Hana가 화면에 나오지 않는다.
    const sp = info.kind === 'unit' ? this.shelves.standPoint(info, -0.8) : this.shelves.standPoint(info, x, dist + 0.3);
    const faceA = Math.atan2(-n.x, -n.z);
    if (first || Math.hypot(sp.x - this.hana.position.x, sp.z - this.hana.position.z) > 0.6) {
      const tgt = this.world.nav.walkable(sp.x, sp.z) ? sp : this.world.nav.nearestWalkable(sp.x, sp.z, 1.5);
      if (tgt) { if (first) this.walkTo(tgt.x, tgt.z, { face: faceA, stopAt: 0.1 }); else this.slideHana(tgt, faceA); }
      else this.faceAngle = faceA;
    } else this.faceAngle = faceA;
    if (rec) this.ui.hoverLabel(null);
    this.updateFocusLabel();
  }
  slideHana(tgt, faceA) { this.path = null; const P = this.hana.position, from = P.clone(); this.faceAngle = faceA; this.tween(0.25, k => { P.x = from.x + (tgt.x - from.x) * k; P.z = from.z + (tgt.z - from.z) * k; }); }
  updateFocusLabel() {
    const rec = this.focus; if (!rec || this.mode !== 'shelf') { this.ui.hoverLabel(null); return; }
    const p = this.shelves.frontPoint(rec).add(new THREE.Vector3(0, rec.h / 2 + 0.04, 0)).project(this.camera);
    const el = this.renderer.domElement.getBoundingClientRect();
    this.ui.hoverLabel(rec, el.left + (p.x + 1) / 2 * el.width - $('#game').getBoundingClientRect().left, (1 - p.y) / 2 * el.height);
  }
  shelfKey(e) {
    const rec = this.focus, info = this.shelfInfo; if (!info) return;
    const grid = this.shelves.grid(info);
    const step = (list, i, d) => list[clamp(i + d, 0, list.length - 1)];
    if (['Enter', 'Space', 'KeyE'].includes(e.code)) { e.preventDefault(); if (!e.repeat && rec) this.pull(); return; }
    if (!rec) return;
    let next = null;
    const lvl = grid[rec.level], i = lvl.indexOf(rec);
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const d = e.code === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) {
        const bay = rec.bay + d;
        const inBay = lvl.filter(r => r.bay === bay);
        next = inBay.length ? nearestX(inBay, rec.x + d) : [1, 2, 3, 4, 5].map(l => grid[l].filter(r => r.bay === bay)).find(a => a.length)?.[0] ?? null;
      } else next = step(lvl, i, d);
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const d = e.code === 'ArrowUp' ? 1 : -1;
      for (let l = rec.level + d; l >= 1 && l <= 5; l += d) if (grid[l].length) { next = nearestX(grid[l], rec.x); break; }
    }
    if (next) { e.preventDefault(); if (next !== rec) this.setFocus(next); }
  }
  hoverShelf(e) {
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1);
    this.raycaster.setFromCamera(ndc, this.camera);
    this.setHover(this.shelves.pick(this.raycaster, this.shelfInfo?.id));
  }
  setHover(rec) {
    if (this.hover === rec) return;
    if (this.hover && this.hover !== this.focus && this.hover !== this.pulled) this.shelves.setOffset(this.hover, 0);
    this.hover = rec;
    if (rec && rec !== this.pulled) { this.shelves.setOffset(rec, 0.01); this.setFocus(rec); }
  }
  exitShelf() {
    if (this.photo?.active) return this.photo.exitShelf();
    if (this.focus && this.focus !== this.pulled) this.shelves.setOffset(this.focus, 0);
    if (this.hover && this.hover !== this.pulled) this.shelves.setOffset(this.hover, 0);
    this.focus = null; this.hover = null;
    this.mode = 'explore'; this.shelfInfo = null;
    this.ui.shelfBar(null); this.ui.hoverLabel(null);
    this.cam.toFollow(this.hana);
    this.faceAngle = null;
    this.focusGame();
  }
  goInner(info) {
    const alc = this.world.chamberById.get(`alc-${info.id}`);
    this.exitShelf();
    if (!alc) return;
    const p = toWorld(alc, 0, Math.min(2.2, alc.d / 2));
    this.walkTo(p.x, p.z, { fast: false });
  }

  // ---------- 꺼내기 → 카드 ----------
  async pull() {
    const rec = this.focus; if (!rec || this.mode !== 'shelf') return;
    this.mode = 'pull'; this.pulled = rec;
    this.ui.hoverLabel(null);
    this.sound.play('pull', 0.4);
    const fast = this.config.reduced;
    const H = this.hana;
    const anim = (dur, fn) => this.tween(dur, fn);
    // 카메라는 2.5m 넘게 물러나 Hana가 손을 뻗는 모습을 비스듬히 보여 준다
    const info = rec.info, n = this.shelves.shelfNormal(info), dir = this.shelves.shelfDir(info);
    const book = this.shelves.centerPoint(rec);
    const camPos = book.clone().addScaledVector(n, info.kind === 'unit' ? 1.2 : this.config.camera.pullDistance * 0.82).addScaledVector(dir, info.kind === 'unit' ? -1.6 : 1.4).add(new THREE.Vector3(0, 0.7, 0));
    this.cam.toPose({ pos: camPos, look: book.clone().addScaledVector(n, 0.4) }, 0.45);
    const step = info.kind === 'unit' ? this.shelves.standPoint(info, rec.x - 0.25) : this.shelves.standPoint(info, rec.x - 0.18, 0.5);
    const from = H.position.clone(), faceA = Math.atan2(-n.x, -n.z);
    this.faceAngle = faceA;
    await anim(0.3, k => { this.shelves.setOffset(rec, 0.01 + 0.11 * k); H.position.x = from.x + (step.x - from.x) * k; H.position.z = from.z + (step.z - from.z) * k; });
    const front = this.shelves.frontPoint(rec, 0.02);
    if (rec.level === 1 && !fast) H.playOnce('pickLow', 'idle');
    H.reach('r', front, 1);
    await anim(0.32, () => { H.reach('r', front, 1); });
    // 책을 손으로
    const loose = this.shelves.makeLoose(rec);
    loose.matrixAutoUpdate = true;
    const m = this.shelves.worldMatrix(rec); m.decompose(loose.position, loose.quaternion, new THREE.Vector3());
    this.shelves.hide(rec, true);
    this.loose = loose;
    H.hold(loose, 'hand');
    H.reach('r', H.chestPoint(0.34, 1.12), 1);
    await anim(0.28, () => { const hp = H.chestPoint(0.34, 1.12); H.reach('r', hp, 1); });
    this.mode = 'card';
    this.ui.shelfBar(null);
    this.cam.toFollow(H, 0.5);
    this.ui.showCard(rec, {
      onOpen: () => this.openBook(rec.book),
      onAttach: a => this.openBook(a, rec.book),
      onIndex: () => this.openItem({ id: this.indexIds.get(rec.book.src.index), title: rec.book.src.index.split('/').pop(), path: rec.book.src.index, kind: 'file', ext: 'md' }),
      onClose: () => this.putBack(),
    });
  }
  // 책 제자리로(0.4초)
  async putBack() {
    if (this.photo?.active) return this.photo.putBack();
    const rec = this.pulled; const loose = this.loose;
    this.ui.hideCard();
    if (!rec) { this.mode = 'explore'; return; }
    this.pulled = null; this.loose = null;
    this.hana.drop();
    this.mode = 'explore';
    if (loose) {
      const target = new THREE.Matrix4().copy(this.shelves.worldMatrix(rec, 0));
      const tp = new THREE.Vector3(), tq = new THREE.Quaternion(); target.decompose(tp, tq, new THREE.Vector3());
      const p0 = loose.position.clone(), q0 = loose.quaternion.clone();
      loose.userData.open.visible = false; loose.userData.inner.visible = true;
      await this.tween(0.4, k => { const e = k * k * (3 - 2 * k); loose.position.lerpVectors(p0, tp, e); loose.position.y += Math.sin(k * Math.PI) * 0.15; loose.quaternion.slerpQuaternions(q0, tq, e); });
      loose.removeFromParent();
    }
    this.shelves.hide(rec, false); this.shelves.setOffset(rec, 0);
    this.sound.play('pull', 0.2);
    this.cam.toFollow(this.hana);
    this.focusGame();
  }

  // ---------- 열기 ----------
  async openBook(item, parentBook = null) {
    if (this.photo?.active) return this.photo.openBook(item, parentBook);
    this.ui.hideCard();
    this.mode = 'read';
    const book = parentBook ?? item;
    this.tutorial.opened();
    this.reader.open(item, { goTo: null });
    // 열람 의자로
    const H = this.hana, seat = this.nearestSeat();
    if (this.loose) {
      this.loose.userData.halfWidth = this.pulled ? Math.max(0.12, this.pulled.d * 0.9) : 0.15;
    }
    if (seat) {
      const f = { x: Math.sin(seat.rot), z: Math.cos(seat.rot) };
      const stand = { x: seat.x + f.x * 0.62, z: seat.z + f.z * 0.62 };
      this.seatTaken = seat;
      this.walkTo(stand.x, stand.z, { face: seat.rot, stopAt: 0.1, then: async () => {
        if (this.mode !== 'read') return;
        H.heading = seat.rot;
        // 앉는 자리로 살짝 뒤로
        const from = H.position.clone(), to = new THREE.Vector3(seat.x + f.x * 0.18, H.position.y, seat.z + f.z * 0.18);
        this.tween(0.9, k => { if (this.mode === 'read') { H.position.x = from.x + (to.x - from.x) * k; H.position.z = from.z + (to.z - from.z) * k; } });
        await H.playOnce('sitDown', 'sitIdle');
        if (this.loose && this.mode === 'read') { this.loose.userData.inner.visible = false; this.loose.userData.open.visible = true; H.hold(this.loose, 'read'); }
        if (H.kind === 'sprite' && this.mode === 'read') this.seatedView(seat);
      } });
    } else if (this.loose) { this.loose.userData.inner.visible = false; this.loose.userData.open.visible = true; H.hold(this.loose, 'read'); }
    void book;
  }
  openItem(item, opts = {}) {
    // 서가에서 꺼내지 않고 바로 연다(검색 Shift+Enter·방명록·인덱스 열기)
    this.ui.hideCard();
    if (this.mode === 'shelf') this.exitShelf();
    if (this.mode !== 'card') this.mode = 'read';
    this.reader.open(item, opts);
    this.tutorial.opened();
  }
  // 스프라이트로 앉아 읽기: 의자 사진이 든 그림으로 바꾸고, 그 그림 방향(3/4 앞모습)에 맞는 자리에 카메라를 둔다.
  // 카메라와 의자 사이가 벽·서가로 막히지 않은 자리만 쓴다.
  seatedPose(seat) {
    const f = { x: Math.sin(seat.rot), z: Math.cos(seat.rot) };
    const blockers = [...this.world.colliders, this.shelves.frames, this.shelves.unitFrames];
    const ray = new THREE.Raycaster();
    const target = new THREE.Vector3(seat.x, seat.y + 0.8, seat.z);
    for (const dist of [2.9, 2.6]) for (const phi of [Math.PI / 4, -Math.PI / 4]) {
      const c = Math.cos(phi), sn = Math.sin(phi);
      const v = { x: -(f.x * c - f.z * sn), z: -(f.x * sn + f.z * c) }; // 카메라 → 의자
      const right = { x: -v.z, z: v.x }, side = f.x * right.x + f.z * right.z;
      const cam = new THREE.Vector3(seat.x - v.x * dist, seat.y + 1.45, seat.z - v.z * dist);
      if (!this.world.nav.walkable(cam.x, cam.z)) continue;
      const dir = cam.clone().sub(target); const L = dir.length(); dir.normalize();
      ray.set(target, dir); ray.far = L;
      if (ray.intersectObjects(blockers, false).some(h => h.distance > 0.45)) continue;
      return { cam, look: new THREE.Vector3(seat.x, seat.y + 0.72, seat.z), mirror: side > 0 };
    }
    return null;
  }
  seatedView(seat) {
    const H = this.hana, pose = seat.pose ?? this.seatedPose(seat);
    if (!pose) return;
    H.sprite.seatPose = { x: seat.x, z: seat.z }; H.sprite.seatMirror = pose.mirror;
    if (seat.obj) seat.obj.visible = false;
    this.seatHidden = seat;
    this.cam.toPose({ pos: pose.cam, look: pose.look }, 0.7);
  }
  leaveSeatedView() {
    if (this.seatHidden?.obj) this.seatHidden.obj.visible = true;
    this.seatHidden = null;
    if (this.hana.sprite) { this.hana.sprite.seatPose = null; this.hana.sprite.seatMirror = null; }
    if (this.cam.mode === 'pose') this.cam.toFollow(this.hana, 0.7);
  }
  nearestSeat() {
    const P = this.hana.position, R = this.config.movement.chairSearch;
    let best = null, bd = Infinity;
    for (const s of this.world.seats) {
      const d = Math.hypot(s.x - P.x, s.z - P.z);
      if (d >= R || d >= bd || Math.abs(s.y - P.y) >= 0.5) continue;
      // 스프라이트는 앉은 모습을 보여 줄 카메라 자리가 있는 의자만
      if (this.hana.kind === 'sprite') { s.pose = this.seatedPose(s); if (!s.pose) continue; }
      bd = d; best = s;
    }
    return best;
  }
  async standUpFromReading() {
    if (this.photo?.active) return this.photo.standUp();
    const H = this.hana;
    if (H.busy || !H.seated) return;
    if (this.loose) H.hold(this.loose, 'hand');
    this.leaveSeatedView();
    await H.playOnce('standUp', 'idle');
    this.seatTaken = null;
  }
  async closeReader() {
    if (this.photo?.active) return this.photo.closeReader();
    this.ui.hoverLabel(null);
    this.reader.close();
    this.onResize();
    const H = this.hana;
    if (H.seated) { H.release(); this.leaveSeatedView(); await H.playOnce('standUp', 'idle'); }
    this.seatTaken = null;
    if (this.loose) await this.putBack();
    else { this.mode = 'explore'; H.drop(); }
    this.focusGame();
  }
  exitAll() {
    if (this.photo?.active) return this.photo.exitAll();
    if (this.ui.overlayOpen) this.ui.closeOverlay();
    if (this.reader.isOpen) { this.reader.close(); this.onResize(); }
    if (this.ui.cardOpen || this.loose) { this.ui.hideCard(); if (this.loose) { this.loose.removeFromParent(); this.loose = null; } if (this.pulled) { this.shelves.hide(this.pulled, false); this.shelves.setOffset(this.pulled, 0); this.pulled = null; } }
    if (this.mode === 'shelf') this.exitShelf();
    this.hana.drop(); this.mode = 'explore'; this.cancelAuto(); this.clearGuide();
  }
  copyPathOf(b) {
    const p = b.url ?? (b.outside ? b.path : `${this.config.root}/${b.path}`);
    navigator.clipboard.writeText(p).then(() => toast('경로를 복사했습니다'), () => toast(p, 5000));
  }
  async external(id, mode) { try { await post(`/api/book/${id}/open?mode=${mode}`); } catch { toast('열지 못했습니다'); } }

  // ---------- 검색 → 길안내 ----------
  fromSearch(r, direct) {
    const b = r.book;
    if (direct) { this.openItem(r.att ?? b, { goTo: b.id }); return; }
    this.guideTo(b.id, { auto: true }); // 검색에서 고르면 Hana가 그 서가까지 걸어간다
  }
  goToBook(bookId) { this.guideTo(bookId, { auto: true }); }
  guideTo(bookId, { auto }) {
    const rec = this.shelves.recByBook.get(bookId);
    if (!rec) { toast('이 책의 자리를 찾지 못했습니다'); return; }
    if (this.photo?.active) return this.photo.guideTo(rec, { auto });
    if (this.reader.isOpen && this.hana.seated) this.standUpFromReading();
    if (this.mode === 'shelf') this.exitShelf();
    const info = rec.info;
    const target = this.shelfApproach(info, rec);
    const pts = this.world.nav.findPath(this.hana.position.x, this.hana.position.z, target.x, target.z);
    if (!pts) { toast('길을 찾지 못했습니다'); return; }
    this.showGuide(pts, { rec, info, target });
    if (auto) this.walkGuide();
    else toast(`바닥 길안내를 따라가거나 Enter로 걸어가세요`, 2600);
  }
  // 서가·책을 누르면 그 서가 앞으로 걸어가 서가 보기로 들어간다
  walkToShelf(info, rec = null, fast = false) {
    if (this.reader.isOpen && this.hana.seated) this.standUpFromReading();
    const t = this.shelfApproach(info, rec);
    this.clearGuide();
    this.walkTo(t.x, t.z, { fast, stopAt: 0.25, then: () => this.enterShelf(info, rec) });
  }
  shelfApproach(info, rec) {
    if (info.kind === 'unit') return new THREE.Vector3(-0.75, 0, 0).applyMatrix4(info.holder.matrixWorld);
    return this.shelves.standPoint(info, rec ? rec.x : info.bays / 2, 0.85);
  }
  walkGuide() {
    const g = this.guideTarget; if (!g) return;
    this.walkTo(g.target.x, g.target.z, { fast: true, stopAt: 0.3, then: () => this.arriveGuide() });
  }
  arriveGuide() {
    const g = this.guideTarget; if (!g) return;
    this.clearGuide();
    const { info, rec } = g;
    if (info.kind === 'unit') {
      const stack = this.shelves.stacks.get(info.stack);
      const row = stack.rows.find(rw => rw.units.includes(info));
      this.shelves.openAisle(info.stack, row.index, row.units.indexOf(info));
      setTimeout(() => { const sp = this.shelves.standPoint(info, rec.x); this.walkTo(sp.x, sp.z, { then: () => this.enterShelf(info, rec, { glow: true }) }); }, this.config.reduced ? 10 : 950);
      return;
    }
    this.enterShelf(info, rec, { glow: true });
    this.sound.play('found', 0.25);
  }
  walkToRoom(roomId) {
    if (this.photo?.active) return this.photo.goRoom(roomId);
    const c = this.world.chamberById.get(`c-${roomId}`);
    const p = toWorld(c, 0, 1.6);
    this.exitAll();
    this.walkTo(p.x, p.z, { fast: true });
  }
  listGoTo(shelfId) {
    this.toggleList(false);
    const info = this.shelves.byId.get(shelfId) ?? this.shelves.byId.get(this.palace.shelves[shelfId]?.units?.[0]);
    if (!info) { toast('이 서가는 게임 안 자리가 없습니다'); return; }
    this.guideTo(info.s.books[0]?.id ?? info.slots[0]?.book.id, { auto: true });
  }
  openFromList(b) {
    const rec = this.shelves.recByBook.get(b.id);
    if (!rec || this.config.static) { this.openItem(b); return; } // 공개판: 목록에서 누르면 바로 읽기
    this.ui.showCard(rec, { onOpen: () => { this.ui.hideCard(); this.openItem(b); }, onAttach: a => { this.ui.hideCard(); this.openItem(a); }, onIndex: () => { this.ui.hideCard(); this.openItem({ id: this.indexIds.get(b.src.index), title: b.src.index.split('/').pop(), path: b.src.index, kind: 'file', ext: 'md' }); }, onClose: () => this.ui.hideCard() });
  }
  toggleList(show) {
    const el = $('#list2d');
    if (show) {
      if (!el.dataset.built) { this.ui.buildList(); el.dataset.built = '1'; if (window.Lenis && window.gsap) { this.listLenis = new window.Lenis({ wrapper: el, content: el, lerp: 0.12 }); window.gsap.ticker.add(t => this.listLenis.raf(t * 1000)); } }
      el.hidden = false; el.querySelector('summary')?.focus();
      window.gsap?.fromTo(el, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.3, clearProps: 'opacity,visibility' });
      window.gsap?.from(el.querySelectorAll('details, .l2-room'), { autoAlpha: 0, y: 10, duration: 0.4, stagger: 0.04, ease: 'power2.out', clearProps: 'all' });
    }
    else { el.hidden = true; this.focusGame(); }
  }
  async refreshData() {
    toast('서가를 새로 고치는 중');
    try { const r = await post('/api/refresh'); toast('서가를 새로 고쳤습니다. 다시 불러옵니다'); console.log(r.report); setTimeout(() => location.reload(), 800); } catch { toast('새로 고치지 못했습니다'); }
  }

  // ---------- 바닥 길안내 선 ----------
  makeGuide() {
    const geo = new THREE.PlaneGeometry(0.34, 0.09); geo.rotateX(-Math.PI / 2);
    this.guide = new THREE.InstancedMesh(geo, new THREE.MeshBasicMaterial({ color: 0xFF7E5F, transparent: true, opacity: 0.85, depthWrite: false }), 600);
    this.guide.count = 0; this.guide.visible = false; this.guide.renderOrder = 3; this.guide.frustumCulled = false;
    this.scene.add(this.guide);
    this.marker = new THREE.Mesh(new THREE.RingGeometry(0.14, 0.2, 32), new THREE.MeshBasicMaterial({ color: 0xFF7E5F, transparent: true, opacity: 0, depthWrite: false }));
    this.marker.rotation.x = -Math.PI / 2; this.scene.add(this.marker);
  }
  showGuide(pts, target) {
    const m = new THREE.Matrix4(), q = new THREE.Quaternion(), s = new THREE.Vector3(1, 1, 1);
    let n = 0;
    const all = [{ x: this.hana.position.x, z: this.hana.position.z }, ...pts.slice(1)];
    for (let i = 0; i < all.length - 1 && n < 600; i++) {
      const a = all[i], b = all[i + 1], L = Math.hypot(b.x - a.x, b.z - a.z), ang = Math.atan2(b.x - a.x, b.z - a.z);
      q.setFromEuler(new THREE.Euler(0, ang + Math.PI / 2, 0));
      for (let d = 0.25; d < L && n < 600; d += 0.55) {
        const x = a.x + (b.x - a.x) * d / L, z = a.z + (b.z - a.z) * d / L;
        m.compose(new THREE.Vector3(x, this.world.heightAt(x, z) + 0.02, z), q, s); this.guide.setMatrixAt(n++, m);
      }
    }
    this.guide.count = n; this.guide.instanceMatrix.needsUpdate = true; this.guide.visible = true;
    this.guideTarget = target;
  }
  clearGuide() { this.guide.visible = false; this.guideTarget = null; this.tutorialGuide = false; if (this.photo?.guide) this.photo.clearGuide(); }
  updateGuide(dt) {
    if (this.marker.material.opacity > 0) { this.marker.material.opacity = Math.max(0, this.marker.material.opacity - dt * 1.2); this.marker.scale.multiplyScalar(1 + dt * 0.6); }
    const g = this.guideTarget;
    if (g && !this.path) {
      const P = this.hana.position;
      if (Math.hypot(P.x - g.target.x, P.z - g.target.z) < 0.9) { if (g.rec) this.arriveGuide(); else this.clearGuide(); }
    }
    if (this.guide.visible) this.guide.material.opacity = 0.65 + Math.sin(performance.now() / 260) * 0.2;
  }
  clickMarker(p) { this.marker.position.set(p.x, this.world.heightAt(p.x, p.z) + 0.02, p.z); this.marker.scale.setScalar(1); this.marker.material.opacity = 0.9; }

  // ---------- 책등 글자 ----------
  updateLabels() {
    const layer = $('#labels');
    const list = [];
    const P = this.hana.position;
    const cap = this.config.labels.max;
    const near = this.config.labels.nearShelf;
    const shelvesNear = [];
    if (this.mode === 'shelf' && this.shelfInfo) shelvesNear.push(this.shelfInfo);
    else if (this.mode === 'explore' || (this.mode === 'read' && !this.hana.seated)) {
      for (const info of this.shelves.byId.values()) {
        const seg = this.shelves.frontSegment(info);
        const vx = seg.bx - seg.ax, vz = seg.bz - seg.az, L2 = vx * vx + vz * vz || 1;
        const t = clamp(((P.x - seg.ax) * vx + (P.z - seg.az) * vz) / L2, 0, 1);
        if (Math.hypot(P.x - (seg.ax + vx * t), P.z - (seg.az + vz * t)) < near) shelvesNear.push(info);
      }
    }
    const rect = this.renderer.domElement.getBoundingClientRect();
    const W = rect.width, Hh = rect.height;
    const v = new THREE.Vector3(), v2 = new THREE.Vector3();
    for (const info of shelvesNear) {
      for (const slot of info.slots) {
        if (list.length >= cap) break;
        if (info.kind === 'unit' && slot.face !== 0) continue;
        const rec = this.shelves.recByBook.get(slot.book.id); if (!rec || rec.hidden) continue;
        const m = this.shelves.worldMatrix(rec);
        v.set(0, 0.5, 0.5).applyMatrix4(m).project(this.camera);
        v2.set(0, -0.5, 0.5).applyMatrix4(m).project(this.camera);
        if (v.z > 1 || v2.z > 1 || v.z < -1) continue;
        const x = (v.x + 1) / 2 * W, y1 = (1 - v.y) / 2 * Hh, y2 = (1 - v2.y) / 2 * Hh;
        const hpx = Math.abs(y2 - y1);
        const v3 = new THREE.Vector3(0.5, 0, 0.5).applyMatrix4(m).project(this.camera);
        const wpx = Math.abs((v3.x + 1) / 2 * W - x) * 2;
        if (hpx < 34 || wpx < 8 || x < -20 || x > W + 20) continue;
        list.push({ rec, x, y: Math.min(y1, y2), hpx, wpx });
      }
    }
    while (this.labelPool.length < list.length) { const d = document.createElement('div'); d.className = 'spine'; layer.append(d); this.labelPool.push(d); }
    this.labelPool.forEach((d, i) => {
      const it = list[i];
      if (!it) { if (d.style.display !== 'none') d.style.display = 'none'; return; }
      d.style.display = '';
      const fs = clamp(it.wpx * 0.62, 7, 15);
      if (d.dataset.id !== it.rec.book.id) { d.textContent = it.rec.book.title; d.dataset.id = it.rec.book.id; d.className = `spine${it.rec.light ? ' light' : ''}`; }
      d.style.fontSize = `${fs}px`; d.style.width = `${it.wpx}px`; d.style.height = `${it.hpx * 0.86}px`; d.style.lineHeight = `${it.wpx}px`;
      d.style.transform = `translate(${it.x - it.wpx / 2}px, ${it.y + it.hpx * 0.07}px)`;
    });
  }
}

function nearestX(list, x) { let best = null, bd = Infinity; for (const r of list) { const d = Math.abs(r.x - x); if (d < bd) { bd = d; best = r; } } return best; }

// ---------- 첫 방문 안내 ----------
class Tutorial {
  constructor(app) { this.app = app; this.step = -1; this.el = $('#tutorial'); this.el.querySelector('button').addEventListener('click', () => this.finish()); }
  start() { if (store.get('tutorialDone', false)) return; this.step = 0; this.show(); }
  restart() { store.set('tutorialDone', false); this.step = 0; this.show(); }
  show() {
    const lines = this.app.config.copy.tutorial;
    if (this.step < 0 || this.step >= lines.length) { this.el.hidden = true; return; }
    this.el.querySelector('span').textContent = `${this.step + 1}/${lines.length}  ${lines[this.step]}`; this.el.hidden = false;
    if (this.step === 1) this.guideToActive();
  }
  guideToActive() {
    if (this.app.photo?.active) { this.app.photo.guideToActive(); this.app.tutorialGuide = true; return; }
    const info = [...this.app.shelves.byId.values()].find(i => i.room === 'content' && i.kind === 'wall' && i.s.active);
    if (!info) return;
    const t = this.app.shelves.standPoint(info, info.bays / 2, 0.85);
    const pts = this.app.world.nav.findPath(this.app.hana.position.x, this.app.hana.position.z, t.x, t.z);
    if (pts) { this.app.showGuide(pts, { target: t, rec: null, info }); this.app.tutorialGuide = true; }
  }
  update(region) { if (this.step === 0 && region.kind === 'hall') { this.step = 1; this.show(); } }
  nearShelf(info) { if (this.step === 1 && info?.s.active && info.room === 'content') { this.app.clearGuide(); this.step = 2; this.show(); } }
  opened() { if (this.step === 2) this.finish(); }
  finish() { this.step = -1; this.el.hidden = true; store.set('tutorialDone', true); if (this.app.tutorialGuide) this.app.clearGuide(); }
}

const app = new App();
window.palaceApp = app;
app.boot().catch(e => { console.error(e); $('#loading-text').textContent = `불러오지 못했습니다: ${e.message}`; });
