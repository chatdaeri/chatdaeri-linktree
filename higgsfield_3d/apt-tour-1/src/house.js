// 집 만들기: scene.json(미터, x 오른쪽 · z 아래 · 원점 = 건물 왼쪽 위) → 벽·문틀·창·바닥·천장·방별 벽 마감
import * as THREE from 'three';
import { texMat, meterUV, TILE, TEX } from './look.js';

const DOOR_H = 2.1, WIN_SILL = 0.9, WIN_HEAD = 2.2, SLIDE_HEAD = 2.25;
// 방 종류별 바닥·벽 마감
const FLOOR = { bath: 'tile', balcony: 'tile', utility: 'tile', entry: 'tile', outdoor: 'tile' };
const LINING = { bath: 'tile', balcony: 'paint', utility: 'paint' };

export class House {
  constructor(scene, S) {
    this.scene = scene; this.S = S;
    this.H = S.wallHeight ?? 2.3;
    this.group = new THREE.Group(); scene.add(this.group);
    this.walls = [];       // 벽 메쉬(카메라 가림·충돌)
    this.extWalls = [];    // 바깥벽(카메라가 집 밖으로 못 나가게)
    this.floors = [];      // 클릭 대상
    this.ceilings = new THREE.Group(); this.group.add(this.ceilings);
    this.doors = [];
    // 벽·천장은 흰 칠(넓어 보이게). 회반죽 사진은 크림색이라 색은 빼고 요철만 쓴다. scene.wallColor로 바꿀 수 있다
    const plasterN = TEX.plaster?.normal;
    const paintMat = (color, bump) => { const m = new THREE.MeshStandardMaterial({ color, roughness: 0.9 }); if (plasterN) { m.normalMap = plasterN; m.normalScale = new THREE.Vector2(bump, bump); } return m; };
    const M = this.mats = {
      paint: paintMat(new THREE.Color(S.wallColor ?? '#FAFAF7'), 0.18),
      cap: new THREE.MeshStandardMaterial({ color: 0x3A3836, roughness: 0.9 }),
      wood: texMat('oakfloor', { roughness: 0.48, bump: 0.3 }),
      tile: texMat('limestone', { roughness: 0.35, bump: 0.2, color: 0xEDE8E0 }),
      wallTile: texMat('limestone', { roughness: 0.32, bump: 0.15, color: 0xFFFFFF }), // 욕실 벽: 밝은 석회석 타일
      ceiling: paintMat(0xFFFFFF, 0.1),
      base: new THREE.MeshStandardMaterial({ color: 0xD8D0C4, roughness: 0.8 }),
      frame: new THREE.MeshStandardMaterial({ color: 0xE9E7E2, roughness: 0.45, metalness: 0.2 }),
      glass: new THREE.MeshPhysicalMaterial({ color: 0xF2F6F5, roughness: 0.04, transparent: true, opacity: 0.12, depthWrite: false, envMapIntensity: 1.4, side: THREE.DoubleSide }),
      door: texMat('oak', { roughness: 0.55, bump: 0.2, color: 0xF4ECE0 }),
      skirt: new THREE.MeshStandardMaterial({ color: 0xF2F1EE, roughness: 0.6 }),
    };
    M.ceiling.shadowSide = THREE.DoubleSide;
  }

  build() {
    const S = this.S, H = this.H, M = this.mats;
    // 벽: 옆면 = 칠, 윗면 = 진한 단면(위에서 볼 때 벽선이 또렷하게)
    for (const w of S.walls) {
      const len = Math.hypot(w.b[0] - w.a[0], w.b[1] - w.a[1]) + 0.01;
      const geo = w.o === 'h' ? new THREE.BoxGeometry(len, H + 0.06, w.t) : new THREE.BoxGeometry(w.t, H + 0.06, len);
      geo.translate(0, -0.03, 0); // 바닥 아래 6cm까지 내려 틈이 없게
      meterUV(geo, TILE.plaster, [(w.a[0] + w.b[0]) / 2, H / 2, (w.a[1] + w.b[1]) / 2]);
      const m = new THREE.Mesh(geo, [M.paint, M.paint, M.cap, M.paint, M.paint, M.paint].map(x => x === M.cap ? x : x.clone()));
      m.position.set((w.a[0] + w.b[0]) / 2, H / 2, (w.a[1] + w.b[1]) / 2);
      m.castShadow = true; m.receiveShadow = true; m.userData.wall = true; m.userData.ext = w.ext;
      this.group.add(m); this.walls.push(m); if (w.ext) this.extWalls.push(m);
    }
    // 방 바닥 칸(0.1m)과 벽 면 사이 빈틈 → 방마다 12cm 넓힌 얇은 받침을 깐다(바깥 빈 곳에는 깔리지 않음)
    for (const r of S.rooms) for (const [x0, z0, x1, z1] of r.rects) {
      const b = new THREE.Mesh(new THREE.BoxGeometry(x1 - x0 + 0.24, 0.03, z1 - z0 + 0.24), M.base);
      b.position.set((x0 + x1) / 2, -0.035, (z0 + z1) / 2); b.receiveShadow = true; this.group.add(b);
    }
    for (const o of S.openings) this.opening(o);
    // 방: 바닥·천장·벽 마감
    for (const r of S.rooms) this.room(r);
    return this;
  }

