// 사진 위 3D 층: 사진과 같은 시점의 카메라(지평선 v0·카메라 높이·초점)를 맞추고 Hana 사진 판을 3D 바닥에 세운다.
// - 크기·위치는 원근 투영으로 정해진다(멀어지면 작아지고 지평선 쪽으로 올라간다).
// - 햇빛 방향으로 바닥에 드리우는 그림자(발에서 멀수록 흐려짐) + 발밑 접지 그림자.
// - 사진 깊이 지도(Depth Anything V2)를 실제 거리로 맞춰, Hana보다 앞에 있는 가구 픽셀이 Hana·그림자를 가린다.
import * as THREE from 'three';

const PERSON = 1.65;

const OCC = /* glsl */`
uniform sampler2D uDepth; uniform sampler2D uFloor; uniform vec4 uImg; uniform vec2 uView; uniform float uDpr; uniform vec2 uFit; uniform float uHasDepth;
vec2 imgUV() { vec2 px = vec2(gl_FragCoord.x / uDpr, uView.y - gl_FragCoord.y / uDpr); return (px - uImg.xy) / uImg.zw; }
float depthAt(vec2 uv) { return texture2D(uDepth, vec2(uv.x, 1.0 - uv.y)).r; }
float floorAt(float v) { return texture2D(uFloor, vec2(clamp(v, 0.0, 1.0), 0.5)).r; }
// 0.45m 앞뒤에 해당하는 깊이 값 차이(가까울수록 크다)
float marginD(float dref) { float x = max(dref - uFit.y, 0.02); return max(0.012, x * x * 0.45 / uFit.x); }
// 사람 판: 발밑 바닥 깊이(dref)보다 확실히 가까운 사진 픽셀(앞 가구)이면 가린다
float bodyVis(float dref) {
  if (uHasDepth < 0.5) return 1.0;
  float m = marginD(dref);
  return 1.0 - smoothstep(dref + 0.6 * m, dref + 1.5 * m, depthAt(imgUV()));
}
// 그림자: 그 자리 사진이 바닥일 때만 드리운다
float floorVis() {
  if (uHasDepth < 0.5) return 1.0;
  vec2 uv = imgUV(); float f = floorAt(uv.y), m = marginD(f);
  return 1.0 - smoothstep(f + 0.5 * m, f + 1.3 * m, depthAt(uv));
}`;
const VERT = /* glsl */`
varying vec2 vUv; varying float vViewZ;
void main() { vUv = uv; vec4 mv = modelViewMatrix * vec4(position, 1.0); vViewZ = -mv.z; gl_Position = projectionMatrix * mv; }`;

