// 원 바운스 규칙 테스트
const assert = require('assert');
const { OneBounce } = require('../public/bounce.js');
const C = OneBounce.C;
let n = 0; const ok = (m) => { n++; console.log('  ✓ ' + m); };
const step = (g, sec) => { for (let i = 0; i < sec * 120; i++) g.update(1 / 120); };
const mk = (o) => new OneBounce({ rng: () => 0.5, ...o });

// 1) 서브: 내 코트에 한 번 튕긴 뒤에는 칠 수 있고, 튕기기 전에는 반칙
{
  const g = mk(); g.server = 0; g.startServe();
  g.ball.y = C.GY - 60; g.ball.x = g.p[0].x; g.ball.vy = 0; // 튕기기 전, 닿는 거리
  g.swing(0, 'lob'); assert.deepStrictEqual(g.score, [0, 1]); ok('튕기기 전에 치면 반칙(발리) → 상대 득점');
}
{
  const g = mk({ level: 0 }); g.server = 0; g.startServe(); g.cpu.wait = 99;
  let hit = false;
  for (let i = 0; i < 600 && !hit; i++) { g.update(1 / 120); if (g.ball.bounces === 1) { g.ball.x = g.p[0].x; g.ball.y = C.GY - 20; g.swing(0, 'lob', 0); hit = g.ball.lastHit === 0; } }
  assert(hit && g.score[1] === 0); ok('한 번 튕긴 뒤에 치면 정상 타격');
  // 친 공은 상대 코트에 먼저 닿는다
  g.cpu.wait = 99; g.ev.length = 0; let bounced = false;
  for (let i = 0; i < 600 && !bounced; i++) { g.update(1 / 120); if (g.ev.some((e) => e.t === 'bounce')) { bounced = true; assert(g.ball.x > C.NET_X, '상대 코트'); } g.ev.length = 0; }
  assert(bounced); ok('내가 친 공이 상대 코트에 먼저 떨어짐 (네트 통과)');
}
// 2) 두 번 튕기면 못 친 쪽 실점
{
  const g = mk(); g.server = 0; g.startServe(); g.p[0].x = 60; g.cpu.wait = 99;
  g.ball.x = 300; g.p[0].vx = 0; step(g, 3);
  assert.deepStrictEqual(g.score, [0, 1]); ok('두 번 튕기도록 못 치면 실점');
}
// 3) 내 코트에 떨어지면 반칙
{
  const g = mk(); g.cpu.wait = 99; g.phase = 'play';
  Object.assign(g.ball, { x: 200, y: 200, vx: 0, vy: 0, lastHit: 0, bounces: 0, recv: 1 });
  step(g, 1); assert.deepStrictEqual(g.score, [0, 1]); ok('친 공이 내 코트에 먼저 닿으면 반칙');
}
// 4) 네트
{
  const g = mk(); g.phase = 'play'; g.cpu.wait = 99;
  Object.assign(g.ball, { x: C.NET_X - 30, y: C.GY - 20, vx: 300, vy: 0, lastHit: 0, bounces: 0, recv: 1 });
  step(g, 0.3); assert.deepStrictEqual(g.score, [0, 1]); ok('네트에 걸리면 친 사람 실점');
}
// 5) 연속 경기: CPU vs CPU 비슷하게 돌려 7점 선취로 끝나는지, NaN 없는지
{
  let ends = 0;
  for (let k = 0; k < 20; k++) {
    let s = k + 1; const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
    const g = new OneBounce({ rng, level: 0.4 });
    for (let i = 0; i < 120 * 900 && !g.over; i++) {
      // 사람(0번)도 단순 자동: 공을 따라가며 칠 수 있을 때 침
      const b = g.ball;
      g.setMove(0, b.recv === 0 ? Math.sign(b.x - g.p[0].x) : 0);
      if (g.canHit(0) === 'ok' && rng() < 0.12) g.swing(0, rng() < 0.3 ? 'smash' : 'lob', rng() * 2 - 1);
      g.update(1 / 120); g.ev.length = 0;
      assert(Number.isFinite(b.x) && Number.isFinite(b.y));
    }
    if (g.over) { ends++; assert(Math.max(...g.score) === C.WIN); }
  }
  assert(ends >= 18, 'ends=' + ends); ok(`자동 경기 20판 중 ${ends}판이 ${C.WIN}점 선취로 종료`);
}
console.log('\n원 바운스 통과: ' + n + '개');
