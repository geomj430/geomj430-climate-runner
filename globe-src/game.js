'use strict';
(async function () {
const $ = (s) => document.querySelector(s);
const loadMsg = (t) => { const el = $('#loadMsg'); if (el) el.textContent = t; };
const nextFrame = () => new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));

// ---------------------------------------------------------------- 기본 설정
const R = 100;               // 지구 반지름(게임 단위)
const EX = 3.3;              // 고도 과장 (에베레스트 ≈ 3.3단위)
const KM = 6371 / R;         // 1단위 = 약 64 km
const DEG = Math.PI / 180;
const IS_TOUCH = matchMedia('(pointer: coarse)').matches || 'ontouchstart' in window;
const LOW = IS_TOUCH || Math.min(innerWidth, innerHeight) < 600;
if (IS_TOUCH) document.body.classList.add('touch');

// ---------------------------------------------------------------- 저장
const SAVE_KEY = 'globe-explorer-v1';
const blankSave = () => ({ visited: {}, stars: {}, stamps: {}, mission: 0, pos: null, sound: true });
let save = blankSave();
try { const s = JSON.parse(localStorage.getItem(SAVE_KEY) || 'null'); if (s && typeof s === 'object') save = Object.assign(blankSave(), s); } catch (e) {}
let saveTimer = 0;
function persist() { try { localStorage.setItem(SAVE_KEY, JSON.stringify(save)); } catch (e) {} }

// ---------------------------------------------------------------- 세계 데이터 해독
// world.png: R = 고도, G = 쾨펜 기후 번호(0 = 바다), B = 나라 번호
const WW = 1440, WH = 720;
const ELEV = new Uint8Array(WW * WH), KC = new Uint8Array(WW * WH), CT = new Uint8Array(WW * WH);
await new Promise((res, rej) => {
  const img = new Image();
  img.onload = () => {
    const cv = document.createElement('canvas'); cv.width = WW; cv.height = WH;
    const g = cv.getContext('2d', { willReadFrequently: true });
    g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, WW, WH).data;
    for (let i = 0, j = 0; i < WW * WH; i++, j += 4) { ELEV[i] = d[j]; KC[i] = d[j + 1]; CT[i] = d[j + 2]; }
    res();
  };
  img.onerror = rej;
  img.src = WORLD_PNG;
});
const CLASSES = WORLD_META.classes, COUNTRIES = WORLD_META.countries;

const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
const smooth = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };
const wrapX = (x) => { x %= WW; return x < 0 ? x + WW : x; };
const clampY = (y) => (y < 0 ? 0 : y >= WH ? WH - 1 : y);
function cell(lat, lon) { return clampY(Math.floor((90 - lat) * 4)) * WW + wrapX(Math.floor((lon + 180) * 4)); }
// 바이리니어: 육지 비율과 고도
function sampleLE(lat, lon, out) {
  const fy = (90 - lat) * 4 - 0.5, fx = (lon + 180) * 4 - 0.5;
  const y0 = Math.floor(fy), x0 = Math.floor(fx), ty = fy - y0, tx = fx - x0;
  const ya = clampY(y0) * WW, yb = clampY(y0 + 1) * WW, xa = wrapX(x0), xb = wrapX(x0 + 1);
  const i1 = ya + xa, i2 = ya + xb, i3 = yb + xa, i4 = yb + xb;
  const w1 = (1 - tx) * (1 - ty), w2 = tx * (1 - ty), w3 = (1 - tx) * ty, w4 = tx * ty;
  out.land = (KC[i1] ? w1 : 0) + (KC[i2] ? w2 : 0) + (KC[i3] ? w3 : 0) + (KC[i4] ? w4 : 0);
  out.elev = ELEV[i1] * w1 + ELEV[i2] * w2 + ELEV[i3] * w3 + ELEV[i4] * w4;
  return out;
}
const _s = { land: 0, elev: 0 };
function terrainH(lat, lon) {
  sampleLE(lat, lon, _s);
  const s = smooth(0.3, 0.7, _s.land);
  const landH = 0.16 + EX * Math.pow(_s.elev / 248, 0.95);
  return -0.8 + (landH + 0.8) * s;
}
const elevMeters = (lat, lon) => { sampleLE(lat, lon, _s); return _s.land < 0.5 ? 0 : Math.max(0, _s.elev * 25); };
const dirLat = (v) => Math.asin(clamp(v.y, -1, 1)) / DEG;
const dirLon = (v) => Math.atan2(v.x, v.z) / DEG;
function llDir(lat, lon, out) {
  const la = lat * DEG, lo = lon * DEG, c = Math.cos(la);
  return out.set(c * Math.sin(lo), Math.sin(la), c * Math.cos(lo));
}
const hDir = (v) => terrainH(dirLat(v), dirLon(v));

// 값 노이즈
function hash(x, y) { let h = (Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263)) | 0; h = Math.imul(h ^ (h >>> 13), 1274126177); h ^= h >>> 16; return (h >>> 0) / 4294967296; }
function vnoise(x, y) {
  const xi = Math.floor(x), yi = Math.floor(y), tx = x - xi, ty = y - yi;
  const sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
  const a = hash(xi, yi), b = hash(xi + 1, yi), c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
  return (a + (b - a) * sx) + ((c + (d - c) * sx) - (a + (b - a) * sx)) * sy;
}
let rngSeed = 12345;
const rnd = () => { rngSeed = (Math.imul(rngSeed, 1664525) + 1013904223) | 0; return (rngSeed >>> 0) / 4294967296; };

const hex = (h) => { const n = parseInt(h.slice(1), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
const KRGB = CLASSES.map((c) => hex(KOPPEN_COLOR[c] || '#cccccc'));
const kname = (code) => (KOPPEN_INFO[code] ? KOPPEN_INFO[code].ko : code);

// ---------------------------------------------------------------- 지명
function oceanName(lat, lon) {
  const inB = (a, b, c, d) => lat >= a && lat <= b && lon >= c && lon <= d;
  if (lat > 66) return '북극해';
  if (lat < -60) return '남극해';
  if (inB(30, 46, -6, 36.5)) return '지중해';
  if (inB(40.5, 47.5, 27, 42)) return '흑해';
  if (inB(36, 47.5, 46, 55.5)) return '카스피해';
  if (inB(53, 66, 9, 31)) return '발트해';
  if (inB(51, 61.5, -4, 9)) return '북해';
  if (inB(33.5, 52, 127.5, 142.5)) return '동해';
  if (inB(33, 41.5, 117, 127)) return '황해';
  if (inB(24, 33, 119, 131)) return '동중국해';
  if (inB(-1, 24, 99, 121)) return '남중국해';
  if (inB(51, 64.5, -96, -76)) return '허드슨만';
  if (inB(18, 31, -98, -80.5)) return '멕시코만';
  if (inB(9, 22, -88, -60)) return '카리브해';
  if (inB(12, 30, 32, 43.6)) return '홍해';
  if (inB(23.5, 30.5, 47.5, 57)) return '페르시아만';
  if (inB(5, 23, 80, 95)) return '벵골만';
  if (inB(5, 25, 55, 75)) return '아라비아해';
  if (lat < 0) {
    if (lon >= 20 && lon < 147) return '인도양';
    if (lon >= -68 && lon < 20) return '대서양';
    return '태평양';
  }
  const th = lat < 9 ? -78 : lat < 18 ? -84 : lat < 30 ? -98 : -80;
  if (lon > th && lon < 30) return '대서양';
  if (lon >= 30 && lon < 100 && lat < 30) return '인도양';
  return '태평양';
}
const countryKo = (i) => (i ? COUNTRY_KO[COUNTRIES[i - 1]] || COUNTRIES[i - 1] : '');

// ---------------------------------------------------------------- 렌더러
const canvas = $('#c');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, LOW ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight, false);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#1d2a52');
const camera = new THREE.PerspectiveCamera(55, innerWidth / innerHeight, 0.05, 3000);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

const gradTex = (() => {
  const d = new Uint8Array([120, 120, 120, 255, 195, 195, 195, 255, 255, 255, 255, 255]);
  const t = new THREE.DataTexture(d, 3, 1, THREE.RGBAFormat);
  t.minFilter = t.magFilter = THREE.NearestFilter; t.needsUpdate = true; return t;
})();
const matCache = {};
function toon(color) {
  if (!matCache[color]) matCache[color] = new THREE.MeshToonMaterial({ color, gradientMap: gradTex });
  return matCache[color];
}
const outlineMat = (thick) => new THREE.ShaderMaterial({
  uniforms: { thick: { value: thick } },
  vertexShader: 'uniform float thick; void main(){ vec3 p = position + normalize(normal) * thick; gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0); }',
  fragmentShader: 'void main(){ gl_FragColor = vec4(0.17, 0.12, 0.09, 1.0); }',
  side: THREE.BackSide
});
const OUT_S = outlineMat(0.025), OUT_M = outlineMat(0.04);

const amb = new THREE.AmbientLight(0xffffff, 1.15);
const hemi = new THREE.HemisphereLight(0xdff0ff, 0x8a7a60, 0.35);
const sun = new THREE.DirectionalLight(0xfff1dc, 2.1);
scene.add(amb, hemi, sun, sun.target);

// ---------------------------------------------------------------- 텍스처 만들기
await nextFrame();
loadMsg('쾨펜 기후 색을 칠하고 있어요');
try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]); } catch (e) {}

