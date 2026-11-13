'use strict';
/**
 * 계정 서비스: 잔액(원)·보관함·뽑기·보상·내기(에스크로)를 서버 DB에서만 관리한다.
 * ※ '원'은 게임 안에서만 쓰는 가상 재화이며 실제 결제/현금화와 무관합니다.
 */
const C = require('./catalog');
const K = require('./const');
const I = require('./inventory');

const STAKES = [0, 1000, 2000, 5000, 10000];
const MAX_BAL = 1e9;
const cleanNick = (n) => (String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 12));

const pub = (a) => ({
  id: a.id, email: a.email, nick: a.nick, bal: a.bal, inv: a.inv, pulls: a.pulls,
  locked: a.locked ? a.locked.stake : 0,
});

class Accounts {
  constructor(store) { this.store = store; }

  /** 로그인(최초 1회는 계정 생성). legacyToken: 예전 버전(토큰 방식) 보관함을 최초 1회만 가져온다. */
  async login(profile, legacyToken) {
    const id = profile.sub;
    return this.store.txn([id], (map) => {
      let a = map[id];
      if (!a) {
        a = map[id] = { id, email: profile.email, name: profile.name, nick: cleanNick(profile.name) || 'PLAYER', bal: K.START_BAL, inv: {}, pulls: 0, locked: null, created: Date.now() };
        const old = legacyToken ? I.decode(legacyToken) : null;
        if (old) { a.inv = old.inv; a.pulls = old.pulls; a.bal = Math.min(old.bal, 20000); a.imported = true; }
      } else { a.email = profile.email || a.email; a.name = profile.name || a.name; }
      return pub(a);
    });
  }

  async get(id) { const a = await this.store.get(id); return a ? pub(a) : null; }
  async raw(id) { return this.store.get(id); }

  async setNick(id, nick) {
    nick = cleanNick(nick); if (!nick) return null;
    return this.store.txn([id], (m) => { if (!m[id]) return null; m[id].nick = nick; return pub(m[id]); });
  }

  /** n회 뽑기 (1회 PULL_COST 원). 서버 난수/서버 잔액으로만 결정 */
  async pull(id, n, rand01) {
    n = n === 10 ? 10 : 1;
    return this.store.txn([id], (m) => {
      const a = m[id]; if (!a) return { error: 'no_account' };
      const cost = K.PULL_COST * n;
      if (a.bal < cost) return { error: 'not_enough', bal: a.bal, cost };
      a.bal -= cost;
      const results = [];
      for (let i = 0; i < n; i++) {
        const p = C.pullOne(rand01);
        const before = a.inv[p.id] || 0;
        a.inv[p.id] = before + 1;
        results.push({ id: p.id, isNew: before === 0, count: before + 1, level: C.dupLevel(before + 1), maxed: before >= C.MAX_DUP_LEVEL });
      }
      a.pulls += n;
      return { results, acct: pub(a) };
    });
  }

  async reward(id, amount) {
    return this.store.txn([id], (m) => { const a = m[id]; if (!a) return null; a.bal = Math.min(MAX_BAL, a.bal + amount); return pub(a); });
  }

  async lineup(id, lineup) {
    const a = await this.store.get(id);
    return C.validateLineup(lineup, a ? a.inv : {});
  }

  /** 내기 시작: 두 사람의 판돈을 동시에 잠근다. 실패하면 아무것도 바뀌지 않는다. */
  async escrow(code, ids, stake) {
    if (!stake) return { ok: true };
    return this.store.txn(ids, (m) => {
      for (const id of ids) {
        const a = m[id];
        if (!a) return { ok: false, who: id, err: 'no_account' };
        if (a.locked) return { ok: false, who: id, err: 'locked' };
        if (a.bal < stake) return { ok: false, who: id, err: 'not_enough' };
      }
      for (const id of ids) { m[id].bal -= stake; m[id].locked = { code, stake }; }
      return { ok: true };
    });
  }

  /** 내기 정산: winnerId 가 있으면 판돈 전액, 없으면(무승부) 각자 환급. 여러 번 호출해도 한 번만 반영된다. */
  async settle(code, ids, winnerId) {
    return this.store.txn(ids, (m) => {
      const held = ids.filter((id) => m[id] && m[id].locked && m[id].locked.code === code);
      if (!held.length) return {};
      const stake = m[held[0]].locked.stake, pot = stake * held.length;
      for (const id of held) m[id].locked = null;
      if (winnerId && held.includes(winnerId)) m[winnerId].bal = Math.min(MAX_BAL, m[winnerId].bal + pot);
      else for (const id of held) m[id].bal = Math.min(MAX_BAL, m[id].bal + stake);
      const out = {};
      for (const id of ids) if (m[id]) out[id] = pub(m[id]);
      return { stake, pot, winnerId: winnerId && held.includes(winnerId) ? winnerId : null, accts: out };
    });
  }

  /** 서버 시작 시: 재시작으로 끊긴 내기를 모두 환급 (방이 메모리에만 있으므로) */
  async refundAllLocked() {
    let n = 0;
    for (const id of await this.store.listLocked()) {
      await this.store.txn([id], (m) => { const a = m[id]; if (a && a.locked) { a.bal = Math.min(MAX_BAL, a.bal + a.locked.stake); a.locked = null; n++; } });
    }
    return n;
  }
}

module.exports = { Accounts, STAKES, pub, cleanNick };
