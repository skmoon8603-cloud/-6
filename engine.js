'use strict';
/**
 * 서버 권한 축구 엔진. 모든 물리/충돌/골 판정/점수/시간은 여기서만 결정된다.
 * 클라이언트는 입력(이동 벡터, 질주, 슛/패스/교체 요청)만 보낸다.
 */
const K = require('./const');
const C = require('./catalog');
const AI = require('./ai');

const { W, H, GOAL_W, GOAL_D, PR, BR, POST_R } = K;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const angDiff = (a, b) => { let d = (b - a) % (Math.PI * 2); if (d > Math.PI) d -= Math.PI * 2; if (d < -Math.PI) d += Math.PI * 2; return d; };
const lerpAng = (a, b, t) => a + angDiff(a, b) * t;
const r1 = (v) => Math.round(v * 10) / 10;

// 팀0 기준 포메이션 [x, y]. 팀1은 180도 회전.
const FORM = [
  [110, H / 2],           // GK
  [400, H / 2 - 205],     // DF
  [400, H / 2 + 205],     // DF
  [600, H / 2],           // MF
  [760, H / 2 - 290],     // FW
  [760, H / 2 + 290],     // FW
];

class Match {
  /**
   * @param {{lineups:string[][], invs:object[], bots:boolean[], seconds?:number, rng?:Function}} o
   */
  constructor(o) {
    this.seconds = o.seconds || K.MATCH_SECONDS;
    this.timeLeft = this.seconds;
    this.rng = o.rng || Math.random;
    this.score = [0, 0];
    this.events = [];
    this.tick = 0;
    this.paused = false;
    this.result = null;
    this.roster = [[], []];
    this.players = [];
    this.teams = [0, 1].map((side) => ({
      side, bot: !!o.bots[side], ctrl: 4, input: { mx: 0, my: 0, sprint: false }, queue: [],
      receiver: -1, receiverUntil: 0, lastSwitch: -9, switchN: 0, freeze: 0,
    }));
    for (let side = 0; side < 2; side++) {
      for (let slot = 0; slot < K.TEAM_SIZE; slot++) {
        const id = o.lineups[side][slot];
        const meta = C.BY_ID[id];
        const st = C.statsFor(id, o.invs[side]);
        const p = {
          i: side * K.TEAM_SIZE + slot, side, slot, pos: C.SLOTS[slot], st, id,
          x: 0, y: 0, vx: 0, vy: 0, ang: side === 0 ? 0 : Math.PI, stam: 100, tired: false,
          kickCd: 0, kickAnim: 0, tackleCd: 0, hold: 0, skill: o.bots[side] ? K.BOT_SKILL : K.MATE_SKILL, aiNoise: 0, think: 0, dx: 0, dy: 0, sp: false, boost: 1, catchCd: 0, diving: 0,
          maxSpd: (115 + st.spd * 0.95) * (C.SLOTS[slot] === 'GK' ? K.GK_SPEED_MUL : 1),
        };
        this.players.push(p);
        this.roster[side].push({ id, name: meta.name, num: meta.number, pos: C.SLOTS[slot], rar: meta.rarity, c1: meta.c1, c2: meta.c2, ovr: meta.ovr });
      }
    }
    this.vest = Math.random() < 0.5 ? 0 : 1; // 조끼 색: 0이면 팀0=빨강/팀1=파랑, 1이면 반대 (경기마다 랜덤)
    this.ball = { x: W / 2, y: H / 2, vx: 0, vy: 0, last: -1, lastSide: -1, owner: -1 };
    this.stats = { shots: [0, 0], passes: [0, 0], poss: [0, 0], goals: [] }; // 경기 기록 (결과 화면용)
    this.pst = this.players.map(() => ({ shots: 0, goals: 0 }));
    this.kickTeam = this.rng() < 0.5 ? 0 : 1;
    this.phase = 'countdown';
    this.phaseT = K.COUNTDOWN;
    this.resetPositions(this.kickTeam);
  }

