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
const renderer = new THREE.WebGLRenderer({ canvas, antialias: !LOW, alpha: true, powerPreference: 'high-performance' });
renderer.setPixelRatio(Math.min(devicePixelRatio || 1, LOW ? 1.5 : 2));
renderer.setSize(innerWidth, innerHeight, false);
renderer.setClearColor(0x000000, 0);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.fog = new THREE.Fog(new THREE.Color('#d6e6ef'), 45, 160);
const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.05, 3000);
addEventListener('resize', () => {
  renderer.setSize(innerWidth, innerHeight, false);
  camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix();
});

// 로우 폴리 재질: 면마다 평평하게 칠해져 각진 디오라마 느낌이 나요
const matCache = {};
function toon(color) {
  if (!matCache[color]) matCache[color] = new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.92, metalness: 0 });
  return matCache[color];
}
// 캐릭터용 점토 재질: 매끈하고 부드러워요
const clayCache = {};
function clay(color) {
  if (!clayCache[color]) clayCache[color] = new THREE.MeshStandardMaterial({ color, roughness: 0.62, metalness: 0 });
  return clayCache[color];
}

const amb = new THREE.AmbientLight(0xffffff, 0.35);
const hemi = new THREE.HemisphereLight(0xdcefff, 0xb3a184, 1.3);
const sun = new THREE.DirectionalLight(0xfff2de, 2.4);
sun.castShadow = true;
sun.shadow.mapSize.set(LOW ? 1024 : 2048, LOW ? 1024 : 2048);
{ const sc = sun.shadow.camera; sc.left = -18; sc.right = 18; sc.top = 18; sc.bottom = -18; sc.near = 1; sc.far = 160; }
sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.05;
scene.add(amb, hemi, sun, sun.target);

// ---------------------------------------------------------------- 텍스처 만들기
await nextFrame();
loadMsg('쾨펜 기후 색을 칠하고 있어요');
try { await Promise.race([document.fonts.ready, new Promise((r) => setTimeout(r, 1500))]); } catch (e) {}

