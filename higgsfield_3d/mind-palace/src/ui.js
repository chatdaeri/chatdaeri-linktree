// 화면 UI: 위치 표시, 상호작용 표시, 책 카드, 검색, 메뉴, 평면도·방명록·도구 카드·조작법, 2D 목록, 미니맵
import { $, $$, h, fmtSize, fmtDate, toast, store } from './util.js';
import { SHAPE_NAME } from './shelves.js';

// ---------- 검색(find-lib.mjs와 같은 점수: 드문 낱말일수록 무겁게, 이름에 들면 1.25배) ----------
export class Search {
  constructor(app) {
    this.app = app;
    this.rows = [];
    const alias = app.palace.aliases ?? [];
    const extra = low => { const s = new Set(); for (const g of alias) if (g.some(t => low.includes(t.toLowerCase()))) g.forEach(t => s.add(t.toLowerCase())); return [...s].join(' '); };
    let order = 0;
    for (const s of Object.values(app.palace.shelves)) for (const b of s.books) {
      const name = b.title.normalize('NFC').toLowerCase();
      const base = `${name} ${(b.path ?? b.url ?? '').normalize('NFC').toLowerCase()} ${(b.desc ?? '').normalize('NFC').toLowerCase()}`;
      this.rows.push({ book: b, shelf: s, name, low: `${base} ${extra(base)}`, order: order++ });
      for (const a of b.attachments ?? []) {
        const an = a.title.normalize('NFC').toLowerCase();
        const ab = `${an} ${(a.path ?? a.url ?? '').normalize('NFC').toLowerCase()} ${(a.desc ?? '').toLowerCase()}`;
        this.rows.push({ book: b, att: a, shelf: s, name: an, low: `${ab} ${extra(ab)}`, order: order++ });
      }
    }
  }
  query(q, max = 30) {
    const keys = q.normalize('NFC').toLowerCase().split(/\s+/).filter(Boolean);
    if (!keys.length) return [];
    const N = this.rows.length;
    const df = Object.fromEntries(keys.map(k => [k, this.rows.reduce((n, r) => n + (r.low.includes(k) ? 1 : 0), 0)]));
    const weight = k => 1 + 0.5 * Math.log((N + 1) / (df[k] + 1));
    const hits = [];
    for (const r of this.rows) {
      const m = keys.filter(k => r.low.includes(k)); if (!m.length) continue;
      hits.push({ ...r, score: m.reduce((s, k) => s + weight(k) * (r.name.includes(k) ? 1.25 : 1), 0), n: m.length });
    }
    hits.sort((a, b) => b.score - a.score || a.order - b.order);
    return hits.slice(0, max);
  }
}

export class UI {
  constructor(app) {
    this.app = app; this.cfg = app.config; this.copy = app.config.copy;
    this.search = new Search(app);
    this.sel = -1; this.results = [];
    this.setupSearch(); this.setupMenu();
    $('#btn-minimap').addEventListener('click', () => { const mm = $('#minimap'); mm.hidden = !mm.hidden; $('#btn-minimap').setAttribute('aria-pressed', String(!mm.hidden)); store.set('minimap', !mm.hidden); });
    if (store.get('minimap', true) === false) { $('#minimap').hidden = true; $('#btn-minimap').setAttribute('aria-pressed', 'false'); }
    this.mm = $('#minimap').getContext('2d');
  }

  // ---------- 위치·표시 ----------
  setWhere(parts) {
    const el = $('#where'); const key = parts.map(p => p.text).join('|');
    if (el.dataset.key === key) return; el.dataset.key = key; el.innerHTML = '';
    parts.forEach((p, i) => { if (i) el.append(h('span', { class: 'sep' }, '›')); el.append(h('span', {}, p.color ? h('i', { class: 'dot', style: { background: p.color } }) : null, p.text)); });
  }
  setPrompt(text) {
    const el = $('#prompt');
    if (!text) { el.hidden = true; return; }
    el.querySelector('span').textContent = text; el.hidden = false;
  }
  shelfBar(info, actions = []) {
    const bar = $('#shelf-bar');
    if (!info) { bar.hidden = true; return; }
    bar.querySelector('strong').textContent = info.s.label || info.s.title;
    const room = this.app.world.roomById.get(info.room);
    bar.querySelector('.shelf-bar-title span').textContent = `${room?.name ?? ''} · ${info.s.books.length.toLocaleString('ko-KR')}권`;
    const box = bar.querySelector('.shelf-bar-actions'); box.innerHTML = '';
    for (const a of actions) box.append(h('button', { class: 'btn', type: 'button', onclick: a.run }, a.label));
    bar.hidden = false;
  }
  hoverLabel(rec, x, y) {
    const el = $('#book-hover');
    if (!rec) { el.hidden = true; return; }
    el.innerHTML = ''; el.append(rec.book.title, h('small', {}, `${rec.level}단 ${rec.within + 1 + rec.bay * 30}번째${rec.missing ? ` · ${this.copy.missing}` : ''}`));
    el.style.left = `${x}px`; el.style.top = `${y}px`; el.hidden = false;
  }