  // ───────────── 상태 관리 ─────────────
  resetPositions(kickSide) {
    for (const p of this.players) {
      const f = FORM[p.slot];
      p.x = p.side === 0 ? f[0] : W - f[0];
      p.y = p.side === 0 ? f[1] : H - f[1];
      p.vx = p.vy = 0; p.hold = 0; p.kickCd = 0; p.boost = 1; p.diving = 0;
      p.ang = p.side === 0 ? 0 : Math.PI;
      p.stam = Math.max(p.stam, 60);
    }
    const t = this.players[kickSide * K.TEAM_SIZE + 4];
    t.x = kickSide === 0 ? W / 2 - 28 : W / 2 + 28; t.y = H / 2;
    Object.assign(this.ball, { x: W / 2, y: H / 2, vx: 0, vy: 0, owner: -1, last: -1, lastSide: -1 });
    for (const tm of this.teams) { tm.ctrl = 4; tm.queue.length = 0; tm.receiver = -1; tm.freeze = tm.side === kickSide ? 0 : 1.6; tm.input.mx = tm.input.my = 0; }
  }

  setInput(side, mx, my, sprint) {
    const tm = this.teams[side];
    if (!tm || tm.bot) return;
    mx = Number.isFinite(mx) ? clamp(mx, -1, 1) : 0;
    my = Number.isFinite(my) ? clamp(my, -1, 1) : 0;
    const l = Math.hypot(mx, my);
    if (l > 1) { mx /= l; my /= l; }
    tm.input.mx = mx; tm.input.my = my; tm.input.sprint = !!sprint;
  }

  act(side, type, power) {
    const tm = this.teams[side];
    if (!tm || tm.bot || tm.queue.length >= 4) return;
    if (type === 'shoot') tm.queue.push({ t: 'shoot', p: clamp(Number.isFinite(power) ? power : 0.55, 0.55, 1) });
    else if (type === 'pass' || type === 'switch') tm.queue.push({ t: type });
  }

  // ───────────── 메인 업데이트 ─────────────
  update(dt) {
    this.tick++;
    if (this.paused || this.phase === 'ended') return;
    if (this.phase === 'countdown') {
      this.phaseT -= dt;
      if (this.phaseT <= 0) { this.phase = 'play'; this.events.push({ type: 'whistle' }); }
      return;
    }
    if (this.phase === 'goal') {
      this.phaseT -= dt;
      this.moveBall(dt, false);
      if (this.phaseT <= 0) {
        if (this.timeLeft <= 0) return this.finish();
        this.kickTeam = 1 - this.lastScorer;
        this.resetPositions(this.kickTeam);
        this.phase = 'countdown'; this.phaseT = 1.6;
        this.events.push({ type: 'kickoff' });
      }
      return;
    }
    // play
    this.timeLeft -= dt;
    if (this.timeLeft <= 0) { this.timeLeft = 0; return this.finish(); }
    this.stepPlay(dt);
  }

  /** 결과 화면용 경기 요약: 슈팅/패스/점유율, 득점 기록, MVP */
  summary() {
    const s = this.stats, tot = Math.max(1, s.poss[0] + s.poss[1]);
    let best = null, bs = 0;
    this.players.forEach((p, i) => { const sc = this.pst[i].goals * 4 + this.pst[i].shots; if (sc > bs) { bs = sc; best = p; } });
    return {
      shots: s.shots.slice(), passes: s.passes.slice(), poss: [Math.round((s.poss[0] / tot) * 100), 100 - Math.round((s.poss[0] / tot) * 100)],
      goals: s.goals.map((g) => ({ ...g })),
      mvp: best ? { name: this.roster[best.side][best.slot].name, num: this.roster[best.side][best.slot].num, side: best.side, goals: this.pst[best.i].goals, shots: this.pst[best.i].shots } : null,
    };
  }

  finish() {
    this.phase = 'ended';
    const [a, b] = this.score;
    this.result = { score: [a, b], winner: a > b ? 0 : b > a ? 1 : -1 };
    this.events.push({ type: 'end', result: this.result });
  }

