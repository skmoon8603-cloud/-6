'use strict';
/**
 * Socket.IO 방/매치 관리.
 * - 방별로 Match 인스턴스를 분리하여 다른 방에 영향이 없다.
 * - 점수/시간/골 판정은 서버 엔진(Match)이 결정한다. 클라이언트는 입력만 보낸다.
 * - 연결이 끊기면 경기를 일시정지하고 GRACE 시간 동안 재접속을 기다린다.
 */
const crypto = require('crypto');
const K = require('./const');
const C = require('./catalog');
const I = require('./inventory');
const { Match } = require('./engine');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30000;
const LOBBY_GRACE_MS = 60000;
const IDLE_ROOM_MS = 20 * 60 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;

const cleanName = (n) => (String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 12)) || 'PLAYER';
const validCid = (c) => typeof c === 'string' && /^[A-Za-z0-9_\-]{8,64}$/.test(c);
const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validCode = (c) => /^[A-Z0-9]{6,8}$/.test(c);

function attach(io, opts = {}) {
  const rooms = new Map();
  const byCid = new Map(); // clientId -> code

  const emit = (pl, ev, data) => { if (pl && pl.socket) pl.socket.emit(ev, data); };
  const other = (room, pl) => room.players.find((p) => p !== pl);

  function genCode() {
    for (let i = 0; i < 100; i++) {
      let c = '';
      for (let k = 0; k < CODE_LEN; k++) c += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }

  function lineupInfo(ids) {
    return ids.map((id) => { const m = C.BY_ID[id]; return { id, name: m.name, pos: m.pos, rar: m.rarity, ovr: m.ovr, c1: m.c1, c2: m.c2, num: m.number }; });
  }

  function mkPlayer(socket, d) {
    const st = I.load(d.token);
    const lineup = C.validateLineup(d.lineup, st.inv);
    return { cid: d.cid, name: cleanName(d.name), socket, connected: true, ready: false, inv: st.inv, pulls: st.pulls, bal: st.bal, lineup, dcAt: 0 };
  }

  function publicState(room, forPl) {
    return {
      code: room.code, state: room.state, practice: room.practice,
      you: room.players.indexOf(forPl),
      players: room.players.map((p) => ({
        name: p.name, ready: p.ready, connected: p.connected,
        team: lineupInfo(p.lineup), avg: Math.round(p.lineup.reduce((s, id) => s + C.BY_ID[id].ovr, 0) / p.lineup.length),
      })),
      last: room.lastResult || null,
      graceMs: room.pauseDeadline ? Math.max(0, room.pauseDeadline - Date.now()) : 0,
    };
  }
  function pushState(room) {
    for (const p of room.players) emit(p, 'room:state', publicState(room, p));
    room.lastActive = Date.now();
  }

  function removeMember(room, pl, reason) {
    room.players = room.players.filter((p) => p !== pl);
    if (byCid.get(pl.cid) === room.code) byCid.delete(pl.cid);
    if (pl.socket) { pl.socket.data.code = null; try { pl.socket.leave && pl.socket.leave('r:' + room.code); } catch (e) { /* noop */ } }
    pl.socket = null;
    const rest = room.players[0];
    if (!rest || room.practice) { rooms.delete(room.code); if (rest) byCid.delete(rest.cid); return; }
    // 진행 중이던 경기는 몰수승
    if (room.state === 'match' && room.match && room.match.phase !== 'ended') {
      room.lastResult = { score: room.match.score.slice(), winner: 0, forfeit: true, reason };
      emit(rest, 'match:end', { ...room.lastResult, you: 0 });
    }
    room.state = 'lobby'; room.match = null; room.pauseDeadline = 0;
    rest.ready = false; rest.dcAt = rest.connected ? 0 : Date.now();
    emit(rest, 'opp:left', { reason });
    pushState(room);
  }

  function leave(socket, reason) {
    const code = socket.data.code;
    const room = rooms.get(code);
    if (!room) { socket.data.code = null; return; }
    const pl = room.players.find((p) => p.socket === socket);
    if (pl) removeMember(room, pl, reason || 'left');
  }

  function startMatch(room) {
    const [a, b] = room.players;
    const practice = room.practice;
    const lineups = [a.lineup, practice ? C.botLineup() : b.lineup];
    const invs = [a.inv, practice ? {} : b.inv];
    room.match = new Match({ lineups, invs, bots: [false, practice], seconds: room.seconds });
    room.state = 'match'; room.lastResult = null; room.pauseDeadline = 0;
    room.players.forEach((p) => { p.ready = false; });
    room.players.forEach((p, side) => emit(p, 'match:start', matchInfo(room, side)));
    pushState(room);
  }
  function matchInfo(room, side) {
    const m = room.match;
    return {
      side, roster: m.roster, seconds: m.seconds, practice: room.practice,
      names: [room.players[0].name, room.practice ? 'CPU' : room.players[1].name],
      field: { W: K.W, H: K.H, GOAL_W: K.GOAL_W, GOAL_D: K.GOAL_D, PR: K.PR, BR: K.BR },
    };
  }

  function finishRoomMatch(room) {
    const m = room.match;
    room.state = 'ended';
    room.lastResult = { score: m.result.score, winner: m.result.winner, forfeit: false };
    // CPU 연습 경기에서 사람이 이기면 서버가 보상(잔액 +1000원)을 확정하고 서명된 토큰을 발급
    let reward = null;
    if (room.practice && m.result.winner === 0) {
      const pl = room.players[0];
      pl.bal = Math.min(1e9, (pl.bal || 0) + I.WIN_REWARD);
      reward = { amount: I.WIN_REWARD, bal: pl.bal, token: I.encode(pl.inv, pl.pulls || 0, pl.bal) };
    }
    room.players.forEach((p, side) => { p.ready = false; emit(p, 'match:end', { ...room.lastResult, you: side, reward: side === 0 ? reward : null }); });
    pushState(room);
  }

  // ───────────── 소켓 핸들러 ─────────────
  io.on('connection', (socket) => {
    socket.data = socket.data || {};
    let bucket = { t: Date.now(), n: 0 };
    const allow = (limit) => {
      const now = Date.now();
      if (now - bucket.t > 1000) { bucket = { t: now, n: 0 }; }
      return ++bucket.n <= limit;
    };
    const ackSafe = (ack, v) => { if (typeof ack === 'function') ack(v); };

    function ensureFree(cid) {
      const old = byCid.get(cid);
      if (!old) return;
      const room = rooms.get(old);
      if (room) {
        const pl = room.players.find((p) => p.cid === cid);
        if (pl) removeMember(room, pl, 'left');
      }
      byCid.delete(cid);
    }

    socket.on('room:create', (d, ack) => {
      if (!allow(20) || !d || !validCid(d.cid)) return ackSafe(ack, { ok: false, err: 'invalid' });
      if (rooms.size >= MAX_ROOMS) return ackSafe(ack, { ok: false, err: 'server_busy' });
      ensureFree(d.cid);
      const code = genCode();
      if (!code) return ackSafe(ack, { ok: false, err: 'server_busy' });
      const pl = mkPlayer(socket, d);
      const room = { code, players: [pl], state: 'lobby', practice: false, match: null, lastResult: null, pauseDeadline: 0, lastActive: Date.now(), seconds: K.MATCH_SECONDS };
      rooms.set(code, room); byCid.set(d.cid, code);
      socket.data.code = code; socket.data.cid = d.cid;
      ackSafe(ack, { ok: true, code, side: 0 });
      pushState(room);
    });

    socket.on('room:practice', (d, ack) => {
      if (!allow(20) || !d || !validCid(d.cid)) return ackSafe(ack, { ok: false, err: 'invalid' });
      if (rooms.size >= MAX_ROOMS) return ackSafe(ack, { ok: false, err: 'server_busy' });
      ensureFree(d.cid);
      const code = genCode();
      const pl = mkPlayer(socket, d);
      const bot = { cid: 'bot', name: 'CPU', socket: null, connected: true, ready: true, inv: {}, lineup: C.botLineup(), dcAt: 0 };
      const room = { code, players: [pl, bot], state: 'lobby', practice: true, match: null, lastResult: null, pauseDeadline: 0, lastActive: Date.now(), seconds: K.MATCH_SECONDS };
      rooms.set(code, room); byCid.set(d.cid, code);
      socket.data.code = code; socket.data.cid = d.cid;
      ackSafe(ack, { ok: true, code, side: 0, practice: true });
      startMatch(room);
    });

    socket.on('room:join', (d, ack) => {
      if (!allow(20) || !d || !validCid(d.cid)) return ackSafe(ack, { ok: false, err: 'invalid' });
      const code = normCode(d.code);
      if (!validCode(code)) return ackSafe(ack, { ok: false, err: 'bad_code' });
      const room = rooms.get(code);
      if (!room || room.practice) return ackSafe(ack, { ok: false, err: 'not_found' });
      if (room.players.some((p) => p.cid === d.cid)) return ackSafe(ack, { ok: false, err: 'use_rejoin' });
      if (room.players.length >= 2) return ackSafe(ack, { ok: false, err: 'room_full' });
      ensureFree(d.cid);
      const pl = mkPlayer(socket, d);
      room.players.push(pl); byCid.set(d.cid, code);
      socket.data.code = code; socket.data.cid = d.cid;
      ackSafe(ack, { ok: true, code, side: 1 });
      emit(room.players[0], 'opp:joined', { name: pl.name });
      pushState(room);
    });

    socket.on('room:rejoin', (d, ack) => {
      if (!allow(20) || !d || !validCid(d.cid)) return ackSafe(ack, { ok: false, err: 'invalid' });
      const code = normCode(d.code);
      const room = rooms.get(code);
      const pl = room && room.players.find((p) => p.cid === d.cid);
      if (!pl) return ackSafe(ack, { ok: false, err: 'not_found' });
      if (pl.socket && pl.socket !== socket) { try { pl.socket.data.code = null; pl.socket.disconnect(true); } catch (e) { /* noop */ } }
      pl.socket = socket; pl.connected = true; pl.dcAt = 0;
      socket.data.code = code; socket.data.cid = d.cid;
      const side = room.players.indexOf(pl);
      ackSafe(ack, { ok: true, code, side, state: room.state });
      if (room.state === 'match' && room.match) {
        emit(pl, 'match:start', matchInfo(room, side));
        if (room.players.every((p) => p.connected)) {
          const m = room.match;
          if (m.paused) {
            m.paused = false; room.pauseDeadline = 0;
            if (m.phase === 'play') { m.phase = 'countdown'; m.phaseT = 2; m.afterCountdown = 'play'; }
          }
          room.players.forEach((p) => emit(p, 'opp:status', { connected: true }));
        }
      } else {
        const o = other(room, pl); if (o) emit(o, 'opp:status', { connected: true });
      }
      pushState(room);
    });

    socket.on('room:lineup', (d) => {
      if (!allow(20)) return;
      const room = rooms.get(socket.data.code);
      const pl = room && room.players.find((p) => p.socket === socket);
      if (!pl || room.state === 'match') return;
      const st = I.load(d && d.token);
      pl.inv = st.inv; pl.pulls = st.pulls; pl.bal = st.bal; pl.lineup = C.validateLineup(d && d.lineup, st.inv);
      if (d && d.name) pl.name = cleanName(d.name);
      pl.ready = false;
      pushState(room);
    });

    socket.on('room:ready', (d) => {
      if (!allow(20)) return;
      const room = rooms.get(socket.data.code);
      const pl = room && room.players.find((p) => p.socket === socket);
      if (!pl || room.state === 'match') return;
      if (room.state === 'ended') { room.state = 'lobby'; room.match = null; }
      pl.ready = !!(d && d.ready);
      if (room.practice && pl.ready) return startMatch(room);
      pushState(room);
      if (room.players.length === 2 && room.players.every((p) => p.ready && p.connected)) startMatch(room);
    });

    socket.on('room:leave', () => { if (allow(20)) leave(socket, 'left'); });

    socket.on('input', (d) => {
      if (!allow(100) || !d) return;
      const room = rooms.get(socket.data.code);
      if (!room || room.state !== 'match' || !room.match) return;
      const side = room.players.findIndex((p) => p.socket === socket);
      if (side < 0) return;
      room.match.setInput(side, +d.mx, +d.my, d.sp);
    });

    socket.on('act', (d) => {
      if (!allow(40) || !d) return;
      const room = rooms.get(socket.data.code);
      if (!room || room.state !== 'match' || !room.match) return;
      const side = room.players.findIndex((p) => p.socket === socket);
      if (side < 0) return;
      room.match.act(side, d.t, +d.p);
    });

    socket.on('ping:c', (_d, ack) => ackSafe(ack, Date.now()));

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code);
      if (!room) return;
      const pl = room.players.find((p) => p.socket === socket);
      if (!pl) return;
      pl.socket = null; pl.connected = false; pl.dcAt = Date.now();
      if (room.practice) { rooms.delete(room.code); byCid.delete(pl.cid); return; }
      const o = other(room, pl);
      if (room.state === 'match' && room.match && room.match.phase !== 'ended') {
        room.match.paused = true;
        room.pauseDeadline = Date.now() + RECONNECT_GRACE_MS;
        if (o) emit(o, 'opp:status', { connected: false, graceMs: RECONNECT_GRACE_MS });
      } else if (o) emit(o, 'opp:status', { connected: false, graceMs: LOBBY_GRACE_MS });
      pushState(room);
    });
  });

  // ───────────── 게임 루프 ─────────────
  function step() {
    for (const room of rooms.values()) {
      if (room.state !== 'match' || !room.match) continue;
      const m = room.match;
      if (!m.paused) {
        m.update(K.TICK);
        if (m.events.length) {
          const evs = m.events.splice(0);
          for (const p of room.players) emit(p, 'ev', evs);
        }
        if (m.tick % K.SNAP_EVERY === 0) {
          const s = m.snapshot();
          for (const p of room.players) if (p.socket) p.socket.volatile.emit('snap', s);
        }
        if (m.phase === 'ended') finishRoomMatch(room);
      }
    }
  }

  function sweep() {
    const now = Date.now();
    for (const room of [...rooms.values()]) {
      // 재접속 유예 만료 → 몰수승
      if (room.state === 'match' && room.match && room.match.paused && room.pauseDeadline && now > room.pauseDeadline) {
        const gone = room.players.filter((p) => !p.connected);
        const stay = room.players.filter((p) => p.connected);
        if (!stay.length) { for (const p of room.players) byCid.delete(p.cid); rooms.delete(room.code); continue; }
        const winner = room.players.indexOf(stay[0]);
        room.state = 'ended'; room.match.paused = false; room.pauseDeadline = 0;
        room.lastResult = { score: room.match.score.slice(), winner, forfeit: true, reason: 'opponent_disconnected' };
        room.players.forEach((p, side) => emit(p, 'match:end', { ...room.lastResult, you: side }));
        for (const g of gone) removeMember(room, g, 'disconnected');
        continue;
      }
      // 로비에서 끊긴 사람 정리
      for (const p of [...room.players]) {
        if (!p.connected && room.state !== 'match' && now - p.dcAt > LOBBY_GRACE_MS) removeMember(room, p, 'disconnected');
      }
      if (!rooms.has(room.code)) continue;
      if (room.players.every((p) => !p.connected || p.cid === 'bot') && now - room.lastActive > RECONNECT_GRACE_MS * 2) {
        for (const p of room.players) byCid.delete(p.cid); rooms.delete(room.code); continue;
      }
      if (now - room.lastActive > IDLE_ROOM_MS && room.state !== 'match') { for (const p of room.players) { byCid.delete(p.cid); if (p.socket) p.socket.data.code = null; } rooms.delete(room.code); }
    }
  }

  let timers = [];
  if (opts.autoloop !== false) {
    let last = Date.now(), acc = 0;
    timers.push(setInterval(() => {
      const now = Date.now(); acc += Math.min(0.25, (now - last) / 1000); last = now;
      let n = 0;
      while (acc >= K.TICK && n < 8) { step(); acc -= K.TICK; n++; }
    }, 16));
    timers.push(setInterval(sweep, 1000));
  }

  return {
    rooms, step, sweep,
    stats: () => ({ rooms: rooms.size, matches: [...rooms.values()].filter((r) => r.state === 'match').length }),
    stop: () => timers.forEach(clearInterval),
  };
}

module.exports = { attach, normCode, validCode };
