// 사진 모드: 공간마다 실사 사진 한 장(고정 카메라)을 배경으로 깔고, 그 위에 Hana 실사 스프라이트를 원근에 맞춰 그린다.
// 바닥·가구·서가·문 자리는 photo-scenes.json(사진 기준 0~1 좌표). 서가를 누르면 Shelf2D(서가 근접 사진 + 책등)로 들어간다.
import { $, h, store, toast, clamp, damp } from './util.js';
import { Shelf2D } from './shelf2d.js';
import { PhotoGL } from './photo3d.js';
import * as THREE from 'three';

const DIRS = ['back', 'backL', 'left', 'frontL', 'front'];
const PERSON = 1.65;
const MOVE = { KeyW: [1, 0], ArrowUp: [1, 0], KeyS: [-1, 0], ArrowDown: [-1, 0], KeyA: [0, -1], ArrowLeft: [0, -1], KeyD: [0, 1], ArrowRight: [0, 1] };
const GRID = 100;

export class PhotoMode {
  constructor(app, def) {
    this.app = app; this.def = def; this.F = def.focal ?? 1.2;
    this.scenes = def.scenes;
    this.imgs = new Map(); this.sheets = new Map();
    this.man = null;
    this.H = { u: 0.5, v: 0.95, dir: 'back', mirror: false, state: 'idle', speed: 0, t: 0, clip: null, sit: 0, sector: 0 };
    this.path = null; this.active = false; this.focusU = 0.5; this.sceneId = null;
    this.hover = null; this.guide = null; this.T = null; this.bgKey = '';
  }

  // ---------- 준비 ----------
  async init(onProgress = () => {}) {
    const root = $('#game');
    this.el = h('div', { id: 'photo' },
      this.bg = h('canvas', { id: 'photo-bg', 'aria-hidden': 'true' }),
      this.olc = h('canvas', { id: 'photo-ol', 'aria-hidden': 'true' }),
      this.glc = h('canvas', { id: 'photo-gl', 'aria-hidden': 'true' }),
      this.fg = h('canvas', { id: 'photo-fg', tabindex: 0, 'aria-label': '마인드 팰리스 사진 공간. 방향키로 걷고 E로 상호작용' }),
      this.chips = h('div', { id: 'photo-chips' }),
      this.fade = h('div', { id: 'photo-fade' }));
    root.insertBefore(this.el, $('#labels'));
    this.gb = this.bg.getContext('2d'); this.gf = this.fg.getContext('2d'); this.go = this.olc.getContext('2d');
    this.gl = new PhotoGL(this.glc, this.F);
    this.tint = new THREE.Color(1, 1, 1); this.tintS = new THREE.Color(1, 1, 1);
    this.shelf = new Shelf2D(this.app, this, this.def.shelfPhoto);
    this.buildGroups();
    // 스프라이트
    const r = await fetch('assets/hana/sprites/manifest.json'); this.man = await r.json();
    const keys = Object.keys(this.man); let done = 0;
    const first = [this.def.start ?? 'outside', 'hall'];
    const total = keys.length + first.length;
    await Promise.all([
      ...keys.map(k => this.loadImg(`${this.man[k].file}`).then(im => { this.sheets.set(k, im); onProgress(++done / total); })),
      ...first.map(id => Promise.all([this.sceneImg(id), this.depthImg(id)]).then(() => onProgress(++done / total))),
    ]);
    // 나머지 방 사진은 뒤에서 미리 받아 둔다
    setTimeout(() => { for (const id of Object.keys(this.scenes)) { this.sceneImg(id); this.depthImg(id); } this.loadImg(`${this.def.shelfPhoto.image}`); }, 400);
    this.setupInput();
    return this;
  }
  loadImg(src) {
    if (this.imgs.has(src)) return this.imgs.get(src);
    const p = new Promise(res => { const im = new Image(); im.decoding = 'async'; im.onload = () => res(im); im.onerror = () => res(null); im.src = src; });
    p.then(im => { p.done = im; });
    this.imgs.set(src, p); return p;
  }
  sceneImg(id) { return this.loadImg(`${this.scenes[id].image}`); }
  depthImg(id) { return this.scenes[id].depthFit ? this.loadImg(`assets/photo/depth/${id}.png`) : Promise.resolve(null); }

  // 방마다 벽 서가 = 묶음 하나(안쪽 서고·이동식 서가 포함). 묶음을 사진 속 서가 자리에 나눠 담는다.
  buildGroups() {
    const P = this.app.palace, S = this.app.shelves;
    this.groupsByRoom = new Map();
    for (const room of P.rooms) {
      const groups = [];
      const seen = new Set();
      const add = (items, s, depth) => {
        if (!s || seen.has(s.id)) return; seen.add(s.id);
        if (s.level === 'stack') { for (const u of s.units ?? []) add(items, P.shelves[u], 2); return; }
        items.push({ id: s.id, s, depth, info: S.byId.get(s.id) ?? null });
        for (const iid of s.inner ?? []) add(items, P.shelves[iid], depth + 1);
      };
      const walls = Object.values(P.shelves).filter(s => s.room === room.id && s.level === 'wall');
      for (const w of walls) {
        const items = []; add(items, w, 0);
        const books = items.reduce((n, it) => n + (it.s.books?.length ?? 0), 0);
        groups.push({ wall: w, items, books, active: items.some(it => it.s.active) });
      }
      // 벽 서가에 매달리지 않은 서가가 있으면 마지막 묶음에 붙인다
      const left = Object.values(P.shelves).filter(s => s.room === room.id && !seen.has(s.id) && s.level !== 'unit');
      if (left.length && groups.length) for (const s of left) add(groups.at(-1).items, s, 1);
      this.groupsByRoom.set(room.id, groups);
    }
    for (const [id, sc] of Object.entries(this.scenes)) {
      const spots = (sc.hotspots ?? []).filter(x => x.type === 'shelves');
      spots.forEach(s => { s.groups = []; });
      const groups = this.groupsByRoom.get(id) ?? [];
      if (!spots.length) continue;
      const act = spots.find(s => s.active);
      const rest = [];
      for (const g of groups) (g.active && act ? act.groups : rest).push(g);
      const pool = spots.filter(s => !(s.active && s.groups.length));
      const list = pool.length ? pool : spots;
      rest.forEach((g, i) => list[Math.min(list.length - 1, Math.floor(i * list.length / rest.length))].groups.push(g));
    }
  }
  spotOfShelf(shelfId) {
    for (const [id, sc] of Object.entries(this.scenes)) for (const sp of sc.hotspots ?? []) if (sp.groups?.some(g => g.items.some(it => it.id === shelfId))) return { sceneId: id, spot: sp };
    return null;
  }

