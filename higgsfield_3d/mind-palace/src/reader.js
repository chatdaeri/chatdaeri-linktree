// 열람 패널: 책이 가리키는 실제 파일을 종류별로 보여 준다.
import { marked } from 'marked';
import DOMPurify from 'dompurify';
import { $, h, post, toast, fmtSize, fmtDate, store } from './util.js';

const IMG = new Set(['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'avif', 'bmp', 'ico']);
const VIDEO = new Set(['mp4', 'mov', 'm4v', 'webm', 'mkv']);
const AUDIO = new Set(['mp3', 'wav', 'm4a', 'aac', 'ogg', 'flac']);
const OFFICE = new Set(['xlsx', 'xls', 'docx', 'doc', 'pptx', 'ppt', 'hwp', 'hwpx', 'key', 'pages', 'numbers', 'rtf']);
const CODE = new Set(['txt', 'json', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'sh', 'zsh', 'yml', 'yaml', 'toml', 'ini', 'xml', 'css', 'log', 'sql', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'srt', 'vtt', 'excalidraw', 'canvas', 'env', 'gitignore', 'lock']);
const encPath = p => p.split('/').map(encodeURIComponent).join('/');
const dirOf = p => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const baseOf = p => p.split('/').pop();
function joinPath(dir, rel) {
  const out = dir ? dir.split('/') : [];
  for (const s of rel.split('/')) { if (!s || s === '.') continue; if (s === '..') out.pop(); else out.push(s); }
  return out.join('/');
}
const extOf = p => { const m = /\.([^./]+)$/.exec(p ?? ''); return m ? m[1].toLowerCase() : ''; };

export class Reader {
  constructor(app) {
    this.app = app; this.cfg = app.config;
    this.el = $('#reader'); this.body = $('#reader-body');
    this.recent = store.get('recent', []);
    this.current = null; this.seq = 0;
    this.el.querySelector('.reader-actions').addEventListener('click', e => {
      const act = e.target.closest('button')?.dataset.act; if (!act) return;
      if (act === 'close') this.app.closeReader();
      if (act === 'copy') this.copyPath();
      if (act === 'app' || act === 'finder') this.openExternal(act);
    });
    this.setupSplitter();
    // 열람 패널 스크롤: Lenis(관성 있는 부드러운 굴림). GSAP 시계 하나로 돌린다
    if (window.Lenis && window.gsap) {
      this.lenis = new window.Lenis({ wrapper: this.body, content: this.body, lerp: 0.12, wheelMultiplier: 0.9 });
      window.gsap.ticker.add(t => this.lenis.raf(t * 1000));
    }
    // 정적 공개판(config.static): 실제 파일이 없으므로 앱·Finder·경로 버튼을 숨긴다
    if (this.cfg.static) for (const a of ['app', 'finder', 'copy']) { const b = this.el.querySelector(`[data-act="${a}"]`); b.hidden = true; b.style.display = 'none'; }
  }
  get isOpen() { return !this.el.hidden; }

  // item: 책·부록 {id, title, path, outside, kind, ext, url, exists} 또는 재료 {assetOf, rel, title, basePath}
  async open(item, opts = {}) {
    const first = !this.isOpen;
    this.el.hidden = false; $('#splitter').hidden = false; document.getElementById('app').classList.add('split'); document.body.classList.add('reading');
    if (first) { this.applyWidth(); this.app.onResize(); window.gsap?.fromTo(this.el, { autoAlpha: 0, x: 36 }, { autoAlpha: 1, x: 0, duration: 0.45, ease: 'power3.out', clearProps: 'transform,opacity,visibility' }); }
    this.current = item;
    const seq = ++this.seq;
    $('#reader-name').textContent = item.title;
    $('#reader-path').textContent = this.displayPath(item);
    this.el.querySelector('[data-act="app"]').disabled = !!item.url;
    this.el.querySelector('[data-act="finder"]').disabled = !!item.url;
    this.pushRecent(item);
    this.renderRecent();
    this.body.innerHTML = '';
    this.body.scrollTop = 0;
    const loading = h('div', { class: 'rd-loading' }, this.cfg.copy.loading);
    this.body.append(loading);
    const slow = setTimeout(() => { if (seq === this.seq && loading.isConnected) loading.replaceWith(this.msg(this.cfg.copy.driveSlow, 'Google Drive가 파일을 내려받는 중일 수 있습니다. 기본 앱으로 열면 바로 볼 수 있습니다.', true)); }, (this.cfg.server?.slowFileSeconds ?? 20) * 1000);
    try {
      const view = await this.render(item, opts);
      if (seq !== this.seq) return;
      this.body.innerHTML = '';
      if (opts.goTo) this.body.append(h('div', { class: 'rd-pad rd-goto' }, h('button', { class: 'btn', type: 'button', onclick: () => this.app.goToBook(opts.goTo) }, this.cfg.copy.goThere)));
      this.body.append(view);
      this.lenis?.resize(); this.lenis?.scrollTo(0, { immediate: true });
      window.gsap?.from(view, { autoAlpha: 0, y: 10, duration: 0.35, ease: 'power2.out', clearProps: 'all' });
    } catch (e) {
      if (seq !== this.seq) return;
      this.body.innerHTML = '';
      this.body.append(this.msg('열지 못했습니다', e.message === 'missing' ? this.cfg.copy.notHere : `오류: ${e.message}`, true));
    } finally { clearTimeout(slow); }
    if (opts.focus !== false) this.body.focus({ preventScroll: true });
  }
  close() {
    this.el.hidden = true; $('#splitter').hidden = true; document.getElementById('app').classList.remove('split'); document.body.classList.remove('reading');
    this.body.innerHTML = ''; this.current = null; this.seq++;
  }
  displayPath(item) {
    if (item.url) return item.url;
    if (item.assetOf) return joinPath(dirOf(item.basePath ?? ''), item.rel);
    return item.path ?? '';
  }
  absPath(item) {
    if (item.url) return item.url;
    const p = this.displayPath(item);
    return item.outside ? p : `${this.cfg.root}/${p}`;
  }
  async copyPath() {
    const p = this.absPath(this.current);
    try { await navigator.clipboard.writeText(p); toast('경로를 복사했습니다'); } catch { toast(p, 5000); }
  }
  async openExternal(mode) {
    const it = this.current; if (!it) return;
    const id = it.assetOf ?? it.id;
    try { await post(`/api/book/${id}/open?mode=${mode}`); } catch { toast('열지 못했습니다'); }
  }
  pushRecent(item) {
    const key = item.assetOf ? `${item.assetOf}:${item.rel}` : item.id;
    this.recent = [{ key, item }, ...this.recent.filter(r => r.key !== key)].slice(0, this.cfg.panel.recent ?? 5);
    store.set('recent', this.recent);
  }
  renderRecent() {
    const box = $('#reader-recent'); box.innerHTML = '';
    const curKey = this.current ? (this.current.assetOf ? `${this.current.assetOf}:${this.current.rel}` : this.current.id) : null;
    for (const r of this.recent) box.append(h('button', { type: 'button', 'aria-current': r.key === curKey ? 'true' : 'false', title: r.item.title, onclick: () => this.open(r.item) }, r.item.title));
  }
  msg(title, text, withApp = false) {
    return h('div', { class: 'rd-msg' }, h('h3', {}, title), h('p', {}, text),
      withApp && this.current && !this.current.url ? h('button', { class: 'btn', type: 'button', onclick: () => this.openExternal('app') }, this.cfg.copy.openApp) : null);
  }

  // 정적 공개판: 책마다 같은 내용이 나오도록 id로 정한 가상 본문
  renderDummy(item) {
    let seed = 0; for (const ch of String(item.id ?? item.title)) seed = (seed * 31 + ch.charCodeAt(0)) >>> 0;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 4294967296);
    const pick = a => a[Math.floor(rnd() * a.length)];
    const S = ['목표를 한 문장으로 정리하고 필요한 자료를 먼저 모은다.', '반복되는 단계는 체크리스트로 바꿔 다음 작업 시간을 줄인다.', '초안은 빠르게 만들고 검토는 기준표로 한다.', '결과물은 같은 이름 규칙으로 한곳에 보관한다.', '담당자와 마감일을 표 맨 위에 적는다.', '지난 회차와 달라진 점만 따로 표시한다.', '숫자는 출처와 기준일을 함께 적는다.', '다음 단계에서 쓸 질문을 끝에 남긴다.'];
    const steps = ['자료 모으기', '초안 만들기', '검토하기', '정리·보관', '공유하기', '다음 회차 준비'];
    const md = [`# ${item.title}`, '', '> 공개 시연용 가상 자료입니다. 실제 문서가 아닙니다.', '', item.desc ? `${item.desc}` : '', '', '## 핵심', ...Array.from({ length: 3 }, () => `- ${pick(S)}`), '', '## 순서',
      '| 단계 | 할 일 | 상태 |', '|---|---|---|', ...steps.slice(0, 3 + Math.floor(rnd() * 3)).map((st, i) => `| ${i + 1} | ${st} | ${pick(['완료', '진행 중', '대기'])} |`), '', '## 메모', pick(S) + ' ' + pick(S)].join('\n');
    const html = DOMPurify.sanitize(marked.parse(md, { gfm: true }));
    const box = h('div', { class: 'md' }); box.innerHTML = html;
    return box;
  }

  url(item, kind = 'file') {
    if (item.assetOf) return `/api/book/${item.assetOf}/asset/${encPath(item.rel)}`;
    if (kind === 'html' && !item.outside) return `${location.protocol}//${location.hostname}:${this.cfg.server?.docPort ?? Number(location.port) + 1}/api/book/${item.id}/asset/${encodeURIComponent(baseOf(item.path))}`;
    return `/api/book/${item.id}/${kind === 'preview' ? 'preview' : 'file'}`;
  }
  async fetchText(item, limit = 2_000_000) {
    const r = await fetch(this.url(item));
    if (r.status === 404) { const j = await r.json().catch(() => ({})); throw new Error(j.error === 'missing' ? 'missing' : '없음'); }
    if (!r.ok) throw new Error(`${r.status}`);
    const len = Number(r.headers.get('content-length') ?? 0);
    const t = decodeText(new Uint8Array(await r.arrayBuffer()));
    if (len > limit) return { text: t.slice(0, limit), cut: true };
    return { text: t, cut: false };
  }

  async render(item) {
    if (this.cfg.static) return this.renderDummy(item);
    if (item.url) return this.renderWeb(item);
    if (item.exists === false) return this.msg(this.cfg.copy.missing, item.outside ? `${this.cfg.copy.notHere} — ${item.path}` : `${item.path}`, false);
    const ext = item.ext ?? extOf(item.rel ?? item.path);
    if (item.kind === 'dir') return this.renderDir(item);
    if (ext === 'md' || ext === 'markdown') return this.renderMd(item);
    if (ext === 'pdf') return h('iframe', { class: 'rd-frame', src: this.url(item), title: item.title });
    if (IMG.has(ext)) return this.renderImg(item);
    // HTML은 문서 전용 포트(다른 출처)에서 연다: 스크립트·같은 출처 저장소는 허용, 앱 화면에는 손댈 수 없다
    if (ext === 'html' || ext === 'htm') return h('iframe', { class: 'rd-frame', src: this.url(item, 'html'), sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox', title: item.title, referrerpolicy: 'origin' });
    if (VIDEO.has(ext)) return this.renderVideo(item);
    if (AUDIO.has(ext)) return h('div', { class: 'rd-pad' }, h('audio', { controls: true, preload: 'metadata', src: this.url(item) }));
    if (ext === 'csv' || ext === 'tsv') return this.renderCsv(item, ext === 'tsv' ? '\t' : ',');
    if (CODE.has(ext) || !ext) return this.renderCode(item);
    if (OFFICE.has(ext)) return this.renderPreview(item);
    return this.renderInfo(item);
  }
  // 웹 주소: 띄울 수 있는 사이트면 패널 안에 바로 띄운다(유튜브는 재생 화면으로). 사이트가 막아 두었으면 이유와 새 탭 버튼.
  async renderWeb(item) {
    const yt = /(?:youtube\.com\/watch\?(?:.*&)?v=|youtu\.be\/|youtube\.com\/shorts\/)([\w-]{6,})/.exec(item.url);
    const bar = h('div', { class: 'rd-webbar' }, h('span', { title: item.url }, item.url), h('button', { class: 'btn', type: 'button', onclick: () => window.open(item.url, '_blank', 'noopener') }, '새 탭으로 열기'));
    const frame = src => h('div', { class: 'rd-web' }, bar, h('div', { class: 'rd-webframe' }, h('iframe', { class: 'rd-frame', src, title: item.title, referrerpolicy: 'strict-origin-when-cross-origin', sandbox: 'allow-scripts allow-same-origin allow-popups allow-popups-to-escape-sandbox allow-presentation', allow: 'fullscreen; autoplay; encrypted-media; picture-in-picture' })));
    if (yt) return frame(`https://www.youtube-nocookie.com/embed/${yt[1]}`);
    if (!/^https:\/\//i.test(item.url)) return this.webMsg(item, '보안 연결(https)이 아닌 주소는 패널 안에 띄우지 않습니다.');
    let chk = { frame: true };
    try { const r = await fetch(`/api/book/${item.id}/frame`); if (r.ok) chk = await r.json(); } catch { /* 확인 못 하면 띄워 본다 */ }
    if (!chk.frame) return this.webMsg(item, '이 사이트는 다른 화면 안에 띄우는 것을 막아 두었습니다(GitHub·Notion 등). 새 탭으로 열어 보세요.');
    return frame(item.url);
  }
  webMsg(item, text) {
    return h('div', { class: 'rd-msg' }, h('h3', {}, item.title), h('p', {}, item.url), h('p', {}, text), item.desc ? h('p', {}, item.desc) : null,
      h('button', { class: 'btn primary', type: 'button', onclick: () => window.open(item.url, '_blank', 'noopener') }, '새 탭으로 열기'));
  }
  renderInfo(item) {
    return h('div', { class: 'rd-msg' }, h('h3', {}, item.title), h('p', {}, `${item.ext ? item.ext.toUpperCase() : '파일'} · ${fmtSize(item.size)} ${fmtDate(item.mtime)}`),
      h('p', {}, '이 종류는 패널에서 보여 주지 않습니다.'),
      h('button', { class: 'btn', type: 'button', onclick: () => this.openExternal('finder') }, this.cfg.copy.reveal), ' ',
      h('button', { class: 'btn', type: 'button', onclick: () => this.openExternal('app') }, this.cfg.copy.openApp));
  }
  renderImg(item) {
    const wrap = h('div', { class: 'rd-img' });
    const img = h('img', { src: this.url(item), alt: item.title, onclick: () => wrap.classList.toggle('full') });
    wrap.append(img);
    return new Promise((ok, fail) => { img.onload = () => ok(wrap); img.onerror = () => fail(new Error('이미지를 불러오지 못했습니다')); });
  }
  renderVideo(item) {
    const wrap = h('div', { class: 'rd-video' });
    const v = h('video', { controls: true, preload: 'metadata', src: this.url(item), playsinline: true });
    wrap.append(v);
    v.addEventListener('error', () => wrap.replaceWith(this.msg('브라우저가 열 수 없는 영상입니다', '코덱을 지원하지 않거나 파일을 아직 내려받지 않았습니다.', true)));
    return wrap;
  }
  async renderPreview(item) {
    if (item.assetOf) return this.renderInfo(item);
    const wrap = h('div', { class: 'rd-preview' });
    const img = h('img', { src: this.url(item, 'preview'), alt: `${item.title} 미리보기` });
    wrap.append(img, h('p', { class: 'rd-note' }, 'macOS 빠른 보기 미리보기 이미지(첫 쪽)입니다.'),
      h('button', { class: 'btn primary', type: 'button', onclick: () => this.openExternal('app') }, this.cfg.copy.openApp));
    return new Promise(ok => { img.onload = () => ok(wrap); img.onerror = () => ok(this.msg('미리보기를 만들지 못했습니다', `${item.ext?.toUpperCase()} 파일은 기본 앱으로 열어 주세요.`, true)); });
  }
  async renderCode(item) {
    const { text, cut } = await this.fetchText(item, 1_500_000);
    const pre = h('pre', { class: 'rd-code' });
    const lines = text.split('\n');
    const frag = document.createDocumentFragment();
    for (const l of lines.slice(0, 20000)) frag.append(h('span', {}, l || ' '));
    pre.append(frag);
    const wrap = h('div');
    if (cut || lines.length > 20000) wrap.append(h('p', { class: 'rd-note rd-pad' }, '파일이 커서 앞부분만 보여 줍니다.'));
    wrap.append(pre);
    return wrap;
  }
  async renderCsv(item, sep) {
    const { text } = await this.fetchText(item, 5_000_000);
    const rows = parseCsv(text, sep, 1001);
    const table = h('table', { class: 'rd-table' });
    rows.forEach((r, i) => table.append(h('tr', {}, r.map(c => h(i === 0 ? 'th' : 'td', {}, c)))));
    return h('div', { class: 'rd-pad' }, rows.length > 1000 ? h('p', { class: 'rd-note' }, '첫 1,000줄만 보여 줍니다.') : null, table);
  }
  async renderDir(item, sub = '') {
    const r = await fetch(`/api/book/${item.id}/list${sub ? `?sub=${encodeURIComponent(sub)}` : ''}`);
    if (!r.ok) throw new Error(r.status === 404 ? 'missing' : `${r.status}`);
    const j = await r.json();
    const list = h('ul', { class: 'rd-list' });
    if (sub) list.append(h('li', {}, h('button', { type: 'button', onclick: async () => { const up = sub.includes('/') ? sub.slice(0, sub.lastIndexOf('/')) : ''; this.body.querySelector('.rd-dir')?.replaceWith(await this.renderDir(item, up)); } }, h('b', {}, '..'), h('span'), h('span'))));
    for (const e of j.entries) {
      const rel = sub ? `${sub}/${e.name}` : e.name;
      list.append(h('li', {}, h('button', { type: 'button', class: e.dir ? 'dir' : '', onclick: async () => {
        if (e.dir) { this.body.querySelector('.rd-dir')?.replaceWith(await this.renderDir(item, rel)); return; }
        this.open({ assetOf: item.id, rel, title: e.name, basePath: `${item.path}/x`, ext: extOf(e.name), size: e.size, mtime: e.mtime });
      } }, h('b', {}, e.name), h('span', {}, e.dir ? '' : fmtSize(e.size)), h('span', {}, fmtDate(e.mtime)))));
    }
    return h('div', { class: 'rd-dir' }, h('p', { class: 'rd-note rd-pad', style: { paddingBottom: '0' } }, `${sub || '폴더'} · ${j.total.toLocaleString('ko-KR')}개`), list);
  }
  async renderMd(item) {
    const { text } = await this.fetchText(item);
    const html = DOMPurify.sanitize(marked.parse(text.replace(/^---\n[\s\S]*?\n---\n/, ''), { gfm: true, breaks: false }));
    const box = h('div', { class: 'md' }); box.innerHTML = html;
    const curPath = item.assetOf ? joinPath(dirOf(item.basePath ?? ''), item.rel) : item.path;
    const baseId = item.assetOf ?? item.id;
    const baseDir = item.assetOf ? dirOf(joinPath(dirOf(item.basePath ?? ''), item.rel)) : dirOf(item.path ?? '');
    const relToBase = p => { // 기준 책 폴더에서 본 상대 경로
      const root = item.assetOf ? dirOf(item.basePath ?? '') : dirOf(item.path ?? '');
      const parts = root ? root.split('/') : [], tgt = p.split('/');
      let i = 0; while (i < parts.length && parts[i] === tgt[i]) i++;
      return [...parts.slice(i).map(() => '..'), ...tgt.slice(i)].join('/');
    };
    for (const img of box.querySelectorAll('img')) {
      const src = img.getAttribute('src') ?? '';
      if (/^(https?:|data:)/i.test(src) || item.outside) continue;
      let dec = src; try { dec = decodeURIComponent(src); } catch { /* 그대로 */ }
      img.src = `/api/book/${baseId}/asset/${encPath(relToBase(joinPath(baseDir, dec.replace(/^<|>$/g, ''))))}`;
      img.loading = 'lazy';
    }
    for (const a of box.querySelectorAll('a[href]')) {
      const href = a.getAttribute('href');
      if (/^(https?:|mailto:)/i.test(href)) { a.target = '_blank'; a.rel = 'noopener noreferrer'; continue; }
      if (href.startsWith('#')) continue;
      a.addEventListener('click', e => {
        e.preventDefault();
        if (item.outside) { toast('세컨브레인 밖 문서의 링크는 열 수 없습니다'); return; }
        let dec = href.split('#')[0]; try { dec = decodeURIComponent(dec); } catch { /* 그대로 */ }
        const target = joinPath(baseDir, dec.replace(/^<|>$/g, ''));
        const book = this.app.bookByPath(target);
        if (book) { this.open(book, { goTo: book.id }); return; }
        this.open({ assetOf: baseId, rel: relToBase(target), title: baseOf(target), basePath: item.assetOf ? item.basePath : item.path, ext: extOf(target), kind: /\/$/.test(dec) ? 'dir' : 'file' });
      });
    }
    void curPath;
    return h('div', { class: 'rd-pad' }, box);
  }

  // 열람 패널 폭
  applyWidth() {
    const w = store.get('panelWidth', this.cfg.panel.width);
    document.documentElement.style.setProperty('--panel-w', `${Math.round(w * 100)}%`);
  }
  setupSplitter() {
    const sp = $('#splitter');
    const set = frac => { const { min, max } = this.cfg.panel; const f = Math.min(max, Math.max(min, frac)); document.documentElement.style.setProperty('--panel-w', `${Math.round(f * 1000) / 10}%`); store.set('panelWidth', f); this.app.onResize(); };
    let drag = false;
    sp.addEventListener('pointerdown', e => { drag = true; sp.setPointerCapture(e.pointerId); document.body.style.cursor = 'col-resize'; for (const f of document.querySelectorAll('iframe')) f.style.pointerEvents = 'none'; });
    sp.addEventListener('pointermove', e => { if (drag) set(1 - e.clientX / window.innerWidth); });
    sp.addEventListener('pointerup', () => { drag = false; document.body.style.cursor = ''; for (const f of document.querySelectorAll('iframe')) f.style.pointerEvents = ''; });
    sp.addEventListener('keydown', e => {
      const cur = store.get('panelWidth', this.cfg.panel.width);
      if (e.key === 'ArrowLeft') { set(cur + 0.03); e.preventDefault(); }
      if (e.key === 'ArrowRight') { set(cur - 0.03); e.preventDefault(); }
    });
  }
}

function parseCsv(text, sep, maxRows) {
  const rows = []; let row = [], cell = '', q = false;
  for (let i = 0; i < text.length && rows.length < maxRows; i++) {
    const ch = text[i];
    if (q) { if (ch === '"') { if (text[i + 1] === '"') { cell += '"'; i++; } else q = false; } else cell += ch; continue; }
    if (ch === '"') q = true;
    else if (ch === sep) { row.push(cell); cell = ''; }
    else if (ch === '\n') { row.push(cell.replace(/\r$/, '')); rows.push(row); row = []; cell = ''; }
    else cell += ch;
  }
  if ((cell || row.length) && rows.length < maxRows) { row.push(cell); rows.push(row); }
  return rows;
}

// 글자 인코딩 알아내기: BOM(UTF-16·UTF-8) → BOM 없는 UTF-16(0 바이트가 많음) → UTF-8 → EUC-KR(옛 한글 문서)
function decodeText(b) {
  if (b[0] === 0xFF && b[1] === 0xFE) return new TextDecoder('utf-16le').decode(b.subarray(2));
  if (b[0] === 0xFE && b[1] === 0xFF) return new TextDecoder('utf-16be').decode(b.subarray(2));
  if (b[0] === 0xEF && b[1] === 0xBB && b[2] === 0xBF) return new TextDecoder('utf-8').decode(b.subarray(3));
  const n = Math.min(b.length, 1000); let even = 0, odd = 0;
  for (let i = 0; i < n; i++) if (b[i] === 0) { if (i % 2) odd++; else even++; }
  if (odd > n * 0.2 && even < n * 0.05) return new TextDecoder('utf-16le').decode(b);
  if (even > n * 0.2 && odd < n * 0.05) return new TextDecoder('utf-16be').decode(b);
  try { return new TextDecoder('utf-8', { fatal: true }).decode(b); } catch { /* 다음 */ }
  try { return new TextDecoder('euc-kr', { fatal: true }).decode(b); } catch { return new TextDecoder('utf-8').decode(b); }
}
