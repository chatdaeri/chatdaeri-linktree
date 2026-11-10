// 건물 만들기: 홀·현관·복도·방·안쪽 서고·이동식 서가 서고의 벽·바닥·천장·문·창·명판·소품, 조명, 충돌 격자
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { NavGrid } from './nav.js';
import { toWorld, toLocal, wallFrame, textTexture, clamp, damp } from './util.js';
import { texMat, meterUV, TILE, forestBackdrop, forestTrees } from './look.js';

const WALL_T = 0.3;
const DOOR_H = { gate: 4.2, auto: 3.0, vault: 2.6, open: 2.7, stair: 3.4 };

export class World {
  constructor(scene, data, config) {
    this.scene = scene; this.data = data; this.config = config;
    this.layout = data.palace.layout;
    this.palace = data.palace;
    this.group = new THREE.Group(); scene.add(this.group);
    this.occluders = [];      // 카메라 가림 처리 대상(벽)
    this.colliders = [];      // 카메라 충돌(벽)
    this.doors = [];          // 자동문
    this.interactables = [];  // E로 쓰는 것
    this.seats = [];          // 열람 의자
    this.roomLights = new Map();
    this.chamberById = new Map(this.layout.chambers.map(c => [c.id, c]));
    this.roomById = new Map(this.palace.rooms.map(r => [r.id, r]));
    this.roomCfg = new Map(config.rooms.map(r => [r.id, r]));
    this.mats = this.makeMaterials();
    this.nav = new NavGrid(this.layout.bounds, config.movement.grid);
  }

  makeMaterials() {
    // 재질 사진(assets/tex)을 입힌 실사 재질. 사진이 없으면 단색으로 남는다.
    const stone = texMat('travertine', { roughness: 0.82, bump: 0.5 });
    const stoneOut = texMat('travertine', { roughness: 0.88, bump: 0.6, color: 0xF4EEE4 });
    const trim = texMat('limestone', { roughness: 0.7, color: 0xE6DCCB });
    const oak = texMat('oak', { roughness: 0.62, bump: 0.25 });
    const oakDark = texMat('oak', { roughness: 0.6, bump: 0.25, color: 0xC9AE8A });
    const glass = new THREE.MeshPhysicalMaterial({ color: 0xF2F6F5, roughness: 0.04, metalness: 0, transparent: true, opacity: 0.14, depthWrite: false, envMapIntensity: 1.4, side: THREE.DoubleSide });
    const mullion = new THREE.MeshStandardMaterial({ color: 0x8C8781, roughness: 0.38, metalness: 0.7 });
    const metal = new THREE.MeshStandardMaterial({ color: 0xA7A29A, roughness: 0.35, metalness: 0.75 });
    const ceiling = texMat('plaster', { roughness: 0.95, bump: 0.3, color: 0xFBF7F0 });
    ceiling.shadowSide = THREE.DoubleSide;
    const ground = texMat('gravel', { roughness: 1, bump: 1.0 });
    const grass = texMat('moss', { roughness: 1, bump: 1.0 });
    const floorOak = texMat('oakfloor', { roughness: 0.5, bump: 0.35 });
    const floorStone = texMat('limestone', { roughness: 0.42, bump: 0.25, color: 0xDCD3C4 });
    const accent = new THREE.MeshStandardMaterial({ color: 0xFF7E5F, emissive: 0xFF7E5F, emissiveIntensity: 1.4, roughness: 0.4 });
    const plant = new THREE.MeshStandardMaterial({ color: 0x8FA27E, roughness: 0.9 });
    const pot = new THREE.MeshStandardMaterial({ color: 0xE8E1D5, roughness: 0.8 });
    return { stone, stoneOut, trim, oak, oakDark, glass, mullion, metal, ceiling, ground, grass, floorOak, floorStone, accent, plant, pot };
  }

  async build(progress = () => {}) {
    this.buildGround();
    progress(0.1, '홀을 세우는 중');
    this.buildHall();
    const chambers = this.layout.chambers;
    chambers.forEach((c, i) => { this.nav.addChamber(c, i); this.chamberIndex.set(c.id, i); });
    // 이동식 서가가 바로 붙은 안쪽 서고는 뒷벽을 이동식 서가 앞벽이 대신한다
    for (const c of chambers.filter(c => c.kind === 'stack')) {
      if (!this.chamberById.has(`pass-${c.id}`)) { const alc = this.chamberById.get(c.doors[0].to); if (alc) alc.skipBack = true; }
    }
    progress(0.25, '방을 짓는 중');
    for (const c of chambers) this.buildChamber(c);
    this.buildLights();
    progress(0.4, '가구를 들이는 중');
    await this.buildProps();
    return this;
  }
  get chamberIndex() { return this._ci ??= new Map(); }

