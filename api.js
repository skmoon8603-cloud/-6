'use strict';
const C = require('./catalog');
const I = require('./inventory');

const hits = new Map(); // ip -> {t, n}
function limited(ip, max = 30, windowMs = 10000) {
  const now = Date.now();
  let h = hits.get(ip);
  if (!h || now - h.t > windowMs) { h = { t: now, n: 0 }; hits.set(ip, h); }
  h.n++;
  if (hits.size > 5000) for (const [k, v] of hits) if (now - v.t > windowMs) hits.delete(k);
  return h.n > max;
}

function catalogPayload() {
  return {
    rarities: C.RARITIES.map(({ key, name, rate, color }) => ({ key, name, rate, color })),
    slots: C.SLOTS, posName: C.POS_NAME, maxDup: C.MAX_DUP_LEVEL, pullCost: I.PULL_COST, winReward: I.WIN_REWARD, startBal: I.START_BAL,
    players: C.CATALOG,
  };
}

/** POST /api/pull  { token?, n: 1|10 } -> { token, results, pulls } */
function handlePull(body, ip) {
  if (limited(ip)) return { status: 429, body: { error: 'too_many_requests' } };
  const n = body && body.n === 10 ? 10 : 1;
  const out = I.pull(body && body.token, n);
  if (out.error) return { status: 402, body: out };
  return { status: 200, body: out };
}

/** POST /api/inventory { token } -> 서명 검증 후 보관함 사본 */
function handleInventory(body, ip) {
  if (limited(ip)) return { status: 429, body: { error: 'too_many_requests' } };
  const st = I.load(body && body.token);
  return { status: 200, body: { inv: st.inv, pulls: st.pulls, bal: st.bal, valid: !!I.decode(body && body.token) } };
}

module.exports = { catalogPayload, handlePull, handleInventory };
