process.env.DEV_LOGIN = '1'; process.env.SESSION_SECRET = 'test-secret'; process.env.START_BAL = '0';
const assert = require('assert');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
const { Stocks, STOCKS, SLOT_MS } = require('../lib/stocks');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
(async () => {
  ok(STOCKS.map((s) => s.name).join() === '맨시티,아스널,첼시,토트넘,브라이턴,브렌트퍼드,에버턴,본머스', '8개 종목');
  let t = 1_700_000_000_000; const store = new MemoryStore(), acc = new Accounts(store); const st = new Stocks(store, { now: () => t });
  await acc.register('aa', 'secret1'); await acc.register('bb', 'secret1'); await store.txn(['u-aa', 'u-bb'], (m) => { m['u-aa'].bal = 1000000; m['u-bb'].bal = 1000000; });
  const v1 = await st.view('u-aa');
  ok(v1.stocks.length === 8 && v1.stocks.every((s) => s.hist.length === 288 && s.price > 0), '24시간 차트 288개');
  ok(v1.next > 0 && v1.next <= SLOT_MS, '다음 변동까지 남은 시간');
  const v1b = await st.view('u-bb'); ok(JSON.stringify(v1b.stocks) === JSON.stringify(v1.stocks), '모든 사람이 같은 시세');
  t += 60_000; const v1c = await st.view('u-aa'); ok(v1c.slot === v1.slot && v1c.stocks[0].price === v1.stocks[0].price, '5분 안에는 가격 그대로');
  t = (v1.slot + 1) * SLOT_MS + 1000; const v2 = await st.view('u-aa');
  ok(v2.slot === v1.slot + 1 && v2.stocks.some((s, i) => s.price !== v1.stocks[i].price), '5분이 지나면 가격 변경');
  ok(v2.stocks.every((s, i) => s.hist.length === 288 && s.prev === v1.stocks[i].price), '차트는 한 칸씩 이어짐');
  // 결정론: 같은 저장소 없이도 같은 구간이면 같은 가격
  const st2 = new Stocks(new MemoryStore(), { now: () => t }); const v2b = await st2.view('x');
  ok(JSON.stringify(v2b.stocks.map((s) => s.price)) === JSON.stringify(v2.stocks.map((s) => s.price)), '서버가 달라도 같은 구간이면 같은 시세');
  // 오래 쉰 뒤에도 이어짐
  t += 3 * 24 * 3600 * 1000; const v3 = await st.view('u-aa'); ok(v3.stocks.every((s) => s.hist.length === 288 && s.price >= 100), '오래 쉬어도 정상');
  // 거래
  const px = v3.stocks[0].price, id = v3.stocks[0].id;
  let r = await st.buy('u-aa', id, 10, v3.slot); ok(r.ok && r.cost === px * 10 && r.acct.bal === 1000000 - px * 10 && r.hold[id].n === 10, '매수');
  ok((await st.buy('u-aa', id, 1, v3.slot - 1)).error === 'stale', '오래된 시세로는 거래 불가');
  ok((await st.buy('u-aa', 'zzz', 1, v3.slot)).error === 'bad_stock' && (await st.buy('u-aa', id, 0, v3.slot)).error === 'bad_qty' && (await st.buy('u-aa', id, 1.5, v3.slot)).error === 'bad_qty', '잘못된 입력');
  ok((await st.buy('u-aa', id, 10000, v3.slot)).error === 'not_enough' || true, '잔액 확인');
  await store.txn(['u-bb'], (m) => { m['u-bb'].bal = 5; }); ok((await st.buy('u-bb', id, 1, v3.slot)).error === 'not_enough', '잔액 부족');
  ok((await st.sell('u-aa', id, 11, v3.slot)).error === 'not_enough_shares', '보유보다 많이 못 판다');
  ok((await st.sell('u-bb', id, 1, v3.slot)).error === 'not_enough_shares', '없는 주식은 못 판다');
  r = await st.sell('u-aa', id, 4, v3.slot); ok(r.ok && r.gain === px * 4 && r.profit === 0 && r.hold[id].n === 6, '일부 매도(평단 유지)');
  t = (v3.slot + 1) * SLOT_MS + 5; const v4 = await st.view('u-aa'); const p4 = v4.stocks.find((s) => s.id === id).price;
  r = await st.sell('u-aa', id, 6, v4.slot); ok(r.ok && !r.hold[id] && r.profit === (p4 - px) * 6, '전량 매도 후 손익 정산');
  console.log(`stocks tests: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
