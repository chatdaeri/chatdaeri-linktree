// 서가와 책. 서가 1칸 = 폭 1m · 선반 5단 · 단마다 30권. 책은 방·모양별 InstancedMesh 하나.
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { toWorld, wallFrame, rand01, shade, textTexture, damp, clamp } from './util.js';
import { paragraphTexture } from './world.js';
import { texMat, meterUV, TEX } from './look.js';

export const LEVEL_Y = [0.40, 0.80, 1.20, 1.60, 2.00]; // 1~5단 바닥 높이
export const SHELF_H = 2.46, DEPTH = 0.36, BOARD = 0.025, PER = 30;
const UNIT_HALF = 0.25;
const SLOT_W = 0.92 / PER;
const ROOM_ITEM = { finance: 'ledger', worklog: 'ledger', media: 'filmcan', brand: 'drawer', idea: 'memo' };
const DIMS = {
  book: k => [0.022 + 0.008 * k[0], 0.24 + 0.09 * k[1], 0.17 + 0.07 * k[2]],
  album: k => [0.012 + 0.004 * k[0], 0.30 + 0.04 * k[1], 0.24 + 0.05 * k[2]],
  case: k => [0.031, 0.28 + 0.03 * k[1], 0.19],
  box: k => [0.031, 0.20 + 0.04 * k[1], 0.27],
  postcard: k => [0.008, 0.14 + 0.02 * k[1], 0.105],
  ledger: k => [0.028 + 0.003 * k[0], 0.31 + 0.03 * k[1], 0.24],
  filmcan: () => [0.03, 0.30, 0.30],
  drawer: k => [0.031, 0.26 + 0.02 * k[1], 0.3],
  memo: k => [0.02 + 0.008 * k[0], 0.20 + 0.03 * k[1], 0.15],
};
const LIGHT_SHAPES = new Set(['album', 'postcard', 'memo', 'drawer', 'box']);
export const SHAPE_NAME = { book: '문서', album: '이미지 화첩', case: '영상·음원 케이스', box: '폴더 상자', postcard: '웹 주소 엽서', ledger: '장부', filmcan: '필름 캔', drawer: '견본 서랍', memo: '메모 묶음' };

export class Shelves {
  constructor(world, config) {
    this.world = world; this.config = config;
    this.palace = world.palace; this.layout = world.layout;
    this.byId = new Map();     // shelfId → 서가 정보
    this.recs = [];            // 책 기록
    this.recByBook = new Map();
    this.roomMeshes = new Map();
    this.stacks = new Map();
    this.glows = [];
    this.tmpM = new THREE.Matrix4(); this.tmpM2 = new THREE.Matrix4();
  }

