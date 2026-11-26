/**
 * 기후 러너 순위표 (구글 시트 + Apps Script)
 *
 * 쓰는 법
 * 1. 새 구글 시트를 만들고, 메뉴 [확장 프로그램 → Apps Script]를 열어요.
 * 2. 원래 있던 코드를 모두 지우고 이 파일 내용을 전부 붙여 넣은 뒤 저장(💾)해요.
 * 3. [배포 → 새 배포 → 유형: 웹 앱]을 고르고
 *    - 다음 사용자로 실행: 나
 *    - 액세스 권한이 있는 사용자: 모든 사용자
 *    로 정한 뒤 [배포]를 눌러요. (처음에는 권한 승인 창이 떠요)
 * 4. 나온 "웹 앱 URL"(https://script.google.com/macros/s/.../exec)을 index.html의 SHEET_URL에 넣어요.
 *
 * 기록은 이 시트의 "scores" 탭에 한 줄씩 쌓여요. 이상한 기록은 그 줄을 지우면 순위표에서 사라져요.
 */
const MODES = ['full', 'af', 'aw', 'bw', 'bs', 'cs', 'cfb', 'df', 'et'];
const MAX_SCORE = 300000;
const TOP = 30;

function sheet_() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sh = ss.getSheetByName('scores');
  if (!sh) {
    sh = ss.insertSheet('scores');
    sh.appendRow(['시간', '닉네임', '모드', '점수']);
    sh.setFrozenRows(1);
  }
  return sh;
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

function cleanNick_(v) {
  return String(v || '').replace(/[\u0000-\u001f\u007f<>=+@]/g, '').replace(/\s+/g, ' ').trim().slice(0, 12);
}

/** 순위표 읽기: ?mode=full */
function doGet(e) {
  const mode = String((e && e.parameter && e.parameter.mode) || 'full');
  if (MODES.indexOf(mode) < 0) return json_({ ok: false, error: 'mode' });
  const cache = CacheService.getScriptCache(), key = 'lb_' + mode, hit = cache.get(key);
  if (hit) return ContentService.createTextOutput(hit).setMimeType(ContentService.MimeType.JSON);
  const sh = sheet_(), n = sh.getLastRow() - 1;
  const rows = n > 0 ? sh.getRange(2, 1, n, 4).getValues() : [];
  const best = {};
  rows.forEach(function (r) {
    const nick = cleanNick_(r[1]), m = String(r[2]), s = Number(r[3]);
    if (m !== mode || !nick || !(s > 0 && s <= MAX_SCORE)) return;
    const k = nick.toLowerCase();
    if (!best[k] || s > best[k].score) best[k] = { nickname: nick, score: Math.round(s) };
  });
  const list = Object.keys(best).map(function (k) { return best[k]; })
    .sort(function (a, b) { return b.score - a.score; }).slice(0, TOP);
  const out = JSON.stringify({ ok: true, rows: list });
  cache.put(key, out, 20);
  return ContentService.createTextOutput(out).setMimeType(ContentService.MimeType.JSON);
}

/** 기록 올리기: 본문 {"nickname":"...","mode":"full","score":1234} */
function doPost(e) {
  let d;
  try { d = JSON.parse(e.postData.contents); } catch (err) { return json_({ ok: false, error: 'json' }); }
  const nick = cleanNick_(d.nickname), mode = String(d.mode), score = Math.round(Number(d.score));
  if (!nick || MODES.indexOf(mode) < 0 || !(score > 0 && score <= MAX_SCORE)) return json_({ ok: false, error: 'invalid' });
  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try { sheet_().appendRow([new Date(), nick, mode, score]); } finally { lock.releaseLock(); }
  CacheService.getScriptCache().remove('lb_' + mode);
  return json_({ ok: true });
}
