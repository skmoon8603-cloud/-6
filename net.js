'use strict';
/**
 * Socket.IO 방/매치 관리 (계정 로그인 필수).
 * - 방마다 독립된 Match 인스턴스. 점수/시간/골/내기 정산은 서버만 결정한다.
 * - 내기(stake): 경기 시작 시 두 사람의 판돈을 DB에서 동시에 잠그고(에스크로), 종료/기권/끊김 시 정산한다.
 * - 연결이 끊기면 경기를 일시정지하고 GRACE 동안 같은 계정의 재접속을 기다린다.
 * ※ '원'은 게임 안에서만 쓰는 가상 재화입니다.
 */
const crypto = require('crypto');
const K = require('./const');
const C = require('./catalog');
const { Match } = require('./engine');
const { STAKES } = require('./accounts');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LEN = 6;
const RECONNECT_GRACE_MS = Number(process.env.RECONNECT_GRACE_MS) || 30000;
const LOBBY_GRACE_MS = 60000;
const IDLE_ROOM_MS = 20 * 60 * 1000;
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 500;

const normCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const validCode = (c) => /^[A-Z0-9]{6,8}$/.test(c);

function attach(io, { accounts, auth, autoloop = true }) {
  const rooms = new Map();
  const byUid = new Map(); // 계정 id -> 방 코드
  const emit = (pl, ev, data) => { if (pl && pl.socket) pl.socket.emit(ev, data); };
  const other = (room, pl) => room.players.find((p) => p !== pl);
  const log = (e) => console.error('[net]', e && e.stack ? e.stack : e);

  // ── 인증: 연결 시 세션 토큰 필수 ──
  io.use(async (socket, next) => {
    try {
      const s = auth.verifySession(socket.handshake && socket.handshake.auth && socket.handshake.auth.token);
      if (!s || !(await accounts.get(s.uid))) return next(new Error('unauthorized'));
      socket.data = socket.data || {}; socket.data.uid = s.uid;
      next();
    } catch (e) { next(new Error('server_error')); }
  });

  function genCode() {
    for (let i = 0; i < 100; i++) {
      let c = '';
      for (let k = 0; k < CODE_LEN; k++) c += CODE_CHARS[crypto.randomInt(0, CODE_CHARS.length)];
      if (!rooms.has(c)) return c;
    }
    return null;
  }
  const lineupInfo = (ids) => ids.map((id) => { const m = C.BY_ID[id]; return { id, name: m.name, pos: m.pos, rar: m.rarity, ovr: m.ovr, c1: m.c1, c2: m.c2, num: m.number }; });

  async function mkPlayer(socket, lineupReq) {
    const a = await accounts.get(socket.data.uid);
    if (!a) return null;
    return { uid: a.id, name: a.nick || 'PLAYER', socket, connected: true, ready: false, inv: a.inv, lineup: C.validateLineup(lineupReq, a.inv), dcAt: 0, bal: a.bal };
  }

  function publicState(room, forPl) {
    return {
      code: room.code, state: room.state, practice: room.practice, stake: room.stake,
      you: room.players.indexOf(forPl),
      players: room.players.map((p) => ({
        name: p.name, ready: p.ready, connected: p.connected,
        team: lineupInfo(p.lineup), avg: Math.round(p.lineup.reduce((s, id) => s + C.BY_ID[id].ovr, 0) / p.lineup.length),
      })),
      last: room.lastResult || null,
      graceMs: room.pauseDeadline ? Math.max(0, room.pauseDeadline - Date.now()) : 0,
    };
  }
  function pushState(room) { for (const p of room.players) emit(p, 'room:state', publicState(room, p)); room.lastActive = Date.now(); }

  function matchInfo(room, side) {
    const m = room.match;
    return {
      side, roster: m.roster, seconds: m.seconds, practice: room.practice, stake: room.escrowed ? room.stake : 0,
      names: [room.players[0].name, room.practice ? 'CPU' : room.players[1].name],
      field: { W: K.W, H: K.H, GOAL_W: K.GOAL_W, GOAL_D: K.GOAL_D, PR: K.PR, BR: K.BR },
    };
  }

  // ── 경기 종료/정산 (정상 종료, 기권, 끊김 모두 이 함수로) ──
  async function conclude(room, { winner, forfeit, reason }) {
    if (room.concluded) return;
    room.concluded = true; room.state = 'ended'; room.pauseDeadline = 0;
    if (room.match) room.match.paused = false;
    const players = [...room.players];
    const score = room.match ? room.match.score.slice() : [0, 0];
    room.lastResult = { score, winner, forfeit: !!forfeit, reason: reason || null };
    let settle = null, rewardAmt = 0; const accts = {};
    try {
      if (room.escrowed) {
        const wUid = winner >= 0 && players[winner] ? players[winner].uid : null;
        settle = await accounts.settle(room.code, players.map((p) => p.uid), wUid);
        room.escrowed = false; Object.assign(accts, settle.accts || {});
      } else if (room.practice && winner === 0 && !forfeit && players[0]) {
        accts[players[0].uid] = await accounts.reward(players[0].uid, K.WIN_REWARD); rewardAmt = K.WIN_REWARD;
      }
    } catch (e) { log(e); }
    players.forEach((p, side) => {
      p.ready = false;
      const d = { ...room.lastResult, you: side };
      if (rewardAmt && side === 0 && accts[p.uid]) d.reward = { amount: rewardAmt, bal: accts[p.uid].bal };
      if (settle && settle.stake) { d.stake = settle.stake; d.pay = settle.winnerId ? (settle.winnerId === p.uid ? settle.stake : -settle.stake) : 0; }
      emit(p, 'match:end', d);
      if (accts[p.uid]) emit(p, 'account', accts[p.uid]);
    });
    pushState(room);
  }

  async function removeMember(room, pl, reason) {
    const rest = other(room, pl);
    if (room.state === 'match' && room.match && room.match.phase !== 'ended' && !room.concluded) {
      await conclude(room, { winner: rest ? room.players.indexOf(rest) : -1, forfeit: true, reason });
    } else if (room.escrowed && !room.concluded) {
      await conclude(room, { winner: -1, forfeit: true, reason }); // 시작 직후 이탈: 판돈 환급
    }
    room.players = room.players.filter((p) => p !== pl);
    if (byUid.get(pl.uid) === room.code) byUid.delete(pl.uid);
    if (pl.socket) { pl.socket.data.code = null; try { pl.socket.leave && pl.socket.leave('r:' + room.code); } catch (e) { /* noop */ } }
    pl.socket = null;
    const left = room.players[0];
    if (!left || room.practice) { rooms.delete(room.code); if (left) byUid.delete(left.uid); return; }
    room.state = 'lobby'; room.match = null; room.pauseDeadline = 0; room.concluded = false; room.lastResult = room.lastResult || null;
    left.ready = false; left.dcAt = left.connected ? 0 : Date.now();
    emit(left, 'opp:left', { reason });
    pushState(room);
  }

  async function leave(socket, reason) {
    const room = rooms.get(socket.data.code);
    if (!room) { socket.data.code = null; return; }
    const pl = room.players.find((p) => p.socket === socket);
    if (pl) await removeMember(room, pl, reason || 'left');
  }

  async function startMatch(room) {
    if (room.starting || room.state === 'match') return;
    room.starting = true;
    try {
      const humans = room.players.filter((p) => p.uid !== 'bot');
      for (const p of humans) { // 최신 보관함/잔액으로 편성 재검증
        const a = await accounts.get(p.uid);
        if (a) { p.inv = a.inv; p.lineup = C.validateLineup(p.lineup, a.inv); p.name = a.nick || p.name; }
      }
      if (rooms.get(room.code) !== room) return;
      if (room.stake > 0 && !room.practice) {
        const r = await accounts.escrow(room.code, humans.map((p) => p.uid), room.stake);
        if (!r.ok) {
          room.players.forEach((p) => { p.ready = false; });
          const who = room.players.find((p) => p.uid === r.who);
          humans.forEach((p) => emit(p, 'room:error', { err: r.err, who: who ? who.name : '', stake: room.stake }));
          return pushState(room);
        }
        room.escrowed = true;
      }
      const [a, b] = room.players;
      const lineups = [a.lineup, room.practice ? C.botLineup() : b.lineup];
      const invs = [a.inv, room.practice ? {} : b.inv];
      room.match = new Match({ lineups, invs, bots: [false, room.practice], seconds: room.seconds });
      room.state = 'match'; room.lastResult = null; room.pauseDeadline = 0; room.concluded = false;
      room.players.forEach((p) => { p.ready = false; });
      room.players.forEach((p, side) => emit(p, 'match:start', matchInfo(room, side)));
      pushState(room);
    } catch (e) { log(e); } finally { room.starting = false; }
  }

  // ───────────── 소켓 핸들러 ─────────────
  io.on('connection', (socket) => {
    socket.data = socket.data || {};
    const uid = socket.data.uid;
    let bucket = { t: Date.now(), n: 0 };
    const allow = (limit) => { const now = Date.now(); if (now - bucket.t > 1000) bucket = { t: now, n: 0 }; return ++bucket.n <= limit; };
    const ackSafe = (ack, v) => { if (typeof ack === 'function') ack(v); };
    const safe = (fn) => async (...a) => { try { await fn(...a); } catch (e) { log(e); const ack = a[a.length - 1]; if (typeof ack === 'function') ack({ ok: false, err: 'server_error' }); } };

    async function ensureFree() {
      const old = byUid.get(uid); if (!old) return;
      const room = rooms.get(old);
      const pl = room && room.players.find((p) => p.uid === uid);
      if (pl) await removeMember(room, pl, 'left');
      byUid.delete(uid);
    }
    const memberOf = () => { const room = rooms.get(socket.data.code); const pl = room && room.players.find((p) => p.socket === socket); return pl ? { room, pl } : {}; };

    socket.on('room:create', safe(async (d, ack) => {
      if (!allow(20)) return ackSafe(ack, { ok: false, err: 'invalid' });
      if (rooms.size >= MAX_ROOMS) return ackSafe(ack, { ok: false, err: 'server_busy' });
      await ensureFree();
      const code = genCode(); if (!code) return ackSafe(ack, { ok: false, err: 'server_busy' });
      const pl = await mkPlayer(socket, d && d.lineup); if (!pl) return ackSafe(ack, { ok: false, err: 'invalid' });
      const room = { code, players: [pl], state: 'lobby', practice: false, stake: 0, match: null, lastResult: null, pauseDeadline: 0, lastActive: Date.now(), seconds: K.MATCH_SECONDS };
      rooms.set(code, room); byUid.set(uid, code); socket.data.code = code;
      ackSafe(ack, { ok: true, code, side: 0 });
      pushState(room);
    }));

    socket.on('room:practice', safe(async (d, ack) => {
      if (!allow(20)) return ackSafe(ack, { ok: false, err: 'invalid' });
      if (rooms.size >= MAX_ROOMS) return ackSafe(ack, { ok: false, err: 'server_busy' });
      await ensureFree();
      const code = genCode(); const pl = await mkPlayer(socket, d && d.lineup);
      if (!code || !pl) return ackSafe(ack, { ok: false, err: 'invalid' });
      const bot = { uid: 'bot', name: 'CPU', socket: null, connected: true, ready: true, inv: {}, lineup: C.botLineup(), dcAt: 0 };
      const room = { code, players: [pl, bot], state: 'lobby', practice: true, stake: 0, match: null, lastResult: null, pauseDeadline: 0, lastActive: Date.now(), seconds: K.MATCH_SECONDS };
      rooms.set(code, room); byUid.set(uid, code); socket.data.code = code;
      ackSafe(ack, { ok: true, code, side: 0, practice: true });
      await startMatch(room);
    }));

    socket.on('room:join', safe(async (d, ack) => {
      if (!allow(20) || !d) return ackSafe(ack, { ok: false, err: 'invalid' });
      const code = normCode(d.code);
      if (!validCode(code)) return ackSafe(ack, { ok: false, err: 'bad_code' });
      const room = rooms.get(code);
      if (!room || room.practice) return ackSafe(ack, { ok: false, err: 'not_found' });
      if (room.players.some((p) => p.uid === uid)) return ackSafe(ack, { ok: false, err: 'use_rejoin' });
      if (room.players.length >= 2) return ackSafe(ack, { ok: false, err: 'room_full' });
      await ensureFree();
      const pl = await mkPlayer(socket, d.lineup); if (!pl) return ackSafe(ack, { ok: false, err: 'invalid' });
      if (room.players.length >= 2) return ackSafe(ack, { ok: false, err: 'room_full' });
      if (room.stake > 0 && pl.bal < room.stake) return ackSafe(ack, { ok: false, err: 'not_enough', stake: room.stake });
      room.players.push(pl); byUid.set(uid, code); socket.data.code = code;
      ackSafe(ack, { ok: true, code, side: 1, stake: room.stake });
      emit(room.players[0], 'opp:joined', { name: pl.name });
      pushState(room);
    }));

    socket.on('room:rejoin', safe(async (d, ack) => {
      if (!allow(20) || !d) return ackSafe(ack, { ok: false, err: 'invalid' });
      const code = normCode(d.code);
      const room = rooms.get(code);
      const pl = room && room.players.find((p) => p.uid === uid);
      if (!pl) return ackSafe(ack, { ok: false, err: 'not_found' });
      if (pl.socket && pl.socket !== socket) { try { pl.socket.data.code = null; pl.socket.disconnect(true); } catch (e) { /* noop */ } }
      pl.socket = socket; pl.connected = true; pl.dcAt = 0; socket.data.code = code;
      const side = room.players.indexOf(pl);
      ackSafe(ack, { ok: true, code, side, state: room.state });
      if (room.state === 'match' && room.match) {
        emit(pl, 'match:start', matchInfo(room, side));
        if (room.players.every((p) => p.connected)) {
          const m = room.match;
          if (m.paused) { m.paused = false; room.pauseDeadline = 0; if (m.phase === 'play') { m.phase = 'countdown'; m.phaseT = 2; } }
          room.players.forEach((p) => emit(p, 'opp:status', { connected: true }));
        }
      } else { const o = other(room, pl); if (o) emit(o, 'opp:status', { connected: true }); }
      pushState(room);
    }));

    socket.on('room:lineup', safe(async (d) => {
      if (!allow(20)) return;
      const { room, pl } = memberOf(); if (!pl || room.state === 'match' || room.starting) return;
      const a = await accounts.get(uid); if (!a) return;
      pl.inv = a.inv; pl.bal = a.bal; pl.name = a.nick || pl.name; pl.lineup = C.validateLineup(d && d.lineup, a.inv);
      pl.ready = false; pushState(room);
    }));

    // 방장이 내기 금액 설정 (0 = 내기 없음)
    socket.on('room:stake', safe(async (d, ack) => {
      if (!allow(20)) return;
      const { room, pl } = memberOf(); if (!pl || room.practice || room.state === 'match' || room.starting) return ackSafe(ack, { ok: false, err: 'invalid' });
      if (room.players[0] !== pl) return ackSafe(ack, { ok: false, err: 'host_only' });
      const stake = Number(d && d.stake);
      if (!STAKES.includes(stake)) return ackSafe(ack, { ok: false, err: 'invalid' });
      const a = await accounts.get(uid);
      if (!a || a.bal < stake) return ackSafe(ack, { ok: false, err: 'not_enough' });
      room.stake = stake; room.players.forEach((p) => { p.ready = false; });
      ackSafe(ack, { ok: true, stake }); pushState(room);
    }));

    socket.on('room:ready', safe(async (d) => {
      if (!allow(20)) return;
      const { room, pl } = memberOf(); if (!pl || room.state === 'match' || room.starting) return;
      if (room.state === 'ended') { room.state = 'lobby'; room.match = null; room.concluded = false; }
      pl.ready = !!(d && d.ready);
      if (room.practice && pl.ready) return startMatch(room);
      pushState(room);
      if (room.players.length === 2 && room.players.every((p) => p.ready && p.connected)) await startMatch(room);
    }));

    socket.on('room:leave', safe(async () => { if (allow(20)) await leave(socket, 'left'); }));

    socket.on('input', (d) => {
      if (!allow(100) || !d) return;
      const { room } = memberOf(); if (!room || room.state !== 'match' || !room.match) return;
      const side = room.players.findIndex((p) => p.socket === socket);
      if (side >= 0) room.match.setInput(side, +d.mx, +d.my, d.sp);
    });
    socket.on('act', (d) => {
      if (!allow(40) || !d) return;
      const { room } = memberOf(); if (!room || room.state !== 'match' || !room.match) return;
      const side = room.players.findIndex((p) => p.socket === socket);
      if (side >= 0) room.match.act(side, d.t, +d.p);
    });
    socket.on('ping:c', (_d, ack) => ackSafe(ack, Date.now()));

    socket.on('disconnect', () => {
      const room = rooms.get(socket.data.code); if (!room) return;
      const pl = room.players.find((p) => p.socket === socket); if (!pl) return;
      pl.socket = null; pl.connected = false; pl.dcAt = Date.now();
      if (room.practice) { rooms.delete(room.code); byUid.delete(pl.uid); return; }
      const o = other(room, pl);
      if (room.state === 'match' && room.match && room.match.phase !== 'ended') {
        room.match.paused = true; room.pauseDeadline = Date.now() + RECONNECT_GRACE_MS;
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
      if (m.paused) continue;
      m.update(K.TICK);
      if (m.events.length) { const evs = m.events.splice(0); for (const p of room.players) emit(p, 'ev', evs); }
      if (m.tick % K.SNAP_EVERY === 0) { const s = m.snapshot(); for (const p of room.players) if (p.socket) p.socket.volatile.emit('snap', s); }
      if (m.phase === 'ended' && !room.concluded) {
        conclude(room, { winner: m.result.winner, forfeit: false }).catch(log);
      }
    }
  }

  let sweeping = false;
  async function sweep() {
    if (sweeping) return; sweeping = true;
    try {
      const now = Date.now();
      for (const room of [...rooms.values()]) {
        if (room.state === 'match' && room.match && room.match.paused && room.pauseDeadline && now > room.pauseDeadline) {
          const gone = room.players.filter((p) => !p.connected), stay = room.players.filter((p) => p.connected);
          if (!stay.length) { // 둘 다 끊김: 내기는 환급
            if (room.escrowed) await conclude(room, { winner: -1, forfeit: true, reason: 'both_disconnected' });
            for (const p of room.players) byUid.delete(p.uid);
            rooms.delete(room.code); continue;
          }
          await conclude(room, { winner: room.players.indexOf(stay[0]), forfeit: true, reason: 'opponent_disconnected' });
          for (const g of gone) await removeMember(room, g, 'disconnected');
          continue;
        }
        for (const p of [...room.players]) {
          if (!p.connected && room.state !== 'match' && now - p.dcAt > LOBBY_GRACE_MS) await removeMember(room, p, 'disconnected');
        }
        if (!rooms.has(room.code)) continue;
        if (room.players.every((p) => !p.connected || p.uid === 'bot') && now - room.lastActive > RECONNECT_GRACE_MS * 2) {
          if (room.escrowed) await conclude(room, { winner: -1, forfeit: true, reason: 'abandoned' });
          for (const p of room.players) byUid.delete(p.uid);
          rooms.delete(room.code); continue;
        }
        if (now - room.lastActive > IDLE_ROOM_MS && room.state !== 'match') {
          for (const p of room.players) { byUid.delete(p.uid); if (p.socket) p.socket.data.code = null; }
          rooms.delete(room.code);
        }
      }
    } catch (e) { log(e); } finally { sweeping = false; }
  }

  const timers = [];
  if (autoloop) {
    let last = Date.now(), acc = 0;
    timers.push(setInterval(() => {
      const now = Date.now(); acc += Math.min(0.25, (now - last) / 1000); last = now;
      let n = 0; while (acc >= K.TICK && n < 8) { step(); acc -= K.TICK; n++; }
    }, 16));
    timers.push(setInterval(() => sweep(), 1000));
  }

  return {
    rooms, step, sweep,
    stats: () => ({ rooms: rooms.size, matches: [...rooms.values()].filter((r) => r.state === 'match').length }),
    stop: () => timers.forEach(clearInterval),
  };
}

module.exports = { attach, normCode, validCode };