const TW = 2048, TH = 1024;
const SAND = hex('#efe1b0'), SEABED = hex('#2f74b8'), ROCK = hex('#8e9fb4'), SNOW = [250, 252, 255];
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
      if (!k0) { const s = smooth(0.2, 0.55, COAST[ci]); r = SEABED[0] + (SAND[0] - SEABED[0]) * s; gg = SEABED[1] + (SAND[1] - SEABED[1]) * s; b = SEABED[2] + (SAND[2] - SEABED[2]) * s; }
      else {
        const jx = (vnoise(dx * 0.35, dy * 0.35) - 0.5) * 2.4 + (vnoise(dx * 1.3 + 50, dy * 1.3) - 0.5) * 0.9;
        const jy = (vnoise(dx * 0.35 + 91, dy * 0.35 + 17) - 0.5) * 2.4 + (vnoise(dx * 1.3, dy * 1.3 + 77) - 0.5) * 0.9;
        let k = KC[clampY(Math.floor(dy + jy)) * WW + wrapX(Math.floor(dx + jx))] || k0;
        const c = KRGB[k - 1]; r = c[0]; gg = c[1]; b = c[2];
        const e = ELEV[ci] / 248;
        const code = CLASSES[k - 1];
        if (code !== 'EF') {
          const rm = smooth(0.3, 0.62, e) * 0.75;
          r += (ROCK[0] - r) * rm; gg += (ROCK[1] - gg) * rm; b += (ROCK[2] - b) * rm;
          const sm = smooth(0.74, 0.84, e + (vnoise(dx * 0.8, dy * 0.8) - 0.5) * 0.08);
          r += (SNOW[0] - r) * sm; gg += (SNOW[1] - gg) * sm; b += (SNOW[2] - b) * sm;
        }
        const br = 0.96 + 0.08 * vnoise(dx * 0.9 + 300, dy * 0.9);
        r *= br; gg *= br; b *= br;
        // 국경선
        const c0 = CT[ci];
        const c1 = CT[clampY(Math.floor(dy)) * WW + wrapX(Math.floor(dx + 0.7))];
        const c2 = CT[clampY(Math.floor(dy + 0.7)) * WW + wrapX(Math.floor(dx))];
        if (c0 && ((c1 && c1 !== c0) || (c2 && c2 !== c0))) { r *= 0.8; gg *= 0.8; b *= 0.82; }
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
  const deep = hex('#3a8bd6'), mid = hex('#55ade6'), shal = hex('#8edbf0'), ice = hex('#eef7fb');
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
  for (let n = 0; n < 0; n++) {
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
function buildSphere(nLon, nLat, hFn, rough) {
  const nv = (nLon + 1) * (nLat + 1);
  const pos = new Float32Array(nv * 3), uv = new Float32Array(nv * 2);
  let k = 0, u = 0;
  for (let j = 0; j <= nLat; j++) {
    const lat = 90 - (j / nLat) * 180, la = lat * DEG, cl = Math.cos(la), sl = Math.sin(la);
    for (let i = 0; i <= nLon; i++) {
      const lon = -180 + (i / nLon) * 360, lo = lon * DEG;
      let h = hFn(lat, lon);
      // 땅에는 살짝 울퉁불퉁한 각을 더해 로우 폴리 느낌을 내요
      if (rough && h > 0.12 && j > 0 && j < nLat) h += (hash(i % nLon, j) - 0.5) * 0.16 * Math.min(1, h / 0.5 + 0.4);
      const r = R + h;
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
const terrainGeo = buildSphere(LOW ? 540 : 720, LOW ? 270 : 360, terrainH, true);
const terrain = new THREE.Mesh(terrainGeo, new THREE.MeshStandardMaterial({ map: canvasTex(landCv), flatShading: true, roughness: 0.95, metalness: 0 }));
terrain.receiveShadow = true;
scene.add(terrain);
// 물: 반투명한 각진 물결이 천천히 출렁여요
const waterU = { value: 0 };
const waterMat = new THREE.MeshStandardMaterial({ map: canvasTex(oceanCv), flatShading: true, roughness: 0.4, metalness: 0.05, transparent: true, opacity: 0.86 });
waterMat.onBeforeCompile = (sh) => {
  sh.uniforms.uTime = waterU;
  sh.vertexShader = 'uniform float uTime;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
    float wv = sin(position.x * 0.9 + uTime * 1.3) * 0.5 + sin(position.z * 1.1 - uTime * 1.1) * 0.5 + sin(position.y * 1.3 + uTime * 0.8) * 0.4;
    transformed += normalize(position) * wv * 0.07;`);
};
const water = new THREE.Mesh(buildSphere(360, 180, () => 0), waterMat);
water.receiveShadow = true;
scene.add(water);
// 지구 둘레의 옅은 하늘빛
const atmo = new THREE.Mesh(new THREE.SphereGeometry(R * 1.12, 96, 48), new THREE.ShaderMaterial({
  vertexShader: 'varying vec3 vN; varying vec3 vV; void main(){ vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix * normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }',
  fragmentShader: 'varying vec3 vN; varying vec3 vV; void main(){ float f = abs(dot(vN, vV)); float a = pow(f, 2.5); gl_FragColor = vec4(0.94, 0.98, 1.0, a * 0.75); }',
  side: THREE.BackSide, transparent: true, depthWrite: false, fog: false
}));
scene.add(atmo);

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
const TRUNK = '#7a5a3c';
const treeU = { uCam: { value: new THREE.Vector3(0, 0, 1e4) }, uPly: { value: new THREE.Vector3(0, 0, 1e4) } };
const TREE_TYPES = {
  rain: merge([colored(T(G.cyl(0.06, 0.09, 0.55, 5), 0, 0.27), TRUNK), colored(T(G.ball(0.46, 0), 0, 0.8, 0, 1, 0.9, 1), '#3f9b4a'), colored(T(G.ball(0.3, 0), 0.24, 1.04, 0.08), '#56b45a')]),
  palm: merge([colored(T(G.cyl(0.045, 0.07, 0.9, 5), 0, 0.45, 0, 1, 1, 1, 0, 0, 0.12), '#b08a58'), colored(T(G.ball(0.42, 0), -0.05, 0.95, 0, 1, 0.3, 1), '#5cb85c'), colored(T(G.ball(0.08, 0), 0, 0.86, 0.06), TRUNK)]),
  acacia: merge([colored(T(G.cyl(0.04, 0.07, 0.6, 5), 0, 0.3), TRUNK), colored(T(G.cyl(0.52, 0.44, 0.16, 7), 0, 0.68), '#9ab84a')]),
  cactus: merge([colored(T(G.cyl(0.09, 0.1, 0.65, 6), 0, 0.33), '#5aa851'), colored(T(G.cyl(0.055, 0.055, 0.25, 5), 0.15, 0.45), '#5aa851'), colored(T(G.cyl(0.05, 0.05, 0.12, 5), 0.08, 0.36, 0, 1, 1, 1, 0, 0, Math.PI / 2), '#5aa851'), colored(T(G.ball(0.09, 0), 0, 0.66), '#68b55c')]),
  shrub: merge([colored(T(G.ball(0.18, 0), 0, 0.09, 0, 1, 0.7, 1), '#adb46a'), colored(T(G.ball(0.12, 0), 0.16, 0.07, 0.05, 1, 0.7, 1), '#98a45c')]),
  rock: merge([colored(T(G.dode(0.22), 0, 0.1, 0, 1, 0.8, 1), '#dedcd6'), colored(T(G.dode(0.13), 0.22, 0.06, 0.08, 1, 0.8, 1), '#c4c1ba')]),
  olive: merge([colored(T(G.cyl(0.05, 0.07, 0.3, 5), 0, 0.15), TRUNK), colored(T(G.ball(0.3, 0), 0, 0.46, 0, 1.1, 0.85, 1.1), '#a2b46a')]),
  decid: merge([colored(T(G.cyl(0.05, 0.08, 0.5, 5), 0, 0.25), TRUNK), colored(T(G.ball(0.4, 0), 0, 0.76), '#8cc63f'), colored(T(G.ball(0.26, 0), -0.18, 0.98, 0.1), '#a3d65a')]),
  conifer: merge([colored(T(G.cyl(0.05, 0.07, 0.25, 5), 0, 0.12), TRUNK), colored(T(G.cone(0.38, 0.52, 6), 0, 0.44), '#3e8e5e'), colored(T(G.cone(0.29, 0.44, 6), 0, 0.72), '#4fa069'), colored(T(G.cone(0.19, 0.36, 6), 0, 0.98), '#62b477')]),
  snowcon: merge([colored(T(G.cyl(0.05, 0.07, 0.25, 5), 0, 0.12), TRUNK), colored(T(G.cone(0.38, 0.52, 6), 0, 0.44), '#3d7d5a'), colored(T(G.cone(0.29, 0.44, 6), 0, 0.72), '#4a8f67'), colored(T(G.cone(0.19, 0.36, 6), 0, 0.98), '#f4f8fb')]),
  tundra: merge([colored(T(G.ball(0.15, 0), 0, 0.05, 0, 1.3, 0.5, 1.3), '#9aa88a'), colored(T(G.dode(0.11), 0.18, 0.05, 0), '#c9c7c0')]),
  ice: merge([colored(T(G.cone(0.13, 1.1, 5), 0, 0.55), '#a8e6f0'), colored(T(G.cone(0.1, 0.75, 5), 0.16, 0.37, 0.05), '#c9f1f7'), colored(T(G.cone(0.08, 0.55, 5), -0.13, 0.27, -0.06), '#8fd9e8')])
};
const VEG = {
  Af: [['rain', 1.0], ['palm', 0.25]], Am: [['rain', 0.75], ['palm', 0.3]], Aw: [['acacia', 0.32], ['rain', 0.06], ['palm', 0.04]], As: [['acacia', 0.28]],
  BWh: [['rock', 0.05], ['shrub', 0.02], ['cactus', 0.03]], BWk: [['rock', 0.06], ['shrub', 0.03]], BSh: [['acacia', 0.1], ['shrub', 0.12]], BSk: [['shrub', 0.16], ['rock', 0.03]],
  Csa: [['olive', 0.38], ['conifer', 0.04]], Csb: [['olive', 0.3], ['conifer', 0.1]], Csc: [['conifer', 0.3]],
  Cwa: [['decid', 0.45], ['rain', 0.08]], Cwb: [['decid', 0.35], ['conifer', 0.1]], Cwc: [['conifer', 0.3]],
  Cfa: [['decid', 0.55], ['conifer', 0.1]], Cfb: [['decid', 0.45], ['conifer', 0.18]], Cfc: [['conifer', 0.35]],
  ET: [['tundra', 0.18], ['rock', 0.05], ['snowcon', 0.02]], EF: [['ice', 0.025]]
};
for (const a of 'swf') for (const b of 'abcd') VEG['D' + a + b] = b === 'a' || b === 'b' ? [['decid', 0.22], ['conifer', 0.5]] : [['conifer', 0.4], ['snowcon', 0.35]];
function addTrees() {
  const N = LOW ? 60000 : 110000;
  const lists = {};
  const v = new THREE.Vector3(); rngSeed = 4242;
  for (let n = 0; n < N; n++) {
    const u = rnd() * 2 - 1, t = rnd() * Math.PI * 2, s = Math.sqrt(1 - u * u);
    v.set(s * Math.cos(t), u, s * Math.sin(t));
    const lat = dirLat(v), lon = dirLon(v);
    const ci = cell(lat, lon), k = KC[ci];
    if (!k) continue;
    const code = CLASSES[k - 1], spec = VEG[code]; if (!spec || !spec.length) continue;
    const e = ELEV[ci] / 248; if (e > 0.78 && code !== 'EF') continue;
    let tot = 0; for (const sp of spec) tot += sp[1];
    const dens = Math.min(1, tot) * (code === 'EF' ? 1 : 1 - smooth(0.5, 0.78, e));
    if (rnd() > dens) continue;
    sampleLE(lat, lon, _s); if (_s.land < 0.9) continue;
    let pick = rnd() * tot, type = spec[0][0];
    for (const sp of spec) { if ((pick -= sp[1]) <= 0) { type = sp[0]; break; } }
    if (type === 'cactus' && lon > -30) type = 'rock';
    // 30° 조각으로 나누면 화면 밖의 나무를 통째로 건너뛸 수 있어요
    const chunk = Math.min(5, Math.floor((lat + 90) / 30)) * 12 + Math.min(11, Math.floor((lon + 180) / 30));
    (lists[type + '|' + chunk] ||= []).push([v.x, v.y, v.z, rnd(), 0.75 + rnd() * 0.6]);
  }
  const m = new THREE.Matrix4(), q = new THREE.Quaternion(), q2 = new THREE.Quaternion(), up = new THREE.Vector3(0, 1, 0), d = new THREE.Vector3(), sc = new THREE.Vector3();
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.9, metalness: 0 });
  // 카메라와 캐릭터 사이를 가리는 나무는 잠깐 숨겨요
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, treeU);
    sh.vertexShader = 'uniform vec3 uCam; uniform vec3 uPly; varying float vHide;\n' + sh.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
      vec3 org = (modelMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0)).xyz;
      vec3 sg = uPly - uCam; float tt = clamp(dot(org - uCam, sg) / max(dot(sg, sg), 1e-4), 0.0, 1.0);
      float dd = length(org - (uCam + sg * tt));
      vHide = ((tt > 0.02 && tt < 0.97 && dd < 1.4) || length(org - uCam) < 1.6) ? 1.0 : 0.0;`);
    sh.fragmentShader = 'varying float vHide;\n' + sh.fragmentShader.replace('void main() {', 'void main() {\n  if (vHide > 0.5) discard;');
  };
  for (const key in lists) {
    const L = lists[key], type = key.split('|')[0];
    const im = new THREE.InstancedMesh(TREE_TYPES[type], mat, L.length);
    L.forEach((it, i) => {
      d.set(it[0], it[1], it[2]);
      const h = hDir(d);
      q.setFromUnitVectors(up, d); q2.setFromAxisAngle(up, it[3] * Math.PI * 2); q.multiply(q2);
      sc.setScalar(it[4] * 1.25);
      m.compose(d.clone().multiplyScalar(R + h - 0.04), q, sc);
      im.setMatrixAt(i, m);
    });
    im.computeBoundingSphere();
    im.castShadow = !LOW; im.receiveShadow = true;
    scene.add(im);
  }
}
addTrees();

// 구름: 열대 수렴대와 중위도에 많고 사막 위에는 적어요
const clouds = new THREE.Group(); scene.add(clouds);
(function () {
  const puff = (r, x, y, z) => colored(T(G.sph(r, 12, 8), x, y, z, 1, 0.78, 1), '#ffffff');
  const geo = merge([puff(1.15, 0, 0, 0), puff(0.9, 1.15, -0.15, 0.15), puff(0.85, -1.1, -0.2, -0.1), puff(0.7, 0.35, 0.5, -0.35), puff(0.6, -0.5, 0.35, 0.4)]);
  const mat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 1, metalness: 0, emissive: '#ffffff', emissiveIntensity: 0.18 });
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
    m.compose(d.clone().multiplyScalar(R + 9 + r * 2.5), q, new THREE.Vector3(s * 1.3, s * 0.9, s));
    im.setMatrixAt(i, m);
  });
  im.computeBoundingSphere();
  im.castShadow = !LOW;
  clouds.add(im);
})();

