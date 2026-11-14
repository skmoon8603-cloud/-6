'use strict';
const assert = require('assert');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
const { Market, QUICK } = require('../lib/market');
const chatNet = require('../lib/chat');
const C = require('../lib/catalog');
let n = 0; const ok = (name, f) => f().then(() => { n++; }).catch((e) => { console.error('실패:', name, e.message); process.exit(1); });

(async () => {
  const store = new MemoryStore(); const acc = new Accounts(store); const mk = new Market(store);
  await acc.register('alice', 'secret1'); await acc.register('bob', 'secret1');
  const A = 'u-alice', B = 'u-bob';
  const common = C.CATALOG.find((p) => p.rarity === 'common' && !p.starter && !p.hidden).id;
  const hero = C.CATALOG.find((p) => p.rarity === 'hero' && !p.hidden).id;
  const trans = C.CATALOG.find((p) => p.hidden);
  await store.txn([A, B], (m) => { m[A].inv = { [common]: 2, [hero]: 1 }; m[A].bal = 500; m[B].bal = 10000; if (trans) m[A].inv[trans.id] = 1; });

  await ok('없는 선수/숨김 선수 등록 불가', async () => {
    assert.strictEqual((await mk.list(A, 'nope', 1000)).error, 'not_sellable');
    if (trans) assert.strictEqual((await mk.list(A, trans.id, 1000)).error, 'not_sellable');
    assert.strictEqual((await mk.list(B, common, 1000)).error, 'not_owned');
  });
  await ok('가격 범위', async () => {
    assert.strictEqual((await mk.list(A, common, 10)).error, 'bad_price');
    assert.strictEqual((await mk.list(A, common, 10 ** 8)).error, 'bad_price');
    assert.strictEqual((await mk.list(A, common, 'abc')).error, 'bad_price');
  });
  let lid;
  await ok('등록하면 카드 1장이 빠진다', async () => {
    const r = await mk.list(A, common, 1000); assert.ok(r.ok); lid = r.listing.id;
    assert.strictEqual((await acc.raw(A)).inv[common], 1);
    const v = await mk.view(B); assert.strictEqual(v.list.length, 1); assert.strictEqual(v.list[0].mine, false);
    assert.strictEqual((await mk.view(A)).list[0].mine, true);
  });
  await ok('취소하면 카드가 돌아온다', async () => {
    const r = await mk.cancel(A, lid); assert.ok(r.ok);
    assert.strictEqual((await acc.raw(A)).inv[common], 2);
    assert.strictEqual((await mk.cancel(A, lid)).error, 'gone');
  });
  await ok('남이 내 매물을 취소 못한다', async () => {
    const r = await mk.list(A, common, 1000);
    assert.strictEqual((await mk.cancel(B, r.listing.id)).error, 'gone'); lid = r.listing.id;
  });
  await ok('본인 매물 구매 불가 / 잔액 부족', async () => {
    assert.strictEqual((await mk.buy(A, lid)).error, 'own');
    const h = await mk.list(A, hero, 50000);
    await store.txn([B], (m) => { m[B].bal = 100; });
    assert.strictEqual((await mk.buy(B, h.listing.id)).error, 'not_enough');
    await mk.cancel(A, h.listing.id);
    await store.txn([B], (m) => { m[B].bal = 10000; });
  });
  await ok('구매: 돈/카드/수수료 5%', async () => {
    const r = await mk.buy(B, lid); assert.ok(r.ok);
    assert.strictEqual(r.net, 950);
    const a = await acc.raw(A), b = await acc.raw(B);
    assert.strictEqual(a.bal, 500 + 950); assert.strictEqual(b.bal, 9000); assert.strictEqual(b.inv[common], 1);
    assert.strictEqual((await mk.view(B)).last[common].p, 1000);
  });
  await ok('이미 팔린 매물 재구매 불가 (동시 구매 한 명만)', async () => {
    const r = await mk.list(A, common, 500);
    await store.txn([B], (m) => { m[B].bal = 5000; });
    await acc.register('carl', 'secret1'); await store.txn(['u-carl'], (m) => { m['u-carl'].bal = 5000; });
    const [x, y] = await Promise.all([mk.buy(B, r.listing.id), mk.buy('u-carl', r.listing.id)]);
    assert.strictEqual([x, y].filter((q) => q.ok).length, 1);
  });
  await ok('돈 총합은 수수료만큼만 줄어든다', async () => {
    const s0 = (await acc.raw(A)).bal + (await acc.raw(B)).bal + (await acc.raw('u-carl')).bal;
    const r = await mk.list(A, hero, 2500); const f = Math.floor(2500 * 5 / 100);
    await mk.buy(B, r.listing.id);
    const s1 = (await acc.raw(A)).bal + (await acc.raw(B)).bal + (await acc.raw('u-carl')).bal;
    assert.strictEqual(s0 - s1, f);
  });
  await ok('최대 매물 수 제한', async () => {
    await store.txn([A], (m) => { m[A].inv[common] = 20; });
    let last; for (let i = 0; i < 9; i++) last = await mk.list(A, common, 400);
    assert.strictEqual(last.error, 'too_many');
  });
  await ok('즉시판매', async () => {
    const before = (await acc.raw(B)).bal; const r = await mk.quick(B, hero);
    assert.ok(r.ok); assert.strictEqual(r.amount, QUICK.hero); assert.strictEqual((await acc.raw(B)).bal, before + QUICK.hero);
    assert.strictEqual((await mk.quick(B, 'nope')).error, 'not_sellable');
  });
  await ok('랭킹/관리자에서 시장 문서는 보이지 않는다', async () => {
    const pl = await acc.players('u-alice'); assert.ok(pl.players.every((p) => !String(p.nick).startsWith('__')));
    assert.strictEqual(pl.players.length, 3);
    process.env.ADMIN_ID = ''; // 관리자 삭제 보호는 id 검사로 충분
  });

  // ── 채팅 ──
  const handlers = {}; const sent = [];
  const mkSock = (uid) => { const h = {}; const s = { data: { uid }, join() {}, leave() {}, on: (e, f) => { h[e] = f; }, emit() {}, h }; return s; };
  const socks = new Map();
  const io = { of: () => ({ sockets: socks }), to: () => ({ emit: (e, d) => sent.push([e, d]) }), on: (e, f) => { handlers[e] = f; } };
  const chat = chatNet.attach(io, { accounts: acc, isAdmin: (id) => id === 'u-alice' });
  const sa = mkSock(A), sb = mkSock(B); socks.set('a', sa); socks.set('b', sb);
  handlers.connection(sa); handlers.connection(sb);
  const call = (s, ev, p) => new Promise((r) => s.h[ev](p, r));
  await ok('채팅: 입장 전 전송 불가', async () => { assert.strictEqual((await call(sb, 'chat:send', { t: 'hi' })).error, 'not_joined'); });
  await ok('채팅: 입장/전송/브로드캐스트', async () => {
    const j = await call(sb, 'chat:join'); assert.deepStrictEqual(j.hist, []);
    await call(sa, 'chat:join');
    assert.ok((await call(sb, 'chat:send', { t: '  안녕\n하세요  ' })).ok);
    const m = sent.filter((x) => x[0] === 'chat:msg').pop()[1]; assert.strictEqual(m.t, '안녕 하세요'); assert.strictEqual(m.n, 'bob');
  });
  await ok('채팅: 도배 제한(1.2초) / 빈 메시지 / 길이', async () => {
    assert.strictEqual((await call(sb, 'chat:send', { t: '또' })).error, 'slow');
    sb.data.last = 0; assert.strictEqual((await call(sb, 'chat:send', { t: '   ' })).error, 'empty');
    sb.data.last = 0; await call(sb, 'chat:send', { t: 'x'.repeat(500) });
    assert.strictEqual(sent.filter((x) => x[0] === 'chat:msg').pop()[1].t.length, 200);
  });
  await ok('채팅: 같은 말 연속 금지', async () => {
    sb.data.last = 0; await call(sb, 'chat:send', { t: 'ㅋ' }); sb.data.last = 0; await call(sb, 'chat:send', { t: 'ㅋ' });
    sb.data.last = 0; assert.strictEqual((await call(sb, 'chat:send', { t: 'ㅋ' })).error, 'repeat');
  });
  await ok('채팅: 관리자만 삭제', async () => {
    const id = chat.hist[0].id; sb.h['chat:del']({ id }); assert.ok(chat.hist.some((m) => m.id === id));
    sa.h['chat:del']({ id }); assert.ok(!chat.hist.some((m) => m.id === id));
  });
  await ok('채팅: 시스템 메시지, 기록 80개 제한', async () => {
    chat.sys('안내'); for (let i = 0; i < 100; i++) chat.sys('s' + i);
    assert.strictEqual(chat.hist.length, 80);
  });
  console.log(`이적시장/채팅 통과: ${n}개`);
})();
