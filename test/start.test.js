// 신규 계정 시작 잔액 10,000원, 초월 확률 0.2%
process.env.DEV_LOGIN = '1'; process.env.SESSION_SECRET = 'test-secret'; delete process.env.START_BAL;
const assert = require('assert');
const C = require('../lib/catalog'); const K = require('../lib/const');
const { MemoryStore } = require('../lib/store'); const { Accounts } = require('../lib/accounts');
const auth = require('../lib/auth');
let n = 0; const ok = (c) => { assert(c); n++; };
(async () => {
  const a = new Accounts(new MemoryStore());
  ok(K.START_BAL === 10000);
  ok((await a.register('newbie', 'secret1')).acct.bal === 10000);
  ok((await a.login(await auth.verifyGoogle('dev:G1'))).bal === 10000);
  const tot = C.RARITIES.reduce((s, r) => s + r.rate, 0); ok(Math.abs(tot - 100) < 1e-9);
  ok(C.RARITY_BY_KEY.trans.rate === 0.2);
  let t = 0; const N = 1000000; for (let i = 0; i < N; i++) if (C.rollRarity(Math.random) === 'trans') t++;
  ok(t / N > 0.0015 && t / N < 0.0025);
  console.log(`start tests: ${n} passed (초월 ${(t / N * 100).toFixed(3)}%)`);
})().catch((e) => { console.error(e); process.exit(1); });
