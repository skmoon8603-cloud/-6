'use strict';
/**
 * 이적시장 (FIFA 스타일): 보관함의 선수 카드를 다른 사람에게 '원'으로 팔 수 있다.
 *  - 매물 등록: 카드 1장이 보관함에서 빠져 시장에 걸린다 (취소하면 돌아옴). 한 사람당 최대 MAX_LISTINGS 개.
 *  - 구매: 구매자 돈 → 판매자 (수수료 FEE_PCT% 제외). 구매자/판매자/시장을 한 번에 원자적으로 처리.
 *  - 즉시판매: 시장 없이 구단에 바로 팔기 (등급별 고정가).
 *  - 가격 범위: 등급별 최저가 ~ 최저가×200 (최대 500만원). 최근 거래가를 선수별로 기록.
 * 시장 데이터는 계정 저장소의 특수 문서('__market') 하나에 저장된다.
 * ※ '원'은 게임 안에서만 쓰는 가상 재화입니다.
 */
const C = require('./catalog');
const { pub } = require('./accounts');

const MID = '__market';
const QUICK = { common: 300, rare: 800, hero: 2500, legend: 8000, myth: 30000 }; // 즉시판매가 = 최저 등록가
const MAX_PRICE = 5000000, MAX_LISTINGS = 8, FEE_PCT = 5, MAX_BAL = 1e9;
const nickOf = (a) => (a.id.startsWith('u-') ? a.id.slice(2) : a.nick || 'PLAYER');
const sellable = (pid) => { const p = C.BY_ID[pid]; return p && !p.starter && !p.hidden && QUICK[p.rarity] ? p : null; };
const range = (p) => [QUICK[p.rarity], Math.min(MAX_PRICE, QUICK[p.rarity] * 200)];
const fresh = () => ({ id: MID, list: [], seq: 0, last: {} });

class Market {
  constructor(store) { this.store = store; }

  async view(uid) {
    const d = (await this.store.get(MID)) || fresh();
    const list = d.list.slice().sort((a, b) => b.ts - a.ts).slice(0, 300).map((l) => ({ id: l.id, pid: l.pid, price: l.price, seller: l.sn, ts: l.ts, mine: l.s === uid }));
    return { list, last: d.last, quick: QUICK, fee: FEE_PCT, maxListings: MAX_LISTINGS, maxPrice: MAX_PRICE };
  }

  /** 카드 1장을 시장에 올린다 */
  async list(uid, pid, price) {
    const p = sellable(pid); if (!p) return { error: 'not_sellable' };
    price = Math.trunc(Number(price));
    const [lo, hi] = range(p);
    if (!Number.isFinite(price) || price < lo || price > hi) return { error: 'bad_price', lo, hi };
    return this.store.txn([uid, MID], (m) => {
      const a = m[uid]; if (!a) return { error: 'no_account' };
      if (!(a.inv[pid] > 0)) return { error: 'not_owned' };
      const d = m[MID] || (m[MID] = fresh());
      if (d.list.filter((l) => l.s === uid).length >= MAX_LISTINGS) return { error: 'too_many', max: MAX_LISTINGS };
      a.inv[pid] -= 1; if (a.inv[pid] <= 0) delete a.inv[pid];
      const l = { id: ++d.seq, pid, price, s: uid, sn: nickOf(a), ts: Date.now() };
      d.list.push(l);
      return { ok: true, listing: l, acct: pub(a) };
    });
  }

  /** 내 매물 취소 → 카드 반환 */
  async cancel(uid, lid) {
    return this.store.txn([uid, MID], (m) => {
      const a = m[uid], d = m[MID]; if (!a) return { error: 'no_account' };
      const i = d ? d.list.findIndex((l) => l.id === lid && l.s === uid) : -1;
      if (i < 0) return { error: 'gone' };
      const [l] = d.list.splice(i, 1);
      a.inv[l.pid] = Math.min(9999, (a.inv[l.pid] || 0) + 1);
      return { ok: true, acct: pub(a) };
    });
  }

  /** 구매: 구매자 돈 차감 → 카드 지급, 판매자에게 (가격 - 수수료) 입금 */
  async buy(uid, lid) {
    const d0 = await this.store.get(MID);
    const l0 = d0 && d0.list.find((l) => l.id === lid);
    if (!l0) return { error: 'gone' };
    if (l0.s === uid) return { error: 'own' };
    return this.store.txn([uid, l0.s, MID], (m) => {
      const b = m[uid], s = m[l0.s], d = m[MID];
      if (!b) return { error: 'no_account' };
      const i = d ? d.list.findIndex((l) => l.id === lid) : -1;
      if (i < 0) return { error: 'gone' };
      const l = d.list[i];
      if (b.bal < l.price) return { error: 'not_enough', need: l.price, bal: b.bal };
      d.list.splice(i, 1);
      b.bal -= l.price; b.inv[l.pid] = Math.min(9999, (b.inv[l.pid] || 0) + 1);
      const net = l.price - Math.floor((l.price * FEE_PCT) / 100);
      if (s) s.bal = Math.min(MAX_BAL, s.bal + net);
      const h = d.last[l.pid] || { p: 0, n: 0 };
      d.last[l.pid] = { p: l.price, n: h.n + 1 };
      return { ok: true, pid: l.pid, price: l.price, net, seller: l.s, sellerNick: l.sn, buyerNick: nickOf(b), acct: pub(b), sellerAcct: s ? pub(s) : null };
    });
  }

  /** 즉시판매: 구단이 등급별 고정가로 바로 사 준다 */
  async quick(uid, pid) {
    const p = sellable(pid); if (!p) return { error: 'not_sellable' };
    return this.store.txn([uid], (m) => {
      const a = m[uid]; if (!a) return { error: 'no_account' };
      if (!(a.inv[pid] > 0)) return { error: 'not_owned' };
      a.inv[pid] -= 1; if (a.inv[pid] <= 0) delete a.inv[pid];
      const amount = QUICK[p.rarity];
      a.bal = Math.min(MAX_BAL, a.bal + amount);
      return { ok: true, amount, acct: pub(a) };
    });
  }
}
module.exports = { Market, QUICK, FEE_PCT, MAX_LISTINGS, MID };
