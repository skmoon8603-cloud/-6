// 원바 규칙: 찬 공은 바닥에 한 번 튕기기 전에는 필드 선수가 터치할 수 없고, 정확히 한 번만 튕긴다
const { Match } = require('../lib/engine');
const C = require('../lib/catalog');
const K = require('../lib/const');
const assert = require('assert');
let s = 7; const rng = () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
const m = new Match({ lineups: [C.botLineup(Math.random), C.botLineup(Math.random)], invs: [{}, {}], bots: [true, true], seconds: 60, rng });
while (m.phase !== 'play') m.update(K.TICK);
// 3번 선수 앞에 공을 두고 슛
const p = m.players[3]; p.x = 300; p.y = 300; m.ball.x = p.x + 20; m.ball.y = p.y; m.ball.vx = m.ball.vy = 0; p.ang = 0;
for (const q of m.players) if (q !== p) { q.x = 900; q.y = 40 + q.i * 40; }
assert(m.doShoot(p, 0.8), '슛 성공');
assert(m.ball.z > 0 && m.ball.vz > 0, '공이 뜬다');
// 상대 선수를 공 경로 위에 세워도 공중에서는 터치 불가
let bounces = 0, ownerWhileAir = false, ticks = 0;
const blocker = m.players[8]; blocker.dx = blocker.dy = 0;
while (ticks++ < 200) {
  blocker.x = m.ball.x; blocker.y = m.ball.y; blocker.vx = blocker.vy = 0;
  const spd0 = Math.hypot(m.ball.vx, m.ball.vy), air = m.ball.z > K.TOUCH_Z;
  m.update(K.TICK);
  if (air && m.ball.owner >= 0) ownerWhileAir = true;
  for (const e of m.events) if (e.type === 'bounce') bounces++;
  m.events.length = 0;
  if (m.ball.z === 0 && bounces) break;
}
assert(!ownerWhileAir, '공중에서 소유 불가');
assert.strictEqual(bounces, 1, '정확히 한 번 튕김');
console.log('원바 규칙 테스트 통과');