  // 틈 하나: 문(인방 + 열린 문짝) · 창(창턱 + 인방 + 유리) · 미닫이창(인방 + 큰 유리) · 트임(인방만)
  opening(o) {
    const H = this.H, M = this.mats;
    const horiz = Math.abs(o.b[0] - o.a[0]) >= Math.abs(o.b[1] - o.a[1]);
    const L = horiz ? o.b[0] - o.a[0] : o.b[1] - o.a[1];
    const cx = (o.a[0] + o.b[0]) / 2, cz = (o.a[1] + o.b[1]) / 2, t = o.t;
    const piece = (y0, y1, mat, thick = t, along = L) => {
      if (y1 - y0 < 0.01) return null;
      const geo = horiz ? new THREE.BoxGeometry(along, y1 - y0, thick) : new THREE.BoxGeometry(thick, y1 - y0, along);
      meterUV(geo, TILE.plaster, [cx, (y0 + y1) / 2, cz]);
      const m = new THREE.Mesh(geo, mat === M.paint ? [M.paint, M.paint, M.cap, M.paint, M.paint, M.paint].map(x => x === M.cap ? x : x.clone()) : mat);
      m.position.set(cx, (y0 + y1) / 2, cz); m.castShadow = true; m.receiveShadow = true;
      if (mat === M.paint) { m.userData.wall = true; m.userData.ext = o.exterior; this.walls.push(m); if (o.exterior) this.extWalls.push(m); }
      this.group.add(m); return m;
    };
    if (o.type === 'door' || o.type === 'open' || o.type === 'slide') { // 문턱 바닥(방 바닥 사이 빈칸)
      const g = horiz ? new THREE.BoxGeometry(L, 0.02, t + 0.02) : new THREE.BoxGeometry(t + 0.02, 0.02, L);
      const th = new THREE.Mesh(meterUV(g, TILE.oakfloor, [cx, 0, cz]), o.type === 'slide' ? M.frame : M.wood);
      th.position.set(cx, -0.01, cz); th.receiveShadow = true; this.group.add(th); this.floors.push(th);
    }
    if (o.type === 'door') {
      piece(DOOR_H, H, M.paint);
      // 문틀
      const jamb = 0.05;
      for (const s of [-1, 1]) {
        const g = horiz ? new THREE.BoxGeometry(jamb, DOOR_H, t + 0.02) : new THREE.BoxGeometry(t + 0.02, DOOR_H, jamb);
        const m = new THREE.Mesh(g, M.frame); m.position.set(cx + (horiz ? s * (L / 2 - jamb / 2) : 0), DOOR_H / 2, cz + (horiz ? 0 : s * (L / 2 - jamb / 2)));
        this.group.add(m);
      }
      // 문짝: 경첩 = a 끝, 비어 있는 쪽으로 85° 열림
      const leafW = L - 0.1, leaf = new THREE.Mesh(new THREE.BoxGeometry(leafW, DOOR_H - 0.03, 0.04), M.door);
      leaf.castShadow = true; leaf.receiveShadow = true;
      const pivot = new THREE.Group(); pivot.add(leaf); leaf.position.set(leafW / 2, (DOOR_H - 0.03) / 2, 0);
      const hinge = horiz ? [o.a[0] + 0.05, o.a[1]] : [o.a[0], o.a[1] + 0.05];
      pivot.position.set(hinge[0], 0, hinge[1]);
      const baseRot = horiz ? 0 : -Math.PI / 2; // 닫힌 문 방향(문짝 +x가 틈을 따라)
      const side = o.swing ?? this.freeSide(o, horiz);
      pivot.rotation.y = baseRot + side * 1.48;
      this.group.add(pivot); this.doors.push(pivot);
    } else if (o.type === 'window') {
      const sill = o.sill ?? WIN_SILL;
      piece(0, sill, M.paint); piece(WIN_HEAD, H, M.paint);
      this.glass(cx, cz, horiz, L, sill, WIN_HEAD, t, 2);
    } else if (o.type === 'slide') {
      piece(SLIDE_HEAD, H, M.paint);
      this.glass(cx, cz, horiz, L, 0.03, SLIDE_HEAD, t, 2);
    } else if (o.type === 'open') {
      piece(SLIDE_HEAD, H, M.paint);
    }
  }
  // 문짝이 열릴 쪽: 틈 양옆 중 걷기 칸이 많은 쪽(+1 = 틈 방향 기준 왼쪽 법선)
  freeSide(o, horiz) {
    const n = this.S.nav; if (!n) return 1;
    const walk = (x, z) => { const i = Math.floor(x / n.cell), j = Math.floor(z / n.cell); return n.rows[j]?.[i] === '1'; };
    const cx = (o.a[0] + o.b[0]) / 2, cz = (o.a[1] + o.b[1]) / 2;
    let a = 0, b = 0;
    for (let d = 0.3; d <= 0.9; d += 0.15) {
      if (horiz) { a += walk(cx, cz - d); b += walk(cx, cz + d); } else { a += walk(cx - d, cz); b += walk(cx + d, cz); }
    }
    // 가로 틈: 회전 +θ → 문짝이 -z 쪽으로, 세로 틈: +θ → +x 쪽으로 열린다
    return horiz ? (a >= b ? 1 : -1) : (a >= b ? -1 : 1);
  }
  glass(cx, cz, horiz, L, y0, y1, t, panels) {
    const M = this.mats, h = y1 - y0;
    const pane = new THREE.Mesh(horiz ? new THREE.PlaneGeometry(L, h) : new THREE.PlaneGeometry(L, h).rotateY(Math.PI / 2), M.glass);
    pane.position.set(cx, (y0 + y1) / 2, cz); pane.userData.noAO = true; this.group.add(pane);
    const bars = [];
    const n = Math.max(panels, Math.round(L / 1.1));
    for (let i = 0; i <= n; i++) bars.push([-L / 2 + (i / n) * L, 0, 0.045, h]);
    for (const yy of [-h / 2, h / 2]) bars.push([0, yy, L, 0.05]);
    for (const [u, v, bw, bh] of bars) {
      const g = horiz ? new THREE.BoxGeometry(bw, bh, Math.min(0.08, t)) : new THREE.BoxGeometry(Math.min(0.08, t), bh, bw);
      const m = new THREE.Mesh(g, M.frame);
      m.position.set(cx + (horiz ? u : 0), (y0 + y1) / 2 + v, cz + (horiz ? 0 : u)); this.group.add(m);
    }
  }

