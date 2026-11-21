'use strict';
/**
 * 공포게임 「종이 울리면」 연동 (축구·도박 RPG 기능과는 완전히 분리)
 *  - 축구 게임 계정(아이디/비밀번호, 세션 토큰)을 그대로 사용한다.
 *  - 세이브는 계정 저장소의 별도 문서('__hor:<계정 id>')에 저장한다. 다른 게임 데이터는 건드리지 않는다.
 *  - 게임 화면은 GitHub Pages 에서 받으므로 이 서버는 로그인·저장만 맡는다 (전송량 절약).
 */
const ORIGINS = (process.env.HORROR_ORIGINS || process.env.RPG_ORIGINS || 'https://skmoon8603-cloud.github.io').split(',').map((s) => s.trim()).filter(Boolean);
const MAX_SAVE = 8000;
const ADMIN_ID = process.env.ADMIN_ID || 'u-skmoon';
const docId = (uid) => '__hor:' + uid;

const hits = new Map();
function limited(key, max, windowMs) {
  const now = Date.now(); let h = hits.get(key);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(key, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  return h.n > max;
}

function http(app, { store, auth, accounts }) {
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
  // 로그인(/api/signin, /api/register)의 CORS 는 rpg.js 가 이미 같은 주소들에 대해 허용한다
  app.use('/api/horror', cors);

  const who = (req) => { const h = req.headers.authorization || ''; const s = auth.verifySession(h.startsWith('Bearer ') ? h.slice(7) : ''); return s ? s.uid : null; };
  const wrap = (fn) => async (req, res) => {
    try {
      res.setHeader('Cache-Control', 'no-store');
      if (limited('hor:' + req.ip, 40, 10000)) return res.status(429).json({ error: 'too_many_requests' });
      const uid = who(req);
      if (!uid) return res.status(401).json({ error: 'unauthorized' });
      const a = await accounts.get(uid);
      if (!a) return res.status(401).json({ error: 'unauthorized' });
      const r = await fn(req, uid, a);
      res.status(r.status || 200).json(r.body);
    } catch (e) { console.error('[horror]', e && e.stack || e); res.status(500).json({ error: 'server_error' }); }
  };

  app.get('/api/horror/ping', (_req, res) => { res.setHeader('Cache-Control', 'no-store'); res.json({ horror: true }); });
  app.get('/api/horror/save', wrap(async (_req, uid, a) => {
    const d = await store.get(docId(uid));
    return { body: { id: uid, nick: a.nick, admin: uid === ADMIN_ID, save: d ? d.save : null, t: d ? d.t : 0 } };
  }));
  app.post('/api/horror/save', wrap(async (req, uid) => {
    const save = req.body && req.body.save;
    if (!save || typeof save !== 'object' || Array.isArray(save)) return { status: 400, body: { error: 'bad_save' } };
    if (JSON.stringify(save).length > MAX_SAVE) return { status: 413, body: { error: 'too_big' } };
    const id = docId(uid), t = Date.now();
    await store.txn([id], (m) => { m[id] = { id, uid, save, t }; });
    return { body: { ok: true, t } };
  }));
}

module.exports = { http, docId };
