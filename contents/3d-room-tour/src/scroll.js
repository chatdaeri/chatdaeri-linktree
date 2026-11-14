// 스크롤 랜딩: 종이 위 평면도(실제 3D 모델을 1.2m에서 자르고 아주 긴 렌즈로 바로 위에서 본 것) → 벽이 올라옴 →
// 카메라가 현관문 앞 눈높이로 내려와 방에서 방으로 걷는다. 방은 카메라가 닿을 때까지 선 그림이고, 닿으면 실제 재질이 쓸고 지나간다.
// 전체: 도면 · 벽 세우기 · 현관문 앞 · 현관 · 주방·식당 · 거실 · 둥근 발코니 · 침실1 · 욕실 엿보기 · 침실2 → 끝에서 직접 걸어 보기
// 진행도 P(0~1) 중 앞 K(=0.36)는 체크포인트 1 구간(그 안에서는 p = P / K로 예전 시간표를 그대로 쓴다), 뒤는 방에서 방으로
import * as THREE from 'three';
import { loadLook, loadExtraTex, viewEnvironment, Post } from './look.js';
import { House } from './house.js';
import { Furniture } from './furniture.js';
import { Exterior } from './exterior.js';
import { Nav } from './nav.js';

const gsap = window.gsap, ScrollTrigger = window.ScrollTrigger;
gsap.registerPlugin(ScrollTrigger);
const Q = new URLSearchParams(location.search), REC = Q.get('record'); // ?record=프레임수 → 장면을 프레임마다 그려 서버로 보낸다(record.py)
const V = (x, y, z) => new THREE.Vector3(x, y, z);
const clamp01 = x => Math.min(1, Math.max(0, x));
const smooth = (a, b, x) => { const t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); };
const ease = t => t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
const lerp = (a, b, t) => a + (b - a) * t;

// ---- 종이·잉크 색: 후처리 마지막 단계(ACES 톤매핑 + sRGB)를 거친 뒤 이 색이 나오도록, 톤매핑 앞의 값을 거꾸로 구한다 ----
const EXPO = 1.04; // 화사하게(종이·잉크 색은 이 값으로 거꾸로 맞춘다)
const IN = [[0.59719, 0.35458, 0.04823], [0.07600, 0.90834, 0.01566], [0.02840, 0.13383, 0.83777]];
const OUT = [[1.60475, -0.53108, -0.07367], [-0.10208, 1.10813, -0.00605], [-0.00327, -0.07276, 1.07602]];
const mul = (M, v) => M.map(r => r[0] * v[0] + r[1] * v[1] + r[2] * v[2]);
const fit = x => (x * (x + 0.0245786) - 0.000090537) / (x * (0.983729 * x + 0.4329510) + 0.238081);
const aces = v => mul(OUT, mul(IN, v.map(c => c * EXPO / 0.6)).map(fit)).map(clamp01);
function preTone(hex) {
  const c = new THREE.Color(hex), t = [c.r, c.g, c.b]; // Color(hex)는 선형 값
  let x = t.slice();
  for (let k = 0; k < 60; k++) {
    const y = aces(x);
    for (let i = 0; i < 3; i++) { const e = 1e-3, xp = x.slice(); xp[i] += e; const d = (aces(xp)[i] - y[i]) / e || 1; x[i] = Math.max(0, x[i] + (t[i] - y[i]) / Math.max(d, 0.05)); }
  }
  return new THREE.Color(x[0], x[1], x[2]);
}
const PAPER = preTone('#F3F0E8'), INK = preTone('#1D1C1A'), GLOW = new THREE.Color(1.7, 1.15, 0.55); // 칸 외곽 빛(따뜻한 금빛)

