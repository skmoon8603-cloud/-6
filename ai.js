'use strict';
/**
 * 팀원 AI (조작하지 않는 선수 + CPU 상대). 입력은 p.dx/p.dy/p.sp 로 출력하고,
 * 슛/패스는 match.doShoot / match.doPass 로 서버 엔진이 직접 수행한다.
 */
const K = require('./const');
const { W, H, GOAL_W, PR, BR } = K;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

const HOME = [[70, H / 2], [235, H / 2 - 125], [235, H / 2 + 125], [350, H / 2], [440, H / 2 - 175], [440, H / 2 + 175]];
function home(p) {
  const h = HOME[p.slot];
  return p.side === 0 ? { x: h[0], y: h[1] } : { x: W - h[0], y: H - h[1] };
}

function prepare(m) {
  const b = m.ball;
  const A = (m.ai = m.ai || { chaser: [-1, -1], has: [false, false] });
  let nd = 1e9, np = null;
  for (const p of m.players) { const d = dist(p, b); if (d < nd) { nd = d; np = p; } }
  A.has = [false, false];
  if (np && nd < 75) A.has[np.side] = true;
  else if (b.lastSide >= 0 && Math.hypot(b.vx, b.vy) > 100) A.has[b.lastSide] = true;
  for (let side = 0; side < 2; side++) {
    const tm = m.teams[side];
    const ownX = side === 0 ? 0 : W;
    let best = -1, bd = 1e9;
    for (let s = 0; s < K.TEAM_SIZE; s++) {
      const p = m.players[side * K.TEAM_SIZE + s];
      if (s === 0 && Math.abs(b.x - ownX) > 200) continue;
      const d = dist(p, b);
      if (d < bd) { bd = d; best = s; }
    }
    // 사람이 조작 중인 선수가 가장 가까우면 AI 추격자는 없음
    A.chaser[side] = !tm.bot && tm.ctrl === best ? -1 : best >= 0 ? side * K.TEAM_SIZE + best : -1;
  }
}

function moveTo(p, tx, ty, slow) {
  const dx = tx - p.x, dy = ty - p.y, d = Math.hypot(dx, dy);
  if (d < 6) { p.dx = p.dy = 0; return; }
  const mag = slow ? Math.min(1, d / 60) : 1;
  p.dx = (dx / d) * mag; p.dy = (dy / d) * mag;
  p.ang = Math.atan2(dy, dx);
}

function nearestOpp(m, p) {
  let best = null, bd = 1e9;
  for (const o of m.players) if (o.side !== p.side) { const d = dist(o, p); if (d < bd) { bd = d; best = o; } }
  return { o: best, d: bd };
}

function think(m, p, dt) {
  p.sp = false; p.dx = p.dy = 0;
  if (p.pos === 'GK') return goalkeeper(m, p, dt);
  const side = p.side, dir = side === 0 ? 1 : -1, b = m.ball, tm = m.teams[side], A = m.ai;
  const ownX = side === 0 ? 0 : W;
  p.think -= dt;

  if (m.canReach(p) && p.kickCd <= 0) return carry(m, p, dir);

  const receiving = tm.receiver === p.i && m.tick < tm.receiverUntil;
  if (A.chaser[side] === p.i || receiving) {
    const t = 0.22;
    moveTo(p, b.x + b.vx * t, b.y + b.vy * t, false);
    p.sp = dist(p, b) > 130 && p.stam > 28;
    return;
  }

  const depth = (b.x - ownX) * dir; // 우리 골대에서 공까지의 전진 거리
  const hm = home(p);
  const has = A.has[side];
  let tx, ty;
  if (p.pos === 'DF') {
    tx = ownX + dir * clamp(depth * 0.5, 150, 430);
    ty = hm.y + (b.y - hm.y) * 0.45;
  } else if (p.pos === 'MF') {
    tx = ownX + dir * clamp(depth * 0.72 + (has ? 70 : 0), 230, 720);
    ty = H / 2 + (b.y - H / 2) * 0.55;
  } else {
    tx = has ? ownX + dir * clamp(depth + 150, 420, 900) : ownX + dir * clamp(depth * 0.9, 380, 620);
    ty = hm.y + (b.y - hm.y) * 0.25;
  }
  moveTo(p, tx, ty, true);
  if (p.dx === 0 && p.dy === 0) p.ang = Math.atan2(b.y - p.y, b.x - p.x);
}

