// 회색 Bayer 다이아몬드 배경 — animate 스킬 element-kit.js background('diamonds')를 페이지용으로 옮김
// (원본: Codrops "Three.js Bayer Dither Playground" Diamonds 셰이더). 종이 위 먹색 다이아몬드 16%, 7px 칸,
// 8×8 Bayer + fbm 구름. 원본은 화면 비율로 아래·양옆 가장자리를 정했는데, 섹션은 세로로 길어서
// 아래 360px · 양옆 260px 띠로 정하고(위·아래 끝은 흐림) 띠 밖은 계산하지 않는다. 초당 10번, 화면에 보일 때만 그린다.
(() => {
  const INK = '#1c1a16', ALPHA = 0.16, P = 7, SPEED = 0.07, DENSITY = 0.05, FPS = 10;
  const BOTTOM = 360, SIDE = 260;
  const fract = x => x - Math.floor(x);
  const hash = n => fract(Math.sin(n) * 43758.5453);
  const smooth = f => f * f * f * (f * (f * 6 - 15) + 10);
  const lerp = (a, b, k) => a + (b - a) * k;
  function vnoise(x, y, z) {
    const ix = Math.floor(x), iy = Math.floor(y), iz = Math.floor(z);
    const wx = smooth(x - ix), wy = smooth(y - iy), wz = smooth(z - iz);
    const h = (a, b, c) => hash((ix + a) + (iy + b) * 57 + (iz + c) * 113);
    return lerp(lerp(lerp(h(0, 0, 0), h(1, 0, 0), wx), lerp(h(0, 1, 0), h(1, 1, 0), wx), wy),
                lerp(lerp(h(0, 0, 1), h(1, 0, 1), wx), lerp(h(0, 1, 1), h(1, 1, 1), wx), wy), wz);
  }
  function fbm(u, v, t) {
    let sum = 1, freq = 1;
    for (let i = 0; i < 5; i++) { sum += vnoise(u * 4 * freq, v * 4 * freq, t * freq); freq *= 1.25; }
    return sum * 0.5 + 0.5;
  }
  const bayer2 = (x, y) => { x = Math.floor(x); y = Math.floor(y); return fract(x / 2 + y * y * 0.75); };
  const bayer4 = (x, y) => bayer2(x * 0.5, y * 0.5) * 0.25 + bayer2(x, y);
  const bayer8 = (x, y) => bayer4(x * 0.5, y * 0.5) * 0.25 + bayer2(x, y);
  const ss = (a, b, x) => { const k = Math.max(0, Math.min(1, (x - a) / (b - a))); return k * k * (3 - 2 * k); };
  const still = matchMedia('(prefers-reduced-motion: reduce)');

  document.querySelectorAll('canvas.dia').forEach(cv => {
    const g = cv.getContext('2d');
    let W = 0, H = 0, visible = false, last = 0, raf = 0;
    const draw = t => {
      g.clearRect(0, 0, W, H);
      g.fillStyle = INK; g.globalAlpha = ALPHA;
      const r = 0.564 * P, scale = Math.min(W, 1440);
      g.beginPath();
      for (let py = 0; py < H; py += P) {
        // 위·아래 섹션 경계에서 직선으로 끊기지 않게 끝 110px은 흐린다
        const fade = ss(0, 110, py) * (1 - ss(H - 110, H, py)), wb = ss(H - BOTTOM - 60, H - 200, py) * fade;
        for (let px = 0; px < W; px += P) {
          const w = Math.max(wb, ss(SIDE, 30, Math.min(px, W - px)) * fade);
          if (w <= 0.02) continue;
          const feed = fbm((px - W / 2) / scale * 1.6, (py - H) / scale * 1.6, t * SPEED) * 0.5 - 0.65 + DENSITY - (1 - w) * 1.1;
          if (feed + bayer8(px / P, py / P) - 0.5 < 0.5) continue;
          const mx = px + 0.49 * P, my = py + 0.49 * P;
          g.moveTo(mx, my - r); g.lineTo(mx + r, my); g.lineTo(mx, my + r); g.lineTo(mx - r, my); g.closePath();
        }
      }
      g.fill(); g.globalAlpha = 1;
    };
    const fit = () => {
      const box = cv.parentElement.getBoundingClientRect();
      W = Math.ceil(box.width); H = Math.ceil(box.height);
      cv.width = W; cv.height = H;
      draw(performance.now() / 1000);
    };
    const loop = now => {
      raf = 0;
      if (!visible || still.matches) return;
      if (now - last >= 1000 / FPS) { last = now; draw(now / 1000); }
      raf = requestAnimationFrame(loop);
    };
    new IntersectionObserver(([e]) => { visible = e.isIntersecting; if (visible && !raf) raf = requestAnimationFrame(loop); }).observe(cv.parentElement);
    new ResizeObserver(fit).observe(cv.parentElement);
  });
})();
