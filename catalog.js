'use strict';
/**
 * RANDOM FOOTBALL - 선수 카탈로그 / 뽑기 / 편성 검증
 * 서버와 클라이언트(/api/catalog)가 동일한 데이터를 사용한다. (결정론적 생성: seed 고정)
 */
const crypto = require('crypto');

const RARITIES = [
  { key: 'common', name: '일반', rate: 55, color: '#9aa7b8', base: 50, count: 24 },
  { key: 'rare',   name: '희귀', rate: 25, color: '#3fa9ff', base: 61, count: 18 },
  { key: 'hero',   name: '영웅', rate: 12, color: '#b65cff', base: 71, count: 14 },
  { key: 'legend', name: '전설', rate: 6,  color: '#ffb81f', base: 81, count: 10 },
  { key: 'myth',   name: '신화', rate: 2,  color: '#ff3d6e', base: 88, count: 6 },
];
const RARITY_BY_KEY = Object.fromEntries(RARITIES.map((r) => [r.key, r]));

// 편성 슬롯 (6인제): 골키퍼1 수비수2 미드필더1 공격수2
const SLOTS = ['GK', 'DF', 'DF', 'MF', 'FW', 'FW'];
const POS_NAME = { GK: '골키퍼', DF: '수비수', MF: '미드필더', FW: '공격수' };
const MAX_DUP_LEVEL = 5; // 중복 1회당 +2% 능력치, 최대 +10%

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

const FIRST_A = ['Ka', 'Ro', 'Mi', 'Ta', 'Ze', 'Lu', 'Vi', 'No', 'Sa', 'Be', 'Dro', 'Fe', 'Gi', 'Ha', 'Ju', 'Ki', 'Ne', 'Pa', 'Xe', 'Yo'];
const FIRST_B = ['ren', 'dan', 'vo', 'lix', 'ro', 'mas', 'tan', 'ko', 'lo', 'zin', 'der', 'mir', 'sho', 'bek', 'ran'];
const LAST_A = ['Bel', 'Cor', 'Dun', 'Fen', 'Gar', 'Hol', 'Kra', 'Lund', 'Mor', 'Nev', 'Ost', 'Pra', 'Quin', 'Rav', 'Sol', 'Tor', 'Ulv', 'Vash', 'Wex', 'Yar', 'Zul'];
const LAST_B = ['ani', 'ek', 'ov', 'ski', 'ton', 'ardo', 'ini', 'berg', 'ez', 'sen', 'ric', 'ova', 'dal', 'ume'];

const ROLE_BONUS = {
  FW: { spd: 6, sht: 11, pas: -2, def: -14, sta: 0 },
  MF: { spd: 0, sht: 0, pas: 11, def: -2, sta: 8 },
  DF: { spd: -2, sht: -10, pas: -2, def: 12, sta: 4 },
  GK: { spd: -8, sht: -14, pas: -4, def: 0, sta: 0 },
};
const OVR_W = {
  FW: { spd: 0.25, sht: 0.4, pas: 0.1, def: 0.02, sta: 0.15, gk: 0 },
  MF: { spd: 0.15, sht: 0.12, pas: 0.38, def: 0.12, sta: 0.2, gk: 0 },
  DF: { spd: 0.18, sht: 0.03, pas: 0.12, def: 0.45, sta: 0.15, gk: 0 },
  GK: { spd: 0.08, sht: 0, pas: 0.07, def: 0.05, sta: 0.05, gk: 0.75 },
};
function ovrOf(pos, st) {
  const w = OVR_W[pos];
  let s = 0;
  for (const k in w) s += st[k] * w[k];
  return Math.round(s);
}

function hsl(h, s, l) { return `hsl(${Math.round(h)} ${Math.round(s)}% ${Math.round(l)}%)`; }

