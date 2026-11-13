// AI vs AI 시뮬레이션: 엔진/AI 동작, 골 판정, 점수 합계 검증
const { Match } = require('../lib/engine');
const C = require('../lib/catalog');
const K = require('../lib/const');
function run(seed, seconds, lineA, lineB) {
  let s = seed; const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
  const m = new Match({ lineups: [lineA, lineB], invs: [{}, {}], bots: [true, true], seconds, rng });
  let goals = []; let ticks = 0, maxSpd = 0, nan = false, minB = 1e9, maxB = -1e9;
  while (m.phase !== 'ended' && ticks < 60 * (seconds + 60)) {
    m.update(K.TICK); ticks++;
    for (const e of m.events) if (e.type === 'goal') goals.push(e);
    m.events.length = 0;
    const b = m.ball; maxSpd = Math.max(maxSpd, Math.hypot(b.vx, b.vy));
    if (![b.x, b.y, b.vx, b.vy].every(Number.isFinite)) nan = true;
    for (const p of m.players) if (![p.x, p.y].every(Number.isFinite)) nan = true;
    minB = Math.min(minB, b.x); maxB = Math.max(maxB, b.x);
  }
  return { m, goals, ticks, maxSpd, nan };
}
const N = +process.argv[2] || 12, secs = +process.argv[3] || 180;
let tot = 0, draws = 0, w0 = 0, w1 = 0, bad = 0;
const t0 = Date.now();
for (let i = 0; i < N; i++) {
  const r = run(1000 + i * 77, secs, C.botLineup(Math.random), C.botLineup(Math.random));
  const sc = r.m.score;
  const sum = sc[0] + sc[1];
  if (sum !== r.goals.length) bad++;
  if (r.nan) bad++;
  tot += sum; if (sc[0] === sc[1]) draws++; else if (sc[0] > sc[1]) w0++; else w1++;
  console.log(`#${i} ${sc[0]}-${sc[1]} goalEvents=${r.goals.length} phase=${r.m.phase} maxBall=${r.maxSpd.toFixed(0)} nan=${r.nan}`);
}
console.log(`avg goals/match=${(tot / N).toFixed(2)} draws=${draws} w0=${w0} w1=${w1} inconsistencies=${bad} cpu=${Date.now() - t0}ms`);