  // ---------- 바깥 ----------
  buildGround() {
    const b = this.layout.bounds;
    const center = { x: (b.minX + b.maxX) / 2, z: (b.minZ + b.maxZ) / 2 };
    const R = Math.hypot(b.maxX - b.minX, b.maxZ - b.minZ) / 2 + 22;
    this.group.add(forestBackdrop(center, R));
    const HR = this.layout.hall.r;
    // 정문 앞 마당(석재)과 자갈길
    const plazaZ0 = HR + 4.5, plazaZ1 = plazaZ0 + 12;
    // 나무줄기: 건물·마당·길에서 4m 이상 떨어진 곳에
    const nearBuilding = (x, z) => Math.hypot(x, z) < HR + 5 || this.layout.chambers.some(c => { const l = toLocal(c, x, z); return l.u > -c.w / 2 - 4 && l.u < c.w / 2 + 4 && l.v > -4 && l.v < c.d + 4; });
    this.group.add(forestTrees(center, 0, R - 4, (x, z) => nearBuilding(x, z) || (Math.abs(x) < 11 && z > HR && z < plazaZ1 + 45)));
    const plaza = new THREE.Mesh(meterUV(new THREE.BoxGeometry(16, 0.04, plazaZ1 - plazaZ0), TILE.limestone, [0, 0, (plazaZ0 + plazaZ1) / 2]), this.mats.floorStone);
    plaza.position.set(0, -0.01, (plazaZ0 + plazaZ1) / 2); plaza.receiveShadow = true; this.group.add(plaza);
    const path = new THREE.Mesh(meterUV(new THREE.BoxGeometry(4, 0.03, 40), TILE.gravel), this.mats.ground);
    path.position.set(0, -0.015, plazaZ1 + 20); path.receiveShadow = true; this.group.add(path);
    this.nav.addRect(-8, plazaZ0, 8, plazaZ1, -2);
    this.nav.addRect(-2, plazaZ1, 2, plazaZ1 + 8, -2);
    // 마당 가장자리 막기
    this.nav.blockSegment(-8, plazaZ0, -8, plazaZ1, 0.05); this.nav.blockSegment(8, plazaZ0, 8, plazaZ1, 0.05);
    this.nav.blockSegment(-8, plazaZ1, -2, plazaZ1, 0.05); this.nav.blockSegment(2, plazaZ1, 8, plazaZ1, 0.05);
    this.nav.blockSegment(-2, plazaZ1 + 8, 2, plazaZ1 + 8, 0.05);
  }

