'use strict';
/**
 * 계정 서비스: 잔액(원)·보관함·뽑기·보상·내기(에스크로)를 서버 DB에서만 관리한다.
 * ※ '원'은 게임 안에서만 쓰는 가상 재화이며 실제 결제/현금화와 무관합니다.
 */
const C = require('./catalog');
const K = require('./const');
const I = require('./inventory');
const crypto = require('crypto');
const scrypt = (pw, salt) => new Promise((res, rej) => crypto.scrypt(pw, salt, 32, (e, k) => (e ? rej(e) : res(k))));
const normUser = (n) => String(n || '').normalize('NFC').trim().toLowerCase();
const validUser = (u) => u.length >= 2 && u.length <= 20 && !/[\u0000-\u001f\u007f]/.test(u);
const fails = new Map(); // 아이디별 로그인 실패 제한 { n, until }

let clock = () => Date.now();
const setClock = (f) => { clock = f || (() => Date.now()); };
/** 한국 시간(KST) 기준 '일' 번호와 그 주(월요일 시작)의 첫 날 번호 */
const kstDay = (t = clock()) => Math.floor((t + K.ATTEND_TZ_H * 3600000) / 86400000);
const weekStart = (d) => d - ((d + 3) % 7); // 1970-01-01 은 목요일 → (d+3)%7 == 0 이 월요일
/** 이번 주 출석 현황 { n: 이번 주 출석 일수, today: 오늘 받았는지, next: 다음에 받을 금액(오늘 받았으면 0) } */
function attStatus(a) {
  const d = kstDay(), w = weekStart(d), at = a.att && a.att.w === w ? a.att : { w, n: 0, last: -1 };
  const today = at.last === d;
  return { n: at.n, today, next: today || at.n >= K.ATTEND.length ? 0 : K.ATTEND[at.n] };
}

const ADMIN_ID = process.env.ADMIN_ID || 'u-skmoon'; // 관리자 계정 (모든 계정의 돈 관리·계정 삭제 권한)
const isAdmin = (id) => id === ADMIN_ID;
const nickOf = (a) => (a.id.startsWith('u-') ? a.id.slice(2) : a.nick || 'PLAYER');

const STAKES = [0, 1000, 2000, 5000, 10000];
const MAX_BAL = 1e9;
const cleanNick = (n) => (String(n || '').replace(/[^\p{L}\p{N} _\-]/gu, '').trim().slice(0, 12));

