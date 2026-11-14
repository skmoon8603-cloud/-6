process.env.START_BAL = '0'; // 테스트는 0원 시작을 가정 (실제 기본값은 10,000원)
'use strict';
// 일일 출석: 하루 1회, 주간 7일 보상표, 매주 월요일 00시(KST) 초기화
process.env.SESSION_SECRET = 't'; process.env.DEV_LOGIN = '1';
const assert = require('assert');
const K = require('../lib/const');
const auth = require('../lib/auth');
const { MemoryStore } = require('../lib/store');
const AC = require('../lib/accounts');
const { OneBounce, C } = require('../lib/onebounce');
let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };
const kst = (iso) => Date.parse(iso + '+09:00'); // 한국 시간 → epoch
(async () => {
  assert.deepStrictEqual(K.ATTEND, [1000, 2000, 3000, 4000, 5000, 5000, 6000]); ok('보상표 1000·2000·3000·4000·5000·5000·6000');
  const accounts = new AC.Accounts(new MemoryStore());
  const a = await accounts.login(await auth.verifyGoogle('dev:att')); const id = a.id;
  const bal = async () => (await accounts.get(id)).bal;
  // 2026-11-16(월) ~ 11-22(일) 한 주
  const days = ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22'];
  let total = 0;
  for (let i = 0; i < 7; i++) {
    AC.setClock(() => kst(days[i] + 'T09:00:00'));
    const r = await accounts.attend(id); assert.strictEqual(r.amount, K.ATTEND[i]); assert.strictEqual(r.day, i + 1); total += r.amount;
    if (i === 0) { assert.strictEqual((await accounts.attend(id)).error, 'already'); ok('같은 날 두 번 받을 수 없다'); AC.setClock(() => kst(days[i] + 'T23:59:00')); assert.strictEqual((await accounts.attend(id)).error, 'already'); ok('23:59 에도 같은 날'); }
  }
  assert.strictEqual(await bal(), total); assert.strictEqual(total, 26000); ok('7일 연속 출석 합계 26,000원');
  AC.setClock(() => kst('2026-11-22T23:59:59')); assert.strictEqual((await accounts.get(id)).att.next, 0); ok('일요일 밤까지는 이번 주 (다 받았으면 더 없음)');
  AC.setClock(() => kst('2026-11-23T00:00:01')); const st = (await accounts.get(id)).att; assert(!st.today && st.n === 0 && st.next === 1000); ok('월요일 00시(KST)에 초기화 → 다시 1일차 1,000원');
  assert.strictEqual((await accounts.attend(id)).amount, 1000); ok('새 주 첫 출석 +1,000원');
  // 빠진 날이 있어도 '이번 주 출석 횟수'로 계산 (화요일 첫 출석 → 1일차)
  const b = await accounts.login(await auth.verifyGoogle('dev:att2'));
  AC.setClock(() => kst('2026-11-24T10:00:00')); assert.strictEqual((await accounts.attend(b.id)).day, 1);
  AC.setClock(() => kst('2026-11-26T10:00:00')); const r2 = await accounts.attend(b.id); assert(r2.day === 2 && r2.amount === 2000); ok('날짜를 건너뛰어도 이번 주 출석 횟수대로 지급');
  AC.setClock(null);
  // 원 바운스 서브/히트박스
  assert(C.REACH_X >= 80 && C.REACH_Y >= 130); ok('히트박스 확대');
  for (let s = 0; s < 40; s++) {
    let x = s + 1; const rng = () => { x = (x * 1664525 + 1013904223) >>> 0; return x / 4294967296; };
    const g = new OneBounce({ rng, cpu: false });
    g.server = s % 2; g.phaseT = 0; g.update(1 / 60); g.ev.length = 0; // 서브 시작
    g.server = s % 2; g.startServe(); g.ev.length = 0;
    const sv = g.server; assert(g.ball.lastHit === sv && g.ball.recv === 1 - sv && g.ball.vy < 0, '서브는 받는 쪽으로 띄워짐');
    let landed = null; for (let i = 0; i < 400 && landed === null; i++) { g.update(1 / 120); const e = g.ev.find((q) => q.type === 'bounce'); if (e) landed = e.x; g.ev.length = 0; }
    assert(g.score[0] + g.score[1] === 0, '서브 실수 없음'); assert(sv === 0 ? landed > C.NET_X : landed < C.NET_X);
  }
  ok('서브는 항상 받는 사람 코트로 떠서 넘어오고 서브 실수 없음 (40회)');
  console.log('\n출석/서브 통과: ' + n + '개');
})().catch((e) => { console.error(e); process.exit(1); });
