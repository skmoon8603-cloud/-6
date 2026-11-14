'use strict';
/**
 * 접속자 목록 + 대결 신청(초대).
 *  - 접속 중인 사람과 상태(대기 중 / 축구 중 / 원 바운스 중)를 보여준다.
 *  - 대기 중인 사람에게 ⚽ 축구 / 🏓 원 바운스 대결을 신청할 수 있다. 상대가 수락하면
 *    신청한 사람이 방을 만들고(기존 방 만들기 그대로), 방 코드가 수락한 사람에게만 전달되어 자동 입장한다.
 *  - 서버가 모든 걸 검증한다: 보낸 사람/받는 사람은 소켓의 로그인 계정이며, 방 코드는 '수락된 신청'의 보낸 사람만 전달할 수 있다.
 *  - 도배 방지: 신청은 4초에 1번, 동시에 대기 중인 신청 1개, 30초 지나면 만료.
 */
const TTL_MS = 30000, HOST_MS = 25000, GAP_MS = 4000;
const GAMES = { soccer: '⚽ 축구', bounce: '🏓 원 바운스' };

function attach(io, { accounts }) {
  const invites = new Map(); let seq = 0;
  const socketsOf = (uid) => { const out = []; for (const [, s] of io.of('/').sockets) if (s.data && s.data.uid === uid) out.push(s); return out; };
  const statusOf = (uid) => { const ss = socketsOf(uid); if (ss.some((s) => s.data.code)) return 'soccer'; if (ss.some((s) => s.data.bzCode)) return 'bounce'; return 'idle'; };
  const list = () => {
    const seen = new Map();
    for (const [, s] of io.of('/').sockets) if (s.data && s.data.uid && s.data.nick && !seen.has(s.data.uid)) seen.set(s.data.uid, { uid: s.data.uid, nick: s.data.nick, st: statusOf(s.data.uid) });
    return [...seen.values()].sort((a, b) => (a.st === 'idle' ? 0 : 1) - (b.st === 'idle' ? 0 : 1) || a.nick.localeCompare(b.nick));
  };
  const tell = (uid, ev, d) => socketsOf(uid).forEach((s) => s.emit(ev, d));
  const finish = (inv, res) => { inv.state = 'done'; clearTimeout(inv.t); invites.delete(inv.id); if (res) tell(inv.from, 'pv:result', { id: inv.id, res, nick: inv.toNick }); tell(inv.to, 'pv:dismiss', { id: inv.id }); };

  io.on('connection', (socket) => {
    const d = socket.data = socket.data || {};
    if (!d.uid) return;
    accounts.get(d.uid).then((a) => { if (a) { d.nick = a.nick; io.emit('pv:changed'); } }).catch(() => {});
    socket.on('pv:list', (_p, ack) => { if (typeof ack === 'function') ack({ list: list(), me: d.uid }); });

    socket.on('pv:invite', (p, ack) => {
      const reply = (r) => { if (typeof ack === 'function') ack(r); };
      const to = String(p && p.to || ''), game = p && p.game;
      if (!GAMES[game]) return reply({ error: 'bad_game' });
      if (to === d.uid) return reply({ error: 'self' });
      const now = Date.now();
      if (d.invAt && now - d.invAt < GAP_MS) return reply({ error: 'slow' });
      if (!socketsOf(to).length) return reply({ error: 'offline' });
      if (statusOf(d.uid) !== 'idle') return reply({ error: 'me_busy' });
      if (statusOf(to) !== 'idle') return reply({ error: 'busy' });
      for (const inv of [...invites.values()]) if (inv.from === d.uid) finish(inv, null); // 이전 신청은 취소
      d.invAt = now;
      const inv = { id: ++seq, from: d.uid, fromNick: d.nick || d.uid, to, toNick: (socketsOf(to)[0].data.nick) || to, game, state: 'pending' };
      inv.t = setTimeout(() => { if (inv.state === 'pending') finish(inv, 'expired'); }, TTL_MS);
      invites.set(inv.id, inv);
      tell(to, 'pv:invited', { id: inv.id, from: inv.fromNick, game, label: GAMES[game], ttl: TTL_MS });
      reply({ ok: true, id: inv.id });
    });

    socket.on('pv:cancel', (p) => { const inv = invites.get(p && p.id); if (inv && inv.from === d.uid && inv.state === 'pending') finish(inv, null); });

    socket.on('pv:respond', (p, ack) => {
      const reply = (r) => { if (typeof ack === 'function') ack(r); };
      const inv = invites.get(p && p.id);
      if (!inv || inv.to !== d.uid || inv.state !== 'pending') return reply({ error: 'gone' });
      if (!p.accept) { finish(inv, 'declined'); return reply({ ok: true }); }
      if (statusOf(inv.to) !== 'idle') { finish(inv, 'busy'); return reply({ error: 'me_busy' }); }
      if (!socketsOf(inv.from).length || statusOf(inv.from) !== 'idle') { finish(inv, 'gone'); return reply({ error: 'gone' }); }
      clearTimeout(inv.t); inv.state = 'accepted'; inv.toSocket = socket.id;
      inv.t = setTimeout(() => { if (inv.state === 'accepted') { tell(inv.to, 'pv:result', { id: inv.id, res: 'expired' }); finish(inv, 'expired'); } }, HOST_MS);
      tell(inv.to, 'pv:dismiss', { id: inv.id, except: socket.id });
      tell(inv.from, 'pv:host', { id: inv.id, game: inv.game, nick: inv.toNick });
      reply({ ok: true });
    });

    socket.on('pv:code', (p) => {
      const inv = invites.get(p && p.id); const code = String(p && p.code || '').toUpperCase();
      if (!inv || inv.from !== d.uid || inv.state !== 'accepted' || !/^[A-Z0-9]{6,8}$/.test(code)) return;
      const tgt = socketsOf(inv.to).find((s) => s.id === inv.toSocket) || socketsOf(inv.to)[0];
      if (tgt) tgt.emit('pv:join', { id: inv.id, game: inv.game, code, from: inv.fromNick });
      finish(inv, null);
    });
    socket.on('pv:fail', (p) => { const inv = invites.get(p && p.id); if (inv && inv.from === d.uid && inv.state === 'accepted') { tell(inv.to, 'pv:result', { id: inv.id, res: 'failed' }); finish(inv, null); } });
    socket.on('disconnect', () => { for (const inv of [...invites.values()]) if (inv.from === d.uid || inv.to === d.uid) finish(inv, inv.from === d.uid ? null : 'gone'); setTimeout(() => io.emit('pv:changed'), 100); });
  });

  // 상태(대기/경기 중) 변화 감지 → 모두에게 알림 (2초마다 확인, 바뀔 때만)
  let sig = '';
  const iv = setInterval(() => { const s = list().map((x) => x.uid + x.st).join('|'); if (s !== sig) { sig = s; io.emit('pv:changed'); } }, 2000);
  if (iv.unref) iv.unref();
  return { list, stop: () => clearInterval(iv), invites };
}
module.exports = { attach, GAMES };