  // ---------- 켜기·장면 ----------
  start() {
    this.active = true;
    $('#stage').hidden = true; $('#labels').hidden = true; document.body.classList.add('photo');
    this.el.hidden = false;
    const saved = store.get('photoPos');
    if (saved && this.scenes[saved.scene] && store.get('visited', false)) this.enter(saved.scene, null, { instant: true, at: saved });
    else this.enter(this.def.start ?? 'outside', 'default', { instant: true });
    this.resize();
  }
  async enter(id, from = 'default', { instant = false, at = null, walkIn = true } = {}) {
    const sc = this.scenes[id]; if (!sc) return;
    const reduce = this.app.config.reduced || instant;
    if (!reduce) { this.fade.classList.add('on'); await wait(230); }
    const [img, depth] = await Promise.all([this.sceneImg(id), this.depthImg(id)]);
    this.gl.setScene(sc, depth);
    this.dmap = depthData(depth);
    for (const x of sc.hotspots ?? []) delete x._mask;
    this.light = lightGrid(img);
    const prev = this.sceneId;
    this.sceneId = id; this.sc = sc; this.path = null; this.hover = null; this.bgKey = '';
    sc.grid ??= this.buildGrid(sc);
    const H = this.H;
    let sp = at ? [at.u, at.v, at.dir ?? 'back'] : null;
    if (!sp && from && sc.spawn?.[from]) sp = sc.spawn[from];
    if (!sp && id === 'hall' && prev && prev !== 'outside') { const d = sc.hotspots.find(x => x.to === prev); if (d) sp = [d.stand[0], d.stand[1] + 0.03, 'front']; }
    if (!sp && id === 'outside' && prev === 'hall') sp = sc.spawn['from:hall'];
    sp ??= sc.spawn?.default ?? [0.5, 0.95, 'back'];
    if (!this.walkable(sp[0], sp[1])) { const n = this.nearestWalkable(sp[0], sp[1]); if (n) sp = [n.u, n.v, sp[2]]; }
    H.u = sp[0]; H.v = sp[1]; H.dir = sp[2] ?? 'back'; H.mirror = false; H.state = 'idle'; H.sit = 0;
    H.sector = DIRS.indexOf(H.dir);
    this.focusU = H.u;
    this.renderChips();
    this.updateWhere();
    this.app.ui.setPrompt(null);
    if (!reduce) { await wait(30); this.fade.classList.remove('on'); }
    // 방에 들어오면 몇 걸음 앞으로
    if (walkIn && !at && from !== null && H.dir === 'back') this.stepIn(0.9);
    else if (walkIn && !at && H.dir === 'front' && id !== this.def.start) this.stepIn(-0.7);
    this.app.tutorial.update({ kind: id === 'hall' ? 'hall' : id === 'outside' ? 'outside' : 'room' });
    if (this.guide) this.continueGuide();
  }
  stepIn(m) {
    const H = this.H, mz = this.mz(H.v);
    const v = clamp(H.v - m / mz, 0, 1);
    if (this.walkable(H.u, v)) this.path = { pts: [{ u: H.u, v }], then: null, fast: false };
  }
  updateWhere() {
    const id = this.sceneId, sc = this.sc;
    const parts = [];
    if (id === 'outside') parts.push({ text: sc.where ?? '정문 앞' });
    else {
      parts.push({ text: this.app.config.copy.hall });
      const room = this.app.world.roomById.get(id), cfg = this.app.world.roomCfg.get(id);
      if (room) parts.push({ text: room.name, color: cfg?.spine });
    }
    this.app.ui.setWhere(parts);
  }

  // ---------- 원근 ----------
  // 사람 키(사진 높이 대비)와 그 기울기
  pAt(v, sc = this.sc) {
    if (sc.camera) { const { v0, k } = sc.camera; return { p: Math.max(0.02, k * (v - v0)), k }; }
    const t = sc.scale; let i = 0;
    while (i < t.length - 2 && v > t[i + 1][0]) i++;
    const [v0, p0] = t[i], [v1, p1] = t[i + 1], k = (p1 - p0) / (v1 - v0);
    return { p: Math.max(0.02, p0 + (v - v0) * k), k: Math.max(0.05, k) };
  }
  aspect(sc = this.sc) { const im = this.imgSync(sc); return im ? im.naturalWidth / im.naturalHeight : 16 / 9; }
  imgSync(sc) { const p = this.imgs.get(`${sc.image}`); return p?.done ?? null; }
  mx(v) { return this.aspect() * PERSON / this.pAt(v).p; }                 // 가로 1(사진 폭) = 몇 m
  mz(v) { const { p, k } = this.pAt(v); return this.F * PERSON * k / (p * p); } // 세로 1(사진 높이) = 몇 m(깊이)
  meters(du, dv, v) { return { x: du * this.mx(v), z: -dv * this.mz(v) }; }

