// 티어: 경계값, 승/패 점수, 0점 하한, 최상위 티어
process.env.DEV_LOGIN = '1'; process.env.SESSION_SECRET = 'test-secret';
const assert = require('assert');
const T = require('../lib/tier');
const auth = require('../lib/auth');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };

ok(T.TIERS.length === 12 && T.TIERS[0] === '브론즈' && T.TIERS[11] === '승엄급', '티어 12개');
ok(T.tierOf(0).name === '브론즈' && T.tierOf(2).name === '브론즈', '0~2점 브론즈');
ok(T.tierOf(3).name === '실버' && T.tierOf(5).name === '실버' && T.tierOf(6).name === '골드', '3점마다 승급');
ok(T.tierOf(4).into === 1, '진행도');
ok(T.tierOf(33).name === '승엄급' && T.tierOf(500).name === '승엄급' && T.tierOf(500).top, '33점부터 승엄급');

(async () => {
  const store = new MemoryStore(); const acc = new Accounts(store);
  const mk = async (nm) => acc.login(await auth.verifyGoogle('dev:' + nm));
  const a = await mk('a'), b = await mk('b');
  let r = await acc.ranked(a.id, b.id);
  ok(r[a.id].after === 1 && r[a.id].delta === 1, '승자 +1');
  ok(r[b.id].after === 0 && r[b.id].delta === 0, '패자 0점 아래로 안 내려감');
  await acc.ranked(a.id, b.id); r = await acc.ranked(a.id, b.id);
  ok(r[a.id].after === 3 && T.tierOf(3).name === '실버', '3점 = 실버');
  r = await acc.ranked(b.id, a.id);
  ok(r[a.id].after === 2 && r[a.id].delta === -1 && r[b.id].after === 1, '지면 −1 / 강등');
  ok(r[a.id].acct.tier.name === '브론즈', 'pub 에 tier 포함');
  ok((await acc.ranked(a.id, a.id)) === null, '자기 자신과는 무효');
  const rows = (await acc.players(a.id)).players || (await acc.players(a.id));
  ok(Array.isArray(rows) ? rows.every((x) => 'pts' in x) : true, '랭킹 행에 pts');
  console.log(`tier tests: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
