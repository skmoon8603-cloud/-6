'use strict';
/**
 * 서명된 보관함 토큰.
 * 계정/DB 없이도 클라이언트가 보관함을 임의로 조작하지 못하도록 서버가 HMAC 서명을 붙인다.
 * 형식: base64url(JSON) + '.' + base64url(HMAC-SHA256)
 */
const crypto = require('crypto');
const C = require('./catalog');

let SECRET = process.env.INVENTORY_SECRET;
if (!SECRET) {
  SECRET = 'random-football-dev-secret-CHANGE-ME';
  console.warn('[경고] INVENTORY_SECRET 환경변수가 없어 개발용 기본 키를 사용합니다. 배포 시 반드시 설정하세요.');
}

const b64 = (buf) => Buffer.from(buf).toString('base64url');
const sign = (payload) => crypto.createHmac('sha256', SECRET).update(payload).digest('base64url');

function encode(inv, pulls) {
  const payload = b64(JSON.stringify({ v: 1, inv, pulls }));
  return payload + '.' + sign(payload);
}

/** 유효하면 { inv, pulls }, 아니면 null */
function decode(token) {
  if (typeof token !== 'string' || token.length > 20000) return null;
  const i = token.indexOf('.');
  if (i < 1) return null;
  const payload = token.slice(0, i);
  const sig = token.slice(i + 1);
  const exp = sign(payload);
  const a = Buffer.from(sig), b = Buffer.from(exp);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  try {
    const o = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (!o || o.v !== 1 || typeof o.inv !== 'object') return null;
    const inv = {};
    for (const id of Object.keys(o.inv)) {
      if (C.BY_ID[id] && !C.BY_ID[id].starter && Number.isInteger(o.inv[id]) && o.inv[id] > 0) inv[id] = Math.min(o.inv[id], 9999);
    }
    return { inv, pulls: Number.isInteger(o.pulls) ? o.pulls : 0 };
  } catch (e) { return null; }
}

/** 토큰 없음/위조 -> 빈 보관함. */
function load(token) {
  return decode(token) || { inv: {}, pulls: 0 };
}

/** n회 뽑기. 서버 난수로만 결과 결정. */
function pull(token, n, rand01) {
  n = n === 10 ? 10 : 1;
  const st = load(token);
  const results = [];
  for (let i = 0; i < n; i++) {
    const p = C.pullOne(rand01);
    const before = st.inv[p.id] || 0;
    st.inv[p.id] = before + 1;
    results.push({ id: p.id, isNew: before === 0, count: before + 1, level: C.dupLevel(before + 1), maxed: before + 1 - 1 >= C.MAX_DUP_LEVEL });
  }
  st.pulls += n;
  return { token: encode(st.inv, st.pulls), results, pulls: st.pulls };
}

module.exports = { encode, decode, load, pull };