const TW = 2048, TH = 1024;
const SAND = hex('#e8d9a8'), ROCK = hex('#a89a86'), SNOW = [250, 252, 255];
function makeLandCanvas() {
  const cv = document.createElement('canvas'); cv.width = TW; cv.height = TH;
  const g = cv.getContext('2d');
  const im = g.createImageData(TW, TH), d = im.data;
  for (let y = 0; y < TH; y++) {
    const lat = 90 - ((y + 0.5) / TH) * 180;
    const dy = (90 - lat) * 4;
    for (let x = 0; x < TW; x++) {
      const lon = -180 + ((x + 0.5) / TW) * 360;
      const dx = (lon + 180) * 4;
      const ci = clampY(Math.floor(dy)) * WW + wrapX(Math.floor(dx));
      let r, gg, b;
      const k0 = KC[ci];
      if (!k0) { [r, gg, b] = SAND; }
      else {
        const jx = (vnoise(dx * 0.35, dy * 0.35) - 0.5) * 2.4 + (vnoise(dx * 1.3 + 50, dy * 1.3) - 0.5) * 0.9;
        const jy = (vnoise(dx * 0.35 + 91, dy * 0.35 + 17) - 0.5) * 2.4 + (vnoise(dx * 1.3, dy * 1.3 + 77) - 0.5) * 0.9;
        let k = KC[clampY(Math.floor(dy + jy)) * WW + wrapX(Math.floor(dx + jx))] || k0;
        const c = KRGB[k - 1]; r = c[0]; gg = c[1]; b = c[2];
        const e = ELEV[ci] / 248;
        const code = CLASSES[k - 1];
        if (code !== 'EF') {
          const rm = smooth(0.42, 0.75, e) * 0.5;
          r += (ROCK[0] - r) * rm; gg += (ROCK[1] - gg) * rm; b += (ROCK[2] - b) * rm;
          const sm = smooth(0.8, 0.9, e + (vnoise(dx * 0.8, dy * 0.8) - 0.5) * 0.08);
          r += (SNOW[0] - r) * sm; gg += (SNOW[1] - gg) * sm; b += (SNOW[2] - b) * sm;
        }
        const br = 0.92 + 0.16 * vnoise(dx * 0.9 + 300, dy * 0.9);
        r *= br; gg *= br; b *= br;
        // 국경선
        const c0 = CT[ci];
        const c1 = CT[clampY(Math.floor(dy)) * WW + wrapX(Math.floor(dx + 0.7))];
        const c2 = CT[clampY(Math.floor(dy + 0.7)) * WW + wrapX(Math.floor(dx))];
        if (c0 && ((c1 && c1 !== c0) || (c2 && c2 !== c0))) { r *= 0.68; gg *= 0.68; b *= 0.7; }
      }
      const o = (y * TW + x) * 4;
      d[o] = r; d[o + 1] = gg; d[o + 2] = b; d[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
  return cv;
}
// 해안 근접도
const COAST = new Float32Array(WW * WH);
(function () {
  const tmp = new Float32Array(WW * WH), rad = 6;
  for (let i = 0; i < WW * WH; i++) COAST[i] = KC[i] ? 1 : 0;
  for (let pass = 0; pass < 2; pass++) {
    for (let y = 0; y < WH; y++) {
      let acc = 0; const row = y * WW;
      for (let x = -rad; x <= rad; x++) acc += COAST[row + wrapX(x)];
      for (let x = 0; x < WW; x++) { tmp[row + x] = acc / (2 * rad + 1); acc += COAST[row + wrapX(x + rad + 1)] - COAST[row + wrapX(x - rad)]; }
    }
    for (let x = 0; x < WW; x++) {
      let acc = 0;
      for (let y = -rad; y <= rad; y++) acc += tmp[clampY(y) * WW + x];
      for (let y = 0; y < WH; y++) { COAST[y * WW + x] = acc / (2 * rad + 1); acc += tmp[clampY(y + rad + 1) * WW + x] - tmp[clampY(y - rad) * WW + x]; }
    }
  }
})();
const isSeaIce = (lat, lon) => {
  const n = vnoise((lon + 180) * 0.12, lat * 0.12) * 5;
  return lat > 77 + n - 2 || lat < -66.5 - n + 1.5;
};
function makeOceanCanvas() {
  const W2 = 2048, H2 = 1024;
  const cv = document.createElement('canvas'); cv.width = W2; cv.height = H2;
  const g = cv.getContext('2d');
  const im = g.createImageData(W2, H2), d = im.data;
  const deep = hex('#2f7fcf'), mid = hex('#3f9be0'), shal = hex('#7fd4ec'), ice = hex('#e4f2fa');
  for (let y = 0; y < H2; y++) {
    const lat = 90 - ((y + 0.5) / H2) * 180;
    const fy = (90 - lat) * 4 - 0.5, y0 = Math.floor(fy), ty = fy - y0;
    for (let x = 0; x < W2; x++) {
      const lon = -180 + ((x + 0.5) / W2) * 360;
      const fx = (lon + 180) * 4 - 0.5, x0 = Math.floor(fx), tx = fx - x0;
      const a = COAST[clampY(y0) * WW + wrapX(x0)], b = COAST[clampY(y0) * WW + wrapX(x0 + 1)];
      const c = COAST[clampY(y0 + 1) * WW + wrapX(x0)], e = COAST[clampY(y0 + 1) * WW + wrapX(x0 + 1)];
      const s = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + e * tx) * ty;
      const m1 = smooth(0.0, 0.18, s), m2 = smooth(0.2, 0.55, s);
      let r = deep[0] + (mid[0] - deep[0]) * m1, gg = deep[1] + (mid[1] - deep[1]) * m1, bb = deep[2] + (mid[2] - deep[2]) * m1;
      r += (shal[0] - r) * m2; gg += (shal[1] - gg) * m2; bb += (shal[2] - bb) * m2;
      const nz = 0.96 + 0.08 * vnoise(x * 0.05, y * 0.05);
      r *= nz; gg *= nz; bb *= nz;
      if (isSeaIce(lat, lon)) { const f = 0.9 + 0.1 * vnoise(x * 0.2, y * 0.2); r = ice[0] * f; gg = ice[1] * f; bb = ice[2] * f; }
      const o = (y * W2 + x) * 4;
      d[o] = r; d[o + 1] = gg; d[o + 2] = bb; d[o + 3] = 255;
    }
  }
  g.putImageData(im, 0, 0);
  // 물결 무늬
  g.strokeStyle = 'rgba(255,255,255,.45)'; g.lineWidth = 2.2; g.lineCap = 'round';
  rngSeed = 777;
  for (let n = 0; n < 1400; n++) {
    const x = rnd() * W2, y = H2 * 0.12 + rnd() * H2 * 0.74;
    const lat = 90 - (y / H2) * 180, lon = -180 + (x / W2) * 360;
    if (COAST[cell(lat, lon)] > 0.02 || isSeaIce(lat, lon)) continue;
    const sx = 1 / Math.max(0.25, Math.cos(lat * DEG));
    g.save(); g.translate(x, y); g.scale(sx, 1);
    g.beginPath(); g.moveTo(-7, 0); g.quadraticCurveTo(-3.5, -4, 0, 0); g.quadraticCurveTo(3.5, 4, 7, 0); g.stroke();
    g.restore();
  }
  // 바다 이름
  const labels = [['태평양', 5, -150, 46], ['태평양', -25, -125, 40], ['대서양', 25, -45, 40], ['대서양', -22, -18, 36], ['인도양', -22, 78, 40], ['북극해', 80, 0, 30], ['남극해', -62, 100, 30], ['태평양', 30, 160, 34]];
  g.textAlign = 'center'; g.textBaseline = 'middle';
  for (const [t, la, lo, size] of labels) {
    const x = ((lo + 180) / 360) * W2, y = ((90 - la) / 180) * H2;
    g.save(); g.translate(x, y); g.scale(1 / Math.max(0.3, Math.cos(la * DEG)), 1);
    g.font = `${size}px Jua, "Gowun Dodum", sans-serif`;
    g.fillStyle = 'rgba(255,255,255,.55)'; g.fillText(t, 0, 0); g.restore();
  }
  return cv;
}
const LAT_LINES = [[0, '#ff6b6b', '적도 0°'], [23.44, '#ffa94d', '북회귀선 23.5°N'], [-23.44, '#ffa94d', '남회귀선 23.5°S'], [66.56, '#74c0fc', '북극권 66.5°N'], [-66.56, '#74c0fc', '남극권 66.5°S']];
function drawLatLines(cv, withText) {
  const g = cv.getContext('2d'), W2 = cv.width, H2 = cv.height;
  for (const [la, col, name] of LAT_LINES) {
    const y = ((90 - la) / 180) * H2;
    g.save(); g.setLineDash([16, 12]); g.lineWidth = 3; g.strokeStyle = col; g.globalAlpha = 0.85;
    g.beginPath(); g.moveTo(0, y); g.lineTo(W2, y); g.stroke(); g.restore();
    if (withText) {
      g.save(); g.font = '15px Jua, "Gowun Dodum", sans-serif'; g.fillStyle = col; g.textAlign = 'center';
      const sx = 1 / Math.max(0.3, Math.cos(la * DEG));
      for (let lo = -165; lo < 180; lo += 45) {
        const x = ((lo + 180) / 360) * W2;
        g.save(); g.translate(x, y - 8); g.scale(sx, 1); g.fillText(name, 0, 0); g.restore();
      }
      g.restore();
    }
  }
}
await nextFrame();
const landCv = makeLandCanvas();
drawLatLines(landCv, false);
await nextFrame();
loadMsg('바다와 해빙을 그리고 있어요');
const oceanCv = makeOceanCanvas();
drawLatLines(oceanCv, true);
function canvasTex(cv) {
  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  t.wrapS = THREE.RepeatWrapping; return t;
}

// ---------------------------------------------------------------- 지구 메시
await nextFrame();
loadMsg('산과 고원을 쌓고 있어요');
function buildSphere(nLon, nLat, hFn) {
  const nv = (nLon + 1) * (nLat + 1);
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let k = 0, u = 0;
  for (let j = 0; j <= nLat; j++) {
    const lat = 90 - (j / nLat) * 180, la = lat * DEG, cl = Math.cos(la), sl = Math.sin(la);
    for (let i = 0; i <= nLon; i++) {
      const lon = -180 + (i / nLon) * 360, lo = lon * DEG;
      const r = R + hFn(lat, lon);
      pos[k++] = r * cl * Math.sin(lo); pos[k++] = r * sl; pos[k++] = r * cl * Math.cos(lo);
      uv[u++] = i / nLon; uv[u++] = 1 - j / nLat;
    }
  }
  const idx = new Uint32Array(nLon * nLat * 6); let q = 0;
  for (let j = 0; j < nLat; j++) for (let i = 0; i < nLon; i++) {
    const a = j * (nLon + 1) + i, b = a + nLon + 1;
    idx[q++] = a; idx[q++] = b; idx[q++] = a + 1; idx[q++] = b; idx[q++] = b + 1; idx[q++] = a + 1;
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  geo.setIndex(new THREE.BufferAttribute(idx, 1));
  geo.computeVertexNormals();
  return geo;
}
const terrainGeo = buildSphere(LOW ? 640 : 900, LOW ? 320 : 450, terrainH);
const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshToonMaterial({ map: canvasTex(landCv), gradientMap: gradTex }));
scene.add(terrain);
const waterMat = new THREE.MeshToonMaterial({ map: canvasTex(oceanCv), gradientMap: gradTex });
const water = new THREE.Mesh(buildSphere(360, 180, () => 0), waterMat);
scene.add(water);
// 테두리선 + 대기
const rim = new THREE.Mesh(new THREE.SphereGeometry(R * 1.006, 96, 48), new THREE.MeshBasicMaterial({ color: '#16203f', side: THREE.BackSide }));
scene.add(rim);
const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.16, 96, 48), new THREE.ShaderMaterial({
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'varying vec3 vN; varying vec3 vV; void main(){ float f = 1.0 - abs(dot(vN, vV)); float a = pow(smoothstep(0.0, 1.0, 1.0 - f) , 3.0); gl_FragColor = vec4(0.45, 0.72, 1.0, a * 0.55); }',
  side: THREE.BackSide, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending
}));
scene.add(atmo);
// 별
(function () {
  const n = 2500, p = new Float32Array(n * 3); rngSeed = 99;
  for (let i = 0; i < n; i++) {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u), r = 1200 + rnd() * 400;
    p[i * 3] = r * s * Math.cos(t); p[i * 3 + 1] = r * u; p[i * 3 + 2] = r * s * Math.sin(t);
  }
  const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(p, 3));
  scene.add(new THREE.Points(g, new THREE.PointsMaterial({ color: '#fff6d8', size: 2.2, sizeAttenuation: false })));
})();

// ---------------------------------------------------------------- 지오메트리 도우미
function colored(geo, color) {
  geo = geo.index ? geo.toNonIndexed() : geo;
  const n = geo.attributes.position.count, c = new Float32Array(n * 3), col = new THREE.Color(color);
  for (let i = 0; i < n; i++) { c[i * 3] = col.r; c[i * 3 + 1] = col.g; c[i * 3 + 2] = col.b; }
  geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
  if (geo.attributes.uv) geo.deleteAttribute('uv');
  return geo;
}
function merge(parts) {
  let n = 0; for (const p of parts) n += p.attributes.position.count;
  const pos = new Float32Array(n * 3), nor = new Float32Array(n * 3), col = new Float32Array(n * 3);
  let o = 0;
  for (const p of parts) {
    pos.set(p.attributes.position.array, o); nor.set(p.attributes.normal.array, o); col.set(p.attributes.color.array, o);
    o += p.attributes.position.count * 3;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(nor, 3));
  g.setAttribute('color', new THREE.BufferAttribute(col, 3));
  g.computeBoundingSphere();
  return g;
}
const T = (geo, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1, ry = 0, rx = 0, rz = 0) => {
  const m = new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(rx, ry, rz)), new THREE.Vector3(sx, sy, sz));
  geo.applyMatrix4(m); return geo;
};
const G = {
  box: (w, h, d) => new THREE.BoxGeometry(w, h, d),
  cyl: (rt, rb, h, s = 8) => new THREE.CylinderGeometry(rt, rb, h, s),
  cone: (r, h, s = 8) => new THREE.ConeGeometry(r, h, s),
  ball: (r, d = 1) => new THREE.IcosahedronGeometry(r, d),
  sph: (r, w = 14, h = 10, ts = 0, tl = Math.PI) => new THREE.SphereGeometry(r, w, h, 0, Math.PI * 2, ts, tl),
  dode: (r) => new THREE.DodecahedronGeometry(r, 0),
  tor: (r, t) => new THREE.TorusGeometry(r, t, 6, 16)
};

// ---------------------------------------------------------------- 식생
await nextFrame();
loadMsg('나무와 선인장을 심고 있어요');
const TREE_TYPES = {
  rain: merge([colored(T(G.cyl(0.06, 0.09, 0.5, 6), 0, 0.25), '#7a5232'), colored(T(G.ball(0.42), 0, 0.72, 0, 1, 0.85, 1), '#2b8a47'), colored(T(G.ball(0.3), 0.2, 0.95, 0.06), '#38a457')]),
  palm: merge([colored(T(G.cyl(0.045, 0.07, 0.9, 6), 0, 0.45, 0, 1, 1, 1, 0, 0, 0.12), '#a07a4a'), colored(T(G.ball(0.4, 0), -0.05, 0.95, 0, 1, 0.3, 1), '#4caf50'), colored(T(G.ball(0.08, 0), 0, 0.86, 0.06), '#7a5232')]),
  acacia: merge([colored(T(G.cyl(0.04, 0.07, 0.6, 5), 0, 0.3), '#7a5232'), colored(T(G.cyl(0.5, 0.42, 0.14, 9), 0, 0.66), '#7fa944')]),
  cactus: merge([colored(T(G.cyl(0.09, 0.1, 0.65, 7), 0, 0.33), '#4f9a48'), colored(T(G.cyl(0.055, 0.055, 0.25, 6), 0.15, 0.45), '#4f9a48'), colored(T(G.cyl(0.05, 0.05, 0.12, 6), 0.08, 0.36, 0, 1, 1, 1, 0, 0, Math.PI / 2), '#4f9a48'), colored(T(G.ball(0.09, 0), 0, 0.66), '#5aa851')]),
  shrub: merge([colored(T(G.ball(0.18, 0), 0, 0.08, 0, 1, 0.6, 1), '#a3a35c'), colored(T(G.ball(0.12, 0), 0.16, 0.06, 0.05, 1, 0.6, 1), '#8f9a52')]),
  rock: merge([colored(T(G.dode(0.2), 0, 0.08, 0, 1, 0.65, 1), '#b48c66'), colored(T(G.dode(0.12), 0.2, 0.05, 0.08, 1, 0.7, 1), '#a07a58')]),
  olive: merge([colored(T(G.cyl(0.05, 0.07, 0.3, 5), 0, 0.15), '#7a6040'), colored(T(G.ball(0.28, 0), 0, 0.44, 0, 1.1, 0.8, 1.1), '#8faa62')]),
  decid: merge([colored(T(G.cyl(0.05, 0.08, 0.45, 6), 0, 0.22), '#7a5232'), colored(T(G.ball(0.36, 0), 0, 0.68), '#5fae4a')]),
  conifer: merge([colored(T(G.cyl(0.04, 0.06, 0.25, 5), 0, 0.12), '#6a4a30'), colored(T(G.cone(0.32, 0.55, 7), 0, 0.45), '#2f6e4a'), colored(T(G.cone(0.23, 0.42, 7), 0, 0.75), '#367d54')]),
  tundra: merge([colored(T(G.ball(0.14, 0), 0, 0.05, 0, 1.3, 0.45, 1.3), '#8f9c74'), colored(T(G.dode(0.1), 0.18, 0.04, 0), '#9aa0a0')])
};
const VEG = {
  Af: [['rain', 1.0], ['palm', 0.25]], Am: [['rain', 0.75], ['palm', 0.3]], Aw: [['acacia', 0.32], ['rain', 0.06], ['palm', 0.04]], As: [['acacia', 0.28]],
  BWh: [['rock', 0.05], ['shrub', 0.02], ['cactus', 0.03]], BWk: [['rock', 0.06], ['shrub', 0.03]], BSh: [['acacia', 0.1], ['shrub', 0.12]], BSk: [['shrub', 0.16], ['rock', 0.03]],
  Csa: [['olive', 0.38], ['conifer', 0.04]], Csb: [['olive', 0.3], ['conifer', 0.1]], Csc: [['conifer', 0.3]],
  Cwa: [['decid', 0.45], ['rain', 0.08]], Cwb: [['decid', 0.35], ['conifer', 0.1]], Cwc: [['conifer', 0.3]],
  Cfa: [['decid', 0.55], ['conifer', 0.1]], Cfb: [['decid', 0.45], ['conifer', 0.18]], Cfc: [['conifer', 0.35]],
  ET: [['tundra', 0.2]], EF: []
};
for (const a of 'swf') for (const b of 'abcd') VEG['D' + a + b] = b === 'a' || b === 'b' ? [['decid', 0.22], ['conifer', 0.5]] : [['conifer', 0.75]];
function addTrees() {
  const N = LOW ? 60000 : 110000;
  const lists = {}; for (const k in TREE_TYPES) lists[k] = [];
  const v = new THREE.Vector3(); rngSeed = 4242;
  for (let n = 0; n < N; n++) {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    v.set(s * Math.cos(t), u, s * Math.sin(t));
    const lat = dirLat(v), lon = dirLon(v);
    const ci = cell(lat, lon), k = KC[ci];
    if (!k) continue;
    const spec = VEG[CLASSES[k - 1]]; if (!spec || !spec.length) continue;
    const e = ELEV[ci] / 248; if (e > 0.78) continue;
    let tot = 0; for (const sp of spec) tot += sp[1];
    const dens = Math.min(1, tot) * (1 - smooth(0.5, 0.78, e));
    if (rnd() > dens) continue;
    sampleLE(lat, lon, _s); if (_s.land < 0.9) continue;
    let pick = rnd() * tot, type = spec[0][0];
    for (const sp of spec) { if ((pick -= sp[1]) <= 0) { type = sp[0]; break; } }
    if (type === 'cactus' && lon > -30) type = 'rock';
    lists[type].push([v.x, v.y, v.z, rnd(), 0.75 + rnd() * 0.6]);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), sc = new THREE.Vector3();
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradTex });
  for (const type in lists) {
    const L = lists[type]; if (!L.length) continue;
    const im = new THREE.InstancedMesh(TREE_TYPES[type], mat, L.length);
    L.forEach((it, i) => {
      d.set(it[0], it[1], it[2]);
      const h = hDir(d);
      q.setFromUnitVectors(up, d); q2.setFromAxisAngle(up, it[3] * Math.PI * 2); q.multiply(q2);
      sc.setScalar(it[4] * 1.25);
      m.compose(d.clone().multiplyScalar(R + h - 0.03), q, sc);
      im.setMatrixAt(i, m);
    });
    im.computeBoundingSphere();
    scene.add(im);
  }
}
addTrees();

