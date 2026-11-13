// 스크롤 = 실사 걷기 영상의 재생 지점. 방에 들어서면 왼쪽 위에 방 정보 카드가 떠오른다.
// 영상: naver-2room.scroll.tools/after2-walk-real.mp4(Seedance 2.5로 실사화)를 모든 프레임 키프레임으로 다시 인코딩한 것(앞뒤 이동이 매끄럽게).
// 카드 시각(초)은 3D 스크롤 페이지(naver-2room.scroll)의 STOPS 진행도를 실사 영상 시각으로 옮긴 값이다.
const ROOMS = [
  { name: '현관', in: 0.0, out: 4.6, area: 0.9, w: 700, d: 1200, info: '포세린 타일 바닥 · 천장까지 닿는 신발장' },
  { name: '주방 · 식당', in: 5.6, out: 17.0, area: 9.2, w: 3100, d: 3300, info: '수제 유약 타일 벽 · 둥근 식탁 · 빨간 펜던트' },
  { name: '거실', in: 20.2, out: 27.6, area: 6.4, w: 2800, d: 2300, info: '넓은 판 오크 마루 · 노란 아치 벽 · 부클레 소파' },
  { name: '발코니', in: 29.4, out: 35.9, area: 6.3, w: 1600, d: 5400, info: '곡면 유리 · 라운지 의자 · 늦은 오후 햇살' },
  { name: '침실1', in: 44.8, out: 52.1, area: 8.3, w: 2800, d: 3000, info: '큰 창 · 밝은 오크 마루' },
  { name: '욕실', in: 54.7, out: 58.6, area: 2.8, w: 1400, d: 2000, info: '돌결 포세린 타일 · 샤워부스' },
  { name: '침실2', in: 62.1, out: 999, area: 5.0, w: 2100, d: 2500, info: '흰 책상 · 칸 책장' },
];
const FADE_IN = 1.6, FADE_OUT = 0.8, LINE_GAP = 0.25; // 초

const video = document.getElementById('tour'), cardsEl = document.getElementById('cards'), hint = document.getElementById('hint'), bar = document.querySelector('#bar i'), back3d = document.getElementById('back3d');
const fmt = n => n.toLocaleString('en-US');
const cards = ROOMS.map((r, i) => {
  const el = document.createElement('div'); el.className = 'card';
  el.innerHTML = `<div class="ln no">${String(i + 1).padStart(2, '0')} / ${String(ROOMS.length).padStart(2, '0')}</div>`
    + `<div class="ln nm">${r.name}</div>`
    + `<div class="ln sz">${r.area.toFixed(1)}㎡  ·  ${(r.area / 3.3058).toFixed(1)}평  ·  ${fmt(r.w)} × ${fmt(r.d)} mm</div>`
    + `<div class="ln fn">${r.info}</div>`;
  cardsEl.appendChild(el);
  return { r, el, lines: [...el.querySelectorAll('.ln')] };
});
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const outCubic = k => 1 - Math.pow(1 - k, 3);

function drawCards(t) {
  for (const { r, el, lines } of cards) {
    const k = smooth(r.in, r.in + FADE_IN * 0.5, t), o = smooth(r.out - FADE_OUT, r.out, t);
    if (k <= 0.001 || o >= 0.999) { el.style.opacity = 0; continue; }
    el.style.opacity = k * (1 - o);
    lines.forEach((L, i) => {
      const e = outCubic(smooth(r.in + i * LINE_GAP, r.in + i * LINE_GAP + FADE_IN, t)); // 줄마다 조금씩 늦게
      L.style.opacity = e * (1 - o); L.style.transform = `translateY(${(1 - e) * 18 - o * 12}px)`;
      if (i === 0) L.style.setProperty('--e', e);
    });
  }
}

let ready = false, target = 0, shown = 0;
history.scrollRestoration = 'manual'; scrollTo(0, 0); // 새로 열면 현관부터
const lenis = new Lenis({ lerp: 0.09, smoothWheel: true }); window.__lenis = lenis;
function progress() { const max = document.documentElement.scrollHeight - innerHeight; return max > 0 ? clamp01(scrollY / max) : 0; }
lenis.on('scroll', () => { target = progress(); });

function loop(now) {
  lenis.raf(now);
  if (ready) {
    shown += (target - shown) * 0.12; if (Math.abs(target - shown) < 1e-4) shown = target;
    const want = shown * Math.max(0, video.duration - 0.05);
    if (!video.seeking && Math.abs(video.currentTime - want) > 1 / 60) video.currentTime = want;
    const t = video.currentTime; // 카드는 영상이 지금 보여 주는 프레임에 맞춘다
    drawCards(t);
    bar.style.width = `${(t / video.duration) * 100}%`;
    hint.style.opacity = shown < 0.01 ? 1 : 0;
    back3d.classList.toggle('on', shown > 0.97);
  }
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

function start() { if (ready) return; ready = true; video.pause(); document.getElementById('load').classList.add('done'); }
if (video.readyState >= 2) start(); else video.addEventListener('loadeddata', start, { once: true });
