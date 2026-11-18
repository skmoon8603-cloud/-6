'use strict';
/**
 * 도박 RPG 연동 (축구 게임 기능과는 완전히 분리)
 *  - 축구 게임 계정(아이디/비밀번호, 세션 토큰)을 그대로 사용한다.
 *  - 세이브는 계정 저장소의 별도 문서('__rpg:<계정 id>')에 저장한다. 축구 게임의 잔액·보관함은 건드리지 않는다.
 *  - /rpg/ 로 접속하면 GitHub Pages 에 있는 RPG 화면을 그대로 내려준다(같은 주소라 로그인·실시간 접속이 바로 된다).
 *  - Socket.IO 네임스페이스 '/rpg': 같은 맵에 있는 다른 플레이어의 위치를 0.1초마다 알려준다.
 */
const PAGES = (process.env.RPG_PAGES || 'https://skmoon8603-cloud.github.io/dobak-rpg/').replace(/\/*$/, '/');
const ORIGINS = (process.env.RPG_ORIGINS || 'https://skmoon8603-cloud.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_SAVE = 24000;
const ADMIN_ID = process.env.ADMIN_ID || 'u-skmoon'; // 관리자 계정 (RPG에서 관리자 보상을 받는다)
const docId = (uid) => '__rpg:' + uid;
// 운영자 지급: 해당 계정이 다음에 게임을 시작할 때 한 번만 적용된다 (받은 기록은 '__rpggrant:<계정>' 에 남는다)
const GRANTS = [
  { id: 'lv20-taeheeim-1115', nick: '이태희', name: '이태희임', lv: 20 }, // 계정 닉네임 「이태희」(캐릭터 이름 「이태희임」) 레벨 20
];
GRANTS.push({ id: 'title-lost-taeheeim', nick: '이태희', name: '이태희임', title: 'lost', keep: true }); // 칭호 「최초로 계정이 날라간 자」 (새 게임을 해도 유지)
GRANTS.push({ id: 'title-fav-otter-1116', nick: 'otter', name: 'otter', title: 'fav', keep: true }); // 칭호 「^관리자의 최애^」 (계정 닉네임이나 캐릭터 이름이 otter)
GRANTS.push({ id: 'lv60-jusiwan-1116', nick: '주시완', name: '주시완', setLv: 60, recalc: true }); // 주시완 Lv60 (스킬·능력치 포인트도 Lv60에 맞게 다시 계산)
// (취소) 「왕정훈 찐계」에 잘못 내린 조정. 이미 적용됐다면 아래 복구가 한 번 들어간다.
GRANTS.push({ id: 'restore-hanback-1116', nick: 'hanback0820', name: '왕정훈 찐계', requires: 'penalty-hanback-1115', setLv: 46, goldMul: 2, recalc: true });
// 「왕정훈 본계」: 레벨 -8 (그만큼 받은 스킬 1·능력치 3 포인트도 회수), 골드 절반
GRANTS.push({ id: 'penalty-wjh-main-1116', name: '왕정훈 본계', lvAdd: -8, spDown: 8, apDown: 24, goldMul: 0.5 });
GRANTS.push({ id: 'dalkong-choi-1117', nick: '최범규 vr2', name: '최범규 vr2', item: 'dalkong' }); // 최범규 vr2에게 달콩빔 (하루 10번)
const DK_NAMES = new Set(['최범규 vr2']); // 달콩빔을 하루 10번 쓸 수 있는 사람 (계정 닉네임 또는 캐릭터 이름)
GRANTS.push({ id: 'penalty-daege-1118', nick: '대게', name: '대게', lvAdd: -10, spDown: 10, apDown: 30, goldMul: 0.5 }); // 「대게」: 레벨 -10 (그만큼 받은 스킬 1·능력치 3 포인트도 회수), 골드 절반
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
const SEATS = { moto: 1, bonggu: 2, lambo: 2 }; // 탈것 뒷자리
const VEH_OK = new Set(['kick', 'fixie', 'moto', 'bonggu', 'lambo']);
const num = (v, lo, hi) => { v = Number(v); return Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : lo; };
const word = (v) => (typeof v === 'string' && /^[a-z]{1,10}$/.test(v) ? v : '');
const itemId = (v) => (typeof v === 'string' && /^[a-z0-9_]{1,14}$/.test(v) ? v : '');
const cleanChat = (t) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 60);
const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 8);

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
    const grants = GRANTS.filter((g) => ((g.admin && uid === ADMIN_ID) || (g.nick && g.nick === a.nick) || (g.name && d && d.save && d.save.name === g.name)) && !got.done.includes(g.id) && (!g.requires || got.done.includes(g.requires))).map((g) => ({ id: g.id, lv: g.lv, title: g.title, setLv: g.setLv, lvAdd: g.lvAdd, sp: g.sp, ap: g.ap, spDown: g.spDown, apDown: g.apDown, goldMul: g.goldMul, goldAdd: g.goldAdd, item: g.item, setCls: g.setCls, recalc: g.recalc }));
    return { body: { id: uid, admin: uid === ADMIN_ID, grants, nick: a.nick, save: d ? d.save : null, t: d ? d.t : 0 } };
  }));
  app.post('/api/rpg/save', wrap(async (req, uid) => {
    const save = req.body && req.body.save;
    if (!save || typeof save !== 'object' || Array.isArray(save)) return { status: 400, body: { error: 'bad_save' } };
    if (JSON.stringify(save).length > MAX_SAVE) return { status: 413, body: { error: 'too_big' } };
    if (!(await accounts.get(uid))) return { status: 401, body: { error: 'unauthorized' } };
    const id = docId(uid), t = Date.now();
    // 다른 기기가 더 최근에 저장했으면 거절한다 (예전 데이터가 새 데이터를 덮어쓰지 않게)
    const base = req.body && Number.isFinite(req.body.base) ? req.body.base : null;
    let conflict = false;
    await store.txn([id], (m) => { const cur = m[id]; if (base != null && cur && cur.t && cur.t !== base) { conflict = true; return; } m[id] = { id, uid, save, t }; });
    if (conflict) return { status: 409, body: { error: 'conflict' } };
    return { body: { ok: true, t } };
  }));

  // 관리자: 계정 조회 (비밀번호는 돌려주지 않음) + 비밀번호 재설정
  app.get('/api/rpg/admin/lookup', wrap(async (req, uid) => {
    if (uid !== ADMIN_ID) return { status: 403, body: { error: 'forbidden' } };
    const q = String((req.query && req.query.q) || '').slice(0, 40);
    return { body: { list: await accounts.adminFind(q) } };
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

  app.post('/api/rpg/grantdone', wrap(async (req, uid) => {
    const gid = String((req.body && req.body.id) || '');
    if (!GRANTS.some((g) => g.id === gid && !g.keep)) return { status: 400, body: { error: 'bad_grant' } };
    const id = grantDoc(uid);
    await store.txn([id], (m) => { const d = m[id] || { id, done: [] }; if (!d.done.includes(gid)) d.done.push(gid); m[id] = d; });
    return { body: { ok: true } };
  }));

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
    if (!req.originalUrl.split('?')[0].endsWith('/')) return res.redirect('/rpg/'); // 끝에 / 가 있어야 음악 등 상대 경로가 맞는다
    const html = await loadPage();
    if (!html) return res.status(502).type('text/plain; charset=utf-8').send('도박 RPG 화면을 불러오지 못했어요. 잠시 후 새로고침해 주세요.');
    res.setHeader('Cache-Control', 'no-cache');
    res.type('html').send(html);
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
  const EVT = { on: false, stage: 0, t: 0, stageT: 0, contrib: new Map(), names: new Map(), day: '', warned: '' };
  const kstNow = () => new Date(Date.now() + 9 * 3600e3);
  const evtStart = () => { const d = kstNow(); Object.assign(EVT, { on: true, stage: 0, t: Date.now(), stageT: Date.now(), contrib: new Map(), names: new Map(), day: d.toISOString().slice(0, 10) }); ns.emit('evt', { on: 1, stage: 0, intro: 1 }); ns.emit('tr:msg', '🟢 서버 이벤트! 평화의 마을에 거대 슬라임이 나타났어요! (15분마다)'); };
  const evtEnd = (full) => {
    if (!EVT.on) return; EVT.on = false; const f = full ? 1 : Math.min(1, EVT.stage / 7);
    const list = [...EVT.contrib.entries()].sort((a, b) => b[1] - a[1]); const total = list.reduce((a, x) => a + x[1], 0) || 1;
    ns.emit('evt', { on: 0, end: 1, full: full ? 1 : 0 });
    list.forEach(([u, c], i) => { const q = byUid.get(u); if (!q) return; const sh = c / total; q.emit('evt:reward', { gold: Math.round(800000 * sh * f), gel: Math.round(10000 * sh * f), lv: Math.round(9 * sh * f * 100) / 100, pct: Math.round(sh * 1000) / 10, rank: i + 1, n: list.length, full: full ? 1 : 0 }); });
  };
  const evtRank = () => { const list = [...EVT.contrib.entries()].filter(([u]) => u !== ADMIN_ID).sort((a, b) => b[1] - a[1]); const total = list.reduce((a, x) => a + x[1], 0) || 1; return list.slice(0, 40).map(([u, c]) => [u, EVT.names.get(u) || '?', Math.round(c / total * 1000) / 10]); };
  const EVT_MS = 12 * 60e3; // 한 판은 최대 12분 (못 잡으면 잡은 만큼 보상하고 종료 → 다음 15분 전에 끝남)
  setInterval(() => {
    const d = kstNow(), m = d.getUTCMinutes(), stamp = d.toISOString().slice(0, 16); // 분 단위 (같은 분에 두 번 시작 방지)
    if (m % 15 === 0 && !EVT.on && EVT.startedAt !== stamp) { EVT.startedAt = stamp; evtStart(); } // 매시 00·15·30·45분
    if (EVT.on && Date.now() - EVT.t > EVT_MS) evtEnd(false);
    if (EVT.on) ns.emit('evt:rank', { stage: EVT.stage, list: evtRank() });
  }, 2000).unref?.();
  // 달콩빔 하루 사용 횟수 (한국 시간 기준 날짜마다 10번)
  const dkCount = new Map(); const kstDay = () => new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10);
  const dkLeft = (u) => { const day = kstDay(); let c = dkCount.get(u); if (!c || c.day !== day) { c = { day, n: 0 }; dkCount.set(u, c); } return Math.max(0, 10 - c.n); };
  // 마을 표지판: 관리자만 고칠 수 있고 모두에게 보인다 (계정 저장소의 '__rpgsigns' 문서에 저장)
  const SIGN_ID = '__rpgsigns'; const SIGN_MAPS = ['village', 'sea']; let signs = {};
  if (store) store.get(SIGN_ID).then((d) => { if (d && d.signs) signs = d.signs; }).catch(() => {});
  const signSave = async () => { try { if (store) await store.txn([SIGN_ID], (m) => { m[SIGN_ID] = { id: SIGN_ID, signs }; }); } catch (e) { console.error('[rpg] 표지판 저장 실패', e.message); } ns.emit('signs', signs); };
  const byUid = new Map(); // uid -> socket
  const duels = new Map(); let pend = []; let lobbies = []; // 결투 신청 · 1:다수 결투 대기실
  const trades = new Map(); // 거래
  const parties = new Map(); // 파티 id -> { lead, m: [uid...] }  (최대 4명)
  const partyOf = (u) => { for (const [id, T] of parties) if (T.m.includes(u)) return id; return null; };
  const ptSend = (id) => { const T = parties.get(id); if (!T) return; for (const u of T.m) { const q = byUid.get(u); if (q) q.emit('pt:upd', { id, lead: T.lead, m: T.m }); } };
  const ptLeave = (u) => { const id = partyOf(u); if (!id) return; const T = parties.get(id); T.m = T.m.filter((x) => x !== u); const q = byUid.get(u); if (q) q.emit('pt:upd', null);
    if (T.m.length < 2) { for (const x of T.m) { const z = byUid.get(x); if (z) z.emit('pt:upd', null); } parties.delete(id); return; }
    if (T.lead === u) T.lead = T.m[0]; ptSend(id); };
  // 같이 사냥: 맵마다 '방장' 한 명이 몬스터를 움직이고, 나머지는 방장이 보내주는 몬스터 상태를 보며 때린 내용을 방장에게 보낸다.
  const hosts = new Map(); // map -> uid
  const bossDead = new Map(); // map -> 보스가 쓰러진 시각 (다시 나타나기까지 10초)
  const bd = (m) => (bossDead.has(m) ? Date.now() - bossDead.get(m) : null);
  const hostOk = (m) => { const s = byUid.get(hosts.get(m)); return !!(s && s.data.map === m); };
  const pickHost = (m) => {
    if (hostOk(m) && !byUid.get(hosts.get(m)).data.idle) return;
    const cur = hosts.get(m), list = [...byUid.values()].filter((s) => s.data.map === m);
    const next = list.find((s) => !s.data.idle) || (hostOk(m) ? null : list[0]);
    if (!next || next.data.uid === cur) return;
    const old = byUid.get(cur); if (old && old.data.map === m) old.emit('host', { m, h: 0 });
    hosts.set(m, next.data.uid); next.emit('host', { m, h: 1, bd: bd(m) });
  };
  ns.use(async (socket, next) => {
    try {
      const s = auth.verifySession(socket.handshake.auth && socket.handshake.auth.token);
      if (!s) return next(new Error('unauthorized'));
      const a = await accounts.get(s.uid);
      if (!a) return next(new Error('unauthorized'));
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
    socket.data.p = null; socket.data.map = '';
    socket.on('s', (d) => {
      if (!d || typeof d !== 'object') return;
      const map = typeof d.m === 'string' && MAPS.test(d.m) ? d.m : '';
      if (!map) return;
      if (map !== socket.data.map) {
        const old = socket.data.map;
        if (old) socket.leave('m:' + old);
        socket.join('m:' + map); socket.data.map = map;
        for (const q of byUid.values()) if (q.data.ride === uid) q.emit('ride:map', { m: map, x: Math.round(num(d.x, 0, 200000)), y: Math.round(num(d.y, 0, 200000)) }); // 뒤에 탄 사람도 같이 이동
        if (socket.data.ride) { const dr = byUid.get(socket.data.ride); if (!dr || dr.data.map !== map) { socket.data.ride = null; socket.emit('ride:off', {}); } }
        if (old) pickHost(old);
        if (socket.data.endTrades) socket.data.endTrades('상대가 다른 곳으로 이동했어요');
        if (old) socket.to('m:' + old).emit('vc', { t: 'bye', from: uid });
        if (!hostOk(map) || byUid.get(hosts.get(map)).data.idle) { const o = byUid.get(hosts.get(map)); if (o && o !== socket && o.data.map === map) o.emit('host', { m: map, h: 0 }); hosts.set(map, uid); }
        socket.emit('host', { m: map, h: hosts.get(map) === uid ? 1 : 0, bd: bd(map) });
      }
      socket.data.p = [
        uid, cleanName(d.n) || socket.data.nick, word(d.r), word(d.c), word(d.j), Math.round(num(d.l, 1, 999)),
        Math.round(num(d.x, 0, 200000)), Math.round(num(d.y, 0, 200000)), d.f < 0 ? -1 : 1, d.a ? 1 : 0, d.w ? 1 : 0, itemId(d.wp), itemId(d.ar), d.t === 'admin' && uid !== ADMIN_ID ? '' : itemId(d.t), // 칭호 (관리자 칭호는 관리자만)
        Math.round(num(d.hp, 0, 100)), // 체력 %
        VEH_OK.has(d.v) ? d.v : '', socket.data.ride ? 1 : 0, // 탈것 · 다른 사람 뒤에 탔는지
        Math.round(num(d.hd, -7, 7) * 100) / 100, // 픽시 진행 방향 (도는 모습)
        Array.isArray(d.sp) ? d.sp.slice(0, 5).map((a) => Array.isArray(a) ? [Math.round(num(a[0], 0, 9)), Math.round(num(a[1], 0, 200000)), Math.round(num(a[2], 0, 200000))] : [0, 0, 0]) : [], // 정령술사의 정령
        Math.round(num(d.wl, 0, 15)), // 무기 강화 단계 (5강마다 무기가 커진다)
      ];
      // 운전자가 탈것에서 내리거나 좌석이 줄면 뒤에 탄 사람을 내리게 한다
      { const seats = SEATS[socket.data.p[15]] || 0; let n = 0; for (const q of byUid.values()) if (q.data.ride === uid) { if (++n > seats) { q.data.ride = null; q.emit('ride:off', { why: seats ? '자리가 없어요' : '운전자가 내렸어요' }); } } }
    });
    socket.on('idle', (v) => { socket.data.idle = !!v; if (socket.data.map) pickHost(socket.data.map); }); // 다른 창을 보는 중
    // 실시간 음성: 같은 맵에서 음성을 켠 사람끼리 연결 신호를 중계한다
    socket.on('vc', (d) => {
      const m = socket.data.map; if (!m || !d || typeof d !== 'object' || Array.isArray(d)) return;
      try { if (JSON.stringify(d).length > 12000) return; } catch (e) { return; }
      d.from = uid;
      if (d.to) { const t = byUid.get(String(d.to)); if (t && t.data.map === m) t.emit('vc', d); }
      else socket.to('m:' + m).emit('vc', d);
    });
    // 파티
    socket.on('pt:inv', (d) => {
      const t = byUid.get(String((d && d.to) || ''));
      if (!t || t === socket) return socket.emit('tr:msg', '상대가 접속해 있지 않아요');
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
      if (!t || t === socket) return socket.emit('tr:msg', '상대가 접속해 있지 않아요');
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
    // 거래
    const tOther = (T) => (T.a === uid ? T.b : T.a);
    const tEnd = (id, msg) => { const T = trades.get(id); if (!T) return; if (T.timer) clearTimeout(T.timer); trades.delete(id); for (const u of [T.a, T.b]) { const q = byUid.get(u); if (q) q.emit('tr:end', { id, msg: u === uid ? '' : msg }); } };
    socket.data.endTrades = (msg) => { for (const [id, T] of trades) if (T.a === uid || T.b === uid) tEnd(id, msg); };
    socket.on('tr:req', (d) => {
      const t = byUid.get(String((d && d.to) || ''));
      if (!t || t === socket || t.data.map !== socket.data.map) return socket.emit('tr:msg', '상대가 근처에 없어요');
      for (const T of trades.values()) if ([T.a, T.b].includes(uid) || [T.a, T.b].includes(t.data.uid)) return socket.emit('tr:msg', '이미 거래 중이에요');
      const id = Math.random().toString(36).slice(2, 9);
      trades.set(id, { a: uid, b: t.data.uid, off: {}, lk: new Set(), ok: false, t: Date.now() });
      t.emit('tr:ask', { id, op: (socket.data.p && socket.data.p[1]) || socket.data.nick });
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
    const amHost = () => !!socket.data.map && hosts.get(socket.data.map) === uid;
    let evN = 0, evT = 0;
    const flood = () => { const now = Date.now(); if (now - evT > 1000) { evT = now; evN = 0; } return ++evN > 300; };
    // 방장 → 같은 맵 사람들: 몬스터 상태
    socket.on('es', (l) => { if (!amHost() || !Array.isArray(l) || l.length > 150 || flood()) return; socket.to('m:' + socket.data.map).volatile.emit('es', l); });
    // 전투 이벤트 중계
    socket.on('ev', (d) => {
      const m = socket.data.map;
      if (!m || !d || typeof d !== 'object' || Array.isArray(d) || flood()) return;
      try { if (JSON.stringify(d).length > (d.k === 'sk' ? 7000 : 2500)) return; } catch (e) { return; }
      if (d.k === 'hit') { if (amHost()) return; const h = byUid.get(hosts.get(m)); if (h && h.data.map === m) { d.from = uid; h.emit('ev', d); } }
      else if (d.k === 'kill' || d.k === 'ep') { if (amHost()) { if (d.k === 'kill' && d.bs) bossDead.set(m, Date.now()); socket.to('m:' + m).emit('ev', d); } }
      else if (d.k === 'pvh') { if (!m.startsWith('arena')) return; const t = byUid.get(String(d.to)); if (t && t.data.map === m) { d.from = uid; t.emit('ev', d); } } // 결투: 상대에게 피해
      else if (d.k === 'pvend') { if (m.startsWith('arena')) socket.to('m:' + m).emit('ev', { k: 'pvend', from: uid }); } // 결투: 내가 졌다
      else if (d.k === 'sk') { d.from = uid; socket.to('m:' + m).volatile.emit('ev', d); } // 다른 사람에게 내 스킬 연출 보여주기
      else if (d.k === 'bf') { if (amHost()) socket.to('m:' + m).emit('ev', d); } // 보스 예고 표시·피하기 버튼을 같은 맵 사람들에게
      else if (d.k === 'gr') { socket.to('m:' + m).volatile.emit('ev', d); }
      else if (d.k === 'skd') { socket.to('m:' + m).emit('ev', { k: 'skd', on: d.on ? 1 : 0, a: Math.max(-7, Math.min(7, +d.a || 0)), from: uid }); } // 픽시 스키딩 (자국·소리) // 마을 할머니 추격 장면 공유
      else if (d.k === 'bd') { if (uid === ADMIN_ID) return; socket.to('m:' + m).emit('ev', { k: 'bd', id: d.id, v: +d.v || 0, from: uid }); } // 보스 기여도(내가 넣은 피해) 공유 (관리자는 빼기)
      else if (d.k === 'dmg') { if (!amHost()) return; const t = byUid.get(String(d.to)); if (t && t.data.map === m) t.emit('ev', d); }
    });
    // 결투 신청
    socket.on('duel:req', () => {
      if (socket.data.map !== 'village') return;
      const now = Date.now();
      for (const [k, D] of duels) if (now - D.t > 60000) duels.delete(k);
      pend = pend.filter((q) => now - q.t < 15000 && q.uid !== uid && byUid.get(q.uid) && byUid.get(q.uid).data.map === 'village');
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
      const L = { id: Math.random().toString(36).slice(2, 8), solo: uid, team: [], t: now, done: false }; lobbies.push(L);
      const nm = (socket.data.p && socket.data.p[1]) || socket.data.nick || '?';
      ns.to('m:village').emit('tr:msg', '⚔ ' + nm + ' 님이 1:다수 결투를 열었어요! 15초 안에 결투 심판 바론에게 「여럿 쪽 참가」를 눌러 주세요');
      socket.emit('duel:lobby', { role: 'solo', n: 0 });
      setTimeout(() => {
        L.done = true; const s0 = byUid.get(L.solo); const team = L.team.filter((u) => { const q = byUid.get(u); return q && q.data.map === 'village'; });
        if (!s0 || s0.data.map !== 'village') { team.forEach((u) => { const q = byUid.get(u); if (q) q.emit('duel:cancel'); }); return; }
        if (!team.length) { s0.emit('tr:msg', '아무도 참가하지 않아서 1:다수 결투가 취소됐어요'); s0.emit('duel:cancel'); return; }
        const key = 'arena' + Array.from({ length: 5 }, () => 'abcdefghijklmnopqrstuvwxyz'[Math.floor(Math.random() * 26)]).join('');
        const sides = { [L.solo]: 0 }; team.forEach((u) => { sides[u] = 1; });
        s0.emit('duel:go', { arena: key, side: 0, idx: 0, sides });
        team.forEach((u, i) => { const q = byUid.get(u); if (q) q.emit('duel:go', { arena: key, side: 1, idx: i, sides }); });
      }, 15000);
    });
    socket.on('duel:team', () => {
      if (socket.data.map !== 'village') return;
      const L = lobbies.find((x) => !x.done && x.solo !== uid && Date.now() - x.t < 15000);
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
      for (const s of byUid.values()) { const q = s.data.p; if (q && s.data.map && list.length < 80) { const pid = partyOf(s.data.uid); list.push([q[0], q[1], q[5], s.data.map, q[6], q[7], pid ? parties.get(pid).m.length : 0]); } }
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
      if (!d || !(uid === ADMIN_ID || socket.data.dkOk)) return; const t = byUid.get(String(d.to || '')); if (!t || t.data.map !== socket.data.map) return;
      const now = Date.now(); if (now - (t.data.dkT || 0) < 1000) return;
      if (uid !== ADMIN_ID) { const left = dkLeft(uid); if (left <= 0) return socket.emit('dkleft', 0); const c = dkCount.get(uid); c.n++; socket.emit('dkleft', dkLeft(uid)); }
      t.data.dkT = now; t.emit('dk');
    });
    // 탈것 뒤에 타기 (오토바이 1명, 봉구차·람보르기니 2명)
    socket.on('ride', (d) => {
      const dr = byUid.get(String((d && d.to) || '')); if (!dr || dr === socket || socket.data.ride) return;
      const me = socket.data.p, p = dr.data.p; if (!me || !p || dr.data.map !== socket.data.map) return;
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
      const t = byUid.get(String(d.to || '')); if (!t || t === socket || t.data.map !== socket.data.map) return;
      const now = Date.now(); if (now - (t.data.jailT || 0) < 31000) return; t.data.jailT = now;
      t.data.ride = null; t.emit('jailed', { by: (socket.data.p && socket.data.p[1]) || '경찰', s: 30 });
      socket.emit('tr:msg', ((t.data.p && t.data.p[1]) || '상대') + ' 님을 감옥에 가뒀어요 (30초)');
    });
    if (EVT.on) socket.emit('evt', { on: 1, stage: EVT.stage });
    socket.on('evt:dmg', (v) => { // 이벤트 슬라임에게 준 피해 (기여도)
      if (!EVT.on || socket.data.map !== 'village') return; const now = Date.now(); if (now - (socket.data.evdT || 0) < 700) return; socket.data.evdT = now;
      const n = Math.max(0, Math.min(2e7, Number(v) || 0)); if (!n) return; EVT.contrib.set(uid, (EVT.contrib.get(uid) || 0) + n); EVT.names.set(uid, (socket.data.p && socket.data.p[1]) || socket.data.nick || '?');
    });
    socket.on('evt:clear', (d) => { // 방장이 '이번 단계 슬라임을 다 잡았다'고 알린다
      if (!EVT.on || socket.data.map !== 'village' || !d || +d.stage !== EVT.stage || Date.now() - EVT.stageT < 4000) return;
      EVT.stage++; EVT.stageT = Date.now(); if (EVT.stage > 6) return evtEnd(true);
      ns.emit('evt', { on: 1, stage: EVT.stage, split: 1 });
    });
    socket.on('rock:sync', () => { const now = Date.now(); const l = []; for (const [i, t] of ROCKS) { if (t <= now) ROCKS.delete(i); else l.push([i, t - now]); } socket.emit('rocks', l); });
    socket.on('rock:hit', (d) => {
      if (socket.data.map !== 'shaft1' || !d) return; const i = Math.floor(+d.i); if (!(i >= 0 && i < 3000)) return;
      const now = Date.now(); if (now - (socket.data.rockT || 0) < 850) { socket.emit('rock:no', { i, ms: Math.max(0, (ROCKS.get(i) || 0) - now) }); return; }
      if ((ROCKS.get(i) || 0) > now) { socket.emit('rock:no', { i, ms: ROCKS.get(i) - now }); return; }
      socket.data.rockT = now; ROCKS.set(i, now + ROCK_MS); if (ROCKS.size > 4000) for (const [k, t] of ROCKS) if (t <= now) ROCKS.delete(k);
      socket.emit('rock:ok', { i, o: rollOre(), ms: ROCK_MS });
      socket.to('m:shaft1').emit('rock', { i, ms: ROCK_MS, by: uid });
    });
    socket.on('admin:spawn', (d) => { // 관리자: /드래곤 — 지금 있는 맵의 방장에게 드래곤을 소환하게 한다
      if (uid !== ADMIN_ID || !d || d.t !== 'dragon') return; const m = socket.data.map; if (!m) return;
      const h = byUid.get(hosts.get(m)); const tgt = h && h.data.map === m ? h : socket;
      tgt.emit('admin:spawn', { t: 'dragon', m, x: Math.round(num(d.x, 0, 200000)), y: Math.round(num(d.y, 0, 200000)) });
      ns.to('m:' + m).emit('tr:msg', '🐉 관리자가 화염 드래곤을 소환했다!!');
    });
    socket.on('evt:admin', (d) => { if (uid !== ADMIN_ID) return; if (d === 'start' && !EVT.on) evtStart(); if (d === 'stop') evtEnd(false); }); // 관리자 테스트용
    socket.on('ann', (t) => {
      if (uid !== ADMIN_ID) return;
      const now = Date.now(); if (now - (socket.data.annT || 0) < 3000) return; socket.data.annT = now;
      const msg = String(t || '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 60); if (!msg) return;
      ns.emit('ann', { t: msg, by: (socket.data.p && socket.data.p[1]) || '관리자' });
    });
    socket.on('c', (t) => {
      const m = socket.data.map, now = Date.now(), text = cleanChat(t);
      if (!m || !text || now - (socket.data.ct || 0) < 800) return;
      socket.data.ct = now;
      socket.to('m:' + m).emit('c', { u: uid, n: (socket.data.p && socket.data.p[1]) || socket.data.nick, t: text });
    });
    socket.on('disconnect', () => { const m = socket.data.map; if (byUid.get(uid) === socket) ptLeave(uid); if (socket.data.endTrades) socket.data.endTrades('상대가 접속을 끊었어요'); if (m) socket.to('m:' + m).emit('vc', { t: 'bye', from: uid }); if (byUid.get(uid) === socket) byUid.delete(uid); if (m) pickHost(m); });
  });
  let tick = 0;
  const timer = setInterval(() => {
    if (++tick % 20 === 0) ns.volatile.emit('n', byUid.size); // 2초마다 전체 접속자 수
    if (tick % 5 === 0) for (const T of parties.values()) { // 0.5초마다 파티원 위치·체력
      const info = T.m.map((u) => { const q = byUid.get(u), p = q && q.data.p; return p ? [u, p[1], p[5], q.data.map, p[6], p[7], p[14]] : [u, '?', 0, '', 0, 0, 0]; });
      for (const u of T.m) { const q = byUid.get(u); if (q) q.volatile.emit('pt:st', info); }
    }
    const maps = new Map();
    for (const s of byUid.values()) { if (!s.data.p || !s.data.map) continue; let l = maps.get(s.data.map); if (!l) maps.set(s.data.map, l = []); l.push(s.data.p); }
    for (const [m, list] of maps) if (list.length > 1) ns.to('m:' + m).volatile.emit('ps', list.slice(0, 40));
    else ns.to('m:' + m).volatile.emit('ps', list);
  }, 100);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); }, count: () => byUid.size };
}

module.exports = { http, attach, docId, linkByNick };