// 구름: 열대 수렴대와 중위도에 많고 사막 위에는 적어요
const clouds = new THREE.Group(); scene.add(clouds);
(function () {
  const geo = merge([colored(T(G.ball(1.2, 1), 0, 0, 0), '#ffffff'), colored(T(G.ball(0.9, 1), 1.2, -0.2, 0.2), '#ffffff'), colored(T(G.ball(0.85, 1), -1.15, -0.25, -0.1), '#ffffff'), colored(T(G.ball(0.7, 1), 0.3, 0.55, -0.4), '#f4f8ff')]);
  const mat = new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradTex, transparent: true, opacity: 0.93 });
  const v = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0); rngSeed = 31337;
  let placed = 0;
  const list = [];
  for (let n = 0; n < 5000 && placed < (LOW ? 110 : 170); n++) {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    v.set(s * Math.cos(t), u, s * Math.sin(t));
    const lat = dirLat(v), lon = dirLon(v), k = KC[cell(lat, lon)];
    const code = k ? CLASSES[k - 1] : '';
    let p = 0.12 + 0.55 * Math.exp(-((lat - 5) * (lat - 5)) / 120) + 0.35 * Math.exp(-((Math.abs(lat) - 55) ** 2) / 150);
    if (code[0] === 'B') p *= 0.12;
    if (Math.abs(lat) > 30 && Math.abs(lat) < 35 && !k) p *= 0.5;
    if (rnd() > p) continue;
    list.push([v.clone(), 0.8 + rnd() * 1.1, rnd()]);
    placed++;
  }
  const im = new THREE.InstancedMesh(geo, mat, list.length);
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  list.forEach(([d, s, r], i) => {
    q.setFromUnitVectors(up, d); q2.setFromAxisAngle(up, r * 6.28); q.multiply(q2);
    m.compose(d.clone().multiplyScalar(R + 8.5 + r * 2.5), q, new THREE.Vector3(s * 1.4, s * 0.8, s));
    im.setMatrixAt(i, m);
  });
  im.computeBoundingSphere();
  clouds.add(im);
})();

