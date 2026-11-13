'use strict';
/**
 * 원 바운스 (ONE BOUNCE) 서버 엔진 — 발로 차는 1:1 코트 게임. 모든 판정은 서버가 한다.
 * 규칙
 *  - 공은 내 코트에 "최대 한 번"만 튕길 수 있다. 공이 떠 있을 때(발리) 차도 되고, 한 번 튕긴 뒤에 차도 된다.
 *  - 두 번 튕기도록 못 차면 실점.
 *  - 내가 찬 공이 상대 코트에 먼저 닿지 않으면(내 코트/네트) 실점.
 *  - 7점 선취.
 */
const W = 800, H = 450, GY = 340, BR = 12, NET_X = W / 2, NET_H = 74, G = 1500;
const REACH_X = 80, REACH_Y = 135; // 발이 닿는 범위(히트박스): 좌우 ±REACH_X, 바닥에서 REACH_Y 이하
const WIN = 7;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

class OneBounce {
  /** opts: { rng, level(CPU 실력 0~1), cpu(true 면 1번 선수를 CPU 가 조종) } */
  constructor(opts = {}) {
    this.rng = opts.rng || Math.random;
    this.level = opts.level == null ? 0.55 : opts.level;
    this.cpuOn = opts.cpu !== false;
    this.score = [0, 0];
    this.server = 0;
    this.p = [{ x: 150, vx: 0, swing: 0, cd: 0, mv: 0 }, { x: W - 150, vx: 0, swing: 0, cd: 0, mv: 0 }];
    this.ev = [];
    this.phase = 'countdown'; this.phaseT = 1.2;
    this.over = false; this.winner = -1; this.tick = 0;
    this.cpu = { wait: 0, err: null, seq: -1, whiff: false };
    this.hitSeq = 0;
    this.ball = { x: 0, y: 0, vx: 0, vy: 0, lastHit: 0, bounces: 0, recv: 0 };
    this.phase = 'countdown'; // 첫 서브 전 잠깐 대기
    Object.assign(this.ball, { x: 150, y: GY - 80, vx: 0, vy: 0, lastHit: 1, bounces: 0, recv: 0 });
  }

  startServe() {
    const s = this.server;
    this.p[0].x = 150; this.p[1].x = W - 150;
    for (const p of this.p) { p.vx = 0; p.cd = 0; p.swing = 0; }
    // 서브: 서버가 받는 사람 코트로 공을 '띄워서' 넘겨준다 (항상 떠 있는 공)
    Object.assign(this.ball, { x: s === 0 ? 150 : W - 150, y: GY - 80, vx: 0, vy: 0, lastHit: s, bounces: 0, recv: 1 - s });
    const lo = 120, hi = 280, off = lo + this.rng() * (hi - lo);
    this.hitSeq++;
    this.launch(s === 0 ? NET_X + off : NET_X - off, 1.15);
    this.ev.push({ type: 'hit', side: s, kind: 'lob' });
    this.phase = 'play';
    this.cpu.wait = 0.35 + (1 - this.level) * 0.5; this.cpu.err = null;
  }

  /** m: -1/0/1 (월드 좌표 기준: +는 오른쪽) */
  setMove(side, m) { this.p[side].mv = clamp(Math.round(Number(m) || 0), -1, 1); }

  /** 발이 닿는가 (공이 떠 있든 튕겼든 상관없음) */
  canHit(side) {
    const b = this.ball, p = this.p[side];
    if (b.lastHit === side || b.recv !== side) return false;
    // 사람은 넓은 히트박스, AI 는 실력에 맞춰 조금 좁게 (너무 강해지지 않도록)
    const rx = this.cpuOn && side === 1 ? REACH_X * (0.55 + 0.3 * this.level) : REACH_X;
    return Math.abs(b.x - p.x) <= rx && b.y >= GY - REACH_Y - BR && b.y <= GY + 2;
  }

  /** kind: 'lob'(높게) | 'smash'(강하게). aim: -1(네트 앞)~1(뒤쪽) */
  swing(side, kind, aim) {
    const p = this.p[side];
    if (this.phase !== 'play' || this.over || p.cd > 0) return false;
    p.cd = 0.35; p.swing = 0.22;
    if (!this.canHit(side)) return false;
    const b = this.ball;
    const a = Number.isFinite(aim) ? clamp(aim, -1, 1) : this.rng() * 2 - 1;
    let tx = side === 0 ? NET_X + 90 + ((a + 1) / 2) * (W - 60 - NET_X - 90) : NET_X - 90 - ((a + 1) / 2) * (NET_X - 60);
    tx += (this.rng() - 0.5) * 60;
    this.launch(tx, kind === 'smash' ? 0.6 : 1.05);
    b.lastHit = side; b.bounces = 0; b.recv = 1 - side; this.hitSeq++;
    this.ev.push({ type: 'hit', side, kind: kind === 'smash' ? 'smash' : 'lob' });
    return true;
  }

  /** 현재 공 위치에서 비행시간 T 만에 x=tx 바닥에 닿도록 속도를 정한다 (네트를 넘도록 T 를 늘린다) */
  launch(tx, T) {
    const b = this.ball; let vx = 0, vy = 0;
    for (let k = 0; k < 16; k++) {
      vx = (tx - b.x) / T; vy = (GY - BR - b.y - 0.5 * G * T * T) / T;
      const tn = vx !== 0 ? (NET_X - b.x) / vx : -1;
      if (tn > 0 && tn < T) { const yn = b.y + vy * tn + 0.5 * G * tn * tn; if (yn > GY - NET_H - BR - 10) { T += 0.07; continue; } }
      break;
    }
    b.vx = vx; b.vy = vy;
  }