export class PhotoGL {
  constructor(canvas, focal) {
    this.F = focal;
    this.r = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true, premultipliedAlpha: false });
    this.r.setClearColor(0x000000, 0);
    this.scene = new THREE.Scene();
    this.cam = new THREE.Camera();
    this.tex = new Map();
    this.shared = {
      uDepth: { value: null }, uImg: { value: new THREE.Vector4() }, uView: { value: new THREE.Vector2() },
      uDpr: { value: 1 }, uFit: { value: new THREE.Vector2(1, 0) }, uHasDepth: { value: 0 }, uFloor: { value: null },
    };
    this.figs = [this.makeFigure(), this.makeFigure()];
    this.sun = { dir: new THREE.Vector3(0, 0, 1), len: 1, opacity: 0.3 };
  }
  makeFigure() {
    const S = this.shared;
    const common = { uMap: { value: null }, uOff: { value: new THREE.Vector2() }, uRep: { value: new THREE.Vector2(1, 1) }, uMirror: { value: 0 }, uAlpha: { value: 1 } };
    // 사진 판
    const body = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).translate(0, 0.5, 0), new THREE.ShaderMaterial({
      uniforms: { ...S, ...common, uTint: { value: new THREE.Color(1, 1, 1) }, uDRef: { value: 0 } },
      vertexShader: VERT, transparent: true, depthWrite: false, depthTest: false,
      fragmentShader: /* glsl */`${OCC}
        uniform sampler2D uMap; uniform vec2 uOff, uRep; uniform float uMirror, uAlpha, uDRef; uniform vec3 uTint;
        varying vec2 vUv; varying float vViewZ;
        void main() {
          vec2 uv = vec2(uMirror > 0.5 ? 1.0 - vUv.x : vUv.x, vUv.y);
          vec4 c = texture2D(uMap, uOff + uv * uRep);
          float a = c.a * uAlpha * bodyVis(uDRef);
          if (a < 0.004) discard;
          // 바닥 가까운 발 부분은 조금 어둡게(바닥 반사광이 덜 닿는다)
          float ao = mix(0.82, 1.0, smoothstep(0.0, 0.07, vUv.y));
          gl_FragColor = vec4(c.rgb * uTint * ao, a);
        }`,
    }));
    body.renderOrder = 3;
    // 햇빛 그림자: 바닥에 눕힌 사각형에 실루엣을 늘여 그린다(발에서 멀수록 흐리고 옅게)
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(12), 3));
    sg.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 1, 1]), 2));
    sg.setIndex([0, 1, 2, 2, 1, 3]);
    const shadow = new THREE.Mesh(sg, new THREE.ShaderMaterial({
      uniforms: { ...S, ...common, uOpacity: { value: 0.3 } },
      vertexShader: VERT, transparent: true, depthWrite: false, depthTest: false, side: THREE.DoubleSide,
      fragmentShader: /* glsl */`${OCC}
        uniform sampler2D uMap; uniform vec2 uOff, uRep; uniform float uMirror, uAlpha, uOpacity;
        varying vec2 vUv; varying float vViewZ;
        float sil(vec2 uv) { uv = clamp(uv, 0.0, 1.0); uv.x = uMirror > 0.5 ? 1.0 - uv.x : uv.x; return texture2D(uMap, uOff + uv * uRep).a; }
        void main() {
          float t = vUv.y;
          float r = mix(0.004, 0.05, t);
          float a = 0.0;
          for (int i = 0; i < 12; i++) { float ang = float(i) * 2.39996; float rr = r * sqrt((float(i) + 0.5) / 12.0); a += sil(vUv + vec2(cos(ang), sin(ang)) * rr * vec2(1.0, 0.55)); }
          a /= 12.0;
          a *= uOpacity * uAlpha * (1.0 - 0.55 * t) * floorVis();
          if (a < 0.003) discard;
          gl_FragColor = vec4(0.13, 0.09, 0.06, a);
        }`,
    }));
    shadow.renderOrder = 1; shadow.frustumCulled = false;
    // 발밑 접지 그림자
    const contact = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), new THREE.ShaderMaterial({
      uniforms: { ...S, uAlpha: { value: 1 }, uOpacity: { value: 0.5 } },
      vertexShader: VERT, transparent: true, depthWrite: false, depthTest: false,
      fragmentShader: /* glsl */`${OCC}
        uniform float uAlpha, uOpacity; varying vec2 vUv; varying float vViewZ;
        void main() {
          float d = length((vUv - 0.5) * 2.0);
          float a = pow(clamp(1.0 - d, 0.0, 1.0), 1.8) * uOpacity * uAlpha * floorVis();
          if (a < 0.003) discard;
          gl_FragColor = vec4(0.10, 0.07, 0.05, a);
        }`,
    }));
    contact.renderOrder = 2;
    for (const m of [shadow, contact, body]) { m.visible = false; this.scene.add(m); }
    return { body, shadow, contact };
  }
  texFor(key, img) {
    let t = this.tex.get(key);
    if (!t) { t = new THREE.Texture(img); t.colorSpace = THREE.NoColorSpace; t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter; t.needsUpdate = true; this.tex.set(key, t); }
    return t;
  }
  setScene(sc, depthImg) {
    this.sc = sc;
    const S = this.shared;
    if (S.uDepth.value) S.uDepth.value.dispose();
    if (depthImg && sc.depthFit) {
      const t = new THREE.Texture(depthImg); t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter; t.generateMipmaps = false; t.needsUpdate = true;
      S.uDepth.value = t; S.uFit.value.set(sc.depthFit[0], sc.depthFit[1]); S.uHasDepth.value = 1;
      this.floorD = floorProfile(sc, depthImg, this.F);
      const data = new Uint8Array(this.floorD.length * 4);
      this.floorD.forEach((d, i) => { data[i * 4] = Math.round(d * 255); data[i * 4 + 3] = 255; });
      if (S.uFloor.value) S.uFloor.value.dispose();
      const ft = new THREE.DataTexture(data, this.floorD.length, 1, THREE.RGBAFormat, THREE.UnsignedByteType);
      ft.minFilter = ft.magFilter = THREE.LinearFilter; ft.needsUpdate = true; S.uFloor.value = ft;
    } else { S.uDepth.value = null; S.uHasDepth.value = 0; this.floorD = null; }
    const [az, el, op] = sc.sun ?? [180, 50, 0.25];
    const a = az * Math.PI / 180;
    this.sun = { dir: new THREE.Vector3(-Math.sin(a), 0, Math.cos(a)), len: 1 / Math.tan(el * Math.PI / 180), opacity: op };
    this.hc = PERSON / sc.camera.k; this.v0 = sc.camera.v0;
  }
  // 사진 좌표(u, v = 발 위치) → 3D 바닥 좌표
  world(u, v, aspect) {
    const Z = this.F * this.hc / Math.max(0.004, v - this.v0);
    return { x: (u - 0.5) * aspect * Z / this.F, z: -Z, Z };
  }
  resize(W, H, dpr) { this.r.setPixelRatio(dpr); this.r.setSize(W, H, false); this.W = W; this.H = H; this.dpr = dpr; }
  // 화면에 보이는 사진 자리(T)에 정확히 겹치는 투영
  setView(T, aspect) {
    const { W, H } = this, F = this.F, near = 0.05, far = 200;
    const Sx = (2 * T.dw / W) * F / aspect, Cx = 2 * (T.ox + 0.5 * T.dw) / W - 1;
    const Sy = (2 * T.dh / H) * F, Cy = 1 - 2 * (T.oy + this.v0 * T.dh) / H;
    const A = -(far + near) / (far - near), B = -2 * far * near / (far - near);
    this.cam.projectionMatrix.set(Sx, 0, -Cx, 0, 0, Sy, -Cy, 0, 0, 0, A, B, 0, 0, -1, 0);
    this.cam.projectionMatrixInverse.copy(this.cam.projectionMatrix).invert();
    this.cam.matrixWorld.makeTranslation(0, this.hc, 0); this.cam.matrixWorldInverse.copy(this.cam.matrixWorld).invert();
    this.cam.matrixAutoUpdate = false;
    const S = this.shared; S.uImg.value.set(T.ox, T.oy, T.dw, T.dh); S.uView.value.set(W, H); S.uDpr.value = this.dpr;
  }
  // figure: { tex, clip, frame, u, v, mirror, alpha, personH, tint(Color) }
  setFigure(i, f, aspect) {
    const g = this.figs[i];
    if (!f || f.alpha < 0.01) { g.body.visible = g.shadow.visible = g.contact.visible = false; return; }
    const { clip } = f, p = this.world(f.u, f.v, aspect);
    const h = f.personH / clip.personFrac, w = h * clip.w / clip.h;
    const rows = Math.ceil(clip.frames / clip.cols);
    const off = new THREE.Vector2((f.frame % clip.cols) / clip.cols, 1 - (Math.floor(f.frame / clip.cols) + 1) / rows), rep = new THREE.Vector2(1 / clip.cols, 1 / rows);
    for (const m of [g.body, g.shadow]) { const U = m.material.uniforms; U.uMap.value = f.tex; U.uOff.value.copy(off); U.uRep.value.copy(rep); U.uMirror.value = f.mirror ? 1 : 0; U.uAlpha.value = f.alpha; }
    // 판: 카메라를 향해 선다
    g.body.position.set(p.x, -clip.footFrac * h, p.z); g.body.scale.set(w, h, 1);
    g.body.rotation.set(0, Math.atan2(-p.x, -p.z), 0);
    g.body.material.uniforms.uTint.value.copy(f.tint);
    g.body.material.uniforms.uDRef.value = this.floorAt(f.v);
    g.body.updateMatrixWorld(true);
    // 그림자: 판을 햇빛 방향으로 바닥에 눕힌 평행사변형. 밑변 = 판의 밑변(발 선)이라 발과 그림자가 붙는다.
    const d = this.sun.dir, L = h * this.sun.len * (f.seated ? 0.8 : 1);
    const right = new THREE.Vector3(Math.cos(g.body.rotation.y), 0, -Math.sin(g.body.rotation.y));
    const half = w / 2, pos = g.shadow.geometry.attributes.position;
    const P0 = new THREE.Vector3(p.x, 0.004, p.z);
    const put = (k, s, t) => { const q = P0.clone().addScaledVector(right, s * half).addScaledVector(d, t * L); pos.setXYZ(k, q.x, q.y, q.z); };
    put(0, -1, 0); put(1, 1, 0); put(2, -1, 1); put(3, 1, 1);
    pos.needsUpdate = true; g.shadow.geometry.computeBoundingSphere();
    g.shadow.material.uniforms.uOpacity.value = this.sun.opacity;
    g.contact.position.set(p.x, 0.003, p.z); g.contact.scale.set(f.seated ? 0.95 : 0.55, 1, f.seated ? 0.7 : 0.34);
    g.contact.material.uniforms.uAlpha.value = f.alpha; g.contact.material.uniforms.uOpacity.value = 0.5 + this.sun.opacity * 0.5;
    g.body.visible = g.shadow.visible = g.contact.visible = true;
  }
  floorAt(v) { const F = this.floorD; if (!F) return 0; const x = Math.min(F.length - 1, Math.max(0, v * F.length - 0.5)), i = Math.floor(x), t = x - i; return F[i] * (1 - t) + F[Math.min(F.length - 1, i + 1)] * t; }
  render() { this.r.render(this.scene, this.cam); }
}