// ---------------------------------------------------------------- 메시 도우미 (외곽선 포함)
function part(group, geo, color, x = 0, y = 0, z = 0, opt = {}) {
  const mesh = new THREE.Mesh(geo, toon(color));
  mesh.position.set(x, y, z);
  if (opt.r) mesh.rotation.set(opt.r[0], opt.r[1], opt.r[2]);
  if (opt.s) mesh.scale.set(opt.s[0], opt.s[1], opt.s[2]);
  if (opt.outline !== false) { const o = new THREE.Mesh(geo, opt.thin ? OUT_S : OUT_M); mesh.add(o); }
  group.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------- 캐릭터
const player = new THREE.Group(); scene.add(player);
const body = new THREE.Group(); player.add(body);
const SKIN = '#f2c9a0';
const mats = { top: new THREE.MeshToonMaterial({ color: '#6fb36a', gradientMap: gradTex }), arm: new THREE.MeshToonMaterial({ color: '#6fb36a', gradientMap: gradTex }), leg: new THREE.MeshToonMaterial({ color: '#8b6b4a', gradientMap: gradTex }) };
function partM(parent, geo, mat, x, y, z) {
  const m = new THREE.Mesh(geo, mat); m.position.set(x, y, z); m.add(new THREE.Mesh(geo, OUT_S)); parent.add(m); return m;
}
const legL = new THREE.Group(), legR = new THREE.Group(), armL = new THREE.Group(), armR = new THREE.Group();
legL.position.set(0.09, 0.34, 0); legR.position.set(-0.09, 0.34, 0);
armL.position.set(0.25, 0.7, 0); armR.position.set(-0.25, 0.7, 0);
body.add(legL, legR, armL, armR);
partM(legL, T(G.box(0.12, 0.32, 0.14), 0, -0.16, 0), mats.leg, 0, 0, 0);
partM(legR, T(G.box(0.12, 0.32, 0.14), 0, -0.16, 0), mats.leg, 0, 0, 0);
partM(legL, G.box(0.14, 0.07, 0.2), toon('#5b4636'), 0, -0.32, 0.03);
partM(legR, G.box(0.14, 0.07, 0.2), toon('#5b4636'), 0, -0.32, 0.03);
partM(armL, T(G.box(0.1, 0.3, 0.1), 0, -0.14, 0), mats.arm, 0, 0, 0);
partM(armR, T(G.box(0.1, 0.3, 0.1), 0, -0.14, 0), mats.arm, 0, 0, 0);
partM(armL, G.ball(0.06, 1), toon(SKIN), 0, -0.31, 0);
partM(armR, G.ball(0.06, 1), toon(SKIN), 0, -0.31, 0);
partM(body, G.cyl(0.2, 0.24, 0.42, 12), mats.top, 0, 0.53, 0);
partM(body, G.box(0.3, 0.3, 0.14), toon('#c8813a'), 0, 0.58, -0.22);
const head = new THREE.Group(); head.position.set(0, 0.98, 0); body.add(head);
partM(head, G.sph(0.24, 18, 14), toon(SKIN), 0, 0, 0);
for (const sx of [1, -1]) {
  const eye = new THREE.Mesh(G.sph(0.032, 8, 6), toon('#2b2118')); eye.position.set(0.085 * sx, 0.02, 0.215); head.add(eye);
  const ch = new THREE.Mesh(G.sph(0.035, 8, 6), toon('#ff9a8a')); ch.position.set(0.14 * sx, -0.06, 0.18); ch.scale.set(1, 0.6, 0.5); head.add(ch);
}
const hats = {};
function hatGroup(name) { const g = new THREE.Group(); g.visible = false; head.add(g); hats[name] = g; return g; }
{ const g = hatGroup('safari'); part(g, G.cyl(0.36, 0.36, 0.03, 18), '#d9b88a', 0, 0.12, 0, { thin: true }); part(g, G.sph(0.22, 16, 8, 0, Math.PI / 2), '#d9b88a', 0, 0.12, 0, { thin: true }); part(g, G.cyl(0.225, 0.225, 0.04, 16), '#8b5a3c', 0, 0.15, 0, { outline: false }); }
{ const g = hatGroup('straw'); part(g, G.cone(0.42, 0.22, 18), '#f0d080', 0, 0.22, 0, { thin: true }); part(g, G.cyl(0.2, 0.22, 0.04, 14), '#d64545', 0, 0.16, 0, { outline: false }); }
{ const g = hatGroup('scarf'); part(g, G.sph(0.262, 18, 12, 0, Math.PI * 0.62), '#2f5fa8', 0, 0, -0.01, { thin: true }); part(g, G.box(0.16, 0.34, 0.05), '#2f5fa8', 0, -0.2, -0.22, { thin: true }); }
{ const g = hatGroup('beanie'); part(g, G.sph(0.255, 16, 10, 0, Math.PI * 0.5), '#2a9d8f', 0, 0.02, 0, { thin: true }); part(g, G.tor(0.24, 0.045), '#f1f1e6', 0, 0.05, 0, { r: [Math.PI / 2, 0, 0], outline: false }); part(g, G.ball(0.07, 1), '#f1f1e6', 0, 0.3, 0, { thin: true }); }
{ const g = hatGroup('chullo'); part(g, G.sph(0.255, 16, 10, 0, Math.PI * 0.55), '#a347c8', 0, 0.02, 0, { thin: true }); part(g, G.cone(0.05, 0.22, 6), '#ffcf5a', 0.2, -0.2, 0, { r: [0, 0, 0.3] }); part(g, G.cone(0.05, 0.22, 6), '#ffcf5a', -0.2, -0.2, 0, { r: [0, 0, -0.3] }); part(g, G.ball(0.05, 0), '#ff6b6b', 0, 0.28, 0); }
{ const g = hatGroup('hood'); part(g, G.sph(0.3, 18, 12, 0, Math.PI * 0.75), '#e9dcc6', 0, 0, -0.03, { thin: true }); part(g, G.tor(0.23, 0.06), '#fbf6ec', 0, -0.01, 0.12, { outline: false }); }
const scarfNeck = part(body, G.tor(0.19, 0.06), '#e63946', 0, 0.76, 0, { r: [Math.PI / 2, 0, 0], thin: true }); scarfNeck.visible = false;
const OUTFITS = {
  hot: { top: '#ffd166', arm: SKIN, leg: '#3b82c4', hat: 'straw', scarf: false, label: '반팔·반바지·밀짚모자 (덥고 습해요)' },
  dry: { top: '#f4efe6', arm: '#f4efe6', leg: '#f4efe6', hat: 'scarf', scarf: false, label: '헐렁한 긴 옷과 두건 (햇볕·모래바람을 막아요)' },
  mild: { top: '#6fb36a', arm: '#6fb36a', leg: '#8b6b4a', hat: 'safari', scarf: false, label: '가벼운 탐험복 (사계절이 뚜렷해요)' },
  cold: { top: '#e63946', arm: '#e63946', leg: '#344055', hat: 'beanie', scarf: true, label: '두꺼운 패딩·털모자·목도리 (겨울이 길고 추워요)' },
  polar: { top: '#e9dcc6', arm: '#e9dcc6', leg: '#6b4f3a', hat: 'hood', scarf: false, label: '털가죽 파카 (1년 내내 추워요)' },
  alpine: { top: '#d35400', arm: '#d35400', leg: '#5b4636', hat: 'chullo', scarf: false, label: '판초와 털모자 (고산은 일교차가 커요)' }
};
let outfit = '';
function setOutfit(name) {
  if (name === outfit) return; outfit = name;
  const o = OUTFITS[name];
  mats.top.color.set(o.top); mats.arm.color.set(o.arm); mats.leg.color.set(o.leg);
  for (const k in hats) hats[k].visible = k === o.hat;
  scarfNeck.visible = o.scarf;
}
setOutfit('mild');
// 배
const boat = new THREE.Group(); boat.visible = false; player.add(boat);
part(boat, T(G.cyl(0.55, 0.38, 0.3, 4), 0, 0, 0, 1, 1, 1.9, Math.PI / 4), '#9c5b34', 0, 0.02, 0);
part(boat, G.box(0.62, 0.05, 1.3), '#d9a66b', 0, 0.16, 0, { outline: false });
part(boat, G.cyl(0.03, 0.03, 1.4, 6), '#6b4f3a', 0, 0.85, -0.25, { thin: true });
part(boat, T(new THREE.ConeGeometry(0.5, 1.1, 3), 0, 0, 0, 0.12, 1, 1), '#fffaf0', 0, 0.95, -0.15, { thin: true });
part(boat, G.box(0.3, 0.18, 0.02), '#e0663a', 0, 1.5, -0.25, { thin: true });
// 열기구
const balloon = new THREE.Group(); balloon.visible = false; player.add(balloon);
{
  const env = new THREE.SphereGeometry(1.0, 16, 14);
  const cols = ['#ff6b6b', '#ffd166', '#4ecdc4', '#ffffff'];
  const ng = env.toNonIndexed(); const n = ng.attributes.position.count, ca = new Float32Array(n * 3), col = new THREE.Color();
  for (let i = 0; i < n; i += 3) {
    const x = (ng.attributes.position.getX(i) + ng.attributes.position.getX(i + 1) + ng.attributes.position.getX(i + 2)) / 3;
    const z = (ng.attributes.position.getZ(i) + ng.attributes.position.getZ(i + 1) + ng.attributes.position.getZ(i + 2)) / 3;
    col.set(cols[Math.floor(((Math.atan2(z, x) + Math.PI) / (Math.PI * 2)) * 8) % 4]);
    for (let k = 0; k < 3; k++) { ca[(i + k) * 3] = col.r; ca[(i + k) * 3 + 1] = col.g; ca[(i + k) * 3 + 2] = col.b; }
  }
  ng.setAttribute('color', new THREE.BufferAttribute(ca, 3));
  const e = new THREE.Mesh(ng, new THREE.MeshToonMaterial({ vertexColors: true, gradientMap: gradTex }));
  e.position.y = 2.45; e.scale.set(1, 1.15, 1); e.add(new THREE.Mesh(ng, OUT_M)); balloon.add(e);
  part(balloon, G.cyl(0.28, 0.24, 0.3, 8), '#a8783c', 0, 0.12, 0);
  for (const [x, z] of [[0.25, 0.25], [-0.25, 0.25], [0.25, -0.25], [-0.25, -0.25]]) part(balloon, T(G.cyl(0.012, 0.012, 1.3, 4), 0, 0, 0, 1, 1, 1, 0, Math.atan2(z, 1.3) * 0.6, -Math.atan2(x, 1.3) * 0.6), '#6b4f3a', x * 1.3, 0.9, z * 1.3, { outline: false });
}

// ---------------------------------------------------------------- 문화 명소 모형
const anims = [];
const PROPS = {
  hanok(g) { part(g, G.box(2.3, 0.25, 1.7), '#b9b3a6', 0, 0.12, 0); part(g, G.box(1.8, 0.75, 1.2), '#f3e6c8', 0, 0.62, 0); for (const x of [-0.85, -0.3, 0.3, 0.85]) part(g, G.box(0.08, 0.75, 0.08), '#7a4a2a', x, 0.62, 0.6, { thin: true }); part(g, T(G.cone(1.6, 0.75, 4), 0, 0, 0, 1.15, 1, 0.8, Math.PI / 4), '#4a4c5e', 0, 1.36, 0); part(g, G.box(2.6, 0.08, 1.9), '#3c3e4e', 0, 1.0, 0); },
  gassho(g) { part(g, G.box(1.5, 0.7, 1.1), '#8b5a2b', 0, 0.35, 0); for (const x of [-0.35, 0.35]) part(g, G.box(0.3, 0.3, 0.02), '#f6eedc', x, 0.42, 0.56, { thin: true }); part(g, T(G.cone(1.15, 1.9, 4), 0, 0, 0, 0.75, 1, 1.25, Math.PI / 4), '#c9a15a', 0, 1.65, 0); part(g, G.box(0.5, 0.5, 0.5), '#ffffff', 0, 2.55, 0, { s: [0.2, 0.2, 2.5], outline: false }); },
  ger(g) { part(g, G.cyl(1, 1, 0.8, 18), '#f6f1e6', 0, 0.4, 0); part(g, G.cone(1.08, 0.55, 18), '#f0e9da', 0, 1.07, 0); part(g, G.cyl(0.18, 0.18, 0.08, 10), '#c84b31', 0, 1.36, 0); part(g, G.box(0.42, 0.58, 0.06), '#e07a2f', 0, 0.3, 0.99, { thin: true }); part(g, G.tor(1.0, 0.03), '#c84b31', 0, 0.55, 0, { r: [Math.PI / 2, 0, 0], outline: false }); horse(g, 1.6, 0.6); },
  cave(g) { part(g, G.sph(1.6, 18, 10, 0, Math.PI / 2), '#d9b77a', 0, 0, -0.4, { s: [1.3, 0.9, 0.9] }); for (const x of [-0.9, 0, 0.9]) { part(g, G.box(0.42, 0.45, 0.1), '#5b3a26', x, 0.3, 0.95, { thin: true }); part(g, G.cyl(0.21, 0.21, 0.1, 12, 1), '#5b3a26', x, 0.52, 0.95, { r: [Math.PI / 2, 0, 0], thin: true }); } },
  terrace(g) { [[1.7, '#7cc35a'], [1.35, '#9bd36a'], [1.0, '#7cc35a'], [0.65, '#9bd36a']].forEach(([r, c], i) => part(g, G.cyl(r, r + 0.05, 0.28, 16), c, 0, 0.14 + i * 0.28, 0)); part(g, G.cyl(1.2, 1.2, 0.02, 16), '#8fd0f0', 0, 0.58, 0, { outline: false }); },
  temple(g) { part(g, G.box(2.4, 0.9, 1.3), '#f4efe6', 0, 0.45, 0); part(g, G.box(1.2, 0.7, 1.0), '#b03a2e', 0, 1.25, 0); part(g, G.box(0.5, 0.25, 0.5), '#ffcf5a', 0, 1.72, 0); for (const x of [-0.8, -0.4, 0, 0.4, 0.8]) part(g, G.box(0.16, 0.22, 0.02), '#5b4636', x, 0.55, 0.66, { outline: false }); },
  flag(g) { part(g, G.cyl(0.04, 0.04, 2.0, 6), '#6b4f3a', 0, 1.0, 0, { thin: true }); part(g, G.box(0.7, 0.45, 0.03), '#e63946', 0.36, 1.75, 0, { thin: true }); ['#2f6fd0', '#fff', '#e63946', '#2a9d8f', '#ffcf5a'].forEach((c, i) => part(g, G.box(0.18, 0.22, 0.02), c, -0.25 - i * 0.24, 1.55 - i * 0.12, 0, { outline: false })); part(g, G.dode(0.35), '#9aa0a0', 0, 0.15, 0); },
  tower(g) { part(g, G.box(0.8, 2.4, 0.8), '#c9d3dd', 0, 1.2, 0); part(g, G.cone(0.5, 0.6, 4), '#6c8aa8', 0, 2.7, 0, { r: [0, Math.PI / 4, 0] }); part(g, G.box(0.7, 1.2, 0.7), '#e9b872', 1.0, 0.6, 0.2); part(g, G.box(0.6, 0.9, 0.6), '#9fc8a0', -0.9, 0.45, 0.3); for (let y = 0.4; y < 2.2; y += 0.4) part(g, G.box(0.82, 0.08, 0.82), '#8aa0b8', 0, y, 0, { outline: false }); },
  stilt(g) { for (const [x, z] of [[-0.65, -0.45], [0.65, -0.45], [-0.65, 0.45], [0.65, 0.45]]) part(g, G.cyl(0.05, 0.05, 0.9, 6), '#6b4f3a', x, 0.45, z, { thin: true }); part(g, G.box(1.6, 0.12, 1.2), '#8b5a3c', 0, 0.92, 0); part(g, G.box(1.3, 0.6, 0.95), '#d9b26a', 0, 1.28, 0); part(g, T(G.cone(1.25, 0.9, 4), 0, 0, 0, 1.0, 1, 0.8, Math.PI / 4), '#a8783c', 0, 2.03, 0); part(g, G.box(0.3, 0.4, 0.02), '#5b3a26', 0, 1.22, 0.49, { thin: true }); part(g, T(G.box(0.3, 0.9, 0.04), 0, 0, 0, 1, 1, 1, 0, -0.5), '#8b5a3c', 0, 0.45, 0.85, { thin: true }); },
  boat(g) { part(g, T(G.cyl(0.5, 0.3, 0.3, 4), 0, 0, 0, 1, 1, 2.3, Math.PI / 4), '#2f6fd0', 0, 0.15, 0); for (const [x, z, c] of [[0.1, 0.3, '#ffcf5a'], [-0.12, 0, '#e63946'], [0.08, -0.35, '#7cc35a'], [-0.05, 0.6, '#ff9f43']]) part(g, G.ball(0.15, 0), c, x, 0.38, z, { thin: true }); part(g, G.cone(0.32, 0.22, 14), '#f0d080', 0, 0.75, -0.7, { thin: true }); part(g, G.cyl(1.5, 1.5, 0.03, 20), '#6cc7e8', 0, 0.02, 0, { outline: false }); },
  hut(g, c) { const roof = c === 'masai' ? '#c8a165' : '#5c9e45'; for (const [x, z] of [[0, 0], [1.3, -0.4], [-1.1, -0.6]]) { part(g, G.cyl(0.6, 0.65, 0.6, 12), '#a0683c', x, 0.3, z); part(g, G.cone(0.82, 0.75, 12), roof, x, 0.97, z); part(g, G.box(0.25, 0.35, 0.05), '#4a2e1a', x, 0.2, z + 0.62, { outline: false }); } },
  farm(g, c) { const crop = { cocoa: '#8a5a2b', capetown: '#7b3f8c', pampa: '#d9c46a', coffee: '#b83b3b' }[c] || '#e3c94a'; for (let i = 0; i < 4; i++) part(g, G.box(0.5, 0.05, 2.0), i % 2 ? '#7cc35a' : '#a3d36a', -1.2 + i * 0.55, 0.03, 0, { outline: false }); for (let i = 0; i < 6; i++) { part(g, G.ball(0.22, 0), '#4f9a48', -1.2 + (i % 3) * 0.55, 0.3, -0.6 + Math.floor(i / 3) * 1.1, { thin: true }); part(g, G.ball(0.07, 0), crop, -1.1 + (i % 3) * 0.55, 0.35, -0.45 + Math.floor(i / 3) * 1.1, { outline: false }); } part(g, G.box(0.9, 0.7, 0.8), '#c0392b', 1.2, 0.35, 0); part(g, T(G.cone(0.75, 0.5, 4), 0, 0, 0, 1, 1, 0.85, Math.PI / 4), '#f4efe6', 1.2, 0.95, 0); if (c === 'pampa') cow(g, 0.2, 1.4); },
  mosque(g) { part(g, G.box(2.0, 1.0, 1.4), '#c08a5a', 0, 0.5, 0); for (const x of [-0.75, 0, 0.75]) { part(g, G.box(0.36, 1.7, 0.36), '#b87d4e', x, 0.85, 0.6); part(g, G.cone(0.2, 0.3, 4), '#b87d4e', x, 1.85, 0.6, { r: [0, Math.PI / 4, 0] }); for (let y = 0.5; y < 1.6; y += 0.35) part(g, G.cyl(0.02, 0.02, 0.55, 4), '#6b4f3a', x, y, 0.6, { r: [Math.PI / 2, 0, 0], outline: false }); } },
  tent(g, c) { if (c === 'sami') { part(g, G.cone(0.9, 1.8, 10), '#d8c3a0', 0, 0.9, 0); for (let i = 0; i < 5; i++) part(g, G.cyl(0.02, 0.02, 0.5, 4), '#6b4f3a', Math.cos(i * 1.25) * 0.06, 1.95, Math.sin(i * 1.25) * 0.06, { r: [Math.cos(i * 1.25) * 0.3, 0, Math.sin(i * 1.25) * 0.3], outline: false }); reindeer(g, 1.4, 0.5); } else { part(g, T(G.cone(1.3, 0.8, 4), 0, 0, 0, 1.3, 1, 0.8, Math.PI / 4), '#6b4b3a', 0, 0.4, 0); part(g, G.box(0.5, 0.45, 0.05), '#3a2a20', 0, 0.22, 0.75, { outline: false }); camel(g, 1.6, 0.4); part(g, T(G.cyl(0.04, 0.06, 1.1, 6), 0, 0, 0, 1, 1, 1, 0, 0, 0.1), '#a07a4a', -1.5, 0.55, -0.4); part(g, G.ball(0.4, 0), '#4caf50', -1.45, 1.1, -0.4, { s: [1, 0.35, 1] }); part(g, G.cyl(0.6, 0.6, 0.03, 14), '#6cc7e8', -1.3, 0.02, 0.4, { outline: false }); } },
  pyramid(g) { part(g, G.cone(1.6, 1.7, 4), '#e3c27a', 0, 0.85, 0, { r: [0, Math.PI / 4, 0] }); part(g, G.cone(0.9, 1.0, 4), '#d9b56a', 1.8, 0.5, -0.8, { r: [0, Math.PI / 4, 0] }); part(g, G.cone(0.6, 0.65, 4), '#e3c27a', -1.6, 0.32, -1.0, { r: [0, Math.PI / 4, 0] }); },
  windtower(g) { part(g, G.box(1.8, 0.8, 1.3), '#d6b483', 0, 0.4, 0); part(g, G.box(0.42, 1.6, 0.42), '#ccaa78', 0.6, 0.8, -0.2); for (const y of [1.25, 1.45]) part(g, G.box(0.44, 0.12, 0.3), '#5b3a26', 0.6, y, -0.2, { outline: false }); part(g, G.sph(0.4, 14, 8, 0, Math.PI / 2), '#e2c595', -0.4, 0.8, 0.1); part(g, G.box(0.3, 0.4, 0.05), '#5b3a26', -0.4, 0.2, 0.66, { outline: false }); },
  white(g) { part(g, G.box(1.3, 0.85, 1.1), '#fbfbf7', 0, 0.42, 0); part(g, G.sph(0.48, 16, 8, 0, Math.PI / 2), '#2f6fd0', 0, 0.85, 0); part(g, G.box(0.9, 0.6, 0.9), '#fbfbf7', 1.1, 0.3, 0.3); part(g, G.box(0.8, 0.5, 0.8), '#fbfbf7', -1.0, 0.25, 0.4); for (const [x, y, z] of [[0, 0.4, 0.56], [1.1, 0.3, 0.76], [-1.0, 0.25, 0.81]]) part(g, G.box(0.18, 0.22, 0.02), '#2f6fd0', x, y, z, { outline: false }); for (let i = 0; i < 3; i++) part(g, G.ball(0.25, 0), '#8faa62', -1.8 + i * 0.3, 0.3, -0.8 + i * 0.4, { thin: true }); },
  clock(g) { part(g, G.box(0.6, 2.6, 0.6), '#c8a46a', 0, 1.3, 0); for (const r of [0, Math.PI / 2, Math.PI, -Math.PI / 2]) { const c = part(g, G.cyl(0.2, 0.2, 0.04, 16), '#fffaf0', Math.sin(r) * 0.31, 2.1, Math.cos(r) * 0.31, { r: [Math.PI / 2, 0, -r], thin: true }); } part(g, G.cone(0.42, 0.9, 4), '#4a5a4a', 0, 3.05, 0, { r: [0, Math.PI / 4, 0] }); part(g, G.box(0.35, 0.8, 0.35), '#d62828', 1.0, 0.4, 0.4); part(g, G.cone(0.45, 0.25, 8), '#2b2b3a', -0.9, 0.95, 0.5, { thin: true }); part(g, G.cyl(0.015, 0.015, 0.9, 4), '#2b2b3a', -0.9, 0.5, 0.5, { outline: false }); },
  windmill(g) { part(g, G.cyl(0.32, 0.6, 1.9, 8), '#8b5a3c', 0, 0.95, 0); part(g, G.cone(0.42, 0.5, 8), '#4a3a30', 0, 2.1, 0); const hub = new THREE.Group(); hub.position.set(0, 1.75, 0.5); g.add(hub); for (let i = 0; i < 4; i++) { const b = part(hub, T(G.box(0.18, 1.3, 0.03), 0, 0.7, 0), '#f5f0e6', 0, 0, 0, { thin: true }); b.rotation.z = (i * Math.PI) / 2; } anims.push((t) => (hub.rotation.z = t * 1.2)); for (let i = 0; i < 14; i++) part(g, G.ball(0.1, 0), ['#e63946', '#ffcf5a', '#ff8fab'][i % 3], -1.4 + (i % 7) * 0.22, 0.1, 0.9 + Math.floor(i / 7) * 0.3, { outline: false }); },
  chalet(g) { part(g, G.box(1.6, 0.9, 1.2), '#9c6b3f', 0, 0.45, 0); part(g, T(G.cone(1.35, 0.55, 4), 0, 0, 0, 1.15, 1, 0.95, Math.PI / 4), '#5b4636', 0, 1.18, 0); part(g, G.box(1.9, 0.08, 1.5), '#f6f6f2', 0, 1.0, 0, { outline: false }); part(g, G.cyl(0.32, 0.32, 0.22, 14), '#ffcf5a', 1.2, 0.11, 0.6); cow(g, -1.4, 0.6); },
  cabin(g) { part(g, G.box(1.4, 0.8, 1.0), '#b5482f', 0, 0.4, 0); part(g, T(G.cone(1.1, 0.6, 4), 0, 0, 0, 1.0, 1, 0.75, Math.PI / 4), '#3c3e4e', 0, 1.1, 0); for (const x of [-0.35, 0.35]) part(g, G.box(0.25, 0.25, 0.02), '#fff8e0', x, 0.5, 0.51, { outline: false }); for (let i = 0; i < 3; i++) part(g, G.cyl(0.1, 0.1, 0.8, 8), '#a07a4a', 1.2, 0.1 + i * 0.19, 0.3, { r: [Math.PI / 2, 0, 0], thin: true }); },
  geo(g) { part(g, G.cyl(0.9, 0.9, 0.05, 16), '#6ec6e8', 0, 0.03, 0, { outline: false }); for (let i = 0; i < 5; i++) part(g, G.dode(0.25), '#7d7a78', Math.cos(i * 1.3) * 1.05, 0.1, Math.sin(i * 1.3) * 1.05); const st = []; for (let i = 0; i < 4; i++) { const s = part(g, G.ball(0.3, 1), '#ffffff', 0, 0.5 + i * 0.5, 0, { outline: false }); s.material = new THREE.MeshToonMaterial({ color: '#ffffff', gradientMap: gradTex, transparent: true, opacity: 0.8 }); st.push(s); } anims.push((t) => st.forEach((s, i) => { const f = (t * 0.4 + i / 4) % 1; s.position.y = 0.3 + f * 2.2; s.scale.setScalar(0.6 + f * 1.2); s.material.opacity = 0.85 * (1 - f); })); },
  onion(g) { part(g, G.box(1.4, 1.1, 1.4), '#e9e2d0', 0, 0.55, 0); [[0, 1.6, 0, '#e63946', 0.42], [0.55, 1.35, 0.55, '#2a9d8f', 0.28], [-0.55, 1.35, 0.55, '#ffcf5a', 0.28], [0.55, 1.35, -0.55, '#3a86ff', 0.28], [-0.55, 1.35, -0.55, '#7cc35a', 0.28]].forEach(([x, y, z, c, r]) => { part(g, G.cyl(r * 0.6, r * 0.6, 0.4, 10), '#f4efe6', x, y - 0.25, z); part(g, G.sph(r, 12, 10), c, x, y + r * 0.3, z, { s: [1, 1.2, 1] }); part(g, G.cone(r * 0.3, r * 0.9, 8), '#ffcf5a', x, y + r * 1.6, z); }); },
  piles(g) { for (let i = 0; i < 8; i++) part(g, G.cyl(0.05, 0.05, 0.6, 6), '#7d7a78', -0.75 + (i % 4) * 0.5, 0.3, i < 4 ? -0.45 : 0.45, { thin: true }); part(g, G.box(1.9, 1.0, 1.2), '#9aa7b8', 0, 1.1, 0); for (let i = 0; i < 4; i++) part(g, G.box(0.25, 0.3, 0.02), '#ffe9a8', -0.66 + i * 0.44, 1.15, 0.61, { outline: false }); part(g, G.box(2.0, 0.12, 1.3), '#ffffff', 0, 1.66, 0); },
  igloo(g) { part(g, G.sph(0.95, 18, 10, 0, Math.PI / 2), '#f4fbff', 0, 0, 0); part(g, G.cyl(0.35, 0.35, 0.6, 12, 1), '#eaf6ff', 0, 0.2, 0.95, { r: [Math.PI / 2, 0, 0], s: [1, 1, 1] }); part(g, G.box(0.36, 0.3, 0.05), '#3a4a5a', 0, 0.15, 1.25, { outline: false }); for (let i = 0; i < 3; i++) dog(g, 1.3 + i * 0.35, -0.6 + i * 0.1); },
  pivot(g) { part(g, G.cyl(1.8, 1.8, 0.05, 28), '#7cc35a', 0, 0.03, 0, { outline: false }); part(g, G.cyl(1.0, 1.0, 0.05, 20), '#d9c46a', 2.4, 0.03, 1.4, { outline: false }); const arm = new THREE.Group(); g.add(arm); part(arm, G.box(1.8, 0.06, 0.06), '#c9d3dd', 0.9, 0.45, 0, { thin: true }); for (let x = 0.3; x <= 1.8; x += 0.5) part(arm, G.cyl(0.02, 0.02, 0.45, 4), '#c9d3dd', x, 0.22, 0, { outline: false }); part(g, G.cyl(0.08, 0.08, 0.5, 6), '#8a9aa8', 0, 0.25, 0); anims.push((t) => (arm.rotation.y = t * 0.3)); for (let i = 0; i < 6; i++) part(g, G.cyl(0.04, 0.03, 0.5, 5), '#e3c94a', -1.0 + Math.cos(i) * 0.5, 0.25, -0.5 + Math.sin(i) * 0.5, { outline: false }); },
  salt(g) { for (let i = 0; i < 19; i++) { const a = i * 2.4, r = Math.sqrt(i) * 0.55; part(g, G.cyl(0.28, 0.28, 0.04, 6), i % 2 ? '#ffffff' : '#eef6fb', Math.cos(a) * r, 0.02, Math.sin(a) * r, { outline: false }); } part(g, G.cone(0.25, 0.4, 6), '#ffffff', 0.4, 0.2, 0.2); part(g, G.cone(0.2, 0.32, 6), '#ffffff', -0.3, 0.16, -0.3); },
  observatory(g) { part(g, G.cyl(0.75, 0.75, 0.7, 16), '#f4f4f0', 0, 0.35, 0); part(g, G.sph(0.75, 16, 10, 0, Math.PI / 2), '#e9eef2', 0, 0.7, 0); part(g, G.box(0.25, 0.6, 0.1), '#2b3a55', 0, 1.15, 0.6, { r: [-0.5, 0, 0], outline: false }); part(g, G.cyl(0.4, 0.4, 0.5, 12), '#f4f4f0', 1.4, 0.25, -0.4); part(g, G.sph(0.4, 12, 8, 0, Math.PI / 2), '#e9eef2', 1.4, 0.5, -0.4); },
  rock(g) { part(g, G.ball(1.4, 1), '#c4572c', 0, 0.3, 0, { s: [1.7, 0.6, 1.0] }); },
  baobab(g) { for (const [x, z, s] of [[0, 0, 1], [1.3, -0.6, 0.8], [-1.2, -0.4, 0.9]]) { part(g, G.cyl(0.28 * s, 0.38 * s, 1.9 * s, 10), '#a08068', x, 0.95 * s, z); for (let i = 0; i < 4; i++) part(g, G.ball(0.25 * s, 0), '#6aa84f', x + Math.cos(i * 1.6) * 0.35 * s, 1.95 * s + (i % 2) * 0.12, z + Math.sin(i * 1.6) * 0.35 * s, { thin: true }); } },
  station(g) { for (const [x, z] of [[-0.8, -0.35], [0.8, -0.35], [-0.8, 0.35], [0.8, 0.35]]) part(g, G.cyl(0.05, 0.05, 0.5, 6), '#7d7a78', x, 0.25, z, { thin: true }); part(g, G.box(2.0, 0.7, 0.95), '#f0882e', 0, 0.85, 0); for (let i = 0; i < 4; i++) part(g, G.box(0.25, 0.2, 0.02), '#2f6fd0', -0.7 + i * 0.46, 0.92, 0.48, { outline: false }); part(g, G.cyl(0.02, 0.02, 1.0, 4), '#7d7a78', 0.8, 1.7, 0, { thin: true }); part(g, G.box(0.36, 0.24, 0.02), '#ffffff', 0.98, 2.05, 0, { thin: true }); part(g, G.ball(0.06, 0), '#c0392b', 0.98, 2.05, 0.02, { outline: false }); for (let i = 0; i < 3; i++) penguin(g, -1.4 + i * 0.35, 0.8 - i * 0.15); }
};
function animal(g, x, z, c, opt = {}) {
  const a = new THREE.Group(); a.position.set(x, 0, z); a.rotation.y = opt.ry || 0.6; g.add(a);
  part(a, G.ball(0.25, 1), c, 0, opt.h || 0.42, 0, { s: [1.5, 0.9, 0.9], thin: true });
  for (const [lx, lz] of [[0.22, 0.12], [-0.22, 0.12], [0.22, -0.12], [-0.22, -0.12]]) part(a, G.cyl(0.04, 0.04, (opt.h || 0.42) - 0.05, 5), c, lx, ((opt.h || 0.42) - 0.05) / 2, lz, { thin: true });
  part(a, G.cyl(0.06, 0.08, opt.neck || 0.3, 6), c, 0.38, (opt.h || 0.42) + 0.15, 0, { r: [0, 0, -0.6], thin: true });
  part(a, G.ball(0.12, 1), c, 0.52, (opt.h || 0.42) + 0.32, 0, { s: [1.3, 0.9, 0.9], thin: true });
  return a;
}
function horse(g, x, z) { animal(g, x, z, '#8b5a3c'); }
function cow(g, x, z) { const a = animal(g, x, z, '#ffffff'); part(a, G.ball(0.12, 0), '#2b2118', 0.05, 0.55, 0.15, { outline: false }); }
function camel(g, x, z) { const a = animal(g, x, z, '#d6a660', { h: 0.55, neck: 0.4 }); part(a, G.ball(0.16, 1), '#d6a660', 0, 0.82, 0, { thin: true }); }
function reindeer(g, x, z) { const a = animal(g, x, z, '#8b6b4a'); for (const s of [1, -1]) part(a, G.cyl(0.015, 0.015, 0.3, 4), '#e9dcc6', 0.5, 0.95, 0.07 * s, { r: [0.4 * s, 0, 0.3], outline: false }); }
function dog(g, x, z) { animal(g, x, z, '#9aa7b8', { h: 0.25, neck: 0.15, ry: 1.2 }).scale.setScalar(0.8); }
function penguin(g, x, z) { const p = new THREE.Group(); p.position.set(x, 0, z); g.add(p); part(p, G.ball(0.16, 1), '#2b2b3a', 0, 0.2, 0, { s: [1, 1.5, 1], thin: true }); part(p, G.ball(0.12, 1), '#ffffff', 0, 0.18, 0.06, { s: [0.9, 1.4, 0.8], outline: false }); part(p, G.cone(0.04, 0.08, 5), '#ffa94d', 0, 0.38, 0.14, { r: [Math.PI / 2, 0, 0], outline: false }); }

// 명소 배치
function makeLabel(text, emoji) {
  const cv = document.createElement('canvas'); const g = cv.getContext('2d');
  g.font = '44px Jua, "Gowun Dodum", sans-serif';
  const w = Math.ceil(g.measureText(text).width) + 120; cv.width = w; cv.height = 96;
  g.font = '44px Jua, "Gowun Dodum", sans-serif';
  g.fillStyle = '#fff8e7'; g.strokeStyle = '#5b4636'; g.lineWidth = 5;
  const r = 40; g.beginPath(); g.roundRect(4, 6, w - 8, 84, r); g.fill(); g.stroke();
  g.font = '46px sans-serif'; g.textBaseline = 'middle'; g.fillText(emoji, 18, 50);
  g.font = '44px Jua, "Gowun Dodum", sans-serif'; g.fillStyle = '#5b4636'; g.fillText(text, 84, 52);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false }));
  sp.scale.set((w / 96) * 1.15, 1.15, 1); sp.renderOrder = 5; return sp;
}
function makeEmoji(emoji, ring) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 128; const g = cv.getContext('2d');
  g.fillStyle = '#fff8e7'; g.strokeStyle = ring; g.lineWidth = 10; g.beginPath(); g.arc(64, 64, 54, 0, 7); g.fill(); g.stroke();
  g.font = '64px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(emoji, 64, 70);
  const t = new THREE.CanvasTexture(cv); t.colorSpace = THREE.SRGBColorSpace;
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthWrite: false })); sp.renderOrder = 5; return sp;
}
const UP = new THREE.Vector3(0, 1, 0);
function placeOnGlobe(obj, lat, lon, lift = 0, yaw = 0) {
  const d = llDir(lat, lon, new THREE.Vector3());
  const h = Math.max(0, hDir(d));
  obj.position.copy(d).multiplyScalar(R + h + lift);
  obj.quaternion.setFromUnitVectors(UP, d).multiply(new THREE.Quaternion().setFromAxisAngle(UP, yaw));
  return d;
}
const ringGeo = new THREE.TorusGeometry(2.4, 0.09, 6, 40);
for (const lm of LANDMARKS) {
  const g = new THREE.Group();
  (PROPS[lm.prop] || PROPS.tower)(g, lm.id);
  g.scale.setScalar(0.85);
  lm.dir = placeOnGlobe(g, lm.lat, lm.lon, -0.05, hash(lm.lat * 100, lm.lon * 100) * 6.28);
  scene.add(g);
  const ring = new THREE.Mesh(ringGeo, new THREE.MeshBasicMaterial({ color: '#ffcf5a', transparent: true, opacity: 0.8 }));
  ring.rotation.x = Math.PI / 2; ring.position.y = 0.12; g.add(ring);
  lm.ring = ring;
  lm.label = makeLabel(lm.name, lm.emoji); lm.label.position.set(0, 4.2, 0); g.add(lm.label);
  lm.icon = makeEmoji(lm.emoji, '#e6a23c'); lm.icon.position.set(0, 4.5, 0); lm.icon.visible = false; g.add(lm.icon);
  lm.group = g;
}
function refreshLandmarkLook(lm) {
  const st = save.stars[lm.id], vi = save.visited[lm.id];
  lm.ring.material.color.set(st ? '#7cc35a' : vi ? '#74c0fc' : '#ffcf5a');
}
LANDMARKS.forEach(refreshLandmarkLook);

