// 걷기 격자(scene.nav: 0.1m 칸, '1' = 걸을 수 있음) + A* 길찾기 + 직선으로 줄이기
export class Nav {
  constructor(n) {
    this.c = n.cell; this.w = n.w; this.h = n.h;
    this.g = new Uint8Array(this.w * this.h);
    n.rows.forEach((row, j) => { for (let i = 0; i < row.length; i++) this.g[j * this.w + i] = row.charCodeAt(i) === 49 ? 1 : 0; });
  }
  cellOf(x, z) { return [Math.floor(x / this.c), Math.floor(z / this.c)]; }
  ok(i, j) { return i >= 0 && j >= 0 && i < this.w && j < this.h && this.g[j * this.w + i] === 1; }
  walkable(x, z) { const [i, j] = this.cellOf(x, z); return this.ok(i, j); }
  nearest(x, z, maxR = 40) {
    const [i0, j0] = this.cellOf(x, z);
    if (this.ok(i0, j0)) return [x, z];
    for (let r = 1; r <= maxR; r++) for (let dj = -r; dj <= r; dj++) for (let di = -r; di <= r; di++) {
      if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
      if (this.ok(i0 + di, j0 + dj)) return [(i0 + di + 0.5) * this.c, (j0 + dj + 0.5) * this.c];
    }
    return null;
  }
  find(ax, az, bx, bz) {
    const s = this.nearest(ax, az), e = this.nearest(bx, bz);
    if (!s || !e) return null;
    const [si, sj] = this.cellOf(...s), [ei, ej] = this.cellOf(...e);
    const W = this.w, N = W * this.h, gS = new Float32Array(N).fill(Infinity), from = new Int32Array(N).fill(-1), closed = new Uint8Array(N);
    const h = (i, j) => { const dx = Math.abs(i - ei), dy = Math.abs(j - ej); return dx + dy - 0.586 * Math.min(dx, dy); };
    const open = [[h(si, sj), si, sj]]; gS[sj * W + si] = 0;
    const D = [[1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1], [1, 1, 1.414], [1, -1, 1.414], [-1, 1, 1.414], [-1, -1, 1.414]];
    let found = false;
    while (open.length) {
      let bi = 0; for (let k = 1; k < open.length; k++) if (open[k][0] < open[bi][0]) bi = k;
      const [, i, j] = open.splice(bi, 1)[0], id = j * W + i;
      if (closed[id]) continue; closed[id] = 1;
      if (i === ei && j === ej) { found = true; break; }
      for (const [di, dj, cost] of D) {
        const ni = i + di, nj = j + dj; if (!this.ok(ni, nj)) continue;
        if (di && dj && (!this.ok(i + di, j) || !this.ok(i, j + dj))) continue; // 모서리 깎지 않기
        const nid = nj * W + ni, ng = gS[id] + cost;
        if (ng < gS[nid]) { gS[nid] = ng; from[nid] = id; open.push([ng + h(ni, nj), ni, nj]); }
      }
    }
    if (!found) return null;
    const cells = []; for (let id = ej * W + ei; id !== -1; id = from[id]) cells.push([(id % W + 0.5) * this.c, (Math.floor(id / W) + 0.5) * this.c]);
    cells.reverse();
    // 보이는 곳까지 건너뛰기
    const pts = [cells[0]];
    let k = 0;
    while (k < cells.length - 1) {
      let far = k + 1;
      for (let m = cells.length - 1; m > k + 1; m--) if (this.clear(cells[k], cells[m])) { far = m; break; }
      pts.push(cells[far]); k = far;
    }
    pts[pts.length - 1] = e;
    return pts;
  }
  clear(a, b) {
    const L = Math.hypot(b[0] - a[0], b[1] - a[1]), n = Math.ceil(L / (this.c * 0.5));
    for (let s = 1; s < n; s++) { const t = s / n; if (!this.walkable(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t)) return false; }
    return true;
  }
}
