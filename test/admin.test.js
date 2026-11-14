process.env.START_BAL = '0'; // 테스트는 0원 시작을 가정 (실제 기본값은 10,000원)
'use strict';
// 랭킹/플레이어 목록 + 관리자(돈 관리·계정 삭제)
process.env.SESSION_SECRET = 't'; process.env.DEV_LOGIN = '1'; process.env.ADMIN_ID = 'u-boss';
const assert = require('assert');
const auth = require('../lib/auth');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
const api = require('../lib/api');
let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };
(async () => {
  const accounts = new Accounts(new MemoryStore());
  const reg = async (name, bal = 0) => { const r = await accounts.register(name, 'secret1'); if (bal) await accounts.reward(r.acct.id, bal); return r.acct.id; };
  const boss = await reg('boss', 100), a = await reg('alice', 5000), b = await reg('bob', 9000), c = await reg('cara', 300);
  // 목록
  const pl = await accounts.players(a);
  assert.deepStrictEqual(pl.players.map((p) => p.nick), ['bob', 'alice', 'cara', 'boss']); assert.strictEqual(pl.players[0].bal, 9000); ok('돈 많은 순으로 정렬, 1위 = bob');
  assert(pl.players.every((p) => p.id === undefined) && pl.admin === false && pl.players.find((p) => p.me).nick === 'alice'); ok('일반 계정에는 아이디 등 내부 정보 없이 닉네임/돈만 보임');
  const pa = await accounts.players(boss); assert(pa.admin && pa.players.every((p) => p.id)); ok('관리자에게는 관리용 아이디가 함께 보임');
  assert.strictEqual((await accounts.get(boss)).admin, true); assert.strictEqual((await accounts.get(a)).admin, false); ok('관리자 표시는 관리자 계정에만');
  // 돈 관리
  assert.strictEqual((await accounts.adminMoney(a, c, 'set', 999999)).error, 'forbidden'); assert.strictEqual((await accounts.get(c)).bal, 300); ok('일반 계정은 돈을 바꿀 수 없다');
  assert((await accounts.adminMoney(boss, c, 'set', 7000)).ok); assert.strictEqual((await accounts.get(c)).bal, 7000);
  assert.strictEqual((await accounts.adminMoney(boss, c, 'add', 500)).bal, 7500); assert.strictEqual((await accounts.adminMoney(boss, c, 'add', -1000)).bal, 6500); ok('설정 / 더하기 / 빼기');
  assert.strictEqual((await accounts.adminMoney(boss, c, 'add', -999999)).bal, 0); ok('0원 아래로는 내려가지 않음');
  assert.strictEqual((await accounts.adminMoney(boss, c, 'set', 'abc')).error, 'bad_amount'); assert.strictEqual((await accounts.adminMoney(boss, 'u-nobody', 'set', 1)).error, 'no_account'); ok('잘못된 금액/없는 계정 거절');
  // 삭제
  assert.strictEqual((await accounts.adminDelete(a, c)).error, 'forbidden'); assert(await accounts.get(c)); ok('일반 계정은 삭제 불가');
  assert.strictEqual((await accounts.adminDelete(boss, boss)).error, 'self'); ok('관리자 본인 계정은 삭제 불가');
  await accounts.escrow('R1', [a, b], 1000); assert.strictEqual((await accounts.adminDelete(boss, a)).error, 'locked'); await accounts.settle('R1', [a, b], null); ok('내기 진행 중인 계정은 삭제 불가');
  assert((await accounts.adminDelete(boss, c)).ok); assert.strictEqual(await accounts.get(c), null); assert(!(await accounts.players(boss)).players.some((p) => p.nick === 'cara'));
  assert.strictEqual((await accounts.signin('cara', 'secret1')).error, 'bad_login'); ok('삭제된 계정은 목록에서 사라지고 로그인도 불가');
  // API 계층: 권한/세션
  const H = api.create({ accounts, auth }); const call = async (h, uid, body) => { let out; await h({ headers: { authorization: 'Bearer ' + auth.signSession(uid) }, body, ip: '9.9.9.' + Math.random() }, { status: (s) => ({ json: (o) => { out = { s, o }; } }), json: () => {} }); return out; };
  assert.strictEqual((await call(H.adminMoney, a, { target: b, mode: 'set', amount: 1 })).s, 403); assert.strictEqual((await call(H.adminDelete, a, { target: b })).s, 403); ok('API: 일반 계정 요청은 403');
  assert.strictEqual((await call(H.adminMoney, boss, { target: b, mode: 'add', amount: 1000 })).o.bal, 10000); ok('API: 관리자 요청은 성공');
  assert.strictEqual((await call(H.players, a)).s, 200); ok('API: 플레이어 목록은 로그인한 모두에게');
  console.log('\n랭킹/관리자 통과: ' + n + '개');
})().catch((e) => { console.error(e); process.exit(1); });