// 목적지 핀, 지구본 보기용 플레이어 표시
const pin = new THREE.Group(); pin.visible = false; scene.add(pin);
part(pin, G.cone(0.35, 1.0, 10), '#e63946', 0, 0.5, 0, { r: [Math.PI, 0, 0] }); part(pin, G.ball(0.42, 1), '#e63946', 0, 1.25, 0); part(pin, G.ball(0.16, 1), '#ffffff', 0, 1.25, 0.32, { outline: false });
const marker = new THREE.Group(); marker.visible = false; scene.add(marker);
{ const m = new THREE.Mesh(new THREE.TorusGeometry(1.6, 0.35, 8, 32), new THREE.MeshBasicMaterial({ color: '#ffcf5a' })); m.rotation.x = Math.PI / 2; marker.add(m);
  const c = new THREE.Mesh(new THREE.ConeGeometry(1.2, 2.4, 12), new THREE.MeshBasicMaterial({ color: '#ff6b6b' })); c.rotation.x = Math.PI; c.position.y = 3.2; marker.add(c); }

// ---------------------------------------------------------------- 날씨 입자
const WEATHER_N = LOW ? 500 : 900;
const weather = new THREE.Group(); scene.add(weather);
const wPos = new Float32Array(WEATHER_N * 3);
for (let i = 0; i < WEATHER_N; i++) { wPos[i * 3] = (Math.random() - 0.5) * 30; wPos[i * 3 + 1] = Math.random() * 16; wPos[i * 3 + 2] = (Math.random() - 0.5) * 30; }
const wGeo = new THREE.BufferGeometry(); wGeo.setAttribute('position', new THREE.BufferAttribute(wPos, 3));
function dotTex(kind) {
  const cv = document.createElement('canvas'); cv.width = cv.height = 32; const g = cv.getContext('2d');
  if (kind === 'rain') { g.strokeStyle = 'rgba(200,230,255,1)'; g.lineWidth = 3; g.lineCap = 'round'; g.beginPath(); g.moveTo(16, 3); g.lineTo(16, 29); g.stroke(); }
  else { const gr = g.createRadialGradient(16, 16, 0, 16, 16, 15); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.6, 'rgba(255,255,255,.8)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 32, 32); }
  const t = new THREE.CanvasTexture(cv); return t;
}
const wTex = { rain: dotTex('rain'), dot: dotTex('dot') };
const wMat = new THREE.PointsMaterial({ size: 0.35, map: wTex.dot, transparent: true, depthWrite: false, opacity: 0 });
const wPts = new THREE.Points(wGeo, wMat); wPts.frustumCulled = false; weather.add(wPts);
let wKind = 'none', wAmt = 0, wTarget = 0;
function weatherFor(code, lat) {
  if (!code) return ['none', 0];
  if (code === 'Af') return ['rain', 0.9];
  if (code === 'Am') return ['rain', 0.6];
  if (code === 'Aw' || code === 'As') return ['rain', 0.2];
  if (code === 'BWh' || code === 'BWk') return ['dust', 0.55];
  if (code === 'BSh' || code === 'BSk') return ['dust', 0.2];
  if (code === 'Cfb' || code === 'Cfc') return ['rain', 0.3];
  if (code === 'Cfa' || code[1] === 'w' && code[0] === 'C') return ['rain', 0.15];
  if (code[0] === 'D') return ['snow', code[2] === 'c' || code[2] === 'd' ? 0.6 : 0.35];
  if (code === 'ET') return ['snow', 0.5];
  if (code === 'EF') return ['blizzard', 1.0];
  return ['none', 0];
}

// ---------------------------------------------------------------- 상태
const P = new THREE.Vector3(), F = new THREE.Vector3(), tmpV = new THREE.Vector3(), tmpV2 = new THREE.Vector3();
const START = { lat: 36.02, lon: 129.2 };
function resetPos() {
  llDir(START.lat, START.lon, P);
  const target = LANDMARKS[0].dir;
  F.copy(target).addScaledVector(P, -P.dot(target)).normalize();
}
if (save.pos && Array.isArray(save.pos.p) && save.pos.p.length === 3) {
  P.fromArray(save.pos.p).normalize(); F.fromArray(save.pos.f); F.addScaledVector(P, -P.dot(F));
  if (F.lengthSq() < 1e-6) resetPos(); else F.normalize();
} else resetPos();
let alt = Math.max(0, hDir(P)), vy = 0, grounded = true;
let mode = 'walk';           // walk | boat
let ballooning = false, globeView = false, running = false, paused = true;
let camDist = 10, camPitch = 0.42, orbitDist = 290;
const orbitDir = new THREE.Vector3().copy(P);
const camF = new THREE.Vector3().copy(F);
const camPos = new THREE.Vector3(), camLook = new THREE.Vector3(), camUp = new THREE.Vector3().copy(P);
let waypoint = null;          // {dir, name}
let walkPhase = 0;
const keys = {};
const joy = { active: false, id: null, x: 0, y: 0, ox: 0, oy: 0 };

// ---------------------------------------------------------------- 소리
let actx = null;
function tone(freq, dur = 0.12, type = 'sine', vol = 0.12, delay = 0) {
  if (!save.sound) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t0 = actx.currentTime + delay, o = actx.createOscillator(), g = actx.createGain();
    o.type = type; o.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0); g.gain.exponentialRampToValueAtTime(vol, t0 + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(actx.destination); o.start(t0); o.stop(t0 + dur + 0.05);
  } catch (e) {}
}
const sfx = {
  stamp() { tone(660, 0.12, 'triangle'); tone(990, 0.2, 'triangle', 0.12, 0.1); },
  right() { [523, 659, 784, 1046].forEach((f, i) => tone(f, 0.16, 'triangle', 0.12, i * 0.08)); },
  wrong() { tone(220, 0.25, 'square', 0.06); tone(180, 0.3, 'square', 0.05, 0.12); },
  open() { tone(880, 0.08, 'sine', 0.1); tone(1320, 0.1, 'sine', 0.08, 0.06); },
  mission() { [523, 659, 784, 659, 784, 1046].forEach((f, i) => tone(f, 0.18, 'triangle', 0.12, i * 0.1)); },
  jump() { tone(440, 0.1, 'sine', 0.06); tone(660, 0.08, 'sine', 0.05, 0.05); },
  splash() { tone(300, 0.15, 'sine', 0.05); }
};