  build() {
    const L = this.layout;
    const oak = texMat('oak', { roughness: 0.6, bump: 0.25, color: 0xF2E4CC });
    this.frameGeo = bayGeometry();
    this.unitGeo = unitGeometry();
    // 1. 서가 자리(holder)
    for (const [id, pl] of Object.entries(L.place)) {
      const s = this.palace.shelves[id]; if (!s) continue;
      const c = this.world.chamberById.get(pl.chamber);
      const holder = new THREE.Object3D();
      let info;
      if (pl.stack) {
        const st = L.stacks[s.parent];
        info = { id, s, c, holder, kind: 'unit', bays: Math.max(1, Math.round(st.unitLen - 0.3)), room: s.room, stack: s.parent, row: pl.stack.row, slot: pl.stack.slot, faces: 2 };
      } else {
        const fr = wallFrame(c, pl.wall, pl.at);
        const p = toWorld(c, fr.u + fr.nu * 0.15, fr.v + fr.nv * 0.15);
        holder.position.set(p.x, c.floorY ?? 0, p.z);
        holder.rotation.y = -c.angle + fr.rot;
        holder.updateMatrixWorld(true);
        info = { id, s, c, holder, kind: 'wall', bays: pl.bays, room: s.room, faces: 1 };
      }
      this.byId.set(id, info);
    }
    // 이동식 서가 배치
    for (const [sid, st] of Object.entries(L.stacks)) {
      const c = this.world.chamberById.get(st.chamber);
      const rows = st.rows.map(r => ({ ...r, gap: r.units.length, anim: null, units: r.units.map(u => this.byId.get(u)) }));
      const stack = { id: sid, c, st, rows };
      this.stacks.set(sid, stack);
      rows.forEach((row, ri) => { row.index = ri; this.layoutRow(stack, row, true); });
    }
    // 2. 책 자리 계산 + 방별 개수
    const counts = new Map();
    for (const info of this.byId.values()) {
      info.slots = this.assignSlots(info);
      for (const r of info.slots) { const k = `${info.room}|${r.mat}`; counts.set(k, (counts.get(k) ?? 0) + 1); }
    }
    // 3. InstancedMesh
    const box = new THREE.BoxGeometry(1, 1, 1);
    const can = new THREE.CylinderGeometry(0.5, 0.5, 1, 20); can.rotateZ(Math.PI / 2);
    // 책등 천 무늬(흑백, 평균 0.78) × 책 색 → 1.27배로 원래 밝기
    const paper = new THREE.MeshStandardMaterial({ color: new THREE.Color(1.27, 1.27, 1.27), roughness: 0.85, map: TEX.spine ?? paperTexture() });
    const metal = new THREE.MeshStandardMaterial({ color: 0xFFFFFF, roughness: 0.32, metalness: 0.75 });
    const ghost = new THREE.MeshStandardMaterial({ color: 0xBDB8B0, roughness: 1, transparent: true, opacity: 0.32, depthWrite: false });
    for (const [k, n] of counts) {
      const [room, mat] = k.split('|');
      const mesh = new THREE.InstancedMesh(mat === 'can' ? can : box, mat === 'can' ? metal : mat === 'ghost' ? ghost : paper, n);
      mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      mesh.castShadow = mat !== 'ghost'; mesh.receiveShadow = true;
      mesh.userData.recs = []; mesh.userData.room = room; mesh.frustumCulled = false;
      mesh.count = 0;
      this.world.group.add(mesh);
      if (!this.roomMeshes.has(room)) this.roomMeshes.set(room, []);
      this.roomMeshes.get(room).push(mesh);
      this[`m:${k}`] = mesh;
    }
    for (const info of this.byId.values()) for (const slot of info.slots) {
      const mesh = this[`m:${info.room}|${slot.mat}`];
      const inst = mesh.count++;
      const rec = { ...slot, info, mesh, inst, offset: 0 };
      mesh.userData.recs[inst] = rec;
      mesh.setColorAt(inst, slot.color);
      this.recs.push(rec);
      this.recByBook.set(slot.book.id, rec);
      this.place(rec);
    }
    for (const list of this.roomMeshes.values()) for (const m of list) { m.instanceMatrix.needsUpdate = true; if (m.instanceColor) m.instanceColor.needsUpdate = true; m.computeBoundingSphere(); }
    // 4. 서가 틀
    const walls = [...this.byId.values()].filter(i => i.kind === 'wall');
    const units = [...this.byId.values()].filter(i => i.kind === 'unit');
    const nBays = walls.reduce((n, i) => n + i.bays, 0), nUnitBays = units.reduce((n, i) => n + i.bays, 0);
    this.frames = new THREE.InstancedMesh(this.frameGeo, oak, Math.max(1, nBays));
    this.unitFrames = new THREE.InstancedMesh(this.unitGeo, oak, Math.max(1, nUnitBays));
    this.unitFrames.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    let k = 0, ku = 0;
    this.frameOwners = []; this.unitOwners = [];
    for (const i of walls) { i.frameStart = k; for (let b = 0; b < i.bays; b++) { this.frameOwners[k] = i; this.frames.setMatrixAt(k++, i.holder.matrixWorld.clone().multiply(this.tmpM.makeTranslation(b, 0, 0))); } }
    for (const i of units) { i.frameStart = ku; for (let b = 0; b < i.bays; b++) this.unitOwners[ku + b] = i; ku += i.bays; this.placeUnitFrame(i); }
    this.frames.count = k; this.unitFrames.count = ku;
    for (const m of [this.frames, this.unitFrames]) { m.castShadow = true; m.receiveShadow = true; m.frustumCulled = false; this.world.group.add(m); }
    // 5. 명판·진행 중 조명·장애물·상호작용
    const accent = new THREE.MeshBasicMaterial({ color: 0xFF7E5F });
    const glow = new THREE.MeshBasicMaterial({ color: 0xFF7E5F, transparent: true, opacity: 0.16, blending: THREE.AdditiveBlending, depthWrite: false });
    this.activeLights = [];
    for (const i of walls) {
      const n = i.s.books.length;
      const tex = textTexture([i.s.label || i.s.title, `${n.toLocaleString('ko-KR')}권${i.s.inner?.length ? ` · ${this.config.copy.innerStack} ${i.s.inner.length}` : ''}`], { width: 900, height: 200, size: 66, subSize: 34, bg: '#FBF9F5', border: '#D6CFC3' });
      const pw = Math.min(2.2, Math.max(0.95, i.bays * 0.92));
      const plate = new THREE.Mesh(new THREE.PlaneGeometry(pw, pw * 200 / 900), new THREE.MeshStandardMaterial({ map: tex, roughness: 0.85 }));
      plate.position.set(i.bays / 2, SHELF_H + 0.04 + pw * 100 / 900, DEPTH * 0.5);
      i.holder.add(plate); plate.updateMatrixWorld(true);
      this.world.group.add(i.holder);
      if (i.s.active) {
        const strip = new THREE.Mesh(new THREE.BoxGeometry(i.bays - 0.06, 0.014, 0.014), accent);
        strip.position.set(i.bays / 2, LEVEL_Y[3] - 0.008, DEPTH - 0.02); i.holder.add(strip);
        const back = new THREE.Mesh(new THREE.PlaneGeometry(i.bays - 0.06, 0.36), glow);
        back.position.set(i.bays / 2, LEVEL_Y[2] + 0.19, 0.016); i.holder.add(back);
        const pl = new THREE.PointLight(0xFF9A7E, 0, 2.4, 2); pl.position.set(i.bays / 2, LEVEL_Y[2] + 0.3, DEPTH + 0.25); i.holder.add(pl);
        this.activeLights.push({ light: pl, room: i.room });
        i.holder.updateMatrixWorld(true);
      }
      // 장애물
      const cw = new THREE.Vector3(i.bays / 2, 0, DEPTH / 2).applyMatrix4(i.holder.matrixWorld);
      this.world.nav.blockBox(cw.x, cw.z, i.bays / 2, DEPTH / 2, -i.holder.rotation.y);
      this.world.interactables.push({ type: 'shelf', shelfId: i.id, room: i.room, seg: this.frontSegment(i), label: this.config.copy.interactShelf });
    }
    for (const stack of this.stacks.values()) {
      for (const row of stack.rows) for (const u of row.units) {
        const plateTex = paragraphTexture(u.s.label || u.s.title, '', `${u.s.books.length}권`);
        const plate = new THREE.Mesh(new THREE.PlaneGeometry(0.44, 0.32), new THREE.MeshStandardMaterial({ map: plateTex, roughness: 0.85 }));
        plate.position.set(-0.035, 1.75, 0); plate.rotation.y = -Math.PI / 2; u.holder.add(plate);
        const handle = new THREE.Mesh(new THREE.TorusGeometry(0.09, 0.012, 8, 24), this.world.mats.metal);
        handle.position.set(-0.05, 1.15, 0); handle.rotation.y = Math.PI / 2; u.holder.add(handle);
        const knob = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.02, 0.05, 10), this.world.mats.metal);
        knob.rotation.z = Math.PI / 2; knob.position.set(-0.03, 1.15, 0); u.holder.add(knob);
        this.world.group.add(u.holder);
        this.world.interactables.push({ type: 'handle', shelfId: u.id, stack: stack.id, row: row.index, slot: row.units.indexOf(u), room: u.room, label: this.config.copy.interactHandle, dynamic: true });
      }
      this.updateRowNav(stack);
    }
    // 빛남 표시용
    this.glowMesh = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xFF7E5F, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false }));
    this.glowMesh.visible = false; this.world.group.add(this.glowMesh);
    return this;
  }

  // 책을 단·칸에 배정
  assignSlots(info) {
    const { s } = info;
    const fill = this.config.layout?.fillOrder ?? [2, 4, 1, 5, 3];
    const activeOrder = [3, ...fill.filter(l => l !== 3)];
    const cap = info.bays * PER;
    const used = new Map(); // face|level → 개수
    const out = [];
    const roomItem = ROOM_ITEM[info.room];
    const base = this.world.roomCfg.get(info.room)?.spine ?? '#888888';
    for (const book of s.books) {
      const order = book.active ? activeOrder : fill;
      let face = 0, level = null, slot = 0;
      for (let f = 0; f < info.faces && level == null; f++) for (const l of order) {
        const k = `${f}|${l}`, n = used.get(k) ?? 0;
        if (n < cap) { face = f; level = l; slot = n; used.set(k, n + 1); break; }
      }
      if (level == null) continue; // 자리 넘침(배치에서 칸을 늘려 생기지 않게 한다)
      const shape = book.exists === false ? (roomItem ?? book.shape) : (roomItem ?? book.shape);
      const k = [rand01(book.id, 1), rand01(book.id, 2), rand01(book.id, 3)];
      let [t, hgt, d] = (DIMS[shape] ?? DIMS.book)(k);
      if (info.kind === 'unit') d = Math.min(d, 0.21);
      const missing = book.exists === false;
      const mat = missing ? 'ghost' : shape === 'filmcan' ? 'can' : 'paper';
      const color = missing ? new THREE.Color(0xBDB8B0) : colorFor(shape, base, k);
      const bay = Math.floor(slot / PER), within = slot % PER;
      const x = bay + 0.04 + (within + 0.5) * SLOT_W;
      const y = LEVEL_Y[level - 1] + BOARD + hgt / 2;
      const z = info.kind === 'unit' ? (face === 0 ? 1 : -1) * (UNIT_HALF - 0.015 - d / 2) : DEPTH - 0.02 - d / 2;
      const tilt = (k[0] - 0.5) * 0.02;
      const local = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(0, 0, tilt)), new THREE.Vector3(t, hgt, d));
      out.push({ book, shape, level, slot, bay, within, face, x, y, z, t, h: hgt, d, local, mat, color, light: LIGHT_SHAPES.has(shape) || missing, missing });
    }
    return out;
  }

  // 이동식 서가 한 줄 배치(gap = 열린 통로가 있는 자리, units.length면 맨 끝)
  layoutRow(stack, row, instant = false, t = 1) {
    const { st, c } = stack;
    row.units.forEach((u, i) => {
      const target = row.u0 + i * st.unitThick + (i >= row.gap ? st.aisle : 0) + st.unitThick / 2;
      u.uTarget = target;
      if (instant || u.uNow == null) u.uNow = target; else u.uNow = u.uFrom + (target - u.uFrom) * t;
      const p = toWorld(c, u.uNow, row.v);
      u.holder.position.set(p.x, c.floorY ?? 0, p.z);
      u.holder.rotation.y = -c.angle + Math.PI / 2;
      u.holder.updateMatrixWorld(true);
    });
  }
  placeUnitFrame(u) { for (let b = 0; b < u.bays; b++) this.unitFrames.setMatrixAt(u.frameStart + b, u.holder.matrixWorld.clone().multiply(this.tmpM.makeTranslation(b, 0, 0))); this.unitFrames.instanceMatrix.needsUpdate = true; }
  openAisle(stackId, rowIndex, slot) {
    const stack = this.stacks.get(stackId); const row = stack.rows[rowIndex];
    const want = slot + 1;
    if (row.gap === want) return false;
    row.units.forEach(u => { u.uFrom = u.uNow; });
    row.gap = want; row.anim = { t: 0, dur: this.config.reduced ? 0.01 : 0.9 };
    return true;
  }
  updateRowNav(stack) {
    const nav = this.world.nav, c = stack.c, st = stack.st;
    for (const row of stack.rows) {
      const pts = [toWorld(c, row.u0 - 0.6, row.v - 0.05), toWorld(c, row.u0 + row.units.length * st.unitThick + st.aisle + 0.6, row.v + st.unitLen + 0.05)];
      nav.clearDyn([pts[0], pts[1], toWorld(c, row.u0 - 0.6, row.v + st.unitLen + 0.05), toWorld(c, row.u0 + row.units.length * st.unitThick + st.aisle + 0.6, row.v - 0.05)]);
      for (const u of row.units) {
        const cw = new THREE.Vector3(st.unitLen / 2, 0, 0).applyMatrix4(u.holder.matrixWorld);
        nav.blockBox(cw.x, cw.z, st.unitLen / 2, UNIT_HALF, -u.holder.rotation.y, 0.2, nav.dyn);
      }
    }
  }
  update(dt, room) {
    for (const stack of this.stacks.values()) {
      let moved = false;
      for (const row of stack.rows) {
        if (!row.anim) continue;
        row.anim.t = Math.min(1, row.anim.t + dt / row.anim.dur);
        const e = row.anim.t < 0.5 ? 2 * row.anim.t * row.anim.t : 1 - (-2 * row.anim.t + 2) ** 2 / 2;
        this.layoutRow(stack, row, false, e);
        for (const u of row.units) { this.placeUnitFrame(u); for (const r of u.slots) this.place(this.recByBook.get(r.book.id)); }
        if (row.anim.t >= 1) row.anim = null;
        moved = true;
      }
      if (moved) { this.updateRowNav(stack); for (const list of this.roomMeshes.values()) for (const m of list) m.instanceMatrix.needsUpdate = true; }
    }
    // 진행 중 조명: 지금 방만
    for (const a of this.activeLights) a.light.intensity = damp(a.light.intensity, a.room === room ? 0.9 : 0, 4, dt);
    // 빛남
    if (this.glow) {
      this.glow.t += dt;
      const g = this.glow, k = g.t / 3;
      if (k >= 1) { this.glowMesh.visible = false; this.glow = null; }
      else {
        this.glowMesh.visible = true;
        this.glowMesh.material.opacity = 0.55 * (0.6 + 0.4 * Math.sin(g.t * 6)) * (1 - k * k);
        this.glowMesh.matrix.copy(this.worldMatrix(g.rec)).multiply(this.tmpM2.makeScale(1.25, 1.06, 1.08));
        this.glowMesh.matrixAutoUpdate = false;
      }
    }
  }

  worldMatrix(rec, offset = rec.offset) {
    return this.tmpM.copy(rec.info.holder.matrixWorld).multiply(this.tmpM2.makeTranslation(0, 0, offset * (rec.face === 1 ? -1 : 1))).multiply(rec.local);
  }
  place(rec) {
    if (rec.hidden) { rec.mesh.setMatrixAt(rec.inst, this.tmpM.makeScale(0, 0, 0)); }
    else rec.mesh.setMatrixAt(rec.inst, this.worldMatrix(rec));
    rec.mesh.instanceMatrix.needsUpdate = true;
  }
  setOffset(rec, off) { rec.offset = off; this.place(rec); }
  hide(rec, v = true) { rec.hidden = v; this.place(rec); }
  glowBook(rec) { this.glow = { rec, t: 0 }; }
  // 책 한 권의 월드 위치(앞면 가운데)
  frontPoint(rec, extra = 0) {
    const m = this.worldMatrix(rec);
    return new THREE.Vector3(0, 0, 0.5 + extra / rec.d).applyMatrix4(m);
  }
  centerPoint(rec) { return new THREE.Vector3().setFromMatrixPosition(this.worldMatrix(rec)); }
  frontSegment(info) {
    const a = new THREE.Vector3(0, 0, DEPTH).applyMatrix4(info.holder.matrixWorld), b = new THREE.Vector3(info.bays, 0, DEPTH).applyMatrix4(info.holder.matrixWorld);
    return { ax: a.x, az: a.z, bx: b.x, bz: b.z };
  }
  // 서가 앞 서는 자리
  standPoint(info, x, dist = 0.95) {
    if (info.kind === 'unit') {
      const st = this.stacks.get(info.stack).st;
      // x가 음수면 통로 입구(줄 앞 복도)에 선다
      return new THREE.Vector3(x < 0 ? x : clamp(x, 0.3, st.unitLen - 0.3), 0, UNIT_HALF + st.aisle / 2).applyMatrix4(info.holder.matrixWorld);
    }
    return new THREE.Vector3(clamp(x, 0.3, info.bays - 0.3), 0, DEPTH + dist).applyMatrix4(info.holder.matrixWorld);
  }
  shelfNormal(info) { const q = new THREE.Quaternion(); info.holder.getWorldQuaternion(q); return new THREE.Vector3(0, 0, 1).applyQuaternion(q); }
  shelfDir(info) { const q = new THREE.Quaternion(); info.holder.getWorldQuaternion(q); return new THREE.Vector3(1, 0, 0).applyQuaternion(q); }
  // 서가 보기 격자: 단마다 칸 순서
  grid(info) {
    if (info.grid) return info.grid;
    const g = { 1: [], 2: [], 3: [], 4: [], 5: [] };
    for (const slot of info.slots) if (slot.face === 0) g[slot.level].push(this.recByBook.get(slot.book.id));
    for (const l of Object.keys(g)) g[l].sort((a, b) => a.slot - b.slot);
    info.grid = g;
    return g;
  }
  frameOwner(mesh, id) { return mesh === this.frames ? this.frameOwners[id] : this.unitOwners[id]; }
  setRoomsVisible(rooms) { for (const [r, list] of this.roomMeshes) for (const m of list) m.visible = rooms.has(r); }
  pick(raycaster, shelfId = null) {
    const meshes = [];
    for (const list of this.roomMeshes.values()) for (const m of list) if (m.visible) meshes.push(m);
    const hits = raycaster.intersectObjects(meshes, false);
    for (const h of hits) {
      const rec = h.object.userData.recs[h.instanceId];
      if (!rec || rec.hidden) continue;
      if (shelfId && rec.info.id !== shelfId) continue;
      return rec;
    }
    return null;
  }
  // 꺼낸 책: 따로 그리는 메쉬
  makeLoose(rec) {
    const geo = rec.shape === 'filmcan' ? new THREE.CylinderGeometry(0.5, 0.5, 1, 20).rotateZ(Math.PI / 2) : new THREE.BoxGeometry(1, 1, 1);
    const mat = new THREE.MeshStandardMaterial({ color: rec.color, roughness: rec.shape === 'filmcan' ? 0.3 : 0.8, metalness: rec.shape === 'filmcan' ? 0.75 : 0, transparent: rec.missing, opacity: rec.missing ? 0.4 : 1 });
    const inner = new THREE.Mesh(geo, mat); inner.scale.set(rec.t, rec.h, rec.d); inner.castShadow = true;
    // 펼친 책 모양(읽을 때)
    const pageMat = new THREE.MeshStandardMaterial({ color: 0xFBF8F1, roughness: 0.9 });
    const open = new THREE.Group();
    for (const s of [-1, 1]) { const p = new THREE.Mesh(new THREE.BoxGeometry(rec.d * 0.95, rec.h * 0.95, 0.012), pageMat); p.position.x = s * rec.d * 0.48; p.rotation.y = s * 0.18; open.add(p); }
    const cover = new THREE.Mesh(new THREE.BoxGeometry(rec.d * 2, rec.h, 0.006), mat); cover.position.z = -0.012; open.add(cover);
    open.visible = false;
    const g = new THREE.Group(); g.add(inner, open);
    g.userData = { inner, open };
    this.world.group.add(g);
    return g;
  }
}