  // ---------- 홀 ----------
  buildHall() {
    const { r: R, height: H, doors } = this.layout.hall;
    const CL0 = Math.min(5.0, H - 2), CL1 = H - 0.8; // 둘레 고창 띠(사진의 홀처럼 숲이 보이는 유리)
    this.hallBand = [CL0, CL1];
    this.nav.addDisk(0, 0, R - 0.1, -1);
    const floor = new THREE.Mesh(meterUV(new THREE.CircleGeometry(R, 96), TILE.limestone), this.mats.floorStone);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true; this.group.add(floor);
    const ceil = new THREE.Mesh(meterUV(new THREE.RingGeometry(2.2, R + 0.2, 96), TILE.plaster), this.mats.ceiling);
    ceil.rotation.x = Math.PI / 2; ceil.position.y = H; ceil.castShadow = true; this.group.add(ceil);
    const oculus = new THREE.Mesh(new THREE.CircleGeometry(2.2, 48), new THREE.MeshStandardMaterial({ color: 0xFFFFFF, emissive: 0xFFFFFF, emissiveIntensity: 1.1 }));
    oculus.rotation.x = Math.PI / 2; oculus.position.y = H + 0.01; this.group.add(oculus);
    // 원형 벽(문 자리 비움)
    const segs = 120, open = doors.map(d => ({ a: d.angle, half: (d.width / 2 + 0.08) / R, h: DOOR_H[d.kind] ?? 3.2 }));
    const angOf = i => (i / segs) * Math.PI * 2; // 북쪽에서 시계 방향
    const pos = a => ({ x: Math.sin(a) * R, z: -Math.cos(a) * R });
    // 문과 문 사이 벽을 한 덩어리로 합친다(그리기 횟수 절약). 문 위 인방은 따로.
    let arc = [];
    const flush = () => { if (arc.length) { this.mergedWall(arc); arc = []; } };
    const start = (() => { for (let i = 0; i < segs; i++) { const mid = (angOf(i) + angOf(i + 1)) / 2; if (open.some(o => Math.abs(angDelta(mid, o.a)) < o.half)) return i; } return 0; })();
    for (let k = 0; k < segs; k++) {
      const i = (start + k) % segs;
      const a0 = angOf(i), a1 = angOf(i + 1), mid = (a0 + a1) / 2;
      const hit = open.find(o => Math.abs(angDelta(mid, o.a)) < o.half);
      const p0 = pos(a0), p1 = pos(a1);
      if (hit) { flush(); this.wallPiece(p0, p1, hit.h, CL0, this.mats.stone, true); this.wallPiece(p0, p1, CL1, H, this.mats.stone, true); }
      else { arc.push([p0, p1]); this.nav.blockSegment(p0.x, p0.z, p1.x, p1.z, WALL_T / 2); }
    }
    flush();
    // 2층 회랑 띠
    const gallery = new THREE.Mesh(new THREE.TorusGeometry(R - 0.5, 0.06, 6, 96), this.mats.trim);
    gallery.rotation.x = Math.PI / 2; gallery.position.y = 4.3; this.group.add(gallery);
    const ledge = new THREE.Mesh(new THREE.RingGeometry(R - 1.0, R - 0.15, 96, 1), this.mats.trim);
    ledge.rotation.x = -Math.PI / 2; ledge.position.y = 4.2; this.group.add(ledge);
    const under = ledge.clone(); under.rotation.x = Math.PI / 2; under.position.y = 4.19; this.group.add(under);
    // 둘레 고창: 유리 원통 + 가는 금속 세로살
    const band = new THREE.Mesh(new THREE.CylinderGeometry(R, R, CL1 - CL0, 96, 1, true), this.mats.glass);
    band.position.y = (CL0 + CL1) / 2; band.userData.noAO = true; this.group.add(band);
    const nb = Math.round(Math.PI * 2 * R / 1.4), bars = [];
    for (let i = 0; i < nb; i++) { const a = i / nb * Math.PI * 2, p = pos(a); const g = new THREE.BoxGeometry(0.05, CL1 - CL0, 0.09); g.rotateY(-a); g.translate(p.x, (CL0 + CL1) / 2, p.z); bars.push(g); }
    this.group.add(new THREE.Mesh(mergeGeometries(bars), this.mats.mullion));
    // 문·명판
    for (const d of doors) {
      const p = pos(d.angle), inward = { x: -Math.sin(d.angle), z: Math.cos(d.angle) };
      const h = DOOR_H[d.kind] ?? 3.2;
      if (d.kind !== 'stair') this.addSlidingDoor(p, d.angle, d.width, h, d.kind === 'gate' ? 'gate' : d.room);
      const room = d.room ? this.roomById.get(d.room) : null;
      const cfg = d.room ? this.roomCfg.get(d.room) : null;
      const title = room ? room.routerName : this.config.title;
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(2.8, 0.5), new THREE.MeshStandardMaterial({ map: textTexture(title, { width: 1120, height: 200, size: 104, bg: '#FBF9F5', border: '#D6CFC3' }), roughness: 0.8 }));
      plate.position.set(p.x + inward.x * 0.17, h + 0.5, p.z + inward.z * 0.17); plate.rotation.y = -d.angle;
      this.group.add(plate);
      if (room) {
        const sw = new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.5, 0.04), new THREE.MeshStandardMaterial({ color: cfg.spine, roughness: 0.6 }));
        sw.position.copy(plate.position).add(new THREE.Vector3(0, -0.42, 0)); sw.rotation.copy(plate.rotation); this.group.add(sw);
        const side = rightOfAngle(d.angle);
        const pq = new THREE.Mesh(new THREE.PlaneGeometry(0.86, 0.62), new THREE.MeshStandardMaterial({ map: paragraphTexture(room.name, room.aliases || cfg.kind, `${room.count.books.toLocaleString('ko-KR')}권`), roughness: 0.85 }));
        const off = d.width / 2 + 0.75;
        pq.position.set(p.x + inward.x * 0.17 - side.x * off, 1.55, p.z + inward.z * 0.17 - side.z * off); pq.rotation.copy(plate.rotation);
        this.group.add(pq);
      }
    }
  }

  // ---------- 방 하나 ----------
  buildChamber(c) {
    const cfg = c.room ? this.roomCfg.get(c.room) : null;
    const walls = ['back', 'front', 'left', 'right'].filter(w => !(c.noWalls ?? []).includes(w) && !(w === 'front' && c.sharedFront) && !(w === 'back' && c.skipBack));
    const fy = c.floorY ?? 0, fy2 = c.floorY2 ?? fy;
    const ramp = fy2 !== fy;
    // 바닥
    const floorMat = this.mats.floorStone; // 방 사진이 모두 석회석 바닥
    const floor = new THREE.Mesh(meterUV(new THREE.BoxGeometry(c.w, 0.1, ramp ? Math.hypot(c.d, fy2 - fy) : c.d), floorMat === this.mats.floorOak ? TILE.oakfloor : TILE.limestone), floorMat);
    const mid = toWorld(c, 0, c.d / 2);
    floor.position.set(mid.x, (fy + fy2) / 2 - 0.05, mid.z);
    floor.rotation.order = 'YXZ'; floor.rotation.y = -c.angle; if (ramp) floor.rotation.x = Math.atan2(fy2 - fy, c.d);
    floor.receiveShadow = true; this.group.add(floor);
    if (fy > 0 || fy2 > 0) { // 다락·경사로 아래를 막는 받침
      const base = new THREE.Mesh(new THREE.BoxGeometry(c.w, Math.max(fy, fy2), c.d), this.mats.stoneOut);
      base.position.set(mid.x, Math.max(fy, fy2) / 2 - 0.1, mid.z); base.rotation.y = -c.angle; this.group.add(base);
    }
    if (c.kind !== 'portico') {
      const ceil = new THREE.Mesh(meterUV(new THREE.PlaneGeometry(c.w, c.d), TILE.plaster), this.mats.ceiling);
      ceil.castShadow = true;
      ceil.position.set(mid.x, fy2 + c.h, mid.z); ceil.rotation.order = 'YXZ'; ceil.rotation.y = -c.angle; ceil.rotation.x = Math.PI / 2;
      this.group.add(ceil);
    }
    // 창 자리(벽에 구멍을 내고 유리를 끼운다): 벽 → [{ a, b, y0, y1 }]
    const openings = new Map(), winList = [];
    const addOpen = (w, opt = {}) => {
      const y0 = opt.y0 ?? (c.kind === 'room' ? 0.35 : Math.min(1.1, c.h * 0.25));
      const h = opt.h ?? (c.kind === 'room' ? Math.min(c.h - y0 - 0.5, 6) : Math.min(c.h - y0 - 0.4, 3.6));
      const o = { a: w.at - w.width / 2, b: w.at + w.width / 2, y0, y1: y0 + h };
      if (!openings.has(w.wall)) openings.set(w.wall, []);
      openings.get(w.wall).push(o);
      winList.push([w, { ...opt, y0, h }]);
    };
    for (const w of c.windows ?? []) addOpen(w);
    // 방의 바깥벽 중 서가·문이 없는 구간은 바닥부터 천장 가까이까지 유리벽(방 사진처럼 숲이 보이게)
    const glassSpans = [];
    if (c.kind === 'room') {
      for (const wall of ['left', 'right', 'back']) {
        if (!walls.includes(wall)) continue;
        const len = wall === 'back' ? c.w : c.d;
        const busy = [];
        for (const d of c.doors.filter(d => d.wall === wall)) busy.push([d.at - d.width / 2 - 0.5, d.at + d.width / 2 + 0.5]);
        for (const pl of Object.values(this.layout.place ?? {})) if (pl.chamber === c.id && pl.wall === wall && !pl.stack) busy.push([pl.at - 0.3, pl.at + pl.bays + 0.3]);
        for (const o of openings.get(wall) ?? []) busy.push([o.a - 0.5, o.b + 0.5]);
        busy.sort((p, q) => p[0] - q[0]);
        let x = 0.6;
        const free = [];
        for (const [a, b] of [...busy, [len - 0.6, len + 1]]) { if (a - x >= 1.4) free.push([x, a]); x = Math.max(x, b); }
        for (const [a, b] of free) {
          const outside = [0.15, 0.5, 0.85].every(t => { const fr = wallFrame(c, wall, a + (b - a) * t); const q = toWorld(c, fr.u - fr.nu * 1.2, fr.v - fr.nv * 1.2); return this.regionAt(q.x, q.z).kind === 'outside'; });
          if (!outside) continue;
          addOpen({ wall, at: (a + b) / 2, width: b - a }, { y0: 0.06, h: Math.min(c.h - 0.66, 6.4) });
          glassSpans.push([wall, a, b]);
        }
      }
    }
    // 정문 현관: 정면을 석회석 기둥 사이 유리벽으로(오프닝 영상의 건물 정면과 맞춘다)
    if (c.kind === 'portico') {
      const gate = c.doors.find(d => d.wall === 'front');
      const spans = [[0.5, gate.at - gate.width / 2 - 0.5], [gate.at + gate.width / 2 + 0.5, c.w - 0.5]];
      for (const [a, b] of spans) addOpen({ wall: 'front', at: (a + b) / 2, width: b - a }, { y0: 0.25, h: c.h - 1.0 });
    }
    // 두 층 높이 방: 서가 위 높은 창 띠(서가 높이 2.5m 위 빈 벽)
    if (c.kind === 'room' && c.h > 5) {
      for (const wall of ['back', 'left', 'right']) {
        const len = wall === 'back' ? c.w : c.d;
        const n = Math.floor((len - 2) / 3.2);
        for (let i = 0; i < n; i++) {
          const at = 1 + (len - 2) * (i + 0.5) / n;
          if (glassSpans.some(([w2, a, b]) => w2 === wall && at + 1.1 > a && at - 1.1 < b)) continue; // 유리벽과 겹치면 생략
          addOpen({ wall, at, width: 2.2 }, { y0: 3.6, h: c.h - 4.5 });
        }
      }
    }
    // 벽
    for (const wall of walls) {
      const len = wall === 'back' || wall === 'front' ? c.w : c.d;
      const doors = c.doors.filter(d => d.wall === wall).map(d => ({ a: d.at - d.width / 2, b: d.at + d.width / 2, h: DOOR_H[d.kind] ?? 2.7, d }));
      let cuts = [[c.kind === 'corridor' && (wall === 'left' || wall === 'right') ? 0.32 : 0, len]];
      // 복도 벽은 홀 벽에 박히지 않게 앞쪽을 조금 남긴다(left는 앞에서, right는 뒤에서 시작)
      if (c.kind === 'corridor' && wall === 'right') cuts = [[0, len - 0.32]];
      for (const o of doors) cuts = cuts.flatMap(([s, e]) => (o.b <= s || o.a >= e ? [[s, e]] : [[s, o.a], [o.b, e]].filter(([x, y]) => y - x > 0.02)));
      const heightAt = at => { if (!ramp) return fy; const fr = wallFrame(c, wall, at); return fy + (fy2 - fy) * clamp(fr.v / c.d, 0, 1); };
      const opens = openings.get(wall) ?? [];
      for (const [s, e] of cuts) {
        const a = this.wallPt(c, wall, s), b = this.wallPt(c, wall, e);
        this.nav.blockSegment(a.x, a.z, b.x, b.z, WALL_T / 2);
        // 창 가장자리에서 벽을 나눠 창 자리는 아래·위만 남긴다
        const xs = [s, e, ...opens.flatMap(o => [o.a, o.b])].filter(x => x >= s && x <= e).sort((p, q) => p - q);
        for (let i = 0; i < xs.length - 1; i++) {
          const x0 = xs[i], x1 = xs[i + 1];
          if (x1 - x0 < 0.02) continue;
          const pa = this.wallPt(c, wall, x0), pb = this.wallPt(c, wall, x1);
          const base = Math.min(heightAt(x0), heightAt(x1)), top = Math.max(heightAt(x0), heightAt(x1)) + c.h;
          const o = opens.find(o => o.a <= (x0 + x1) / 2 && o.b >= (x0 + x1) / 2);
          if (!o) { this.wallPiece(pa, pb, base - 0.05, top, this.mats.stone, false, c); continue; }
          this.wallPiece(pa, pb, base - 0.05, base + o.y0, this.mats.stone, false, c);
          this.wallPiece(pa, pb, base + o.y1, top, this.mats.stone, false, c);
        }
      }
      for (const o of doors) { // 문 위 인방
        const a = this.wallPt(c, wall, o.a), b = this.wallPt(c, wall, o.b);
        const y = heightAt(o.d.at);
        if (c.h > o.h) this.wallPiece(a, b, y + o.h, y + c.h, this.mats.stone, false, c);
        if (o.d.kind === 'vault') this.addVaultDoor(c, o.d);
      }
    }
    // 창(유리·창살)
    for (const [w, opt] of winList) this.addWindow(c, w, opt);
    // 방 입구 안내판(복도 쪽)
    if (c.kind === 'room' && cfg) {
      const room = this.roomById.get(c.room);
      const fr = wallFrame(c, 'front', c.w / 2 + c.doors[0].width / 2 + 0.75);
      const p = toWorld(c, fr.u, -0.17);
      const sign = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.6), new THREE.MeshStandardMaterial({ map: paragraphTexture(cfg.ownerLabel, `${room.name} · ${cfg.kind}`, ''), roughness: 0.85 }));
      sign.position.set(p.x, fy + 1.6, p.z); sign.rotation.y = -c.angle; this.group.add(sign);
      // 안쪽 서고 입구 표시
      for (const d of c.doors.filter(d => d.wall === 'back')) {
        const f = wallFrame(c, 'back', d.at), q = toWorld(c, f.u, c.d - 0.16);
        const t = new THREE.Mesh(new THREE.PlaneGeometry(1.5, 0.26), new THREE.MeshStandardMaterial({ map: textTexture(this.config.copy.innerStack, { width: 600, height: 104, size: 52, bg: '#FBF9F5' }), roughness: 0.8 }));
        t.position.set(q.x, fy + 2.95, q.z); t.rotation.y = -c.angle; this.group.add(t);
      }
    }
    if (c.kind === 'stack' || c.kind === 'alcove') {
      const f = toWorld(c, 0, 0.3);
      const t = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.3), new THREE.MeshStandardMaterial({ map: textTexture(c.label, { width: 880, height: 120, size: 50, bg: '#FBF9F5' }), roughness: 0.8 }));
      const back = toWorld(c, 0, 0.17);
      if (c.kind === 'stack') { t.position.set(back.x, fy + 2.95, back.z); t.rotation.y = -c.angle + Math.PI; this.group.add(t); }
      void f;
    }
  }
  mergedWall(pairs) {
    const H = this.layout.hall.height, geos = [], [CL0, CL1] = this.hallBand;
    for (const [a, b] of pairs) {
      const len = Math.hypot(b.x - a.x, b.z - a.z) + 0.06;
      for (const [y0, y1] of [[0, CL0], [CL1, H]]) {
        const g = meterUV(new THREE.BoxGeometry(len, y1 - y0, WALL_T), TILE.travertine, [Math.atan2((a.x + b.x) / 2, -(a.z + b.z) / 2) * this.layout.hall.r, (y0 + y1) / 2, 0]);
        g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x)); g.translate((a.x + b.x) / 2, (y0 + y1) / 2, (a.z + b.z) / 2);
        geos.push(g);
      }
    }
    const m = new THREE.Mesh(mergeGeometries(geos), this.mats.stone.clone());
    m.receiveShadow = true; m.castShadow = true; m.userData.wall = true; m.userData.chamber = 'hall';
    this.group.add(m); this.occluders.push(m); this.colliders.push(m);
    // 바닥 걸레받이
    const geos2 = pairs.map(([a, b]) => { const len = Math.hypot(b.x - a.x, b.z - a.z) + 0.06; const g = new THREE.BoxGeometry(len, 0.14, WALL_T + 0.04); g.rotateY(-Math.atan2(b.z - a.z, b.x - a.x)); g.translate((a.x + b.x) / 2, 0.07, (a.z + b.z) / 2); return g; });
    const sk = new THREE.Mesh(mergeGeometries(geos2), this.mats.trim); this.group.add(sk);
  }
  wallPt(c, wall, at) { const f = wallFrame(c, wall, at); return toWorld(c, f.u, f.v); }
  wallPiece(a, b, y0, y1, mat, hall = false, c = null) {
    const len = Math.hypot(b.x - a.x, b.z - a.z);
    if (len < 0.01 || y1 - y0 < 0.01) return null;
    // 같은 벽 줄의 조각끼리 돌 줄눈이 이어지게: 벽 방향 좌표·높이를 UV에 더한다
    const dx = (b.x - a.x) / len, dz = (b.z - a.z) / len, mx = (a.x + b.x) / 2, mz = (a.z + b.z) / 2;
    const along = mx * dx + mz * dz;
    const geo = meterUV(new THREE.BoxGeometry(len + (hall ? 0.06 : WALL_T), y1 - y0, WALL_T), TILE.travertine, [along, (y0 + y1) / 2, 0]);
    const m = new THREE.Mesh(geo, mat.clone());
    m.position.set(mx, (y0 + y1) / 2, mz);
    m.rotation.y = -Math.atan2(b.z - a.z, b.x - a.x);
    m.castShadow = true; m.receiveShadow = true;
    m.userData.wall = true; m.userData.chamber = c?.id ?? 'hall';
    this.group.add(m); this.occluders.push(m); this.colliders.push(m);
    return m;
  }
  addWindow(c, w, opt = {}) {
    const fr = wallFrame(c, w.wall, w.at);
    const p = toWorld(c, fr.u, fr.v); // 벽 구멍 한가운데
    const y = (c.floorY ?? 0) + (opt.y0 ?? Math.min(1.1, c.h * 0.25));
    const hgt = opt.h ?? Math.min(c.h - y - 0.4, 3.6);
    const g = new THREE.Group();
    const pane = new THREE.Mesh(new THREE.PlaneGeometry(w.width, hgt), this.mats.glass); pane.userData.noAO = true; g.add(pane);
    // 가는 금속 창살(사진처럼 1.4m 간격 세로살, 가로살은 위·아래만)
    const n = Math.max(1, Math.round(w.width / 1.4)), bars = [];
    for (let i = 0; i <= n; i++) { const b = new THREE.BoxGeometry(0.045, hgt, 0.08); b.translate(-w.width / 2 + (i / n) * w.width, 0, 0); bars.push(b); }
    for (const yy of [-hgt / 2, hgt / 2]) { const b = new THREE.BoxGeometry(w.width, 0.06, 0.1); b.translate(0, yy, 0); bars.push(b); }
    g.add(new THREE.Mesh(mergeGeometries(bars), this.mats.mullion));
    g.position.set(p.x, y + hgt / 2, p.z);
    g.rotation.y = -c.angle + fr.rot; // 판의 앞면이 방 안을 본다
    this.group.add(g);
  }
  addSlidingDoor(p, tangentAngle, width, h, key) {
    // 홀 원 둘레의 문: 접선 방향으로 미닫이 두 짝
    const t = { x: Math.cos(tangentAngle), z: Math.sin(tangentAngle) }; // 원 둘레 접선
    const mat = this.mats.oak;
    const glass = this.mats.glass;
    const leaves = [];
    for (const s of [-1, 1]) {
      const g = new THREE.Group();
      const frame = new THREE.Mesh(new THREE.BoxGeometry(width / 2, h, 0.06), mat);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(width / 2 - 0.24, h - 0.6, 0.07), glass);
      pane.position.y = 0.1; g.add(frame, pane);
      g.rotation.y = -Math.atan2(t.z, t.x);
      this.group.add(g);
      leaves.push({ g, s });
    }
    const door = { kind: 'slide', p, t, width, h, leaves, open: 0, key };
    this.doors.push(door);
    this.placeSlide(door);
  }
  placeSlide(door) {
    for (const { g, s } of door.leaves) {
      const off = s * (door.width / 4 + door.open * door.width / 2 * 0.98);
      g.position.set(door.p.x + door.t.x * off, door.h / 2, door.p.z + door.t.z * off);
    }
  }
  addVaultDoor(c, d) {
    const fr = wallFrame(c, d.wall, d.at - d.width / 2);
    const hinge = toWorld(c, fr.u, fr.v);
    const g = new THREE.Group();
    const disk = new THREE.Mesh(new THREE.CylinderGeometry(d.width / 2 * 0.98, d.width / 2 * 0.98, 0.26, 40), this.mats.metal);
    disk.rotation.x = Math.PI / 2; disk.position.set(d.width / 2, DOOR_H.vault / 2, 0);
    const wheel = new THREE.Mesh(new THREE.TorusGeometry(0.32, 0.035, 8, 32), this.mats.metal);
    wheel.position.set(d.width / 2, DOOR_H.vault / 2, -0.17);
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.1, 16), this.mats.oakDark);
    hub.rotation.x = Math.PI / 2; hub.position.copy(wheel.position);
    disk.scale.set(1, 1, 1); g.add(disk, wheel, hub);
    // 문틀(원형 자리)
    g.position.set(hinge.x, c.floorY ?? 0, hinge.z);
    const baseRot = -c.angle + fr.rot;
    g.rotation.y = baseRot;
    this.group.add(g);
    const p = toWorld(c, wallFrame(c, d.wall, d.at).u, 0);
    this.doors.push({ kind: 'vault', g, baseRot, p, open: 0, key: c.room });
  }

  // ---------- 조명 ----------
  buildLights() {
    // 하늘빛은 숲 환경 지도(scene.environment)가 맡고, 반구광은 바닥에서 튀는 따뜻한 빛만 조금
    const hemi = new THREE.HemisphereLight(0xF6F2EA, 0xD8C7A8, 0.35);
    this.scene.add(hemi);
    // 아침 해: 낮은 각도(약 38°)로 창을 통해 바닥에 빛 무늬를 만든다
    this.sun = new THREE.DirectionalLight(0xFFE6C4, 3.0);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0002; this.sun.shadow.normalBias = 0.04;
    this.sun.shadow.radius = 5; this.sun.shadow.blurSamples = 16;
    this.scene.add(this.sun, this.sun.target);
    this.setSunFor({ x: 0, z: 0, r: 16 });
    // 방마다 그림자 없는 약한 채움빛 1개(사진의 밝고 고른 실내)
    for (const c of this.layout.chambers.filter(c => c.kind === 'room')) {
      const l = new THREE.DirectionalLight(0xFFF6EA, 0.35);
      const m = toWorld(c, 0, c.d / 2);
      l.position.set(m.x + 4, 12, m.z + 6); l.target.position.set(m.x, 0, m.z);
      this.scene.add(l, l.target);
      this.roomLights.set(c.room, l);
    }
  }
  setSunFor({ x, z, r }) {
    const s = this.sun, dir = new THREE.Vector3(-0.55, 0.62, 0.56).normalize(); // 동남쪽 낮은 해
    s.position.set(x + dir.x * 40, dir.y * 40, z + dir.z * 40); s.target.position.set(x, 0, z);
    const cam = s.shadow.camera; cam.left = -r; cam.right = r; cam.top = r; cam.bottom = -r; cam.near = 1; cam.far = 90;
    cam.updateProjectionMatrix();
  }

  // ---------- 소품 ----------
  async buildProps() {
    const loader = new GLTFLoader();
    const have = new Set(this.config.assets?.props ?? []);
    const tryLoad = async name => { if (!have.has(name)) return null; try { return (await loader.loadAsync(`assets/props/${name}.glb`)).scene; } catch { return null; } };
    const glb = {};
    for (const n of ['chair', 'table', 'lamp', 'plant', 'mapstand', 'guestbook', 'workbench', 'filmcan', 'ledger', 'drawers', 'handle']) glb[n] = await tryLoad(n);
    const fit = (obj, size) => { // 상자 크기에 맞춰 축척
      const box = new THREE.Box3().setFromObject(obj), s = new THREE.Vector3(); box.getSize(s);
      const k = Math.min(size.x / s.x, size.y / s.y, size.z / s.z);
      obj.scale.multiplyScalar(k);
      const b2 = new THREE.Box3().setFromObject(obj), c2 = new THREE.Vector3(); b2.getCenter(c2);
      obj.position.sub(new THREE.Vector3(c2.x, b2.min.y, c2.z));
      const wrap = new THREE.Group(); wrap.add(obj); return wrap;
    };
    const make = (type, p) => {
      const M = this.mats;
      const box = (w, hh, d, mat, x = 0, y = 0, z = 0) => { const m = new THREE.Mesh(new THREE.BoxGeometry(w, hh, d), mat); m.position.set(x, y + hh / 2, z); m.castShadow = true; m.receiveShadow = true; return m; };
      const g = new THREE.Group();
      switch (type) {
        case 'chair': {
          if (glb.chair) return fit(glb.chair.clone(), new THREE.Vector3(0.52, 0.86, 0.54));
          g.add(box(0.46, 0.04, 0.44, M.oak, 0, 0.44, 0), box(0.46, 0.42, 0.04, M.oak, 0, 0.48, -0.2));
          for (const [x, z] of [[-0.2, -0.19], [0.2, -0.19], [-0.2, 0.19], [0.2, 0.19]]) g.add(box(0.035, 0.44, 0.035, M.oakDark, x, 0, z));
          return g;
        }
        case 'table': case 'workbench': {
          const L = p.small ? 1.1 : 2.4, W = p.small ? 0.6 : 1.0;
          if (glb[type] ?? glb.table) return fit((glb[type] ?? glb.table).clone(), new THREE.Vector3(L, 0.76, W));
          g.add(box(L, 0.05, W, type === 'workbench' ? M.oakDark : M.oak, 0, 0.72, 0));
          for (const [x, z] of [[-L / 2 + 0.08, -W / 2 + 0.08], [L / 2 - 0.08, -W / 2 + 0.08], [-L / 2 + 0.08, W / 2 - 0.08], [L / 2 - 0.08, W / 2 - 0.08]]) g.add(box(0.06, 0.72, 0.06, M.oakDark, x, 0, z));
          if (type === 'workbench') { const paper = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.004, 0.55), new THREE.MeshStandardMaterial({ color: 0xDDE6EE, roughness: 0.9 })); paper.position.set(-0.3, 0.775, 0); paper.rotation.y = 0.12; g.add(paper); }
          return g;
        }
        case 'lamp': {
          if (glb.lamp) { const w = fit(glb.lamp.clone(), new THREE.Vector3(0.3, 0.5, 0.3)); const l = new THREE.PointLight(0xFFE7C6, 0.6, 3.5, 2); l.position.y = 0.4; w.add(l); return w; }
          const base = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.1, 0.03, 20), M.metal); base.position.y = 0.775;
          const arm = new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.42, 8), M.metal); arm.position.y = 0.99;
          const shade = new THREE.Mesh(new THREE.ConeGeometry(0.12, 0.13, 24, 1, true), new THREE.MeshStandardMaterial({ color: 0xF4EFE6, emissive: 0xFFF1DD, emissiveIntensity: 0.5, side: THREE.DoubleSide }));
          shade.position.y = 1.2; g.add(base, arm, shade);
          const light = new THREE.PointLight(0xFFE7C6, 0.6, 3.5, 2); light.position.y = 1.12; g.add(light);
          return g;
        }
        case 'plant': {
          if (glb.plant) return fit(glb.plant.clone(), new THREE.Vector3(0.7, 1.4, 0.7));
          const potM = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.17, 0.42, 20), M.pot); potM.position.y = 0.21;
          g.add(potM);
          for (let i = 0; i < 7; i++) { const l = new THREE.Mesh(new THREE.SphereGeometry(0.22, 10, 8), M.plant); l.position.set(Math.cos(i) * 0.14, 0.62 + (i % 3) * 0.18, Math.sin(i * 1.7) * 0.14); l.scale.set(0.8, 1.3, 0.8); g.add(l); }
          return g;
        }
        case 'mapStand': {
          if (glb.mapstand) {
            const w = fit(glb.mapstand.clone(), new THREE.Vector3(1.0, 1.15, 0.8));
            // 받침 윗면에 실제 평면도를 얹는다
            const box = new THREE.Box3().setFromObject(w);
            const map = new THREE.Mesh(new THREE.PlaneGeometry(0.72, 0.48), new THREE.MeshStandardMaterial({ map: this.planTexture(), roughness: 0.9 }));
            map.position.set(0, box.max.y - 0.06, 0.02); map.rotation.x = -Math.PI / 2 + 0.38; w.add(map);
            return w;
          }
          const col = new THREE.Mesh(new THREE.CylinderGeometry(0.18, 0.26, 0.95, 24), M.stoneOut); col.position.y = 0.475;
          const top = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.05, 0.62), M.oak); top.position.y = 1.0; top.rotation.x = -0.35;
          const map = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.54), new THREE.MeshStandardMaterial({ map: this.planTexture(), roughness: 0.9 }));
          map.position.set(0, 1.031, 0.0); map.rotation.x = -Math.PI / 2 - 0.35;
          g.add(col, top, map); return g;
        }
        case 'guestbook': {
          if (glb.guestbook) return fit(glb.guestbook.clone(), new THREE.Vector3(0.7, 1.1, 0.5));
          const post = new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.05, 0.98, 12), M.oakDark); post.position.y = 0.49;
          const desk = new THREE.Mesh(new THREE.BoxGeometry(0.62, 0.04, 0.44), M.oak); desk.position.y = 1.0; desk.rotation.x = -0.3;
          const book = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.03, 0.34), new THREE.MeshStandardMaterial({ color: 0xF7F2E8, roughness: 0.9 })); book.position.set(0, 1.04, 0.01); book.rotation.x = -0.3;
          const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.2, 0.22, 0.03, 20), M.oakDark); foot.position.y = 0.015;
          g.add(post, desk, book, foot); return g;
        }
        case 'desk': {
          g.add(box(1.2, 0.04, 0.6, M.oak, 0, 0.74, 0));
          g.add(box(0.05, 0.74, 0.55, M.oakDark, -0.56, 0, 0), box(0.05, 0.74, 0.55, M.oakDark, 0.56, 0, 0));
          const cardMat = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.9 });
          for (let i = 0; i < 4; i++) { const cdd = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.004, 0.22), cardMat); cdd.position.set(-0.36 + i * 0.22, 0.785, (i % 2) * 0.06); cdd.rotation.y = (i - 1.5) * 0.12; g.add(cdd); }
          return g;
        }
        case 'filmcan': {
          if (glb.filmcan) return fit(glb.filmcan.clone(), new THREE.Vector3(0.36, 0.08, 0.36));
          const can = new THREE.Mesh(new THREE.CylinderGeometry(0.17, 0.17, 0.05, 32), M.metal); can.position.y = 0.025; g.add(can); return g;
        }
        case 'ledger': {
          if (glb.ledger) return fit(glb.ledger.clone(), new THREE.Vector3(0.3, 0.06, 0.4));
          g.add(box(0.3, 0.05, 0.4, new THREE.MeshStandardMaterial({ color: 0x5E5A55, roughness: 0.7 }))); return g;
        }
        case 'drawerCabinet': {
          if (glb.drawers) return fit(glb.drawers.clone(), new THREE.Vector3(1.6, 1.0, 0.6));
          g.add(box(1.6, 0.95, 0.6, M.oak));
          for (let r = 0; r < 4; r++) for (let k = 0; k < 4; k++) { const hd = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.02, 0.02), M.metal); hd.position.set(-0.6 + k * 0.4, 0.15 + r * 0.22, 0.31); g.add(hd); }
          return g;
        }
        default: return null;
      }
    };
    const fy = c => c?.floorY ?? 0;
    for (const p of this.layout.props) {
      let x, z, rot = p.rot ?? 0, c = null;
      if (p.chamber === 'hall') { x = p.x; z = p.z; }
      else { c = this.chamberById.get(p.chamber); if (!c) continue; const w = toWorld(c, p.u, p.v); x = w.x; z = w.z; rot = -c.angle + rot; }
      const obj = make(p.type, p);
      if (!obj) continue;
      obj.position.set(x, fy(c) + (p.onTable ? 0.77 : 0), z); obj.rotation.y = rot;
      obj.traverse(o => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
      this.group.add(obj); (this.props ??= []).push(obj);
      const fp = { chair: [0.27, 0.27], table: p.small ? [0.6, 0.35] : [1.25, 0.55], workbench: [1.25, 0.55], plant: [0.3, 0.3], mapStand: [0.5, 0.42], guestbook: [0.34, 0.26], desk: [0.62, 0.32], drawerCabinet: [0.82, 0.32] }[p.type];
      if (fp && !p.onTable && p.type !== 'chair') this.nav.blockBox(x, z, fp[0], fp[1], -rot);
      if (p.type === 'chair') {
        this.nav.blockBox(x, z, 0.2, 0.2, -rot, 0.12);
        const face = rot; // 의자 정면(+z) 방향
        this.seats.push({ x, z, y: fy(c), rot: face, chamber: c?.id ?? 'hall', room: c?.room ?? null, obj });
      }
      if (p.type === 'mapStand') this.interactables.push({ type: 'map', x, z, r: 1.6, label: this.config.copy.interactMap });
      if (p.type === 'guestbook') this.interactables.push({ type: 'guestbook', x, z, r: 1.5, label: this.config.copy.interactGuestbook });
      if (p.type === 'desk' && p.skills) this.interactables.push({ type: 'skills', x, z, r: 1.6, room: c.room, label: this.config.copy.interactDesk });
    }
  }
  planTexture() {
    const cv = document.createElement('canvas'); cv.width = 820; cv.height = 540;
    const g = cv.getContext('2d'); g.fillStyle = '#FBF9F5'; g.fillRect(0, 0, 820, 540);
    const b = this.layout.bounds, sx = 780 / (b.maxX - b.minX), sz = 500 / (b.maxZ - b.minZ), s = Math.min(sx, sz);
    const tx = (x, z) => [20 + (x - b.minX) * s, 20 + (z - b.minZ) * s];
    g.strokeStyle = '#8D867C'; g.lineWidth = 2;
    g.beginPath(); const [cx, cz] = tx(0, 0); g.arc(cx, cz, this.layout.hall.r * s, 0, Math.PI * 2); g.stroke();
    for (const c of this.layout.chambers) {
      const pts = this.nav.cornersOf(c).map(p => tx(p.x, p.z));
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      const cfg = c.room ? this.roomCfg.get(c.room) : null;
      g.fillStyle = c.kind === 'room' && cfg ? `${cfg.spine}33` : 'rgba(0,0,0,0.03)'; g.fill(); g.stroke();
    }
    const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
  }

  // ---------- 매 프레임 ----------
  update(dt, hana) {
    for (const d of this.doors) {
      const dist = Math.hypot(hana.x - d.p.x, hana.z - d.p.z);
      const want = dist < 3.4 ? 1 : 0;
      const prev = d.open;
      d.open = damp(d.open, want, 6, dt);
      if (d.kind === 'slide') this.placeSlide(d);
      else d.g.rotation.y = d.baseRot - d.open * 1.75;
      if (prev < 0.05 && d.open >= 0.05 && this.onDoor) this.onDoor(d);
    }
  }
  regionAt(x, z) {
    const [ix, iz] = this.nav.cellOf(x, z);
    if (!this.nav.inside(ix, iz)) return { kind: 'outside' };
    const r = this.nav.region[this.nav.idx(ix, iz)];
    if (r === -1) return { kind: 'hall' };
    if (r < 0) return { kind: 'outside' };
    const c = this.layout.chambers[r];
    return { kind: c.kind, chamber: c, room: c.room };
  }
  heightAt(x, z) {
    const g = this.regionAt(x, z);
    if (!g.chamber) return 0;
    const c = g.chamber, fy = c.floorY ?? 0, fy2 = c.floorY2 ?? fy;
    if (fy === fy2) return fy;
    const l = toLocal(c, x, z);
    return fy + (fy2 - fy) * clamp(l.v / c.d, 0, 1);
  }
}