  // ---------- 바닥 ----------
  walkable(u, v, sc = this.sc) {
    if (!inPoly(sc.floor, u, v)) return false;
    for (const b of sc.blockers ?? []) if (inPoly(b, u, v)) return false;
    // 몸 폭(좌우 0.18m)
    const r = 0.18 / (this.aspect(sc) * PERSON / this.pAt(v, sc).p);
    for (const du of [-r, r]) { if (!inPoly(sc.floor, u + du, v)) return false; for (const b of sc.blockers ?? []) if (inPoly(b, u + du, v)) return false; }
    return true;
  }
  buildGrid(sc) {
    const g = new Uint8Array(GRID * GRID);
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) g[j * GRID + i] = this.walkable((i + 0.5) / GRID, (j + 0.5) / GRID, sc) ? 1 : 0;
    return g;
  }
  nearestWalkable(u, v) {
    const g = this.sc.grid; let best = null, bd = Infinity;
    for (let j = 0; j < GRID; j++) for (let i = 0; i < GRID; i++) {
      if (!g[j * GRID + i]) continue;
      const cu = (i + 0.5) / GRID, cv = (j + 0.5) / GRID;
      const m = this.meters(cu - u, cv - v, (cv + v) / 2), d = Math.hypot(m.x, m.z);
      if (d < bd) { bd = d; best = { u: cu, v: cv }; }
    }
    return best;
  }
  lineFree(a, b) {
    const n = Math.ceil(Math.hypot(b.u - a.u, b.v - a.v) / 0.004);
    for (let i = 1; i <= n; i++) { const t = i / n; if (!this.walkable(a.u + (b.u - a.u) * t, a.v + (b.v - a.v) * t)) return false; }
    return true;
  }
  findPath(to) {
    const H = this.H, a = { u: H.u, v: H.v };
    if (this.lineFree(a, to)) return [to];
    const g = this.sc.grid, idx = (i, j) => j * GRID + i;
    const si = clamp(Math.floor(a.u * GRID), 0, GRID - 1), sj = clamp(Math.floor(a.v * GRID), 0, GRID - 1);
    const ti = clamp(Math.floor(to.u * GRID), 0, GRID - 1), tj = clamp(Math.floor(to.v * GRID), 0, GRID - 1);
    const cost = new Float32Array(GRID * GRID).fill(Infinity), from = new Int32Array(GRID * GRID).fill(-1);
    const open = [[0, si, sj]]; cost[idx(si, sj)] = 0;
    const hEst = (i, j) => { const m = this.meters((ti - i) / GRID, (tj - j) / GRID, (j + 0.5) / GRID); return Math.hypot(m.x, m.z); };
    let found = false, guard = 0;
    while (open.length && guard++ < 40000) {
      let bi = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
      const [, i, j] = open.splice(bi, 1)[0];
      if (i === ti && j === tj) { found = true; break; }
      for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const ni = i + di, nj = j + dj; if (ni < 0 || nj < 0 || ni >= GRID || nj >= GRID) continue;
        if (!g[idx(ni, nj)] && !(ni === ti && nj === tj)) continue;
        const m = this.meters(di / GRID, dj / GRID, (j + 0.5) / GRID), c = cost[idx(i, j)] + Math.hypot(m.x, m.z);
        if (c < cost[idx(ni, nj)]) { cost[idx(ni, nj)] = c; from[idx(ni, nj)] = idx(i, j); open.push([c + hEst(ni, nj), ni, nj]); }
      }
    }
    if (!found) return null;
    const pts = []; let k = idx(ti, tj);
    while (k >= 0 && k !== idx(si, sj)) { pts.unshift({ u: (k % GRID + 0.5) / GRID, v: (Math.floor(k / GRID) + 0.5) / GRID }); k = from[k]; }
    pts[pts.length - 1] = to;
    // 줄이기: 보이는 점까지 건너뛴다
    const out = []; let cur = a, i = 0;
    while (i < pts.length) { let j = pts.length - 1; while (j > i && !this.lineFree(cur, pts[j])) j--; out.push(pts[j]); cur = pts[j]; i = j + 1; }
    return out;
  }
  walkTo(u, v, { then = null, fast = false, face = null } = {}) {
    let to = { u, v };
    if (!this.walkable(u, v)) { const n = this.nearestWalkable(u, v); if (!n) return false; to = n; }
    const pts = this.findPath(to);
    if (!pts) { toast('그곳으로 가는 길을 찾지 못했습니다'); return false; }
    this.path = { pts, then, fast, face };
    return true;
  }

  // ---------- 매 프레임 ----------
  update(dt) {
    if (!this.active || !this.sc) return;
    const app = this.app, H = this.H;
    const canWalk = (app.mode === 'explore' || app.mode === 'read') && !this.shelf.isOpen && !this.busy;
    let mvx = 0, mvz = 0, speed = 0;
    if (canWalk) {
      let f = 0, s = 0;
      for (const k of app.keys) if (MOVE[k]) { f += MOVE[k][0]; s += MOVE[k][1]; }
      const fast = app.keys.has('ShiftLeft') || app.keys.has('ShiftRight');
      if (f || s) {
        if (H.state === 'read') this.standUp();
        else {
          this.path = null;
          const L = Math.hypot(f, s); mvx = s / L; mvz = f / L; speed = fast ? this.def.fastSpeed : this.def.walkSpeed;
          // 문 앞에서 위로 걸으면 들어간다
          if (f > 0) { const d = this.doorAt(H.u, H.v); if (d) { this.useHotspot(d); return; } }
          if (f < 0 && this.sc.exit && H.v > this.sc.exit.v - 0.012) { this.leave(); return; }
        }
      } else if (this.path) {
        const r = this.followPath(dt); mvx = r.x; mvz = r.z; speed = r.speed;
      }
    }
    if (speed > 0) {
      const mx = this.mx(H.v), mz = this.mz(H.v);
      const du = mvx * speed * dt / mx, dv = -mvz * speed * dt / mz;
      if (this.walkable(H.u + du, H.v + dv)) { H.u += du; H.v += dv; }
      else if (this.walkable(H.u + du, H.v)) H.u += du;
      else if (this.walkable(H.u, H.v + dv)) H.v += dv;
      else if (this.path) { this.path.stuck = (this.path.stuck ?? 0) + dt; if (this.path.stuck > 0.8) this.path = null; }
      this.setDir(mvx, mvz);
      if (H.state !== 'wave') H.state = speed > this.def.walkSpeed + 0.1 ? 'fast' : 'walk';
      H.speed = speed;
      if (this.sc.exit && H.v > this.sc.exit.v && mvz < 0 && !this.path) { this.leave(); return; }
    } else if (H.state === 'walk' || H.state === 'fast') { H.state = 'idle'; H.speed = 0; }
    // 앉기·일어서기 전환
    const sitT = H.state === 'read' ? 1 : 0;
    H.sit = this.app.config.reduced ? sitT : damp(H.sit, sitT, 7, dt);
    this.updatePrompt();
    this.render(dt);
    if (++this.frame % 3 === 0) this.drawMinimap();
    if (this.frame % 90 === 0 && app.mode === 'explore') store.set('photoPos', { scene: this.sceneId, u: H.u, v: H.v, dir: H.dir });
  }
  followPath(dt) {
    const H = this.H, P = this.path;
    while (P.pts.length) {
      const m = this.meters(P.pts[0].u - H.u, P.pts[0].v - H.v, H.v);
      if (Math.hypot(m.x, m.z) > 0.06) break;
      P.pts.shift();
    }
    if (!P.pts.length) {
      this.path = null; const then = P.then;
      if (P.face) this.faceTo(P.face);
      if (then) then();
      return { x: 0, z: 0, speed: 0 };
    }
    const m = this.meters(P.pts[0].u - H.u, P.pts[0].v - H.v, H.v), L = Math.hypot(m.x, m.z) || 1;
    const last = P.pts.length === 1;
    const sp = (P.fast ? this.def.fastSpeed : this.def.walkSpeed) * (last ? Math.min(1, L / 0.5 + 0.35) : 1);
    return { x: m.x / L, z: m.z / L, speed: Math.min(sp, L / dt) };
  }
  // 걷는 방향(m, 카메라 기준: x 오른쪽, z 멀어지는 쪽) → 스프라이트 방향
  setDir(x, z) {
    const H = this.H;
    const theta = Math.atan2(Math.abs(x), z); // 0 = 뒷모습, π = 앞모습
    const raw = theta / (Math.PI / 4);
    if (Math.abs(raw - H.sector) > 0.62) H.sector = clamp(Math.round(raw), 0, 4);
    H.dir = DIRS[H.sector];
    if (x > 0.08) H.mirror = true; else if (x < -0.08) H.mirror = false;
  }
  faceTo(pt) {
    const H = this.H, m = this.meters(pt[0] - H.u, pt[1] - H.v, H.v);
    H.sector = -9; this.setDir(m.x, m.z);
  }

  // ---------- 상호작용 ----------
  hotspotAt(u, v) {
    const list = (this.sc.hotspots ?? []).filter(x => x.type !== 'shelves' || x.groups?.length);
    // 작은 것부터(문·안내대가 큰 서가보다 먼저)
    return list.filter(x => inPoly(x.poly, u, v)).sort((a, b) => area(a.poly) - area(b.poly))[0] ?? null;
  }
  doorAt(u, v) {
    for (const d of this.sc.hotspots ?? []) if (d.type === 'door') { const m = this.meters(d.stand[0] - u, d.stand[1] - v, v); if (Math.hypot(m.x, m.z) < 0.45) return d; }
    return null;
  }
  nearHotspot() {
    const H = this.H; let best = null, bd = 0.6;
    for (const x of this.sc.hotspots ?? []) {
      if (x.type === 'shelves' && !x.groups?.length) continue;
      const m = this.meters(x.stand[0] - H.u, x.stand[1] - H.v, H.v), d = Math.hypot(m.x, m.z);
      if (d < bd) { bd = d; best = x; }
    }
    return best;
  }
  labelOf(x) {
    if (x.label) return x.label;
    if (x.type === 'door') { const r = this.app.world.roomById.get(x.to); return r ? `${r.name}로 들어가기` : '들어가기'; }
    if (x.type === 'shelves') return `${this.app.config.copy.interactShelf} · ${groupTitle(x.groups)}`;
    return '';
  }
  updatePrompt() {
    const app = this.app;
    if (app.mode !== 'explore' && app.mode !== 'read') return;
    if (this.H.state === 'read' || this.path) { app.ui.setPrompt(null); this.near = null; return; }
    const x = this.nearHotspot(); this.near = x;
    app.ui.setPrompt(x ? this.labelOf(x) : null);
    if (x?.type === 'shelves' && this.sceneId === 'content' && x.active) {
      const g = x.groups.find(gr => gr.active); const info = g?.items.find(it => it.info)?.info;
      if (info) this.app.tutorial.nearShelf({ ...info, s: { ...info.s, active: true }, room: 'content' });
    }
  }
  interact() {
    if (this.H.state === 'read') return;
    const x = this.near ?? this.nearHotspot();
    if (x) return this.useHotspot(x);
    if (this.guide) return this.walkGuide();
  }
  goHotspot(x) {
    this.path = null;
    const m = this.meters(x.stand[0] - this.H.u, x.stand[1] - this.H.v, this.H.v);
    if (Math.hypot(m.x, m.z) < 0.35) return this.useHotspot(x);
    const center = centroid(x.poly);
    this.walkTo(x.stand[0], x.stand[1], { face: [center[0], Math.max(center[1], x.stand[1] - 0.2)], then: () => this.useHotspot(x) });
  }
  useHotspot(x, opts = {}) {
    const app = this.app;
    switch (x.type) {
      case 'door': app.sound.play('door', 0.25); return this.enter(x.to, this.sceneId === 'hall' ? 'default' : this.sceneId === 'outside' ? 'default' : `from:${this.sceneId}`);
      case 'map': return app.showPlan();
      case 'guestbook': return app.ui.showGuestbook(app.palace.log);
      case 'skills': return app.ui.showSkills(this.sceneId);
      case 'shelves': { const c = centroid(x.poly); this.faceTo([c[0], Math.min(c[1], this.H.v - 0.05)]); return this.shelf.open(x, opts); }
      default:
    }
  }
  leave() {
    const ex = this.sc.exit; if (!ex) return;
    this.app.sound.play('door', 0.2);
    this.enter(ex.to, `from:${this.sceneId}`);
  }

  // ---------- 길안내 ----------
  // 목표: { sceneId, spot, rec }. 지금 장면에서 다음에 갈 문(또는 서가)을 빛낸다.
  guideTo(rec, { auto }) {
    const hit = this.spotOfShelf(rec.info.id);
    if (!hit) { toast('이 책의 자리를 사진 공간에서 찾지 못했습니다'); return; }
    if (this.H.state === 'read') this.standUp();
    if (this.shelf.isOpen) this.shelf.close();
    this.guide = { ...hit, rec };
    this.renderChips();
    if (auto) this.walkGuide();
    else toast('빛나는 곳을 누르거나 Enter로 걸어가세요', 2600);
  }
  nextStep() {
    const g = this.guide; if (!g) return null;
    if (this.sceneId === g.sceneId) return g.spot;
    if (this.sceneId === 'hall') return this.sc.hotspots.find(x => x.type === 'door' && x.to === g.sceneId) ?? null;
    if (this.sceneId === 'outside') return this.sc.hotspots.find(x => x.type === 'door');
    return { type: 'exit' };
  }
  walkGuide() {
    const step = this.nextStep(); if (!step) return;
    this.guide.auto = true;
    if (step.type === 'exit') { const ex = this.sc.exit; this.walkTo(this.H.u, ex.v - 0.01, { fast: true, then: () => this.leave() }); return; }
    if (step === this.guide.spot) { this.walkTo(step.stand[0], step.stand[1], { fast: true, face: centroid(step.poly), then: () => this.arriveGuide() }); return; }
    this.walkTo(step.stand[0], step.stand[1], { fast: true, then: () => this.useHotspot(step) });
  }
  continueGuide() { if (this.guide?.auto) setTimeout(() => this.walkGuide(), this.app.config.reduced ? 0 : 250); }
  arriveGuide() {
    const g = this.guide; if (!g) return;
    this.guide = null; this.renderChips();
    if (g.tutorial) return;
    this.useHotspot(g.spot, { rec: g.rec, glow: true });
    this.app.sound.play('found', 0.25);
  }
  clearGuide() { this.guide = null; this.renderChips(); }
  guideToActive() {
    const hit = Object.entries(this.scenes).find(([id]) => id === 'content');
    const spot = hit?.[1].hotspots.find(x => x.active);
    if (spot) { this.guide = { sceneId: 'content', spot, rec: null, tutorial: true }; this.renderChips(); }
  }
  goRoom(roomId) {
    this.app.exitAll();
    if (this.sceneId === roomId) return;
    const sc = this.scenes[roomId]; const spot = sc?.hotspots.find(x => x.type === 'shelves' && x.groups?.length);
    this.guide = { sceneId: roomId, spot: spot ?? { stand: sc.spawn.default, poly: [[0, 0], [0, 0], [0, 0]] }, rec: null, tutorial: true, auto: true };
    this.walkGuide();
  }

  // ---------- 읽기(앉기) ----------
  sitToRead() {
    const sc = this.sc, H = this.H;
    if (!sc.seat) { H.dir = 'front'; H.sector = 4; H.state = 'idle'; return; }
    const [u, v, mirror] = sc.seat;
    this.walkTo(u + (mirror ? -0.02 : 0.02), v, { then: () => { if (this.app.mode === 'read') { H.state = 'read'; H.seatMirror = mirror; H.t = 0; } } });
  }
  standUp() {
    const H = this.H; if (H.state !== 'read') return;
    H.state = 'idle'; H.dir = 'front'; H.sector = 4; H.mirror = !!H.seatMirror;
  }

  // ---------- 그리기 ----------
  resize() {
    const r = $('#game').getBoundingClientRect(), dpr = Math.min(2, window.devicePixelRatio || 1);
    this.W = r.width; this.Hh = r.height; this.dpr = dpr;
    for (const cv of [this.bg, this.fg, this.olc]) { cv.width = Math.round(r.width * dpr); cv.height = Math.round(r.height * dpr); }
    this.gl.resize(r.width, r.height, dpr);
    this.bgKey = '';
    this.shelf.resize();
  }
  transform(im) {
    const W = this.W, Hh = this.Hh, iw = im.naturalWidth, ih = im.naturalHeight;
    const s = Math.max(W / iw, Hh / ih), dw = iw * s, dh = ih * s;
    const ox = clamp(W / 2 - this.focusU * dw, W - dw, 0), oy = (Hh - dh) / 2;
    return { ox, oy, dw, dh };
  }
  render(dt) {
    const sc = this.sc, im = this.imgSync(sc); if (!im) return;
    const H = this.H;
    // 화면이 사진보다 좁으면 Hana를 따라 옆으로 민다
    const fu = H.state === 'read' && sc.seat ? sc.seat[0] : H.u;
    this.focusU = damp(this.focusU, fu, 3, dt);
    const T = this.T = this.transform(im);
    const key = `${this.sceneId}|${T.ox.toFixed(1)}|${T.dw.toFixed(1)}|${this.W}|${this.Hh}`;
    if (key !== this.bgKey) {
      this.bgKey = key; const g = this.gb;
      g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.W, this.Hh);
      g.imageSmoothingQuality = 'high'; g.drawImage(im, T.ox, T.oy, T.dw, T.dh);
      this.placeChips();
    }
    // 길안내·마우스 올린 곳 테두리: Hana(3D 층)보다 아래 층에 그리고, 사진 속 더 가까운 가구 부분은 지운다
    const g = this.go;
    g.setTransform(this.dpr, 0, 0, this.dpr, 0, 0); g.clearRect(0, 0, this.W, this.Hh);
    const pulse = 0.55 + Math.sin(performance.now() / 260) * 0.3;
    const gs = this.nextStep();
    if (gs && gs.poly) this.outline(g, T, gs, `rgba(255,126,95,${pulse})`, 3, `rgba(255,126,95,${0.10 * pulse})`);
    if (this.hover && this.hover !== gs) this.outline(g, T, this.hover, 'rgba(255,255,255,0.85)', 2, 'rgba(255,255,255,0.10)');
    this.drawHana(T, dt);
  }
  outline(g, T, x, stroke, lw, fill) {
    const poly = x.poly;
    g.save();
    g.beginPath(); poly.forEach(([u, v], i) => { const px = T.ox + u * T.dw, py = T.oy + v * T.dh; if (i) g.lineTo(px, py); else g.moveTo(px, py); }); g.closePath();
    g.fillStyle = fill; g.fill(); g.lineWidth = lw; g.strokeStyle = stroke; g.lineJoin = 'round'; g.stroke();
    const m = this.occMask(x);
    if (m) { g.globalCompositeOperation = 'destination-out'; g.drawImage(m.canvas, T.ox + m.u0 * T.dw, T.oy + m.v0 * T.dh, (m.u1 - m.u0) * T.dw, (m.v1 - m.v0) * T.dh); }
    g.restore();
  }
  // 대상(문·서가)보다 사진 속에서 확실히 가까운 픽셀 = 테두리를 지울 곳
  occMask(x) {
    if (x._mask !== undefined) return x._mask;
    const D = this.dmap, fit = this.sc.depthFit;
    if (!D || !fit) return (x._mask = null);
    const us = x.poly.map(p => p[0]), vs = x.poly.map(p => p[1]);
    const u0 = Math.max(0, Math.min(...us) - 0.01), u1 = Math.min(1, Math.max(...us) + 0.01), v0 = Math.max(0, Math.min(...vs) - 0.01), v1 = Math.min(1, Math.max(...vs) + 0.01);
    const i0 = Math.floor(u0 * D.w), i1 = Math.ceil(u1 * D.w), j0 = Math.floor(v0 * D.h), j1 = Math.ceil(v1 * D.h);
    const inside = [];
    for (let j = j0; j < j1; j++) for (let i = i0; i < i1; i++) if (inPoly(x.poly, (i + 0.5) / D.w, (j + 0.5) / D.h)) inside.push(D.d[j * D.w + i]);
    if (!inside.length) return (x._mask = null);
    inside.sort((a, b) => a - b);
    const ref = inside[Math.floor(inside.length * 0.4)];
    const xr = Math.max(ref - fit[1], 0.02), m = Math.max(0.012, xr * xr * 0.45 / fit[0]);
    const cw = i1 - i0, ch = j1 - j0, c = document.createElement('canvas'); c.width = cw; c.height = ch;
    const g = c.getContext('2d'), img = g.createImageData(cw, ch);
    let any = false;
    for (let j = 0; j < ch; j++) for (let i = 0; i < cw; i++) {
      const d = D.d[(j + j0) * D.w + i + i0], a = clamp((d - ref - m) / m, 0, 1);
      if (a > 0) { img.data[(j * cw + i) * 4 + 3] = Math.round(a * 255); any = true; }
    }
    if (!any) return (x._mask = null);
    g.putImageData(img, 0, 0);
    return (x._mask = { canvas: c, u0: i0 / D.w, u1: i1 / D.w, v0: j0 / D.h, v1: j1 / D.h });
  }
  clipFor(state, dir) {
    const m = this.man;
    if (state === 'read') return m['read-seated'] ? 'read-seated' : this.clipFor('idle', 'front');
    if (state === 'wave') return m['wave-front'] ? 'wave-front' : this.clipFor('idle', 'front');
    const base = state === 'walk' || state === 'fast' ? 'walk' : 'idle';
    const order = [dir, ...DIRS.slice().sort((a, b) => Math.abs(DIRS.indexOf(a) - DIRS.indexOf(dir)) - Math.abs(DIRS.indexOf(b) - DIRS.indexOf(dir)))];
    for (const d of order) { if (m[`${base}-${d}`]) return `${base}-${d}`; if (base === 'idle' && m[`walk-${d}`]) return `walk-${d}`; }
    return Object.keys(m)[0];
  }
  // Hana: 3D 층에 사진 판·그림자로 그린다(앉기 전환은 서 있는 판과 앉은 판을 겹쳐 바꾼다)
  drawHana(T, dt) {
    const H = this.H, sc = this.sc, gl = this.gl, aspect = this.aspect();
    gl.setView(T, aspect);
    if (this.shelf.isOpen) { gl.setFigure(0, null); gl.setFigure(1, null); gl.render(); return; }
    // 그 자리 바닥 밝기·색으로 Hana 색을 맞춘다(햇빛 든 곳은 밝게)
    const fu = H.state === 'read' && sc.seat ? sc.seat[0] : H.u, fv = H.state === 'read' && sc.seat ? sc.seat[1] : H.v;
    this.light?.at(fu, fv, this.tint);
    this.tintS.lerp(this.tint, 1 - Math.exp(-4 * dt));
    gl.setFigure(0, H.sit < 0.99 ? this.figure(dt, H.state === 'read' ? 'idle' : H.state, H.dir, { u: H.u, v: H.v }, 1 - H.sit, H.mirror, false) : null, aspect);
    gl.setFigure(1, H.sit > 0.01 && sc.seat ? this.figure(dt, 'read', 'front', { u: sc.seat[0], v: sc.seat[1] }, H.sit, !!sc.seat[2], true) : null, aspect);
    gl.render();
  }
  figure(dt, state, dir, pos, alpha, mirror, seated) {
    const H = this.H, key = this.clipFor(state, dir), clip = this.man[key], sheet = this.sheets.get(key);
    if (!clip || !sheet) return null;
    if (!seated) {
      if (H.clip !== key) { H.clip = key; H.t = 0; }
      let rate = 1;
      if (key.startsWith('walk-') && (state === 'walk' || state === 'fast')) rate = clamp(H.speed / 1.25, 0.6, 2.2);
      else if (key.startsWith('walk-')) rate = 0;
      H.t += dt * rate;
      if (state === 'wave' && H.t * clip.fps >= clip.frames - 1) H.state = 'idle';
    } else H.st = (H.st ?? 0) + dt;
    const t = seated ? H.st : H.t;
    let f = Math.floor(t * clip.fps); f = clip.mode === 'loop' ? f % clip.frames : Math.min(clip.frames - 1, f);
    return { tex: this.gl.texFor(key, sheet), clip, frame: f, u: pos.u, v: pos.v, mirror, alpha, seated, personH: seated ? 1.32 : PERSON, tint: this.tintS };
  }
  wave() { if (this.man['wave-front']) { this.H.state = 'wave'; this.H.t = 0; this.H.clip = null; } }

  // ---------- 글자표(문 이름·서가 이름) ----------
  renderChips() {
    if (!this.sc) return;
    this.chips.innerHTML = '';
    const gs = this.nextStep();
    for (const x of this.sc.hotspots ?? []) {
      if (!x.chip) continue;
      let text = '', color = null;
      if (x.type === 'door') { const r = this.app.world.roomById.get(x.to); text = r?.name ?? (x.to === 'hall' ? this.app.config.copy.hall : ''); color = this.app.world.roomCfg.get(x.to)?.spine; }
      else if (x.type === 'shelves') { if (!x.groups?.length) continue; text = groupTitle(x.groups); }
      if (!text) continue;
      const el = h('button', { class: `pchip${x === gs ? ' guide' : ''}${x.active ? ' active' : ''}`, type: 'button', tabindex: -1, onclick: () => this.goHotspot(x) }, color ? h('i', { style: { background: color } }) : null, text);
      el.dataset.u = x.chip[0]; el.dataset.v = x.chip[1];
      this.chips.append(el);
    }
    if (this.sc.exit) {
      const el = h('button', { class: `pchip exit${gs?.type === 'exit' ? ' guide' : ''}`, type: 'button', tabindex: -1, onclick: () => { const ex = this.sc.exit; this.walkTo(this.H.u, ex.v - 0.005, { then: () => this.leave() }); } }, `↓ ${this.sc.exit.label}`);
      el.dataset.u = 0.5; el.dataset.v = 0.985; this.chips.append(el);
    }
    this.placeChips();
  }
  placeChips() {
    const T = this.T; if (!T) return;
    for (const el of this.chips.children) {
      if (el.classList.contains('exit')) continue;
      const half = (el.offsetWidth || 120) / 2;
      const x = clamp(T.ox + Number(el.dataset.u) * T.dw, half + 8, this.W - half - 8), y = Math.max(el.offsetHeight + 56, T.oy + Number(el.dataset.v) * T.dh);
      el.style.transform = `translate(${Math.round(x)}px, ${Math.round(y)}px) translate(-50%, -100%)`;
    }
  }
  drawMinimap() {
    const c = this.app.layout.chambers.find(ch => ch.kind === 'room' && ch.room === this.sceneId);
    const pos = c ? { x: c.x, z: c.z } : this.sceneId === 'outside' ? this.app.layout.spawn : { x: 0, z: 0 };
    this.app.ui.drawMinimap(pos, Math.PI, c ? this.sceneId : null);
  }
  planPos() {
    const c = this.app.layout.chambers.find(ch => ch.kind === 'room' && ch.room === this.sceneId);
    return c ? { x: c.x, z: c.z } : this.sceneId === 'outside' ? this.app.layout.spawn : { x: 0, z: 0 };
  }

  // ---------- 책 열기·닫기 ----------
  openBook(item, parentBook = null) {
    const app = this.app;
    app.ui.hideCard();
    app.mode = 'read';
    app.tutorial.opened();
    app.reader.open(item, { goTo: null });
    if (this.shelf.isOpen) this.shelf.close();
    this.shelf.pulled = null;
    app.onResize();
    this.sitToRead();
    void parentBook;
  }
  putBack() {
    const app = this.app;
    app.ui.hideCard();
    this.shelf.putBack();
    if (!this.shelf.isOpen) app.mode = 'explore';
    app.sound.play('pull', 0.2);
    if (!this.shelf.isOpen) this.focus();
  }
  closeReader() {
    const app = this.app;
    app.reader.close(); app.onResize();
    this.standUp();
    if (app.ui.cardOpen) app.ui.hideCard();
    this.shelf.pulled = null;
    app.mode = this.shelf.isOpen ? 'shelf' : 'explore';
    this.focus();
  }
  exitShelf() {
    this.shelf.close();
    this.app.mode = 'explore';
    this.focus();
  }
  exitAll() {
    const app = this.app;
    if (app.ui.overlayOpen) app.ui.closeOverlay();
    if (app.reader.isOpen) { app.reader.close(); app.onResize(); }
    if (app.ui.cardOpen) app.ui.hideCard();
    if (this.shelf.isOpen) this.shelf.close();
    this.shelf.pulled = null;
    this.standUp();
    app.mode = 'explore'; this.path = null; this.clearGuide();
  }

  // ---------- 입력 ----------
  setupInput() {
    const cv = this.fg;
    const toUV = e => { const r = cv.getBoundingClientRect(), T = this.T; if (!T) return null; return { u: (e.clientX - r.left - T.ox) / T.dw, v: (e.clientY - r.top - T.oy) / T.dh }; };
    cv.addEventListener('contextmenu', e => e.preventDefault());
    cv.addEventListener('pointerdown', e => { cv.focus({ preventScroll: true }); if (e.button === 0) this.downAt = { x: e.clientX, y: e.clientY }; });
    cv.addEventListener('pointermove', e => {
      const p = toUV(e); if (!p) return;
      const x = this.app.mode === 'explore' || this.app.mode === 'read' ? this.hotspotAt(p.u, p.v) : null;
      if (x !== this.hover) { this.hover = x; cv.style.cursor = x ? 'pointer' : ''; cv.title = x ? this.labelOf(x) : ''; }
    });
    cv.addEventListener('pointerleave', () => { this.hover = null; });
    cv.addEventListener('pointerup', e => {
      if (e.button !== 0 || !this.downAt || Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > 6) { this.downAt = null; return; }
      this.downAt = null;
      const app = this.app; if (app.mode !== 'explore' && app.mode !== 'read') return;
      const p = toUV(e); if (!p) return;
      const x = this.hotspotAt(p.u, p.v);
      if (x) { if (this.H.state === 'read') return; this.goHotspot(x); return; }
      if (this.H.state === 'read') return;
      if (this.sc.exit && p.v > this.sc.exit.v - 0.01) { this.walkTo(this.H.u, this.sc.exit.v - 0.005, { then: () => this.leave() }); return; }
      this.walkTo(p.u, p.v);
    });
  }
  onKey(e) {
    if (this.shelf.isOpen) return this.shelf.key(e);
    return false;
  }
  focus() { this.fg.focus({ preventScroll: true }); }
}

