'use strict';
/**
 * 원 바운스 방/매치 (Socket.IO). 판정/점수/보상은 서버만 결정한다.
 * - 'bz:cpu'   : AI 와 대결 (이기면 BOUNCE_REWARD 원)
 * - 'bz:create'/'bz:join' : 친구와 방 코드로 대결 (보상 없음)
 * ※ '원'은 게임 안에서만 쓰는 가상 재화입니다.
 */
const crypto = require('crypto');
const K = require('./const');
const { OneBounce, C } = require('./onebounce');
const { STAKES } = require('./accounts');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;
const LOBBY_MS = 10 * 60 * 1000;

function attach(io, { accounts, autoloop = true }) {
  const rooms = new Map();
  const byUid = new Map();
  const log = (e) => console.error('[bounce]', e && e.stack ? e.stack : e);
  const emit = (pl, ev, d) => { if (pl && pl.socket) pl.socket.emit(ev, d); };

  const genCode = () => {
    for (let i = 0; i < 100; i++) {
      let c = 'B'; for (let k = 0; k < 6; k++) c += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  };

  async function startMatch(room) {
    if (room.stake > 0 && !room.cpu) { // 내기: 두 사람의 판돈을 동시에 잠근다 (실패하면 아무것도 바뀌지 않음)
      room.state = 'starting';
      let r;
      try { r = await accounts.escrow(room.code, room.players.map((p) => p.uid), room.stake); } catch (e) { log(e); r = { ok: false, err: 'server_error' }; }
      if (!r.ok) {
        const who = room.players.find((p) => p.uid === r.who);
        for (const p of room.players) emit(p, 'bz:error', { err: r.err, who: who ? who.name : '', stake: room.stake });
        drop(room); return;
      }
      room.escrowed = true;
      if (room.aborted || rooms.get(room.code) !== room || room.players.length < 2) { // 잠그는 사이에 누가 나감 → 전액 환급
        try { await accounts.settle(room.code, room.players.map((p) => p.uid), null); } catch (e) { log(e); }
        room.escrowed = false;
        for (const p of room.players) { const a = await accounts.get(p.uid); if (a) emit(p, 'account', a); }
        for (const p of room.players) emit(p, 'bz:left', {});
        drop(room); return;
      }
    }
    if (room.escrowed) for (const p of room.players) { const a = await accounts.get(p.uid); if (a) emit(p, 'account', a); } // 판돈이 잠긴 잔액 반영
    room.game = new OneBounce({ cpu: room.cpu, level: K.BOUNCE_CPU_LEVEL });
    room.state = 'play'; room.t0 = Date.now(); room.acc = 0; room.last = Date.now(); room.snapN = 0;
    room.players.forEach((p, side) => emit(p, 'bz:start', {
      side, code: room.code, cpu: room.cpu, stake: room.stake, C,
      names: [room.players[0].name, room.cpu ? 'AI' : room.players[1] ? room.players[1].name : '?'],
    }));
  }

  async function conclude(room, g) {
    if (room.concluded) return;
    room.concluded = true; room.state = 'ended';
    const winner = g.winner, forfeit = !!(g.ev.find((e) => e.type === 'end' && e.forfeit));
    let reward = null, settle = null;
    try {
      if (room.escrowed) {
        const wUid = winner >= 0 && room.players[winner] ? room.players[winner].uid : null;
        settle = await accounts.settle(room.code, room.players.map((p) => p.uid), wUid);
        room.escrowed = false;
        for (const p of room.players) if (settle.accts && settle.accts[p.uid]) emit(p, 'account', settle.accts[p.uid]);
      } else if (room.cpu && winner === 0 && !forfeit && room.players[0]) {
        const a = await accounts.reward(room.players[0].uid, K.BOUNCE_REWARD);
        if (a) { reward = { amount: K.BOUNCE_REWARD, bal: a.bal }; emit(room.players[0], 'account', a); }
      }
    } catch (e) { log(e); }
    room.players.forEach((p, side) => emit(p, 'bz:end', { winner, you: side, score: g.score.slice(), forfeit, reward: side === 0 ? reward : null, stake: settle && settle.stake ? settle.stake : 0, pay: settle && settle.stake ? (settle.winnerId ? (settle.winnerId === room.players[side].uid ? settle.stake : -settle.stake) : 0) : 0 }));
  }

  function step() {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      if (room.state === 'lobby') { if (now - room.created > LOBBY_MS) drop(room); continue; }
      if (room.state !== 'play') continue;
      const g = room.game;
      room.acc = Math.min(0.25, room.acc + (now - room.last) / 1000); room.last = now;
      while (room.acc >= K.TICK && !g.over) {
        room.acc -= K.TICK; g.update(K.TICK);
        if (++room.snapN % K.SNAP_EVERY === 0) {
          const s = g.snapshot();
          for (const p of room.players) if (p.socket) p.socket.volatile.emit('bz:snap', s);
        }
        if (g.ev.length) {
          const evs = g.ev.filter((e) => e.type !== 'end'); g.ev = g.ev.filter((e) => e.type === 'end');
          if (evs.length) for (const p of room.players) emit(p, 'bz:ev', evs);
        }
      }
      if (g.over) { const s = g.snapshot(); for (const p of room.players) emit(p, 'bz:snap', s); conclude(room, g).then(() => drop(room)).catch(log); }
    }
  }

  function drop(room) {
    rooms.delete(room.code);
    for (const p of room.players) { if (byUid.get(p.uid) === room.code) byUid.delete(p.uid); if (p.socket) p.socket.data.bzCode = null; }
  }

  /** 방을 떠난다. 진행 중이면 상대 승리(기권). */
  async function leave(socket) {
    const code = socket.data.bzCode; const room = code && rooms.get(code); if (!room) return;
    const side = room.players.findIndex((p) => p.socket === socket);
    if (side < 0) return;
    if (room.state === 'starting') { room.aborted = true; return; }
    if (room.state === 'play') { const g = room.game; g.forfeit(side); await conclude(room, g); drop(room); return; }
    room.players.splice(side, 1);
    if (byUid.get(socket.data.uid) === code) byUid.delete(socket.data.uid);
    socket.data.bzCode = null;
    if (!room.players.length || room.state === 'lobby') { if (room.players[0]) emit(room.players[0], 'bz:left', {}); rooms.delete(code); if (room.players[0]) { byUid.delete(room.players[0].uid); room.players[0].socket.data.bzCode = null; } }
  }

  io.on('connection', (socket) => {
    const uid = socket.data && socket.data.uid; if (!uid) return;
    let bucket = { t: 0, n: 0 };
    const allow = (limit) => { const now = Date.now(); if (now - bucket.t > 1000) bucket = { t: now, n: 0 }; return ++bucket.n <= limit; };
    const ack = (cb, v) => { if (typeof cb === 'function') cb(v); };
    const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { log(e); const cb = a[a.length - 1]; if (typeof cb === 'function') cb({ ok: false, err: 'server_error' }); } };
    const mk = async () => { const a = await accounts.get(uid); return a ? { uid, name: a.nick || 'PLAYER', socket } : null; };

    const enter = async (d, cb, mode) => {
      if (!allow(10)) return ack(cb, { ok: false, err: 'invalid' });
      if (rooms.size >= MAX_ROOMS) return ack(cb, { ok: false, err: 'server_busy' });
      if (byUid.has(uid)) { const old = rooms.get(byUid.get(uid)); if (old) { const oldPl = old.players.find((p) => p.uid === uid); if (oldPl && oldPl.socket) await leave(oldPl.socket); } byUid.delete(uid); }
      const pl = await mk(); if (!pl) return ack(cb, { ok: false, err: 'invalid' });
      if (mode === 'join') {
        const code = String(d && d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
        const room = rooms.get(code);
        if (!room || room.cpu) return ack(cb, { ok: false, err: 'no_room' });
        if (room.state !== 'lobby' || room.players.length >= 2) return ack(cb, { ok: false, err: 'room_full' });
        if (room.players[0].uid === uid) return ack(cb, { ok: false, err: 'self' });
        if (room.stake > 0) { const a = await accounts.get(uid); if (!a || a.bal < room.stake) return ack(cb, { ok: false, err: 'not_enough', stake: room.stake }); if (a.locked) return ack(cb, { ok: false, err: 'locked' }); }
        room.players.push(pl); byUid.set(uid, code); socket.data.bzCode = code;
        ack(cb, { ok: true, code, stake: room.stake });
        await startMatch(room);
        return;
      }
      const code = genCode(); if (!code) return ack(cb, { ok: false, err: 'server_busy' });
      const stake = mode === 'create' && STAKES.includes(+(d && d.stake)) ? +d.stake : 0;
      if (stake > 0) { const a = await accounts.get(uid); if (!a || a.bal < stake) return ack(cb, { ok: false, err: 'not_enough', stake }); if (a.locked) return ack(cb, { ok: false, err: 'locked' }); }
      const room = { code, players: [pl], state: 'lobby', cpu: mode === 'cpu', stake, escrowed: false, created: Date.now(), game: null, concluded: false };
      rooms.set(code, room); byUid.set(uid, code); socket.data.bzCode = code;
      ack(cb, { ok: true, code, cpu: room.cpu, stake });
      if (room.cpu) startMatch(room);
    };

    socket.on('bz:cpu', safe((d, cb) => enter(d, cb, 'cpu')));
    socket.on('bz:create', safe((d, cb) => enter(d, cb, 'create')));
    socket.on('bz:join', safe((d, cb) => enter(d, cb, 'join')));
    socket.on('bz:peek', safe((d, cb) => { // 입장 전 판돈 확인
      if (!allow(10)) return ack(cb, { ok: false });
      const room = rooms.get(String(d && d.code || '').toUpperCase().replace(/[^A-Z0-9]/g, ''));
      if (!room || room.cpu || room.state !== 'lobby' || room.players.length >= 2) return ack(cb, { ok: false, err: room ? 'room_full' : 'no_room' });
      ack(cb, { ok: true, stake: room.stake, host: room.players[0].name });
    }));
    socket.on('bz:leave', safe(async () => { if (allow(10)) await leave(socket); }));
    const mine = () => { const room = rooms.get(socket.data.bzCode); if (!room || room.state !== 'play') return null; const side = room.players.findIndex((p) => p.socket === socket); return side < 0 ? null : { room, side }; };
    socket.on('bz:in', (d) => { if (!allow(60) || !d) return; const m = mine(); if (m) m.room.game.setMove(m.side, +d.m); });
    socket.on('bz:swing', (d) => { if (!allow(30) || !d) return; const m = mine(); if (m) m.room.game.swing(m.side, d.k === 'smash' ? 'smash' : 'lob', +d.a); });
    socket.on('disconnect', safe(async () => { await leave(socket); }));
  });

  let timer = null;
  if (autoloop) { timer = setInterval(() => { try { step(); } catch (e) { log(e); } }, 1000 / 60); if (timer.unref) timer.unref(); }
  return { step, rooms, stop: () => timer && clearInterval(timer) };
}

module.exports = { attach };