const angDelta = (a, b) => { let d = (a - b) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const rightOfAngle = a => ({ x: Math.cos(a), z: Math.sin(a) });

// ---------- 텍스처 ----------
export function paragraphTexture(title, body, foot) {
  const W = 860, H = 620, cv = document.createElement('canvas'); cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = '#FBF9F5'; g.fillRect(0, 0, W, H); g.strokeStyle = '#D6CFC3'; g.lineWidth = 4; g.strokeRect(2, 2, W - 4, H - 4);
  g.fillStyle = '#22201D'; g.font = '700 74px Pretendard'; g.textBaseline = 'top';
  let ts = 74; while (g.measureText(title).width > W - 100 && ts > 30) { ts -= 4; g.font = `700 ${ts}px Pretendard`; }
  g.fillText(title, 50, 56);
  g.font = '500 44px Pretendard'; g.fillStyle = '#5E5850';
  const words = (body ?? '').split(/(?<=[·,:\s])/); let line = '', y = 180;
  for (const w of words) { if (g.measureText(line + w).width > W - 100) { g.fillText(line.trim(), 50, y); y += 62; line = ''; if (y > H - 140) break; } line += w; }
  if (line && y <= H - 140) g.fillText(line.trim(), 50, y);
  if (foot) { g.font = '600 40px Pretendard'; g.fillStyle = '#8D867C'; g.fillText(foot, 50, H - 90); }
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 4; return t;
}