// ---- 드러남(선 그림 → 재질): 방마다 사각형 · 쓸고 가는 방향 · 진행도 ----
const NR = 16;
const U = {
  uRect: { value: Array.from({ length: NR }, () => new THREE.Vector4(0, 0, -1, -1)) },
  uSweep: { value: Array.from({ length: NR }, () => new THREE.Vector4(0, 0, -1, 0)) },
  uLen: { value: new Array(NR).fill(1) }, uProg: { value: new Array(NR).fill(0) },
  uN: { value: 0 }, uOut: { value: 0 }, uPaper: { value: PAPER }, uInk: { value: INK }, uGlow: { value: GLOW },
  uPlan: { value: null }, uPlanXf: { value: new THREE.Vector4(0, 0, 1, 1) }, uPlanOn: { value: 0 }, // 아직 안 칠해진 바닥 = 처음의 흑백 평면도(실제 축척 그대로)
};
const REVEAL = /* glsl */`
uniform vec4 uRect[${NR}]; uniform vec4 uSweep[${NR}]; uniform float uLen[${NR}]; uniform float uProg[${NR}];
uniform int uN; uniform float uOut; uniform vec3 uPaper; uniform vec3 uInk; uniform vec3 uGlow;
uniform sampler2D uPlan; uniform vec4 uPlanXf; uniform float uPlanOn;
varying vec3 vWPos;
// 30cm 입체 칸(타일)마다: 걷는 방향 거리 + 칸마다 다른 지연 → 차례가 오면 칸 외곽이 먼저 빛나고, 이어서 재질로 채워진다
const float CELL = 0.3;
float hash3( vec3 c ) { return fract( sin( dot( c, vec3( 12.9898, 78.233, 37.719 ) ) ) * 43758.5453 ); }
vec2 revealAt( vec3 p, vec3 nrm ) {
  vec3 cid = floor( p / CELL ), cc = ( cid + 0.5 ) * CELL, f = fract( p / CELL ), dd = min( f, 1.0 - f ), an = abs( nrm );
  float edge = an.x >= an.y && an.x >= an.z ? min( dd.y, dd.z ) : an.y >= an.z ? min( dd.x, dd.z ) : min( dd.x, dd.y ); // 면에 놓인 두 방향의 칸 경계까지 거리
  float line = 1.0 - smoothstep( 0.025, 0.075, edge );
  float rv = 0.0, gl = 0.0; bool inside = false;
  for ( int i = 0; i < ${NR}; i ++ ) {
    if ( i >= uN ) break;
    vec4 r = uRect[ i ];
    if ( p.x < r.x || p.x > r.z || p.z < r.y || p.z > r.w ) continue;
    inside = true;
    float s = dot( cc.xz - uSweep[ i ].xy, uSweep[ i ].zw ) + hash3( cid ) * 0.9;
    float k = uProg[ i ] * ( uLen[ i ] + 1.6 ) - 0.35 - s;           // 이 칸 차례에서 얼마나 지났나(m)
    rv = max( rv, smoothstep( 0.05, 0.22, k ) );
    float on = step( 0.002, uProg[ i ] ) * step( uProg[ i ], 0.998 );
    gl = max( gl, on * ( smoothstep( -0.12, 0.0, k ) * ( 1.0 - smoothstep( 0.05, 0.6, k ) ) ) * ( line + 0.18 * ( 1.0 - smoothstep( 0.05, 0.22, k ) ) ) );
  }
  if ( ! inside ) { rv = uOut; gl = 0.0; }
  return vec2( rv, gl );
}
`;
const done = new WeakSet();
function patchSurface(m, cap) {
  if (done.has(m)) return; done.add(m);
  if (cap) { m.defines = { ...(m.defines || {}), CAP: '' }; m.side = THREE.DoubleSide; }
  m.polygonOffset = true; m.polygonOffsetFactor = 1; m.polygonOffsetUnits = 1; // 윤곽선이 면 위에 또렷이
  const prev = m.onBeforeCompile;
  m.onBeforeCompile = (sh, r) => {
    prev?.call(m, sh, r); Object.assign(sh.uniforms, U);
    sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = REVEAL + sh.fragmentShader.replace('#include <opaque_fragment>', `#include <opaque_fragment>
  { vec3 nrmW = normalize( cross( dFdx( vWPos ), dFdy( vWPos ) ) ); vec2 rg = revealAt( vWPos, nrmW ); vec3 paper = uPaper;
    if ( uPlanOn > 0.5 && abs( nrmW.y ) > 0.9 && vWPos.y < 0.08 ) { // 바닥: 평면도 그림(방 이름·치수·문 호)이 깔려 있다가 칸마다 재질로 덮인다
      vec2 uv = ( vWPos.xz - uPlanXf.xy ) / uPlanXf.zw;
      if ( uv.x > 0.0 && uv.x < 1.0 && uv.y > 0.0 && uv.y < 1.0 ) { float l = dot( texture2D( uPlan, vec2( uv.x, 1.0 - uv.y ) ).rgb, vec3( 0.3333 ) ); paper = mix( uInk, uPaper, 0.12 + 0.88 * smoothstep( 0.25, 0.92, l ) ); }
    }
#ifdef CAP
    if ( ! gl_FrontFacing ) paper = uInk; // 잘린 벽 속 = 검은 단면
#endif
    { // 모눈종이: 아직 안 칠해진 면에 30cm 칸 선을 옅은 잉크로(칠해질 칸이 미리 보인다)
      vec3 f = fract( vWPos / CELL ), dd = min( f, 1.0 - f ), an = abs( nrmW );
      float e = an.x >= an.y && an.x >= an.z ? min( dd.y, dd.z ) : an.y >= an.z ? min( dd.x, dd.z ) : min( dd.x, dd.y );
      float gridL = 1.0 - smoothstep( 0.012, 0.04, e ); paper = mix( paper, uInk, 0.26 * gridL ); }
    gl_FragColor.rgb = mix( paper, gl_FragColor.rgb, rg.x ) + uGlow * rg.y; }`);
  };
  const key = m.customProgramCacheKey?.bind(m);
  m.customProgramCacheKey = () => (key ? key() : '') + (cap ? '|rvc' : '|rv');
  m.needsUpdate = true;
}
const LINE = new THREE.LineBasicMaterial({ color: INK });
LINE.onBeforeCompile = sh => {
  Object.assign(sh.uniforms, U);
  sh.vertexShader = 'varying vec3 vWPos;\n' + sh.vertexShader.replace('#include <project_vertex>', '#include <project_vertex>\n  vWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
  sh.fragmentShader = REVEAL + sh.fragmentShader.replace('#include <opaque_fragment>', '#include <opaque_fragment>\n  if ( revealAt( vWPos, vec3( 0.0, 1.0, 0.0 ) ).x > 0.5 ) discard;');
};
LINE.customProgramCacheKey = () => 'rvline';
const edgeCache = new WeakMap();
function addEdges(mesh, angle = 32) {
  let g = edgeCache.get(mesh.geometry);
  if (!g) { g = new THREE.EdgesGeometry(mesh.geometry, angle); edgeCache.set(mesh.geometry, g); }
  const l = new THREE.LineSegments(g, LINE); l.userData.edge = true; l.raycast = () => {}; mesh.add(l);
}

// ---- 불러오기 진행 막대: 단계마다 받을 파일 크기만큼 구간을 나눈다(질감 → 창밖 → 가구 3D) ----
const LOAD = { bar: document.getElementById('loadbar'), pct: document.getElementById('loadpct'), lo: 0, hi: 0, base: 0, last: 0, shown: 0 };
const loadShow = v => { v = Math.min(1, v); if (v <= LOAD.shown) return; LOAD.shown = v; LOAD.bar.style.transform = `scaleX(${v})`; LOAD.pct.textContent = Math.round(v * 100) + '%'; };
const loadStage = (lo, hi) => { Object.assign(LOAD, { lo, hi, base: LOAD.last }); loadShow(lo); };
THREE.DefaultLoadingManager.onProgress = (url, done, total) => { LOAD.last = done; if (total > LOAD.base) loadShow(LOAD.lo + (LOAD.hi - LOAD.lo) * (done - LOAD.base) / (total - LOAD.base)); };
loadStage(0.08, 0.08);

// ---- 무대 ----
const S = await (await fetch('scene.json')).json();
S.wallColor = '#FFFCF5'; // 벽지: 크림빛 흰색(석회 도장 결은 그대로)
const [W, D] = S.size, H = S.wallHeight ?? 2.3, C = V(W / 2, 0, D / 2);
const R = new THREE.WebGLRenderer({ canvas: document.getElementById('gl'), antialias: true, powerPreference: 'high-performance', preserveDrawingBuffer: !!REC });
R.setPixelRatio(REC ? 1 : Math.min(2, devicePixelRatio)); R.outputColorSpace = THREE.SRGBColorSpace;
R.toneMapping = THREE.ACESFilmicToneMapping; R.toneMappingExposure = EXPO;
R.shadowMap.enabled = true; R.shadowMap.type = THREE.PCFShadowMap;
const clip = new THREE.Plane(V(0, -1, 0), 1.2); R.clippingPlanes = [clip]; // 1.2m 위는 잘라 낸다(평면도 = 이 높이에서 자른 모습)
const scene = new THREE.Scene(); scene.background = PAPER.clone();
const camera = new THREE.PerspectiveCamera(2, 1, 0.05, 1200);
loadStage(0.08, 0.26);
await loadLook(R, S.view);
if (S.style?.tex) await loadExtraTex(R, Object.values(S.style.tex));
scene.environment = viewEnvironment(R); scene.environmentIntensity = 1.1;
const house = new House(scene, S).build();
Exterior.prototype.buildCorridor = function () {}; // 이 영상에는 현관 밖 계단실(복도·계단·난간·엘리베이터)을 짓지 않는다. 정원·나무·하늘만
loadStage(0.26, 0.42);
const ext = await new Exterior(scene, S, house).build();
loadStage(0.42, 0.94);
const furn = await new Furniture(scene, S).build();
loadStage(0.94, 0.97);
// 늦은 오후 해: 둥근 발코니(서쪽)에서 낮게 들어온다
scene.add(new THREE.HemisphereLight(0xFFF3E0, 0xD8C2A0, 1.0)); // 따뜻한 하늘빛 + 마루에서 튀는 빛
const fill = new THREE.DirectionalLight(0xFFE4BC, 0.7); fill.position.copy(C).add(V(-6, 8, -3)); fill.target.position.copy(C); scene.add(fill, fill.target); // 그림자 없는 따뜻한 보조광
const sun = new THREE.DirectionalLight(0xFFC88C, 5.4), sdir = V(-1, 0.29, 0.4).normalize(); // 늦은 오후: 낮게 들어와 방 깊이 닿는다
sun.position.copy(C).addScaledVector(sdir, 30); sun.target.position.copy(C);
sun.castShadow = true; sun.shadow.mapSize.set(4096, 4096); sun.shadow.bias = -0.0002; sun.shadow.normalBias = 0.03;
Object.assign(sun.shadow.camera, { left: -9, right: 9, top: 9, bottom: -9, near: 1, far: 70 }); sun.shadow.camera.updateProjectionMatrix();
scene.add(sun, sun.target);
const post = new Post(R, scene, camera);
post.bloom.threshold = 6; post.bloom.strength = 0.12; // 종이 흰색(톤매핑 앞 값이 크다)은 번지지 않고 전구만 번지게

// 재질 패치 + 윤곽선(바닥판·걸레받이·천장·바깥은 선 없음)
const sky = []; ext.group.traverse(o => { if (o.isMesh && o.material?.isShaderMaterial) sky.push(o); });
const extCeil = []; ext.group.traverse(o => { if (o.isMesh && !o.material?.isShaderMaterial) { const b = new THREE.Box3().setFromObject(o); if (b.min.y > H - 0.05 && b.max.y < H + 0.5) extCeil.push(o); } });
scene.updateMatrixWorld(true);
const bb = new THREE.Box3();
const meshes = []; scene.traverse(o => { if (o.isMesh) meshes.push(o); });
for (const o of meshes) {
  if (o.material?.isShaderMaterial) continue;
  const isWall = !!o.userData.wall;
  for (const m of [].concat(o.material)) patchSurface(m, isWall);
  if (!o.visible) continue;
  let p = o, inExt = false, inCeil = false; while (p) { if (p === ext.group) inExt = true; if (p === house.ceilings) inCeil = true; p = p.parent; }
  if (inExt || inCeil) continue;
  bb.setFromObject(o); const h = bb.max.y - bb.min.y;
  if (house.floors.includes(o) || (bb.max.y < 0.05 && h < 0.06) || (h < 0.1 && bb.min.y < 0.02 && !o.parent?.userData?.furniture && !o.parent?.parent?.userData?.furniture)) continue;
  addEdges(o, o.geometry?.attributes?.position?.count > 3000 ? 62 : 30); // 고해상 3D 가구는 큰 꺾임만(침구 주름이 잔선으로 뭉개졌다)
}

// 방 사각형(벽 두께만큼 넓힘)과 쓸고 갈 방향. 이름 없는 수납·복도 칸은 가장 가까운 방과 함께 드러난다
const SOUTH = new Set(['욕실', '침실2']);
const named = S.rooms.filter(r => !r.auto), prog = Object.fromEntries(named.map(r => [r.name, 0]));
const slots = S.rooms.map((r, i) => {
  const x0 = Math.min(...r.rects.map(q => q[0])) - 0.18, z0 = Math.min(...r.rects.map(q => q[1])) - 0.18, x1 = Math.max(...r.rects.map(q => q[2])) + 0.18, z1 = Math.max(...r.rects.map(q => q[3])) + 0.18;
  let owner = r.name;
  if (r.auto) { const cx = (x0 + x1) / 2, cz = (z0 + z1) / 2; owner = named.slice().sort((a, b) => Math.hypot(a.center[0] - cx, a.center[1] - cz) - Math.hypot(b.center[0] - cx, b.center[1] - cz))[0].name; }
  U.uRect.value[i].set(x0, z0, x1, z1);
  if (SOUTH.has(owner)) { U.uSweep.value[i].set(0, z0, 0, 1); U.uLen.value[i] = z1 - z0; } // 북쪽 문으로 들어가는 방: 남쪽으로 쓸어 간다
  else { U.uSweep.value[i].set(x1, 0, -1, 0); U.uLen.value[i] = x1 - x0; }                  // 그 밖: 서쪽으로(걷는 방향)
  return { owner };
});
U.uN.value = Math.min(NR, slots.length);

// 잘린 벽 단면(검은 면): 벽 속이 비어 있어 아래 바닥판이 비쳤다 → 자른 높이에 검은 판을 얹고 벽과 함께 올린다
const capMat = new THREE.MeshBasicMaterial({ color: INK }), caps = new THREE.Group(); scene.add(caps);
for (const w of S.walls) {
  const hz = w.o === 'h', len = Math.abs(hz ? w.b[0] - w.a[0] : w.b[1] - w.a[1]) + 0.01;
  const m = new THREE.Mesh(new THREE.PlaneGeometry(hz ? len : w.t, hz ? w.t : len).rotateX(-Math.PI / 2), capMat);
  m.position.set((w.a[0] + w.b[0]) / 2, 0, (w.a[1] + w.b[1]) / 2); caps.add(m);
}
for (const A of S.arcs ?? []) if (!A.glass) { const m = new THREE.Mesh(new THREE.RingGeometry(A.r - A.t / 2, A.r + A.t / 2, 48, 1, -(A.a0 + A.span), A.span).rotateX(-Math.PI / 2), capMat); m.position.set(A.c[0], 0, A.c[1]); caps.add(m); }

// 평면도에만 보이는 것: 문 열림 호 · 치수선
const planOnly = new THREE.Group(); scene.add(planOnly);
const planLine = new THREE.LineBasicMaterial({ color: INK, transparent: true });
const seg = pts => { const g = new THREE.BufferGeometry().setFromPoints(pts); const l = new THREE.Line(g, planLine); planOnly.add(l); };
for (const pv of house.doors) {
  const o = S.openings.find(q => q.id === pv.userData.id); if (!o) continue;
  const hx = pv.position.x, hz = pv.position.z, A = Math.hypot(o.a[0] - hx, o.a[1] - hz) > Math.hypot(o.b[0] - hx, o.b[1] - hz) ? o.a : o.b;
  const r = Math.hypot(A[0] - hx, A[1] - hz), a0 = Math.atan2(A[1] - hz, A[0] - hx), a1 = -pv.rotation.y;
  let d = a1 - a0; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI;
  seg(Array.from({ length: 33 }, (_, k) => V(hx + r * Math.cos(a0 + d * k / 32), 0.02, hz + r * Math.sin(a0 + d * k / 32))));
}
const DIM = 0.8;
seg([V(0, 0.02, -0.15), V(0, 0.02, -DIM - 0.15)]); seg([V(W, 0.02, -0.15), V(W, 0.02, -DIM - 0.15)]); seg([V(-0.2, 0.02, -DIM), V(W + 0.2, 0.02, -DIM)]);
seg([V(-0.15, 0.02, 0), V(-DIM - 0.15, 0.02, 0)]); seg([V(-0.15, 0.02, D), V(-DIM - 0.15, 0.02, D)]); seg([V(-DIM, 0.02, -0.2), V(-DIM, 0.02, D + 0.2)]);
for (const [x, z] of [[0, -DIM], [W, -DIM], [-DIM, 0], [-DIM, D]]) seg([V(x - 0.1, 0.02, z + 0.1), V(x + 0.1, 0.02, z - 0.1)]);

// ---- 카메라 길 ----
const aerialDir = V(1, 0, 0.85).normalize(), EL1 = THREE.MathUtils.degToRad(38), DIST1 = 15.5, FOV1 = 34;
const doorOut = V(10.2, 1.6, 2.76), doorLook = V(7.6, 1.45, 2.72); // 문짝(북쪽 경첩) 반대편으로 비켜 선다
const descent = new THREE.CatmullRomCurve3([V(0, 0, 0), V(10.7, 5.0, 3.7), V(10.3, 2.4, 2.85), doorOut.clone()]);
const walkIn = new THREE.CatmullRomCurve3([doorOut.clone(), V(9.3, 1.6, 2.7), V(8.45, 1.6, 2.6)]);
const toKitchen = new THREE.CatmullRomCurve3([V(8.45, 1.6, 2.58), V(7.85, 1.6, 2.5), V(7.5, 1.58, 2.68)]);
const lookKitchen = new THREE.CatmullRomCurve3([V(6.8, 1.4, 2.35), V(5.9, 1.2, 1.7), V(5.2, 1.05, 1.25)]);
const PL = S.plan, IMGW = PL.size[0] / PL.ppm, IMGD = PL.size[1] / PL.ppm, IMG0 = [-PL.origin[0] / PL.ppm, -PL.origin[1] / PL.ppm]; // 평면도 그림이 덮는 범위(m)
{ const t = await new THREE.TextureLoader().loadAsync('plan-bw.png?v=20261114'); t.colorSpace = THREE.NoColorSpace; t.anisotropy = 8; U.uPlan.value = t; U.uPlanXf.value.set(IMG0[0], IMG0[1], IMGW, IMGD); }
let halfPlan = 4;
function planFrame(aspect) { halfPlan = Math.max((IMGW + 0.6) / 2 / aspect, (IMGD + 1.4) / 2); }
const look = V(0, 0, 0), pos = V(0, 0, 0), up = V(0, 1, 0);
// 체크포인트 1 뒤: 구간마다 [시작 P, 끝 P, 카메라 길, 보는 곳 길, 화각]. 눈높이 1.55~1.58m, 문은 가운데로 지나간다
const K = 0.36;
const SEG = [ // [시작 P, 끝 P, 카메라 길(점), 고개 [좌우°(0 = +z 남쪽, 90 = +x 동쪽), 위아래°](점마다 하나), 화각 시작, 끝]
  [0.380, 0.470, [[7.5, 1.58, 2.68], [6.2, 1.58, 1.85], [4.95, 1.56, 1.45], [4.42, 1.52, 1.92]], [[-122, -11], [-110, -8], [-118, -12], [-132, -14]], 64, 64], // 아치를 지나 거실 모퉁이로
  [0.470, 0.535, [[4.42, 1.52, 1.92], [3.6, 1.53, 1.7], [2.6, 1.55, 1.4]], [[-132, -14], [-110, -14], [-86, -15]], 62, 62],                                             // 소파 → 유리문
  [0.535, 0.605, [[2.6, 1.55, 1.4], [2.35, 1.55, 1.35], [2.3, 1.55, 1.5]], [[-86, -15], [-108, -14], [-62, -14]], 62, 64],                                              // 둥근 발코니를 훑는다
  [0.605, 0.752, [[2.3, 1.55, 1.5], [3.4, 1.58, 1.75], [4.67, 1.58, 1.6], [5.1, 1.58, 2.2], [5.2, 1.58, 2.92], [4.6, 1.58, 2.92], [3.9, 1.56, 3.15]],
                 [[-62, -14], [-150, -9], [-265, -5], [-330, -5], [-415, -6], [-440, -10], [-374, -20]], 64, 64],                                                                 // 소파 쪽으로 고개를 돌리며 아치·복도를 지나 침실1로(각도는 이어지게 -360 넘어서도 그대로 센다)
  [0.752, 0.785, [[3.9, 1.56, 3.15], [3.85, 1.56, 3.2]], [[-374, -20], [-420, -15]], 64, 64],                                                                             // 침대 → 창
  [0.785, 0.835, [[3.85, 1.56, 3.2], [4.5, 1.58, 2.95], [5.16, 1.6, 3.36]], [[-420, -15], [-337, -10], [-347, -25]], 64, 76],                                                  // 욕실 문 앞
  [0.835, 0.860, [[5.16, 1.6, 3.36], [5.16, 1.6, 3.42]], [[-347, -25], [-345, -25]], 78, 78],                                                                               // 엿보기
  [0.860, 0.940, [[5.16, 1.6, 3.42], [5.3, 1.58, 3.0], [5.6, 1.58, 2.72], [6.5, 1.58, 2.55], [7.07, 1.58, 2.6], [7.07, 1.58, 3.25], [7.3, 1.56, 3.6]],
                 [[-345, -25], [-320, -10], [-280, -8], [-265, -6], [-325, -8], [-357, -15], [-363, -22]], 76, 64],                                                                                // 침실2로(문 가운데로 곧게)
  [0.940, 1.000, [[7.3, 1.56, 3.6], [7.95, 1.6, 3.3]], [[-363, -22], [-384, -20]], 64, 68],                                                                               // 책상 → 책장
].map(([a, b, ps, hs, f0, f1]) => ({ a, b, f0, f1, pc: new THREE.CatmullRomCurve3(ps.map(q => V(...q)), false, 'centripetal'), hc: new THREE.CatmullRomCurve3(hs.map(([y, x]) => V(y, x, 0)), false, 'catmullrom', 0.5) }));
// 걷는 속도는 거리에 맞춰 고르게(getPointAt), 고개는 같은 자리(점 번호)에 맞춰 돌린다: 보는 곳을 곡선으로 잡으면 보는 점이 카메라 옆을 지날 때 고개가 홱 꺾였다
const hv = V(0, 0, 0);
function cameraAt(P) {
  if (P > K) { // 방에서 방으로
    const sg = SEG.find(q => P <= q.b) ?? SEG[SEG.length - 1], s0 = P < SEG[0].a ? SEG[0] : sg, u = P < SEG[0].a ? 0 : clamp01((P - sg.a) / (sg.b - sg.a));
    const t = s0.pc.points.length > 4 ? lerp(u, ease(u), 0.4) : ease(u); // 긴 길은 고르게(가운데서 너무 빨라져 고개가 홱 돌았다), 짧은 길은 부드럽게 서고 떠난다
    s0.pc.getPointAt(t, pos); s0.hc.getPoint(s0.pc.getUtoTmapping(t), hv); const yw = THREE.MathUtils.degToRad(hv.x), pt = THREE.MathUtils.degToRad(hv.y);
    look.set(pos.x + Math.sin(yw) * Math.cos(pt) * 3, pos.y + Math.sin(pt) * 3, pos.z + Math.cos(yw) * Math.cos(pt) * 3); camera.near = 0.05; camera.far = 600;
    camera.position.copy(pos); camera.up.set(0, 1, 0); camera.fov = lerp(s0.f0, s0.f1, t); camera.updateProjectionMatrix(); camera.lookAt(look); return;
  }
  const p = P / K;
  let fov;
  if (p < 0.38) { // 평면도 → 비스듬한 하늘 시점(돌리 줌: 멀고 좁은 렌즈에서 가깝고 넓은 렌즈로, 화면 속 크기는 비슷하게)
    const t = ease(smooth(0.12, 0.38, p)), el = lerp(Math.PI / 2, EL1, t), dist = Math.exp(lerp(Math.log(300), Math.log(DIST1), t));
    const half = lerp(halfPlan, DIST1 * Math.tan(THREE.MathUtils.degToRad(FOV1 / 2)), t);
    fov = THREE.MathUtils.radToDeg(2 * Math.atan(half / dist));
    pos.copy(C).addScaledVector(aerialDir, Math.cos(el) * dist); pos.y = Math.sin(el) * dist;
    const IC = V(IMG0[0] + IMGW / 2, 0, IMG0[1] + IMGD / 2 + 0.25); pos.x += IC.x - C.x; pos.z += IC.z - C.z;
    pos.lerp(V(0, 0, 0).copy(C).addScaledVector(aerialDir, Math.cos(el) * dist).setY(Math.sin(el) * dist), t); look.copy(IC).lerp(C, t); up.set(0, 0, -1).lerp(V(0, 1, 0), t).normalize();
  } else if (p < 0.55) { // 하늘에서 현관문 앞 눈높이로
    const t = ease(smooth(0.38, 0.55, p));
    descent.points[0].copy(C).addScaledVector(aerialDir, Math.cos(EL1) * DIST1); descent.points[0].y = Math.sin(EL1) * DIST1;
    descent.getPoint(t, pos); look.lerpVectors(C, doorLook, smooth(0, 0.85, t)); fov = lerp(FOV1, 60, t); up.set(0, 1, 0);
  } else if (p < 0.74) { // 문을 지나 현관으로
    const t = ease(smooth(0.57, 0.74, p)); walkIn.getPoint(t, pos); look.lerpVectors(doorLook, lookKitchen.points[0], t); fov = 60; up.set(0, 1, 0);
  } else { // 현관에서 주방·식당으로
    const t = ease(smooth(0.76, 0.95, p)); toKitchen.getPoint(t, pos); lookKitchen.getPoint(t, look); fov = lerp(60, 64, t); up.set(0, 1, 0);
  }
  // 가까운·먼 자름면을 집까지 거리에 맞춘다: 300m 밖에서 가까운 면이 5cm면 깊이 구분이 약 5cm로 뭉개져
  // 몇 mm 떨어진 윤곽선·벽 단면·바닥판이 프레임마다 앞뒤를 바꾸며 덜덜 떨렸다
  const dC = pos.distanceTo(C), low = pos.y < H + 0.15;
  camera.near = low ? 0.05 : Math.max(0.05, dC - 16); camera.far = low ? 600 : Math.max(dC + 30, p > 0.42 ? 160 : 0);
  camera.position.copy(pos); camera.up.copy(up); camera.fov = fov; camera.updateProjectionMatrix(); camera.lookAt(look);
}

// ---- 잉크 겹 그림(방 이름·면적·치수 숫자·도면 틀·장소 이름): 2D 캔버스. 녹화 때 3D 화면과 합친다 ----
const ink = document.getElementById('ink'), g = ink.getContext('2d');
const planImg = new Image(); planImg.src = 'plan-bw.png?v=20261114'; await planImg.decode();
const inkHex = '#1D1C1A', subHex = '#6B655C', paperHex = '#F3F0E8';
const PLAN_IMG = true; // 처음 도면 = 다시 그린 평면도 그림(false면 모델에서 그린 이름·치수)
const NAME = { '주방및식당': '주방 · 식당' }, LABEL = { '발코니': [1.15, 0, 4.35], '침실1': [3.25, 0, 3.0] }; // 표기 이름 · 가구와 겹치지 않는 표기 자리
const proj = v => { const q = v.clone().project(camera); return [(q.x + 1) / 2 * ink.clientWidth, (1 - q.y) / 2 * ink.clientHeight, q.z]; };
function drawInk(P) {
  const p = pOld(P), w = ink.clientWidth, h = ink.clientHeight, a = 1 - smooth(0.06, 0.15, p), sx = ink.width / w;
  g.setTransform(sx, 0, 0, sx, 0, 0); g.clearRect(0, 0, w, h);
  const ia = 1 - smooth(0.115, 0.17, p); // 네이버 평면도(흑백): 모델과 같은 자리, 벽이 올라오기 시작하면 모델로 녹아든다
  if (ia > 0.01) {
    const P0 = proj(V(IMG0[0], 0, IMG0[1])), PX = proj(V(IMG0[0] + IMGW, 0, IMG0[1])), PZ = proj(V(IMG0[0], 0, IMG0[1] + IMGD)), iw = planImg.width, ih = planImg.height;
    g.save(); g.globalAlpha = ia; g.setTransform(sx * (PX[0] - P0[0]) / iw, sx * (PX[1] - P0[1]) / iw, sx * (PZ[0] - P0[0]) / ih, sx * (PZ[1] - P0[1]) / ih, sx * P0[0], sx * P0[1]);
    g.imageSmoothingQuality = 'high'; g.drawImage(planImg, 0, 0); g.restore();
  }
  if (a > 0.01) {
    g.globalAlpha = a; g.fillStyle = inkHex; g.strokeStyle = inkHex; g.textAlign = 'center'; g.textBaseline = 'middle';
    if (!PLAN_IMG) for (const r of named) {
      const [x, y] = proj(V(r.center[0], 0, r.center[1])), xs = r.rects.flatMap(q => [q[0], q[2]]), zs = r.rects.flatMap(q => [q[1], q[3]]);
      const dims = `${Math.round((Math.max(...xs) - Math.min(...xs)) * 100) * 10} × ${Math.round((Math.max(...zs) - Math.min(...zs)) * 100) * 10}`;
      const [lx, ly] = LABEL[r.name] ? proj(V(...LABEL[r.name])) : [x, y], nm = NAME[r.name] ?? r.name, sub = `${(r.stated ?? r.area).toFixed(1)}㎡ · ${dims}`;
      g.lineJoin = 'round'; g.strokeStyle = paperHex; g.lineWidth = 4;
      g.font = '600 13px Pretendard'; g.strokeText(nm, lx, ly - 9); g.fillStyle = inkHex; g.fillText(nm, lx, ly - 9);
      g.font = '400 10.5px Pretendard'; g.strokeText(sub, lx, ly + 8); g.fillStyle = subHex; g.fillText(sub, lx, ly + 8); g.fillStyle = inkHex; g.strokeStyle = inkHex; g.lineWidth = 1;
    }
    g.font = '400 11px Pretendard';
    let [x, y] = proj(V(W / 2, 0, -DIM)); if (!PLAN_IMG) { g.fillText(`${Math.round(W * 100) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), x, y - 9);
    [x, y] = proj(V(-DIM, 0, D / 2)); g.save(); g.translate(x - 9, y); g.rotate(-Math.PI / 2); g.fillText(`${Math.round(D * 100) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ','), 0, 0); g.restore(); }
    // 도면 틀 · 표제란 · 방위
    g.lineWidth = 1; g.strokeRect(18.5, 18.5, w - 37, h - 37);
    const bw = 230, bh = 64, bx = w - 18 - bw, by = h - 18 - bh; g.strokeRect(bx + 0.5, by + 0.5, bw, bh); g.beginPath(); g.moveTo(bx + 0.5, by + 34.5); g.lineTo(bx + bw, by + 34.5); g.stroke();
    g.textAlign = 'left'; g.font = '600 13px Pretendard'; g.fillText('2룸 아파트 · 평면도', bx + 12, by + 18); g.font = '400 11px Pretendard'; g.fillStyle = subHex; g.fillText(`${S.rooms.reduce((n, r) => n + r.area, 0).toFixed(1)}㎡ · 단위 mm`, bx + 12, by + 49);
    const nx = 52, ny = h - 60; g.strokeStyle = inkHex; g.beginPath(); g.arc(nx, ny, 14, 0, Math.PI * 2); g.stroke(); g.fillStyle = inkHex; g.beginPath(); g.moveTo(nx, ny - 12); g.lineTo(nx + 5, ny + 4); g.lineTo(nx, ny); g.lineTo(nx - 5, ny + 4); g.fill(); g.textAlign = 'center'; g.font = '600 10px Pretendard'; g.fillText('N', nx, ny - 22);
  }
  for (const st of STOPS) roomPanel(st, P, w, h);
  endCard(P, w, h); // 걷는 동안: 방에 들어서면 왼쪽 위에 방 정보가 떠오른다
  g.globalAlpha = 1;
}
// 방 정보(왼쪽 위 빈 곳): 번호 · 이름 · 면적(㎡·평) · 크기 · 마감. 들어설 때 줄마다 차례로 떠오르고, 나갈 때 위로 사라진다
const ROOM_INFO = {
  '현관': '포세린 타일 바닥 · 천장까지 닿는 신발장',
  '주방및식당': '수제 유약 타일 벽 · 둥근 식탁 · 빨간 펜던트',
  '거실': '넓은 판 오크 마루 · 노란 아치 벽 · 부클레 소파',
  '발코니': '곡면 유리 · 라운지 의자 · 늦은 오후 햇살',
  '침실1': '세이지 그린 벽 · 린넨 침구',
  '침실2': '흰 책상 · 칸 책장',
  '욕실': '돌결 포세린 타일 · 샤워부스',
};
const STOPS = [{ room: '현관', in: 0.6 * K, out: 0.765 * K }, { room: '주방및식당', in: 0.795 * K, out: 0.41 }, { room: '거실', in: 0.445, out: 0.525 }, { room: '발코니', in: 0.545, out: 0.615 },
  { room: '침실1', in: 0.712, out: 0.792 }, { room: '욕실', in: 0.82, out: 0.862 }, { room: '침실2', in: 0.90, out: 9 }]; // 진행도 P
const TOTAL = 7;
function roomPanel(st, p, w, h) {
  const r = named.find(q => q.name === st.room); if (!r) return;
  const sc = st.in < K ? K : 0.36, k = smooth(st.in, st.in + 0.05 * sc, p), o = smooth(st.out - 0.025 * sc, st.out, p); if (k <= 0.001 || o >= 0.999) return; // 시간 폭은 체크포인트 1과 같게
  const xs = r.rects.flatMap(q => [q[0], q[2]]), zs = r.rects.flatMap(q => [q[1], q[3]]), mm = v => `${Math.round(v * 100) * 10}`.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const area = r.stated ?? r.area, idx = STOPS.indexOf(st) + 1;
  const lines = [
    { t: `${String(idx).padStart(2, '0')} / ${String(TOTAL).padStart(2, '0')}`, f: '500 12px Pretendard', c: '#8A7F70', dy: 0, ls: 0.18 },
    { t: NAME[r.name] ?? r.name, f: '600 44px Pretendard', c: inkHex, dy: 30, ls: -0.01 },
    { t: `${area.toFixed(1)}㎡  ·  ${(area / 3.3058).toFixed(1)}평  ·  ${mm(Math.max(...xs) - Math.min(...xs))} × ${mm(Math.max(...zs) - Math.min(...zs))} mm`, f: '500 14px Pretendard', c: '#3A3631', dy: 82, ls: 0.01 },
    { t: ROOM_INFO[r.name] ?? '', f: '500 14px Pretendard', c: '#3A3631', dy: 106, ls: 0.01 },
  ];
  const X = 56, Y = 64;
  // 읽히게: 왼쪽 위에서 번지는 옅은 종이빛
  const gr = g.createRadialGradient(X - 20, Y - 20, 10, X - 20, Y - 20, 520); gr.addColorStop(0, `rgba(250,247,240,${0.95 * k * (1 - o)})`); gr.addColorStop(0.55, `rgba(250,247,240,${0.8 * k * (1 - o)})`); gr.addColorStop(1, 'rgba(250,247,240,0)');
  g.globalAlpha = 1; g.fillStyle = gr; g.fillRect(0, 0, w, h); // 반지름보다 작은 사각형에만 칠하면 그 끝에서 빛이 끊겨 선처럼 보였다
  { // 글자 뒤 크림 카드: 밝은 유리·하늘 앞(발코니)에서도 읽히게
    g.font = '500 14px Pretendard'; const cw = Math.max(...lines.slice(2).map(L => g.measureText(L.t).width)) + 36;
    g.globalAlpha = 0.86 * k * (1 - o); g.fillStyle = '#FAF7F0'; g.beginPath(); g.roundRect(X - 18, Y - 16, Math.max(cw, 260), 148, 10); g.fill(); }
  g.textAlign = 'left'; g.textBaseline = 'top';
  lines.forEach((L, i) => {
    const ki = smooth(st.in + i * 0.008 * sc, st.in + (i * 0.008 + 0.035) * sc, p), e = 1 - Math.pow(1 - ki, 3); // 줄마다 조금씩 늦게
    g.globalAlpha = e * (1 - o); g.fillStyle = L.c; g.font = L.f; g.letterSpacing = `${L.ls}em`;
    g.fillText(L.t, X, Y + L.dy + (1 - e) * 18 - o * 12);
    if (i === 0) { g.strokeStyle = L.c; g.lineWidth = 1; g.beginPath(); g.moveTo(X + 74, Y + 7.5); g.lineTo(X + 74 + 46 * e, Y + 7.5); g.stroke(); }
  });
  g.letterSpacing = '0px';
}

// 끝: 오른쪽 위 안내 — 실사 버전 투어(real/) 또는 여기서 직접 걷기(버튼은 같은 자리에 겹친 진짜 버튼)
const CTA = { w: 268, h: 52, gap: 12 };
function endCard(P, w, h) {
  const k = smooth(0.962, 0.99, P); if (k <= 0.001 || WALK.on) return;
  const e = 1 - Math.pow(1 - k, 3), X = w - 56 - CTA.w, Y = 148 + (1 - e) * 16, Y2 = Y + CTA.h + CTA.gap; // 오른쪽 위(빈 벽 쪽): 아래에 두면 책장과 맞닿았다
  g.globalAlpha = e; g.textAlign = 'left'; g.textBaseline = 'top';
  g.fillStyle = '#8A7F70'; g.font = '500 12px Pretendard'; g.letterSpacing = '0.18em'; g.fillText('THE END OF THE TOUR', X, Y - 58); g.letterSpacing = '0px';
  g.fillStyle = inkHex; g.font = '600 26px Pretendard'; g.fillText('이제 직접 걸어 보세요', X, Y - 38);
  g.fillStyle = '#1D1C1A'; g.beginPath(); g.roundRect(X, Y, CTA.w, CTA.h, 26); g.fill();
  g.fillStyle = 'rgba(250,247,240,0.92)'; g.strokeStyle = '#1D1C1A'; g.lineWidth = 1.5; g.beginPath(); g.roundRect(X + 0.75, Y2 + 0.75, CTA.w - 1.5, CTA.h - 1.5, 26); g.fill(); g.stroke(); g.lineWidth = 1;
  g.font = '600 15px Pretendard'; g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = '#F3F0E8'; g.fillText('실사 버전으로 투어하기  →', X + CTA.w / 2, Y + CTA.h / 2 + 1);
  g.fillStyle = '#1D1C1A'; g.fillText('직접 걸어 보기  →', X + CTA.w / 2, Y2 + CTA.h / 2 + 1);
  CTA.x = X; CTA.y = Y; CTA.y2 = Y2; CTA.alpha = e;
}

// ---- 직접 걸어 보기: 끌기 = 둘러보기 · 방향키/WASD = 걷기(Shift 빠르게) · 바닥 클릭 = 그 자리로. 카메라 칸(camNav) 밖으로는 못 나간다 ----
const WALK = { on: false, yaw: 0, pitch: 0, keys: new Set(), path: null, last: 0 };
const camNav = new Nav(S.camNav), walkNav = new Nav(S.nav, S.openings.filter(o => o.type === 'door' || (o.type === 'open' && Math.hypot(o.b[0] - o.a[0], o.b[1] - o.a[1]) < 1.2)));
const EYE = 1.56;
function walkEnter() {
  WALK.on = true; const d = new THREE.Vector3(); camera.getWorldDirection(d);
  WALK.yaw = Math.atan2(d.x, d.z); WALK.pitch = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1)); WALK.path = null;
  camera.fov = 66; camera.near = 0.05; camera.far = 600; camera.updateProjectionMatrix(); camera.position.y = EYE;
  { // 벽에 붙은 자리에서 시작하지 않게: 지금 방 가운데 쪽으로 반걸음 들어서고(걸을 수 있는 칸에서), 방 안쪽을 보며 시작
    const P0 = camera.position, here = named.find(r => r.rects.some(q => P0.x >= q[0] - 0.1 && P0.x <= q[2] + 0.1 && P0.z >= q[1] - 0.1 && P0.z <= q[3] + 0.1));
    if (here) { const xs = here.rects.flatMap(q => [q[0], q[2]]), zs = here.rects.flatMap(q => [q[1], q[3]]), cx = (Math.min(...xs) + Math.max(...xs)) / 2, cz = (Math.min(...zs) + Math.max(...zs)) / 2, nx = P0.x + (cx - P0.x) * 0.5, nz = P0.z + (cz - P0.z) * 0.5; if (camNav.walkable(nx, nz)) { P0.x = nx; P0.z = nz; } WALK.yaw = Math.atan2(cx - P0.x, cz - P0.z) || WALK.yaw; WALK.pitch = -0.12; }
  }
  document.body.classList.add('walking'); window.__lenis?.stop();
}
function walkExit() { WALK.on = false; document.body.classList.remove('walking'); window.__lenis?.start(); window.__lenis?.scrollTo(0, { immediate: false, duration: 2.4 }); }
function walkStep(dt) {
  const k = WALK.keys, fwd = (k.has('w') || k.has('arrowup') ? 1 : 0) - (k.has('s') || k.has('arrowdown') ? 1 : 0);
  const side = (k.has('d') ? 1 : 0) - (k.has('a') ? 1 : 0), turn = (k.has('arrowleft') ? 1 : 0) - (k.has('arrowright') ? 1 : 0);
  WALK.yaw += turn * 1.6 * dt;
  const sp = (k.has('shift') ? 2.6 : 1.3) * dt, fx = Math.sin(WALK.yaw), fz = Math.cos(WALK.yaw);
  let mx = (fx * fwd - fz * side) * sp, mz = (fz * fwd + fx * side) * sp;
  if (mx || mz) WALK.path = null;
  else if (WALK.path?.length) { // 바닥 클릭으로 가는 중
    const [tx, tz] = WALK.path[0], dx = tx - camera.position.x, dz = tz - camera.position.z, L = Math.hypot(dx, dz);
    if (L < 0.08) WALK.path.shift(); else { const st = Math.min(L, 1.3 * dt); mx = dx / L * st; mz = dz / L * st; const want = Math.atan2(dx, dz); let dy = want - WALK.yaw; while (dy > Math.PI) dy -= 2 * Math.PI; while (dy < -Math.PI) dy += 2 * Math.PI; WALK.yaw += dy * Math.min(1, 4 * dt); WALK.pitch += (-0.1 - WALK.pitch) * Math.min(1, 2 * dt); } // 걸어가는 동안 시선은 눈높이로
  }
  const P0 = camera.position, ok = (x, z) => { if (!camNav.walkable(x, z)) return false; const L = Math.hypot(mx, mz) || 1; return camNav.walkable(x + mx / L * 0.22, z + mz / L * 0.22); }; // 가는 쪽 22cm 앞도 비어 있어야(벽에 코를 박지 않게)
  if (ok(P0.x + mx, P0.z + mz)) { P0.x += mx; P0.z += mz; } else if (ok(P0.x + mx, P0.z)) P0.x += mx; else if (ok(P0.x, P0.z + mz)) P0.z += mz; // 벽에 닿으면 미끄러진다
  P0.y = EYE; const cp = Math.cos(WALK.pitch);
  camera.up.set(0, 1, 0); camera.lookAt(P0.x + Math.sin(WALK.yaw) * cp, P0.y + Math.sin(WALK.pitch), P0.z + Math.cos(WALK.yaw) * cp);
}
function walkFrame(dt) {
  walkStep(dt);
  for (const k in prog) prog[k] = 1; slots.forEach((s, i) => { U.uProg.value[i] = 1; }); U.uOut.value = 1;
  house.group.scale.y = 1; clip.constant = 1e4; caps.visible = false; house.ceilings.visible = true; for (const m of extCeil) m.visible = true;
  ext.group.visible = true; for (const s of sky) s.visible = true; post.ao.blendIntensity = 0.8; post.bloom.enabled = true; ext.update?.(camera);
  post.render(dt);
  const w = ink.clientWidth, h = ink.clientHeight; g.setTransform(ink.width / w, 0, 0, ink.width / w, 0, 0); g.clearRect(0, 0, w, h);
  const here = named.find(r => r.rects.some(q => camera.position.x >= q[0] - 0.1 && camera.position.x <= q[2] + 0.1 && camera.position.z >= q[1] - 0.1 && camera.position.z <= q[3] + 0.1));
  g.globalAlpha = 1; g.textAlign = 'left'; g.textBaseline = 'top';
  if (here) { const a = here.stated ?? here.area; g.fillStyle = inkHex; g.font = '600 30px Pretendard'; g.fillText(NAME[here.name] ?? here.name, 56, 60); g.fillStyle = '#4A453E'; g.font = '400 14px Pretendard'; g.fillText(`${a.toFixed(1)}㎡ · ${(a / 3.3058).toFixed(1)}평`, 56, 100); g.fillStyle = '#7A7064'; g.fillText(ROOM_INFO[here.name] ?? '', 56, 122); }
}
function walkClick(ev) { // 바닥을 누르면 그 자리까지 길을 찾아 걸어간다
  const r = R.domElement.getBoundingClientRect(), m = new THREE.Vector2((ev.clientX - r.left) / r.width * 2 - 1, -((ev.clientY - r.top) / r.height) * 2 + 1);
  const rc = new THREE.Raycaster(); rc.setFromCamera(m, camera); const hit = rc.intersectObjects(house.floors, false)[0]; if (!hit) return;
  const path = walkNav.find(camera.position.x, camera.position.z, hit.point.x, hit.point.z); if (!path) return;
  WALK.path = path.slice(1).map(([x, z]) => camNav.nearest(x, z, 6) ?? [x, z]);
}

