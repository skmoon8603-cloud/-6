'use strict';
/**
 * 주식 (가상 구단 주식): 서버 전체가 같은 시세를 쓰고, 5분마다 한 번씩 가격이 바뀐다.
 *  - 시세는 (종목, 5분 구간 번호)로 결정되는 난수로 이어붙인 '평균회귀 랜덤워크'. 서버가 꺼져 있어도 다시 켜지면 현재 구간까지 이어서 계산한다.
 *  - 시세 문서('__stocks') 하나에 종목별 최근 288개(24시간) 가격을 저장. 보유 주식은 계정의 stk: { 종목: { n: 수량, c: 총매수금 } }.
 *  - 매수/매도는 현재 가격에서 즉시 체결(수수료 없음). 화면에 보이던 시세와 다르면(5분이 지났으면) 'stale' 로 거절해 다시 확인하게 한다.
 * ※ '원'은 게임 안에서만 쓰는 가상 재화이며 실제 주식/투자와 무관합니다.
 */
const crypto = require('crypto');
const { pub } = require('./accounts');

const SID = '__stocks', SLOT_MS = 5 * 60 * 1000, KEEP = 288, MAX_QTY = 10000, MAX_HOLD = 100000, MAX_BAL = 1e9;
const STOCKS = [
  { id: 'mci', name: '맨시티', base: 12000, vol: 0.040, color: '#6cabdd' },
  { id: 'ars', name: '아스널', base: 10000, vol: 0.045, color: '#ef0107' },
  { id: 'che', name: '첼시', base: 8000, vol: 0.055, color: '#2a62c9' },
  { id: 'tot', name: '토트넘', base: 7000, vol: 0.050, color: '#9aa7c7' },
  { id: 'bha', name: '브라이턴', base: 5000, vol: 0.060, color: '#2f8cff' },
  { id: 'bre', name: '브렌트퍼드', base: 4000, vol: 0.065, color: '#ff4d4d' },
  { id: 'eve', name: '에버턴', base: 3000, vol: 0.070, color: '#3b5bdb' },
  { id: 'bou', name: '본머스', base: 2500, vol: 0.075, color: '#ff6b6b' },
];
const BY_ID = Object.fromEntries(STOCKS.map((s) => [s.id, s]));
const slotOf = (t) => Math.floor(t / SLOT_MS);

/** (종목, 구간)에 대해 항상 같은 표준정규 비슷한 난수 */
function z(id, slot) {
  const h = crypto.createHash('sha256').update(`${id}:${slot}`).digest();
  const u = (i) => h.readUInt16BE(i * 2) / 65536;
  return (u(0) + u(1) + u(2) - 1.5) * 2;
}
/** 직전 가격에서 다음 구간 가격 (평균으로 끌려가는 성질 + 변동) */
function nextPx(s, prev, slot) {
  const lp = Math.log(prev), lb = Math.log(s.base);
  const ln = lp + 0.06 * (lb - lp) + s.vol * z(s.id, slot);
  return Math.round(Math.min(s.base * 4, Math.max(Math.max(100, s.base * 0.25), Math.exp(ln))));
}
/** 문서를 slot 까지 이어서 계산 (제자리 수정). 너무 오래 쉬었으면 최근 KEEP 개 구간만 새로 만든다. */
function advance(d, slot) {
  if (!d.hist) { d.hist = {}; d.slot = slot - KEEP; for (const s of STOCKS) d.hist[s.id] = [s.base]; d.slot = slot - KEEP; }
  if (d.slot >= slot) return d;
  const from = Math.max(d.slot + 1, slot - KEEP + 1);
  for (const s of STOCKS) {
    const h = d.hist[s.id] || (d.hist[s.id] = [s.base]);
    let p = h[h.length - 1];
    for (let k = from; k <= slot; k++) { p = nextPx(s, p, k); h.push(p); }
    if (h.length > KEEP) h.splice(0, h.length - KEEP);
  }
  d.slot = slot; return d;
}
const fresh = () => ({ id: SID });
const price = (d, id) => { const h = d.hist[id]; return h[h.length - 1]; };

class Stocks {
  constructor(store, opts = {}) { this.store = store; this.now = opts.now || (() => Date.now()); }

  async state() {
    const slot = slotOf(this.now());
    const cur = await this.store.get(SID);
    if (cur && cur.slot === slot) return cur;
    return this.store.txn([SID], (m) => { const d = m[SID] || (m[SID] = fresh()); advance(d, slot); return JSON.parse(JSON.stringify(d)); });
  }
  /** 현재 시세 + 내 보유 */
  async view(uid) {
    const d = await this.state(); const a = await this.store.get(uid);
    const t = this.now();
    return {
      slot: d.slot, next: (d.slot + 1) * SLOT_MS - t, slotMs: SLOT_MS,
      stocks: STOCKS.map((s) => { const h = d.hist[s.id]; return { id: s.id, name: s.name, color: s.color, price: h[h.length - 1], prev: h.length > 1 ? h[h.length - 2] : h[0], hist: h }; }),
      hold: (a && a.stk) || {}, bal: a ? a.bal : 0,
    };
  }
  async buy(uid, id, qty, slot) {
    const s = BY_ID[id]; qty = Number(qty);
    if (!s) return { error: 'bad_stock' };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_QTY) return { error: 'bad_qty' };
    const cs = slotOf(this.now());
    return this.store.txn([uid, SID], (m) => {
      const a = m[uid]; if (!a) return { error: 'no_account' };
      const d = m[SID] || (m[SID] = fresh()); advance(d, cs);
      if (Number(slot) !== d.slot) return { error: 'stale' };
      const px = price(d, id), cost = px * qty;
      if (a.bal < cost) return { error: 'not_enough', need: cost, bal: a.bal };
      const h = (a.stk = a.stk || {})[id] || { n: 0, c: 0 };
      if (h.n + qty > MAX_HOLD) return { error: 'max_hold' };
      a.bal -= cost; a.stk[id] = { n: h.n + qty, c: h.c + cost };
      return { ok: true, id, qty, price: px, cost, acct: pub(a), hold: a.stk };
    });
  }
  async sell(uid, id, qty, slot) {
    const s = BY_ID[id]; qty = Number(qty);
    if (!s) return { error: 'bad_stock' };
    if (!Number.isInteger(qty) || qty < 1 || qty > MAX_HOLD) return { error: 'bad_qty' };
    const cs = slotOf(this.now());
    return this.store.txn([uid, SID], (m) => {
      const a = m[uid]; if (!a) return { error: 'no_account' };
      const d = m[SID] || (m[SID] = fresh()); advance(d, cs);
      if (Number(slot) !== d.slot) return { error: 'stale' };
      const h = (a.stk || {})[id];
      if (!h || h.n < qty) return { error: 'not_enough_shares', have: h ? h.n : 0 };
      const px = price(d, id), gain = px * qty, costPart = Math.round((h.c * qty) / h.n);
      a.bal = Math.min(MAX_BAL, a.bal + gain);
      if (h.n === qty) delete a.stk[id]; else a.stk[id] = { n: h.n - qty, c: h.c - costPart };
      return { ok: true, id, qty, price: px, gain, profit: gain - costPart, acct: pub(a), hold: a.stk };
    });
  }
}
module.exports = { Stocks, STOCKS, SLOT_MS, slotOf, nextPx, advance, MAX_QTY, MAX_HOLD, SID };
