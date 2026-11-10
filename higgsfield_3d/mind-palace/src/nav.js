// 바닥 격자(25cm): 걸을 수 있는 칸, 바닥 높이, 칸이 속한 공간. 충돌과 A* 길찾기.
import { toLocal } from './util.js';

export class NavGrid {
  constructor(bounds, cell = 0.25) {
    this.cell = cell;
    this.x0 = bounds.minX; this.z0 = bounds.minZ;
    this.nx = Math.ceil((bounds.maxX - bounds.minX) / cell);
    this.nz = Math.ceil((bounds.maxZ - bounds.minZ) / cell);
    const n = this.nx * this.nz;
    this.floor = new Uint8Array(n);   // 바닥 있음
    this.block = new Uint8Array(n);   // 고정 장애물
    this.dyn = new Uint8Array(n);     // 움직이는 장애물(이동식 서가)
    this.region = new Int16Array(n).fill(-3); // 공간 번호(-1 홀, -2 바깥, -3 없음)
    this.chambers = [];
  }
  idx(ix, iz) { return iz * this.nx + ix; }
  cellOf(x, z) { return [Math.floor((x - this.x0) / this.cell), Math.floor((z - this.z0) / this.cell)]; }
  center(ix, iz) { return { x: this.x0 + (ix + 0.5) * this.cell, z: this.z0 + (iz + 0.5) * this.cell }; }
  inside(ix, iz) { return ix >= 0 && iz >= 0 && ix < this.nx && iz < this.nz; }
  walkableCell(ix, iz) { if (!this.inside(ix, iz)) return false; const i = this.idx(ix, iz); return this.floor[i] && !this.block[i] && !this.dyn[i]; }
  walkable(x, z) { const [ix, iz] = this.cellOf(x, z); return this.walkableCell(ix, iz); }

  // 바닥 칠하기
  addChamber(c, index) {
    this.chambers[index] = c;
    const pts = this.cornersOf(c);
    this.forBox(pts, (ix, iz, p) => {
      const l = toLocal(c, p.x, p.z);
      if (l.u < -c.w / 2 || l.u > c.w / 2 || l.v < 0 || l.v > c.d) return;
      const i = this.idx(ix, iz);
      this.floor[i] = 1;
      // 홀(-1)이나 다른 공간과 겹치는 문턱 칸은 먼저 칠한 쪽을 둔다
      if (this.region[i] === -3 || this.region[i] === -2) this.region[i] = index;
    });
  }
  addDisk(x, z, r, region) {
    this.forBox([{ x: x - r, z: z - r }, { x: x + r, z: z + r }], (ix, iz, p) => {
      if ((p.x - x) ** 2 + (p.z - z) ** 2 > r * r) return;
      const i = this.idx(ix, iz); this.floor[i] = 1; this.region[i] = region;
    });
  }
  addRect(x0, z0, x1, z1, region) {
    this.forBox([{ x: x0, z: z0 }, { x: x1, z: z1 }], (ix, iz) => { const i = this.idx(ix, iz); this.floor[i] = 1; if (this.region[i] === -3) this.region[i] = region; });
  }
  cornersOf(c) {
    const f = { x: Math.sin(c.angle), z: -Math.cos(c.angle) }, r = { x: Math.cos(c.angle), z: Math.sin(c.angle) };
    return [[-c.w / 2, 0], [c.w / 2, 0], [c.w / 2, c.d], [-c.w / 2, c.d]].map(([u, v]) => ({ x: c.x + r.x * u + f.x * v, z: c.z + r.z * u + f.z * v }));
  }
  forBox(pts, fn) {
    const xs = pts.map(p => p.x), zs = pts.map(p => p.z);
    const [ax, az] = this.cellOf(Math.min(...xs), Math.min(...zs));
    const [bx, bz] = this.cellOf(Math.max(...xs), Math.max(...zs));
    for (let iz = Math.max(0, az); iz <= Math.min(this.nz - 1, bz); iz++) for (let ix = Math.max(0, ax); ix <= Math.min(this.nx - 1, bx); ix++) fn(ix, iz, this.center(ix, iz));
  }
  // 장애물: 선분(벽, 두께 포함) · 회전 상자 · 원. pad = Hana 반지름
  blockSegment(x1, z1, x2, z2, half, pad = 0.22, layer = this.block) {
    const r = half + pad;
    this.forBox([{ x: Math.min(x1, x2) - r, z: Math.min(z1, z2) - r }, { x: Math.max(x1, x2) + r, z: Math.max(z1, z2) + r }], (ix, iz, p) => {
      const dx = x2 - x1, dz = z2 - z1, L2 = dx * dx + dz * dz || 1;
      const t = Math.max(0, Math.min(1, ((p.x - x1) * dx + (p.z - z1) * dz) / L2));
      const qx = x1 + dx * t - p.x, qz = z1 + dz * t - p.z;
      if (qx * qx + qz * qz <= r * r) layer[this.idx(ix, iz)] = 1;
    });
  }
  blockBox(cx, cz, hw, hd, angle, pad = 0.22, layer = this.block) {
    const ca = Math.cos(angle), sa = Math.sin(angle), R = Math.hypot(hw, hd) + pad;
    this.forBox([{ x: cx - R, z: cz - R }, { x: cx + R, z: cz + R }], (ix, iz, p) => {
      const dx = p.x - cx, dz = p.z - cz;
      const lx = dx * ca + dz * sa, lz = -dx * sa + dz * ca;
      const ox = Math.max(0, Math.abs(lx) - hw), oz = Math.max(0, Math.abs(lz) - hd);
      if (ox * ox + oz * oz <= pad * pad) layer[this.idx(ix, iz)] = 1;
    });
  }
  blockDisk(x, z, r, pad = 0.22) { this.blockSegment(x, z, x, z, r, pad); }
  clearDyn(pts) { this.forBox(pts, (ix, iz) => { this.dyn[this.idx(ix, iz)] = 0; }); }