// 바닥 잉크선(이 영상의 표지): 처음 평면도의 선이 3D 방 안으로 이어진다 — 방에 들어설 때 그 방 바닥 둘레가 잉크로 한 변씩 그려지고
// 재질이 다 칠해지면 옅어진다. 3D 장면 안의 선이라 가구 뒤로는 가려진다(2D로 겹쳐 그렸더니 소파 위를 가로질렀다)
const dimLines = STOPS.map(st => {
  const r = named.find(q => q.name === st.room); if (!r) return null;
  const xs = r.rects.flatMap(q => [q[0], q[2]]), zs = r.rects.flatMap(q => [q[1], q[3]]), x0 = Math.min(...xs) + 0.05, x1 = Math.max(...xs) - 0.05, z0 = Math.min(...zs) + 0.05, z1 = Math.max(...zs) - 0.05, y = 0.014;
  const pts = []; const seg = (a, b) => { for (let i = 0; i < 40; i++) pts.push(a.clone().lerp(b, i / 40)); };
  seg(V(x0, y, z0), V(x1, y, z0)); seg(V(x1, y, z0), V(x1, y, z1)); seg(V(x1, y, z1), V(x0, y, z1)); seg(V(x0, y, z1), V(x0, y, z0)); pts.push(V(x0, y, z0));
  const m = new THREE.LineBasicMaterial({ color: INK, transparent: true, opacity: 0, depthWrite: false });
  const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), m); l.renderOrder = 2; l.raycast = () => {}; l.visible = false; scene.add(l);
  return { st, l, n: pts.length };
});
function dimFrame(P) {
  for (const d of dimLines) { if (!d) continue;
    const sc = d.st.in < K ? K : 0.36, k = smooth(d.st.in - 0.03 * sc, d.st.in + 0.07 * sc, P), o = smooth(d.st.in + 0.12 * sc, d.st.in + 0.2 * sc, P);
    d.l.visible = k > 0.001 && o < 0.999; d.l.material.opacity = 0.9 * (1 - o); d.l.geometry.setDrawRange(0, Math.max(2, Math.round(d.n * ease(k))));
  }
}

