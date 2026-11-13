'use strict';
/**
 * 서명된 보관함 토큰 (+ 게임머니 잔액 bal).
 * 계정/DB 없이도 클라이언트가 보관함·잔액을 임의로 조작하지 못하도록 서버가 HMAC 서명을 붙인다.
 * 형식: base64url(JSON) + '.' + base64url(HMAC-SHA256)
 *
 * ※ '원'은 게임 안에서만 쓰는 가상 재화이며 실제 결제/현금과 무관합니다.
 */
const crypto = require('crypto');
const C = require('./catalog');
const K = require('./const');

let SECRET = process.env.INVENTORY_SECRET;
if (!SECRET) {
  SECRET = 'random-football-dev-secret-CHANGE-ME';
  console.warn('[경고] INVENTORY_SECRET 환경변수가 없어 개발용 기본 키를 사용합니다. 배포 시 반드시 설정하세요.');
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');
const MAX_BAL = 1e9;

function encode(inv, pulls, bal) {
  const payload = b64(JSON.stringify({ v: 1, inv, pulls, bal: Math.max(0, Math.min(MAX_BAL, bal | 0)) }));
  return payload + '.' + sign(payload);
}

/** 유효하면 { inv, pulls, bal }, 아니면 null. (bal 필드가 없는 예전 토큰은 START_BAL) */
function decode(token) {
  if (typeof token !== 'string' || token.length > 20000) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const a = Buffer.from(token.slice(i + 1)), b = Buffer.from(sign(payload));
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || o.v !== 1 || typeof o.inv !== 'object') return null;
    const inv = {};
    for (const id of Object.keys(o.inv)) {
      if (C.BY_ID[id] && !C.BY_ID[id].starter && Number.isInteger(o.inv[id]) && o.inv[id] > 0) inv[id] = Math.min(o.inv[id], 9999);
    }
    const bal = Number.isInteger(o.bal) ? Math.max(0, Math.min(MAX_BAL, o.bal)) : K.START_BAL;
    return { inv, pulls: Number.isInteger(o.pulls) ? o.pulls : 0, bal };
  } catch (e) { return null; }
}

/** 토큰 없음/위조 -> 빈 보관함 + 시작 잔액. */
function load(token) {
  return decode(token) || { inv: {}, pulls: 0, bal: K.START_BAL };
}

/** n회 뽑기: 1회당 PULL_COST 원. 잔액 부족이면 { error:'not_enough' }. 서버 난수로만 결과 결정. */
function pull(token, n, rand01) {
  n = n === 10 ? 10 : 1;
  const st = load(token);
  const cost = K.PULL_COST * n;
  if (st.bal < cost) return { error: 'not_enough', bal: st.bal, cost };
  st.bal -= cost;
  const results = [];
  for (let i = 0; i < n; i++) {
    const p = C.pullOne(rand01);
    const before = st.inv[p.id] || 0;
    st.inv[p.id] = before + 1;
    results.push({ id: p.id, isNew: before === 0, count: before + 1, level: C.dupLevel(before + 1), maxed: before >= C.MAX_DUP_LEVEL });
  }
  st.pulls += n;
  return { token: encode(st.inv, st.pulls, st.bal), results, pulls: st.pulls, bal: st.bal };
}

module.exports = { encode, decode, load, pull, PULL_COST: K.PULL_COST, WIN_REWARD: K.WIN_REWARD, START_BAL: K.START_BAL };