// ---------- 도형 ----------
export function inPoly(poly, u, v) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > v) !== (yj > v) && u < (xj - xi) * (v - yi) / (yj - yi) + xi) c = !c;
  }
  return c;
}
function area(poly) { let a = 0; for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) a += (poly[j][0] + poly[i][0]) * (poly[j][1] - poly[i][1]); return Math.abs(a / 2); }
function centroid(poly) { const n = poly.length; return [poly.reduce((s, p) => s + p[0], 0) / n, poly.reduce((s, p) => s + p[1], 0) / n]; }
export function groupTitle(groups) {
  const names = groups.map(g => g.wall.label || g.wall.title);
  return names.length > 2 ? `${names.slice(0, 2).join(' · ')} 외 ${names.length - 2}` : names.join(' · ');
}
const wait = ms => new Promise(r => setTimeout(r, ms));

// 사진을 64×36으로 줄여 두고, 발밑 바닥 밝기·색을 읽는다
function lightGrid(img) {
  if (!img) return null;
  const W = 64, H = 36, c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const d = g.getImageData(0, 0, W, H).data;
  let R = 0, G = 0, B = 0; for (let i = 0; i < d.length; i += 4) { R += d[i]; G += d[i + 1]; B += d[i + 2]; }
  const n = d.length / 4; R /= n; G /= n; B /= n;
  const Lm = 0.3 * R + 0.59 * G + 0.11 * B;
  // 사진 전체 색(따뜻한 정도)을 18%만 섞는다
  const base = [1 + 0.18 * (R / Lm - 1), 1 + 0.18 * (G / Lm - 1), 1 + 0.18 * (B / Lm - 1)];
  return {
    at(u, v, out) {
      let L = 0, k = 0;
      for (let y = Math.floor((v - 0.03) * H); y <= Math.floor((v + 0.01) * H); y++) for (let x = Math.floor((u - 0.04) * W); x <= Math.floor((u + 0.04) * W); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue;
        const i = (y * W + x) * 4; L += 0.3 * d[i] + 0.59 * d[i + 1] + 0.11 * d[i + 2]; k++;
      }
      const f = k ? clamp(Math.pow(L / k / Lm, 0.3), 0.88, 1.1) : 1;
      out.setRGB(base[0] * f * 0.97, base[1] * f * 0.97, base[2] * f * 0.97);
    },
  };
}

// 깊이 지도를 672폭으로 줄여 값만 꺼내 둔다(테두리 가림용)
function depthData(img) {
  if (!img) return null;
  const w = 672, h = Math.round(672 * img.naturalHeight / img.naturalWidth);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
  const px = g.getImageData(0, 0, w, h).data, d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) d[i] = px[i * 4] / 255;
  return { w, h, d };
}