// ---- 한 장면 ----
const VIEWS = { living: { pos: [4.35, 1.45, 2.2], look: [2.7, 0.7, 0.55], fov: 62 }, shelf: { pos: [2.6, 1.4, 1.0], look: [3.6, 0.55, 2.2], fov: 62 },
  dining: { pos: [7.75, 1.5, 2.55], look: [6.6, 0.85, 1.35], fov: 64 }, study: { pos: [8.25, 1.45, 3.65], look: [7.0, 0.75, 4.9], fov: 64 },
  bath: { pos: [5.1, 1.55, 3.75], look: [5.95, 0.85, 4.55], fov: 70 }, balcony: { pos: [1.7, 1.45, 2.7], look: [0.5, 0.45, 1.75], fov: 62 } };
const VIEW = (() => { const v = Q.get('view'); if (!v) return null; const n = v.split(',').map(Number); if (n.length >= 6 && n.every(Number.isFinite)) { VIEWS._ = { pos: n.slice(0, 3), look: n.slice(3, 6), fov: n[6] ?? 62 }; return '_'; } return v; })(); // 확인용: ?view=living|shelf|dining|study|bath|balcony 또는 ?view=x,y,z,보는x,y,z[,화각] → 다 드러난 방을 고정 자리에서
function frame(p) {
  if (VIEW && VIEWS[VIEW]) {
    const v = VIEWS[VIEW]; frame0(1); camera.position.set(...v.pos); camera.up.set(0, 1, 0); camera.fov = v.fov; camera.near = 0.05; camera.far = 600; camera.updateProjectionMatrix(); camera.lookAt(...v.look);
    for (const k in prog) prog[k] = 1; slots.forEach((s, i) => { U.uProg.value[i] = 1; }); U.uOut.value = 1; house.ceilings.visible = true; for (const s of sky) s.visible = true;
    post.render(1 / 60); g.setTransform(1, 0, 0, 1, 0, 0); g.clearRect(0, 0, ink.width, ink.height); return;
  }
  frame0(p);
  post.render(1 / 60);
  drawInk(p);
}
const pOld = P => Math.min(1, P / K);
function frame0(P) {
  cameraAt(P); const p = Math.min(1, P / K); dimFrame(P);
  const camLow = camera.position.y < H + 0.15;
  // 벽 세우기: 집(벽·문틀·인방·창·문짝)을 1.2m 높이에서 천장 높이까지 늘려 올린다. 자르는 방식은 문·창 위 인방이 끝에야 나타나
  // 벽 윗선이 비었다가 생기는 것처럼 보였다. 가구는 늘리지 않고, 벽 꼭대기에서만 자른다
  const top = H + 0.03, rise = p < 0.37 ? lerp(1.2 / top, 1, ease(smooth(0.13, 0.35, p))) : 1;
  house.group.scale.y = rise; clip.constant = rise < 1 ? rise * top + 0.004 : 1e4;
  caps.visible = rise < 0.999; caps.position.y = rise * top + 0.002;
  house.ceilings.visible = p > 0.45 && camLow; for (const m of extCeil) m.visible = camLow;
  ext.group.visible = p > 0.42; for (const s of sky) s.visible = camLow; scene.background.copy(PAPER);
  U.uOut.value = smooth(0.47, 0.55, p); U.uPlanOn.value = 0; // 바닥 평면도 그림은 글자가 비스듬히 뭉개져 깨져 보였다(검수 4회차) → 대신 모눈                                                   // 바깥(복도)은 내려오면서
  prog['현관'] = smooth(0.6, 0.71, p); prog['주방및식당'] = smooth(0.79, 0.93, p);        // 방은 카메라가 닿을 때
  prog['거실'] = smooth(0.41, 0.465, P); prog['발코니'] = smooth(0.505, 0.55, P); prog['침실1'] = smooth(0.672, 0.735, P);
  prog['욕실'] = smooth(0.79, 0.835, P); prog['침실2'] = smooth(0.862, 0.915, P); // 문 가까운 칸은 카메라가 문에 닿기 전에 끝나게(가까이서 큰 칸이 번쩍였다)
  slots.forEach((s, i) => { U.uProg.value[i] = prog[s.owner] ?? 0; });
  planLine.opacity = 1 - smooth(0.06, 0.16, p); planOnly.visible = !PLAN_IMG && planLine.opacity > 0.01;
  post.ao.blendIntensity = lerp(0, 0.8, smooth(0.15, 0.6, p)); post.bloom.enabled = p > 0.55;
  ext.update?.(camera);
}