  stepPlay(dt) {
    for (const tm of this.teams) this.processQueue(tm);
    AI.prepare(this);
    for (const tm of this.teams) {
      if (tm.freeze > 0) tm.freeze -= dt;
      for (let s = 0; s < K.TEAM_SIZE; s++) {
        const p = this.players[tm.side * K.TEAM_SIZE + s];
        p.kickCd = Math.max(0, p.kickCd - dt); p.kickAnim = Math.max(0, p.kickAnim - dt);
        p.catchCd = Math.max(0, p.catchCd - dt); p.tackleCd = Math.max(0, p.tackleCd - dt); p.diving = Math.max(0, p.diving - dt);
        p.boost = 1;
        const human = !tm.bot && tm.ctrl === s;
        if (human) {
          p.dx = tm.input.mx; p.dy = tm.input.my; p.sp = tm.input.sprint;
          if (Math.hypot(p.dx, p.dy) > 0.2) p.ang = Math.atan2(p.dy, p.dx);
        } else if (tm.freeze > 0 && Math.hypot(this.ball.vx, this.ball.vy) < 5) {
          p.dx = p.dy = 0; p.sp = false;
        } else {
          AI.think(this, p, dt);
        }
      }
    }
    for (const p of this.players) this.movePlayer(p, dt);
    this.separate();
    const ow = this.ball.owner >= 0 ? this.players[this.ball.owner] : null; if (ow) this.stats.poss[ow.side]++;
    this.moveBall(dt, true);
  }

  movePlayer(p, dt) {
    const mag = Math.min(1, Math.hypot(p.dx, p.dy));
    let sprinting = false;
    if (mag > 0.1) {
      if (p.sp && p.stam > 0 && !p.tired) sprinting = true;
    }
    if (sprinting) {
      p.stam -= 18 * (1.5 - p.st.sta / 100) * dt;
      if (p.stam <= 0) { p.stam = 0; p.tired = true; }
    } else {
      p.stam = Math.min(100, p.stam + (9 + p.st.sta * 0.08) * dt);
      if (p.tired && p.stam >= 20) p.tired = false;
    }
    p.sprinting = sprinting;
    let spd = p.maxSpd * (sprinting ? K.SPRINT_MUL : 1) * (p.tired ? 0.82 : 1) * p.boost;
    const l = Math.hypot(p.dx, p.dy) || 1;
    const tvx = mag > 0.05 ? (p.dx / l) * spd * mag : 0;
    const tvy = mag > 0.05 ? (p.dy / l) * spd * mag : 0;
    const acc = 1250 * dt;
    let ax = tvx - p.vx, ay = tvy - p.vy;
    const al = Math.hypot(ax, ay);
    if (al > acc) { ax = (ax / al) * acc; ay = (ay / al) * acc; }
    p.vx += ax; p.vy += ay;
    p.x = clamp(p.x + p.vx * dt, PR, W - PR);
    p.y = clamp(p.y + p.vy * dt, PR, H - PR);
    if ((p.x <= PR && p.vx < 0) || (p.x >= W - PR && p.vx > 0)) p.vx = 0;
    if ((p.y <= PR && p.vy < 0) || (p.y >= H - PR && p.vy > 0)) p.vy = 0;
  }

  separate() {
    const ps = this.players;
    for (let i = 0; i < ps.length; i++) for (let j = i + 1; j < ps.length; j++) {
      const a = ps[i], b = ps[j];
      let dx = b.x - a.x, dy = b.y - a.y;
      const d = Math.hypot(dx, dy), min = PR * 2 - 2;
      if (d < min && d > 0.001) {
        const o = (min - d) / 2; dx /= d; dy /= d;
        a.x -= dx * o; a.y -= dy * o; b.x += dx * o; b.y += dy * o;
        const rv = (b.vx - a.vx) * dx + (b.vy - a.vy) * dy;
        if (rv < 0) { a.vx += dx * rv * 0.5; a.vy += dy * rv * 0.5; b.vx -= dx * rv * 0.5; b.vy -= dy * rv * 0.5; }
      }
    }
  }