function buildCatalog() {
  const rng = mulberry32(20261113);
  const list = [];
  const usedNames = new Set();
  const usedNums = {};
  const cycle = ['GK', 'FW', 'MF', 'DF', 'FW', 'MF', 'DF'];

  function makeName() {
    for (let i = 0; i < 50; i++) {
      const n = FIRST_A[Math.floor(rng() * FIRST_A.length)] + FIRST_B[Math.floor(rng() * FIRST_B.length)] + ' ' +
        LAST_A[Math.floor(rng() * LAST_A.length)] + LAST_B[Math.floor(rng() * LAST_B.length)];
      if (!usedNames.has(n)) { usedNames.add(n); return n.toUpperCase(); }
    }
    return 'PLAYER ' + (usedNames.size + 1);
  }
  function makeStats(pos, base) {
    const b = ROLE_BONUS[pos];
    const r = () => (rng() - 0.5) * 10;
    const st = {
      spd: clamp(Math.round(base + b.spd + r()), 20, 99),
      sht: clamp(Math.round(base + b.sht + r()), 20, 99),
      pas: clamp(Math.round(base + b.pas + r()), 20, 99),
      def: clamp(Math.round(base + b.def + r()), 20, 99),
      sta: clamp(Math.round(base + b.sta + r()), 20, 99),
      gk: 0,
    };
    st.gk = pos === 'GK' ? clamp(Math.round(base + 14 + (rng() - 0.4) * 7), 30, 99) : clamp(Math.round(8 + rng() * 14), 5, 30);
    return st;
  }
  function makeNumber(posIdx) {
    for (let i = 0; i < 80; i++) {
      const n = 1 + Math.floor(rng() * 99);
      if (!usedNums[n] || i > 60) { usedNums[n] = true; return n; }
    }
    return 7;
  }

  // 기본(스타터) 선수 6명: 항상 보유
  const starters = [
    ['S_GK', 'GK', 'ROOKIE KEEPER', 1], ['S_DF1', 'DF', 'ROOKIE BACK A', 4], ['S_DF2', 'DF', 'ROOKIE BACK B', 5],
    ['S_MF', 'MF', 'ROOKIE MID', 8], ['S_FW1', 'FW', 'ROOKIE STRIKER A', 9], ['S_FW2', 'FW', 'ROOKIE STRIKER B', 11],
  ];
  starters.forEach(([id, pos, name, num], i) => {
    const st = makeStats(pos, 44);
    list.push({
      id, name, pos, rarity: 'common', number: num, stats: st, ovr: ovrOf(pos, st), starter: true,
      c1: hsl(200 + i * 10, 20, 55), c2: '#e9eef5',
    });
  });

  RARITIES.forEach((rar, ri) => {
    for (let i = 0; i < rar.count; i++) {
      const pos = cycle[i % cycle.length];
      const st = makeStats(pos, rar.base);
      const hue = rng() * 360;
      const id = `${rar.key[0].toUpperCase()}${String(i + 1).padStart(2, '0')}`;
      list.push({
        id, name: makeName(), pos, rarity: rar.key, number: makeNumber(i), stats: st, ovr: ovrOf(pos, st), starter: false,
        c1: hsl(hue, 70 + ri * 4, 50), c2: hsl((hue + 150 + rng() * 60) % 360, 60, 85 - ri * 4),
      });
    }
  });
  return list;
}

const CATALOG = buildCatalog();
const BY_ID = Object.fromEntries(CATALOG.map((p) => [p.id, p]));
const POOL = {};
for (const r of RARITIES) POOL[r.key] = CATALOG.filter((p) => p.rarity === r.key && !p.starter);

/** 등급 확률 추첨 (rand01: 0 이상 1 미만 난수 함수) */
function rollRarity(rand01) {
  const x = rand01() * 100;
  let acc = 0;
  for (const r of RARITIES) {
    acc += r.rate;
    if (x < acc) return r.key;
  }
  return 'common';
}
function secureRand01() { return crypto.randomInt(0, 1e9) / 1e9; }

function pullOne(rand01 = secureRand01) {
  const rk = rollRarity(rand01);
  const pool = POOL[rk];
  return pool[Math.floor(rand01() * pool.length) % pool.length];
}

/** 중복 보유 수(count) -> 능력치 보정 레벨 */
function dupLevel(count) { return clamp((count || 1) - 1, 0, MAX_DUP_LEVEL); }

/** 경기용 최종 능력치 (서버만 계산) */
function statsFor(id, inv) {
  const p = BY_ID[id];
  if (!p) return null;
  const lv = p.starter ? 0 : dupLevel(inv && inv[id]);
  const m = 1 + lv * 0.02;
  const out = {};
  for (const k in p.stats) out[k] = Math.min(99, Math.round(p.stats[k] * m));
  return out;
}

function defaultLineup() { return ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'S_FW2']; }

/** 편성 검증: 슬롯 포지션 일치, 보유 여부, 중복 사용 금지. 위반 슬롯은 기본 선수로 대체. */
function validateLineup(lineup, inv) {
  const def = defaultLineup();
  const out = [];
  const used = new Set();
  for (let i = 0; i < SLOTS.length; i++) {
    let id = Array.isArray(lineup) ? lineup[i] : null;
    const p = typeof id === 'string' ? BY_ID[id] : null;
    const owned = p && (p.starter || (inv && inv[id] > 0));
    if (!p || !owned || p.pos !== SLOTS[i] || used.has(id)) id = def[i];
    used.add(id);
    out.push(id);
  }
  return out;
}

/** 서버 봇(CPU) 편성: 무작위 일반~영웅 */
function botLineup(rand01 = Math.random) {
  const out = [];
  const used = new Set();
  for (let i = 0; i < SLOTS.length; i++) {
    const cand = CATALOG.filter((p) => p.pos === SLOTS[i] && ['common', 'rare', 'hero'].includes(p.rarity) && !used.has(p.id));
    const p = cand[Math.floor(rand01() * cand.length)];
    used.add(p.id);
    out.push(p.id);
  }
  return out;
}

module.exports = {
  RARITIES, RARITY_BY_KEY, SLOTS, POS_NAME, CATALOG, BY_ID, MAX_DUP_LEVEL,
  rollRarity, pullOne, dupLevel, statsFor, defaultLineup, validateLineup, botLineup, secureRand01,
};
