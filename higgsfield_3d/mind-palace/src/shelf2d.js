// 사진 서가 보기: 원목 서가 근접 사진(3칸 × 5단) 위에 지금 서가의 책등을 단·칸 자리에 꽂는다. 칸이 3개보다 많으면 넘겨 본다.
import { $, h, clamp, rand01 } from './util.js';
const rand = id => rand01(id, 7);


export class Shelf2D {
  constructor(app, photo, def) {
    this.app = app; this.photo = photo; this.def = def;
    this.el = h('div', { id: 'shelf2d', 'aria-label': '서가 보기' },
      this.img = h('img', { class: 'sh-bg', alt: '', draggable: 'false' }),
      this.stage = h('div', { class: 'sh-stage', role: 'listbox', 'aria-label': '책등' }),
      this.prevBtn = h('button', { class: 'sh-page prev', type: 'button', 'aria-label': '앞 칸들', onclick: () => this.turn(-1) }, '‹'),
      this.nextBtn = h('button', { class: 'sh-page next', type: 'button', 'aria-label': '뒤 칸들', onclick: () => this.turn(1) }, '›'),
      this.pager = h('div', { class: 'sh-pager' }),
      this.listBox = h('div', { class: 'sh-list', role: 'menu' }));
    this.el.hidden = true; this.listBox.hidden = true;
    $('#game').insertBefore(this.el, $('#labels'));
    this.img.src = `${def.image}`;
    this.img.addEventListener('load', () => this.resize());
    this.isOpen = false; this.focus = null; this.pulled = null; this.pageIdx = 0; this.entries = [];
    this.stage.addEventListener('pointerleave', () => { if (!this.pulled) this.app.ui.hoverLabel(null); });
  }

  // ---------- 열기·닫기 ----------
  open(spot, { rec = null, glow = false } = {}) {
    this.spot = spot;
    this.items = spot.groups.flatMap(g => g.items);
    let idx = rec ? this.items.findIndex(it => it.id === rec.info.id) : -1;
    if (idx < 0) idx = this.items.findIndex(it => it.s.active && it.info?.slots?.length);
    if (idx < 0) idx = this.items.findIndex(it => it.info?.slots?.length);
    this.isOpen = true; this.el.hidden = false;
    this.app.mode = 'shelf';
    this.app.ui.setPrompt(null);
    this.resize();
    this.show(Math.max(0, idx), rec, glow);
    this.app.sound.play('pull', 0.12);
    this.stage.focus?.();
  }
  close() {
    this.isOpen = false; this.el.hidden = true; this.listBox.hidden = true;
    this.focus = null;
    this.app.ui.shelfBar(null); this.app.ui.hoverLabel(null);
  }
  get listOpen() { return !this.listBox.hidden; }

  show(idx, focusRec = null, glow = false) {
    this.idx = (idx + this.items.length) % this.items.length;
    const it = this.items[this.idx]; this.item = it;
    const info = it.info;
    const S = this.app.shelves;
    this.recs = info ? info.slots.map(sl => S.recByBook.get(sl.book.id)).filter(Boolean) : [];
    this.layoutBooks();
    const bar = info ?? { s: it.s, room: it.s.room };
    const acts = [];
    if (this.items.length > 1) {
      acts.push({ label: '‹ 이전 서가', run: () => this.show(this.idx - 1) });
      acts.push({ label: `서가 목록 ${this.idx + 1}/${this.items.length}`, run: () => this.toggleList() });
      acts.push({ label: '다음 서가 ›', run: () => this.show(this.idx + 1) });
    }
    this.app.ui.shelfBar(bar, acts);
    this.listBox.hidden = true;
    const first = (focusRec && this.entries.find(e => e.rec === focusRec)) ?? this.entries[0] ?? null;
    this.pageIdx = first ? first.page : 0;
    this.render();
    this.setFocus(first);
    if (glow && first) { const el = this.elOf(first); el?.classList.add('glow'); setTimeout(() => el?.classList.remove('glow'), 2600); }
  }
  // 사진 서가 배치: 눈높이 단(3·4번째 줄)부터 칸마다 85%까지 채우고 다음 칸으로. 넘치면 다음 쪽.
  // 책 두께는 실제보다 두껍게(제목이 읽히게) 잡는다. 카드의 "n단 m번째"도 이 자리 기준.
  layoutBooks() {
    const { bays, rows } = this.def;
    const ORDER = [2, 3, 1, 4, 0];
    this.entries = [];
    let page = 0, ri = 0, c = 0, x = null;
    for (const rec of this.recs) {
      const t = clamp((rec.t - 0.008) / 0.023, 0, 1), k = rand(rec.book.id);
      for (let guard = 0; guard < 400; guard++) {
        const [x0, x1] = bays[c], cw = x1 - x0;
        const w = cw * (0.043 + 0.03 * t);
        if (x == null) x = x0 + cw * (0.012 + 0.02 * k);
        if (x + w <= x0 + cw * 0.86) {
          const r = ORDER[ri], [y0, y1] = rows[r];
          const hh = (y1 - y0) * clamp(rec.h / 0.37, 0.5, 0.95);
          this.entries.push({ rec, page, row: r, c, x0: x, x1: x + w, y0: y1 - hh, y1 });
          x += w + (k > 0.86 ? cw * 0.006 : cw * 0.0012);
          break;
        }
        c++; x = null;
        if (c > 2) { c = 0; ri++; if (ri >= ORDER.length) { ri = 0; page++; } }
      }
    }
    this.pages = Math.max(1, (this.entries.at(-1)?.page ?? 0) + 1);
    // 줄 안 순번(카드·이름표에 쓰는 자리 표시)
    const byRow = new Map();
    for (const e of this.entries) { const key = `${e.page}|${e.row}`; const n = byRow.get(key) ?? 0; byRow.set(key, n + 1); e.view = { ...e.rec, level: 5 - e.row, bay: 0, within: n }; }
  }
  elOf(e) { return e ? this.stage.querySelector(`[data-id="${e.rec.book.id}"]`) : null; }

