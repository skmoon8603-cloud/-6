// 닉네임 변경 / 삭제된 캐릭터 정리 / 새 캐릭터 / 골키퍼 즉시 패스
process.env.DEV_LOGIN = '1'; process.env.SESSION_SECRET = 'test-secret'; process.env.START_BAL = '0';
const assert = require('assert');
const C = require('../lib/catalog'); const K = require('../lib/const');
const { MemoryStore } = require('../lib/store'); const { Accounts, setClock, nickOf } = require('../lib/accounts');
const { Match } = require('../lib/engine');
let n = 0; const ok = (c, m) => { assert(c, m); n++; };
(async () => {
  // 캐릭터
  const nm = (i) => C.BY_ID[i].name + '/' + C.BY_ID[i].rarity;
  ok(['주시완/legend', '황주원/legend', '허신/legend', '송인우/legend', '홍서현/legend', '김준협/legend'].join() === ['L01', 'L06', 'L07', 'L08', 'L09', 'L10'].map(nm).join(), '전설 6명');
  ok(C.BY_ID.L01.stats.dri >= 90 && C.BY_ID.L06.stats.sht >= 90 && C.BY_ID.L06.stats.dri >= 90 && C.BY_ID.L07.stats.sta >= 90 && C.BY_ID.L08.stats.spd >= 90 && C.BY_ID.L09.stats.pas >= 90 && C.BY_ID.L10.stats.def >= 90, '전설 특기 능력치');
  ok(['김동우', '박사하', '박지용', '문은우', '손재현', '채시완', '신동윤', '황순민', '고예헌', '우지민', '허시화'].join() === ['H04', 'H05', 'H06', 'H07', 'H08', 'H09', 'H10', 'H11', 'H12', 'H13', 'H14'].map((i) => C.BY_ID[i].name).join() && ['H04', 'H14'].every((i) => C.BY_ID[i].rarity === 'hero'), '에픽 11명');
  ok(C.BY_ID.H12.pos === 'GK' && C.BY_ID.H12.stats.gk >= 85, '고예헌은 골키퍼');
  ok(['R01', 'R04', 'C01', 'C02'].map(nm).join() === '김동민/rare,최선율/rare,왕정훈/rare,라태양/rare', '희귀 4명(왕정훈·라태양은 일반에서 승급)');
  ok(!C.BY_ID.M06 && !C.CATALOG.some((p) => p.name === '이지후'), '이지후 삭제');
  // 닉네임
  const store = new MemoryStore(), acc = new Accounts(store);
  await acc.register('alice', 'secret1'); await acc.register('bob', 'secret1');
  ok((await acc.setNick('u-alice', 'x')).error === 'invalid', '너무 짧은 닉네임');
  ok((await acc.setNick('u-alice', 'Bob')).error === 'taken', '남의 아이디/닉네임과 같으면 거절(대소문자 무시)');
  let r = await acc.setNick('u-alice', '멋진 앨리스'); ok(r.ok && r.account.nick === '멋진 앨리스' && r.account.id === 'u-alice', '닉네임 변경, 아이디는 그대로');
  ok((await acc.setNick('u-alice', '또바뀜')).error === 'slow', '연속 변경 제한');
  ok((await acc.setNick('u-bob', '멋진 앨리스')).error === 'taken', '바뀐 닉네임도 중복 불가');
  ok((await acc.players('u-bob')).players.some((p) => p.nick === '멋진 앨리스'), '랭킹에 새 닉네임 표시');
  ok(nickOf(await store.get('u-alice')) === '멋진 앨리스' && (await acc.get('u-alice')).nick === '멋진 앨리스', '어디서나 같은 닉네임');
  // 삭제된 캐릭터 정리
  await store.txn(['u-bob', '__market'], (m) => { m['u-bob'].inv = { M06: 1, R01: 1 }; m['__market'] = { id: '__market', list: [{ id: 1, pid: 'M06', price: 1, s: 'u-bob' }, { id: 2, pid: 'R01', price: 1, s: 'u-bob' }], seq: 2, last: {}, sysDay: -1 }; });
  ok(!('M06' in (await acc.get('u-bob')).inv), '삭제된 캐릭터는 화면에 내려가지 않음');
  ok((await acc.purgeRemoved(['M06'])) === 2, '정리: 보관함 1 + 매물 1');
  const b = await store.get('u-bob'); ok(!('M06' in b.inv) && b.inv.R01 === 1 && (await store.get('__market')).list.length === 1, '다른 캐릭터는 그대로');
  // 골키퍼: 공을 받자마자 패스
  let kicked = null;
  for (let trial = 0; trial < 5; trial++) {
    const L = C.defaultLineup(); const m = new Match({ lineups: [L, L], invs: [{}, {}], bots: [true, true], seconds: 60 }); m.phase = 'play';
    const gk = m.players[0];
    for (const p of m.players) { if (p !== gk) { p.x = 600 + p.i * 40; p.y = 300 + (p.i % 3) * 120; p.vx = p.vy = 0; } }
    gk.x = 60; gk.y = K.H / 2; gk.vx = gk.vy = 0; Object.assign(m.ball, { x: 64, y: K.H / 2, vx: 0, vy: 0, owner: gk.i, last: gk.i, lastSide: 0 });
    let t = 0; const fast = () => Math.hypot(m.ball.vx, m.ball.vy) > 250;
    while (t < 1.5 && !fast()) { m.update(K.TICK); t += K.TICK; }
    kicked = t; if (!fast() || t > 0.3) break;
  }
  ok(kicked !== null && kicked <= 0.3, `골키퍼는 공을 잡자마자 패스 (${kicked.toFixed(2)}초)`);
  console.log(`changes tests: ${n} passed`);
})().catch((e) => { console.error(e); process.exit(1); });
