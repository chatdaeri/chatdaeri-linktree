// 스크롤 연출(GSAP ScrollTrigger). 움직임 줄이기 설정이면 아무것도 하지 않는다.
(() => {
  if (!window.gsap || !window.ScrollTrigger) return;
  gsap.registerPlugin(ScrollTrigger);
  const mm = gsap.matchMedia();

  // [6] 대시보드: 섹션을 고정하고 스크롤에 맞춰 패널로 차례로 확대 + 세컨드 브레인 구체를 스크롤만큼 돌린다 (데스크톱만)
  mm.add('(min-width: 901px) and (prefers-reduced-motion: no-preference)', () => {
    const dash = document.querySelector('[data-dash]');
    const frame = dash.querySelector('.shot-frame'), media = frame.querySelector('.shot-media');
    const steps = [...dash.querySelectorAll('.dash-steps li')];
    document.documentElement.classList.add('motion-on');
    // 영상 원본 1600×1000 기준 영역 [x0, y0, x1, y1]. null = 전체
    const regions = [null, [24, 60, 396, 240], [430, 330, 1170, 860], [1204, 465, 1576, 717], [1204, 741, 1576, 1000], null];
    const view = r => {
      const W = frame.clientWidth, H = frame.clientHeight, k = W / 1600;
      if (!r) return { x: 0, y: 0, scale: 1 };
      const [x0, y0, x1, y1] = r, rw = (x1 - x0) * k, rh = (y1 - y0) * k;
      const s = Math.min(W / rw, H / rh) * 0.86;
      const cx = (x0 + x1) / 2 * k, cy = (y0 + y1) / 2 * k;
      const x = Math.min(0, Math.max(W - W * s, W / 2 - cx * s));
      const y = Math.min(0, Math.max(H - H * s, H / 2 - cy * s));
      return { x, y, scale: s };
    };
    const HOLD = 0.7, MOVE = 1;
    const tl = gsap.timeline({ defaults: { ease: 'power2.inOut' } });
    tl.set(media, view(null)).to({}, { duration: HOLD });
    regions.slice(1).forEach(r => {
      tl.to(media, { x: () => view(r).x, y: () => view(r).y, scale: () => view(r).scale, duration: MOVE })
        .to({}, { duration: HOLD });
    });
    const setStep = i => steps.forEach((li, k) => li.classList.toggle('on', k === i));
    setStep(0);
    ScrollTrigger.create({
      animation: tl, trigger: dash, start: 'center center+=32', end: () => '+=' + window.innerHeight * 3.2,
      pin: dash, pinSpacing: true, scrub: 0.6, invalidateOnRefresh: true,
      onUpdate: () => {
        const seg = Math.floor(Math.max(0, tl.time() - HOLD / 2) / (HOLD + MOVE) + 0.5);
        const i = seg >= regions.length - 1 ? 0 : seg;
        setStep(i); frame.classList.toggle('zoomed', i > 0);
      }
    });

    // 구체 회전: 영상(134프레임 = 한 바퀴, 처음과 끝이 이어짐)을 재생하지 않고 스크롤 위치의 장면으로 옮긴다. 섹션을 지나는 동안 두 바퀴
    const TURNS = 2;
    let want = 0, busy = false;
    const seek = () => {
      const d = media.duration;
      if (busy || !d || media.readyState < 1) return;
      const t = Math.min(d - 1 / 30, (want * TURNS % 1) * d);
      if (Math.abs(media.currentTime - t) < 1 / 90) return;
      busy = true; media.currentTime = t;
    };
    const done = () => { busy = false; seek(); };
    media.addEventListener('seeked', done);
    media.addEventListener('loadedmetadata', seek);
    media.preload = 'auto'; media.load();
    ScrollTrigger.create({ trigger: '#out', start: 'top bottom', end: 'bottom top', onUpdate: s => { want = s.progress; seek(); } });

    return () => {
      media.removeEventListener('seeked', done); media.removeEventListener('loadedmetadata', seek);
      document.documentElement.classList.remove('motion-on'); frame.classList.remove('zoomed'); gsap.set(media, { clearProps: 'all' });
    };
  });

  mm.add('(prefers-reduced-motion: no-preference)', () => {
    // [5] 커리큘럼 카드: 화면에 들어오는 묶음마다 떠오름
    gsap.set('.unit', { opacity: 0, y: 24 });
    ScrollTrigger.batch('.unit', { start: 'top 88%', once: true,
      onEnter: b => gsap.to(b, { opacity: 1, y: 0, duration: 0.6, stagger: 0.08, ease: 'power2.out' }) });
  });

  addEventListener('load', () => ScrollTrigger.refresh());

  // [2] 적용 전·후 채팅: 화면에 들어오면 내 말풍선 → AI 입력 중(점 세 개) → AI 답
  const quiet = matchMedia('(prefers-reduced-motion: reduce)').matches;
  if (!quiet) {
    document.documentElement.classList.add('js-chat');
    const io = new IntersectionObserver(entries => entries.forEach(e => {
      if (!e.isIntersecting) return;
      io.unobserve(e.target);
      // 한 대화창 안의 대화를 위에서부터 차례로
      e.target.querySelectorAll('.chat').forEach((c, k) => {
        const t = k * 1700;
        setTimeout(() => c.classList.add('seen'), t);
        setTimeout(() => c.classList.add('ai'), t + 450);
        setTimeout(() => c.classList.add('done'), t + 1350);
      });
    }), { threshold: 0.5 });
    document.querySelectorAll('.chat-box').forEach(c => io.observe(c));
  }

  // [3] SSR+ 모션그래픽: 화면 절반 이상 보이면 한 번 재생, 끝나면 '다시 보기'
  const mg = document.querySelector('.mg-video'), again = document.querySelector('.mg-replay');
  if (mg) {
    const play = () => { again.hidden = true; mg.currentTime = 0; mg.play().catch(() => { again.hidden = false; }); };
    mg.addEventListener('ended', () => { again.textContent = '다시 보기'; again.hidden = false; });
    again.addEventListener('click', play);
    if (quiet) { again.textContent = '재생'; again.hidden = false; }
    else new IntersectionObserver((entries, o) => { if (entries[0].isIntersecting) { o.disconnect(); play(); } }, { threshold: 0.55 }).observe(mg);
  }
  document.fonts?.ready.then(() => ScrollTrigger.refresh());
})();