  // ---------- 그리기 ----------
  resize() {
    if (!this.img.naturalWidth) return;
    const r = $('#game').getBoundingClientRect();
    const iw = this.img.naturalWidth, ih = this.img.naturalHeight;
    const s = Math.max(r.width / iw, r.height / ih), dw = iw * s, dh = ih * s;
    const ox = (r.width - dw) / 2, oy = Math.min(0, (r.height - dh) / 2);
    for (const el of [this.img, this.stage]) Object.assign(el.style, { left: `${ox}px`, top: `${oy}px`, width: `${dw}px`, height: `${dh}px` });
    const bay = this.def.bays[0];
    this.stage.style.setProperty('--cw', `${(bay[1] - bay[0]) * dw}px`);
    this.T = { ox, oy, dw, dh };
    if (this.focus) this.placeHover(this.focus);
  }
  render() {
    const st = this.stage; st.innerHTML = '';
    const { bays, rows } = this.def;
    for (let c = 0; c < 3; c++) for (let r = 0; r < 5; r++) st.append(h('div', { class: 'sh-shade', style: box(bays[c][0], rows[r][0], bays[c][1], rows[r][1]) }));
    for (const e of this.entries) {
      if (e.page !== this.pageIdx) continue;
      const rec = e.rec;
      const col = rec.missing ? '#CFC9BF' : `#${rec.color.getHexString()}`;
      const el = h('button', { class: `sp${rec.light ? ' light' : ''}${rec.missing ? ' missing' : ''}${rec === this.pulled ? ' pulled' : ''}`, type: 'button', role: 'option', 'data-id': rec.book.id, title: rec.book.title, tabindex: -1, style: box(e.x0, e.y0, e.x1, e.y1) }, h('span', {}, rec.book.title));
      el.style.setProperty('--c', col);
      el.addEventListener('pointerenter', () => { if (this.app.mode === 'shelf') this.setFocus(e); });
      el.addEventListener('click', () => { if (this.app.mode !== 'shelf') return; this.setFocus(e); this.pull(); });
      st.append(el);
    }
    if (!this.entries.length) st.append(h('div', { class: 'sh-note', style: box(0.3, 0.40, 0.7, 0.50) }, this.emptyText()));
    this.prevBtn.hidden = this.pageIdx <= 0; this.nextBtn.hidden = this.pageIdx >= this.pages - 1;
    this.pager.textContent = this.pages > 1 ? `${this.pageIdx + 1} / ${this.pages}쪽` : '';
    this.pager.hidden = this.pages <= 1;
  }
  emptyText() {
    const it = this.item, inner = this.items.filter((x, i) => i > this.idx && x.depth > it.depth).length;
    return inner ? `이 서가에는 바로 꽂힌 책이 없습니다. 안쪽 서가 ${inner}개는 ‘다음 서가’로 봅니다.` : '이 서가에는 책이 없습니다.';
  }
  turn(d) {
    const p = clamp(this.pageIdx + d, 0, this.pages - 1); if (p === this.pageIdx) return;
    this.pageIdx = p; this.render();
    this.setFocus(this.entries.find(e => e.page === p) ?? null);
  }
  setFocus(e) {
    if (this.focus === e && this.elOf(e)?.classList.contains('focus')) return;
    this.elOf(this.focus)?.classList.remove('focus');
    this.focus = e;
    if (!e) { this.app.ui.hoverLabel(null); return; }
    if (e.page !== this.pageIdx) { this.pageIdx = e.page; this.render(); }
    this.elOf(e)?.classList.add('focus');
    this.placeHover(e);
  }
  placeHover(e) {
    const el = this.elOf(e); if (!el) return;
    const g = $('#game').getBoundingClientRect(), r = el.getBoundingClientRect();
    const x = clamp(r.left + r.width / 2 - g.left, 170, g.width - 170);
    this.app.ui.hoverLabel(e.view, x, r.top - g.top - 8);
  }