  // ───────────── 공 ─────────────
  moveBall(dt, live) {
    const b = this.ball;
    if (live) this.playerBall(dt);
    const f = Math.exp(-K.BALL_FRICTION * dt);
    b.vx *= f; b.vy *= f;
    if (Math.hypot(b.vx, b.vy) < 3) { b.vx = 0; b.vy = 0; }
    // 속도가 매우 빠를 때 터널링 방지: 서브스텝
    const sp = Math.hypot(b.vx, b.vy);
    const n = Math.max(1, Math.ceil((sp * dt) / 6));
    for (let k = 0; k < n; k++) {
      b.x += (b.vx * dt) / n; b.y += (b.vy * dt) / n;
      this.ballWalls(live);
      if (live && this.phase === 'play') this.checkGoal();
    }
  }

  ballWalls(live) {
    const b = this.ball;
    const inMouth = Math.abs(b.y - H / 2) < GOAL_W / 2;
    // 골대 기둥 (4개)
    for (const px of [0, W]) for (const sy of [-1, 1]) {
      const qx = px, qy = H / 2 + (sy * GOAL_W) / 2;
      let dx = b.x - qx, dy = b.y - qy; const d = Math.hypot(dx, dy), m = BR + POST_R;
      if (d < m && d > 0.001) {
        dx /= d; dy /= d; b.x = qx + dx * m; b.y = qy + dy * m;
        const vn = b.vx * dx + b.vy * dy;
        if (vn < 0) { b.vx -= 1.7 * vn * dx; b.vy -= 1.7 * vn * dy; this.events.push({ type: 'post' }); }
      }
    }
    // 위/아래 벽
    const yMin = BR, yMax = H - BR;
    if (b.y < yMin && (b.x >= 0 && b.x <= W)) { b.y = yMin; b.vy = Math.abs(b.vy) * 0.72; b.vx *= 0.96; }
    if (b.y > yMax && (b.x >= 0 && b.x <= W)) { b.y = yMax; b.vy = -Math.abs(b.vy) * 0.72; b.vx *= 0.96; }
    // 좌/우 벽 (골 입구 제외)
    if (b.x < BR && !inMouth) { b.x = BR; b.vx = Math.abs(b.vx) * 0.72; }
    if (b.x > W - BR && !inMouth) { b.x = W - BR; b.vx = -Math.abs(b.vx) * 0.72; }
    // 골대 안쪽 (네트)
    if (b.x < 0 || b.x > W) {
      const lim = GOAL_W / 2 - BR;
      if (b.y < H / 2 - lim) { b.y = H / 2 - lim; b.vy = Math.abs(b.vy) * 0.4; }
      if (b.y > H / 2 + lim) { b.y = H / 2 + lim; b.vy = -Math.abs(b.vy) * 0.4; }
      if (b.x < -GOAL_D) { b.x = -GOAL_D; b.vx = Math.abs(b.vx) * 0.2; b.vy *= 0.6; }
      if (b.x > W + GOAL_D) { b.x = W + GOAL_D; b.vx = -Math.abs(b.vx) * 0.2; b.vy *= 0.6; }
    }
  }

  checkGoal() {
    const b = this.ball;
    if (Math.abs(b.y - H / 2) >= GOAL_W / 2) return;
    let scorer = -1;
    if (b.x > W + 4) scorer = 0;
    else if (b.x < -4) scorer = 1;
    if (scorer < 0) return;
    this.score[scorer]++;
    this.lastScorer = scorer;
    // 득점자: 마지막으로 공을 찬 선수 (자책골이면 상대 팀 득점 처리, 이름은 자책)
    const lp = b.last >= 0 ? this.players[b.last] : null;
    const own = lp && lp.side !== scorer;
    this.phase = 'goal'; this.phaseT = K.GOAL_PAUSE;
    this.stats.goals.push({ side: scorer, by: lp ? this.roster[lp.side][lp.slot].name : '', num: lp ? this.roster[lp.side][lp.slot].num : 0, own: !!own, min: Math.max(1, Math.ceil((K.MATCH_SECONDS - this.timeLeft) / K.MATCH_SECONDS * 90)) });
    if (lp && !own) this.pst[lp.i].goals++;
    this.events.push({
      type: 'goal', side: scorer, score: [this.score[0], this.score[1]],
      by: lp ? this.roster[lp.side][lp.slot].name : '', num: lp ? this.roster[lp.side][lp.slot].num : 0, own: !!own,
    });
  }

