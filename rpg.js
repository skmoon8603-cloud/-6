'use strict';
/**
 * 도파민 RPG 연동 (축구 게임 기능과는 완전히 분리)
 *  - 축구 게임 계정(아이디/비밀번호, 세션 토큰)을 그대로 사용한다.
 *  - 세이브는 계정 저장소의 별도 문서('__rpg:<계정 id>')에 저장한다. 축구 게임의 잔액·보관함은 건드리지 않는다.
 *  - /rpg/ 로 접속하면 GitHub Pages 에 있는 RPG 화면을 그대로 내려준다(같은 주소라 로그인·실시간 접속이 바로 된다).
 *  - Socket.IO 네임스페이스 '/rpg': 같은 맵에 있는 다른 플레이어의 위치를 0.1초마다 알려준다.
 */
const PAGES = (process.env.RPG_PAGES || 'https://skmoon8603-cloud.github.io/dobak-rpg/').replace(/\/*$/, '/');
const ORIGINS = (process.env.RPG_ORIGINS || 'https://skmoon8603-cloud.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_SAVE = 600000; // 예전 24000 은 가방이 큰 캐릭터의 저장을 조용히 거절해서 레벨이 되돌아갔다
const ADMIN_ID = process.env.ADMIN_ID || 'u-skmoon'; // 관리자 계정 (RPG에서 관리자 보상을 받는다)
const docId = (uid) => '__rpg:' + uid;
const REPORT_ID = '__rpgreports';
// 제재(채팅 금지·정지): { [uid]: { mute: 끝나는 시각, ban: 끝나는 시각 또는 -1(영구), why, name } }
const SANC_ID = '__rpgsanction'; let SANC = null;
async function sancLoad(store) { if (!SANC) { try { const d = await store.get(SANC_ID); SANC = (d && d.m) || {}; } catch (e) { SANC = {}; } } return SANC; }
async function sancSave(store) { try { await store.txn([SANC_ID], (m) => { m[SANC_ID] = { id: SANC_ID, m: SANC }; }); } catch (e) { console.error('[rpg] 제재 저장 실패', e.message); } }
const banLeft = (uid) => { const x = SANC && SANC[uid]; if (!x || !x.ban) return 0; return x.ban === -1 ? -1 : Math.max(0, x.ban - Date.now()); };
const muteLeft = (uid) => { const x = SANC && SANC[uid]; return x && x.mute ? Math.max(0, x.mute - Date.now()) : 0; };
const leftTxt = (ms) => ms === -1 ? '영구' : ms > 864e5 ? Math.ceil(ms / 864e5) + '일' : ms > 36e5 ? Math.ceil(ms / 36e5) + '시간' : Math.ceil(ms / 6e4) + '분';
const CONTACT = process.env.RPG_CONTACT || 'skmoon8603@gmail.com'; // 플레이스토어 등록 전에 Render 환경변수 RPG_CONTACT 에 문의 이메일을 넣는다
const PRIVACY_HTML = "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>도파민 RPG 개인정보처리방침</title><style>body{font-family:system-ui,sans-serif;max-width:720px;margin:0 auto;padding:24px;line-height:1.7;color:#222}h1{font-size:1.5em}h2{font-size:1.15em;margin-top:1.6em}</style></head><body>\n<h1>도파민 RPG 개인정보처리방침</h1><p>시행일: 2026년 11월 20일</p>\n<p>「도파민 RPG」(이하 \"게임\")는 이용자의 개인정보를 소중히 다루며, 게임 운영에 꼭 필요한 정보만 모읍니다. 이 게임은 실제 돈을 거는 도박이 아니며, 게임 안의 골드는 현금으로 바꿀 수 없습니다.</p>\n<h2>1. 모으는 정보</h2><ul><li>계정 정보: 아이디, 비밀번호(복구할 수 없는 암호화 값으로만 저장), 닉네임. Google 로그인을 쓰면 Google이 넘겨주는 이메일 주소와 이름.</li><li>게임 기록: 캐릭터 이름·레벨·아이템·골드 등 저장 데이터, 결투·랭킹 기록.</li><li>이용자가 쓴 글: 채팅, 표지판 댓글, 신고 내용.</li><li>접속 기록: 접속 IP 주소(과도한 요청 차단용, 따로 보관하지 않음).</li></ul>\n<h2>2. 쓰는 목적</h2><ul><li>로그인과 게임 저장·불러오기</li><li>다른 이용자와 함께 하는 실시간 플레이(채팅·거래·파티·결투)와 랭킹</li><li>욕설·괴롭힘 신고 처리와 부정 이용 방지</li></ul>\n<h2>3. 보관 기간</h2><p>계정을 삭제할 때까지 보관합니다. 계정을 삭제하면 계정 정보와 게임 저장 데이터를 바로 지웁니다. 신고 기록은 처리 후 최대 90일까지 보관할 수 있습니다.</p>\n<h2>4. 다른 곳에 주는 정보</h2><p>개인정보를 팔거나 광고 목적으로 남에게 주지 않습니다. 서버 운영을 위해 호스팅 업체(Render, GitHub)의 서버에 데이터가 저장됩니다.</p>\n<h2>5. 계정 삭제</h2><p>게임 안 「상태 → ⚙ 계정」 메뉴에서, 또는 <a href=\"./delete\">계정 삭제 페이지</a>에서 언제든 계정을 지울 수 있습니다. 같은 계정을 쓰는 RANDOM FOOTBALL 기록도 함께 지워집니다.</p>\n<h2>6. 아동</h2><p>이 게임은 모의 도박 요소(게임 골드로만 하는 카지노)가 있어 만 15세 미만을 대상으로 하지 않습니다. 게임 골드와 아이템은 현금으로 사거나 팔 수 없습니다.</p>\n<h2>7. 문의</h2><p>개인정보 관련 문의: {{CONTACT}}</p>\n</body></html>";
const DELETE_HTML = "<!DOCTYPE html><html lang=\"ko\"><head><meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\"><title>도파민 RPG 계정 삭제</title><style>body{font-family:system-ui,sans-serif;max-width:480px;margin:0 auto;padding:24px;line-height:1.6;color:#222}input,button{font-size:1em;padding:10px;width:100%;box-sizing:border-box;margin:6px 0}button{background:#c62828;color:#fff;border:0;border-radius:6px}#m{font-weight:bold}</style></head><body>\n<h1>도파민 RPG 계정 삭제</h1><p>아이디와 비밀번호를 넣으면 계정과 게임 저장 데이터가 <b>바로, 되돌릴 수 없게</b> 지워집니다. 같은 계정을 쓰는 RANDOM FOOTBALL 기록도 함께 지워집니다.</p>\n<p>Google 로그인 계정은 게임 안 「상태 → ⚙ 계정」에서 지우거나, {{CONTACT}} 으로 요청해 주세요.</p>\n<input id=\"u\" placeholder=\"아이디\" autocomplete=\"username\"><input id=\"p\" type=\"password\" placeholder=\"비밀번호\" autocomplete=\"current-password\"><label><input type=\"checkbox\" id=\"c\" style=\"width:auto\"> 되돌릴 수 없다는 것을 이해했어요</label><button id=\"b\">계정 영구 삭제</button><p id=\"m\"></p>\n<script>b.onclick=async()=>{if(!c.checked){m.textContent='확인란을 체크해 주세요';return;}b.disabled=true;m.textContent='처리 중…';try{const r=await fetch('/api/rpg/deleteweb',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({user:u.value,pw:p.value})});const j=await r.json().catch(()=>({}));m.textContent=r.ok?'계정이 삭제됐어요. 이용해 주셔서 고마워요.':j.error==='locked'?'잠시 후 다시 시도해 주세요':j.error==='forbidden'?'이 계정은 지울 수 없어요':'아이디 또는 비밀번호가 틀렸어요';}catch(e){m.textContent='서버에 연결하지 못했어요';}b.disabled=false;};</script></body></html>";
// 운영자 지급: 해당 계정이 다음에 게임을 시작할 때 한 번만 적용된다 (받은 기록은 '__rpggrant:<계정>' 에 남는다)
const GRANTS = [
  { id: 'lv20-taeheeim-1115', nick: '이태희', name: '이태희임', lv: 20 }, // 계정 닉네임 「이태희」(캐릭터 이름 「이태희임」) 레벨 20
];
GRANTS.push({ id: 'title-lost-taeheeim', nick: '이태희', name: '이태희임', title: 'lost', keep: true }); // 칭호 「최초로 계정이 날라간 자」 (새 게임을 해도 유지)
GRANTS.push({ id: 'title-fav-otter-1116', nick: 'otter', name: 'otter', title: 'fav', keep: true }); // 칭호 「^관리자의 최애^」 (계정 닉네임이나 캐릭터 이름이 otter)
GRANTS.push({ id: 'lv60-jusiwan-1116', nick: '주시완', name: '주시완', setLv: 60, recalc: true }); // 주시완 Lv60 (스킬·능력치 포인트도 Lv60에 맞게 다시 계산)
// (취소) 「왕정훈 찐계」에 잘못 내린 조정. 이미 적용됐다면 아래 복구가 한 번 들어간다.
GRANTS.push({ id: 'restore-hanback-1116', nick: 'hanback0820', name: '왕정훈 찐계', requires: 'penalty-hanback-1115', setLv: 46, goldMul: 2, recalc: true });
const PK_ALWAYS = new Set(['왕정훈 본계']); // PvP를 끌 수 없는 캐릭터
// 「왕정훈 본계」: 레벨 -8 (그만큼 받은 스킬 1·능력치 3 포인트도 회수), 골드 절반
GRANTS.push({ id: 'penalty-wjh-main-1116', name: '왕정훈 본계', lvAdd: -8, spDown: 8, apDown: 24, goldMul: 0.5 });
GRANTS.push({ id: 'dalkong-choi-1117', nick: '최범규 vr2', name: '최범규 vr2', item: 'dalkong' }); // 최범규 vr2에게 달콩빔 (하루 10번)
const DK_NAMES = new Set(['최범규 vr2']); // 달콩빔을 하루 10번 쓸 수 있는 사람 (계정 닉네임 또는 캐릭터 이름)
GRANTS.push({ id: 'penalty-daege-1118', nick: '대게', name: '대게', lvAdd: -10, spDown: 10, apDown: 30, goldMul: 0.5 }); // 「대게」: 레벨 -10 (그만큼 받은 스킬 1·능력치 3 포인트도 회수), 골드 절반
GRANTS.push({ id: 'lv91-songdoha-1120', nick: '섹시한 송도하', name: '섹시한 송도하', setLv: 91 }); // 「섹시한 송도하」 레벨 91 (다른 건 그대로)
GRANTS.push({ id: 'lv90-baekbf-1121', nick: '백지헌남친', name: '백지헌남친', setLv: 90 }); // 「백지헌남친」 레벨 90
GRANTS.push({ id: 'title-nofind-baekbf', nick: '백지헌남친', name: '백지헌남친', title: 'nofind', keep: true }); // 칭호 「계정을 못 찾은 자」
GRANTS.push({ id: 'dweapon-baekbf-1122', nick: '백지헌남친', name: '백지헌남친', item: 'w_{cls}5' }); // 백지헌남친: 내 직업 드래곤 무기
GRANTS.push({ id: 'lv122-parkjm-1122', nick: '박종모', name: '박종모', setLv: 122 }); // 「박종모」 레벨 122
GRANTS.push({ id: 'debt-beomgyu-1128', nick: '뉴비도우미-범규', name: '뉴비도우미-범규', clearDebt: true }); // 「뉴비도우미-범규」 빚 없애기
GRANTS.push({ id: 'debt-parkjm-1122', nick: '박종모', name: '박종모', clearDebt: true }); // 「박종모」 빚 없애기
GRANTS.push({ id: 'gold-wjh-main-1121', name: '왕정훈 본계', goldAdd: 3000000 }); // 「왕정훈 본계」 +300만 골드
GRANTS.push({ id: 'admin-mats-1121', admin: true, mats: { aheart: 10, aspear: 10, dheart: 10 } }); // 관리자: 아누비스의 심장·아누비스의 창·드래곤 하트 10개씩
// 서버 복구 기념 (11/20): 칭호 「서버복구자」 + 경험치 2배권(1분) · 골드 2배권(1분) — 계정 닉네임이나 캐릭터 이름이 같으면 받는다
for (const [k, nick, name] of [['songdoha', '섹시한 송도하', '섹시한 송도하'], ['songdoha2', '섹시한도하', '섹시한도하'], ['songdoha3', '색시한도하', '색시한도하'], ['taehee', '이태희', '이태희임'], ['dohyun', '고트도현', '고트도현'], ['jsy', '정성윤석열이재명', '정성윤석열이재명']]) {
  GRANTS.push({ id: 'title-restorer-' + k, nick, name, title: 'restorer', keep: true });
  GRANTS.push({ id: 'cons-restorer-1120-' + k, nick, name, cons: { xp2: 1, gold2: 1 } });
}
GRANTS.push({ id: 'cls-admin-spirit-1117', admin: true, setCls: 'spirit' }); // 관리자 직업 → 정령술사
GRANTS.push({ id: 'cls-admin-spirit-1118', admin: true, setCls: 'spirit' }); // (다시) 예전 화면이 받기만 하고 적용을 못 해서 한 번 더
GRANTS.push({ id: 'gold-admin-1117', admin: true, goldAdd: 200000000 }); // 관리자 +2억 골드
const grantDoc = (uid) => '__rpggrant:' + uid;
const MAPS = /^[a-z][a-z0-9]{1,11}$/; // 맵 이름 (shaft1 처럼 숫자도 됨)
// 탄광 제 1갱도 바위: 누가 깼는지 모두 함께 본다 (바위 번호 → 다시 생기는 시각). 속에 든 광석은 서버가 정한다.
const ROCKS = new Map();
const ROCK_MS = 30000;
const ORE_ODDS = [['diamond', .1], ['sapphire', 2], ['ruby', 3], ['gold', 5], ['silver', 10], ['coal', 30], ['stone', 50]];
const rollOre = () => { let r = Math.random() * 100.1; for (const [k, p] of ORE_ODDS) { if (r < p) return k; r -= p; } return 'stone'; };
const SEATS = { moto: 1, bonggu: 2, lambo: 2, heli: 2 }; // 탈것 뒷자리
const VEH_OK = new Set(['kick', 'fixie', 'moto', 'bonggu', 'lambo', 'heli']);
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };
const word = (v) => (typeof v === 'string' && /^[a-z]{1,10}$/.test(v) ? v : '');
const itemId = (v) => (typeof v === 'string' && /^[a-z0-9_]{1,14}$/.test(v) ? v : '');
const PROF = require('./profanity');
const cleanChat = (t) => PROF.clean(String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60));
const cleanName = (n) => PROF.clean(String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 8));

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(key, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  return h.n > max;
}

/**
 * 계정 연동(1회): 화면에 같은 닉네임으로 보이는 계정이 둘일 때, RPG 캐릭터가 있는 쪽의 세이브를
 * 축구 게임을 실제로 하던 계정(뽑기·보관함 기록이 더 많은 쪽)으로 옮긴다. 원래 세이브는 '__rpgbak:<계정>' 에 백업.
 */
let linkStatus = '';
const shownNick = (a) => String(a.nickSet && a.nick ? a.nick : a.id.startsWith('u-') ? a.id.slice(2) : a.nick || 'PLAYER');
async function linkByNick(store, nick) {
  const flag = '__rpglink:' + nick;
  const done = await store.get(flag);
  if (done) return done.result;
  const low = nick.toLowerCase();
  const cands = (await store.listAll()).filter((a) => a && typeof a.id === 'string' && !a.id.startsWith('__') && shownNick(a).toLowerCase() === low);
  const foot = (c) => (c.pulls || 0) + Object.keys(c.inv || {}).length;
  const docs = new Map();
  for (const c of cands) docs.set(c.id, await store.get(docId(c.id)));
  const lvOf = (c) => { const d = docs.get(c.id); return d && d.save ? Number(d.save.lv) || 1 : 0; };
  let result;
  if (!cands.length) return 'no_account';
  if (cands.length === 1) result = 'same_account';
  else {
    const src = cands.slice().sort((a, b) => lvOf(b) - lvOf(a))[0];
    const dst = cands.filter((c) => c !== src).sort((a, b) => foot(b) - foot(a) || (a.created || 0) - (b.created || 0))[0];
    if (!lvOf(src)) return 'no_save';
    if (foot(src) >= foot(dst)) result = 'already_on_football_account';
    else if (lvOf(dst) >= lvOf(src)) return 'ambiguous';
    else {
      const sId = docId(src.id), dId = docId(dst.id), b1 = '__rpgbak:' + src.id, b2 = '__rpgbak:' + dst.id, t = Date.now();
      await store.txn([sId, dId, b1, b2], (m) => {
        m[b1] = { id: b1, uid: src.id, save: m[sId].save, t };
        if (m[dId]) m[b2] = { id: b2, uid: dst.id, save: m[dId].save, t };
        m[dId] = { id: dId, uid: dst.id, save: m[sId].save, t };
      });
      await store.remove(sId);
      result = 'moved';
    }
  }
  await store.txn([flag], (m) => { m[flag] = { id: flag, result, t: Date.now() }; });
  return result;
}

/** REST + 화면 제공 */
const GIFT = { fn: null }; // 관리자 지급을 접속 중인 사람에게 바로 보내기 (attach 에서 채움)
const TAKE = { fn: null }; // 다른 기기에 '저장하고 멈춰' 보내기 (attach 에서 채움)
function http(app, { store, auth, accounts }) {
  // 다른 주소(GitHub Pages)에서 열어도 로그인·저장이 되도록 허용 (쿠키가 아닌 토큰 방식이라 안전)
  const cors = (req, res, next) => {
    const o = req.headers.origin;
    if (o && ORIGINS.includes(o)) {
      res.setHeader('Access-Control-Allow-Origin', o);
      res.setHeader('Vary', 'Origin');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
      res.setHeader('Access-Control-Max-Age', '86400');
    }
    if (req.method === 'OPTIONS') return res.status(204).end();
    next();
  };
  app.use(['/api/rpg', '/api/register', '/api/signin'], cors);

  const who = (req) => { const h = req.headers.authorization || ''; const s = auth.verifySession(h.startsWith('Bearer ') ? h.slice(7) : ''); return s ? s.uid : null; };
  const wrap = (fn) => async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (limited('rpg:' + req.ip, 90, 10000)) return res.status(429).json({ error: 'too_many_requests' });
      const uid = who(req);
      if (!uid) return res.status(401).json({ error: 'unauthorized' });
      if (store) { await sancLoad(store); if (banLeft(uid) && !/delete/.test(req.path)) return res.status(403).json({ error: 'banned', left: leftTxt(banLeft(uid)) }); }
      const r = await fn(req, uid);
      res.status(r.status || 200).json(r.body);
    } catch (e) { console.error('[rpg]', e && e.stack || e); res.status(500).json({ error: 'server_error' }); }
  };

  app.get('/api/rpg/ping', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ rpg: true, link: linkStatus }); });
  app.get('/api/rpg/save', wrap(async (_req, uid) => {
    const a = await accounts.get(uid);
    if (!a) return { status: 401, body: { error: 'unauthorized' } };
    const d = await store.get(docId(uid));
    const got = (await store.get(grantDoc(uid))) || { done: [] };
    const grants = GRANTS.filter((g) => ((g.admin && uid === ADMIN_ID) || (g.nick && g.nick === a.nick) || (g.name && d && d.save && d.save.name === g.name)) && !got.done.includes(g.id) && (!g.requires || got.done.includes(g.requires))).map((g) => ({ id: g.id, lv: g.lv, title: g.title, setLv: g.setLv, lvAdd: g.lvAdd, sp: g.sp, ap: g.ap, spDown: g.spDown, apDown: g.apDown, goldMul: g.goldMul, goldAdd: g.goldAdd, item: g.item, setCls: g.setCls, recalc: g.recalc, cons: g.cons, mats: g.mats, clearDebt: g.clearDebt }));
    for (const g of (got.gifts || [])) if (!got.done.includes(g.id)) grants.push(g); // 관리자 탭에서 보낸 지급
    return { body: { id: uid, admin: uid === ADMIN_ID, grants, nick: a.nick, save: d ? d.save : null, t: d ? d.t : 0 } };
  }));
  app.post('/api/rpg/save', wrap(async (req, uid) => {
    const save = req.body && req.body.save;
    if (!save || typeof save !== 'object' || Array.isArray(save)) return { status: 400, body: { error: 'bad_save' } };
    if (JSON.stringify(save).length > MAX_SAVE) return { status: 413, body: { error: 'too_big' } };
    if (uid !== ADMIN_ID) { // 조작 방지: 말이 안 되는 값은 정상 범위로 되돌린다
      const fix = (v, lo, hi, d) => (Number.isFinite(+v) ? Math.max(lo, Math.min(hi, Math.round(+v))) : d);
      save.lv = fix(save.lv, 1, 200, 1); save.gold = fix(save.gold, 0, 1e11, 0);
      if (save.bank && typeof save.bank === 'object') save.bank.dep = fix(save.bank.dep, 0, 1e10, 0);
      if (save.eq && typeof save.eq === 'object') for (const k of Object.keys(save.eq)) { const e = save.eq[k]; if (e && typeof e === 'object') e.plus = fix(e.plus, 0, 20, 0); }
      if (Array.isArray(save.bag)) for (const e of save.bag) if (e && typeof e === 'object') e.plus = fix(e.plus, 0, 20, 0);
      if (save.flags && typeof save.flags === 'object') delete save.flags.admin;
    }
    if (!(await accounts.get(uid))) return { status: 401, body: { error: 'unauthorized' } };
    const id = docId(uid), t = Date.now();
    // 다른 기기가 더 최근에 저장했으면 거절한다 (예전 데이터가 새 데이터를 덮어쓰지 않게)
    const base = req.body && Number.isFinite(req.body.base) ? req.body.base : null;
    let conflict = false;
    await store.txn([id], (m) => { const cur = m[id]; if (base != null && cur && cur.t && cur.t !== base) { conflict = true; return; } m[id] = { id, uid, save, t }; });
    if (conflict) return { status: 409, body: { error: 'conflict' } };
    return { body: { ok: true, t } };
  }));

  // 본인 계정 삭제 (게임 안: 로그인된 상태 + 비밀번호 / 웹: 아이디 + 비밀번호)
  const wipe = async (id) => { try { await store.remove(docId(id)); await store.remove('__hor:' + id); } catch (e) { console.error('[rpg] 저장 삭제 실패', e.message); } }; // 공포게임 저장도 같이 지운다
  app.post('/api/rpg/deleteme', wrap(async (req, uid) => {
    const r = await accounts.selfDelete(uid, req.body && req.body.pw, true);
    if (r.error) return { status: 400, body: r };
    await wipe(uid); return { body: { ok: true } };
  }));
  app.post('/api/rpg/deleteweb', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (limited('del:' + req.ip, 5, 60000)) return res.status(429).json({ error: 'locked' });
      const user = String((req.body && req.body.user) || '').normalize('NFC').trim().toLowerCase().slice(0, 20);
      if (!user) return res.status(400).json({ error: 'bad_login' });
      const r = await accounts.selfDelete('u-' + user, req.body && req.body.pw, false);
      if (r.error) return res.status(400).json(r);
      await wipe('u-' + user); res.json({ ok: true });
    } catch (e) { console.error('[rpg]', e); res.status(500).json({ error: 'server_error' }); }
  });
  // 관리자: 신고 목록
  app.get('/api/rpg/admin/reports', wrap(async (_req, uid) => {
    if (uid !== ADMIN_ID) return { status: 403, body: { error: 'forbidden' } };
    const d = await store.get(REPORT_ID); return { body: { list: (d && d.list) || [] } };
  }));
  // 관리자: 계정 조회 (비밀번호는 돌려주지 않음) + 비밀번호 재설정
  app.get('/api/rpg/admin/lookup', wrap(async (req, uid) => {
    if (uid !== ADMIN_ID) return { status: 403, body: { error: 'forbidden' } };
    const q = String((req.query && req.query.q) || '').slice(0, 40);
    return { body: { list: await accounts.adminFind(q) } };
  }));
  // 관리자: 유저에게 레벨·골드·장비·아이템 지급 (접속 중이면 바로, 아니면 다음 접속 때)
  app.post('/api/rpg/admin/give', wrap(async (req, uid) => {
    if (uid !== ADMIN_ID) return { status: 403, body: { error: 'forbidden' } };
    const b = req.body || {};
    const user = String(b.user || '').normalize('NFC').trim().toLowerCase();
    if (!user) return { status: 400, body: { error: 'bad_user' } };
    const to = 'u-' + user;
    if (!(await accounts.get(to))) return { status: 404, body: { error: 'no_user' } };
    const id = 'gift-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
    const g = { id };
    const lv = Math.round(+b.setLv || 0); if (lv >= 1 && lv <= 200) { g.setLv = lv; g.recalc = true; }
    const gold = Math.round(+b.goldAdd || 0); if (gold > 0) g.goldAdd = Math.min(gold, 1e10);
    if (typeof b.item === 'string' && /^[a-z0-9_{}]{1,30}$/.test(b.item)) g.item = b.item;
    if (Array.isArray(b.items)) { const L = b.items.filter((x) => typeof x === 'string' && /^[a-z0-9_{}]{1,30}$/.test(x)).slice(0, 20); if (L.length) g.items = L; }
    if (Array.isArray(b.veh)) { const L = b.veh.filter((x) => typeof x === 'string' && /^[a-z0-9]{1,20}$/.test(x)).slice(0, 10); if (L.length) g.veh = L; }
    const cnt = (o) => { if (!o || typeof o !== 'object' || Array.isArray(o)) return null; const r = {}; let n = 0; for (const k of Object.keys(o).slice(0, 10)) if (/^[a-z0-9]{1,20}$/.test(k)) { const v = Math.round(+o[k] || 0); if (v > 0) { r[k] = Math.min(v, 999); n++; } } return n ? r : null; };
    const c = cnt(b.cons); if (c) g.cons = c; const m = cnt(b.mats); if (m) g.mats = m;
    if (Object.keys(g).length < 2) return { status: 400, body: { error: 'empty' } };
    const gd = grantDoc(to);
    await store.txn([gd], (mm) => { const d = mm[gd] || { id: gd, done: [] }; d.gifts = (d.gifts || []).concat([g]).slice(-30); mm[gd] = d; });
    const live = GIFT.fn ? GIFT.fn(to, g) : 0;
    return { body: { ok: true, live } };
  }));
  // 관리자: 유저 인벤토리 보기 (마지막으로 저장된 상태)
  app.get('/api/rpg/admin/inv', wrap(async (req, uid) => {
    if (uid !== ADMIN_ID) return { status: 403, body: { error: 'forbidden' } };
    const user = String((req.query && req.query.user) || '').normalize('NFC').trim().toLowerCase();
    const to = 'u-' + user; const d = await store.get(docId(to)); const s = d && d.save;
    if (!s) return { body: { none: 1 } };
    const pick = { name: s.name, lv: s.lv, cls: s.cls, job: s.job, job3: s.job3, gold: s.gold, bank: s.bank ? { dep: s.bank.dep, loan: s.bank.loan } : null, eq: s.eq, bag: s.bag, pots: s.pots, mats: s.mats, veh: s.veh, ride: s.ride, quick: s.quick };
    return { body: { save: pick, t: d.t || 0, online: !!(GIFT.on && GIFT.on(to)) } };
  }));
  app.post('/api/rpg/admin/resetpw', wrap(async (req, uid) => {
    if (uid !== ADMIN_ID) return { status: 403, body: { error: 'forbidden' } };
    const user = String((req.body && req.body.user) || '').normalize('NFC').trim().toLowerCase();
    const pw = String((req.body && req.body.pw) || '');
    if (!user) return { status: 400, body: { error: 'bad_user' } };
    const r = await accounts.adminSetPw('u-' + user, pw);
    if (r.error) return { status: 400, body: r };
    return { body: { ok: true } };
  }));

  // 이어하기 직전: 같은 계정으로 켜져 있는 다른 기기에 지금까지 저장하고 멈추라고 알린다
  app.post('/api/rpg/takeover', wrap(async (_req, uid) => {
    if (!(await accounts.get(uid))) return { status: 401, body: { error: 'unauthorized' } };
    return { body: { ok: true, n: TAKE.fn ? TAKE.fn(uid) : 0 } };
  }));

  app.post('/api/rpg/grantdone', wrap(async (req, uid) => {
    const gid = String((req.body && req.body.id) || '');
    const gift = /^gift-[a-z0-9]{6,20}$/.test(gid);
    if (!gift && !GRANTS.some((g) => g.id === gid && !g.keep)) return { status: 400, body: { error: 'bad_grant' } };
    const id = grantDoc(uid);
    await store.txn([id], (m) => { const d = m[id] || { id, done: [] }; if (gift) { d.gifts = (d.gifts || []).filter((g) => g.id !== gid); d.done = d.done.filter((x) => !/^gift-/.test(x)); } else if (!d.done.includes(gid)) d.done.push(gid); m[id] = d; });
    return { body: { ok: true } };
  }));

  // 끝없는 평야의 집·밭: 모든 캐릭터 저장에서 모아 보여준다 (10초 캐시) — 주인이 접속하지 않아도 보인다
  const HOUSE_T = new Set(['tent', 'container', 'cabin', 'small', 'mansion', 'grand']);
  const CROP_T = new Set(['potato', 'carrot', 'tomato', 'corn', 'strawberry', 'watermelon', 'pumpkin', 'goldapple']);
  let homes = { t: 0, data: null };
  app.get('/api/rpg/homes', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (limited('hm:' + req.ip, 30, 10000)) return res.status(429).json({ error: 'too_many_requests' });
      if (!homes.data || Date.now() - homes.t > 10000) {
        const out = [];
        for (const d of await store.listAll()) {
          if (!d || typeof d.id !== 'string' || !d.id.startsWith('__rpg:') || !d.save || typeof d.save !== 'object') continue;
          const h = d.save.home; if (!h || typeof h !== 'object' || !HOUSE_T.has(h.t)) continue;
          if (!d.save.flags || !d.save.flags.homeRef1) continue; // 환불 전(옛 규칙) 집은 주인이 접속하면 사라지므로 빼 둔다
          const farm = Array.isArray(d.save.farm) ? d.save.farm.slice(0, 80).map((f) => (f && CROP_T.has(f.c) ? [f.c, Math.round(num(f.t, 0, 1e14)), f.w === 0 ? 0 : 1] : 0)) : [];
          out.push({ u: String(d.uid || d.id).slice(0, 40), n: cleanName(d.save.name) || '모험가', t: h.t, x: Math.round(num(h.x, 0, 200000)), y: Math.round(num(h.y, 0, 200000)), f: farm });
        }
        for (const [u, c] of claims) if (Date.now() - c.t < 180000 && !out.some((o) => o.u === u)) out.push({ u, n: c.n, t: 'tent', x: c.x, y: c.y, f: [] });
        homes = { t: Date.now(), data: out };
      }
      res.json({ now: Date.now(), list: homes.data });
    } catch (e) { res.status(500).json({ error: 'server' }); }
  });
  // 집 자리 잡기: 서버가 최신 저장 + 방금 잡은 자리까지 보고 겹치는지 판정한다 (동시에 지어도 겹치지 않게)
  const claims = new Map(); // uid → { x, y, n, t }
  const homeRect = (x, y) => ({ x0: x - 158 - 16, x1: x + 158 + 30 + 6 * 32 + 16, y0: y - 208 - 16, y1: y + 9 * 32 }); // 대저택 + 밭 60평 크기
  app.post('/api/rpg/home/claim', wrap(async (req, uid) => {
    const b = req.body || {};
    const x = Math.round(num(b.x, 0, 200000)), y = Math.round(num(b.y, 0, 200000)), n = cleanName(b.n) || '모험가';
    if (limited('hc:' + uid, 20, 60000)) return { status: 429, body: { error: 'too_many_requests' } };
    const others = [];
    for (const d of await store.listAll()) {
      if (!d || typeof d.id !== 'string' || !d.id.startsWith('__rpg:') || d.uid === uid || !d.save || typeof d.save !== 'object') continue;
      const h = d.save.home; if (!h || typeof h !== 'object' || !HOUSE_T.has(h.t) || !d.save.flags || !d.save.flags.homeRef1) continue;
      others.push({ x: num(h.x, 0, 200000), y: num(h.y, 0, 200000), n: cleanName(d.save.name) || '모험가', u: d.uid });
    }
    const now = Date.now();
    for (const [u, c] of claims) { if (now - c.t > 180000) { claims.delete(u); continue; } if (u !== uid) { const i = others.findIndex((o) => o.u === u); if (i >= 0) others.splice(i, 1); others.push(c); } }
    const a = homeRect(x, y);
    for (const o of others) { const r = homeRect(o.x, o.y); if (a.x0 < r.x1 && r.x0 < a.x1 && a.y0 < r.y1 && r.y0 < a.y1) return { status: 409, body: { error: 'clash', n: o.n } }; }
    claims.set(uid, { x, y, n, t: now, u: uid }); homes.data = null; // 다른 사람 목록에도 바로 보이게
    return { body: { ok: true } };
  }));
  // ===== 경매장 =====
  // 물건은 올릴 때 서버가 맡고(올린 사람 가방에서 빠짐), 입찰한 돈도 그때 빠진다.
  // 더 높은 입찰이 오면 앞사람 돈은 돌려주고, 끝나면 낙찰자에게 물건·판 사람에게 돈(수수료 5%)을 지급으로 보낸다.
  const AUC = '__auction', AUC_DUR = [60, 1200, 3600, 43200], AUC_FEE = 0.05, AUC_MAX = 10;
  const sendGift = async (to, g) => {
    g.id = 'gift-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    const gd = grantDoc(to);
    await store.txn([gd], (mm) => { const d = mm[gd] || { id: gd, done: [] }; d.gifts = (d.gifts || []).concat([g]).slice(-150); mm[gd] = d; });
    if (GIFT.fn) GIFT.fn(to, g);
  };
  const aucItem = (it) => {
    if (!it || typeof it !== 'object') return null;
    const k = it.k, id = String(it.id || '');
    if (!/^[a-z0-9_]{1,30}$/.test(id)) return null;
    if (k === 'g') return { k, id, plus: Math.round(num(it.plus, 0, 20)), n: 1 };
    if (k === 'm' || k === 'p') { const n = Math.round(num(it.n, 1, 1e6)); return n >= 1 ? { k, id, n } : null; }
    return null;
  };
  const aucLoad = async () => { const d = await store.get(AUC); return d && Array.isArray(d.list) ? d.list : []; };
  app.get('/api/rpg/auc', wrap(async () => ({ body: { now: Date.now(), list: await aucLoad() } })));
  app.post('/api/rpg/auc/list', wrap(async (req, uid) => {
    const b = req.body || {}; const it = aucItem(b.it); const dur = Math.round(+b.dur || 0); const start = Math.round(num(b.start, 1, 1e10));
    if (!it || !AUC_DUR.includes(dur) || !(start >= 1)) return { status: 400, body: { error: 'bad' } };
    if (limited('al:' + uid, 15, 60000)) return { status: 429, body: { error: 'too_many_requests' } };
    let err = '', row = null;
    await store.txn([AUC], (m) => {
      const d = m[AUC] || { id: AUC, list: [], seq: 0 };
      if (d.list.filter((x) => x.s === uid).length >= AUC_MAX) { err = 'max'; return; }
      d.seq = (d.seq || 0) + 1;
      row = { id: 'a' + d.seq.toString(36), s: uid, sn: cleanName(b.n) || '모험가', it, start, bid: 0, b: '', bn: '', end: Date.now() + dur * 1000 };
      d.list.push(row); m[AUC] = d;
    });
    if (err) return { status: 409, body: { error: err } };
    return { body: { ok: true, row } };
  }));
  app.post('/api/rpg/auc/bid', wrap(async (req, uid) => {
    const b = req.body || {}; const id = String(b.id || ''); const amt = Math.round(num(b.amt, 1, 1e11));
    if (limited('ab:' + uid, 30, 60000)) return { status: 429, body: { error: 'too_many_requests' } };
    let err = '', prev = null, row = null;
    await store.txn([AUC], (m) => {
      const d = m[AUC]; const r = d && d.list.find((x) => x.id === id);
      if (!r || r.end <= Date.now()) { err = 'gone'; return; }
      if (r.s === uid) { err = 'self'; return; }
      if (r.b === uid) { err = 'top'; return; }
      const need = r.bid ? Math.ceil(r.bid * 1.05) : r.start;
      if (amt < need) { err = 'low'; return; }
      if (r.b) prev = { u: r.b, amt: r.bid };
      r.bid = amt; r.b = uid; r.bn = cleanName(b.n) || '모험가';
      if (r.end - Date.now() < 30000) r.end = Date.now() + 30000; // 끝나기 직전 입찰이면 30초 연장
      row = r; m[AUC] = d;
    });
    if (err) return { status: 409, body: { error: err } };
    if (prev) await sendGift(prev.u, { auc: { gold: prev.amt, msg: '더 높은 입찰이 들어와서 입찰금을 돌려받았어요' } });
    return { body: { ok: true, row } };
  }));
  app.post('/api/rpg/auc/cancel', wrap(async (req, uid) => {
    const id = String((req.body && req.body.id) || ''); let err = '', row = null;
    await store.txn([AUC], (m) => {
      const d = m[AUC]; const i = d ? d.list.findIndex((x) => x.id === id) : -1;
      if (i < 0) { err = 'gone'; return; } const r = d.list[i];
      if (r.s !== uid) { err = 'not_mine'; return; } if (r.b) { err = 'has_bid'; return; }
      d.list.splice(i, 1); row = r; m[AUC] = d;
    });
    if (err) return { status: 409, body: { error: err } };
    await sendGift(uid, { auc: { it: row.it, msg: '경매를 취소해서 물건을 돌려받았어요' } });
    return { body: { ok: true } };
  }));
  // 끝난 경매 정산 (5초마다)
  let aucBusy = false;
  setInterval(async () => {
    if (aucBusy) return; aucBusy = true;
    try {
      let done = [];
      await store.txn([AUC], (m) => { const d = m[AUC]; if (!d || !d.list || !d.list.length) return; const now = Date.now(); done = d.list.filter((x) => x.end <= now); if (!done.length) return; d.list = d.list.filter((x) => x.end > now); m[AUC] = d; });
      for (const r of done) {
        if (r.b) {
          await sendGift(r.b, { auc: { it: r.it, msg: '경매에서 낙찰받았어요!' } });
          await sendGift(r.s, { auc: { gold: Math.floor(r.bid * (1 - AUC_FEE)), msg: `경매에 올린 물건이 ${r.bn} 님에게 팔렸어요 (수수료 5%)` } });
        } else await sendGift(r.s, { auc: { it: r.it, msg: '아무도 입찰하지 않아서 물건을 돌려받았어요' } });
      }
    } catch (e) { console.error('[rpg] 경매 정산 실패', e.message); }
    aucBusy = false;
  }, 5000);

  // 순위: 돈·레벨 상위 10명 (20초 캐시, 로그인 없이 볼 수 있다)
  let rank = { t: 0, data: null };
  app.get('/api/rpg/rank', async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (limited('rk:' + req.ip, 30, 10000)) return res.status(429).json({ error: 'too_many_requests' });
      if (!rank.data || Date.now() - rank.t > 20000) {
        const rows = (await store.listAll())
          .filter((d) => d && typeof d.id === 'string' && d.id.startsWith('__rpg:') && d.save && typeof d.save === 'object')
          .filter((d) => d.uid !== ADMIN_ID) // 관리자는 순위에서 뺀다
          .map((d) => ({ uid: d.uid, name: cleanName(d.save.name) || '모험가', lv: Math.round(num(d.save.lv, 1, 999)), exp: num(d.save.exp, 0, 1e12), gold: Math.round(num(d.save.gold, 0, 1e12)), cls: word(d.save.cls), job: word(d.save.job), pvw: Math.round(num(d.save.pvw, 0, 1e6)), pvl: Math.round(num(d.save.pvl, 0, 1e6)) }));
        const gold = rows.slice().sort((a, b) => b.gold - a.gold || b.lv - a.lv).slice(0, 10);
        const lv = rows.slice().sort((a, b) => b.lv - a.lv || b.exp - a.exp).slice(0, 10);
        const pv = rows.filter((r) => r.pvw > 0).sort((a, b) => b.pvw - a.pvw || a.pvl - b.pvl).slice(0, 10);
        const nicks = new Map();
        for (const r of [...gold, ...lv, ...pv]) if (!nicks.has(r.uid)) { const a = await accounts.get(r.uid); nicks.set(r.uid, a ? a.nick : ''); }
        const out = (l) => l.map((r) => ({ name: r.name, nick: nicks.get(r.uid) || '', lv: r.lv, gold: r.gold, cls: r.cls, job: r.job, pvw: r.pvw, pvl: r.pvl }));
        rank = { t: Date.now(), data: { gold: out(gold), lv: out(lv), pv: out(pv), total: rows.length } };
      }
      res.json(rank.data);
    } catch (e) { console.error('[rpg]', e && e.stack || e); res.status(500).json({ error: 'server_error' }); }
  });

  // 화면: GitHub Pages 의 index.html 을 1분 캐시로 내려준다. 나머지 파일(음악 등)은 Pages 로 넘긴다.
  let page = { html: '', t: 0 };
  const loadPage = async () => {
    if (page.html && Date.now() - page.t < 60000) return page.html;
    try {
      const r = await fetch(PAGES + 'index.html?t=' + Date.now(), { signal: AbortSignal.timeout(8000) });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      page = { html: await r.text(), t: Date.now() };
    } catch (e) { console.error('[rpg] 화면 불러오기 실패:', e.message); }
    return page.html;
  };
  app.get('/rpg', async (req, res) => {
    // 게임 화면은 GitHub Pages에서 바로 받는다 (Render 전송량 절약). RPG_SERVE_HERE=1 이면 예전처럼 여기서 내려준다
    if (!process.env.RPG_SERVE_HERE) { const q = req.originalUrl.indexOf('?'); return res.redirect(302, PAGES + (q >= 0 ? req.originalUrl.slice(q) : '')); }
    if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect('/rpg/'); // 끝에 / 가 있어야 음악 등 상대 경로가 맞는다
    const html = await loadPage();
    if (!html) return res.status(502).type('text/plain; charset=utf-8').send('도파민 RPG 화면을 불러오지 못했어요. 잠시 후 새로고침해 주세요.');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
  });
  // 플레이스토어용: 개인정보처리방침 · 계정 삭제 페이지
  app.get('/rpg/privacy', (_req, res) => { res.type('html').send(PRIVACY_HTML.replace(/{{CONTACT}}/g, CONTACT)); });
  app.get('/rpg/delete', (_req, res) => { res.type('html').send(DELETE_HTML.replace(/{{CONTACT}}/g, CONTACT)); });
  // 앱 설치용 파일(매니페스트·서비스 워커·아이콘)은 같은 주소에서 직접 내려준다 (서비스 워커는 다른 주소로 넘기면 안 된다)
  const APPF = { 'manifest.webmanifest': 'application/manifest+json', 'sw.js': 'application/javascript', 'icon-192.png': 'image/png', 'icon-512.png': 'image/png' }; const appCache = new Map();
  app.get('/rpg/:file', async (req, res, next) => {
    const f = req.params.file, type = APPF[f]; if (!type) return next();
    let c = appCache.get(f);
    if (!c || Date.now() - c.t > 300000) { try { const r = await fetch(PAGES + f); if (r.ok) { c = { b: Buffer.from(await r.arrayBuffer()), t: Date.now() }; appCache.set(f, c); } } catch (e) { console.error('[rpg] 앱 파일 실패', f, e.message); } }
    if (!c) return res.status(502).end();
    res.setHeader('Cache-Control', f === 'sw.js' ? 'no-cache' : 'public, max-age=3600'); res.type(type).send(c.b);
  });
  // 플레이스토어 앱(TWA)이 이 사이트의 주인임을 확인하는 파일. Render 환경변수 RPG_APP_SHA256 에 서명 지문을 넣는다
  app.get('/.well-known/assetlinks.json', (_req, res) => {
    const fp = String(process.env.RPG_APP_SHA256 || '').split(',').map((x) => x.trim()).filter(Boolean);
    res.json(fp.length ? [{ relation: ['delegate_permission/common.handle_all_urls'], target: { namespace: 'android_app', package_name: process.env.RPG_APP_PKG || 'com.dobakrpg.app', sha256_cert_fingerprints: fp } }] : []);
  });
  app.get('/rpg/:file', (req, res) => {
    if (!/^[\w.\-]{1,60}$/.test(req.params.file)) return res.status(404).end();
    res.redirect(PAGES + req.params.file);
  });
}