// ---------------------------------------------------------------- UI 도우미
function toast(html, sub) {
  const el = document.createElement('div'); el.className = 'toast'; el.innerHTML = html + (sub ? `<small>${sub}</small>` : '');
  const box = $('#toasts'); box.appendChild(el);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { el.classList.add('out'); setTimeout(() => el.remove(), 450); }, 3400);
}
function confetti() {
  const em = ['🎉', '⭐', '🌈', '🎊', '✨'];
  for (let i = 0; i < 22; i++) {
    const s = document.createElement('span'); s.className = 'confetti'; s.textContent = em[i % em.length];
    s.style.left = Math.random() * 100 + 'vw'; s.style.animationDuration = 1.8 + Math.random() * 1.6 + 's'; s.style.animationDelay = Math.random() * 0.4 + 's';
    document.body.appendChild(s); setTimeout(() => s.remove(), 4200);
  }
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
function fmtLat(lat) { return `${Math.abs(lat).toFixed(1)}°${lat >= 0 ? 'N' : 'S'}`; }
function fmtLon(lon) { return `${Math.abs(lon).toFixed(1)}°${lon >= 0 ? 'E' : 'W'}`; }
const kmStr = (km) => (km < 1 ? '바로 앞' : `${Math.round(km).toLocaleString('ko-KR')} km`);
const kChip = (code) => `background:${KOPPEN_COLOR[code] || '#ddd'}`;

function climograph(cg) {
  const c = CLIMO[cg]; if (!c) return '';
  const W = 320, H = 170, L = 34, Rr = 34, Tp = 14, B = 24, w = W - L - Rr, h = H - Tp - B;
  const tmin = Math.min(-10, Math.floor(Math.min(...c.t) / 10) * 10), tmax = Math.max(30, Math.ceil(Math.max(...c.t) / 10) * 10);
  const pmax = Math.max(100, Math.ceil(Math.max(...c.p) / 100) * 100);
  const ty = (t) => Tp + h - ((t - tmin) / (tmax - tmin)) * h, py = (p) => Tp + h - (p / pmax) * h, mx = (i) => L + (i + 0.5) * (w / 12);
  let s = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(c.name)} 기후 그래프"><rect x="${L}" y="${Tp}" width="${w}" height="${h}" fill="#fbf6ea" stroke="#ead9b8"/>`;
  for (let t = tmin; t <= tmax; t += 10) { const y = ty(t); s += `<line x1="${L}" x2="${L + w}" y1="${y}" y2="${y}" stroke="#ead9b8" stroke-dasharray="2 3"/><text x="${L - 4}" y="${y + 4}" font-size="10" text-anchor="end" fill="#d9534f">${t}</text>`; }
  for (let i = 0; i <= 4; i++) { const p = (pmax * i) / 4; s += `<text x="${L + w + 4}" y="${py(p) + 4}" font-size="10" fill="#3b82c4">${p}</text>`; }
  c.p.forEach((p, i) => { const bw = w / 12 - 4; s += `<rect x="${mx(i) - bw / 2}" y="${py(p)}" width="${bw}" height="${Tp + h - py(p)}" fill="#7fb8ea" rx="2"/>`; });
  if (tmin < 0 && tmax > 0) s += `<line x1="${L}" x2="${L + w}" y1="${ty(0)}" y2="${ty(0)}" stroke="#c9b8a0"/>`;
  s += `<polyline points="${c.t.map((t, i) => `${mx(i)},${ty(t)}`).join(' ')}" fill="none" stroke="#e05a4f" stroke-width="2.5" stroke-linejoin="round"/>`;
  c.t.forEach((t, i) => (s += `<circle cx="${mx(i)}" cy="${ty(t)}" r="2.8" fill="#e05a4f"/>`));
  for (let i = 0; i < 12; i++) s += `<text x="${mx(i)}" y="${H - 8}" font-size="10" text-anchor="middle" fill="#8a7563">${i + 1}</text>`;
  s += `<text x="4" y="10" font-size="10" fill="#d9534f">℃</text><text x="${W - 4}" y="10" font-size="10" text-anchor="end" fill="#3b82c4">mm</text></svg>`;
  const ty2 = c.t.reduce((a, b) => a + b, 0) / 12, py2 = c.p.reduce((a, b) => a + b, 0);
  return `<div class="climo">${s}<div class="cap">${esc(c.name)} 기후 그래프 · 연평균 약 ${ty2.toFixed(1)}℃ · 연 강수량 약 ${Math.round(py2).toLocaleString('ko-KR')}mm · 연교차 약 ${(Math.max(...c.t) - Math.min(...c.t)).toFixed(0)}℃ (대략적인 평년값)</div></div>`;
}

// ---------------------------------------------------------------- 위치 정보
let here = { lat: 0, lon: 0, code: '', country: '', ocean: '', elev: 0, onWater: false, terrain: '' };
function terrainLabel(lat, lon, code, m) {
  if (code === 'EF') return '빙상(두꺼운 얼음)';
  const m2 = elevMeters(lat + 0.6, lon), m3 = elevMeters(lat - 0.6, lon), m4 = elevMeters(lat, lon + 0.6 / Math.max(0.2, Math.cos(lat * DEG))), m5 = elevMeters(lat, lon - 0.6 / Math.max(0.2, Math.cos(lat * DEG)));
  const relief = Math.max(m, m2, m3, m4, m5) - Math.min(m, m2, m3, m4, m5);
  if (m < 200) return relief > 400 ? '해안·산기슭' : '낮은 평야';
  if (m < 600) return relief > 500 ? '언덕·구릉' : '평야·구릉';
  if (m < 2000) return relief > 700 ? '산지' : '고원';
  if (m < 4000) return relief > 900 ? '높은 산지' : '높은 고원';
  return relief > 900 ? '아주 높은 산(고산 지대)' : '세계의 지붕 같은 고원';
}
function updateHere() {
  const lat = dirLat(P), lon = dirLon(P), ci = cell(lat, lon);
  const k = KC[ci], code = k ? CLASSES[k - 1] : '';
  const onWater = mode === 'boat' || (ballooning && hDir(P) < 0);
  here.lat = lat; here.lon = lon; here.onWater = onWater;
  here.code = onWater ? '' : code;
  here.country = onWater ? '' : countryKo(CT[ci]);
  here.ocean = onWater ? oceanName(lat, lon) : '';
  here.elev = onWater ? 0 : Math.round(elevMeters(lat, lon) / 50) * 50;
  here.terrain = onWater ? (isSeaIce(lat, lon) ? '바다 얼음(해빙) 사이를 항해 중' : '바다 위를 항해 중') : terrainLabel(lat, lon, code, here.elev);
  // HUD
  $('#lPlace').textContent = onWater ? `🌊 ${here.ocean}` : `📍 ${here.country || (lat < -60 ? '남극' : '이름 없는 땅')}`;
  $('#lCoord').textContent = `${fmtLat(lat)} ${fmtLon(lon)}`;
  const chip = $('#lChip');
  if (here.code) {
    chip.textContent = here.code; chip.style.cssText = kChip(here.code);
    $('#lKname').textContent = kname(here.code);
    $('#lKdesc').textContent = (GROUP_INFO[here.code[0]].emoji + ' ') + KOPPEN_INFO[here.code].d;
  } else {
    chip.textContent = '바다'; chip.style.cssText = 'background:#7fd4ec';
    $('#lKname').textContent = '해양';
    $('#lKdesc').textContent = '바다는 땅보다 천천히 데워지고 천천히 식어서 둘레 기후를 부드럽게 해 줘요.';
  }
  $('#lTerrain').textContent = onWater ? here.terrain : `해발 약 ${here.elev.toLocaleString('ko-KR')}m · ${here.terrain}`;
  // 옷차림
  let of = 'mild';
  if (here.code) {
    const gch = here.code[0];
    of = gch === 'A' ? 'hot' : gch === 'B' ? 'dry' : gch === 'C' ? 'mild' : gch === 'D' ? 'cold' : 'polar';
    if (here.elev >= 2800 && gch !== 'E') of = 'alpine';
  } else if (Math.abs(lat) > 60) of = 'polar';
  else of = outfit || 'mild';
  setOutfit(of);
  $('#lOutfit').textContent = OUTFITS[of].label;
  // 날씨
  const [kind, amt] = weatherFor(here.code, lat);
  if (kind !== wKind) { wKind = kind; wMat.map = kind === 'rain' ? wTex.rain : wTex.dot; wMat.color.set(kind === 'dust' ? '#e6c48a' : kind === 'rain' ? '#d8ecff' : '#ffffff'); wMat.size = kind === 'rain' ? 0.5 : kind === 'dust' ? 0.3 : 0.32; wMat.needsUpdate = true; }
  wTarget = amt;
  // 도장
  if (here.code && !save.stamps[here.code]) {
    save.stamps[here.code] = Date.now(); persist(); sfx.stamp();
    toast(`🌈 새 기후 도장! <b style="${kChip(here.code)};padding:0 6px;border-radius:6px">${here.code}</b> ${esc(kname(here.code))}`, GROUP_INFO[here.code[0]].rule);
    updateStats();
  }
}
function updateStats() {
  $('#sStar').textContent = Object.keys(save.stars).length;
  $('#sStamp').textContent = Object.keys(save.stamps).filter((c) => CLASSES.includes(c)).length;
  $('#sVisit').textContent = Object.keys(save.visited).length;
  $('#sVisitMax').textContent = LANDMARKS.length;
}

// ---------------------------------------------------------------- 미션과 길 안내
function missionTarget() {
  if (waypoint) return waypoint;
  const m = MISSIONS[save.mission]; if (!m) return null;
  if (m.type === 'visit') { const lm = LANDMARKS.find((l) => l.id === m.id); return { dir: lm.dir, name: lm.name }; }
  if (m.type === 'elev' || m.type === 'lat') return { dir: llDir(m.lat, m.lon, new THREE.Vector3()), name: m.title };
  if (m.type === 'all') {
    let best = null, bd = -2;
    for (const lm of LANDMARKS) if (!save.stars[lm.id]) { const d = lm.dir.dot(P); if (d > bd) { bd = d; best = lm; } }
    return best ? { dir: best.dir, name: best.name } : null;
  }
  return null;
}
function missionDone(m) {
  if (!m) return false;
  if (m.type === 'visit') return !!save.visited[m.id];
  if (m.type === 'elev') return !here.onWater && here.elev >= m.value;
  if (m.type === 'lat') return here.lat >= m.value;
  if (m.type === 'stamps') return Object.keys(save.stamps).length >= m.value;
  if (m.type === 'all') return LANDMARKS.every((l) => save.stars[l.id]);
  return false;
}
function renderMission() {
  const m = MISSIONS[save.mission];
  if (waypoint) { $('#mTitle').textContent = `📍 ${waypoint.name}`; $('#mHint').textContent = '목적지로 가는 중 · 지도를 다시 누르면 바꿀 수 있어요'; }
  else if (m) { $('#mTitle').textContent = `미션 ${save.mission + 1}/${MISSIONS.length} · ${m.title}`; $('#mHint').textContent = m.hint; }
  else { $('#mTitle').textContent = '🏆 모든 미션 완료!'; $('#mHint').textContent = '지구 어디든 자유롭게 탐험해요.'; }
}
function checkMission() {
  const m = MISSIONS[save.mission];
  if (m && missionDone(m)) {
    save.mission++; persist(); sfx.mission(); confetti();
    toast(`🏅 미션 완료! ${esc(m.title)}`, MISSIONS[save.mission] ? `다음: ${MISSIONS[save.mission].title}` : '모든 미션을 마쳤어요!');
    renderMission();
  }
  if (waypoint && waypoint.dir.dot(P) > Math.cos(2.0 / R)) { toast(`📍 목적지 도착: ${esc(waypoint.name)}`); waypoint = null; pin.visible = false; renderMission(); }
}
function setWaypoint(dir, name) {
  waypoint = { dir: dir.clone().normalize(), name };
  const lat = dirLat(waypoint.dir), lon = dirLon(waypoint.dir);
  placeOnGlobe(pin, lat, lon, 0.1); pin.visible = true;
  renderMission(); tone(700, 0.08);
}
function updateArrow() {
  const tg = missionTarget(); const ar = $('#arrow svg');
  if (!tg) { $('#mDist').textContent = ''; ar.style.opacity = 0.25; return; }
  ar.style.opacity = 1;
  const d = tmpV.copy(tg.dir).addScaledVector(P, -P.dot(tg.dir));
  const right = tmpV2.crossVectors(F, P);
  const ang = Math.atan2(d.dot(right), d.dot(F));
  ar.style.transform = `rotate(${ang}rad)`;
  const km = Math.acos(clamp(P.dot(tg.dir), -1, 1)) * 6371;
  $('#mDist').textContent = `목표까지 ${kmStr(km)}`;
}