  room(r) {
    const H = this.H, M = this.mats;
    const floorMat = (r.floor === 'wood' ? M.wood : r.floor === 'tile' ? M.tile : FLOOR[r.type] === 'tile' ? M.tile : M.wood);
    const y = floorMat === M.tile && r.type === 'entry' ? -0.03 : 0; // 현관은 한 단 낮게
    for (const [x0, z0, x1, z1] of r.rects) {
      const w = x1 - x0, d = z1 - z0;
      const g = meterUV(new THREE.BoxGeometry(w, 0.02, d), floorMat === M.tile ? TILE.limestone : TILE.oakfloor, [(x0 + x1) / 2, 0, (z0 + z1) / 2]);
      const f = new THREE.Mesh(g, floorMat); f.position.set((x0 + x1) / 2, y - 0.01, (z0 + z1) / 2); f.receiveShadow = true;
      f.userData.room = r.name; this.group.add(f); this.floors.push(f);
      const c = new THREE.Mesh(meterUV(new THREE.PlaneGeometry(w, d), TILE.plaster), M.ceiling);
      c.rotation.x = Math.PI / 2; c.position.set((x0 + x1) / 2, H, (z0 + z1) / 2); c.castShadow = true;
      this.ceilings.add(c);
    }
    // 방 둘레 마감(벽에 닿은 가장자리만): 욕실 = 타일, 그 밖 = 걸레받이
    const lining = LINING[r.type];
    for (const e of this.roomEdges(r)) {
      const [ax, az, bx, bz, nx, nz] = e, len = Math.hypot(bx - ax, bz - az);
      if (len < 0.05) continue;
      const horiz = Math.abs(bx - ax) > Math.abs(bz - az);
      const mx = (ax + bx) / 2 + nx * 0.006, mz = (az + bz) / 2 + nz * 0.006;
      if (lining === 'tile') {
        const g = horiz ? new THREE.PlaneGeometry(len, H) : new THREE.PlaneGeometry(len, H).rotateY(Math.PI / 2);
        if (horiz && nz < 0) g.rotateY(Math.PI); if (!horiz && nx < 0) g.rotateY(Math.PI);
        meterUV(g, TILE.limestone, [mx, H / 2, mz]);
        const p = new THREE.Mesh(g, M.wallTile); p.position.set(mx, H / 2, mz); p.receiveShadow = true; this.group.add(p);
      } else {
        const g = horiz ? new THREE.BoxGeometry(len, 0.08, 0.012) : new THREE.BoxGeometry(0.012, 0.08, len);
        const p = new THREE.Mesh(g, M.skirt); p.position.set(mx, 0.04, mz); this.group.add(p);
      }
    }
  }
  // 방 칸(0.1m) 가장자리 중 바로 옆이 벽인 변들을 이어 붙인다 → [ax, az, bx, bz, 안쪽 법선 x, z]
  roomEdges(r) {
    const c = 0.1, S = this.S;
    if (!this._wallCells) { // 벽 칸 표시
      const w = Math.ceil(S.size[0] / c) + 2, h = Math.ceil(S.size[1] / c) + 2, m = new Uint8Array(w * h);
      const mark = (x0, z0, x1, z1) => { for (let j = Math.max(0, Math.floor(z0 / c)); j <= Math.min(h - 1, Math.floor(z1 / c)); j++) for (let i = Math.max(0, Math.floor(x0 / c)); i <= Math.min(w - 1, Math.floor(x1 / c)); i++) m[j * w + i] = 1; };
      for (const wl of S.walls) { const t = wl.t / 2; if (wl.o === 'h') mark(Math.min(wl.a[0], wl.b[0]), wl.a[1] - t, Math.max(wl.a[0], wl.b[0]), wl.a[1] + t); else mark(wl.a[0] - t, Math.min(wl.a[1], wl.b[1]), wl.a[0] + t, Math.max(wl.a[1], wl.b[1])); }
      this._wallCells = { w, h, m };
    }
    const { w, h, m } = this._wallCells;
    const inRoom = new Set();
    for (const [x0, z0, x1, z1] of r.rects) for (let j = Math.round(z0 / c); j < Math.round(z1 / c); j++) for (let i = Math.round(x0 / c); i < Math.round(x1 / c); i++) inRoom.add(j * 100000 + i);
    const isWall = (i, j) => i >= 0 && j >= 0 && i < w && j < h && m[j * w + i] === 1;
    const edges = [];
    const runs = { n: new Map(), s: new Map(), w: new Map(), e: new Map() };
    for (const k of inRoom) {
      const j = Math.floor(k / 100000), i = k % 100000;
      if (!inRoom.has((j - 1) * 100000 + i) && isWall(i, j - 1)) push(runs.n, j, i);
      if (!inRoom.has((j + 1) * 100000 + i) && isWall(i, j + 1)) push(runs.s, j + 1, i);
      if (!inRoom.has(j * 100000 + i - 1) && isWall(i - 1, j)) push(runs.w, i, j);
      if (!inRoom.has(j * 100000 + i + 1) && isWall(i + 1, j)) push(runs.e, i + 1, j);
    }
    function push(map, line, pos) { if (!map.has(line)) map.set(line, []); map.get(line).push(pos); }
    const merge = (map, fn) => { for (const [line, arr] of map) { arr.sort((p, q) => p - q); let s = arr[0], prev = arr[0]; for (const v of [...arr.slice(1), Infinity]) { if (v !== prev + 1) { fn(line, s, prev + 1); s = v; } prev = v; } } };
    // 칸 경계선 → 실제 벽 면으로 붙이기(칸은 0.1m라 벽 면과 최대 5cm 어긋난다)
    const face = (o, line, a, b, sgn) => {
      let best = line, bd = 0.16;
      for (const wl of S.walls) {
        if (wl.o !== o) continue;
        const lo = o === 'h' ? Math.min(wl.a[0], wl.b[0]) : Math.min(wl.a[1], wl.b[1]), hi = o === 'h' ? Math.max(wl.a[0], wl.b[0]) : Math.max(wl.a[1], wl.b[1]);
        if (hi < a + 0.02 || lo > b - 0.02) continue;
        const f = (o === 'h' ? wl.a[1] : wl.a[0]) + sgn * wl.t / 2, d = Math.abs(f - line);
        if (d < bd) { bd = d; best = f; }
      }
      return best;
    };
    merge(runs.n, (j, a, b) => { const z = face('h', j * c, a * c, b * c, 1); edges.push([a * c, z, b * c, z, 0, 1]); });
    merge(runs.s, (j, a, b) => { const z = face('h', j * c, a * c, b * c, -1); edges.push([a * c, z, b * c, z, 0, -1]); });
    merge(runs.w, (i, a, b) => { const x = face('v', i * c, a * c, b * c, 1); edges.push([x, a * c, x, b * c, 1, 0]); });
    merge(runs.e, (i, a, b) => { const x = face('v', i * c, a * c, b * c, -1); edges.push([x, a * c, x, b * c, -1, 0]); });
    return edges;
  }
  roomAt(x, z) {
    for (const r of this.S.rooms) for (const [x0, z0, x1, z1] of r.rects) if (x >= x0 && x <= x1 && z >= z0 && z <= z1) return r;
    return null;
  }
}