/** 실시간: 같은 맵의 다른 플레이어 보여주기 */
function attach(io, { auth, accounts, store }) {
  if (store) linkByNick(store, '주시완').then((r) => { linkStatus = r; console.log('[rpg] 주시완 계정 연동:', r); }).catch((e) => { linkStatus = 'error'; console.error('[rpg] 연동 오류', e.message); });
  const ns = io.of('/rpg');
  // ===== 서버 이벤트: 매일 23시 평화의 마을에 거대 슬라임 =====
  // 1마리 → 2 → 4 → 8 → 16 → 32 → 64 마리로 분열. 기여도(준 피해)에 따라 80만 골드 · 슬라임 점액 1만 개 · 레벨 9 만큼의 경험치를 나눈다.
  // 서버(채널)마다 따로 진행 — 다른 채널과는 아무것도 공유하지 않는다
  const EVTS = new Map(); const EVTW = { warned: '' };
  const evtOf = (ch) => { let E = EVTS.get(ch); if (!E) { E = { on: false, stage: 0, t: 0, stageT: 0, contrib: new Map(), names: new Map(), day: '', startedAt: '' }; EVTS.set(ch, E); } return E; };
  const chEmit = (ch, ev, d) => { for (const s of byUid.values()) if (s.data.ch === ch) s.emit(ev, d); };
  const kstNow = () => new Date(Date.now() + 9 * 3600e3);
  const evtStart = (ch) => { const E = evtOf(ch), d = kstNow(); Object.assign(E, { on: true, stage: 0, t: Date.now(), stageT: Date.now(), contrib: new Map(), names: new Map(), day: d.toISOString().slice(0, 10) }); chEmit(ch, 'evt', { on: 1, stage: 0, intro: 1 }); chEmit(ch, 'tr:msg', '🟢 서버 이벤트! 평화의 마을에 거대 슬라임이 나타났어요! (밤 11시 · 11시 15분)'); };
  const evtEnd = (ch, full) => {
    const E = evtOf(ch); if (!E.on) return; E.on = false; const f = full ? 1 : Math.min(1, E.stage / 7);
    const list = [...E.contrib.entries()].sort((a, b) => b[1] - a[1]); const total = list.reduce((a, x) => a + x[1], 0) || 1;
    chEmit(ch, 'evt', { on: 0, end: 1, full: full ? 1 : 0 });
    list.forEach(([u, c], i) => { const q = byUid.get(u); if (!q) return; const sh = c / total; q.emit('evt:reward', { gold: Math.round(800000 * sh * f), gel: Math.round(10000 * sh * f), lv: Math.round(9 * sh * f * 100) / 100, pct: Math.round(sh * 1000) / 10, rank: i + 1, n: list.length, full: full ? 1 : 0 }); });
  };
  const evtRank = (E) => { const list = [...E.contrib.entries()].filter(([u]) => u !== ADMIN_ID).sort((a, b) => b[1] - a[1]); const total = list.reduce((a, x) => a + x[1], 0) || 1; return list.slice(0, 40).map(([u, c]) => [u, E.names.get(u) || '?', Math.round(c / total * 1000) / 10]); };
  const EVT_MS = 12 * 60e3; // 한 판은 최대 12분
  setInterval(() => {
    const d = kstNow(), h = d.getUTCHours(), m = d.getUTCMinutes(), day = d.toISOString().slice(0, 10);
    if (h === 22 && m === 59 && EVTW.warned !== day + ':a') { EVTW.warned = day + ':a'; ns.emit('tr:msg', '⏰ 곧 밤 11시! 평화의 마을에 거대 슬라임이 나타나요 (서버 이벤트)'); }
    else if (h === 23 && m === 14 && EVTW.warned !== day + ':b') { EVTW.warned = day + ':b'; ns.emit('tr:msg', '⏰ 곧 11시 15분! 거대 슬라임이 한 번 더 나타나요'); }
    let slot = null;
    if (h === 23 && m === 0) slot = day + ':a';
    else if (h === 23 && m === 15) slot = day + ':b';
    for (let ch = 1; ch <= CH_N; ch++) {
      const E = evtOf(ch);
      if (slot && !E.on && E.startedAt !== slot) { E.startedAt = slot; evtStart(ch); }
      if (E.on && Date.now() - E.t > EVT_MS) evtEnd(ch, false);
      if (E.on) chEmit(ch, 'evt:rank', { stage: E.stage, list: evtRank(E) });
    }
  }, 2000).unref?.();
  // 달콩빔 하루 사용 횟수 (한국 시간 기준 날짜마다 10번)
  const dkCount = new Map(); const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const dkLeft = (u) => { const day = kstDay(); let c = dkCount.get(u); if (!c || c.day !== day) { c = { day, n: 0 }; dkCount.set(u, c); } return Math.max(0, 10 - c.n); };
  // 마을 표지판: 관리자만 고칠 수 있고 모두에게 보인다 (계정 저장소의 '__rpgsigns' 문서에 저장)
  const SIGN_ID = '__rpgsigns'; const SIGN_MAPS = ['village', 'sea']; let signs = {};
  if (store) store.get(SIGN_ID).then((d) => { if (d && d.signs) signs = d.signs; }).catch(() => {});
  const signSave = async () => { try { if (store) await store.txn([SIGN_ID], (m) => { m[SIGN_ID] = { id: SIGN_ID, signs }; }); } catch (e) { console.error('[rpg] 표지판 저장 실패', e.message); } ns.emit('signs', signs); };
  const byUid = new Map(); // uid -> socket
  const TODAY = { day: '', m: new Map() }; // 오늘(한국 시간) 접속한 계정 uid -> 닉네임
  GIFT.on = (uid) => byUid.has(uid);
  GIFT.fn = (uid, g) => { const o = byUid.get(uid); if (!o) return 0; o.emit('gift', g); return 1; };
  TAKE.fn = (uid) => { const o = byUid.get(uid); if (!o) return 0; o.emit('takeover'); return 1; };
  const duels = new Map(); let pend = []; let lobbies = []; // 결투 신청 · 1:다수 결투 대기실
  const trades = new Map(); // 거래
  const raidPend = new Map(); // 파티 id -> 레이드 준비 중
  const parties = new Map(); // 파티 id -> { lead, m: [uid...] }  (최대 4명)
  const partyOf = (u) => { for (const [id, T] of parties) if (T.m.includes(u)) return id; return null; };
  const ptSend = (id) => { const T = parties.get(id); if (!T) return; for (const u of T.m) { const q = byUid.get(u); if (q) q.emit('pt:upd', { id, lead: T.lead, m: T.m }); } };
  const ptLeave = (u) => { const id = partyOf(u); if (!id) return; const T = parties.get(id); T.m = T.m.filter((x) => x !== u); const q = byUid.get(u); if (q) q.emit('pt:upd', null);
    if (T.m.length < 2) { for (const x of T.m) { const z = byUid.get(x); if (z) z.emit('pt:upd', null); } parties.delete(id); return; }
    if (T.lead === u) T.lead = T.m[0]; ptSend(id); };
  // 같이 사냥: 맵마다 '방장' 한 명이 몬스터를 움직이고, 나머지는 방장이 보내주는 몬스터 상태를 보며 때린 내용을 방장에게 보낸다.
  const hosts = new Map(); // 방(채널|맵) -> uid
  // ===== 채널(서버 #1~#15): 채널마다 최대 12명, 같은 채널 사람끼리만 같은 맵에서 보인다 =====
  const CH_N = 15, CH_MAX = 12, CH1_PW = process.env.RPG_CH1_PW || '잠신중';
  const baseOf = (r) => String(r || '').slice(String(r || '').indexOf('|') + 1);
  const roomOf = (ch, map) => ch + '|' + map; // 결투장·광산도 채널마다 따로
  const chCount = () => { const c = new Array(CH_N + 1).fill(0); for (const s of byUid.values()) if (s.data.ch) c[s.data.ch]++; return c; };
  const bossDead = new Map(); // map -> 보스가 쓰러진 시각 (다시 나타나기까지 10초)
  const bd = (m) => (bossDead.has(m) ? Date.now() - bossDead.get(m) : null);
  const hostOk = (m) => { const s = byUid.get(hosts.get(m)); return !!(s && s.data.room === m); };
  const pickHost = (m) => {
    if (hostOk(m) && !byUid.get(hosts.get(m)).data.idle) return;
    const cur = hosts.get(m), list = [...byUid.values()].filter((s) => s.data.room === m);
    const next = list.find((s) => !s.data.idle) || (hostOk(m) ? null : list[0]);
    if (!next || next.data.uid === cur) return;
    const old = byUid.get(cur); if (old && old.data.room === m) old.emit('host', { m: baseOf(m), h: 0 });
    hosts.set(m, next.data.uid); next.emit('host', { m: baseOf(m), h: 1, bd: bd(m) });
  };
  ns.use(async (socket, next) => {
    try {
      const s = auth.verifySession(socket.handshake.auth && socket.handshake.auth.token);
      if (!s) return next(new Error('unauthorized'));
      const a = await accounts.get(s.uid);
      if (!a) return next(new Error('unauthorized'));
      await sancLoad(store); const bl = banLeft(s.uid); if (bl) return next(new Error('banned:' + leftTxt(bl)));
      socket.data.uid = s.uid; socket.data.nick = a.nick;
      try { const d = await store.get(docId(s.uid)); socket.data.dkOk = DK_NAMES.has(a.nick) || !!(d && d.save && DK_NAMES.has(d.save.name)); } catch (e) { socket.data.dkOk = false; }
      next();
    } catch (e) { next(new Error('server_error')); }
  });
  ns.on('connection', (socket) => {
    const uid = socket.data.uid;
    const old = byUid.get(uid);
    if (old && old !== socket) { old.emit('kicked'); old.disconnect(true); } // 같은 계정은 한 곳에서만
    byUid.set(uid, socket);
    { const day = kstDay(); if (TODAY.day !== day) { TODAY.day = day; TODAY.m.clear(); } TODAY.m.set(uid, socket.data.nick || ''); }
    socket.data.p = null; socket.data.map = ''; socket.data.room = '';
    { const c = chCount(); let ch = 0; for (let i = 2; i <= CH_N; i++) if (c[i] < CH_MAX) { ch = i; break; } // 1번 서버는 비밀번호가 있어야 들어간다
      if (!ch) { socket.emit('full'); setTimeout(() => socket.disconnect(true), 300); return; }
      socket.data.ch = ch; socket.emit('ch', { ch, n: CH_N, max: CH_MAX }); socket.emit('n', chCount()[ch]); }
    // 채널 목록 · 채널 옮기기
    socket.on('ch:list', () => { const c = chCount(); socket.emit('ch:list', { cur: socket.data.ch, c: c.slice(1), max: CH_MAX, lock: [1] }); });
    socket.on('ch:set', (n, pw) => {
      if (n && typeof n === 'object') { pw = n.pw; n = n.ch; }
      n = Math.floor(+n); if (!(n >= 1 && n <= CH_N) || n === socket.data.ch) return;
      if (n === 1 && String(pw || '') !== CH1_PW) return socket.emit('tr:msg', '🔒 1번 서버 비밀번호가 틀렸어요');
      if (chCount()[n] >= CH_MAX) return socket.emit('tr:msg', '그 채널은 꽉 찼어요 (' + CH_MAX + '명)');
      const oldRoom = socket.data.room; if (socket.data.endTrades) socket.data.endTrades('상대가 다른 채널로 옮겼어요');
      if (oldRoom) { socket.leave('m:' + oldRoom); socket.to('m:' + oldRoom).emit('vc', { t: 'bye', from: uid }); }
      for (const q of byUid.values()) if (q.data.ride === uid) { q.data.ride = null; q.emit('ride:off', { why: '운전자가 다른 채널로 옮겨서 내렸어요' }); }
      if (socket.data.ride) { const dr = byUid.get(socket.data.ride); if (dr) dr.emit('tr:msg', ((socket.data.p && socket.data.p[1]) || '누군가') + ' 님이 내렸어요'); }
      if (partyOf(uid)) { ptLeave(uid); socket.emit('tr:msg', '다른 서버로 옮겨서 파티에서 나왔어요'); }
      socket.data.ch = n; socket.data.room = ''; socket.data.map = ''; socket.data.ride = null; if (oldRoom) pickHost(oldRoom);
      socket.emit('ch', { ch: n, n: CH_N, max: CH_MAX, moved: 1 }); socket.emit('n', chCount()[n]);
    });
    socket.on('s', (d) => {
      if (!d || typeof d !== 'object') return;
      const map = typeof d.m === 'string' && MAPS.test(d.m) ? d.m : '';
      if (!map) return;
      const room = roomOf(socket.data.ch, map);
      if (room !== socket.data.room) {
        const old = socket.data.room;
        if (old) socket.leave('m:' + old);
        socket.join('m:' + room); socket.data.map = map; socket.data.room = room;
        for (const q of byUid.values()) if (q.data.ride === uid && q.data.ch === socket.data.ch) q.emit('ride:map', { m: map, x: Math.round(num(d.x, 0, 200000)), y: Math.round(num(d.y, 0, 200000)) }); // 뒤에 탄 사람도 같이 이동
        if (socket.data.ride) { const dr = byUid.get(socket.data.ride); if (!dr || dr.data.room !== room) { socket.data.ride = null; socket.emit('ride:off', {}); } }
        if (old) pickHost(old);
        if (socket.data.endTrades) socket.data.endTrades('상대가 다른 곳으로 이동했어요');
        if (old) socket.to('m:' + old).emit('vc', { t: 'bye', from: uid });
        if (!hostOk(room) || byUid.get(hosts.get(room)).data.idle) { const o = byUid.get(hosts.get(room)); if (o && o !== socket && o.data.room === room) o.emit('host', { m: map, h: 0 }); hosts.set(room, uid); }
        socket.emit('host', { m: map, h: hosts.get(room) === uid ? 1 : 0, bd: bd(room) });
      }
      socket.data.pk = d.pk || PK_ALWAYS.has(cleanName(d.n)) ? 1 : 0; // 정해진 캐릭터는 PvP 항상 켬
      socket.data.p = [
        uid, cleanName(d.n) || socket.data.nick, word(d.r), word(d.c), word(d.j), Math.round(num(d.l, 1, 999)),
        Math.round(num(d.x, 0, 200000)), Math.round(num(d.y, 0, 200000)), d.f < 0 ? -1 : 1, d.a ? 1 : 0, d.w ? 1 : 0, itemId(d.wp), itemId(d.ar), d.t === 'admin' && uid !== ADMIN_ID ? '' : itemId(d.t), // 칭호 (관리자 칭호는 관리자만)
        Math.round(num(d.hp, 0, 100)), // 체력 %
        VEH_OK.has(d.v) ? d.v : '', socket.data.ride ? 1 : 0, // 탈것 · 다른 사람 뒤에 탔는지
        Math.round(num(d.hd, -7, 7) * 100) / 100, // 픽시 진행 방향 (도는 모습)
        Array.isArray(d.sp) ? d.sp.slice(0, 5).map((a) => Array.isArray(a) ? [Math.round(num(a[0], 0, 9)), Math.round(num(a[1], 0, 200000)), Math.round(num(a[2], 0, 200000))] : [0, 0, 0]) : [], // 정령술사의 정령
        Math.round(num(d.wl, 0, 20)), // 무기 강화 단계 (5강마다 무기가 커진다)
        socket.data.pk, // PvP 켬
        Array.isArray(d.pt) && d.pt[0] ? [word(d.pt[0]), Math.round(num(d.pt[1], 0, 20)), d.pt[2] ? 1 : 0, Math.round(num(d.pt[3], 0, 200000)), Math.round(num(d.pt[4], 0, 200000))] : 0, // 보스 펫 [종류, 레벨, 탔는지, x, y]
      ];
      // 운전자가 탈것에서 내리거나 좌석이 줄면 뒤에 탄 사람을 내리게 한다
      { const seats = SEATS[socket.data.p[15]] || 0; let n = 0; for (const q of byUid.values()) if (q.data.ride === uid) { if (++n > seats) { q.data.ride = null; q.emit('ride:off', { why: seats ? '자리가 없어요' : '운전자가 내렸어요' }); } } }
    });
    socket.on('idle', (v) => { socket.data.idle = !!v; if (socket.data.room) pickHost(socket.data.room); }); // 다른 창을 보는 중
    // 실시간 음성: 같은 맵에서 음성을 켠 사람끼리 연결 신호를 중계한다
    socket.on('vc', (d) => {
      const m = socket.data.room; if (!m || !d || typeof d !== 'object' || Array.isArray(d)) return;
      try { if (JSON.stringify(d).length > 12000) return; } catch (e) { return; }
      d.from = uid;
      if (d.to) { const t = byUid.get(String(d.to)); if (t && t.data.room === m) t.emit('vc', d); }
      else socket.to('m:' + m).emit('vc', d);
    });
    // 파티
    socket.on('pt:inv', (d) => {
      const t = byUid.get(String((d && d.to) || ''));
      if (!t || t === socket || t.data.ch !== socket.data.ch) return socket.emit('tr:msg', '상대가 같은 서버에 없어요');
      const mine = partyOf(uid); if (mine && parties.get(mine).m.length >= 4) return socket.emit('tr:msg', '파티는 4명까지예요');
      if (partyOf(t.data.uid)) return socket.emit('tr:msg', '상대는 이미 다른 파티에 있어요');
      const now = Date.now(); if (now - (socket.data.pinv || 0) < 2000) return; socket.data.pinv = now;
      t.data.pask = { from: uid, t: now };
      t.emit('pt:ask', { from: uid, op: (socket.data.p && socket.data.p[1]) || socket.data.nick });
      socket.emit('tr:msg', '파티 초대를 보냈어요');
    });
    socket.on('pt:ans', (d) => {
      const A = socket.data.pask; socket.data.pask = null;
      if (!A || !d || A.from !== String(d.from) || Date.now() - A.t > 60000) return;
      const inv = byUid.get(A.from); if (!inv) return socket.emit('tr:msg', '초대한 사람이 나갔어요');
      if (!d.yes) return inv.emit('tr:msg', ((socket.data.p && socket.data.p[1]) || '상대') + ' 님이 파티 초대를 거절했어요');
      if (partyOf(uid)) return;
      let id = partyOf(A.from);
      if (!id) { id = Math.random().toString(36).slice(2, 8); parties.set(id, { lead: A.from, m: [A.from] }); }
      const T = parties.get(id); if (T.m.length >= 4) return socket.emit('tr:msg', '파티가 가득 찼어요');
      T.m.push(uid); ptSend(id);
    });
    // 파티 참가 요청: 상대 파티의 파티장(파티가 없으면 상대 본인)에게 묻는다
    socket.on('pt:req', (d) => {
      const t = byUid.get(String((d && d.to) || ''));
      if (!t || t === socket || t.data.ch !== socket.data.ch) return socket.emit('tr:msg', '상대가 같은 서버에 없어요');
      if (partyOf(uid)) return socket.emit('tr:msg', '이미 파티에 있어요. 먼저 파티를 나가 주세요');
      const now = Date.now(); if (now - (socket.data.preq || 0) < 3000) return socket.emit('tr:msg', '잠시 후 다시 요청해 주세요'); socket.data.preq = now;
      const pid = partyOf(t.data.uid); const T = pid && parties.get(pid);
      if (T && T.m.length >= 4) return socket.emit('tr:msg', '그 파티는 가득 찼어요');
      const L = T ? byUid.get(T.lead) : t; if (!L) return socket.emit('tr:msg', '파티장이 접속해 있지 않아요');
      L.data.preqs = (L.data.preqs || []).filter((x) => now - x.t < 60000 && x.from !== uid).slice(-5); L.data.preqs.push({ from: uid, t: now });
      L.emit('pt:rq', { from: uid, op: (socket.data.p && socket.data.p[1]) || socket.data.nick, lv: socket.data.p && socket.data.p[5] });
      socket.emit('tr:msg', '파티 참가 요청을 보냈어요');
    });
    socket.on('pt:rans', (d) => {
      const now = Date.now(); const L = socket.data.preqs || []; const i = L.findIndex((x) => d && x.from === String(d.from) && now - x.t < 60000);
      if (i < 0) return; const A = L.splice(i, 1)[0];
      const rq = byUid.get(A.from); if (!rq) return socket.emit('tr:msg', '요청한 사람이 나갔어요');
      if (!d.yes) return rq.emit('tr:msg', ((socket.data.p && socket.data.p[1]) || '상대') + ' 님이 파티 참가를 거절했어요');
      if (partyOf(A.from)) return socket.emit('tr:msg', '그 사람은 이미 다른 파티에 들어갔어요');
      let id = partyOf(uid);
      if (id && parties.get(id).lead !== uid) return;
      if (!id) { id = Math.random().toString(36).slice(2, 8); parties.set(id, { lead: uid, m: [uid] }); }
      const T = parties.get(id); if (T.m.length >= 4) return socket.emit('tr:msg', '파티가 가득 찼어요');
      T.m.push(A.from); ptSend(id);
    });
    socket.on('pt:leave', () => ptLeave(uid));
    // ===== 주간 레이드: 파티장이 신청 → 3명 모두 같은 곳에 있는지 확인 → 각자 강함을 받아 보스 세기를 정한다 =====
    socket.on('raid:ask', () => {
      const pid = partyOf(uid), T = pid && parties.get(pid);
      if (!T) return socket.emit('tr:msg', '3명 파티를 먼저 만들어 주세요');
      if (T.lead !== uid) return socket.emit('tr:msg', '파티장만 레이드를 시작할 수 있어요');
      if (T.m.length !== 3) return socket.emit('tr:msg', '레이드는 꼭 3명이서만 들어갈 수 있어요 (지금 ' + T.m.length + '명)');
      const ss = T.m.map((u) => byUid.get(u));
      if (ss.some((q) => !q || q.data.room !== socket.data.room)) return socket.emit('tr:msg', '파티원 3명이 모두 같은 곳(제단지기 근처)에 있어야 해요');
      const R = { pid, got: new Map(), done: false };
      raidPend.set(pid, R);
      ss.forEach((q) => q.emit('raid:pw?'));
      setTimeout(() => { if (raidPend.get(pid) === R && !R.done) { raidPend.delete(pid); for (const q of ss) if (q) q.emit('tr:msg', '레이드 준비가 끝나지 않았어요. 다시 시도해 주세요'); } }, 6000);
    });
    socket.on('raid:pw', (d) => {
      const pid = partyOf(uid), R = pid && raidPend.get(pid), T = pid && parties.get(pid);
      if (!R || !T || R.done || !d || typeof d !== 'object') return;
      R.got.set(uid, { p: num(d.p, 0, 1e7), dps: num(d.dps, 1, 1e9), hp: num(d.hp, 1, 1e8), def: num(d.def, 0, 1e6), no: d.no ? 1 : 0 });
      if (R.got.size < T.m.length) return;
      R.done = true; raidPend.delete(pid);
      const ss = T.m.map((u) => byUid.get(u)).filter(Boolean);
      const list = [...R.got.values()];
      const sumDps = list.reduce((a, c) => a + c.dps, 0), avgHp = list.reduce((a, c) => a + c.hp, 0) / list.length, avgDef = list.reduce((a, c) => a + c.def, 0) / list.length, pw = list.reduce((a, c) => a + c.p, 0);
      // 보통은 못 이기게: 4분(광폭화 전) 동안 예상 피해의 1.3배 체력, 한 대에 체력의 35%쯤 깎는 공격력
      const k = 'raid' + Math.random().toString(36).slice(2, 8).replace(/[^a-z0-9]/g, 'x');
      const go = { k, p: Math.round(pw), hp: Math.round(sumDps * 240 * 1.3 * 0.25), atk: Math.round((avgHp * 0.35 + avgDef * 0.6) * 0.5), /* 체력 75%↓ · 공격력 50%↓ */ def: Math.round(60 + pw / 400) };
      for (const q of ss) q.emit('raid:go', go);
    });
    // 거래
    const tOther = (T) => (T.a === uid ? T.b : T.a);
    const tEnd = (id, msg) => { const T = trades.get(id); if (!T) return; if (T.timer) clearTimeout(T.timer); trades.delete(id); for (const u of [T.a, T.b]) { const q = byUid.get(u); if (q) q.emit('tr:end', { id, msg: u === uid ? '' : msg }); } };
    socket.data.endTrades = (msg) => { for (const [id, T] of trades) if (T.a === uid || T.b === uid) tEnd(id, msg); };
    socket.on('tr:req', (d) => {
      const t = byUid.get(String((d && d.to) || ''));
      if (!t || t === socket || t.data.room !== socket.data.room) return socket.emit('tr:msg', '상대가 근처에 없어요');
      for (const T of trades.values()) if ([T.a, T.b].includes(uid) || [T.a, T.b].includes(t.data.uid)) return socket.emit('tr:msg', '이미 거래 중이에요');
      { const la = socket.data.p && socket.data.p[5], lb = t.data.p && t.data.p[5]; if (la && lb && Math.abs(la - lb) >= 60) return socket.emit('tr:msg', '레벨 차이가 60 이상이면 거래할 수 없어요'); }
      const id = Math.random().toString(36).slice(2, 9);
      trades.set(id, { a: uid, b: t.data.uid, off: {}, lk: new Set(), ok: false, t: Date.now() });
      t.emit('tr:ask', { id, from: uid, op: (socket.data.p && socket.data.p[1]) || socket.data.nick });
      socket.emit('tr:msg', '거래를 신청했어요. 상대의 대답을 기다리는 중…');
    });
    socket.on('tr:ans', (d) => {
      const id = String((d && d.id) || ''), T = trades.get(id); if (!T || T.b !== uid || T.ok) return;
      if (!d.yes) return tEnd(id, '상대가 거래를 거절했어요');
      T.ok = true;
      for (const u of [T.a, T.b]) { const q = byUid.get(u), o = byUid.get(u === T.a ? T.b : T.a); if (q) q.emit('tr:open', { id, op: (o && o.data.p && o.data.p[1]) || '?' }); }
    });
    socket.on('tr:offer', (d) => {
      const id = String((d && d.id) || ''), T = trades.get(id); if (!T || !T.ok || (T.a !== uid && T.b !== uid)) return;
      const o = d.offer; try { if (!o || typeof o !== 'object' || JSON.stringify(o).length > 4000) return; } catch (e) { return; }
      T.off[uid] = o; T.lk.clear(); if (T.timer) { clearTimeout(T.timer); T.timer = null; }
      const other = byUid.get(tOther(T)); if (other) other.emit('tr:offer', { id, offer: o });
      for (const u of [T.a, T.b]) { const q = byUid.get(u); if (q) q.emit('tr:st', { id, lk: [] }); }
    });
    socket.on('tr:lock', (d) => {
      const id = String((d && d.id) || ''), T = trades.get(id); if (!T || !T.ok || (T.a !== uid && T.b !== uid)) return;
      if (d.on) T.lk.add(uid); else T.lk.delete(uid);
      if (T.timer && T.lk.size < 2) { clearTimeout(T.timer); T.timer = null; }
      if (T.lk.size === 2 && !T.timer) {
        T.timer = setTimeout(() => { if (trades.get(id) !== T || T.lk.size < 2) return; trades.delete(id); for (const u of [T.a, T.b]) { const q = byUid.get(u); if (q) q.emit('tr:done', { id, give: T.off[u] || {}, get: T.off[u === T.a ? T.b : T.a] || {} }); } }, 5000);
        for (const u of [T.a, T.b]) { const q = byUid.get(u); if (q) q.emit('tr:st', { id, lk: [...T.lk], at: Date.now() + 5000 }); }
        return;
      }
      for (const u of [T.a, T.b]) { const q = byUid.get(u); if (q) q.emit('tr:st', { id, lk: [...T.lk] }); }
    });
    socket.on('tr:cancel', (d) => tEnd(String((d && d.id) || ''), '상대가 거래를 취소했어요'));
    const amHost = () => !!socket.data.room && hosts.get(socket.data.room) === uid;
    let evN = 0, evT = 0;
    const flood = () => { const now = Date.now(); if (now - evT > 1000) { evT = now; evN = 0; } return ++evN > 300; };
    // 방장 → 같은 맵 사람들: 몬스터 상태
    socket.on('es', (l) => {
      if (!amHost() || !l || flood()) return;
      if (Array.isArray(l)) { if (l.length > 150) return; }
      else if (typeof l === 'object') { const d = Array.isArray(l.d) ? l.d.slice(0, 150) : [], g = Array.isArray(l.g) ? l.g.slice(0, 150).map((x) => String(x).slice(0, 20)) : []; l = { d, g }; } // 바뀐 몬스터만 (전송량 절약)
      else return;
      socket.to('m:' + socket.data.room).volatile.emit('es', l);
    });
    // 전투 이벤트 중계
    socket.on('ev', (d) => {
      const m = socket.data.room;
      if (!m || !d || typeof d !== 'object' || Array.isArray(d) || flood()) return;
      try { if (JSON.stringify(d).length > (d.k === 'sk' ? 7000 : 2500)) return; } catch (e) { return; }
      if (d.k === 'hit') { if (amHost()) return; const h = byUid.get(hosts.get(m)); if (h && h.data.room === m) { d.from = uid; h.emit('ev', d); } }
      else if (d.k === 'kill' || d.k === 'ep') { if (amHost()) { if (d.k === 'kill' && d.bs) bossDead.set(m, Date.now()); socket.to('m:' + m).emit('ev', d); } }
      else if (d.k === 'pvh') { const t = byUid.get(String(d.to)); if (!m.startsWith('arena') && !(socket.data.pk && t && t.data.pk)) return; if (t && t.data.room === m) { d.from = uid; t.emit('ev', d); } } // 결투: 상대에게 피해
      else if (d.k === 'pvend') { if (m.startsWith('arena')) socket.to('m:' + m).emit('ev', { k: 'pvend', from: uid }); } // 결투: 내가 졌다
      else if (d.k === 'sk') { d.from = uid; socket.to('m:' + m).volatile.emit('ev', d); } // 다른 사람에게 내 스킬 연출 보여주기
      else if (d.k === 'bf') { if (amHost()) socket.to('m:' + m).emit('ev', d); } // 보스 예고 표시·피하기 버튼을 같은 맵 사람들에게
      else if (d.k === 'gr') { socket.to('m:' + m).volatile.emit('ev', d); }
      else if (d.k === 'skd') { socket.to('m:' + m).emit('ev', { k: 'skd', on: d.on ? 1 : 0, a: Math.max(-7, Math.min(7, +d.a || 0)), from: uid }); } // 픽시 스키딩 (자국·소리) // 마을 할머니 추격 장면 공유
      else if (d.k === 'bd') { if (uid === ADMIN_ID) return; socket.to('m:' + m).emit('ev', { k: 'bd', id: d.id, v: +d.v || 0, from: uid }); } // 보스 기여도(내가 넣은 피해) 공유 (관리자는 빼기)
      else if (d.k === 'dmg') { if (!amHost()) return; const t = byUid.get(String(d.to)); if (t && t.data.room === m) t.emit('ev', d); }
      else if (d.k === 'pois') { if (!amHost()) return; const t = byUid.get(String(d.to)); if (t && t.data.room === m) t.emit('ev', d); } // 전갈 독 전달
    });
    // 결투 신청
    socket.on('duel:req', () => {
      if (socket.data.map !== 'village') return;
      const now = Date.now();
      for (const [k, D] of duels) if (now - D.t > 60000) duels.delete(k);
      pend = pend.filter((q) => now - q.t < 15000 && q.uid !== uid && byUid.get(q.uid) && byUid.get(q.uid).data.map === 'village' && byUid.get(q.uid).data.ch === socket.data.ch);
      const other = pend.shift();
      if (!other) { pend.push({ uid, t: now }); socket.emit('duel:wait'); return; }
      const id = Math.random().toString(36).slice(2, 8);
      duels.set(id, { a: other.uid, b: uid, yes: new Set(), t: now });
      const nameOf = (u) => { const q = byUid.get(u); return (q && q.data.p && q.data.p[1]) || (q && q.data.nick) || '?'; };
      byUid.get(other.uid).emit('duel:ask', { id, op: nameOf(uid) });
      socket.emit('duel:ask', { id, op: nameOf(other.uid) });
    });
    // 1:다수 결투: 한 명이 '혼자'로 열면 15초 동안 '여럿' 쪽 참가자를 받는다 (최대 4명)
    socket.on('duel:solo', () => {
      if (socket.data.map !== 'village') return;
      const now = Date.now(); lobbies = lobbies.filter((L) => !L.done);
      if (lobbies.some((L) => L.solo === uid || L.team.includes(uid))) return;
      const L = { id: Math.random().toString(36).slice(2, 8), solo: uid, team: [], t: now, done: false, ch: socket.data.ch }; lobbies.push(L);
      const nm = (socket.data.p && socket.data.p[1]) || socket.data.nick || '?';
      ns.to('m:' + socket.data.room).emit('tr:msg', '⚔ ' + nm + ' 님이 1:다수 결투를 열었어요! 15초 안에 결투 심판 바론에게 「여럿 쪽 참가」를 눌러 주세요');
      socket.emit('duel:lobby', { role: 'solo', n: 0 });
      setTimeout(() => {
        L.done = true; const s0 = byUid.get(L.solo); const team = L.team.filter((u) => { const q = byUid.get(u); return q && q.data.map === 'village' && q.data.ch === L.ch; });
        if (!s0 || s0.data.map !== 'village' || s0.data.ch !== L.ch) { team.forEach((u) => { const q = byUid.get(u); if (q) q.emit('duel:cancel'); }); return; }
        if (!team.length) { s0.emit('tr:msg', '아무도 참가하지 않아서 1:다수 결투가 취소됐어요'); s0.emit('duel:cancel'); return; }
        const key = 'arena' + Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
        const sides = { [L.solo]: 0 }; team.forEach((u) => { sides[u] = 1; });
        s0.emit('duel:go', { arena: key, side: 0, idx: 0, sides });
        team.forEach((u, i) => { const q = byUid.get(u); if (q) q.emit('duel:go', { arena: key, side: 1, idx: i, sides }); });
      }, 15000);
    });
    socket.on('duel:team', () => {
      if (socket.data.map !== 'village') return;
      const L = lobbies.find((x) => !x.done && x.solo !== uid && x.ch === socket.data.ch && Date.now() - x.t < 15000);
      if (!L) return socket.emit('tr:msg', '지금 열린 1:다수 결투가 없어요');
      if (L.team.includes(uid)) return; if (L.team.length >= 4) return socket.emit('tr:msg', '여럿 쪽 자리가 꽉 찼어요 (최대 4명)');
      L.team.push(uid); const nm = (socket.data.p && socket.data.p[1]) || '?';
      socket.emit('duel:lobby', { role: 'team', n: L.team.length, left: Math.max(0, Math.ceil((15000 - (Date.now() - L.t)) / 1000)) });
      const s0 = byUid.get(L.solo); if (s0) s0.emit('tr:msg', '⚔ ' + nm + ' 님이 여럿 쪽에 참가했어요 (' + L.team.length + '명)');
    });
    socket.on('duel:ans', (d) => {
      const id = String((d && d.id) || ''), D = duels.get(id);
      if (!D || (D.a !== uid && D.b !== uid)) return;
      const both = [D.a, D.b].map((u) => byUid.get(u));
      if (!d.yes) { duels.delete(id); both.forEach((q) => q && q.emit('duel:cancel')); return; }
      D.yes.add(uid);
      if (D.yes.size < 2) return;
      duels.delete(id);
      const key = 'arena' + Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
      both.forEach((q, i) => q && q.emit('duel:go', { arena: key, side: i }));
    });
    // 지도: 접속한 모든 사람의 위치 (1초에 한 번까지)
    socket.on('who', (cb) => {
      const now = Date.now(); if (typeof cb !== 'function' || now - (socket.data.wt || 0) < 700) return; socket.data.wt = now;
      const list = [];
      for (const s of byUid.values()) { const q = s.data.p; if (q && s.data.map && s.data.ch === socket.data.ch && list.length < 80) { const pid = partyOf(s.data.uid); list.push([q[0], q[1], q[5], s.data.map, q[6], q[7], pid ? parties.get(pid).m.length : 0]); } }
      cb(list);
    });
    // 채팅: 같은 맵 사람들 머리 위에 뜬다 (0.8초에 한 번)
    // 관리자 공지: 접속한 모든 사람 화면 위에 5초 동안 크게 띄운다
    socket.emit('signs', signs);
    socket.on('sign:set', async (d) => {
      if (uid !== ADMIN_ID || !d || !SIGN_MAPS.includes(d.m)) return;
      const t = String(d.t || '').replace(/[\u0000-\u0009\u000b-\u001f]/g, ' ').split('\n').slice(0, 6).map((x) => x.slice(0, 40)).join('\n').trim().slice(0, 200);
      signs = { ...signs, [d.m]: { ...(signs[d.m] || {}), t, by: (socket.data.p && socket.data.p[1]) || '관리자', at: Date.now() } };
      await signSave();
    });
    // 표지판 댓글: 한 사람당 표지판마다 1개 (다시 쓰면 수정), 본인 삭제 가능, 관리자는 아무 댓글이나 삭제
    socket.on('sign:cmt', async (d) => {
      if (!d || !SIGN_MAPS.includes(d.m) || flood()) return;
      const now = Date.now(); if (now - (socket.data.cmtT || 0) < 3000) return socket.emit('tr:msg', '잠시 후 다시 써 주세요'); socket.data.cmtT = now;
      if (muteLeft(uid)) return socket.emit('tr:msg', '🔇 채팅 금지 중이에요 (' + leftTxt(muteLeft(uid)) + ' 남음)');
      const t = cleanChat(d.t).slice(0, 60); if (!t) return;
      const S = { ...(signs[d.m] || { t: '' }) }; const c = { ...(S.c || {}) };
      if (!c[uid] && Object.keys(c).length >= 300) return socket.emit('tr:msg', '댓글이 너무 많아요');
      c[uid] = { n: (socket.data.p && socket.data.p[1]) || socket.data.nick || '?', t, at: now, ed: c[uid] ? 1 : 0 };
      S.c = c; signs = { ...signs, [d.m]: S }; await signSave();
    });
    socket.on('sign:del', async (d) => {
      if (!d || !SIGN_MAPS.includes(d.m)) return;
      const who = d.u && uid === ADMIN_ID ? String(d.u) : uid;
      const S = signs[d.m]; if (!S || !S.c || !S.c[who]) return;
      const c = { ...S.c }; delete c[who]; signs = { ...signs, [d.m]: { ...S, c } }; await signSave();
    });
    // 관리자의 달콩빔: 맞은 사람 화면에 달콩이 사진 (관리자만, 같은 맵, 1초에 한 번)
    if (socket.data.dkOk && uid !== ADMIN_ID) socket.emit('dkleft', dkLeft(uid));
    socket.on('dk', (d) => {
      if (!d || !(uid === ADMIN_ID || socket.data.dkOk)) return; const t = byUid.get(String(d.to || '')); if (!t || t.data.room !== socket.data.room) return;
      const now = Date.now(); if (now - (t.data.dkT || 0) < 1000) return;
      if (uid !== ADMIN_ID) { const left = dkLeft(uid); if (left <= 0) return socket.emit('dkleft', 0); const c = dkCount.get(uid); c.n++; socket.emit('dkleft', dkLeft(uid)); }
      t.data.dkT = now; t.emit('dk');
    });
    // 탈것 뒤에 타기 (오토바이 1명, 봉구차·람보르기니 2명)
    socket.on('ride', (d) => {
      const dr = byUid.get(String((d && d.to) || '')); if (!dr || dr === socket || socket.data.ride) return;
      const me = socket.data.p, p = dr.data.p; if (!me || !p || dr.data.room !== socket.data.room) return;
      if (dr.data.ride) return socket.emit('tr:msg', '그 사람도 다른 사람 뒤에 타고 있어요');
      const seats = SEATS[p[15]] || 0; if (!seats) return socket.emit('tr:msg', '뒤에 탈 수 있는 탈것이 아니에요');
      if (Math.hypot(p[6] - me[6], p[7] - me[7]) > 120) return socket.emit('tr:msg', '더 가까이 가야 해요');
      let n = 0; for (const q of byUid.values()) if (q.data.ride === dr.data.uid) n++;
      if (n >= seats) return socket.emit('tr:msg', '자리가 꽉 찼어요');
      socket.data.ride = dr.data.uid; socket.emit('ride:ok', { to: dr.data.uid, seat: n });
      dr.emit('tr:msg', ((me && me[1]) || '누군가') + ' 님이 뒤에 탔어요!');
    });
    socket.on('ride:off', () => { if (socket.data.ride) { const dr = byUid.get(socket.data.ride); socket.data.ride = null; if (dr) dr.emit('tr:msg', ((socket.data.p && socket.data.p[1]) || '누군가') + ' 님이 내렸어요'); } });
    // 경찰봉: 맞은 사람을 파출소 감옥에 30초 가둔다 (관리자 · 이태희 계정만)
    socket.on('jail', (d) => {
      if (!(uid === ADMIN_ID || socket.data.nick === '이태희') || !d) return;
      const t = byUid.get(String(d.to || '')); if (!t || t === socket || t.data.room !== socket.data.room) return;
      const now = Date.now(); if (now - (t.data.jailT || 0) < 31000) return; t.data.jailT = now;
      t.data.ride = null; t.emit('jailed', { by: (socket.data.p && socket.data.p[1]) || '경찰', s: 30 });
      socket.emit('tr:msg', ((t.data.p && t.data.p[1]) || '상대') + ' 님을 감옥에 가뒀어요 (30초)');
    });
    { const E = evtOf(socket.data.ch); if (E.on) socket.emit('evt', { on: 1, stage: E.stage }); }
    socket.on('evt:dmg', (v) => { // 이벤트 슬라임에게 준 피해 (기여도)
      const E = evtOf(socket.data.ch); if (!E.on || socket.data.map !== 'village') return; const now = Date.now(); if (now - (socket.data.evdT || 0) < 700) return; socket.data.evdT = now;
      const n = Math.max(0, Math.min(2e7, Number(v) || 0)); if (!n) return; E.contrib.set(uid, (E.contrib.get(uid) || 0) + n); E.names.set(uid, (socket.data.p && socket.data.p[1]) || socket.data.nick || '?');
    });
    socket.on('evt:clear', (d) => { // 방장이 '이번 단계 슬라임을 다 잡았다'고 알린다
      const E = evtOf(socket.data.ch), ch = socket.data.ch;
      if (!E.on || socket.data.map !== 'village' || !d || +d.stage !== E.stage || Date.now() - E.stageT < 4000) return;
      E.stage++; E.stageT = Date.now(); if (E.stage > 6) return evtEnd(ch, true);
      chEmit(ch, 'evt', { on: 1, stage: E.stage, split: 1 });
    });
    socket.on('rock:sync', () => { const now = Date.now(), pre = socket.data.ch + ':'; const l = []; for (const [k, t] of ROCKS) { if (t <= now) ROCKS.delete(k); else if (k.startsWith(pre)) l.push([+k.slice(pre.length), t - now]); } socket.emit('rocks', l); });
    socket.on('rock:hit', (d) => {
      if (socket.data.map !== 'shaft1' || !d) return; const i = Math.floor(+d.i); if (!(i >= 0 && i < 3000)) return;
      const now = Date.now(); const rk = socket.data.ch + ':' + i; // 돌은 같은 채널끼리 공유
      if (now - (socket.data.rockT || 0) < 850) { socket.emit('rock:no', { i, ms: Math.max(0, (ROCKS.get(rk) || 0) - now) }); return; }
      if ((ROCKS.get(rk) || 0) > now) { socket.emit('rock:no', { i, ms: ROCKS.get(rk) - now }); return; }
      socket.data.rockT = now; ROCKS.set(rk, now + ROCK_MS); if (ROCKS.size > 4000) for (const [k, t] of ROCKS) if (t <= now) ROCKS.delete(k);
      socket.emit('rock:ok', { i, o: rollOre(), ms: ROCK_MS });
      socket.to('m:' + socket.data.room).emit('rock', { i, ms: ROCK_MS, by: uid });
    });
    socket.on('admin:spawn', (d) => { // 관리자: /드래곤 — 지금 있는 맵의 방장에게 드래곤을 소환하게 한다
      if (uid !== ADMIN_ID || !d || d.t !== 'dragon') return; const m = socket.data.room; if (!m) return;
      const h = byUid.get(hosts.get(m)); const tgt = h && h.data.room === m ? h : socket;
      tgt.emit('admin:spawn', { t: 'dragon', m: baseOf(m), x: Math.round(num(d.x, 0, 200000)), y: Math.round(num(d.y, 0, 200000)) });
      ns.to('m:' + m).emit('tr:msg', '🐉 관리자가 화염 드래곤을 소환했다!!');
    });
    socket.on('evt:admin', (d) => { if (uid !== ADMIN_ID) return; const ch = socket.data.ch; if (d === 'start' && !evtOf(ch).on) evtStart(ch); if (d === 'stop') evtEnd(ch, false); }); // 관리자 테스트용
    socket.on('ann', (t) => {
      if (uid !== ADMIN_ID) return;
      const now = Date.now(); if (now - (socket.data.annT || 0) < 3000) return; socket.data.annT = now;
      const msg = String(t || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60); if (!msg) return;
      ns.emit('ann', { t: msg, by: (socket.data.p && socket.data.p[1]) || '관리자' });
    });
    // 신고: 욕설·괴롭힘 등. 최근 채팅 몇 줄과 함께 저장 (관리자가 확인)
    socket.on('rep', async (d) => {
      if (!d || flood()) return; const now = Date.now(); if (now - (socket.data.repT || 0) < 10000) return socket.emit('tr:msg', '잠시 후 다시 신고해 주세요'); socket.data.repT = now;
      const to = String(d.to || '').slice(0, 60), t = byUid.get(to);
      const why = String(d.why || '').replace(/[\u0000-\u001f]/g, ' ').slice(0, 30), lines = (Array.isArray(d.log) ? d.log : []).slice(-8).map((x) => String(x).replace(/[\u0000-\u001f]/g, ' ').slice(0, 80));
      const rec = { at: now, by: uid, byName: (socket.data.p && socket.data.p[1]) || socket.data.nick, to, toName: t ? ((t.data.p && t.data.p[1]) || t.data.nick) : String(d.name || '').slice(0, 12), why, lines };
      try { await store.txn([REPORT_ID], (m) => { const x = m[REPORT_ID] || { id: REPORT_ID, list: [] }; x.list = [rec, ...(x.list || []).filter((r) => now - r.at < 90 * 864e5)].slice(0, 500); m[REPORT_ID] = x; }); } catch (e) { console.error('[rpg] 신고 저장 실패', e.message); }
      socket.emit('tr:msg', '🚩 신고가 접수됐어요. 관리자가 확인할게요');
      const adm = byUid.get(ADMIN_ID); if (adm) adm.emit('tr:msg', `🚩 신고: ${rec.byName} → ${rec.toName} (${why})`);
    });
    // 관리자: 신고 목록 · 처리 · 채팅 금지 · 정지
    // 관리자: 오늘 접속한 사람 수와 지금 플레이 중인 사람 목록
    socket.on('adm:who', () => {
      if (uid !== ADMIN_ID) return;
      const day = kstDay(); if (TODAY.day !== day) { TODAY.day = day; TODAY.m.clear(); }
      const online = []; for (const q of byUid.values()) { const p = q.data.p; online.push({ nick: q.data.nick || '', name: p ? p[1] : '', lv: p ? p[5] : 0, cls: p ? p[3] : '', ch: q.data.ch || 0, map: q.data.map || '', idle: q.data.idle ? 1 : 0 }); }
      online.sort((a, b) => b.lv - a.lv);
      socket.emit('adm:who', { today: TODAY.m.size, todayList: [...TODAY.m.values()].slice(-300), online });
    });
    socket.on('adm:reps', async () => {
      if (uid !== ADMIN_ID) return; await sancLoad(store);
      const d = await store.get(REPORT_ID); const list = ((d && d.list) || []).slice(0, 100);
      socket.emit('adm:reps', { list, sanc: Object.entries(SANC).filter(([u]) => banLeft(u) || muteLeft(u)).map(([u, x]) => ({ u, name: x.name, why: x.why, mute: muteLeft(u), ban: banLeft(u) })) });
    });
    socket.on('adm:done', async (d) => {
      if (uid !== ADMIN_ID || !d) return; const at = +d.at;
      try { await store.txn([REPORT_ID], (m) => { const x = m[REPORT_ID]; if (x && x.list) x.list = x.list.filter((r) => r.at !== at); }); } catch (e) {}
      socket.emit('tr:msg', '✅ 신고를 처리 완료했어요');
    });
    socket.on('adm:sanc', async (d) => {
      if (uid !== ADMIN_ID || !d) return; await sancLoad(store);
      const to = String(d.to || '').slice(0, 60), kind = String(d.kind || ''), min = Math.max(0, Math.min(5256000, +d.min || 0));
      if (!to || to === ADMIN_ID) return;
      const x = SANC[to] || {}; x.name = String(d.name || x.name || '?').slice(0, 12); x.why = String(d.why || '').slice(0, 30);
      const t = byUid.get(to);
      if (kind === 'mute') { x.mute = Date.now() + min * 6e4; if (t) t.emit('tr:msg', '🔇 운영 정책 위반으로 ' + leftTxt(min * 6e4) + ' 동안 채팅이 금지됐어요'); }
      else if (kind === 'ban') { x.ban = min ? Date.now() + min * 6e4 : -1; if (t) { t.emit('banned', { left: leftTxt(banLeft(to)), why: x.why }); setTimeout(() => { try { t.disconnect(true); } catch (e) {} }, 500); } }
      else if (kind === 'clear') { delete x.mute; delete x.ban; if (t) t.emit('tr:msg', '✅ 제재가 풀렸어요'); }
      else return;
      SANC[to] = x; if (!x.mute && !x.ban) delete SANC[to]; await sancSave(store);
      console.log(`[관리자] 제재 ${kind} ${to} ${min}분`);
      socket.emit('tr:msg', '⚖ ' + x.name + ' : ' + (kind === 'mute' ? '채팅 금지 ' + leftTxt(min * 6e4) : kind === 'ban' ? '정지 ' + (min ? leftTxt(min * 6e4) : '영구') : '제재 해제'));
    });
    socket.on('c', (t) => {
      const m = socket.data.room, now = Date.now(), text = cleanChat(t);
      if (!m || !text || now - (socket.data.ct || 0) < 800) return;
      if (muteLeft(uid)) return socket.emit('tr:msg', '🔇 채팅 금지 중이에요 (' + leftTxt(muteLeft(uid)) + ' 남음)');
      socket.data.ct = now;
      socket.to('m:' + m).emit('c', { u: uid, n: (socket.data.p && socket.data.p[1]) || socket.data.nick, t: text });
    });
    socket.on('disconnect', () => { const m = socket.data.room; for (const q of byUid.values()) if (q !== socket && q.data.ride === uid) { q.data.ride = null; q.emit('ride:off', { why: '운전자가 나가서 내렸어요' }); } if (byUid.get(uid) === socket) ptLeave(uid); if (socket.data.endTrades) socket.data.endTrades('상대가 접속을 끊었어요'); if (m) socket.to('m:' + m).emit('vc', { t: 'bye', from: uid }); if (byUid.get(uid) === socket) byUid.delete(uid); if (m) pickHost(m); });
  });
  let tick = 0; const psSig = new Map();
  const timer = setInterval(() => {
    if (++tick % 20 === 0) { const c = chCount(); for (const s of byUid.values()) s.volatile.emit('n', c[s.data.ch] || 0); } // 2초마다 같은 서버 접속자 수
    if (tick % 5 === 0) for (const T of parties.values()) { // 0.5초마다 파티원 위치·체력
      const info = T.m.map((u) => { const q = byUid.get(u), p = q && q.data.p; return p ? [u, p[1], p[5], q.data.map, p[6], p[7], p[14], q.data.ch || 0] : [u, '?', 0, '', 0, 0, 0, 0]; });
      for (const u of T.m) { const q = byUid.get(u); if (q) q.volatile.emit('pt:st', info); }
    }
    const maps = new Map();
    for (const s of byUid.values()) { if (!s.data.p || !s.data.room) continue; let l = maps.get(s.data.room); if (!l) maps.set(s.data.room, l = []); l.push(s.data.p); }
    // 전송량 줄이기: 1초마다 전체 목록, 그 사이엔 바뀐 사람만 ('pd')
    const full = tick % 10 === 0;
    for (const [m, list] of maps) {
      const L = list.slice(0, 40);
      if (full) { ns.to('m:' + m).volatile.emit('ps', L); for (const p of L) psSig.set(p[0], JSON.stringify(p)); continue; }
      const d = []; for (const p of L) { const sg = JSON.stringify(p); if (psSig.get(p[0]) !== sg) { psSig.set(p[0], sg); d.push(p); } }
      if (d.length) ns.to('m:' + m).volatile.emit('pd', d);
    }
    if (full && psSig.size > byUid.size * 2 + 100) { const live = new Set([...byUid.values()].map((s) => s.data.p && s.data.p[0])); for (const k of psSig.keys()) if (!live.has(k)) psSig.delete(k); }
  }, 100);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); }, count: () => byUid.size };
}

module.exports = { http, attach, docId, linkByNick };