  // 가장 가까운 걸을 수 있는 칸
  nearestWalkable(x, z, maxR = 3) {
    const [cx, cz] = this.cellOf(x, z);
    if (this.walkableCell(cx, cz)) return this.center(cx, cz);
    const R = Math.ceil(maxR / this.cell);
    for (let r = 1; r <= R; r++) {
      let best = null, bd = Infinity;
      for (let dz = -r; dz <= r; dz++) for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
        if (!this.walkableCell(cx + dx, cz + dz)) continue;
        const d = dx * dx + dz * dz; if (d < bd) { bd = d; best = this.center(cx + dx, cz + dz); }
      }
      if (best) return best;
    }
    return null;
  }

  // A*(8방향, 모서리 자르기 금지) → 세계 좌표 경로(곧게 편 것)
  findPath(sx, sz, tx, tz) {
    const s = this.nearestWalkable(sx, sz, 1.5), t = this.nearestWalkable(tx, tz, 3);
    if (!s || !t) return null;
    const [ax, az] = this.cellOf(s.x, s.z), [bx, bz] = this.cellOf(t.x, t.z);
    const n = this.nx * this.nz;
    const g = new Float32Array(n).fill(Infinity), from = new Int32Array(n).fill(-1), closed = new Uint8Array(n);
    const heap = new MinHeap();
    const H = (ix, iz) => { const dx = Math.abs(ix - bx), dz = Math.abs(iz - bz); return (dx + dz) + (Math.SQRT2 - 2) * Math.min(dx, dz); };
    const start = this.idx(ax, az), goal = this.idx(bx, bz);
    g[start] = 0; heap.push(start, H(ax, az));
    let steps = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === goal) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++steps > 400000) return null;
      const cx = cur % this.nx, cz = (cur - cx) / this.nx;
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        if (!dx && !dz) continue;
        const nx = cx + dx, nz = cz + dz;
        if (!this.walkableCell(nx, nz)) continue;
        if (dx && dz && (!this.walkableCell(cx + dx, cz) || !this.walkableCell(cx, cz + dz))) continue;
        const ni = this.idx(nx, nz);
        if (closed[ni]) continue;
        const ng = g[cur] + (dx && dz ? Math.SQRT2 : 1);
        if (ng < g[ni]) { g[ni] = ng; from[ni] = cur; heap.push(ni, ng + H(nx, nz)); }
      }
    }
    if (from[goal] === -1 && goal !== start) return null;
    const cells = [];
    for (let c = goal; c !== -1; c = from[c]) { cells.push(c); if (c === start) break; }
    cells.reverse();
    const pts = cells.map(c => { const ix = c % this.nx; return this.center(ix, (c - ix) / this.nx); });
    pts[pts.length - 1] = { x: tx, z: tz };
    if (!this.walkable(tx, tz)) pts[pts.length - 1] = t;
    return this.simplify([{ x: sx, z: sz }, ...pts]);
  }
  lineClear(a, b) {
    const d = Math.hypot(b.x - a.x, b.z - a.z), n = Math.ceil(d / (this.cell * 0.5));
    for (let i = 1; i < n; i++) { const t = i / n; if (!this.walkable(a.x + (b.x - a.x) * t, a.z + (b.z - a.z) * t)) return false; }
    return true;
  }
  simplify(pts) {
    if (pts.length < 3) return pts;
    const out = [pts[0]];
    let i = 0;
    while (i < pts.length - 1) {
      let j = pts.length - 1;
      while (j > i + 1 && !this.lineClear(pts[i], pts[j])) j--;
      out.push(pts[j]); i = j;
    }
    return out;
  }
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(key, pri) {
    const k = this.k, p = this.p; let i = k.length; k.push(key); p.push(pri);
    while (i > 0) { const j = (i - 1) >> 1; if (p[j] <= pri) break; k[i] = k[j]; p[i] = p[j]; i = j; }
    k[i] = key; p[i] = pri;
  }
  pop() {
    const k = this.k, p = this.p, top = k[0], lk = k.pop(), lp = p.pop();
    if (k.length) {
      let i = 0; const n = k.length;
      for (;;) { let c = 2 * i + 1; if (c >= n) break; if (c + 1 < n && p[c + 1] < p[c]) c++; if (p[c] >= lp) break; k[i] = k[c]; p[i] = p[c]; i = c; }
      k[i] = lk; p[i] = lp;
    }
    return top;
  }
}