  fault(side, why) { this.ev.push({ type: 'fault', side, why }); this.point(1 - side, why); }

  point(side, why) {
    this.score[side]++;
    this.ev.push({ type: 'point', side, why, score: this.score.slice() });
    if (this.score[side] >= WIN) { this.over = true; this.winner = side; this.phase = 'ended'; this.ev.push({ type: 'end', winner: side, score: this.score.slice() }); return; }
    this.server = side; this.phase = 'point'; this.phaseT = 1.3;
  }

  /** 한 쪽이 나가면 상대 승리 */
  forfeit(side) {
    if (this.over) return;
    this.over = true; this.winner = 1 - side; this.phase = 'ended';
    this.ev.push({ type: 'end', winner: this.winner, score: this.score.slice(), forfeit: true });
  }

  update(dt) {
    this.tick++;
    if (this.over) return;
    for (const p of this.p) { p.cd = Math.max(0, p.cd - dt); p.swing = Math.max(0, p.swing - dt); }
    if (this.phase === 'countdown') { this.phaseT -= dt; if (this.phaseT <= 0) this.startServe(); return; }
    if (this.phase === 'point') { this.phaseT -= dt; if (this.phaseT <= 0) this.startServe(); return; }
    if (this.phase !== 'play') return;
    if (this.cpuOn) this.cpuThink(dt);
    for (let i = 0; i < 2; i++) {
      const p = this.p[i];
      if (!(this.cpuOn && i === 1)) p.vx = p.mv * 300;
      const lo = i === 0 ? 30 : NET_X + 40, hi = i === 0 ? NET_X - 40 : W - 30;
      p.x = clamp(p.x + p.vx * dt, lo, hi);
    }
    this.moveBall(dt);
  }

  moveBall(dt) {
    const b = this.ball, n = 4, h = dt / n;
    for (let k = 0; k < n && this.phase === 'play'; k++) {
      const px = b.x;
      b.vy += G * h; b.x += b.vx * h; b.y += b.vy * h;
      if (b.x < BR) { b.x = BR; b.vx = Math.abs(b.vx) * 0.6; }
      if (b.x > W - BR) { b.x = W - BR; b.vx = -Math.abs(b.vx) * 0.6; }
      if ((px - NET_X) * (b.x - NET_X) <= 0 && b.y > GY - NET_H - BR * 0.5) { this.ev.push({ type: 'net' }); return this.fault(b.lastHit, 'net'); }
      if (b.y >= GY - BR && b.vy > 0) {
        b.y = GY - BR;
        const side = b.x < NET_X ? 0 : 1;
        this.ev.push({ type: 'bounce', x: Math.round(b.x) });
        if (b.bounces === 0) {
          if (side !== b.recv) return this.fault(b.lastHit, 'own'); // 받는 사람 코트에 먼저 닿아야 한다
          b.bounces = 1; b.vy = -Math.abs(b.vy) * 0.72; b.vx *= 0.88;
        } else {
          return this.fault(side, 'double'); // 두 번째 바운드: 그 코트 주인이 못 찼다
        }
      }
    }
  }

  // ─── CPU (1번 선수) ───
  cpuThink(dt) {
    const side = 1, p = this.p[1], b = this.ball, c = this.cpu;
    const sp = 190 + this.level * 130;
    let tx = W - 150;
    if (b.recv === side) {
      if (b.bounces === 0) {
        const t = this.timeToGround();
        c.err = c.err == null ? (this.rng() - 0.5) * (1 - this.level) * 90 : c.err;
        tx = clamp(b.x + b.vx * t, NET_X + 40, W - 30) + (b.vx > 0 ? 10 : -10) + c.err;
      } else tx = b.x;
    } else c.err = null;
    const d = tx - p.x;
    p.vx = Math.abs(d) < 6 ? 0 : Math.sign(d) * Math.min(sp, Math.abs(d) * 8);
    if (c.seq !== this.hitSeq) { c.seq = this.hitSeq; c.whiff = this.rng() < 0.1 + (1 - this.level) * 0.3; } // 공마다 한 번 '놓칠지' 결정 (AI 실수)
    if (this.canHit(side) && !c.whiff) {
      c.wait -= dt;
      if (c.wait <= 0) {
        this.swing(side, this.rng() < 0.25 + this.level * 0.3 ? 'smash' : 'lob', this.rng() * 2 - 1);
        c.wait = 0.1 + (1 - this.level) * 0.25; c.err = null;
      }
    }
  }

  timeToGround() {
    const b = this.ball, h = GY - BR - b.y, a = 0.5 * G, bb = b.vy, disc = bb * bb + 4 * a * h;
    return disc < 0 ? 0 : Math.max(0, (-bb + Math.sqrt(disc)) / (2 * a));
  }

  snapshot() {
    const b = this.ball, r = (v) => Math.round(v * 10) / 10;
    return {
      ph: this.phase, sc: this.score.slice(), k: this.tick,
      b: [r(b.x), r(b.y), r(b.vx), r(b.vy), b.bounces, b.recv, b.lastHit],
      p: this.p.map((q) => [r(q.x), q.swing > 0 ? 1 : 0, r(q.swing)]),
    };
  }
}

OneBounce.C = { W, H, GY, BR, NET_X, NET_H, REACH_X, REACH_Y, WIN };
module.exports = { OneBounce, C: OneBounce.C };