  /** 공과 선수 접촉: 드리블 보조, 충돌, 골키퍼 캐치 */
  playerBall(dt) {
    const b = this.ball;
    // 드리블 소유자 결정. 상대가 공을 가진 선수에게서 뺏으려면 '태클 판정'을 통과해야 한다.
    // 성공 확률은 태클하는 선수의 수비 능력이 높을수록, 공 가진 선수의 볼 컨트롤이 낮을수록 높다.
    let best = null, bestEff = 1e9;
    for (const p of this.players) {
      if (p.kickCd > 0) continue;
      const d = Math.hypot(b.x - p.x, b.y - p.y);
      if (d > PR + BR + 10) continue;
      let eff = d;
      if (b.owner === p.i) eff -= 3;
      if (eff < bestEff) { bestEff = eff; best = p; }
    }
    const carrier = b.owner >= 0 ? this.players[b.owner] : null;
    if (carrier && Math.hypot(b.x - carrier.x, b.y - carrier.y) <= PR + BR + 12) {
      // 가장 가까운 상대 선수가 태클을 시도한다
      let opp = null, od = 1e9;
      for (const q of this.players) {
        if (q.side === carrier.side || q.kickCd > 0) continue;
        const d = Math.hypot(b.x - q.x, b.y - q.y);
        if (d <= PR + BR + 10 && d < od) { od = d; opp = q; }
      }
      if (opp) {
        best = carrier;
        if (opp.tackleCd <= 0) {
          const ctl = carrier.st.dri; // 드리블이 높을수록 공을 잘 안 뺏긴다
          const chance = clamp(0.22 + (opp.st.def - ctl) * 0.007, 0.05, 0.7);
          if (this.rng() < chance) { best = opp; carrier.kickCd = 0.35; opp.tackleCd = 0.5; this.events.push({ type: 'save' }); } // 뺏기 성공
          else { opp.tackleCd = 0.8; opp.vx *= 0.35; opp.vy *= 0.35; } // 실패: 태클한 선수가 주춤
        }
      }
    }
    if (best) {
      const p = best;
      const sp = Math.hypot(p.vx, p.vy);
      const ctl = (p.st.dri * 2 + p.st.spd) / 3;
      if (p.pos === 'GK' && p.catchCd <= 0 && Math.hypot(b.vx, b.vy) < 650 + p.st.gk * 2) {
        // 골키퍼 캐치
        const spd = Math.hypot(b.vx, b.vy);
        const chance = clamp(0.35 + p.st.gk / 170 - spd / 2200, 0.15, 0.97);
        p.catchCd = 0.8;
        if (this.rng() < chance) { b.vx = b.vy = 0; p.hold = 0.55; b.owner = p.i; b.last = p.i; b.lastSide = p.side; this.autoCtrl(p); this.events.push({ type: 'save' }); return; }
      }
      b.owner = p.i; b.last = p.i; b.lastSide = p.side; this.autoCtrl(p);
      if (sp > 15 || Math.hypot(b.vx, b.vy) < 80) {
        const tx = p.x + Math.cos(p.ang) * (PR + BR + 3), ty = p.y + Math.sin(p.ang) * (PR + BR + 3);
        const k = Math.min(1, dt * (7 + ctl * 0.07));
        b.vx += (p.vx * 1.02 + (tx - b.x) * 9 - b.vx) * k;
        b.vy += (p.vy * 1.02 + (ty - b.y) * 9 - b.vy) * k;
      }
    } else if (b.owner >= 0) {
      const o = this.players[b.owner];
      if (Math.hypot(b.x - o.x, b.y - o.y) > PR + BR + 24) b.owner = -1;
    }
    // 물리 충돌 (밀어내기 + 반발)
    for (const p of this.players) {
      const rad = p.pos === 'GK' && p.diving > 0 ? PR + 9 : PR;
      let dx = b.x - p.x, dy = b.y - p.y; const d = Math.hypot(dx, dy), m = rad + BR;
      if (d < m && d > 0.001) {
        dx /= d; dy /= d; b.x = p.x + dx * m; b.y = p.y + dy * m;
        const vr = (b.vx - p.vx) * dx + (b.vy - p.vy) * dy;
        if (vr < 0 && p.kickCd <= 0) {
          const e = p.pos === 'GK' ? 0.55 : 0.35;
          b.vx -= (1 + e) * vr * dx; b.vy -= (1 + e) * vr * dy;
          if (Math.abs(vr) > 120) { b.last = p.i; b.lastSide = p.side; }
        }
      }
    }
  }

