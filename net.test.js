'use strict';
// Socket.IO 없이 실행 가능한 서버 로직 통합 테스트 (목 소켓 사용)
process.env.MATCH_SECONDS = '60';
process.env.RECONNECT_GRACE_MS = '300';
process.env.INVENTORY_SECRET = 'test-secret';
const assert = require('assert');
const K = require('../lib/const');
const C = require('../lib/catalog');
const I = require('../lib/inventory');
const api = require('../lib/api');
const net = require('../lib/net');

// ── 목 io ──
const handlersOnConn = [];
const io = { on: (ev, fn) => { if (ev === 'connection') handlersOnConn.push(fn); } };
let seq = 0;
function connect() {
  const h = {}; const inbox = [];
  const sock = {
    id: 's' + (++seq), data: {}, on: (ev, fn) => { h[ev] = fn; },
    emit: (ev, d) => inbox.push([ev, d]), leave() {}, disconnect() { this.dead = true; },
    volatile: { emit: (ev, d) => inbox.push([ev, d]) },
  };
  handlersOnConn.forEach((fn) => fn(sock));
  const c = {
    sock, inbox, cid: 'client-' + sock.id + '-abcdef',
    send: (ev, d) => new Promise((res) => { if (!h[ev]) return res(undefined); const r = h[ev](d, res); if (ev !== 'room:create' && ev !== 'room:join' && ev !== 'room:rejoin' && ev !== 'room:practice' && ev !== 'ping:c') res(r); }),
    drop: () => { h.disconnect && h.disconnect(); },
    got: (ev) => inbox.filter((x) => x[0] === ev).map((x) => x[1]),
    clear: () => { inbox.length = 0; },
  };
  return c;
}
const game = net.attach(io, { autoloop: false });
const run = (n) => { for (let i = 0; i < n; i++) game.step(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };

(async () => {
  // 1. 방 생성/입장
  const A = connect(), B = connect(), X = connect();
  const lineA = ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'S_FW2'];
  // 보유하지 않은 신화 선수로 편성 시도 → 서버가 기본 선수로 대체해야 함
  const myth = C.CATALOG.find((p) => p.rarity === 'myth' && p.pos === 'FW').id;
  const cheat = lineA.slice(); cheat[4] = myth;
  const r1 = await A.send('room:create', { cid: A.cid, name: 'Alice', token: '', lineup: cheat });
  assert(r1.ok && /^[A-Z2-9]{6}$/.test(r1.code), 'code format'); ok('방 코드 6자리 생성: ' + r1.code);
  const stA = A.got('room:state').pop();
  assert.strictEqual(stA.players[0].team[4].id, 'S_FW1'); ok('미보유 선수 편성 시도 → 서버가 기본 선수로 교체');
  const bad = await B.send('room:join', { cid: B.cid, code: 'zzzzzz', name: 'Bob' });
  assert(!bad.ok && bad.err === 'not_found'); ok('없는 방 코드 거절');
  const bad2 = await B.send('room:join', { cid: B.cid, code: 'abc', name: 'Bob' });
  assert(!bad2.ok && bad2.err === 'bad_code'); ok('형식이 틀린 코드 거절');
  // 정당한 보관함 토큰으로 신화 보유
  let tok = null, haveMyth = false;
  for (let i = 0; i < 4000 && !haveMyth; i++) { const o = I.pull(tok, 10); tok = o.token; haveMyth = o.results.some((x) => C.BY_ID[x.id].rarity === 'myth' && C.BY_ID[x.id].pos === 'FW'); }
  const mine = Object.keys(I.load(tok).inv).find((id) => C.BY_ID[id].rarity === 'myth' && C.BY_ID[id].pos === 'FW');
  const r2 = await B.send('room:join', { cid: B.cid, code: r1.code.toLowerCase(), name: 'Bob', token: tok, lineup: ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', mine, 'S_FW2'] });
  assert(r2.ok && r2.side === 1); ok('친구가 소문자 코드로 입장 (대소문자 무시)');
  assert.strictEqual(B.got('room:state').pop().players[1].team[4].id, mine); ok('서명된 토큰으로 보유한 선수는 편성 허용');
  const full = await X.send('room:join', { cid: X.cid, code: r1.code, name: 'Eve' });
  assert(!full.ok && full.err === 'room_full'); ok('3번째 입장 거절 (최대 2명)');
  const forged = I.load(tok.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A')));
  assert.deepStrictEqual(forged.inv, {}); ok('위조된 보관함 토큰은 무효 처리');

  // 2. 준비 → 경기 시작
  await A.send('room:ready', { ready: true });
  assert.strictEqual(A.got('match:start').length, 0);
  await B.send('room:ready', { ready: true });
  assert(A.got('match:start').length === 1 && B.got('match:start').length === 1); ok('양쪽 준비 시 경기 시작');
  const room = [...game.rooms.values()][0];
  run(60 * 4); // 카운트다운 통과
  assert.strictEqual(room.match.phase, 'play');
  const snapsA = A.got('snap'), snapsB = B.got('snap');
  assert(snapsA.length > 50 && snapsB.length > 50); assert.strictEqual(snapsA[0].p.length, 12); ok('양쪽에 스냅샷(선수 12명+공) 실시간 전송');
  // 입력 → 서버 위치 변화, 상대 클라이언트에도 반영
  const before = room.match.players[room.match.teams[0].ctrl * 1].x;
  await A.send('input', { mx: 1, my: 0, sp: true }); run(60);
  const ctrl0 = room.match.players[room.match.teams[0].ctrl];
  const lastB = B.got('snap').pop();
  assert(Math.abs(lastB.p[ctrl0.i][0] - ctrl0.x) < 40 && ctrl0.x > before + 20); ok('A의 입력이 서버에서 처리되고 B 스냅샷에 동기화');
  // 조작 시도: 점수/공 위치를 직접 보내도 영향 없음
  const sc0 = room.match.score.slice();
  await A.send('score', { s: [9, 9] }); await A.send('act', { t: 'goal', p: 999 }); await A.send('input', { mx: 1e9, my: NaN, sp: 1, score: 99, ball: { x: 9999 } });
  run(10); assert.deepStrictEqual(room.match.score, sc0); assert(Math.hypot(room.match.players[ctrl0.i].vx, room.match.players[ctrl0.i].vy) < 400); ok('클라이언트가 점수/공/속도를 임의 조작 불가');
  // 방 밖 사용자가 입력 보내도 무시
  await X.send('input', { mx: 1, my: 1 }); await X.send('room:ready', { ready: true }); ok('방 밖 소켓의 입력/준비 무시');

  // 3. 골 판정 (서버가 판정) + 방 격리
  const C1 = connect(), D1 = connect();
  const rr = await C1.send('room:create', { cid: C1.cid, name: 'Cat' });
  await D1.send('room:join', { cid: D1.cid, code: rr.code, name: 'Dog' });
  await C1.send('room:ready', { ready: true }); await D1.send('room:ready', { ready: true });
  const room2 = game.rooms.get(rr.code);
  run(60 * 4);
  const otherScore = room2.match.score.slice();
  A.clear();
  const m = room.match;
  Object.assign(m.ball, { x: K.W - 40, y: K.H / 2, vx: 500, vy: 0 });
  for (const p of m.players) { p.x = 300; p.y = 100; } // 선수 간섭 제거
  run(30);
  const goals = A.got('ev').flat().filter((e) => e.type === 'goal');
  assert.strictEqual(goals.length, 1); assert.strictEqual(goals[0].side, 0); assert.deepStrictEqual(m.score, [sc0[0] + 1, sc0[1]]); ok('골대 안으로 들어가면 서버가 득점 판정 → 점수 +1 (팀0)');
  assert.deepStrictEqual(room2.match.score, otherScore); ok('다른 방의 점수/경기에는 영향 없음 (방 격리)');
  // 골 직후 킥오프 리셋
  run(60 * 4);
  assert(Math.abs(m.ball.x - K.W / 2) < 5 && m.phase !== 'goal'); ok('골 연출 후 킥오프 위치로 리셋');
  // 골대 옆(포스트 밖)은 골이 아님
  const s1 = m.score.slice();
  Object.assign(m.ball, { x: K.W - 30, y: K.H / 2 - K.GOAL_W / 2 - 30, vx: 400, vy: 0 }); m.phase = 'play';
  for (const p of m.players) { p.x = 300; p.y = 100; }
  run(40); assert.deepStrictEqual(m.score, s1); ok('골 입구 밖으로 향한 공은 득점이 아님');

  // 4. 연결 끊김 → 일시정지 → 재접속
  B.clear(); A.clear();
  const tBefore = m.timeLeft;
  B.drop();
  assert(A.got('opp:status').some((s) => s.connected === false)); ok('상대 연결 끊김 알림');
  run(120); assert.strictEqual(m.timeLeft, tBefore); ok('끊긴 동안 경기 시간/물리 일시정지');
  const B2 = connect();
  const rj = await B2.send('room:rejoin', { cid: B.cid, code: r1.code });
  assert(rj.ok && rj.side === 1); assert(B2.got('match:start').length === 1);
  assert(A.got('opp:status').some((s) => s.connected === true)); ok('같은 clientId로 재접속 → 경기 정보 재전송 + 상대에 알림');
  run(60 * 3); assert(m.timeLeft < tBefore); ok('재접속 후 카운트다운 뒤 경기 재개');
  await B2.send('input', { mx: 0, my: 1, sp: false }); run(30);
  assert(Math.abs(m.teams[1].input.my - 1) < 1e-9); ok('재접속한 소켓의 입력이 정상 처리');

  // 5. 유예시간 초과 → 몰수승
  A.clear();
  B2.drop(); await sleep(350); game.sweep();
  const end = A.got('match:end').pop();
  assert(end && end.forfeit && end.winner === 0 && end.you === 0); ok('재접속 유예 초과 시 남은 플레이어 승리(몰수) 판정');

  // 6. 정상 종료 + 승패 표시 + 재경기
  const E1 = connect(), E2 = connect();
  const re = await E1.send('room:create', { cid: E1.cid, name: 'E1' });
  await E2.send('room:join', { cid: E2.cid, code: re.code, name: 'E2' });
  await E1.send('room:ready', { ready: true }); await E2.send('room:ready', { ready: true });
  run(60 * 70);
  const e1 = E1.got('match:end').pop(), e2 = E2.got('match:end').pop();
  assert(e1 && e2 && e1.you === 0 && e2.you === 1 && e1.winner === e2.winner); ok(`시간 종료 시 서버가 결과 확정 (점수 ${e1.score.join('-')}, winner=${e1.winner})`);
  await E1.send('room:ready', { ready: true }); await E2.send('room:ready', { ready: true });
  assert.strictEqual(E1.got('match:start').length, 2); ok('재경기(다시하기) 동작');
  // 7. 명시적 나가기 → 상대에 알림 + 몰수승
  run(60 * 5);
  E1.clear(); E2.clear();
  await E2.send('room:leave');
  assert(E1.got('opp:left').length === 1); assert(E1.got('match:end').pop().forfeit); ok('방을 나가면 상대에게 알림 + 경기 중이면 몰수승');

  // 8. 연습 경기
  const P = connect();
  const pr = await P.send('room:practice', { cid: P.cid, name: 'Solo' });
  assert(pr.ok); run(60 * 5);
  assert(P.got('snap').length > 100); ok('CPU 연습 경기 시작/진행');
  P.drop(); assert(![...game.rooms.keys()].includes(pr.code)); ok('연습 경기는 연결 종료 시 방 정리');

  // 9. REST: 뽑기 API
  const p1 = api.handlePull({ n: 10 }, '1.1.1.1');
  assert(p1.status === 200 && p1.body.results.length === 10 && I.decode(p1.body.token).pulls === 10); ok('뽑기 API: 10연차 + 서명 토큰 발급');
  let limited = false; for (let i = 0; i < 40; i++) if (api.handlePull({ n: 1 }, '2.2.2.2').status === 429) limited = true;
  assert(limited); ok('뽑기 API 호출 속도 제한');
  const st = game.stats(); console.log('  stats', st);
  console.log(`\n통과: ${passed}개 테스트`);
  game.stop(); process.exit(0);
})().catch((e) => { console.error('\n✗ 실패:', e); process.exit(1); });