function colorFor(shape, base, k) {
  switch (shape) {
    case 'album': return shade(base, 0.28 + k[0] * 0.08, -0.1);
    case 'case': return shade(base, -0.16 + k[0] * 0.04, 0.02);
    case 'box': return shade('#C9B793', (k[0] - 0.5) * 0.06);
    case 'postcard': return shade('#F1ECE2', (k[0] - 0.5) * 0.04);
    case 'ledger': return shade(base, -0.12 + (k[0] - 0.5) * 0.1, -0.04);
    case 'filmcan': return shade('#A2A6A8', (k[0] - 0.5) * 0.08);
    case 'drawer': return shade('#D5C29E', (k[0] - 0.5) * 0.06);
    case 'memo': return shade('#EDE5D4', (k[0] - 0.5) * 0.05);
    default: return shade(base, (k[0] - 0.5) * 0.24, (k[1] - 0.5) * 0.16);
  }
}

function bayGeometry() {
  const parts = [];
  const add = (w, h, d, x, y, z) => { const g = meterUV(new THREE.BoxGeometry(w, h, d), 1.0, [x, y, z]); g.translate(x, y, z); parts.push(g); };
  add(0.02, SHELF_H, DEPTH, 0.01, SHELF_H / 2, DEPTH / 2);
  add(0.02, SHELF_H, DEPTH, 0.99, SHELF_H / 2, DEPTH / 2);
  add(1, SHELF_H, 0.012, 0.5, SHELF_H / 2, 0.006);
  for (const y of [...LEVEL_Y, 2.42]) add(0.98, BOARD, DEPTH - 0.012, 0.5, y + BOARD / 2, DEPTH / 2 + 0.006);
  add(1, 0.38, 0.02, 0.5, 0.19, DEPTH - 0.03);
  add(1.02, 0.045, DEPTH + 0.03, 0.5, SHELF_H + 0.022, DEPTH / 2);
  return mergeGeometries(parts);
}
function unitGeometry() {
  const parts = [], D = UNIT_HALF * 2;
  const add = (w, h, d, x, y, z) => { const g = meterUV(new THREE.BoxGeometry(w, h, d), 1.0, [x, y, z]); g.translate(x, y, z); parts.push(g); };
  add(1, SHELF_H, 0.016, 0.5, SHELF_H / 2, 0);
  add(0.025, SHELF_H, D, 0.0125, SHELF_H / 2, 0);
  add(0.025, SHELF_H, D, 0.9875, SHELF_H / 2, 0);
  for (const y of [...LEVEL_Y, 2.42]) add(0.96, BOARD, D - 0.01, 0.5, y + BOARD / 2, 0);
  add(1, 0.38, D - 0.04, 0.5, 0.19, 0);
  add(1.02, 0.045, D + 0.02, 0.5, SHELF_H + 0.022, 0);
  add(1.0, 0.04, 0.06, 0.5, 0.02, -D / 2 + 0.03); add(1.0, 0.04, 0.06, 0.5, 0.02, D / 2 - 0.03); // 바퀴 레일
  return mergeGeometries(parts);
}
function paperTexture() {
  const cv = document.createElement('canvas'); cv.width = 64; cv.height = 256;
  const g = cv.getContext('2d'); g.fillStyle = '#FFFFFF'; g.fillRect(0, 0, 64, 256);
  for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(0,0,0,${Math.random() * 0.05})`; g.fillRect(Math.random() * 64, Math.random() * 256, 1, 1); }
  g.fillStyle = 'rgba(0,0,0,0.10)'; g.fillRect(0, 22, 64, 3); g.fillRect(0, 230, 64, 3);
  g.fillStyle = 'rgba(255,255,255,0.22)'; g.fillRect(0, 26, 64, 2); g.fillRect(0, 226, 64, 2);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace; return t;
}
