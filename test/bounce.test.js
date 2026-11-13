'use strict';
// 원 바운스: 엔진 규칙 + 서버(목 소켓) 통합 테스트 (AI 승리 보상, 친구 대결, 기권)
process.env.SESSION_SECRET = 'test-secret'; process.env.DEV_LOGIN = '1';
const assert = require('assert');
const K = require('../lib/const');
const auth = require('../lib/auth');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
const { OneBounce, C } = require('../lib/onebounce');
const bouncenet = require('../lib/bouncenet');
let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };
const step = (g, sec) => { for (let i = 0; i < sec * 120; i++) g.update(1 / 120); };
const mk = (o) => { const g = new OneBounce({ rng: () => 0.5, cpu: false, ...o }); g.phaseT = 0; g.update(1 / 60); g.ev.length = 0; return g; };

// ── 엔진 규칙 ──
{ // 떠 있는 공도 찰 수 있다 (발리 허용)
  const g = mk(); g.cpuOn = false;
  Object.assign(g.ball, { x: 150, y: C.GY - 60, vx: 0, vy: 0, lastHit: 1, bounces: 0, recv: 0 }); g.p[0].x = 150;
  assert(g.swing(0, 'lob', 0) && g.score[1] === 0 && g.ball.lastHit === 0); ok('공이 떠 있을 때(튕기기 전) 차도 반칙이 아니다');
}
{ // 한 번 튕긴 뒤에도 찰 수 있다
  const g = mk(); Object.assign(g.ball, { x: 150, y: C.GY - 20, vx: 0, vy: 0, lastHit: 1, bounces: 1, recv: 0 }); g.p[0].x = 150;
  assert(g.swing(0, 'smash', 0)); ok('한 번 튕긴 뒤에 차도 된다');
}
{ // 높은 공(발이 안 닿는 높이)은 못 찬다, 상대 차례 공도 못 찬다
  const g = mk(); Object.assign(g.ball, { x: 150, y: 60, vx: 0, vy: 0, lastHit: 1, bounces: 0, recv: 0 }); g.p[0].x = 150;
  assert(!g.swing(0, 'lob', 0)); ok('발이 닿지 않는 높이의 공은 못 찬다');
  const h = mk(); Object.assign(h.ball, { x: 150, y: C.GY - 20, vx: 0, vy: 0, lastHit: 0, bounces: 0, recv: 1 }); h.p[0].x = 150;
  assert(!h.swing(0, 'lob', 0)); ok('방금 내가 찬 공(상대 차례)은 다시 못 찬다');
}
{ // 내가 찬 공은 상대 코트에 먼저 떨어진다
  const g = mk(); Object.assign(g.ball, { x: 150, y: C.GY - 20, vx: 0, vy: 0, lastHit: 1, bounces: 1, recv: 0 }); g.p[0].x = 150;
  g.swing(0, 'lob', 0); g.ev.length = 0; let landed = null;
  for (let i = 0; i < 600 && landed === null; i++) { g.update(1 / 120); const e = g.ev.find((x) => x.type === 'bounce'); if (e) landed = e.x; g.ev.length = 0; }
  assert(landed > C.NET_X, 'x=' + landed); assert.deepStrictEqual(g.score, [0, 0]); ok('친 공이 네트를 넘어 상대 코트에 먼저 닿는다 (강/약 모두)');
  for (const kind of ['smash', 'lob']) for (const a of [-1, 1]) {
    const h = mk(); Object.assign(h.ball, { x: 120, y: C.GY - 30, vx: 0, vy: 0, lastHit: 1, bounces: 1, recv: 0 }); h.p[0].x = 120;
    h.swing(0, kind, a); step(h, 3); assert(h.score[1] === 0 && h.ball.lastHit === 0 || h.score[0] + h.score[1] > 0 && h.score[1] === 0 || h.ball.recv === 1, kind + a);
  }
}
{ // 두 번 튕기면 못 찬 쪽 실점
  const g = mk(); g.p[0].x = 40; g.p[0].mv = 0; Object.assign(g.ball, { x: 330, y: 100, vx: 0, vy: 0, lastHit: 1, bounces: 0, recv: 0 });
  step(g, 3); assert.deepStrictEqual(g.score, [0, 1]); ok('내 코트에 두 번 튕기도록 못 차면 실점');
}
{ // 자기 코트에 먼저 떨어지면 친 사람 실점 / 네트
  const g = mk(); Object.assign(g.ball, { x: 200, y: 200, vx: 0, vy: 0, lastHit: 0, bounces: 0, recv: 1 }); step(g, 1);
  assert.deepStrictEqual(g.score, [0, 1]); ok('친 공이 내 코트에 먼저 닿으면 실점');
  const h = mk(); Object.assign(h.ball, { x: C.NET_X - 30, y: C.GY - 20, vx: 300, vy: 0, lastHit: 0, bounces: 0, recv: 1 }); step(h, 0.3);
  assert.deepStrictEqual(h.score, [0, 1]); ok('네트에 걸리면 친 사람 실점');
}
{ // AI vs 자동 플레이어: 전부 7점 선취로 끝나고 NaN 없음
  let ends = 0;
  for (let k = 0; k < 20; k++) {
    let s = k + 1; const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const g = new OneBounce({ rng, level: 0.4 });
    for (let i = 0; i < 120 * 900 && !g.over; i++) {
      const b = g.ball; g.setMove(0, b.recv === 0 ? Math.sign(b.x - g.p[0].x) : 0);
      if (g.canHit(0) && rng() < 0.12) g.swing(0, rng() < 0.3 ? 'smash' : 'lob', rng() * 2 - 1);
      g.update(1 / 120); g.ev.length = 0; assert(Number.isFinite(b.x) && Number.isFinite(b.y));
    }
    if (g.over) { ends++; assert(Math.max(...g.score) === C.WIN); }
  }
  assert(ends >= 18); ok(`자동 경기 20판 중 ${ends}판이 ${C.WIN}점 선취로 종료`);
}