// ---------------------------------------------------------------- 정보 카드
let openLm = null;
function openCard(lm) {
  openLm = lm; paused = true;
  const first = !save.visited[lm.id];
  if (first) { save.visited[lm.id] = Date.now(); persist(); updateStats(); refreshLandmarkLook(lm); }
  const ci = cell(lm.lat, lm.lon), k = KC[ci], code = k ? CLASSES[k - 1] : '';
  const em = Math.round(elevMeters(lm.lat, lm.lon) / 50) * 50;
  const done = !!save.stars[lm.id];
  $('#cardSheet').innerHTML = `
    <button class="btn close" data-close aria-label="닫기">✕</button>
    <div class="lmhead"><div class="em">${lm.emoji}</div><div><h2 id="cName">${esc(lm.name)}</h2><div class="ct">${esc(lm.country)} · ${fmtLat(lm.lat)} ${fmtLon(lm.lon)}</div></div></div>
    <div class="facts">${code ? `<span style="${kChip(code)}">${code} ${esc(kname(code))}</span>` : ''}<span>⛰ 해발 약 ${em.toLocaleString('ko-KR')}m</span><span>${GROUP_INFO[code[0]] ? GROUP_INFO[code[0]].emoji + ' ' + GROUP_INFO[code[0]].name : ''}</span></div>
    <p>${esc(lm.body)}</p>
    ${lm.note ? `<div class="note">💡 ${esc(lm.note)}</div>` : ''}
    ${lm.cg ? climograph(lm.cg) : ''}
    <div class="quiz" id="quiz">
      <div class="qq">❓ ${esc(lm.q)} ${done ? '<span style="color:#4f9150">⭐ 별 받음</span>' : ''}</div>
      <div class="opts">${lm.o.map((o, i) => `<button data-opt="${i}">${['①', '②', '③'][i]} ${esc(o)}</button>`).join('')}</div>
      <div class="fb" id="qfb" aria-live="polite"></div>
    </div>
    <div class="actions"><button class="btn" data-guide>📖 도감 열기</button><button class="btn primary" data-close>계속 탐험하기</button></div>`;
  $('#card').hidden = false; sfx.open();
  $('#cardSheet').querySelector('[data-opt]').focus({ preventScroll: true });
}
$('#card').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (e.target === $('#card') || (t && t.hasAttribute('data-close'))) return closeCard();
  if (t && t.hasAttribute('data-guide')) { closeCard(); openBook('lm'); return; }
  if (t && t.dataset.opt != null && openLm) {
    const lm = openLm, i = +t.dataset.opt, ok = i === lm.a;
    const btns = [...$('#cardSheet').querySelectorAll('[data-opt]')];
    btns.forEach((b) => b.classList.remove('right', 'wrong'));
    t.classList.add(ok ? 'right' : 'wrong');
    if (ok) {
      btns.forEach((b) => (b.disabled = true));
      const firstStar = !save.stars[lm.id];
      if (firstStar) { save.stars[lm.id] = Date.now(); persist(); updateStats(); refreshLandmarkLook(lm); }
      sfx.right();
      $('#qfb').innerHTML = `<b style="color:#4f9150">정답이에요! ${firstStar ? '⭐ 별 1개를 받았어요.' : ''}</b> ${esc(lm.why)}`;
      if (firstStar) confetti();
    } else { sfx.wrong(); $('#qfb').innerHTML = `<b style="color:#c0613a">다시 생각해 봐요.</b> 본문을 다시 읽으면 힌트가 있어요.`; }
  }
});
function closeCard() { $('#card').hidden = true; openLm = null; paused = false; canvas.focus({ preventScroll: true }); }

// ---------------------------------------------------------------- 도감
let bookTab = 'k';
function openBook(tab) {
  if (tab) bookTab = tab; paused = true;
  const tabs = [['k', '🌈 기후 도장'], ['lm', '🏛 문화 명소'], ['m', '🏅 미션'], ['i', 'ℹ️ 정보']];
  let html = `<button class="btn close" data-close aria-label="닫기">✕</button><h2>📖 탐험 도감</h2>
    <div class="tabs">${tabs.map(([k, n]) => `<button class="btn ${bookTab === k ? 'on' : ''}" data-tab="${k}">${n}</button>`).join('')}</div>`;
  if (bookTab === 'k') {
    const n = Object.keys(save.stamps).length;
    html += `<p>지금까지 <b>${n}</b> / 31가지 기후를 밟았어요. 쾨펜 기후 구분은 기온과 강수량으로 세계 기후를 나눠요.</p>`;
    for (const gk of 'ABCDE') {
      const gi = GROUP_INFO[gk];
      html += `<div class="ggroup">${gi.emoji} ${gk} ${gi.name}<small>${gi.rule}</small></div><div class="note" style="margin:4px 0 6px">${gi.life}</div><div class="stamps">`;
      for (const c of KOPPEN_ORDER.filter((c) => c[0] === gk)) {
        const got = !!save.stamps[c];
        html += `<div class="stamp ${got ? '' : 'no'}"><b style="${kChip(c)}">${c}</b>${got ? '' : '❔ '}${esc(kname(c))}<br><span style="color:#8a7563">${esc(KOPPEN_INFO[c].d)}</span></div>`;
      }
      html += `</div>`;
    }
  } else if (bookTab === 'lm') {
    html += `<p>방문 ${Object.keys(save.visited).length} / ${LANDMARKS.length} · 별 ${Object.keys(save.stars).length}개. <b>안내</b>를 누르면 그곳을 목적지로 정해요.</p><div class="lmlist">`;
    for (const lm of LANDMARKS) {
      const vi = save.visited[lm.id], st = save.stars[lm.id];
      html += `<div class="lmrow"><div class="em">${vi ? lm.emoji : '❔'}</div><div class="nm">${esc(lm.name)} ${st ? '⭐' : ''}<small>${esc(lm.country)} · ${fmtLat(lm.lat)} ${fmtLon(lm.lon)}</small></div>
        ${vi ? `<button class="btn" data-read="${lm.id}">읽기</button>` : ''}<button class="btn" data-go="${lm.id}">안내</button></div>`;
    }
    html += `</div>`;
  } else if (bookTab === 'm') {
    html += `<ol class="mlist">${MISSIONS.map((m, i) => `<li class="${i < save.mission ? 'done' : i === save.mission ? 'cur' : ''}">${i < save.mission ? '✅' : i === save.mission ? '👉' : '⬜'} ${esc(m.title)}</li>`).join('')}</ol>`;
  } else {
    html += `<h3>이 지구본은 무엇으로 만들었나요?</h3>
      <p>땅의 색은 위도·경도 0.5° 간격의 쾨펜-가이거 기후 구분 자료, 높낮이는 위성으로 잰 지형 고도 자료, 나라 경계는 Natural Earth 지도 자료로 그렸어요. 산의 높이는 잘 보이도록 실제보다 약 ${Math.round((EX * R * 6371) / (R * 8.85) / 10) * 10}배 과장했어요. 게임 속 1걸음 거리는 실제로 약 ${Math.round(KM)}km예요.</p>
      <p>위선: <span style="color:#e05a4f">적도</span> · <span style="color:#e0902e">남·북회귀선(23.5°)</span> · <span style="color:#3b82c4">남·북극권(66.5°)</span>이 점선으로 그려져 있어요.</p>
      <h3>지도 색 읽기</h3><div class="stamps">${KOPPEN_ORDER.filter((c, i) => 'Af Aw BWh BSk Csa Cfa Cfb Dwa Dfc ET EF'.split(' ').includes(c)).map((c) => `<div class="stamp"><b style="${kChip(c)}">${c}</b>${esc(kname(c))}</div>`).join('')}</div>
      <h3>만든 자료</h3><p class="credits">기후 구분: 쾨펜-가이거 0.5° 격자(koppen-climate-lookup, ISC 라이선스) · 지형 고도: NASA 지형 영상(three-globe 예제 이미지, MIT) · 국경: Natural Earth 1:110m(world-atlas, ISC) · 3D 엔진: three.js(MIT). 기후 그래프와 명소 설명은 학습용으로 단순화한 값이에요.</p>
      <div class="actions"><button class="btn" data-resetall>진행 기록 지우기</button></div>`;
  }
  $('#bookSheet').innerHTML = html;
  $('#book').hidden = false;
}
$('#book').addEventListener('click', (e) => {
  const t = e.target.closest('button');
  if (e.target === $('#book') || (t && t.hasAttribute('data-close'))) { $('#book').hidden = true; paused = false; canvas.focus({ preventScroll: true }); return; }
  if (!t) return;
  if (t.dataset.tab) openBook(t.dataset.tab);
  if (t.dataset.read) { $('#book').hidden = true; openCard(LANDMARKS.find((l) => l.id === t.dataset.read)); }
  if (t.dataset.go) { const lm = LANDMARKS.find((l) => l.id === t.dataset.go); setWaypoint(lm.dir, lm.name); $('#book').hidden = true; paused = false; toast(`📍 ${esc(lm.name)}(으)로 안내할게요`); }
  if (t.hasAttribute('data-resetall') && confirm('모든 진행 기록(도장·별·미션)을 지울까요?')) { save = blankSave(); persist(); location.reload(); }
});

// ---------------------------------------------------------------- 미니맵
const mini = $('#mini'), mg = mini.getContext('2d');
const miniBase = (() => {
  const cv = document.createElement('canvas'); cv.width = 440; cv.height = 220; const g = cv.getContext('2d');
  const im = g.createImageData(440, 220), d = im.data, sea = hex('#4aa3e6'), ice = hex('#dfeef6');
  for (let y = 0; y < 220; y++) for (let x = 0; x < 440; x++) {
    const lat = 90 - ((y + 0.5) / 220) * 180, lon = -180 + ((x + 0.5) / 440) * 360, k = KC[cell(lat, lon)];
    const c = k ? KRGB[k - 1] : isSeaIce(lat, lon) ? ice : sea, o = (y * 440 + x) * 4;
    d[o] = c[0]; d[o + 1] = c[1]; d[o + 2] = c[2]; d[o + 3] = 255;
  }
  g.putImageData(im, 0, 0);
  g.setLineDash([4, 4]); g.lineWidth = 1;
  for (const [la, col] of LAT_LINES) { const y = ((90 - la) / 180) * 220; g.strokeStyle = col; g.beginPath(); g.moveTo(0, y); g.lineTo(440, y); g.stroke(); }
  return cv;
})();
const mxy = (lat, lon) => [((lon + 180) / 360) * 440, ((90 - lat) / 180) * 220];
function drawMini() {
  mg.drawImage(miniBase, 0, 0);
  for (const lm of LANDMARKS) {
    const [x, y] = mxy(lm.lat, lm.lon);
    mg.fillStyle = save.stars[lm.id] ? '#4f9150' : save.visited[lm.id] ? '#2f6fd0' : '#ffcf5a';
    mg.strokeStyle = '#5b4636'; mg.lineWidth = 1.5; mg.setLineDash([]);
    mg.beginPath(); mg.arc(x, y, 4, 0, 7); mg.fill(); mg.stroke();
  }
  const tg = missionTarget();
  if (tg) { const [x, y] = mxy(dirLat(tg.dir), dirLon(tg.dir)); mg.strokeStyle = '#e63946'; mg.lineWidth = 3; mg.beginPath(); mg.arc(x, y, 9 + Math.sin(performance.now() / 200) * 2, 0, 7); mg.stroke(); }
  const [px, py] = mxy(here.lat, here.lon);
  const east = tmpV.set(Math.cos(here.lon * DEG), 0, -Math.sin(here.lon * DEG));
  const north = tmpV2.crossVectors(P, east);
  const a = Math.atan2(F.dot(east), F.dot(north));
  mg.save(); mg.translate(px, py); mg.rotate(a);
  mg.fillStyle = '#ff3b3b'; mg.strokeStyle = '#fff'; mg.lineWidth = 2.5;
  mg.beginPath(); mg.moveTo(0, -11); mg.lineTo(7, 7); mg.lineTo(0, 3); mg.lineTo(-7, 7); mg.closePath(); mg.stroke(); mg.fill(); mg.restore();
}
mini.addEventListener('pointerdown', (e) => {
  e.stopPropagation(); e.preventDefault();
  const r = mini.getBoundingClientRect(), lon = ((e.clientX - r.left) / r.width) * 360 - 180, lat = 90 - ((e.clientY - r.top) / r.height) * 180;
  let best = null, bd = 1e9;
  for (const lm of LANDMARKS) { const d = (lm.lat - lat) ** 2 + ((lm.lon - lon) * 0.7) ** 2; if (d < bd) { bd = d; best = lm; } }
  if (best && bd < 16) setWaypoint(best.dir, best.name);
  else {
    const k = KC[cell(lat, lon)];
    setWaypoint(llDir(lat, lon, new THREE.Vector3()), k ? `${countryKo(CT[cell(lat, lon)]) || '이곳'} (${CLASSES[k - 1]})` : oceanName(lat, lon));
  }
});

// ---------------------------------------------------------------- 입력
const isTyping = () => !$('#card').hidden || !$('#book').hidden || !$('#start').hidden;
addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { if (!$('#card').hidden) closeCard(); else if (!$('#book').hidden) { $('#book').hidden = true; paused = false; } return; }
  if (isTyping()) return;
  const k = e.key.toLowerCase();
  keys[e.code] = true;
  if (e.code === 'Space') { e.preventDefault(); doJump(); }
  if (k === 'm') toggleGlobe();
  if (k === 'b') toggleBalloon();
  if (k === 'j') openBook();
  if (k === '+' || k === '=') zoom(-1);
  if (k === '-' || k === '_') zoom(1);
  if (e.code.startsWith('Arrow')) e.preventDefault();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