  /** 공을 잡으면 그 선수를 자동으로 조종 (사람이 조작하는 팀) */
  autoCtrl(p) { const tm = this.teams[p.side]; if (!tm.bot && tm.ctrl !== p.slot) tm.ctrl = p.slot; }

  canReach(p) { return Math.hypot(this.ball.x - p.x, this.ball.y - p.y) <= PR + BR + 12; }

  kick(p, ang, speed) {
    const b = this.ball;
    b.vx = Math.cos(ang) * speed + p.vx * 0.25;
    b.vy = Math.sin(ang) * speed + p.vy * 0.25;
    b.last = p.i; b.lastSide = p.side; b.owner = -1;
    p.kickCd = 0.32; p.kickAnim = 0.22; p.hold = 0; p.ang = ang;
    const sx = Math.cos(ang) * (PR + BR + 2), sy = Math.sin(ang) * (PR + BR + 2);
    b.x = p.x + sx; b.y = p.y + sy;
    this.events.push({ type: 'kick', pw: speed });
  }

  doShoot(p, power) {
    p.kickAnim = 0.2;
    if (!this.canReach(p)) return false;
    const dir = p.side === 0 ? 1 : -1;
    const gx = p.side === 0 ? W : 0;
    let ang = p.ang;
    const a0 = Math.atan2(H / 2 - p.y, gx - p.x);
    if (Math.abs(angDiff(ang, a0)) < 0.85 && (gx - p.x) * dir < 520) {
      // 에임 어시스트: 상대 골키퍼 반대편 구석을 노린다
      const gk = this.players[(1 - p.side) * K.TEAM_SIZE];
      const aimY = H / 2 + (gk.y > H / 2 ? -1 : 1) * (GOAL_W / 2 - 34);
      const a1 = Math.atan2(aimY - p.y, gx - p.x);
      ang = lerpAng(ang, a1, 0.7);
    }
    ang += (this.rng() - 0.5) * 2 * (0.015 + ((100 - p.st.sht) / 100) * 0.11 + p.aiNoise);
    const speed = (380 + p.st.sht * 5) * (0.5 + 0.5 * power);
    this.kick(p, ang, speed);
    this.stats.shots[p.side]++; this.pst[p.i].shots++;
    return true;
  }

