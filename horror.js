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

/**
 * 멀티플레이: Socket.IO 네임스페이스 '/horror'
 *  - 방(4자리 코드)마다 최대 6명. 처음 들어온 사람이 '방장(host)' — 괴물·종소리를 계산해서 다른 사람에게 보낸다.
 *  - 서버는 계산하지 않고 같은 방 사람들에게 전달만 한다 (가볍게).
 */
const PROF = require('./profanity');
const cleanChat = (t) => PROF.clean(String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 50));
const MAX = 6;
function attach(io, { auth, accounts }) {
  const ns = io.of('/horror');
  const rooms = new Map(); // code -> { host: socketId, members: Set<socketId>, slot: Map<socketId, 1~6> }
  const roster = (code) => { const r = rooms.get(code); if (!r) return; const list = [...r.members].map((id) => { const s = ns.sockets.get(id); return s ? { id, s: r.slot.get(id), nick: s.data.nick, host: id === r.host ? 1 : 0 } : null; }).filter(Boolean); ns.to(code).emit('roster', list); };
  const leave = (socket) => {
    const code = socket.data.room; if (!code) return; socket.leave(code); socket.data.room = '';
    const r = rooms.get(code); if (!r) return; const sl = r.slot.get(socket.id); r.members.delete(socket.id); r.slot.delete(socket.id);
    if (!r.members.size) { rooms.delete(code); return; }
    if (r.host === socket.id) { r.host = [...r.members][0]; const h = ns.sockets.get(r.host); if (h) h.emit('host', 1); }
    ns.to(code).emit('gone', sl); roster(code);
  };
  ns.use(async (socket, next) => {
    try {
      const tok = socket.handshake.auth && socket.handshake.auth.token;
      const s = tok ? auth.verifySession(tok) : null;
      const a = s ? await accounts.get(s.uid) : null;
      socket.data.nick = a ? String(a.nick || '플레이어').slice(0, 12) : '게스트' + Math.floor(1000 + Math.random() * 9000);
      socket.data.room = ''; socket.data.n = 0; socket.data.t = 0;
      next();
    } catch (e) { next(new Error('server_error')); }
  });
  ns.on('connection', (socket) => {
    const rate = () => { const now = Date.now(); if (now - socket.data.t > 1000) { socket.data.t = now; socket.data.n = 0; } return ++socket.data.n > 60; };
    socket.on('rooms', () => { socket.emit('rooms', [...rooms.entries()].map(([code, r]) => ({ code, n: r.members.size })).filter((r) => r.n < MAX).slice(0, 20)); });
    socket.on('join', (code) => {
      code = String(code || '').replace(/\D/g, '').slice(0, 4);
      if (code.length !== 4) return socket.emit('joinErr', 'bad');
      leave(socket);
      let r = rooms.get(code); if (!r) { r = { host: socket.id, members: new Set(), slot: new Map() }; rooms.set(code, r); }
      if (r.members.size >= MAX) return socket.emit('joinErr', 'full');
      let sl = 1; const used = new Set(r.slot.values()); while (used.has(sl)) sl++;
      r.members.add(socket.id); r.slot.set(socket.id, sl); socket.join(code); socket.data.room = code; socket.data.slot = sl;
      socket.emit('joined', { code, me: socket.id, s: sl, nick: socket.data.nick, host: r.host === socket.id ? 1 : 0 });
      roster(code);
    });
    socket.on('leave', () => leave(socket));
    // 내 위치·상태 → 같은 방 사람들에게 (자주 오므로 volatile)
    // 데이터를 아끼기 위해 숫자 배열로만 주고받는다: [층, x*10, y*10, 방향*100, 상태 비트, 소리*10]
    const nums = (d, max) => Array.isArray(d) && d.length <= max && d.every((v) => typeof v === 'number' && Number.isFinite(v));
    socket.on('s', (d) => { if (!socket.data.room || rate() || !nums(d, 8)) return; socket.volatile.to(socket.data.room).emit('p', [socket.data.slot, ...d]); });
    // 방장이 보내는 괴물·종소리 상태
    socket.on('m', (d) => { const r = rooms.get(socket.data.room); if (!r || r.host !== socket.id || rate() || !nums(d, 200)) return; socket.volatile.to(socket.data.room).emit('m', d); });
    // 일회성 사건 (소리, 접기, 방송, 층 이동, 죽음 등)
    socket.on('ev', (d) => { if (!socket.data.room || rate() || !d || typeof d !== 'object') return; socket.to(socket.data.room).emit('ev', { f: socket.data.slot, ...d }); });
    socket.on('chat', (t) => { if (!socket.data.room || rate()) return; const m = cleanChat(t); if (m) ns.to(socket.data.room).emit('chat', { s: socket.data.slot, nick: socket.data.nick, t: m }); });
    socket.on('disconnect', () => leave(socket));
  });
}

module.exports = { http, attach, docId };