addEventListener('blur', () => { for (const k in keys) keys[k] = false; });
function zoom(dir) { if (globeView) orbitDist = clamp(orbitDist * (dir > 0 ? 1.15 : 0.87), 140, 520); else camDist = clamp(camDist * (dir > 0 ? 1.2 : 0.83), 4, 60); }
canvas.addEventListener('wheel', (e) => { e.preventDefault(); const f = Math.exp(e.deltaY * 0.0012); if (globeView) orbitDist = clamp(orbitDist * f, 140, 520); else camDist = clamp(camDist * f, 4, 60); }, { passive: false });
const pointers = new Map(); let pinch0 = 0, dragMoved = 0;
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY, sx: e.clientX, sy: e.clientY });
  dragMoved = 0;
  if (e.pointerType === 'touch' && !globeView && !joy.active && e.clientX < innerWidth * 0.45 && e.clientY > innerHeight * 0.35) {
    joy.active = true; joy.id = e.pointerId; joy.ox = e.clientX; joy.oy = e.clientY; joy.x = joy.y = 0;
    const j = $('#joy'); j.hidden = false; j.style.left = e.clientX + 'px'; j.style.top = e.clientY + 'px'; $('#knob').style.transform = '';
  }
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; pinch0 = Math.hypot(a.x - b.x, a.y - b.y); }
});
canvas.addEventListener('pointermove', (e) => {
  const p = pointers.get(e.pointerId); if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y; p.x = e.clientX; p.y = e.clientY;
  dragMoved += Math.abs(dx) + Math.abs(dy);
  if (joy.active && e.pointerId === joy.id) {
    let jx = (e.clientX - joy.ox) / 50, jy = (e.clientY - joy.oy) / 50; const l = Math.hypot(jx, jy); if (l > 1) { jx /= l; jy /= l; }
    joy.x = jx; joy.y = jy; $('#knob').style.transform = `translate(${jx * 34}px,${jy * 34}px)`; return;
  }
  if (pointers.size === 2) {
    const [a, b] = [...pointers.values()]; const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (pinch0 > 0) { const f = pinch0 / d; if (globeView) orbitDist = clamp(orbitDist * f, 140, 520); else camDist = clamp(camDist * f, 4, 60); }
    pinch0 = d; return;
  }
  if (paused) return;
  if (globeView) {
    const right = tmpV.crossVectors(camUp, orbitDir).normalize();
    orbitDir.applyAxisAngle(camUp, -dx * 0.005).applyAxisAngle(right, dy * 0.005).normalize();
  } else {
    turn(-dx * 0.006);
    camPitch = clamp(camPitch + dy * 0.004, 0.08, 1.35);
  }
});
function endPointer(e) {
  const p = pointers.get(e.pointerId);
  pointers.delete(e.pointerId);
  if (joy.active && e.pointerId === joy.id) { joy.active = false; joy.x = joy.y = 0; $('#joy').hidden = true; }
  if (p && globeView && dragMoved < 8 && e.type === 'pointerup') globeClick(e.clientX, e.clientY);
  if (pointers.size < 2) pinch0 = 0;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
const ray = new THREE.Raycaster();
function globeClick(x, y) {
  ray.setFromCamera(new THREE.Vector2((x / innerWidth) * 2 - 1, -(y / innerHeight) * 2 + 1), camera);
  const o = ray.ray.origin, d = ray.ray.direction, b = o.dot(d), c = o.dot(o) - R * R, disc = b * b - c;
  if (disc < 0) return;
  const hit = o.clone().addScaledVector(d, -b - Math.sqrt(disc)).normalize();
  let best = null, bd = Math.cos(4 * DEG);
  for (const lm of LANDMARKS) { const dd = lm.dir.dot(hit); if (dd > bd) { bd = dd; best = lm; } }
  if (best) setWaypoint(best.dir, best.name);
  else { const lat = dirLat(hit), lon = dirLon(hit), k = KC[cell(lat, lon)]; setWaypoint(hit, k ? `${countryKo(CT[cell(lat, lon)]) || '이곳'} (${CLASSES[k - 1]})` : oceanName(lat, lon)); }
  toast(`📍 목적지를 정했어요: ${esc(waypoint.name)}`, '🌍 버튼을 눌러 다시 걸어가요');
}
function turn(a) {
  const left = tmpV.crossVectors(P, F);
  F.multiplyScalar(Math.cos(a)).addScaledVector(left, Math.sin(a)).normalize();
}
function doJump() { if (grounded && !ballooning && mode === 'walk') { vy = 5.5; grounded = false; sfx.jump(); } }
function toggleBalloon() {
  ballooning = !ballooning; $('#bBalloon').classList.toggle('on', ballooning);
  toast(ballooning ? '🎈 열기구를 탔어요! 빠르게 날아가요' : '🎈 열기구에서 내렸어요');
}
function toggleGlobe() {
  globeView = !globeView; $('#bGlobe').classList.toggle('on', globeView);
  if (globeView) { orbitDir.copy(P); camUp.copy(tmpV.set(0, 1, 0)); $('#hint').textContent = '끌어서 돌리기 · 누르면 그곳을 목적지로 · 🌍 버튼으로 돌아가기'; }
  else $('#hint').textContent = '';
}
$('#bGlobe').onclick = toggleGlobe;
$('#bBalloon').onclick = toggleBalloon;
$('#bBook').onclick = () => openBook();
$('#zIn').onclick = () => zoom(-1);
$('#zOut').onclick = () => zoom(1);
$('#bSound').onclick = () => { save.sound = !save.sound; persist(); $('#bSound').textContent = save.sound ? '🔊' : '🔇'; };
$('#bSound').textContent = save.sound ? '🔊' : '🔇';
$('#tJump').addEventListener('pointerdown', (e) => { e.preventDefault(); doJump(); });
$('#tRun').addEventListener('pointerdown', (e) => { e.preventDefault(); running = !running; $('#tRun').classList.toggle('on', running); });
$('#locToggle').onclick = () => { const o = $('#loc').classList.toggle('open'); $('#locToggle').textContent = o ? '접기' : '더 보기'; };

// ---------------------------------------------------------------- 게임 루프
const clock = new THREE.Clock();
let tick = 0, lastHud = 0;
const frameUp = new THREE.Vector3(), basisX = new THREE.Vector3(), mtx = new THREE.Matrix4();
function step(dt) {
  let fwd = 0, trn = 0;
  if (!paused && !globeView) {
    if (keys.KeyW || keys.ArrowUp) fwd += 1;
    if (keys.KeyS || keys.ArrowDown) fwd -= 0.6;
    if (keys.KeyA || keys.ArrowLeft) trn += 1;
    if (keys.KeyD || keys.ArrowRight) trn -= 1;
    if (joy.active) { fwd += clamp(-joy.y * 1.3, -0.6, 1); trn += clamp(-joy.x * 1.2, -1, 1); }
  }
  fwd = clamp(fwd, -1, 1); trn = clamp(trn, -1, 1);
  const run = running || keys.ShiftLeft || keys.ShiftRight;
  if (trn) turn(trn * 2.3 * dt);
  const gH = hDir(P);
  const onWater = gH < -0.05;
  mode = onWater && !ballooning ? 'boat' : 'walk';
  let speed = ballooning ? (run ? 22 : 13) : mode === 'boat' ? (run ? 14 : 8) : run ? 9 : 5;
  if (fwd && mode === 'walk' && !ballooning) {
    // 오르막은 느리게
    const ahead = tmpV.copy(P).addScaledVector(F, (0.5 * Math.sign(fwd)) / R).normalize();
    const slope = (Math.max(0, hDir(ahead)) - Math.max(0, gH)) / 0.5;
    speed *= clamp(1 - Math.max(0, slope) * 0.6, 0.4, 1);
  }
  if (fwd) {
    const a = (fwd * speed * dt) / R;
    const np = tmpV.copy(P).multiplyScalar(Math.cos(a)).addScaledVector(F, Math.sin(a));
    F.multiplyScalar(Math.cos(a)).addScaledVector(P, -Math.sin(a));
    P.copy(np).normalize();
    F.addScaledVector(P, -P.dot(F)).normalize();
  }
  // 높이
  const surface = onWater ? 0.06 : gH;
  if (ballooning) { alt += (Math.max(0, gH) + 6.5 - alt) * Math.min(1, dt * 2); vy = 0; grounded = false; }
  else {
    vy -= 16 * dt; alt += vy * dt;
    if (alt <= surface) { if (!grounded && vy < -3 && onWater) sfx.splash(); alt = surface; vy = 0; grounded = true; }
    else if (alt - surface < 0.05 && vy <= 0) grounded = true; else grounded = false;
  }
  // 걷기 동작
  const moving = Math.abs(fwd) > 0.05;
  walkPhase += dt * (moving ? (run ? 15 : 10) : 0);
  const sw = mode === 'walk' && !ballooning && moving && grounded ? Math.sin(walkPhase) * 0.7 : 0;
  legL.rotation.x = sw; legR.rotation.x = -sw; armL.rotation.x = -sw * 0.8; armR.rotation.x = sw * 0.8;
  body.position.y = mode === 'walk' && moving && grounded ? Math.abs(Math.sin(walkPhase)) * 0.06 : 0;
  boat.visible = mode === 'boat'; balloon.visible = ballooning;
  if (mode === 'boat' && !ballooning) { body.position.y = 0.05; legL.rotation.x = legR.rotation.x = 0; }
  const bob = mode === 'boat' ? Math.sin(tick * 3) * 0.05 : 0;
  frameUp.copy(P);
  basisX.crossVectors(frameUp, F);
  mtx.makeBasis(basisX, frameUp, F);
  player.quaternion.setFromRotationMatrix(mtx);
  player.position.copy(P).multiplyScalar(R + alt + bob);
  if (mode === 'boat') player.rotateZ(Math.sin(tick * 2.2) * 0.06);
  player.scale.setScalar(1);
}
function updateCamera(dt) {
  const k = 1 - Math.exp(-dt * (globeView ? 3.5 : 6));
  let tPos, tLook, tUp;
  if (globeView) {
    tPos = tmpV.copy(orbitDir).multiplyScalar(orbitDist); tLook = tmpV2.set(0, 0, 0); tUp = UP;
  } else {
    camF.lerp(F, 1 - Math.exp(-dt * 5)); camF.addScaledVector(P, -P.dot(camF));
    if (camF.lengthSq() < 1e-6) camF.copy(F); camF.normalize();
    const d = camDist * (ballooning ? 1.5 : 1);
    tPos = tmpV.copy(player.position).addScaledVector(P, Math.sin(camPitch) * d + 1.0).addScaledVector(camF, -Math.cos(camPitch) * d);
    // 땅 아래로 들어가지 않게
    const cr = tPos.length(), cd = tPos.clone().divideScalar(cr), minR = R + Math.max(0, hDir(cd)) + 0.8;
    if (cr < minR) tPos.multiplyScalar(minR / cr);
    tLook = tmpV2.copy(player.position).addScaledVector(P, 0.9).addScaledVector(camF, 1.2);
    tUp = P;
  }
  camPos.lerp(tPos, k); camLook.lerp(tLook, k); camUp.lerp(tUp, k).normalize();
  camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camLook);
  // 햇빛은 카메라 왼쪽 위에서
  const camR = tmpV.setFromMatrixColumn(camera.matrixWorld, 0), camU = tmpV2.setFromMatrixColumn(camera.matrixWorld, 1);
  sun.position.copy(camLook).addScaledVector(camU, 60).addScaledVector(camR, -35).add(camera.position.clone().sub(camLook).normalize().multiplyScalar(40));
  sun.target.position.copy(camLook);
}
function updateWorld(dt) {
  tick += dt;
  clouds.rotation.y += dt * 0.004;
  for (const f of anims) f(tick);
  const camDistC = camera.position.length();
  // 명소 표시
  for (const lm of LANDMARKS) {
    const dd = lm.group.position.distanceTo(player.position);
    if (globeView || camDistC > R + 60) {
      lm.label.visible = false; lm.icon.visible = true; lm.icon.scale.setScalar(Math.max(3, camDistC / 28));
      lm.icon.position.y = 4 + camDistC / 40;
    } else {
      lm.label.visible = dd > 7 && dd < 45; lm.icon.visible = dd >= 45 && dd < 120; lm.icon.scale.setScalar(3.2);
      lm.icon.position.y = 4.5 + Math.sin(tick * 2 + lm.lat) * 0.3;
      lm.label.position.y = 4.2 + Math.sin(tick * 2 + lm.lat) * 0.25;
    }
    lm.ring.material.opacity = 0.55 + 0.35 * Math.sin(tick * 3 + lm.lon);
  }
  marker.visible = globeView || camDistC > R + 60;
  if (marker.visible) { marker.position.copy(P).multiplyScalar(R + Math.max(0, hDir(P)) + 1); marker.quaternion.setFromUnitVectors(UP, P); marker.scale.setScalar(Math.max(1, camDistC / 120)); }
  if (pin.visible) pin.scale.setScalar(globeView ? 4 : 1.6);
  // 날씨
  wAmt += (wTarget - wAmt) * Math.min(1, dt * 1.5);
  wMat.opacity = Math.min(0.9, wAmt * 1.2) * (globeView ? 0 : 1);
  weather.position.copy(player.position); weather.quaternion.copy(player.quaternion);
  const fall = wKind === 'rain' ? 22 : wKind === 'dust' ? 0.6 : wKind === 'blizzard' ? 5 : 2.2;
  const drift = wKind === 'dust' ? 5 : wKind === 'blizzard' ? 9 : 0.6;
  const visN = Math.floor(WEATHER_N * clamp(wAmt, 0, 1));
  wGeo.setDrawRange(0, visN);
  for (let i = 0; i < visN; i++) {
    let y = wPos[i * 3 + 1] - fall * dt * (0.7 + (i % 5) * 0.1);
    let x = wPos[i * 3] + drift * dt * (0.6 + (i % 3) * 0.2) + (wKind === 'snow' ? Math.sin(tick * 1.5 + i) * dt * 0.8 : 0);
    if (y < -1) y += 17; if (x > 15) x -= 30;
    wPos[i * 3 + 1] = y; wPos[i * 3] = x;
  }
  wGeo.attributes.position.needsUpdate = true;
}
function nearLandmarks() {
  if (window.__noCards || paused || globeView || ballooning) return;
  for (const lm of LANDMARKS) {
    const d = lm.dir.dot(P);
    if (d > Math.cos(2.6 / R)) { if (!lm.cool) { lm.cool = true; openCard(lm); return; } }
    else if (d < Math.cos(4.5 / R)) lm.cool = false;
  }
}
function loop() {
  requestAnimationFrame(loop);
  const dt = Math.min(0.05, clock.getDelta());
  step(dt);
  updateCamera(dt);
  updateWorld(dt);
  const now = performance.now();
  if (now - lastHud > 140 && !$('#hud').hidden) {
    lastHud = now; updateHere(); checkMission(); updateArrow(); drawMini(); nearLandmarks();
    saveTimer += 1;
    if (saveTimer > 20) { saveTimer = 0; save.pos = { p: P.toArray(), f: F.toArray() }; persist(); }
  }
  renderer.render(scene, camera);
}

// ---------------------------------------------------------------- 시작
for (const lm of LANDMARKS) if (lm.dir.dot(P) > Math.cos(2.6 / R)) lm.cool = true;
camPos.copy(P).multiplyScalar(R + 60); camLook.copy(P).multiplyScalar(R); camUp.copy(F);
updateStats(); renderMission();
$('#loading').hidden = true;
$('#start').hidden = false;
const hasProgress = Object.keys(save.stamps).length || save.mission > 0;
if (hasProgress) { $('#bStart').textContent = '이어서 탐험하기'; $('#bReset').hidden = false; }
if (IS_TOUCH) { $('#keysDesk').hidden = true; $('#keysTouch').hidden = false; }
$('#bReset').onclick = () => { if (confirm('처음부터 다시 시작할까요? 모은 도장과 별이 지워져요.')) { save = blankSave(); persist(); location.reload(); } };
$('#bStart').onclick = () => {
  $('#start').hidden = true; $('#hud').hidden = false; paused = false;
  canvas.focus({ preventScroll: true });
  try { actx = actx || new (window.AudioContext || window.webkitAudioContext)(); actx.resume(); } catch (e) {}
  updateHere();
  toast(hasProgress ? '다시 만나서 반가워요! 🧭' : '포항에서 출발! 🧭', IS_TOUCH ? '왼쪽 아래를 눌러 움직여요' : 'W·A·S·D 또는 방향키로 움직여요');
};
window.__game = { P, F, setPos(lat, lon, yawDeg = 0) { llDir(lat, lon, P); F.set(0, 1, 0).addScaledVector(P, -P.y).normalize(); if (F.lengthSq() < 0.5) F.set(1, 0, 0); turn(yawDeg * DEG); alt = Math.max(0, hDir(P)); camF.copy(F); player.position.copy(P).multiplyScalar(R + alt); camPos.copy(player.position).addScaledVector(P, 5).addScaledVector(F, -8); camLook.copy(player.position); camUp.copy(P); }, keys, here: () => here, toggleGlobe, toggleBalloon };
loop();
})().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) { l.hidden = false; l.innerHTML = '앗, 지구를 만들지 못했어요 😢<small>' + String(e && e.message || e) + '<br>최신 크롬·엣지·사파리에서 다시 열어 주세요.</small>'; }
});