  // ---------- 서가 목록 ----------
  toggleList(show = this.listBox.hidden) {
    const box = this.listBox; box.innerHTML = '';
    if (!show) { box.hidden = true; return; }
    this.items.forEach((it, i) => {
      const n = it.s.books?.length ?? 0;
      box.append(h('button', { type: 'button', role: 'menuitem', class: `${i === this.idx ? 'cur' : ''}`, style: { paddingLeft: `${12 + it.depth * 16}px` }, onclick: () => this.show(i) }, h('span', {}, it.s.label || it.s.title), h('small', {}, `${n.toLocaleString('ko-KR')}권`)));
    });
    box.hidden = false;
    box.querySelector('.cur')?.scrollIntoView({ block: 'nearest' });
    box.querySelector('.cur')?.focus();
  }

  // ---------- 키 ----------
  key(e) {
    if (this.app.mode !== 'shelf') return;
    if (this.listOpen) return;
    const cur = this.focus;
    if (['Enter', 'Space', 'KeyE'].includes(e.code)) { e.preventDefault(); if (!e.repeat && cur) this.pull(); return; }
    if (e.code === 'PageUp' || e.code === 'BracketLeft') { e.preventDefault(); return this.show(this.idx - 1); }
    if (e.code === 'PageDown' || e.code === 'BracketRight') { e.preventDefault(); return this.show(this.idx + 1); }
    if (!cur) { if (e.code === 'ArrowLeft') this.turn(-1); if (e.code === 'ArrowRight') this.turn(1); return; }
    const ord = x => x.page * 10 + x.c + x.x0;
    const row = this.entries.filter(x => x.page === cur.page && x.row === cur.row).sort((a, b) => ord(a) - ord(b));
    let next = null;
    if (e.code === 'ArrowLeft' || e.code === 'ArrowRight') {
      const d = e.code === 'ArrowLeft' ? -1 : 1;
      if (e.shiftKey) next = row.find(x => x.c === cur.c + d) ?? (d > 0 ? null : row.filter(x => x.c === cur.c - 1).at(-1));
      else {
        const i = row.indexOf(cur) + d;
        if (i >= 0 && i < row.length) next = row[i];
        else { const all = this.entries, j = all.indexOf(cur) + d; next = all[j] ?? null; }
      }
    }
    if (e.code === 'ArrowUp' || e.code === 'ArrowDown') {
      const d = e.code === 'ArrowUp' ? -1 : 1;
      const cx = cur.c + cur.x0;
      for (let r = cur.row + d; r >= 0 && r <= 4; r += d) {
        const list = this.entries.filter(x => x.page === cur.page && x.row === r);
        if (list.length) { next = list.reduce((a, b) => (Math.abs(b.c + b.x0 - cx) < Math.abs(a.c + a.x0 - cx) ? b : a)); break; }
      }
    }
    if (next) { e.preventDefault(); this.setFocus(next); }
  }

  // ---------- 꺼내기 ----------
  async pull() {
    const e = this.focus; if (!e || this.app.mode !== 'shelf') return;
    const rec = e.view;
    const app = this.app;
    app.mode = 'pull'; this.pulled = e.rec;
    const el = this.elOf(e); el?.classList.add('pulled');
    app.sound.play('pull', 0.4);
    app.ui.hoverLabel(null);
    await new Promise(r => setTimeout(r, app.config.reduced ? 0 : 420));
    app.mode = 'card';
    app.ui.showCard(rec, {
      onOpen: () => this.photo.openBook(rec.book),
      onAttach: a => this.photo.openBook(a, rec.book),
      onIndex: () => this.photo.openBook({ id: app.indexIds.get(rec.book.src.index), title: rec.book.src.index.split('/').pop(), path: rec.book.src.index, kind: 'file', ext: 'md' }),
      onClose: () => this.photo.putBack(),
    });
  }
  putBack() {
    const rec = this.pulled; this.pulled = null;
    if (this.isOpen) { this.app.mode = 'shelf'; this.show(this.idx, rec); }
  }
}

function box(x0, y0, x1, y1) { return { left: `${x0 * 100}%`, top: `${y0 * 100}%`, width: `${(x1 - x0) * 100}%`, height: `${(y1 - y0) * 100}%` }; }