function carry(m, p, dir) {
  const gx = p.side === 0 ? W : 0;
  const b = m.ball;
  const { o: opp, d: od } = nearestOpp(m, p);
  const dGoal = Math.abs(gx - p.x);
  const aimY = H / 2 + clamp(p.y - H / 2, -50, 50) * -0.5;
  if (p.think <= 0) {
    p.think = 0.16 + m.rng() * 0.16;
    const a2g = Math.atan2(aimY - p.y, gx - p.x);
    if (dGoal < 340 && Math.abs(p.y - H / 2) < 250) {
      p.ang = a2g; m.doShoot(p, 0.65 + m.rng() * 0.35); return;
    }
    if (dGoal < 480 && od > 90 && m.rng() < 0.3) { p.ang = a2g; m.doShoot(p, 0.9); return; }
    const own = Math.abs(p.x - (p.side === 0 ? 0 : W));
    if (od < 85 && (m.rng() < 0.55 + p.st.pas / 400)) { if (m.doPass(p, true)) return; }
    if (own < 300 && od < 130 && m.rng() < 0.6) { if (m.doPass(p, true)) return; }
    if (m.rng() < 0.05) { if (m.doPass(p, true)) return; }
  }
  // 드리블: 골대 쪽으로, 앞의 상대는 피한다
  let vx = gx - p.x, vy = aimY - p.y; const l = Math.hypot(vx, vy) || 1; vx /= l; vy /= l;
  for (const o of m.players) {
    if (o.side === p.side) continue;
    const dx = p.x - o.x, dy = p.y - o.y, d = Math.hypot(dx, dy);
    if (d < 120 && d > 0.1) {
      const ahead = ((o.x - p.x) * dir) > -20;
      const w = (1 - d / 120) * (ahead ? 1.4 : 0.4);
      vx += (dx / d) * w; vy += (dy / d) * w;
    }
  }
  const l2 = Math.hypot(vx, vy) || 1;
  p.dx = vx / l2; p.dy = vy / l2; p.ang = Math.atan2(p.dy, p.dx);
  p.sp = od > 110 && p.stam > 35;
}

function goalkeeper(m, p, dt) {
  const side = p.side, dir = side === 0 ? 1 : -1, b = m.ball;
  const ownX = side === 0 ? 0 : W;
  const gx = ownX + dir * 34;
  const bs = Math.hypot(b.vx, b.vy);
  // 볼 소유 → 잠깐 후 배급
  if (m.canReach(p) && bs < 90) {
    p.gkT = (p.gkT === undefined ? 0.4 : p.gkT) - dt;
    p.ang = side === 0 ? 0 : Math.PI;
    if (p.gkT <= 0) { p.gkT = undefined; m.doPass(p, true); }
    return;
  }
  p.gkT = undefined;
  const toGoal = b.vx * dir < -120;
  let ty, tx = gx + dir * Math.min(70, Math.abs(b.x - ownX) * 0.1);
  if (toGoal) {
    const t = (gx - b.x) / b.vx;
    ty = b.y + b.vy * t;
    if (t > 0 && t < 0.6 && Math.abs(ty - H / 2) < GOAL_W / 2 + 30) { p.boost = 1.1 + p.st.gk / 110; p.diving = 0.3; }
    tx = gx;
  } else {
    ty = H / 2 + (b.y - H / 2) * 0.4;
  }
  ty = clamp(ty, H / 2 - GOAL_W / 2 + 4, H / 2 + GOAL_W / 2 - 4);
  const rush = Math.abs(b.x - ownX) < 190 && Math.abs(b.y - H / 2) < GOAL_W / 2 + 70 && bs < 200 && dist(p, b) < 150;
  if (rush) { let n = 0; for (const o of m.players) if (o.side !== side && dist(o, b) < dist(p, b)) n++; if (!n) { moveTo(p, b.x, b.y, false); return; } }
  moveTo(p, tx, ty, true);
  if (p.dx === 0 && p.dy === 0) p.ang = Math.atan2(b.y - p.y, b.x - p.x);
}

module.exports = { prepare, think, home };