const pub = (a) => ({
  // 닉네임은 로그인 아이디로 고정
  id: a.id, email: a.email, nick: a.id.startsWith('u-') ? a.id.slice(2) : a.nick, bal: a.bal, inv: a.inv, pulls: a.pulls,
  locked: a.locked ? a.locked.stake : 0,
  secret: C.secretFor(a.inv), // 보유한 숨김(초월) 캐릭터의 실제 정보
  att: attStatus(a),
  admin: isAdmin(a.id),
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

  /** 아이디/비밀번호 회원가입. 비밀번호는 scrypt 해시로만 저장한다. */
  async register(username, password, legacyToken) {
    const u = normUser(username);
    if (!validUser(u)) return { error: 'bad_username' };
    if (typeof password !== 'string' || password.length < 6 || password.length > 64) return { error: 'bad_password' };
    const salt = crypto.randomBytes(16);
    const hash = (await scrypt(password, salt)).toString('base64');
    const id = 'u-' + u;
    return this.store.txn([id], (m) => {
      if (m[id]) return { error: 'exists' };
      const a = m[id] = { id, email: '', name: u, nick: cleanNick(u) || 'PLAYER', bal: K.START_BAL, inv: {}, pulls: 0, locked: null, created: Date.now(), pw: { salt: salt.toString('base64'), hash } };
      const old = legacyToken ? I.decode(legacyToken) : null;
      if (old) { a.inv = old.inv; a.pulls = old.pulls; a.bal = Math.min(old.bal, 20000); a.imported = true; }
      return { acct: pub(a) };
    });
  }

  /** 아이디/비밀번호 로그인 (5회 연속 실패 시 5분 잠금) */
  async signin(username, password) {
    const u = normUser(username);
    if (!validUser(u) || typeof password !== 'string' || password.length > 64) return { error: 'bad_login' };
    const f = fails.get(u);
    if (f && f.until > Date.now()) return { error: 'locked' };
    const a = await this.store.get('u-' + u);
    const salt = a && a.pw ? Buffer.from(a.pw.salt, 'base64') : Buffer.alloc(16);
    const got = await scrypt(password, salt);
    const ok = !!(a && a.pw) && crypto.timingSafeEqual(got, Buffer.from(a.pw.hash, 'base64'));
    if (!ok) {
      const n = ((f && !(f.until && f.until <= Date.now()) ? f.n : 0) || 0) + 1;
      fails.set(u, { n, until: n >= 5 ? Date.now() + 300000 : 0 });
      if (fails.size > 5000) fails.clear();
      return { error: 'bad_login' };
    }
    fails.delete(u);
    return { acct: pub(a) };
  }

  async get(id) { const a = await this.store.get(id); return a ? pub(a) : null; }
  async raw(id) { return this.store.get(id); }

  /** 닉네임은 아이디로 고정되어 변경할 수 없다 */
  async setNick(id) { const a = await this.store.get(id); return a ? pub(a) : null; }

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

  /** 일일 출석 보상: 하루 한 번(한국 시간 기준), 이번 주 N번째 출석에 ATTEND[N-1] 원. 매주 월요일 초기화. */
  async attend(id) {
    return this.store.txn([id], (m) => {
      const a = m[id]; if (!a) return { error: 'no_account' };
      const d = kstDay(), w = weekStart(d);
      let at = a.att && a.att.w === w ? a.att : { w, n: 0, last: -1 };
      if (at.last === d) return { error: 'already', acct: pub(a) };
      const amount = K.ATTEND[Math.min(at.n, K.ATTEND.length - 1)];
      at = { w, n: at.n + 1, last: d };
      a.att = at; a.bal = Math.min(MAX_BAL, a.bal + amount);
      return { amount, day: at.n, acct: pub(a) };
    });
  }

  /** 모든 계정 목록 (돈 많은 순). 아이디(id)는 관리자에게만 알려준다. */
  async players(viewerId) {
    const admin = isAdmin(viewerId);
    const list = (await this.store.listAll()).map((a) => ({
      nick: nickOf(a), bal: a.bal || 0, owned: Object.keys(a.inv || {}).filter((k) => a.inv[k] > 0).length,
      ...(admin ? { id: a.id, locked: !!a.locked } : {}), ...(a.id === viewerId ? { me: true } : {}),
    }));
    list.sort((x, y) => y.bal - x.bal || x.nick.localeCompare(y.nick));
    return { players: list, admin };
  }

  /** [관리자] 계정의 돈을 설정(set)하거나 더하고/빼기(add) */
  async adminMoney(adminId, targetId, mode, amount) {
    if (!isAdmin(adminId)) return { error: 'forbidden' };
    amount = Math.trunc(Number(amount));
    if (!Number.isFinite(amount) || Math.abs(amount) > MAX_BAL || (mode !== 'set' && mode !== 'add')) return { error: 'bad_amount' };
    return this.store.txn([targetId], (m) => {
      const a = m[targetId]; if (!a) return { error: 'no_account' };
      const before = a.bal;
      a.bal = Math.max(0, Math.min(MAX_BAL, mode === 'set' ? amount : a.bal + amount));
      console.log(`[관리자] ${adminId} → ${targetId} 돈 ${mode} ${amount}: ${before} → ${a.bal}`);
      return { ok: true, id: targetId, nick: nickOf(a), before, bal: a.bal };
    });
  }

  /** [관리자] 계정 삭제 (본인/내기 진행 중인 계정은 삭제 불가) */
  async adminDelete(adminId, targetId) {
    if (!isAdmin(adminId)) return { error: 'forbidden' };
    if (targetId === adminId) return { error: 'self' };
    const a = await this.store.get(targetId);
    if (!a) return { error: 'no_account' };
    if (a.locked) return { error: 'locked' };
    await this.store.remove(targetId);
    console.log(`[관리자] ${adminId} 이(가) 계정 삭제: ${targetId}`);
    return { ok: true, id: targetId, nick: nickOf(a) };
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

  /** 운영자 요청 1회성 지급: 닉네임이 정확히 일치하는 계정이 '한 개'일 때만, 모든 캐릭터를 1장(Lv.1)씩 지급. (이미 지급했으면 건너뜀) */
  async grantAllByNick(nick) {
    nick = String(nick).toLowerCase();
    let ids = await this.store.findByNick(nick);
    if (await this.store.get('u-' + nick) && !ids.includes('u-' + nick)) ids = [...ids, 'u-' + nick];
    ids = [...new Set(ids)]; if (ids.includes('u-' + nick)) ids = ['u-' + nick]; // 아이디가 정확히 일치하는 계정 우선
    if (ids.length !== 1) return { ok: false, found: ids.length };
    const id = ids[0];
    return this.store.txn([id], (m) => {
      const a = m[id]; if (!a) return { ok: false, found: 0 };
      if (a.grantedAll) return { ok: true, already: true, id };
      for (const p of C.CATALOG) if (!p.starter && !(a.inv[p.id] > 0)) a.inv[p.id] = 1;
      a.grantedAll = true;
      return { ok: true, id };
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

module.exports = { Accounts, STAKES, pub, cleanNick, setClock, isAdmin, ADMIN_ID };
