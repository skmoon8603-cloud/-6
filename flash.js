'use strict';
/** 관리자 전용: 지금 접속 중인 모든 사람(본인 제외)의 화면에 이미지를 1초 동안 띄운다. 도배 방지 3초. */
const SHOW_MS = 1000, GAP_MS = 3000;
function attach(io, { isAdmin }) {
  let last = 0;
  io.on('connection', (socket) => {
    const d = socket.data = socket.data || {};
    if (!d.uid) return;
    socket.on('admin:flash', (_p, ack) => {
      const reply = (r) => { if (typeof ack === 'function') ack(r); };
      if (!isAdmin(d.uid)) return reply({ error: 'forbidden' });
      const now = Date.now();
      if (now - last < GAP_MS) return reply({ error: 'slow' });
      last = now;
      let n = 0; const seen = new Set();
      for (const [, s] of io.of('/').sockets) {
        if (!s.data || !s.data.uid || s.data.uid === d.uid) continue;
        s.emit('flash', { ms: SHOW_MS }); seen.add(s.data.uid);
      }
      n = seen.size; reply({ ok: true, n });
    });
  });
}
module.exports = { attach, SHOW_MS, GAP_MS };