// ---------------------------------------------------------------- 메시 도우미
function part(group, geo, color, x = 0, y = 0, z = 0, opt = {}) {
  const mesh = new THREE.Mesh(geo, toon(color));
  mesh.position.set(x, y, z);
  if (opt.r) mesh.rotation.set(opt.r[0], opt.r[1], opt.r[2]);
  if (opt.s) mesh.scale.set(opt.s[0], opt.s[1], opt.s[2]);
  mesh.castShadow = true; mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

// ---------------------------------------------------------------- 캐릭터 (큰 머리의 꼬마 탐험가)
const player = new THREE.Group(); scene.add(player);
const body = new THREE.Group(); player.add(body);
const SKIN = '#f6c9a3';
const mats = {};
for (const [k, c] of [['vest', '#7fae6e'], ['shirt', '#3f3b3a'], ['arm', SKIN], ['leg', SKIN], ['shorts', '#4a4d55']]) mats[k] = new THREE.MeshStandardMaterial({ color: c, roughness: 0.62, metalness: 0 });
mats.vest.side = THREE.DoubleSide;
function cp(parent, geo, mat, x = 0, y = 0, z = 0, opt = {}) {
  const m = new THREE.Mesh(geo, typeof mat === 'string' ? clay(mat) : mat);
  m.position.set(x, y, z);
  if (opt.r) m.rotation.set(opt.r[0], opt.r[1], opt.r[2]);
  if (opt.s) m.scale.set(opt.s[0], opt.s[1], opt.s[2]);
  m.castShadow = true;
  parent.add(m); return m;
}
const CAP = (r, l) => new THREE.CapsuleGeometry(r, l, 6, 14);
const SPH = (r, a = 0, b = Math.PI, p0 = 0, pl = Math.PI * 2) => new THREE.SphereGeometry(r, 24, 16, p0, pl, a, b);
const CYL = (rt, rb, h, s = 18) => new THREE.CylinderGeometry(rt, rb, h, s);
const legL = new THREE.Group(), legR = new THREE.Group(), armL = new THREE.Group(), armR = new THREE.Group();
legL.position.set(0.09, 0.36, 0); legR.position.set(-0.09, 0.36, 0);
armL.position.set(0.22, 0.68, 0); armR.position.set(-0.22, 0.68, 0);
body.add(legL, legR, armL, armR);
for (const leg of [legL, legR]) {
  cp(leg, CAP(0.07, 0.14), mats.leg, 0, -0.14, 0);
  cp(leg, CYL(0.075, 0.075, 0.08), '#d9534f', 0, -0.25, 0);
  cp(leg, CAP(0.085, 0.1), '#f4f1ea', 0, -0.32, 0.04, { r: [Math.PI / 2, 0, 0] });
  cp(leg, new THREE.BoxGeometry(0.16, 0.025, 0.26), '#c8c2b6', 0, -0.4, 0.04);
}
for (const [arm, s] of [[armL, 1], [armR, -1]]) {
  cp(arm, SPH(0.08), mats.vest, 0, 0, 0);
  cp(arm, CAP(0.058, 0.13), mats.arm, 0.01 * s, -0.13, 0);
  cp(arm, SPH(0.068), SKIN, 0.01 * s, -0.25, 0.01);
}
cp(body, CYL(0.17, 0.2, 0.18), mats.shorts, 0, 0.4, 0);
cp(body, CAP(0.17, 0.14), mats.shirt, 0, 0.58, 0);
cp(body, new THREE.CylinderGeometry(0.19, 0.205, 0.27, 20, 1, true, 0.5, Math.PI * 2 - 1.0), mats.vest, 0, 0.6, 0);
for (const s of [1, -1]) cp(body, new THREE.BoxGeometry(0.085, 0.075, 0.03), '#5f8f55', 0.1 * s, 0.53, 0.175, { r: [0, 0.5 * s, 0] });
cp(body, CYL(0.04, 0.04, 0.012, 16), '#7fae6e', 0.11, 0.66, 0.19, { r: [Math.PI / 2 - 0.3, 0, 0] });
cp(body, CYL(0.02, 0.02, 0.014, 10), '#d9534f', 0.11, 0.66, 0.197, { r: [Math.PI / 2 - 0.3, 0, 0] });
// 배낭과 매트, 물병, 삽
const pack = new THREE.Group(); pack.position.set(0, 0.6, -0.2); body.add(pack);
cp(pack, CAP(0.15, 0.12), '#4b4340', 0, 0, -0.02, { s: [1.15, 1, 0.62] });
cp(pack, CYL(0.095, 0.095, 0.44), '#f0a64a', 0, 0.26, -0.03, { r: [0, 0, Math.PI / 2] });
cp(pack, new THREE.TorusGeometry(0.05, 0.012, 8, 18), '#d98b2f', 0.222, 0.26, -0.03, { r: [0, Math.PI / 2, 0] });
cp(pack, CYL(0.045, 0.045, 0.17, 14), '#d9534f', 0.19, 0.02, -0.03);
cp(pack, CYL(0.013, 0.013, 0.42, 8), '#7a6a5a', -0.19, -0.02, -0.06, { r: [0, 0, 0.15] });
cp(pack, new THREE.BoxGeometry(0.12, 0.16, 0.025), '#8a8590', -0.22, -0.26, -0.06, { r: [0, 0, 0.15] });
// 머리
const head = new THREE.Group(); head.position.set(0, 1.0, 0); body.add(head);
cp(head, SPH(0.3), SKIN, 0, 0, 0, { s: [1, 0.94, 0.96] });
cp(head, SPH(0.305, 0, Math.PI * 0.62, Math.PI, Math.PI), '#4a3428', 0, 0, -0.005);
for (const s of [1, -1]) {
  cp(head, SPH(0.06), SKIN, 0.29 * s, -0.03, -0.01, { s: [0.6, 1, 1] });
  cp(head, SPH(0.034), '#2b2118', 0.1 * s, -0.01, 0.27, { s: [1, 1.3, 0.5] });
  cp(head, new THREE.TorusGeometry(0.078, 0.013, 8, 24), '#3b2f2a', 0.1 * s, -0.01, 0.285);
  cp(head, new THREE.BoxGeometry(0.012, 0.012, 0.24), '#3b2f2a', 0.175 * s, 0.0, 0.17, { r: [0, 0.25 * s, 0] });
  cp(head, SPH(0.035), '#ffa38f', 0.17 * s, -0.11, 0.23, { s: [1, 0.6, 0.5] });
}
cp(head, CYL(0.01, 0.01, 0.05, 6), '#3b2f2a', 0, 0.0, 0.29, { r: [0, 0, Math.PI / 2] });
cp(head, SPH(0.03), '#eeb08c', 0, -0.06, 0.29);
const hats = {};
function hatGroup(name) { const g = new THREE.Group(); g.visible = false; head.add(g); hats[name] = g; return g; }
{ const g = hatGroup('cap'); cp(g, SPH(0.318, 0, Math.PI / 2), '#7fae6e', 0, 0.03, 0, { s: [1, 0.82, 1] }); cp(g, CYL(0.2, 0.2, 0.03), '#f0a64a', 0, 0.06, 0.27, { s: [1.05, 1, 1.25], r: [-0.12, 0, 0] }); cp(g, SPH(0.03), '#6a9a5c', 0, 0.3, 0); }
{ const g = hatGroup('straw'); cp(g, CYL(0.52, 0.52, 0.03, 24), '#f0d080', 0, 0.1, 0); cp(g, SPH(0.31, 0, Math.PI / 2), '#f0d080', 0, 0.08, 0, { s: [1, 0.85, 1] }); cp(g, CYL(0.31, 0.31, 0.06, 24), '#d64545', 0, 0.13, 0); }
{ const g = hatGroup('scarf'); cp(g, SPH(0.335, 0, Math.PI * 0.3), '#2f5fa8', 0, 0, -0.01); cp(g, SPH(0.335, 0, Math.PI * 0.62, Math.PI / 2 + 0.8, Math.PI * 2 - 1.6), '#2f5fa8', 0, 0, -0.01); cp(g, new THREE.BoxGeometry(0.18, 0.36, 0.05), '#2f5fa8', 0, -0.24, -0.27, { r: [0.25, 0, 0] }); }
{ const g = hatGroup('beanie'); cp(g, SPH(0.325, 0, Math.PI * 0.5), '#2a9d8f', 0, 0.02, 0); cp(g, new THREE.TorusGeometry(0.31, 0.05, 10, 28), '#f1f1e6', 0, 0.05, 0, { r: [Math.PI / 2, 0, 0] }); cp(g, SPH(0.075), '#f1f1e6', 0, 0.36, 0); }
{ const g = hatGroup('chullo'); cp(g, SPH(0.325, 0, Math.PI * 0.55), '#a347c8', 0, 0.02, 0); for (const s of [1, -1]) cp(g, new THREE.ConeGeometry(0.06, 0.24, 10), '#ffcf5a', 0.27 * s, -0.2, 0, { r: [0, 0, 0.3 * s] }); cp(g, SPH(0.06), '#ff6b6b', 0, 0.35, 0); }
{ const g = hatGroup('hood'); cp(g, SPH(0.37, 0, Math.PI * 0.3), '#e9dcc6', 0, 0, -0.03); cp(g, SPH(0.37, 0, Math.PI * 0.72, Math.PI / 2 + 0.95, Math.PI * 2 - 1.9), '#e9dcc6', 0, 0, -0.03); cp(g, new THREE.TorusGeometry(0.28, 0.07, 10, 28), '#fbf6ec', 0, -0.01, 0.15); }
const scarfNeck = cp(body, new THREE.TorusGeometry(0.17, 0.06, 10, 24), '#e05a4f', 0, 0.76, 0, { r: [Math.PI / 2, 0, 0] }); scarfNeck.visible = false;
const OUTFITS = {
  hot: { vest: '#f2c14e', shirt: '#ffffff', arm: SKIN, leg: SKIN, shorts: '#4f8fd0', hat: 'straw', scarf: false, label: '반팔·반바지·밀짚모자 (덥고 습해요)' },
  dry: { vest: '#f4efe6', shirt: '#ece4d4', arm: '#f4efe6', leg: '#f4efe6', shorts: '#ece4d4', hat: 'scarf', scarf: false, label: '헐렁한 긴 옷과 두건 (햇볕·모래바람을 막아요)' },
  mild: { vest: '#7fae6e', shirt: '#3f3b3a', arm: SKIN, leg: SKIN, shorts: '#4a4d55', hat: 'cap', scarf: false, label: '가벼운 탐험복 (사계절이 뚜렷해요)' },
  cold: { vest: '#e05a4f', shirt: '#c94a40', arm: '#e05a4f', leg: '#3d4660', shorts: '#3d4660', hat: 'beanie', scarf: true, label: '두꺼운 패딩·털모자·목도리 (겨울이 길고 추워요)' },
  polar: { vest: '#e9dcc6', shirt: '#d9c8ae', arm: '#e9dcc6', leg: '#8a6a4f', shorts: '#8a6a4f', hat: 'hood', scarf: false, label: '털가죽 파카 (1년 내내 추워요)' },
  alpine: { vest: '#d35400', shirt: '#5b4636', arm: '#d35400', leg: '#5b4636', shorts: '#5b4636', hat: 'chullo', scarf: false, label: '판초와 털모자 (고산은 일교차가 커요)' }
};
let outfit = '';
function setOutfit(name) {
  if (name === outfit) return; outfit = name;
  const o = OUTFITS[name];
  for (const k of ['vest', 'shirt', 'arm', 'leg', 'shorts']) mats[k].color.set(o[k]);
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
  const e = new THREE.Mesh(ng, new THREE.MeshStandardMaterial({ vertexColors: true, flatShading: true, roughness: 0.8 }));
  e.position.y = 2.45; e.scale.set(1, 1.15, 1); e.castShadow = true; balloon.add(e);
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
  geo(g) { part(g, G.cyl(0.9, 0.9, 0.05, 16), '#6ec6e8', 0, 0.03, 0, { outline: false }); for (let i = 0; i < 5; i++) part(g, G.dode(0.25), '#7d7a78', Math.cos(i * 1.3) * 1.05, 0.1, Math.sin(i * 1.3) * 1.05); const st = []; for (let i = 0; i < 4; i++) { const s = part(g, G.ball(0.3, 1), '#ffffff', 0, 0.5 + i * 0.5, 0, { outline: false }); s.material = new THREE.MeshStandardMaterial({ color: '#ffffff', flatShading: true, roughness: 1, transparent: true, opacity: 0.8 }); s.castShadow = false; st.push(s); } anims.push((t) => st.forEach((s, i) => { const f = (t * 0.4 + i / 4) % 1; s.position.y = 0.3 + f * 2.2; s.scale.setScalar(0.6 + f * 1.2); s.material.opacity = 0.85 * (1 - f); })); },
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
let camDist = 11, camPitch = 0.5, orbitDist = 290;
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
  const right = tmpV2.crossVectors(camF, P);
  const ang = Math.atan2(d.dot(right), d.dot(camF));
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
    camF.applyAxisAngle(P, -dx * 0.006);
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
const tmpV3 = new THREE.Vector3(), tmpV4 = new THREE.Vector3();
let camAlt = alt, curSpd = 0;
// 발 주변 다섯 곳의 높이를 평균 내어 울퉁불퉁한 흔들림을 줄여요
function groundAt(p) {
  let s = hDir(p) * 2, n = 2;
  const left = tmpV4.crossVectors(p, F);
  for (const [a, b] of [[0.4, 0], [-0.4, 0], [0, 0.4], [0, -0.4]]) { tmpV3.copy(p).addScaledVector(F, a / R).addScaledVector(left, b / R).normalize(); s += hDir(tmpV3); n++; }
  return s / n;
}
function step(dt) {
  // 화면(카메라) 기준 이동: W 앞, S 뒤(카메라 쪽), A 왼쪽, D 오른쪽. 캐릭터는 가는 방향을 바라봐요
  let ix = 0, iy = 0, cyaw = 0;
  if (!paused && !globeView) {
    if (keys.KeyW || keys.ArrowUp) iy += 1;
    if (keys.KeyS || keys.ArrowDown) iy -= 1;
    if (keys.KeyA || keys.ArrowLeft) ix -= 1;
    if (keys.KeyD || keys.ArrowRight) ix += 1;
    if (keys.KeyQ) cyaw += 1;
    if (keys.KeyE) cyaw -= 1;
    if (joy.active) { ix += joy.x; iy -= joy.y; }
  }
  if (cyaw) camF.applyAxisAngle(P, cyaw * 1.3 * dt);
  const mag = Math.min(1, Math.hypot(ix, iy));
  const run = running || keys.ShiftLeft || keys.ShiftRight;
  if (mag > 0.08) {
    const camRight = tmpV4.crossVectors(camF, P);
    const D = tmpV3.copy(camF).multiplyScalar(iy).addScaledVector(camRight, ix);
    D.addScaledVector(P, -P.dot(D));
    if (D.lengthSq() > 1e-8) {
      D.normalize();
      const ang = Math.atan2(tmpV.crossVectors(F, D).dot(P), clamp(F.dot(D), -1, 1));
      turn(clamp(ang, -9 * dt, 9 * dt));
    }
  }
  const gRaw = hDir(P);
  const onWater = gRaw < -0.05;
  mode = onWater && !ballooning ? 'boat' : 'walk';
  let speed = ballooning ? (run ? 22 : 13) : mode === 'boat' ? (run ? 14 : 8) : run ? 9 : 5;
  if (mag > 0.08 && mode === 'walk' && !ballooning) {
    const ahead = tmpV.copy(P).addScaledVector(F, 0.8 / R).normalize();
    const slope = (Math.max(0, hDir(ahead)) - Math.max(0, gRaw)) / 0.8;
    speed *= clamp(1 - Math.max(0, slope) * 0.5, 0.5, 1);
  }
  curSpd += ((mag > 0.08 ? mag : 0) * speed - curSpd) * Math.min(1, dt * 6);
  if (curSpd > 0.02) {
    const a = (curSpd * dt) / R;
    const np = tmpV.copy(P).multiplyScalar(Math.cos(a)).addScaledVector(F, Math.sin(a));
    F.multiplyScalar(Math.cos(a)).addScaledVector(P, -Math.sin(a));
    P.copy(np).normalize();
    F.addScaledVector(P, -P.dot(F)).normalize();
  } else curSpd = 0;
  // 높이: 땅을 부드럽게 따라가요
  const surface = onWater ? 0.06 : groundAt(P);
  if (ballooning) { alt += (Math.max(0, gRaw) + 6.5 - alt) * Math.min(1, dt * 1.5); vy = 0; grounded = false; }
  else if (!grounded || vy > 0) {
    vy -= 16 * dt; alt += vy * dt;
    if (alt <= surface) { if (vy < -3 && onWater) sfx.splash(); alt = surface; vy = 0; grounded = true; }
  } else {
    const diff = surface - alt;
    if (diff < -0.7) { grounded = false; vy = 0; }
    else alt += diff * Math.min(1, dt * 10);
  }
  // 걷기 동작
  const moving = Math.abs(curSpd) > 0.3 && mode === 'walk' && !ballooning;
  walkPhase += dt * Math.abs(curSpd) * (run ? 1.7 : 2.0);
  const amp = moving && grounded ? Math.min(1, Math.abs(curSpd) / 4) * 0.65 : 0;
  const sw = Math.sin(walkPhase) * amp;
  legL.rotation.x = sw; legR.rotation.x = -sw; armL.rotation.x = -sw * 0.8; armR.rotation.x = sw * 0.8;
  body.position.y = moving && grounded ? Math.abs(Math.sin(walkPhase)) * 0.03 : 0;
  body.rotation.x += ((moving && run ? 0.14 : 0) - body.rotation.x) * Math.min(1, dt * 8);
  boat.visible = mode === 'boat'; balloon.visible = ballooning;
  if (mode === 'boat') {
    const bob = Math.sin(tick * 2.6) * 0.03;
    boat.position.y = bob; body.position.y = 0.06 + bob; legL.rotation.x = legR.rotation.x = 0;
    boat.rotation.z = Math.sin(tick * 2) * 0.04;
  }
  basisX.crossVectors(P, F);
  mtx.makeBasis(basisX, P, F);
  player.quaternion.setFromRotationMatrix(mtx);
  player.position.copy(P).multiplyScalar(R + alt);
}
function updateCamera(dt) {
  let tPos, tLook, tUp;
  // 카메라 높이는 캐릭터보다 더 천천히 따라가서 오르내림이 덜 흔들려요
  camAlt += (alt - camAlt) * Math.min(1, dt * 2.5);
  if (globeView) {
    tPos = tmpV.copy(orbitDir).multiplyScalar(orbitDist); tLook = tmpV2.set(0, 0, 0); tUp = UP;
  } else {
    // 카메라는 화면을 끌 때(또는 Q·E)만 돌아요. 이동해도 방향을 유지해요
    camF.addScaledVector(P, -P.dot(camF));
    if (camF.lengthSq() < 1e-6) camF.copy(F); camF.normalize();
    const anchor = tmpV3.copy(P).multiplyScalar(R + camAlt);
    const d = camDist * (ballooning ? 1.5 : 1);
    tPos = tmpV.copy(anchor).addScaledVector(P, Math.sin(camPitch) * d + 1.0).addScaledVector(camF, -Math.cos(camPitch) * d);
    const cr = tPos.length(), cd = tmpV4.copy(tPos).divideScalar(cr), minR = R + Math.max(0, hDir(cd)) + 1.0;
    if (cr < minR) tPos.multiplyScalar(minR / cr);
    tLook = tmpV2.copy(anchor).addScaledVector(P, 1.0).addScaledVector(camF, 1.5);
    tUp = P;
  }
  const k = 1 - Math.exp(-dt * (globeView ? 3.5 : 5));
  camPos.lerp(tPos, k); camLook.lerp(tLook, 1 - Math.exp(-dt * (globeView ? 3.5 : 8))); camUp.lerp(tUp, k).normalize();
  camera.position.copy(camPos); camera.up.copy(camUp); camera.lookAt(camLook);
  treeU.uCam.value.copy(camPos);
  if (globeView) treeU.uPly.value.copy(camPos); else treeU.uPly.value.copy(player.position).addScaledVector(P, 0.7);
  // 햇빛은 화면 왼쪽 위 뒤편에서 비춰 그림자가 오른쪽 앞으로 생겨요
  camera.updateMatrixWorld();
  const camR = tmpV.setFromMatrixColumn(camera.matrixWorld, 0), camU = tmpV2.setFromMatrixColumn(camera.matrixWorld, 1), camB = tmpV4.setFromMatrixColumn(camera.matrixWorld, 2);
  const target = globeView ? camLook : player.position;
  sun.target.position.copy(target);
  sun.position.copy(target).addScaledVector(camU, 55).addScaledVector(camR, -32).addScaledVector(camB, 30);
}
function updateWorld(dt) {
  tick += dt;
  waterU.value = tick;
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
  const farView = globeView || camDistC > R + 45;
  scene.fog.near = farView ? 1e5 : 30 + camDist * 1.6; scene.fog.far = farView ? 2e5 : 120 + camDist * 3.5;
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
window.__game = { P, F, setPos(lat, lon, yawDeg = 0) { llDir(lat, lon, P); F.set(0, 1, 0).addScaledVector(P, -P.y).normalize(); if (F.lengthSq() < 0.5) F.set(1, 0, 0); turn(yawDeg * DEG); alt = Math.max(0, hDir(P)); camF.copy(F); player.position.copy(P).multiplyScalar(R + alt); camPos.copy(player.position).addScaledVector(P, 5).addScaledVector(F, -8); camLook.copy(player.position); camUp.copy(P); }, keys, here: () => here, toggleGlobe, toggleBalloon, turn, setCam(d, p) { camDist = d; camPitch = p; }, camShake: () => camera.position.clone() };
loop();
})().catch((e) => {
  console.error(e);
  const l = document.getElementById('loading');
  if (l) { l.hidden = false; l.innerHTML = '앗, 지구를 만들지 못했어요 😢<small>' + String(e && e.message || e) + '<br>최신 크롬·엣지·사파리에서 다시 열어 주세요.</small>'; }
});
