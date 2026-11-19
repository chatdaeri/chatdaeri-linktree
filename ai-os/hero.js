// 히어로: 세컨드 브레인(분야 구체 6개 + 가운데 핵)을 1비트 다이아몬드 점묘로 그린다.
// 칸마다 구와 만나는 앞면을 찾아 빛을 계산하고 8×8 Bayer 문턱으로 켜고 끈다(diamonds.js와 같은 점묘 규칙).
// 천천히 돌고, 마우스 쪽으로 살짝 기울며, 바깥에서 자료 점이 구체로 빨려 들어간다. 움직임 줄이기면 한 장만 그린다.
(() => {
  const cv = document.querySelector('.hero-art');
  if (!cv) return;
  const g = cv.getContext('2d');
  const INK = '#1c1a16', ORANGE = '#FF7E5F', P = 5;
  const fract = x => x - Math.floor(x);
  const bayer2 = (x, y) => fract(x / 2 + y * y * 0.75);
  const bayer4 = (x, y) => bayer2(Math.floor(x * 0.5), Math.floor(y * 0.5)) * 0.25 + bayer2(x, y);
  const bayer8 = (x, y) => bayer4(Math.floor(x * 0.5), Math.floor(y * 0.5)) * 0.25 + bayer2(x, y);
  const LIGHT = (() => { const v = [-0.5, -0.6, 0.62]; const n = Math.hypot(...v); return v.map(c => c / n); })();
  // 구: 고리 위 6개(분야) + 가운데 핵. 단위 = 그림 반지름
  const balls = [...Array(6)].map((_, i) => ({ a: Math.PI + i * Math.PI / 3, d: 0.66, r: 0.23 + (i % 3) * 0.025 }));
  const still = matchMedia('(prefers-reduced-motion: reduce)');
  let W = 0, H = 0, R = 0, cx = 0, cy = 0, yaw = 0.3, tx = 0, ty = 0, mx = 0, my = 0, last = 0, visible = true;
  const bits = [];

  const fit = () => {
    const box = cv.getBoundingClientRect(), dpr = Math.min(2, devicePixelRatio || 1);
    W = box.width; H = box.height; cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    R = Math.min(W, H) * 0.46; cx = W / 2; cy = H / 2;
  };
  // 3D 점을 화면으로: 고리는 기울어진 평면(pitch), yaw로 돈다
  const place = (yawNow, pitch) => {
    const out = [{ x: 0, y: 0, z: 0, r: 0.16, core: true }];
    for (const b of balls) {
      const x0 = Math.cos(b.a + yawNow) * b.d, z0 = Math.sin(b.a + yawNow) * b.d;
      out.push({ x: x0, y: z0 * Math.sin(pitch), z: z0 * Math.cos(pitch), r: b.r });
    }
    return out;
  };
  const spawn = () => {
    const side = Math.random() * Math.PI * 2, far = 1.5 + Math.random() * 0.5;
    bits.push({ x: Math.cos(side) * far, y: Math.sin(side) * far * 0.8, k: 0, s: 0.004 + Math.random() * 0.006, to: 1 + Math.floor(Math.random() * 6), hot: Math.random() < 0.25 });
  };
  for (let i = 0; i < 26; i++) { spawn(); bits[i].k = Math.random(); }

  const draw = () => {
    g.clearRect(0, 0, W, H);
    const pitch = 1.05 + ty * 0.25, yawNow = yaw + tx * 0.35;
    const s = place(yawNow, pitch);
    const r = 0.564 * P;
    const ink = new Path2D(), hot = new Path2D();
    const x0 = Math.floor((cx - R * 1.35) / P) * P, x1 = cx + R * 1.35, y0 = Math.floor((cy - R * 1.2) / P) * P, y1 = cy + R * 1.2;
    for (let py = y0; py < y1; py += P) for (let px = x0; px < x1; px += P) {
      const u = (px + P / 2 - cx) / R, v = (py + P / 2 - cy) / R;
      let best = null, bz = -9;
      for (const b of s) {
        const dx = u - b.x, dy = v - b.y, q = b.r * b.r - dx * dx - dy * dy;
        if (q <= 0) continue;
        const z = b.z + Math.sqrt(q);
        if (z > bz) { bz = z; best = { b, nx: dx / b.r, ny: dy / b.r, nz: Math.sqrt(q) / b.r }; }
      }
      if (!best) continue;
      const lit = Math.max(0, best.nx * LIGHT[0] + best.ny * LIGHT[1] + best.nz * LIGHT[2]);
      const depth = 0.75 + 0.25 * (best.b.z + 0.6);        // 뒤쪽 구는 옅게
      const tone = (0.18 + 0.82 * lit) * depth;               // 1 = 가장 밝음(점이 적음)
      const ix = Math.floor(px / P), iy = Math.floor(py / P);
      if (1 - tone < bayer8(ix, iy) + 0.06) continue;          // 어두운 곳일수록 점이 많다
      const path = best.b.core ? hot : ink;
      const mxp = px + P / 2, myp = py + P / 2;
      path.moveTo(mxp, myp - r); path.lineTo(mxp + r, myp); path.lineTo(mxp, myp + r); path.lineTo(mxp - r, myp); path.closePath();
    }
    g.fillStyle = INK; g.fill(ink);
    g.fillStyle = ORANGE; g.fill(hot);
    // 자료 점: 바깥에서 구체로 빨려 들어간다
    for (const p of bits) {
      const t = s[p.to], e = p.k * p.k;
      const x = cx + (p.x + (t.x - p.x) * e) * R, y = cy + (p.y + (t.y - p.y) * e) * R;
      const a = Math.min(1, p.k * 4) * (1 - Math.max(0, p.k - 0.85) / 0.15);
      g.globalAlpha = a; g.fillStyle = p.hot ? ORANGE : INK;
      const q = p.hot ? 3.4 : 2.6;
      g.beginPath(); g.moveTo(x, y - q); g.lineTo(x + q, y); g.lineTo(x, y + q); g.lineTo(x - q, y); g.closePath(); g.fill();
    }
    g.globalAlpha = 1;
  };
  const tick = now => {
    if (!visible || still.matches) { last = 0; return; }
    const dt = last ? Math.min(0.05, (now - last) / 1000) : 0; last = now;
    yaw += dt * 0.22;
    tx += (mx - tx) * 0.06; ty += (my - ty) * 0.06;
    for (let i = bits.length - 1; i >= 0; i--) { bits[i].k += bits[i].s * dt * 60; if (bits[i].k >= 1) { bits.splice(i, 1); spawn(); } }
    draw();
    requestAnimationFrame(tick);
  };
  addEventListener('pointermove', e => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; });
  new ResizeObserver(() => { fit(); draw(); }).observe(cv);
  new IntersectionObserver(([e]) => { const was = visible; visible = e.isIntersecting; if (visible && !was) requestAnimationFrame(tick); }).observe(cv);
  fit(); draw(); requestAnimationFrame(tick);
})();