function resize() {
  const w = REC ? 1280 : innerWidth, h = REC ? 720 : innerHeight;
  R.setSize(w, h, false); camera.aspect = w / h; planFrame(w / h);
  const dpr = R.getPixelRatio(); ink.width = w * dpr; ink.height = h * dpr; ink.style.width = w + 'px'; ink.style.height = h + 'px';
  if (REC) { R.domElement.style.width = w + 'px'; R.domElement.style.height = h + 'px'; }
  post.setSize(w, h, dpr);
}
resize(); addEventListener('resize', resize);
await document.fonts.ready;
frame(0); frame(0); // 셰이더를 미리 만든다
loadShow(1);
document.getElementById('load').classList.add('done');

if (REC && Q.get('walk')) { // 걷기 모드 확인 녹화(?record=N&walk=1): 끝 장면에서 걷기로 들어가 정해 둔 조작을 재생한다
  const N = +REC, out = document.createElement('canvas'); out.width = 1280; out.height = 720; const og = out.getContext('2d');
  frame(1); walkEnter(); const at = i => i / 30, dn = k => WALK.keys.add(k), upk = k => WALK.keys.delete(k);
  const toFloor = (x, z) => { const v = V(x, 0, z).project(camera), r = R.domElement.getBoundingClientRect(); return { clientX: r.left + (v.x + 1) / 2 * r.width, clientY: r.top + (1 - v.y) / 2 * r.height }; };
  for (let i = 0; i < N; i++) {
    const t = at(i);
    if (t >= 0.5 && t < 2.2) dn('arrowleft'); else upk('arrowleft');            // 왼쪽으로 돌아 문 쪽을 본다
    if (t >= 2.4 && t < 3.6) dn('w'); else upk('w');                             // 몇 걸음 앞으로
    if (Math.abs(t - 4.0) < 1e-6 || (i === Math.round(4.0 * 30))) { WALK.path = walkNav.find(camera.position.x, camera.position.z, 3.2, 1.3)?.slice(1).map(([x, z]) => camNav.nearest(x, z, 6) ?? [x, z]) ?? null; } // 거실 바닥을 누른 것과 같다
    walkFrame(1 / 30);
    og.drawImage(R.domElement, 0, 0, 1280, 720); og.drawImage(ink, 0, 0, 1280, 720);
    await fetch(`__frame?i=${i}`, { method: 'POST', body: out.toDataURL('image/jpeg', 0.9) });
  }
  await fetch('__done', { method: 'POST', body: '{}' });
} else if (REC) { // 녹화: 프레임마다 3D + 잉크를 합쳐 서버로 보낸다(record.py가 mp4로 묶는다)
  const N = +REC, out = document.createElement('canvas'); out.width = 1280; out.height = 720; const og = out.getContext('2d');
  for (let i = 0; i < N; i++) {
    const p = Q.get('p') != null ? +Q.get('p') : i / Math.max(1, N - 1); frame(p); // ?p= → 그 지점 한 장(확인용)
    og.drawImage(R.domElement, 0, 0, 1280, 720); og.drawImage(ink, 0, 0, 1280, 720);
    await fetch(`__frame?i=${i}`, { method: 'POST', body: out.toDataURL('image/jpeg', 0.9) });
  }
  await fetch('__done', { method: 'POST', body: '{}' });
} else {
  const lenis = new window.Lenis({ lerp: 0.09, smoothWheel: true });
  lenis.on('scroll', ScrollTrigger.update); gsap.ticker.add(t => lenis.raf(t * 1000)); gsap.ticker.lagSmoothing(0);
  let target = 0, shown = 0;
  ScrollTrigger.create({ trigger: '#track', start: 'top top', end: 'bottom bottom', onUpdate: s => { target = s.progress; } });
  if (location.hash === '#end') { history.scrollRestoration = 'manual'; lenis.scrollTo(document.documentElement.scrollHeight, { immediate: true }); target = shown = 1; } // 실사 투어에서 돌아올 때: 끝 장면에서 바로
  const fix = Q.get('p'); // 확인용: ?p=0.5 → 그 지점에서 멈춘 장면
  window.__lenis = lenis;
  const btn = document.getElementById('walk'), real = document.getElementById('real'), back = document.getElementById('back');
  btn.addEventListener('click', walkEnter); back.addEventListener('click', walkExit);
  addEventListener('keydown', e => { if (!WALK.on) return; const k = e.key.toLowerCase(); WALK.keys.add(k === 'shift' ? 'shift' : k); if (k.startsWith('arrow') || k === ' ') e.preventDefault(); if (k === 'escape') walkExit(); });
  addEventListener('keyup', e => { WALK.keys.delete(e.key.toLowerCase()); });
  let drag = null;
  R.domElement.addEventListener('pointerdown', e => { if (!WALK.on) return; drag = { x: e.clientX, y: e.clientY, moved: 0 }; R.domElement.setPointerCapture(e.pointerId); });
  R.domElement.addEventListener('pointermove', e => { if (!drag) return; const dx = e.clientX - drag.x, dy = e.clientY - drag.y; drag.moved += Math.abs(dx) + Math.abs(dy); drag.x = e.clientX; drag.y = e.clientY;
    WALK.yaw -= dx * 0.0042; WALK.pitch = THREE.MathUtils.clamp(WALK.pitch - dy * 0.0036, -1.1, 0.9); WALK.path = null; });
  R.domElement.addEventListener('pointerup', e => { if (drag && drag.moved < 6) walkClick(e); drag = null; });
  addEventListener('wheel', e => { if (WALK.on) e.preventDefault(); }, { passive: false });
  let tPrev = performance.now();
  R.setAnimationLoop(() => {
    const now = performance.now(), dt = Math.min(0.05, (now - tPrev) / 1000); tPrev = now;
    if (WALK.on) { walkFrame(dt); return; }
    if (fix != null) { frame(+fix); return; } shown += (target - shown) * 0.12; if (Math.abs(target - shown) < 1e-4) shown = target; frame(shown);
    const on = shown > 0.975 && CTA.x != null; btn.style.display = real.style.display = on ? 'block' : 'none';
    if (on) { Object.assign(real.style, { left: CTA.x + 'px', top: CTA.y + 'px', width: CTA.w + 'px', height: CTA.h + 'px' });
      Object.assign(btn.style, { left: CTA.x + 'px', top: CTA.y2 + 'px', width: CTA.w + 'px', height: CTA.h + 'px' }); }
  });
  window.__frame = frame; window.__walk = { enter: walkEnter, exit: walkExit, W: WALK, click: walkClick, cam: camera };
}
