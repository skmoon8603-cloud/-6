'use strict';
/**
 * 실시간 전체 채팅방 (Socket.IO). 로그인한 사람만 접속(인증은 net.js 의 io.use 에서 처리).
 * - 최근 메시지 80개를 메모리에 보관, 접속하면 받아본다. 서버가 재시작되면 비워진다.
 * - 도배 방지: 1.2초에 1개, 길이 200자, 같은 말 연속 3번 금지, 관리자는 메시지 삭제 가능.
 * - 시스템 메시지(sys): 이적시장 거래 등을 채팅창에 알려준다.
 */
const HIST = 80, MAXLEN = 200, GAP_MS = 1200;
const clean = (t) => String(t == null ? '' : t).replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, MAXLEN);

const { nickOf } = require('./accounts');
function attach(io, { accounts, isAdmin }) {
  const hist = []; let seq = 0;
  const online = () => { let n = 0; const seen = new Set(); for (const [, s] of io.of('/').sockets) if (s.data && s.data.chat && !seen.has(s.data.uid)) { seen.add(s.data.uid); n++; } return n; };
  const pushOnline = () => io.to('chat').emit('chat:online', online());
  const add = (m) => { m.id = ++seq; hist.push(m); if (hist.length > HIST) hist.shift(); io.to('chat').emit('chat:msg', m); return m; };

  io.on('connection', (socket) => {
    const d = socket.data = socket.data || {};
    if (!d.uid) return;
    socket.on('chat:join', async (_p, ack) => {
      try {
        const a = await accounts.get(d.uid); if (!a) return;
        d.nick = nickOf(a); d.chat = true; d.last = 0; d.rep = 0; d.prev = '';
        socket.join('chat');
        if (typeof ack === 'function') ack({ hist, online: online(), admin: isAdmin(d.uid) });
        pushOnline();
      } catch (e) { /* noop */ }
    });
    socket.on('chat:leave', () => { d.chat = false; socket.leave('chat'); pushOnline(); });
    socket.on('chat:send', (p, ack) => {
      const reply = (r) => { if (typeof ack === 'function') ack(r); };
      if (!d.chat) return reply({ error: 'not_joined' });
      const text = clean(p && p.t);
      if (!text) return reply({ error: 'empty' });
      const now = Date.now();
      if (now - d.last < GAP_MS) return reply({ error: 'slow' });
      d.rep = text === d.prev ? d.rep + 1 : 0; d.prev = text;
      if (d.rep >= 2) return reply({ error: 'repeat' });
      d.last = now;
      add({ u: d.uid, n: d.nick, t: text, ts: now, adm: isAdmin(d.uid) || undefined });
      reply({ ok: true });
    });
    socket.on('chat:del', (p) => {
      if (!isAdmin(d.uid)) return;
      const i = hist.findIndex((m) => m.id === (p && p.id));
      if (i >= 0) { hist.splice(i, 1); io.to('chat').emit('chat:del', p.id); }
    });
    socket.on('disconnect', () => { if (d.chat) setTimeout(pushOnline, 50); });
  });
  return { sys: (text) => add({ sys: true, t: clean(text), ts: Date.now() }), hist, online };
}
module.exports = { attach, clean };
