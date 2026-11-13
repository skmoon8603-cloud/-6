'use strict';
// 공 뺏기 확률: 수비 능력이 높을수록 성공률↑, 100%는 아님
const { Match } = require('../lib/engine');
const C = require('../lib/catalog');
const K = require('../lib/const');
function trial(defStat, n) {
  let steals = 0;
  for (let i = 0; i < n; i++) {
    const L = C.defaultLineup();
    const m = new Match({ lineups: [L, L], invs: [{}, {}], bots: [true, true], seconds: 60 });
    m.phase = 'play';
    const carrier = m.players[5], tackler = m.players[6 + 2];
    for (const p of m.players) { p.x = 100 + p.i * 3; p.y = 50; p.vx = p.vy = 0; p.kickCd = 0; }
    carrier.x = 500; carrier.y = 340; carrier.ang = 0; tackler.x = 520; tackler.y = 340; tackler.st = { ...tackler.st, def: defStat };
    m.ball.x = 508; m.ball.y = 340; m.ball.vx = m.ball.vy = 0; m.ball.owner = carrier.i; m.ball.lastSide = 0; m.ball.last = carrier.i;
    m.playerBall(K.TICK);
    if (m.ball.owner === tackler.i) steals++;
  }
  return steals / n;
}
const lo = trial(30, 4000), mid = trial(60, 4000), hi = trial(95, 4000);
console.log(`태클 1회 성공률: 수비30=${(lo * 100).toFixed(1)}%  수비60=${(mid * 100).toFixed(1)}%  수비95=${(hi * 100).toFixed(1)}%`);
if (!(lo < mid && mid < hi && hi < 0.8 && lo > 0)) { console.error('✗ 확률 모델 이상'); process.exit(1); }
console.log('✓ 수비 능력이 높을수록 성공률이 올라가고, 어떤 경우에도 100%가 아님');