  /** @param aiMode true 이면 전진 패스를 선호 */
  doPass(p, aiMode) {
    p.kickAnim = 0.2;
    if (!this.canReach(p)) return false;
    const dir = p.side === 0 ? 1 : -1;
    const base = aiMode ? (p.side === 0 ? 0 : Math.PI) : p.ang;
    let best = null, bestScore = 1e9;
    const opp = this.players.filter((q) => q.side !== p.side);
    for (let s = 0; s < K.TEAM_SIZE; s++) {
      const t = this.players[p.side * K.TEAM_SIZE + s];
      if (t === p) continue;
      const vx = t.x - p.x, vy = t.y - p.y, d = Math.hypot(vx, vy);
      if (d < 70) continue;
      const diff = Math.abs(angDiff(aiMode ? Math.atan2(vy, vx) : p.ang, aiMode ? base : Math.atan2(vy, vx)));
      if (!aiMode && diff > 0.95) continue;
      let sc = diff * 1.4 + Math.abs(d - 300) / 450;
      if (aiMode) {
        sc -= ((t.x - p.x) * dir) / 700;
        if (t.pos === 'GK') sc += 1.2;
        for (const o of opp) { // 패스 길목 차단 여부
          const t0 = ((o.x - p.x) * vx + (o.y - p.y) * vy) / (d * d);
          if (t0 > 0 && t0 < 1 && Math.hypot(p.x + vx * t0 - o.x, p.y + vy * t0 - o.y) < 38) sc += 1.0;
        }
      }
      if (sc < bestScore) { bestScore = sc; best = t; }
    }
    if (!best) { this.kick(p, p.ang, 380); return true; }
    const vx = best.x - p.x, vy = best.y - p.y, d = Math.hypot(vx, vy);
    const spd = clamp(d * 1.45 + 150, 230, 780) * (0.9 + p.st.pas / 900);
    const lead = Math.min(0.6, d / spd) * 0.75;
    const tx = best.x + best.vx * lead, ty = best.y + best.vy * lead;
    let ang = Math.atan2(ty - p.y, tx - p.x);
    ang += (this.rng() - 0.5) * 2 * (0.01 + ((100 - p.st.pas) / 100) * 0.07 + p.aiNoise);
    this.kick(p, ang, spd); this.stats.passes[p.side]++;
    const tm = this.teams[p.side];
    tm.receiver = best.i; tm.receiverUntil = this.tick + 100;
    if (!tm.bot && tm.ctrl === p.slot) tm.ctrl = best.slot; // 수신자로 자동 전환
    return true;
  }

  processQueue(tm) {
    while (tm.queue.length) {
      const a = tm.queue.shift();
      const p = this.players[tm.side * K.TEAM_SIZE + tm.ctrl];
      if (a.t === 'shoot') this.doShoot(p, a.p);
      else if (a.t === 'pass') this.doPass(p, false);
      else if (a.t === 'switch') this.switchPlayer(tm);
    }
  }

  switchPlayer(tm) {
    const b = this.ball;
    const dir = tm.side === 0 ? 1 : -1;
    const ownGoalX = tm.side === 0 ? 0 : W;
    const cands = [];
    for (let s = 0; s < K.TEAM_SIZE; s++) {
      const p = this.players[tm.side * K.TEAM_SIZE + s];
      if (s === 0 && Math.abs(b.x - ownGoalX) > 230) continue; // 골키퍼는 공이 가까울 때만
      cands.push({ s, d: Math.hypot(p.x - b.x, p.y - b.y) });
    }
    cands.sort((a, c) => a.d - c.d);
    const now = this.tick;
    tm.switchN = now - tm.lastSwitch < 40 ? tm.switchN + 1 : 0;
    tm.lastSwitch = now;
    const list = cands.filter((c) => c.s !== tm.ctrl);
    if (!list.length) return;
    tm.ctrl = list[tm.switchN % list.length].s;
  }

  // ───────────── 스냅샷 ─────────────
  snapshot() {
    const b = this.ball;
    return {
      ph: this.phase, tm: r1(this.timeLeft), pt: r1(Math.max(0, this.phaseT)), sc: this.score,
      b: [r1(b.x), r1(b.y), r1(b.vx), r1(b.vy)],
      p: this.players.map((p) => [r1(p.x), r1(p.y), Math.round(p.ang * 100) / 100, Math.round(p.stam), (p.kickAnim > 0 ? 1 : 0) | (p.sprinting ? 2 : 0) | (p.hold > 0 ? 4 : 0)]),
      c: [this.teams[0].ctrl, this.teams[1].ctrl],
      k: this.tick,
    };
  }
}

module.exports = { Match, FORM };
