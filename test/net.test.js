'use strict';
// Socket.IO 없이 실행 가능한 서버 로직 통합 테스트 (목 소켓 + 메모리 저장소, 계정/내기 포함)
process.env.MATCH_SECONDS = '60';
process.env.RECONNECT_GRACE_MS = '300';
process.env.SESSION_SECRET = 'test-secret';
process.env.DEV_LOGIN = '1';
const assert = require('assert');
const K = require('../lib/const');
const C = require('../lib/catalog');
const auth = require('../lib/auth');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
const apiMod = require('../lib/api');
const net = require('../lib/net');

const store = new MemoryStore();
const accounts = new Accounts(store);
const handlersOnConn = []; const mw = [];
const io = { use: (fn) => mw.push(fn), on: (ev, fn) => { if (ev === 'connection') handlersOnConn.push(fn); } };
let seq = 0;
async function mkUser(name, bal = 0, inv = null) {
  const prof = await auth.verifyGoogle('dev:' + name);
  const a = await accounts.login(prof);
  if (bal) await accounts.reward(a.id, bal);
  if (inv) await store.txn([a.id], (m) => { Object.assign(m[a.id].inv, inv); });
  return { id: a.id, token: auth.signSession(a.id), name };
}
async function connect(user) {
  const h = {}; const inbox = [];
  const sock = {
    id: 's' + (++seq), data: {}, handshake: { auth: { token: user.token } }, on: (ev, fn) => { h[ev] = fn; },
    emit: (ev, d) => inbox.push([ev, d]), leave() {}, disconnect() { this.dead = true; },
    volatile: { emit: (ev, d) => inbox.push([ev, d]) },
  };
  for (const fn of mw) await new Promise((res, rej) => fn(sock, (e) => (e ? rej(e) : res())));
  handlersOnConn.forEach((fn) => fn(sock));
  return {
    sock, inbox, user,
    send: (ev, d) => new Promise((res) => { if (!h[ev]) return res(undefined); Promise.resolve(h[ev](d, res)).then(() => res()); }),
    drop: () => { h.disconnect && h.disconnect(); },
    got: (ev) => inbox.filter((x) => x[0] === ev).map((x) => x[1]),
    clear: () => { inbox.length = 0; },
  };
}
const game = net.attach(io, { accounts, auth, autoloop: false });
const run = (n) => { for (let i = 0; i < n; i++) game.step(); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const flush = () => sleep(20);
let passed = 0;
const ok = (name) => { passed++; console.log('  ✓', name); };
const bal = async (u) => (await accounts.get(u.id)).bal;

(async () => {
  // 0. 인증
  await assert.rejects(connect({ token: 'bogus' }), /unauthorized/); ok('로그인 세션이 없거나 위조되면 소켓 연결 거절');
  const bad = auth.signSession('g-nobody'); await assert.rejects(connect({ token: bad }), /unauthorized/); ok('존재하지 않는 계정의 세션 거절');
  assert.strictEqual(auth.verifySession(auth.signSession('x').replace(/.$/, 'A') + 'z'), null); ok('세션 서명 변조 불가');
  assert.strictEqual(await auth.verifyGoogle('garbage'), null); ok('잘못된 구글 토큰 거절');

  const myth = C.CATALOG.find((p) => p.rarity === 'myth' && p.pos === 'FW').id;
  const uA = await mkUser('Alice', 20000), uB = await mkUser('Bob', 20000, { [myth]: 1 }), uX = await mkUser('Eve');
  const A = await connect(uA), B = await connect(uB), X = await connect(uX);
  const lineA = ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'S_FW2'];
  const cheat = lineA.slice(); cheat[4] = myth;

  // 1. 방 생성/입장
  const r1 = await A.send('room:create', { lineup: cheat });
  assert(r1.ok && /^[A-Z2-9]{6}$/.test(r1.code)); ok('방 코드 6자리 생성: ' + r1.code);
  assert.strictEqual(A.got('room:state').pop().players[0].team[4].id, 'S_FW1'); ok('미보유 선수 편성 시도 → 서버가 기본 선수로 교체');
  assert.strictEqual((await B.send('room:join', { code: 'zzzzzz' })).err, 'not_found'); ok('없는 방 코드 거절');
  assert.strictEqual((await B.send('room:join', { code: 'abc' })).err, 'bad_code'); ok('형식이 틀린 코드 거절');
  const r2 = await B.send('room:join', { code: r1.code.toLowerCase(), lineup: ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', myth, 'S_FW2'] });
  assert(r2.ok && r2.side === 1); ok('친구가 소문자 코드로 입장');
  assert.strictEqual(B.got('room:state').pop().players[1].team[4].id, myth); ok('서버 DB에 보유한 선수는 편성 허용');
  assert.strictEqual((await X.send('room:join', { code: r1.code })).err, 'room_full'); ok('3번째 입장 거절');

  // 2. 내기 설정
  assert.strictEqual((await B.send('room:stake', { stake: 1000 })).err, 'host_only'); ok('내기 금액은 방장만 변경');
  assert.strictEqual((await A.send('room:stake', { stake: 777 })).err, 'invalid'); ok('허용되지 않은 판돈 거절');
  assert.strictEqual((await A.send('room:stake', { stake: 5000 })).ok, true);
  assert.strictEqual(B.got('room:state').pop().stake, 5000); ok('방장이 판돈 5,000원 설정 → 상대에게도 표시');

  // 3. 준비 → 에스크로 → 경기
  await A.send('room:ready', { ready: true }); assert.strictEqual(A.got('match:start').length, 0);
  await B.send('room:ready', { ready: true });
  assert(A.got('match:start').length === 1 && B.got('match:start').length === 1); ok('양쪽 준비 시 경기 시작');
  assert.strictEqual(await bal(uA), 15000); assert.strictEqual(await bal(uB), 15000); ok('시작 시 두 사람 판돈 5,000원씩 잠김 (20,000 → 15,000)');
  assert.strictEqual(A.got('match:start')[0].stake, 5000);
  const room = [...game.rooms.values()][0];
  run(60 * 4); assert.strictEqual(room.match.phase, 'play');
  assert(A.got('snap').length > 50 && B.got('snap').length > 50); ok('스냅샷 실시간 전송');
  await A.send('input', { mx: 1, my: 0, sp: true }); run(60);
  const ctrl0 = room.match.players[room.match.teams[0].ctrl];
  assert(Math.abs(B.got('snap').pop().p[ctrl0.i][0] - ctrl0.x) < 40); ok('A의 입력이 서버에서 처리되고 B에 동기화');
  const sc0 = room.match.score.slice();
  await A.send('score', { s: [9, 9] }); await A.send('act', { t: 'goal', p: 999 }); await A.send('input', { mx: 1e9, my: NaN, sp: 1 });
  run(10); assert.deepStrictEqual(room.match.score, sc0); ok('클라이언트가 점수 조작 불가');
  await X.send('input', { mx: 1, my: 1 }); ok('방 밖 소켓의 입력 무시');

  // 4. 골 판정
  const m = room.match;
  A.clear(); Object.assign(m.ball, { x: K.W - 40, y: K.H / 2, vx: 500, vy: 0 });
  for (const p of m.players) { p.x = 300; p.y = 100; }
  run(30);
  assert.strictEqual(A.got('ev').flat().filter((e) => e.type === 'goal').length, 1); assert.deepStrictEqual(m.score, [sc0[0] + 1, sc0[1]]); ok('골 판정 → 팀0 +1');

  // 5. 끊김/재접속 (경기 중 내기 유지)
  const tBefore = m.timeLeft; B.clear(); A.clear(); B.drop();
  assert(A.got('opp:status').some((s) => s.connected === false)); run(120); assert.strictEqual(m.timeLeft, tBefore); ok('끊긴 동안 일시정지');
  const B2 = await connect(uB);
  const rj = await B2.send('room:rejoin', { code: r1.code });
  assert(rj.ok && rj.side === 1 && B2.got('match:start').length === 1); ok('같은 계정으로 재접속 → 경기 복귀');
  assert.strictEqual(await bal(uB), 15000); ok('재접속해도 판돈은 이중 차감되지 않음');
  run(60 * 12); assert(m.timeLeft < tBefore); ok("재접속 후 경기 재개");

  // 6. 끊김 유예 초과 → 몰수승 + 판돈 전액 승자에게
  A.clear(); B2.drop(); await sleep(350); await game.sweep(); await flush();
  const end = A.got('match:end').pop();
  assert(end && end.forfeit && end.winner === 0 && end.pay === 5000 && end.stake === 5000); ok('유예 초과 시 남은 사람 승리 + 내기 정산 통지');
  assert.strictEqual(await bal(uA), 25000); assert.strictEqual(await bal(uB), 15000); ok('승자 +10,000(판돈 합계) → A 25,000 / B 15,000');
  assert.strictEqual((await accounts.raw(uA.id)).locked, null); ok('정산 후 잠금 해제');
  assert(A.got('account').pop().bal === 25000); ok('승자에게 새 잔액 실시간 전송');

  // 7. 정상 종료 정산 (무승부면 환급)
  const uC = await mkUser('Cat', 3000), uD = await mkUser('Dog', 3000);
  const C1 = await connect(uC), D1 = await connect(uD);
  const rc = await C1.send('room:create', {}); await D1.send('room:join', { code: rc.code });
  assert.strictEqual((await C1.send('room:stake', { stake: 5000 })).err, 'not_enough'); ok('잔액보다 큰 판돈은 설정 불가');
  await C1.send('room:stake', { stake: 2000 });
  await C1.send('room:ready', { ready: true }); await D1.send('room:ready', { ready: true });
  assert.strictEqual(await bal(uC), 1000); assert.strictEqual(await bal(uD), 1000);
  const rm = game.rooms.get(rc.code); run(60 * 4); rm.match.score = [1, 1]; rm.match.timeLeft = 0.01; run(5); await flush();
  assert.strictEqual(C1.got('match:end').pop().winner, -1); assert.strictEqual(await bal(uC), 3000); assert.strictEqual(await bal(uD), 3000); ok('무승부 → 판돈 각자 환급 (3,000 / 3,000)');
  await C1.send('room:ready', { ready: true }); await D1.send('room:ready', { ready: true });
  assert.strictEqual(C1.got('match:start').length, 2); assert.strictEqual(await bal(uC), 1000); ok('재경기 시 판돈 다시 잠김');
  const rm2 = game.rooms.get(rc.code); run(60 * 4); rm2.match.score = [0, 2]; rm2.match.timeLeft = 0.01; run(5); await flush();
  assert.strictEqual(await bal(uD), 5000); assert.strictEqual(await bal(uC), 1000); ok('패자 −2,000 / 승자 +2,000 (D 5,000 / C 1,000)');
  assert.strictEqual(D1.got('match:end').pop().pay, 2000);

  // 8. 시작 순간 잔액 부족 → 시작 불가, 아무것도 잠기지 않음
  const uE = await mkUser('Eli', 2000), uF = await mkUser('Fay', 2000);
  const E1 = await connect(uE), F1 = await connect(uF);
  const re = await E1.send('room:create', {}); await F1.send('room:join', { code: re.code });
  await E1.send('room:stake', { stake: 2000 });
  await store.txn([uF.id], (m) => { m[uF.id].bal = 500; }); // 방에서 대기하는 동안 잔액이 줄어든 상황
  await E1.send('room:ready', { ready: true }); await F1.send('room:ready', { ready: true }); await flush();
  assert.strictEqual(E1.got('match:start').length, 0); assert(E1.got('room:error').pop().err === 'not_enough'); ok('잔액 부족한 사람이 있으면 경기 시작 거절 + 양쪽에 안내');
  assert.strictEqual(await bal(uE), 2000); assert.strictEqual(await bal(uF), 500); ok('시작 실패 시 아무 돈도 잠기지 않음');
  assert.strictEqual(game.rooms.get(re.code).players.some((p) => p.ready), false); ok('실패 후 준비 상태 초기화');

  // 9. 경기 중 방 나가기 = 기권패 (판돈 상대에게)
  await store.txn([uF.id], (m) => { m[uF.id].bal = 2000; });
  await E1.send('room:ready', { ready: true }); await F1.send('room:ready', { ready: true }); run(60 * 5);
  assert.strictEqual(await bal(uE), 0);
  E1.clear(); F1.clear(); await F1.send('room:leave'); await flush();
  assert(E1.got('opp:left').length === 1 && E1.got('match:end').pop().forfeit); assert.strictEqual(await bal(uE), 4000); assert.strictEqual(await bal(uF), 0); ok('경기 중 나가면 기권패 → 판돈 상대 지급 (E 4,000 / F 0)');

  // 10. 서버 재시작 시 잠긴 판돈 환급
  await store.txn([uE.id], (m) => { m[uE.id].bal -= 1500; m[uE.id].locked = { code: 'DEAD11', stake: 1500 }; });
  assert.strictEqual(await accounts.refundAllLocked(), 1); assert.strictEqual(await bal(uE), 4000); ok('서버 재시작 때 남은 에스크로 환급');
  assert.strictEqual(await accounts.refundAllLocked(), 0);
  // 정산은 한 번만
  const dbl = await accounts.settle('NOPE', [uE.id, uF.id], uE.id); assert.deepStrictEqual(dbl, {}); ok('이미 정산된/없는 내기는 중복 지급되지 않음');
  // 동시에 두 방에서 내기 불가
  const uG = await mkUser('Gus', 5000), uH = await mkUser('Hal', 5000), uI = await mkUser('Ian', 5000);
  assert((await accounts.escrow('R1', [uG.id, uH.id], 1000)).ok);
  assert.strictEqual((await accounts.escrow('R2', [uG.id, uI.id], 1000)).err, 'locked'); assert.strictEqual(await bal(uI), 5000); ok('이미 내기 중인 계정은 다른 내기에 참여 불가 (이중 베팅 방지)');

  // 11. 연습 경기 + CPU 승리 보상
  const P = await connect(uX);
  const pr = await P.send('room:practice', { lineup: lineA }); assert(pr.ok); await flush(); run(60 * 5);
  assert(P.got('snap').length > 100); ok('CPU 연습 경기 진행');
  { const m = game.rooms.get(pr.code).match; const ids = (side) => m.players.filter((p) => p.side === side).map((p) => p.id);
    assert.deepStrictEqual(ids(1), ids(0)); assert.deepStrictEqual(ids(0), lineA); ok('CPU는 내 구단과 똑같은 선수로 싸운다');
    const gk0 = m.players[0], fw0 = m.players[4]; assert.strictEqual(gk0.pos, 'GK');
    const base = (p) => 115 + p.st.spd * 0.95; assert(Math.abs(gk0.maxSpd - base(gk0) * 0.7) < 1e-6 && Math.abs(fw0.maxSpd - base(fw0)) < 1e-6); ok('골키퍼 이동 속도 30% 감소'); }
  const room3 = game.rooms.get(pr.code); room3.match.score = [2, 0]; room3.match.timeLeft = 0.01; P.clear(); run(5); await flush();
  const endP = P.got('match:end').pop();
  assert(endP.winner === 0 && endP.reward.amount === 3000 && endP.reward.bal === 3000); assert.strictEqual(await bal(uX), 3000); ok('CPU를 이기면 서버 DB에 +3,000원 (0 → 3,000)');
  P.drop(); assert(!game.rooms.has(pr.code)); ok('연습 경기는 연결 종료 시 방 정리');
  const Q = await connect(uX); const qr = await Q.send('room:practice', {}); await flush(); run(60 * 5);
  const room4 = game.rooms.get(qr.code); room4.match.score = [0, 1]; room4.match.timeLeft = 0.01; Q.clear(); run(5); await flush();
  assert(!Q.got('match:end').pop().reward); assert.strictEqual(await bal(uX), 3000); ok('CPU에게 지면 보상 없음');

  // 12. REST API (뽑기)
  const A_ = apiMod.create({ accounts, auth });
  const call = async (h, { token, body, ip = '9.9.9.9' } = {}) => { let out; await h({ headers: token ? { authorization: 'Bearer ' + token } : {}, body, ip }, { status: (c) => ({ json: (b) => { out = { status: c, body: b }; } }) }); return out; };
  assert.strictEqual((await call(A_.pull, { body: { n: 1 } })).status, 401); ok('로그인 없이 뽑기 불가(401)');
  const uJ = await mkUser('Joy', 25000);
  const p1 = await call(A_.pull, { token: uJ.token, body: { n: 10 } });
  assert(p1.status === 200 && p1.body.results.length === 10 && p1.body.acct.bal === 15000 && p1.body.acct.pulls === 10); ok('10연차 = 10,000원 차감 (25,000 → 15,000)');
  assert.strictEqual((await call(A_.pull, { token: uJ.token, body: { n: 1 } })).body.acct.bal, 14000); ok('1회 뽑기 = 1,000원 차감');
  assert.strictEqual((await call(A_.pull, { token: uI.token + 'x', body: { n: 1 } })).status, 401); ok('위조 세션으로 뽑기 불가');
  const poor = await mkUser('Poor', 0); assert.strictEqual((await call(A_.pull, { token: poor.token, body: { n: 1 }, ip: '8.8.8.8' })).status, 402); ok('잔액 0원이면 뽑기 거절(402)');
  const lg = await call(A_.login, { body: { credential: 'dev:Zed' } }); assert(lg.status === 200 && lg.body.session && lg.body.account.bal === 0); ok('로그인 API: 신규 계정 생성 (잔액 0원)');
  const lg2 = await call(A_.login, { body: { credential: 'dev:Zed' } }); assert.strictEqual(lg2.body.account.id, lg.body.account.id); ok('같은 구글 계정으로 다시 로그인하면 같은 계정');
  assert.strictEqual((await call(A_.login, { body: { credential: 'nope' } })).status, 401); ok('잘못된 구글 토큰으로 로그인 불가(401)');
  const mine = await call(A_.me, { token: lg.body.session }); assert.strictEqual(mine.body.account.id, lg.body.account.id);
  const before = (await call(A_.me, { token: lg.body.session })).body.account.nick; assert.strictEqual((await call(A_.nick, { token: lg.body.session, body: { nick: '해커' } })).body.account.nick, before); ok('닉네임은 변경 불가');
  const rg = await call(A_.register, { body: { username: 'Kim_01', password: 'secret1' }, ip: '5.5.5.5' }); assert(rg.status === 200 && rg.body.account.id === 'u-kim_01' && rg.body.account.bal === 0); ok('아이디/비밀번호 회원가입 (잔액 0원)');
  assert(!JSON.stringify(rg.body).includes('secret1') && !JSON.stringify(rg.body).includes('"pw"')); assert(!JSON.stringify(await accounts.get('u-kim_01')).includes('hash')); ok('응답에 비밀번호/해시가 포함되지 않음');
  const raw = await accounts.raw('u-kim_01'); assert(raw.pw.hash && !JSON.stringify(raw).includes('secret1')); ok('저장소에는 비밀번호 원문 없이 scrypt 해시만 저장');
  assert.strictEqual((await call(A_.register, { body: { username: 'kim_01', password: 'other12' }, ip: '5.5.5.5' })).status, 409); ok('중복 아이디 가입 거절');
  assert.strictEqual((await call(A_.register, { body: { username: 'a', password: 'secret1' }, ip: '5.5.5.5' })).status, 400); assert.strictEqual((await call(A_.register, { body: { username: '김 철수!', password: 'secret1' }, ip: '5.5.5.5' })).status, 200); assert.strictEqual((await call(A_.signin, { body: { username: '김 철수!', password: 'secret1' }, ip: '5.5.5.5' })).status, 200); ok('한글·공백·특수문자 아이디도 가입/로그인 가능'); assert.strictEqual((await call(A_.register, { body: { username: 'abcd', password: '123' }, ip: '5.5.5.5' })).status, 400); ok('너무 짧은 아이디/비밀번호 거절');
  const si = await call(A_.signin, { body: { username: 'KIM_01', password: 'secret1' }, ip: '6.6.6.6' }); assert(si.status === 200 && si.body.account.id === 'u-kim_01' && auth.verifySession(si.body.session)); ok('올바른 비밀번호로 로그인 (아이디 대소문자 무시)');
  assert.strictEqual((await call(A_.signin, { body: { username: 'kim_01', password: 'wrong!!' }, ip: '6.6.6.6' })).status, 401); assert.strictEqual((await call(A_.signin, { body: { username: 'nobody', password: 'secret1' }, ip: '6.6.6.6' })).status, 401); ok('틀린 비밀번호/없는 아이디 로그인 거절');
  for (let i = 0; i < 5; i++) await call(A_.signin, { body: { username: 'kim_01', password: 'bad' + i + 'xx' }, ip: '7.7.7.7' });
  assert.strictEqual((await call(A_.signin, { body: { username: 'kim_01', password: 'secret1' }, ip: '7.7.7.7' })).status, 429); ok('연속 5회 실패 시 5분 잠금 (맞는 비밀번호도 거절)');
  // 새 캐릭터 / 초월 / 모든 포지션 / 드리블 / 자동 조종
  const CC = require('../lib/catalog');
  assert.deepStrictEqual(['김승현', '어느 2학년 형', '유동원'], ['M01', 'M02', 'M03'].map((i) => CC.BY_ID[i].name)); assert.deepStrictEqual(['박지훈', '최성욱'], ['M04', 'M05'].map((i) => CC.BY_ID[i].name)); assert.deepStrictEqual(['김지용', '김도윤', '모똥원'], ['L02', 'L03', 'L04'].map((i) => CC.BY_ID[i].name)); assert.notStrictEqual(CC.BY_ID.L01.name, '유동원'); ok('유동원은 신화(능력치 +7), 전설은 3명');
  assert.deepStrictEqual(CC.RARITIES.map((r) => CC.CATALOG.filter((p) => p.rarity === r.key && !p.starter).length), [24, 18, 14, 10, 6, 1]); ok('등급별 캐릭터 수는 그대로, 초월 1명 추가');
  assert.deepStrictEqual(CC.BY_ID.M01.stats, { gk: 100, sta: 90, def: 70, pas: 70, sht: 70, spd: 80, dri: 67 }); assert(CC.CATALOG.every((p) => typeof p.stats.dri === 'number')); ok('능력치 입력값 일치 + 모든 캐릭터에 드리블 능력치');
  const pubc = apiMod.catalogPayload().players.find((p) => p.id === 'T01'); assert(pubc.name === '?' && pubc.stats.def === 0); assert(!JSON.stringify(apiMod.catalogPayload()).includes('각성의 이지안')); ok('초월 캐릭터는 공개 카탈로그에서 이름/능력치가 가려짐(?)');
  const uT = await mkUser('Tran', 0, { T01: 1 }); const aT = await accounts.get(uT.id); assert.strictEqual(aT.secret.T01.name, '각성의 이지안'); assert.strictEqual((await accounts.get((await mkUser('NoTran')).id)).secret.T01, undefined); ok('초월 캐릭터를 가진 사람에게만 실제 정보 전달');
  assert.deepStrictEqual(CC.validateLineup(['M01', 'M02', 'L01', 'L02', 'L03', 'L04'], { M01: 1, M02: 1, L01: 1, L02: 1, L03: 1, L04: 1 }), ['M01', 'M02', 'L01', 'L02', 'L03', 'L04']); ok('모든 캐릭터를 어느 포지션(골키퍼 포함)에도 편성 가능');
  const { Match } = require('../lib/engine');
  const mm = new Match({ lineups: [['M01', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'S_FW2'], CC.botLineup()], invs: [{ M01: 1 }, {}], bots: [false, true], seconds: 60 });
  assert.strictEqual(mm.players[0].pos, 'GK'); const mm2 = new Match({ lineups: [['S_GK', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'M01'], CC.botLineup()], invs: [{ M01: 1 }, {}], bots: [false, true], seconds: 60 }); assert.strictEqual(mm2.players[5].pos, 'FW'); ok('경기에서는 배치한 슬롯이 포지션이 됨');
  // 자동 조종
  const am = new Match({ lineups: [CC.defaultLineup(), CC.botLineup()], invs: [{}, {}], bots: [false, true], seconds: 60 });
  for (let i = 0; i < 60 * 4; i++) am.update(1 / 60);
  const mate = am.players[2]; am.teams[0].ctrl = 4; Object.assign(am.ball, { x: mate.x + 5, y: mate.y, vx: 0, vy: 0, owner: -1 }); for (const q of am.players) if (q !== mate) { q.x = 20 + q.i * 3; q.y = 20; }
  am.update(1 / 60); assert.strictEqual(am.teams[0].ctrl, 2); ok('공을 잡은 선수를 자동으로 조종');
  // 드리블 vs 수비
  const tackle = (dri, def) => { let w = 0; for (let n = 0; n < 400; n++) {
    const lm = CC.defaultLineup(); const m2 = new Match({ lineups: [lm, lm], invs: [{}, {}], bots: [true, true], seconds: 60, seed: n + 1 });
    for (let i = 0; i < 60 * 4; i++) m2.update(1 / 60);
    const car = m2.players[4], opp = m2.players[6 + 4]; car.st.dri = dri; opp.st.def = def; car.x = 500; car.y = 300; opp.x = 520; opp.y = 300; car.vx = car.vy = opp.vx = opp.vy = 0; opp.tackleCd = 0;
    for (const q of m2.players) if (q !== car && q !== opp) { q.x = 50; q.y = 50 + q.i * 10; q.kickCd = 5; }
    Object.assign(m2.ball, { x: 515, y: 300, vx: 0, vy: 0, owner: car.i }); m2.playerBall(1 / 60); if (m2.ball.owner === opp.i) w++; } return w / 400; };
  const lowDri = tackle(30, 80), highDri = tackle(95, 80), highDef = tackle(60, 95), lowDef = tackle(60, 30);
  assert(lowDri > highDri + 0.15 && highDef > lowDef + 0.15 && highDri < 0.5); ok(`드리블↑ 뺏기 어려움(${lowDri.toFixed(2)}→${highDri.toFixed(2)}) · 수비↑ 잘 뺏음(${lowDef.toFixed(2)}→${highDef.toFixed(2)}) · 100% 아님`);
  const uS = await mkUser('skmoon', 0); assert.strictEqual((await accounts.grantAllByNick('skmoon')).ok, true);
  const aS = await accounts.get(uS.id); assert(CC.CATALOG.filter((p) => !p.starter).every((p) => aS.inv[p.id] === 1)); assert.strictEqual((await accounts.grantAllByNick('skmoon')).already, true); assert.strictEqual((await accounts.grantAllByNick('nobody-here')).found, 0); ok('닉네임 skmoon 계정에 모든 캐릭터 1장씩 지급(1회성, 중복·없는 닉네임 안전)');
  const rk = await call(A_.register, { body: { username: '박 아이디', password: 'secret1' }, ip: '4.4.4.4' }); assert.strictEqual(rk.body.account.nick, '박 아이디'); assert.strictEqual((await call(A_.nick, { token: rk.body.session, body: { nick: 'x' } })).body.account.nick, '박 아이디'); ok('닉네임 = 로그인 아이디로 고정');
  const meanChk = CC.CATALOG.every((p) => p.ovr === Math.round(Object.values(p.stats).reduce((a, b) => a + b, 0) / 7)); assert(meanChk); ok('보관함 점수 = 7개 능력치 평균');
  assert.strictEqual(CC.BY_ID.C01.name, '왕정훈'); assert.strictEqual(CC.BY_ID.C01.rarity, 'common'); assert.strictEqual(CC.BY_ID.C01.pos, 'DF'); assert.deepStrictEqual(['박종모', '최범규'], ['H01', 'H02'].map((i) => CC.BY_ID[i].name)); assert(CC.BY_ID.H01.stats.dri >= 80 && CC.BY_ID.H02.stats.dri >= 80 && CC.BY_ID.H02.stats.sht > CC.BY_ID.H01.stats.sht); assert.deepStrictEqual(CC.RARITIES.map((r) => CC.CATALOG.filter((p) => p.rarity === r.key && !p.starter).length), [24, 18, 14, 10, 6, 1]); ok('왕정훈(일반·수비수), 박종모·최범규(영웅/에픽) 추가, 등급별 개수 유지');
  { const { Match } = require('../lib/engine'); const mm = new Match({ lineups: [lineA, lineA], invs: [{}, {}], bots: [false, true], seconds: 60 });
    for (let i = 0; i < 60 * 4; i++) mm.update(K.TICK); // 카운트다운 지나 경기 시작
    mm.setInput(0, 1, 0, false); for (let i = 0; i < 30; i++) mm.update(K.TICK);
    const me = mm.players[mm.teams[0].ctrl]; assert(me.sprinting); ok('조이스틱 끝까지 밀면 자동 질주(내 선수가 CPU보다 느리지 않음)');
    mm.setInput(0, 0.5, 0, false); for (let i = 0; i < 30; i++) mm.update(K.TICK); assert(!me.sprinting); ok('조금만 밀면 걷기(자동 질주 안 함)'); }
  let limited = false; for (let i = 0; i < 70; i++) if ((await call(A_.me, { token: uJ.token, ip: '2.2.2.2' })).status === 429) limited = true;
  assert(limited); ok('API 호출 속도 제한');
  console.log('  stats', game.stats());
  console.log(`\n통과: ${passed}개 테스트`);
  game.stop(); process.exit(0);
})().catch((e) => { console.error('\n✗ 실패:', e); process.exit(1); });
