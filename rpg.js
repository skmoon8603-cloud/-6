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
const docId = (uid) => '__rpg:' + uid;
const MAPS = /^[a-z]{2,12}$/;
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
    return { body: { id: uid, nick: a.nick, save: d ? d.save : null, t: d ? d.t : 0 } };
  }));
  app.post('/api/rpg/save', wrap(async (req, uid) => {
    const save = req.body && req.body.save;
    if (!save || typeof save !== 'object' || Array.isArray(save)) return { status: 400, body: { error: 'bad_save' } };
    if (JSON.stringify(save).length > MAX_SAVE) return { status: 413, body: { error: 'too_big' } };
    if (!(await accounts.get(uid))) return { status: 401, body: { error: 'unauthorized' } };
    const id = docId(uid), t = Date.now();
    await store.txn([id], (m) => { m[id] = { id, uid, save, t }; });
    return { body: { ok: true, t } };
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
          .map((d) => ({ uid: d.uid, name: cleanName(d.save.name) || '모험가', lv: Math.round(num(d.save.lv, 1, 999)), exp: num(d.save.exp, 0, 1e12), gold: Math.round(num(d.save.gold, 0, 1e12)), cls: word(d.save.cls), job: word(d.save.job) }));
        const gold = rows.slice().sort((a, b) => b.gold - a.gold || b.lv - a.lv).slice(0, 10);
        const lv = rows.slice().sort((a, b) => b.lv - a.lv || b.exp - a.exp).slice(0, 10);
        const nicks = new Map();
        for (const r of [...gold, ...lv]) if (!nicks.has(r.uid)) { const a = await accounts.get(r.uid); nicks.set(r.uid, a ? a.nick : ''); }
        const out = (l) => l.map((r) => ({ name: r.name, nick: nicks.get(r.uid) || '', lv: r.lv, gold: r.gold, cls: r.cls, job: r.job }));
        rank = { t: Date.now(), data: { gold: out(gold), lv: out(lv), total: rows.length } };
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
  const byUid = new Map(); // uid -> socket
  // 같이 사냥: 맵마다 '방장' 한 명이 몬스터를 움직이고, 나머지는 방장이 보내주는 몬스터 상태를 보며 때린 내용을 방장에게 보낸다.
  const hosts = new Map(); // map -> uid
  const hostOk = (m) => { const s = byUid.get(hosts.get(m)); return !!(s && s.data.map === m); };
  const pickHost = (m) => { if (hostOk(m)) return; hosts.delete(m); for (const s of byUid.values()) if (s.data.map === m) { hosts.set(m, s.data.uid); s.emit('host', { m, h: 1 }); return; } };
  ns.use(async (socket, next) => {
    try {
      const s = auth.verifySession(socket.handshake.auth && socket.handshake.auth.token);
      if (!s) return next(new Error('unauthorized'));
      const a = await accounts.get(s.uid);
      if (!a) return next(new Error('unauthorized'));
      socket.data.uid = s.uid; socket.data.nick = a.nick;
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
        if (old) pickHost(old);
        if (!hostOk(map)) hosts.set(map, uid);
        socket.emit('host', { m: map, h: hosts.get(map) === uid ? 1 : 0 });
      }
      socket.data.p = [
        uid, cleanName(d.n) || socket.data.nick, word(d.r), word(d.c), word(d.j), Math.round(num(d.l, 1, 999)),
        Math.round(num(d.x, 0, 9999)), Math.round(num(d.y, 0, 9999)), d.f < 0 ? -1 : 1, d.a ? 1 : 0, d.w ? 1 : 0, itemId(d.wp), itemId(d.ar),
      ];
    });
    const amHost = () => !!socket.data.map && hosts.get(socket.data.map) === uid;
    let evN = 0, evT = 0;
    const flood = () => { const now = Date.now(); if (now - evT > 1000) { evT = now; evN = 0; } return ++evN > 300; };
    // 방장 → 같은 맵 사람들: 몬스터 상태
    socket.on('es', (l) => { if (!amHost() || !Array.isArray(l) || l.length > 150 || flood()) return; socket.to('m:' + socket.data.map).volatile.emit('es', l); });
    // 전투 이벤트 중계
    socket.on('ev', (d) => {
      const m = socket.data.map;
      if (!m || !d || typeof d !== 'object' || Array.isArray(d) || flood()) return;
      try { if (JSON.stringify(d).length > 2500) return; } catch (e) { return; }
      if (d.k === 'hit') { if (amHost()) return; const h = byUid.get(hosts.get(m)); if (h && h.data.map === m) { d.from = uid; h.emit('ev', d); } }
      else if (d.k === 'kill' || d.k === 'ep') { if (amHost()) socket.to('m:' + m).emit('ev', d); }
      else if (d.k === 'dmg') { if (!amHost()) return; const t = byUid.get(String(d.to)); if (t && t.data.map === m) t.emit('ev', d); }
    });
    // 채팅: 같은 맵 사람들 머리 위에 뜬다 (0.8초에 한 번)
    socket.on('c', (t) => {
      const m = socket.data.map, now = Date.now(), text = cleanChat(t);
      if (!m || !text || now - (socket.data.ct || 0) < 800) return;
      socket.data.ct = now;
      socket.to('m:' + m).emit('c', { u: uid, n: (socket.data.p && socket.data.p[1]) || socket.data.nick, t: text });
    });
    socket.on('disconnect', () => { const m = socket.data.map; if (byUid.get(uid) === socket) byUid.delete(uid); if (m) pickHost(m); });
  });
  const timer = setInterval(() => {
    const maps = new Map();
    for (const s of byUid.values()) { if (!s.data.p || !s.data.map) continue; let l = maps.get(s.data.map); if (!l) maps.set(s.data.map, l = []); l.push(s.data.p); }
    for (const [m, list] of maps) if (list.length > 1) ns.to('m:' + m).volatile.emit('ps', list.slice(0, 40));
    else ns.to('m:' + m).volatile.emit('ps', list);
  }, 100);
  if (timer.unref) timer.unref();
  return { stop() { clearInterval(timer); }, count: () => byUid.size };
}

module.exports = { http, attach, docId, linkByNick };
