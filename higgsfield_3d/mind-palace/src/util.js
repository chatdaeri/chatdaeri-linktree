// 공용 도구: 좌표 변환, 수학, 글자 텍스처, 저장소, DOM
import * as THREE from 'three';

export const fwd = a => ({ x: Math.sin(a), z: -Math.cos(a) });
export const rightOf = a => ({ x: Math.cos(a), z: Math.sin(a) });
// 방 지역 좌표(u 오른쪽, v 깊이) → 세계 좌표
export function toWorld(c, u, v) { const f = fwd(c.angle), r = rightOf(c.angle); return { x: c.x + f.x * v + r.x * u, z: c.z + f.z * v + r.z * u }; }
export function toLocal(c, x, z) { const dx = x - c.x, dz = z - c.z, f = fwd(c.angle), r = rightOf(c.angle); return { u: dx * r.x + dz * r.z, v: dx * f.x + dz * f.z }; }
// 벽 위치(at)를 지역 좌표·방향으로
export function wallFrame(c, wall, at) {
  switch (wall) {
    case 'back': return { u: -c.w / 2 + at, v: c.d, du: 1, dv: 0, nu: 0, nv: -1, rot: 0 };
    case 'front': return { u: c.w / 2 - at, v: 0, du: -1, dv: 0, nu: 0, nv: 1, rot: Math.PI };
    case 'left': return { u: -c.w / 2, v: at, du: 0, dv: 1, nu: 1, nv: 0, rot: Math.PI / 2 };
    case 'right': return { u: c.w / 2, v: c.d - at, du: 0, dv: -1, nu: -1, nv: 0, rot: -Math.PI / 2 };
    default: throw new Error(wall);
  }
}
// 지역 좌표의 three.js 표현: x = u, z = -v, 그룹 회전 y = -angle
export const localVec = (u, y, v) => new THREE.Vector3(u, y, -v);
export const clamp = (x, a, b) => Math.max(a, Math.min(b, x));
export const lerp = (a, b, t) => a + (b - a) * t;
export const smooth = t => t * t * (3 - 2 * t);
export const damp = (a, b, lambda, dt) => lerp(a, b, 1 - Math.exp(-lambda * dt));
export function angleDiff(a, b) { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; }
export const hash = s => { let h = 2166136261; for (const c of s) { h ^= c.codePointAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };
export const rand01 = (s, k = 0) => ((hash(`${s}:${k}`) % 10000) / 10000);

// 색
export function shade(hex, l = 0, s = 0) {
  const c = new THREE.Color(hex); const hsl = {}; c.getHSL(hsl);
  c.setHSL(hsl.h, clamp(hsl.s + s, 0, 1), clamp(hsl.l + l, 0, 1));
  return c;
}

// 글자 텍스처(명판·안내판). 글꼴이 먼저 불러와져 있어야 한다.
export function textTexture(lines, { width = 1024, height = 160, bg = '#FFFFFF', fg = '#22201D', sub = '#6B655D', size = 64, subSize = 34, align = 'center', padding = 40, border = null, weight = 700 } = {}) {
  const cv = document.createElement('canvas');
  cv.width = width; cv.height = height;
  const g = cv.getContext('2d');
  if (bg) { g.fillStyle = bg; g.fillRect(0, 0, width, height); }
  if (border) { g.strokeStyle = border; g.lineWidth = 4; g.strokeRect(2, 2, width - 4, height - 4); }
  const [main, second] = Array.isArray(lines) ? lines : [lines];
  g.textAlign = align; g.textBaseline = 'middle';
  const x = align === 'center' ? width / 2 : padding;
  const fit = (text, px, w) => { let s = px; g.font = `${weight} ${s}px Pretendard`; while (g.measureText(text).width > w && s > 12) { s -= 2; g.font = `${weight} ${s}px Pretendard`; } return s; };
  if (second) {
    fit(main, size, width - padding * 2); g.fillStyle = fg; g.fillText(main, x, height * 0.4);
    g.font = `500 ${subSize}px Pretendard`; let t = second;
    while (g.measureText(t).width > width - padding * 2 && t.length > 4) t = `${t.slice(0, -2)}…`;
    g.fillStyle = sub; g.fillText(t, x, height * 0.74);
  } else { fit(main, size, width - padding * 2); g.fillStyle = fg; g.fillText(main, x, height / 2 + 2); }
  const tex = new THREE.CanvasTexture(cv);
  tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
  return tex;
}

// 저장소
const KEY = 'mind-palace:';
export const store = {
  get(k, d = null) { try { const v = localStorage.getItem(KEY + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(KEY + k, JSON.stringify(v)); } catch { /* 무시 */ } },
};

// DOM
export const $ = (s, el = document) => el.querySelector(s);
export const $$ = (s, el = document) => [...el.querySelectorAll(s)];
export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'text') el.textContent = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}
export function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 ** 3) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  return `${(n / 1024 ** 3).toFixed(2)} GB`;
}
export function fmtDate(sec) {
  if (!sec) return '';
  const d = new Date(sec * 1000);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
export const token = () => document.querySelector('meta[name="palace-token"]')?.content ?? '';
export async function post(url) {
  const r = await fetch(url, { method: 'POST', headers: { 'X-Palace-Token': token() } });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
}
let toastTimer = 0;
export function toast(msg, ms = 2400) {
  const el = $('#toast'); el.textContent = msg; el.hidden = false;
  window.gsap?.fromTo(el, { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.3, ease: 'power3.out', overwrite: true });
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}
export const reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
export const isMobile = () => window.innerWidth < 768;