// 줄(v)마다 사진 깊이 지도의 바닥 값(바닥 다각형 안 중앙값). 바닥이 없는 줄은 이웃 값으로 잇고, 아래로 갈수록 커지게 맞춘다.
function floorProfile(sc, img, focal) {
  const W = 168, H = 95, N = 128;
  const c = document.createElement('canvas'); c.width = W; c.height = H;
  const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, W, H);
  const px = g.getImageData(0, 0, W, H).data;
  const skip = [...(sc.blockers ?? []), ...(sc.occluders ?? []).flatMap(o => o.polys)];
  const rows = new Array(H).fill(null);
  for (let y = 0; y < H; y++) {
    const v = (y + 0.5) / H, vals = [];
    for (let x = 0; x < W; x++) { const u = (x + 0.5) / W; if (inPoly(sc.floor, u, v) && !skip.some(p => inPoly(p, u, v))) vals.push(px[(y * W + x) * 4] / 255); }
    // 카메라 식으로 예상한 바닥 값 근처만 쓴다(같은 줄의 탁자·의자 픽셀 제외)
    const Z = v > sc.camera.v0 + 0.005 ? focal * (1.65 / sc.camera.k) / (v - sc.camera.v0) : 1e4;
    const exp = sc.depthFit[0] / Z + sc.depthFit[1];
    const lo = exp > 0.03 ? exp * 0.6 - 0.02 : 0, hi = exp > 0.03 ? exp * 1.5 + 0.03 : 0.3;
    const ok = vals.filter(d => d >= lo && d <= hi);
    if (ok.length >= 2) { ok.sort((a, b) => a - b); rows[y] = ok[ok.length >> 1]; }
  }
  const first = rows.findIndex(r => r != null); if (first < 0) return null;
  for (let y = 0; y < H; y++) if (rows[y] == null) rows[y] = y < first ? rows[first] : rows[y - 1];
  for (let y = 1; y < H; y++) rows[y] = Math.max(rows[y], rows[y - 1]);
  return Array.from({ length: N }, (_, i) => { const x = ((i + 0.5) / N) * H - 0.5, y = Math.max(0, Math.min(H - 1, Math.floor(x))), t = Math.max(0, Math.min(1, x - y)); return rows[y] * (1 - t) + rows[Math.min(H - 1, y + 1)] * t; });
}
function inPoly(poly, u, v) {
  let c = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) { const [xi, yi] = poly[i], [xj, yj] = poly[j]; if ((yi > v) !== (yj > v) && u < (xj - xi) * (v - yi) / (yj - yi) + xi) c = !c; }
  return c;
}