// ── 서버 통합 ──
const store = new MemoryStore(); const accounts = new Accounts(store);
const handlers = []; const mw = [];
const io = { use: (f) => mw.push(f), on: (ev, f) => { if (ev === 'connection') handlers.push(f); } };
let seq = 0;
async function user(name) { const a = await accounts.login(await auth.verifyGoogle('dev:' + name)); return { id: a.id, token: auth.signSession(a.id) }; }
async function conn(u) {
  const h = {}, inbox = [];
  const sock = { id: 's' + (++seq), data: {}, handshake: { auth: { token: u.token } }, on: (ev, f) => { h[ev] = f; }, emit: (ev, d) => inbox.push([ev, d]), leave() {}, disconnect() {}, volatile: { emit: (ev, d) => inbox.push([ev, d]) } };
  for (const f of mw) await new Promise((res, rej) => f(sock, (e) => (e ? rej(e) : res())));
  handlers.forEach((f) => f(sock));
  return { sock, inbox, send: (ev, d) => new Promise((res) => { Promise.resolve(h[ev](d, res)).then(() => res()); }), drop: () => h.disconnect && h.disconnect(), got: (ev) => inbox.filter((x) => x[0] === ev).map((x) => x[1]) };
}
const net = bouncenet.attach(io, { accounts, autoloop: false });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
(async () => {
  io.use = null;
  mw.push((s, nx) => { const t = auth.verifySession(s.handshake.auth.token); s.data.uid = t.uid; nx(); });
  const ua = await user('alice'), ub = await user('bob'), uc = await user('cara');
  // AI 대결: 이기면 +1,000원 (서버 DB)
  const A = await conn(ua); const r = await A.send('bz:cpu', {}); assert(r.ok); assert.strictEqual(A.got('bz:start').length, 1); ok('AI 대결 즉시 시작');
  const room = [...net.rooms.values()][0]; room.game.cpuOn = true;
  // 사람 쪽을 이기게: 7점을 직접 만든다 (실제 득점 로직 사용)
  for (let i = 0; i < C.WIN; i++) room.game.point(0, 'double');
  net.step(); await sleep(30);
  assert.strictEqual(A.got('bz:end').length, 1); const end = A.got('bz:end')[0];
  assert(end.winner === 0 && end.reward.amount === 1000); assert.strictEqual((await accounts.get(ua.id)).bal, 1000); ok('AI를 이기면 서버 DB에 +1,000원');
  assert(A.got('account').length >= 1); assert.strictEqual(net.rooms.size, 0); ok('종료 후 방 정리 + 잔액 갱신 이벤트');
  // AI에게 지면 보상 없음 / 기권해도 보상 없음
  const A2 = await conn(ua); await A2.send('bz:cpu', {}); const r2 = [...net.rooms.values()][0];
  for (let i = 0; i < C.WIN; i++) r2.game.point(1, 'double'); net.step(); await sleep(30);
  assert(!A2.got('bz:end')[0].reward); assert.strictEqual((await accounts.get(ua.id)).bal, 1000); ok('AI에게 지면 보상 없음');
  const A3 = await conn(ua); await A3.send('bz:cpu', {}); await A3.send('bz:leave'); assert.strictEqual((await accounts.get(ua.id)).bal, 1000); assert.strictEqual(net.rooms.size, 0); ok('도중에 나가면(기권) 보상 없음');
  // 친구 대결: 방 만들기 → 입장 → 입력 → 승부, 보상 없음
  const B = await conn(ub), Cc = await conn(uc);
  const cr = await B.send('bz:create', {}); assert(cr.ok && /^B[A-Z0-9]{5}$/.test(cr.code));
  assert.strictEqual((await Cc.send('bz:join', { code: 'ZZZZZZ' })).err, 'no_room'); ok('없는 방 코드는 입장 실패');
  const jr = await Cc.send('bz:join', { code: cr.code }); assert(jr.ok);
  assert.strictEqual(B.got('bz:start')[0].side, 0); assert.strictEqual(Cc.got('bz:start')[0].side, 1); ok('친구가 코드로 입장하면 양쪽에 시작 알림 (A=왼쪽, B=오른쪽)');
  const D = await conn(await user('dan')); assert.strictEqual((await D.send('bz:join', { code: cr.code })).err, 'room_full'); ok('가득 찬 방은 입장 불가');
  await Cc.send('bz:in', { m: -1 }); for (let i = 0; i < 90; i++) { net.step(); await sleep(2); }
  const snap = Cc.got('bz:snap').pop(); assert(snap && snap.p[1][0] < C.W - 150 + 1); ok('입력이 서버에서 처리되어 스냅샷에 반영');
  const fr = [...net.rooms.values()][0]; for (let i = 0; i < C.WIN; i++) fr.game.point(1, 'double'); net.step(); await sleep(30);
  assert(Cc.got('bz:end')[0].winner === 1 && !Cc.got('bz:end')[0].reward); assert.strictEqual((await accounts.get(uc.id)).bal, 0); ok('친구 대결은 승부만 가리고 원 보상은 없음');
  // 친구 대결 도중 한 명이 끊기면 상대 승리
  const E = await conn(await user('eve')), F = await conn(await user('finn'));
  const er = await E.send('bz:create', {}); await F.send('bz:join', { code: er.code }); E.drop(); await sleep(20);
  assert(F.got('bz:end')[0].winner === 1 && F.got('bz:end')[0].forfeit); ok('상대가 끊기면 남은 사람 승리(기권승)');
  console.log('\n원 바운스 통과: ' + n + '개');
})().catch((e) => { console.error(e); process.exit(1); });