  // ---------- 책 카드 ----------
  showCard(rec, { onOpen, onClose, onAttach, onIndex }) {
    const b = rec.book, room = this.app.world.roomById.get(rec.info.room), cfg = this.app.world.roomCfg.get(rec.info.room);
    const card = $('#card'); card.innerHTML = '';
    const kind = b.kind === 'web' ? 'web' : b.kind === 'dir' ? '폴더' : (b.ext || '파일').toUpperCase();
    const where = `${room?.name ?? ''} › ${rec.info.s.label || rec.info.s.title} › ${rec.level}단 ${rec.bay * 30 + rec.within + 1}번째`;
    const meta = h('dl', { class: 'card-meta' },
      h('dt', {}, '위치'), h('dd', {}, where),
      h('dt', {}, '종류'), h('dd', {}, `${kind} · ${SHAPE_NAME[rec.shape] ?? ''}`),
      b.size != null ? [h('dt', {}, '크기'), h('dd', {}, fmtSize(b.size))] : null,
      b.mtime ? [h('dt', {}, '수정일'), h('dd', {}, fmtDate(b.mtime))] : null,
      h('dt', {}, '경로'), h('dd', {}, h('code', {}, b.url ?? b.path ?? '')));
    const head = h('div', { class: 'card-kind' }, h('i', { style: { background: cfg?.spine ?? '#888' } }), b.section || rec.info.s.label);
    card.append(head, h('h2', { id: 'card-title' }, b.title), b.desc ? h('p', { class: 'card-desc' }, b.desc) : null, meta);
    if (b.exists === false) card.append(h('div', { class: 'card-missing' }, h('b', {}, this.copy.missing), h('br'), `${b.src.index} ${b.src.line}번째 줄`));
    if (b.attachments?.length) {
      const ul = h('ul', { class: 'card-attach' }, h('h3', {}, `부록 ${b.attachments.length}`));
      for (const a of b.attachments) ul.append(h('li', {}, h('span', { title: a.title }, a.title), h('button', { class: 'btn', type: 'button', onclick: () => onAttach(a) }, this.copy.open)));
      card.append(ul);
    }
    const acts = h('div', { class: 'card-actions' });
    if (b.exists === false) acts.append(h('button', { class: 'btn primary', type: 'button', onclick: onIndex }, this.copy.openIndex));
    else acts.append(h('button', { class: 'btn primary', type: 'button', onclick: onOpen }, this.copy.open));
    if (!b.url) {
      acts.append(h('button', { class: 'btn', type: 'button', onclick: () => this.app.copyPathOf(b) }, this.copy.copyPath));
      if (b.exists !== false) acts.append(h('button', { class: 'btn', type: 'button', onclick: () => this.app.external(b.id, 'finder') }, this.copy.reveal));
    }
    acts.append(h('button', { class: 'btn ghost', type: 'button', onclick: onClose }, this.copy.putBack));
    card.append(acts);
    $('#card-layer').hidden = false;
    this.cardReturn = document.activeElement;
    card.focus();
    card.querySelector('.btn.primary')?.focus();
  }
  hideCard() { $('#card-layer').hidden = true; if (this.cardReturn?.isConnected) this.cardReturn.focus?.(); }
  get cardOpen() { return !$('#card-layer').hidden; }

