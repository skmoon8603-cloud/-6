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
const cleanName = (n) => String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 8);

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(key, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  return h.n > max;
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

  app.get('/api/rpg/ping', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ rpg: true }); });
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
function attach(io, { auth, accounts }) {
  const ns = io.of('/rpg');
  const byUid = new Map(); // uid -> socket
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
      if (map !== socket.data.map) { if (socket.data.map) socket.leave('m:' + socket.data.map); socket.join('m:' + map); socket.data.map = map; }
      socket.data.p = [
        uid, cleanName(d.n) || socket.data.nick, word(d.r), word(d.c), word(d.j), Math.round(num(d.l, 1, 999)),
        Math.round(num(d.x, 0, 9999)), Math.round(num(d.y, 0, 9999)), d.f < 0 ? -1 : 1, d.a ? 1 : 0, d.w ? 1 : 0,
      ];
    });
    socket.on('disconnect', () => { if (byUid.get(uid) === socket) byUid.delete(uid); });
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

module.exports = { http, attach, docId };