  // ---------- 검색 ----------
  setupSearch() {
    const input = $('#search'), box = $('#search-results');
    input.addEventListener('input', () => this.runSearch(input.value));
    input.addEventListener('focus', () => { if (input.value) this.runSearch(input.value); });
    input.addEventListener('keydown', e => {
      if (e.key === 'ArrowDown') { this.move(1); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { this.move(-1); e.preventDefault(); }
      else if (e.key === 'Enter') { const r = this.results[Math.max(0, this.sel)]; if (r) this.pick(r, e.shiftKey); e.preventDefault(); }
      else if (e.key === 'Escape') { this.closeSearch(); e.preventDefault(); e.stopPropagation(); }
    });
    document.addEventListener('pointerdown', e => { if (!e.target.closest('#search-wrap')) box.hidden = true; });
  }
  runSearch(q) {
    const box = $('#search-results');
    this.results = this.search.query(q, 30); this.sel = this.results.length ? 0 : -1;
    box.innerHTML = '';
    if (!q.trim()) { box.hidden = true; return; }
    if (!this.results.length) { box.append(h('div', { class: 'sr-empty' }, '찾는 자료가 없습니다.')); box.hidden = false; return; }
    let lastKey = '';
    this.results.forEach((r, i) => {
      const room = this.app.world.roomById.get(r.shelf.room), cfg = this.app.world.roomCfg.get(r.shelf.room);
      const key = `${r.shelf.room}|${r.shelf.id}`;
      if (key !== lastKey) { box.append(h('div', { class: 'sr-group' }, h('i', { class: 'dot', style: { width: '8px', height: '8px', borderRadius: '50%', display: 'inline-block', background: cfg?.spine } }), `${room?.name} › ${r.shelf.label || r.shelf.title}`)); lastKey = key; }
      box.append(h('button', { class: 'sr-item', role: 'option', type: 'button', 'aria-selected': i === this.sel ? 'true' : 'false', onclick: e => this.pick(r, e.shiftKey), onmouseenter: () => { this.sel = i; this.mark(); } },
        h('b', {}, r.att ? `${r.att.title}` : r.book.title), h('span', {}, r.att ? `부록 · ${r.book.title}` : (r.book.desc || r.book.path || r.book.url || ''))));
    });
    box.append(h('div', { class: 'sr-foot' }, h('span', {}, h('kbd', {}, 'Enter'), ' 길안내'), h('span', {}, h('kbd', {}, 'Shift'), '+', h('kbd', {}, 'Enter'), ' 바로 열기'), h('span', {}, h('kbd', {}, 'Esc'), ' 닫기')));
    box.hidden = false;
  }
  move(d) { if (!this.results.length) return; this.sel = (this.sel + d + this.results.length) % this.results.length; this.mark(); }
  mark() { $$('#search-results .sr-item').forEach((el, i) => { el.setAttribute('aria-selected', i === this.sel ? 'true' : 'false'); if (i === this.sel) el.scrollIntoView({ block: 'nearest' }); }); }
  pick(r, direct) { this.closeSearch(); this.app.fromSearch(r, direct); }
  closeSearch() { $('#search-results').hidden = true; $('#search').blur(); this.app.focusGame(); }
  openSearch() { const s = $('#search'); s.focus(); s.select(); }

  // ---------- 메뉴 ----------
  setupMenu() {
    const btn = $('#btn-menu'), menu = $('#menu');
    const items = [
      [this.copy.view2d, 'Tab', () => this.app.toggleList(true)],
      ['평면도', 'M', () => this.app.showPlan()],
      ['조작법', '?', () => this.app.showHelp()],
      null,
      ...(this.cfg.static ? [] : [[this.copy.refresh, '', () => this.app.refreshData()]]),
      [() => `${this.copy.sound} ${this.app.sound.enabled ? '끄기' : '켜기'}`, '', () => { this.app.sound.toggle(); }],
      null,
      [this.copy.startAtGate, '', () => this.app.startAtGate()],
      [this.copy.replayOpening, '', () => this.app.playOpening(true)],
      [this.copy.replayGuide, '', () => this.app.tutorial.restart()],
    ];
    const render = () => {
      menu.innerHTML = '';
      for (const it of items) {
        if (!it) { menu.append(h('hr')); continue; }
        const [label, key, run] = it;
        menu.append(h('button', { type: 'button', role: 'menuitem', onclick: () => { close(); run(); } }, typeof label === 'function' ? label() : label, key ? h('span', { class: 'k' }, key) : null));
      }
    };
    const close = () => { menu.hidden = true; btn.setAttribute('aria-expanded', 'false'); };
    btn.addEventListener('click', () => { if (menu.hidden) { render(); menu.hidden = false; btn.setAttribute('aria-expanded', 'true'); menu.querySelector('button')?.focus(); } else close(); });
    menu.addEventListener('keydown', e => { if (e.key === 'Escape') { close(); btn.focus(); e.stopPropagation(); } });
    document.addEventListener('pointerdown', e => { if (!e.target.closest('#hud-right')) close(); });
  }

  // ---------- 오버레이 ----------
  overlay(title, sub, content, onClose) {
    const ov = $('#overlay'), box = $('#overlay-box');
    box.innerHTML = '';
    box.append(h('div', { class: 'ov-head' }, h('div', {}, h('h2', {}, title), sub ? h('p', {}, sub) : null), h('button', { class: 'btn', type: 'button', onclick: () => this.closeOverlay() }, '닫기')), content);
    ov.hidden = false; this.ovReturn = document.activeElement; this.ovClose = onClose; box.focus();
  }
  closeOverlay() { $('#overlay').hidden = true; this.ovClose?.(); this.ovClose = null; this.app.focusGame(); }
  get overlayOpen() { return !$('#overlay').hidden; }

  showPlan(hana) {
    const L = this.app.layout;
    const pts = L.chambers.flatMap(c => this.app.world.nav.cornersOf(c));
    const b = { minX: Math.min(...pts.map(p => p.x)) - 3, maxX: Math.max(...pts.map(p => p.x)) + 3, minZ: Math.min(...pts.map(p => p.z)) - 3, maxZ: Math.max(...pts.map(p => p.z)) + 3 };
    const W = 1000, s = W / (b.maxX - b.minX), H = (b.maxZ - b.minZ) * s;
    const ns = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(ns, 'svg'); svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('class', 'plan-svg'); svg.setAttribute('role', 'group'); svg.setAttribute('aria-label', '건물 평면도');
    const tx = (x, z) => [(x - b.minX) * s, (z - b.minZ) * s];
    const el = (n, a) => { const e = document.createElementNS(ns, n); for (const [k, v] of Object.entries(a)) e.setAttribute(k, v); return e; };
    const [cx, cz] = tx(0, 0);
    svg.append(el('circle', { cx, cy: cz, r: L.hall.r * s, fill: '#FFFFFF', stroke: '#B8B0A3', 'stroke-width': 1.5 }));
    const hallT = el('text', { x: cx, y: cz + 9, 'text-anchor': 'middle', 'font-size': 26, 'font-weight': 700, fill: '#22201D' }); hallT.textContent = this.copy.hall; svg.append(hallT);
    for (const c of L.chambers) {
      const pts = this.app.world.nav.cornersOf(c).map(p => tx(p.x, p.z).join(',')).join(' ');
      const cfg = c.room ? this.app.world.roomCfg.get(c.room) : null;
      const isRoom = c.kind === 'room';
      const g = el('g', isRoom ? { class: 'room', tabindex: 0, role: 'button', 'aria-label': `${c.label}로 걸어가기` } : {});
      g.append(el('polygon', { points: pts, fill: isRoom ? `${cfg.spine}22` : c.kind === 'corridor' || c.kind === 'passage' ? '#FFFFFF' : `${cfg?.spine ?? '#999999'}12`, stroke: isRoom ? cfg.spine : '#C9C1B4', 'stroke-width': isRoom ? 2 : 1 }));
      if (isRoom || c.kind === 'stack') {
        const m = this.app.world.nav.cornersOf(c).reduce((a, p) => ({ x: a.x + p.x / 4, z: a.z + p.z / 4 }), { x: 0, z: 0 });
        const [mx, mz] = tx(m.x, m.z);
        const t = el('text', { x: mx, y: mz + 5, 'text-anchor': 'middle', 'font-size': isRoom ? 30 : 18, 'font-weight': isRoom ? 700 : 500, fill: isRoom ? '#22201D' : '#6B655D' }); t.textContent = isRoom ? c.label : '이동식 서가'; g.append(t);
        if (isRoom) { const r2 = this.app.world.roomById.get(c.room); const t2 = el('text', { x: mx, y: mz + 38, 'text-anchor': 'middle', 'font-size': 20, fill: '#6B655D' }); t2.textContent = `${r2.count.books.toLocaleString('ko-KR')}권`; g.append(t2); }
      }
      if (isRoom) {
        const go = () => { this.closeOverlay(); this.app.walkToRoom(c.room); };
        g.addEventListener('click', go); g.addEventListener('keydown', e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } });
      }
      svg.append(g);
    }
    // Hana
    const [hx, hz] = tx(hana.x, hana.z);
    svg.append(el('circle', { cx: hx, cy: hz, r: 11, fill: '#FF7E5F', stroke: '#FFFFFF', 'stroke-width': 3 }));
    this.overlay('평면도', '방을 누르면 Hana가 그 방 입구까지 걸어갑니다. 방향키를 누르면 멈춥니다.', svg);
    svg.querySelector('.room')?.focus();
  }
  showGuestbook(log) {
    const e = log.entries;
    const entry = x => h('div', { class: 'guest-entry' }, h('time', {}, `${x.date} · ${x.type}`), h('b', {}, x.title), x.change ? h('p', {}, x.change) : x.input ? h('p', {}, x.input) : null);
    const book = h('div', { class: 'guest' }, h('div', { class: 'guest-page' }, e.slice(0, 3).map(entry)), h('div', { class: 'guest-page' }, e.slice(3).map(entry), h('p', {}, h('button', { class: 'btn primary', type: 'button', onclick: () => { this.closeOverlay(); this.app.openItem({ id: 'log', title: 'log.md', path: 'log.md', kind: 'file', ext: 'md' }); } }, 'log.md 전체 열기'))));
    this.overlay(this.copy.guestbook, `세컨브레인 변경 기록 최근 ${e.length}건 · 전체 ${log.total.toLocaleString('ko-KR')}건`, book);
  }
  showSkills(room) {
    const r = this.app.world.roomById.get(room);
    const box = h('div', { class: 'tools' }, r.skills.map(s => h('div', { class: 'tool' }, h('code', {}, s.name), h('p', {}, s.role || ''), h('small', {}, s.from))));
    this.overlay(`${r.name} · ${this.copy.skills}`, '세컨브레인에 파일이 없는 스킬이라 열기 대신 이름과 역할만 보여 줍니다.', box);
  }
  showHelp() {
    const k = (keys, text) => h('div', {}, h('span', {}, text), h('span', {}, keys.map(x => h('kbd', {}, x))));
    const photo = !!this.app.photo?.active;
    const box = h('div', { class: 'keys' },
      h('h3', {}, '걷기'), k(['←', '↑', '→', '↓'], photo ? '걷기(↑ 안쪽으로 · ↓ 앞쪽으로)' : '걷기(카메라 방향 기준)'), k(['W', 'A', 'S', 'D'], '걷기'), k(['Shift'], '빠른 걸음'),
      k(['클릭'], photo ? '바닥: 그 자리로 걸어가기 · 문·서가·모형·방명록: 가서 바로 보기' : '바닥: 그 자리로 걸어가기 · 서가·안내도: 가서 바로 보기'),
      photo ? null : [k(['오른쪽 끌기'], '카메라 돌리기'), k(['[', ']'], '카메라 돌리기'), k(['휠'], '확대·축소')],
      k(['E', 'Enter', 'Space'], '가까운 대상과 상호작용'), k(['/'], '검색'), k(['M'], '평면도'), k(['Tab'], '목록 보기'), k(['Esc'], '한 단계 뒤로'),
      h('h3', {}, '서가 보기'), k(['←', '→'], '옆 책'), k(['↑', '↓'], '위·아래 선반'), k(['Shift', '←', '→'], '옆 서가 칸'), photo ? k(['PgUp', 'PgDn'], '이전·다음 서가') : null, k(['Enter'], '꺼내기'), k(['Esc'], '나가기'));
    this.overlay('조작법', '', box);
  }

  // ---------- 미니맵 ----------
  drawMinimap(hana, heading, roomId) {
    const cv = $('#minimap'); if (cv.hidden) return;
    const g = this.mm, W = cv.width, S = 3.4;
    g.clearRect(0, 0, W, W); g.save(); g.translate(W / 2, W / 2);
    const tx = (x, z) => [(x - hana.x) * S, (z - hana.z) * S];
    const L = this.app.layout;
    g.lineWidth = 1;
    for (const c of L.chambers) {
      const pts = this.app.world.nav.cornersOf(c).map(p => tx(p.x, p.z));
      if (pts.every(([x, y]) => Math.abs(x) > W && Math.abs(y) > W)) continue;
      g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.closePath();
      const cfg = c.room ? this.app.world.roomCfg.get(c.room) : null;
      g.fillStyle = cfg && c.room === roomId && c.kind !== 'corridor' ? `${cfg.spine}55` : cfg && c.kind === 'room' ? `${cfg.spine}22` : '#F3EFE8';
      g.fill(); g.strokeStyle = cfg && c.kind === 'room' ? `${cfg.spine}` : '#CFC7BA'; g.stroke();
    }
    const [hx, hz] = tx(0, 0);
    g.beginPath(); g.arc(hx, hz, L.hall.r * S, 0, Math.PI * 2); g.fillStyle = roomId ? '#FAF8F4' : '#EFE9E0'; g.fill(); g.strokeStyle = '#B8B0A3'; g.stroke();
    g.rotate(-heading + Math.PI);
    g.beginPath(); g.moveTo(0, -8); g.lineTo(5.5, 6); g.lineTo(0, 3); g.lineTo(-5.5, 6); g.closePath();
    g.fillStyle = '#FF7E5F'; g.fill(); g.strokeStyle = '#FFFFFF'; g.lineWidth = 1.5; g.stroke();
    g.restore();
  }

  // ---------- 2D 목록 ----------
  buildList() {
    const root = $('#list2d'); root.innerHTML = '';
    const head = h('div', { class: 'l2-head' }, h('h2', {}, `${this.cfg.title} · 목록`), h('div', {}, h('button', { class: 'btn', type: 'button', onclick: () => this.app.toggleList(false) }, this.copy.view3d)));
    const body = h('div', { class: 'l2-body' });
    const shelves = this.app.palace.shelves;
    const shelfNode = (s, depth = 0) => {
      const d = h('details', { class: 'l2-shelf' });
      const sum = h('summary', {}, s.label || s.title, h('small', {}, `${s.books.length.toLocaleString('ko-KR')}권`), s.active ? h('span', { class: 'act' }, this.copy.activeShelf) : null);
      d.append(sum);
      d.addEventListener('toggle', () => {
        if (!d.open || d.dataset.built) return; d.dataset.built = '1';
        const ul = h('ul', { class: 'l2-books' });
        for (const b of s.books) ul.append(h('li', {}, h('button', { type: 'button', class: b.exists === false ? 'missing' : '', onclick: () => this.app.openFromList(b) }, b.title, h('small', {}, b.kind === 'web' ? '웹' : b.kind === 'dir' ? '폴더' : (b.ext || '').toUpperCase()))));
        if (this.app.world) ul.append(h('li', {}, h('button', { type: 'button', onclick: () => this.app.listGoTo(s.id) }, h('b', {}, this.copy.toGame))));
        d.append(ul);
        for (const c of [...(s.inner ?? []), ...(s.units ?? [])]) d.append(shelfNode(shelves[c], depth + 1));
      });
      return d;
    };
    for (const r of this.app.palace.rooms) {
      const cfg = this.app.world?.roomCfg.get(r.id) ?? this.cfg.rooms.find(x => x.id === r.id);
      const d = h('details', { class: 'l2-room' });
      d.append(h('summary', {}, h('img', { src: `${cfg.still}`, alt: '', loading: 'lazy' }), h('div', {}, h('b', {}, h('i', { class: 'l2-swatch', style: { background: cfg.spine } }), r.name), h('span', {}, `${cfg.ownerLabel} · ${r.aliases || cfg.kind}`)), h('span', {}, `서가 ${r.count.shelves} · ${r.count.books.toLocaleString('ko-KR')}권`)));
      for (const sid of r.shelves) d.append(shelfNode(shelves[sid]));
      body.append(d);
    }
    root.append(head, body);
  }
}

// 효과음(기본 꺼짐)
export class Sound {
  constructor(cfg) {
    this.cfg = cfg; this.enabled = store.get('sound', cfg.sound.enabled);
    this.buf = {};
  }
  toggle() { this.enabled = !this.enabled; store.set('sound', this.enabled); toast(this.enabled ? '효과음 켬' : '효과음 끔'); }
  play(name, vol = 0.5) {
    if (this.cfg.static || !this.enabled || !this.cfg.sound.files[name]) return;
    let a = this.buf[name];
    if (!a) { a = this.buf[name] = new Audio(`/api/sfx/${name}`); }
    try { const c = a.cloneNode(); c.volume = vol; c.play().catch(() => {}); } catch { /* 무시 */ }
  }
}
