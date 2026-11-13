'use strict';
/**
 * 원 바운스 (ONE BOUNCE) — 새로운 미니게임.
 * 규칙: 상대가 보낸 공은 내 코트 바닥에 "딱 한 번" 튕긴 뒤에만 칠 수 있다.
 *  - 튕기기 전에 치면 (발리) 반칙 → 상대 득점
 *  - 두 번 튕기도록 못 치면 → 상대 득점
 *  - 내가 친 공이 상대 코트에 먼저 닿지 않으면(내 코트/네트) → 상대 득점
 * 7점 선취. 혼자서 CPU와 대결한다.
 */
(function (root) {
  const W = 800, H = 450, GY = 340, BR = 12, NET_X = W / 2, NET_H = 74, G = 1500;
  const REACH_X = 58, REACH_Y = 150;
  const WIN = 7;
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  class OneBounce {
    constructor(opts = {}) {
      this.rng = opts.rng || Math.random;
      this.level = opts.level == null ? 0.6 : opts.level; // CPU 실력 0~1
      this.score = [0, 0];
      this.server = 0;
      this.p = [{ x: 150, vx: 0, swing: 0, cd: 0 }, { x: W - 150, vx: 0, swing: 0, cd: 0 }];
      this.ev = []; // 이벤트 {t:'hit'|'bounce'|'point'|'fault', ...}
      this.phase = 'serve'; this.phaseT = 1.0; this.over = false; this.winner = -1;
      this.cpu = { target: W - 150, wait: 0, want: 'lob' };
      this.ball = { x: 0, y: 0, vx: 0, vy: 0, lastHit: 0, bounces: 0, recv: 0 };
      this.startServe();
    }

    startServe() {
      const s = this.server;
      const x = s === 0 ? 150 : W - 150;
      this.p[0].x = 150; this.p[1].x = W - 150;
      Object.assign(this.ball, { x, y: GY - 230, vx: 0, vy: 0, lastHit: 1 - s, bounces: 0, recv: s });
      this.phase = 'play';
      this.cpu.wait = 0.4 + (1 - this.level) * 0.5;
    }

    /** 사람 입력: move -1/0/1 */
    setMove(side, m) { this.p[side].vx = m * 300; }

    /** 공을 칠 수 있는지 판정. 반환: 'ok' | 'miss' | 'volley' */
    canHit(side) {
      const b = this.ball, p = this.p[side];
      if (b.lastHit === side) return 'miss';
      if (Math.abs(b.x - p.x) > REACH_X || b.y < GY - REACH_Y || b.y > GY + 2) return 'miss';
      if (b.bounces === 0) return 'volley';
      return b.recv === side && b.bounces === 1 ? 'ok' : 'miss';
    }

    /** 스윙. kind: 'lob'(높게) | 'smash'(강하게). */
    swing(side, kind, aim) {
      const p = this.p[side];
      if (this.phase !== 'play' || p.cd > 0) return;
      p.cd = 0.35; p.swing = 0.2;
      const r = this.canHit(side);
      if (r === 'miss') return;
      if (r === 'volley') return this.fault(side, 'volley');
      const b = this.ball;
      // 착지 목표: 상대 코트 안 (aim: -1 앞쪽(네트 근처) ~ 1 뒤쪽)
      const a = aim == null ? this.rng() * 2 - 1 : aim;
      let tx = side === 0 ? NET_X + 90 + (a + 1) / 2 * (W - 60 - NET_X - 90) : NET_X - 90 - (a + 1) / 2 * (NET_X - 60);
      // 서투름: 높은 곳/먼 곳에서 칠수록 약간 흔들림
      tx += (this.rng() - 0.5) * 60;
      let T = kind === 'smash' ? 0.62 : 1.05;
      let vx, vy;
      for (let k = 0; k < 14; k++) {
        vx = (tx - b.x) / T;
        vy = (GY - b.y - 0.5 * G * T * T) / T;
        // 네트 통과 높이 확인
        const tn = (NET_X - b.x) / vx;
        if (tn > 0 && tn < T) {
          const yn = b.y + vy * tn + 0.5 * G * tn * tn;
          if (yn > GY - NET_H - BR - 10) { T += 0.07; continue; }
        }
        break;
      }
      b.vx = vx; b.vy = vy; b.lastHit = side; b.bounces = 0; b.recv = 1 - side;
      this.ev.push({ t: 'hit', side, kind });
    }

    fault(side, why) { this.ev.push({ t: 'fault', side, why }); this.point(1 - side, why); }

    point(side, why) {
      this.score[side]++;
      this.ev.push({ t: 'point', side, why, score: this.score.slice() });
      if (this.score[side] >= WIN) { this.over = true; this.winner = side; this.phase = 'over'; return; }
      this.server = side; this.phase = 'point'; this.phaseT = 1.3;
    }

    update(dt) {
      if (this.over) return;
      for (const p of this.p) { p.cd = Math.max(0, p.cd - dt); p.swing = Math.max(0, p.swing - dt); }
      if (this.phase === 'point') { this.phaseT -= dt; if (this.phaseT <= 0) this.startServe(); return; }
      if (this.phase !== 'play') return;
      this.cpuThink(dt);
      // 이동 (각자 자기 코트 안)
      for (let i = 0; i < 2; i++) {
        const p = this.p[i];
        const lo = i === 0 ? 30 : NET_X + 40, hi = i === 0 ? NET_X - 40 : W - 30;
        p.x = clamp(p.x + p.vx * dt, lo, hi);
      }
      this.moveBall(dt);
    }

    moveBall(dt) {
      const b = this.ball;
      const n = 4, h = dt / n;
      for (let k = 0; k < n && this.phase === 'play'; k++) {
        const px = b.x;
        b.vy += G * h; b.x += b.vx * h; b.y += b.vy * h;
        // 좌우 벽
        if (b.x < BR) { b.x = BR; b.vx = Math.abs(b.vx) * 0.6; }
        if (b.x > W - BR) { b.x = W - BR; b.vx = -Math.abs(b.vx) * 0.6; }
        // 네트
        if ((px - NET_X) * (b.x - NET_X) <= 0 && b.y > GY - NET_H - BR * 0.5) {
          this.ev.push({ t: 'net' });
          return this.fault(b.lastHit, 'net');
        }
        // 바닥
        if (b.y >= GY - BR && b.vy > 0) {
          b.y = GY - BR;
          const side = b.x < NET_X ? 0 : 1;
          this.ev.push({ t: 'bounce', x: b.x });
          if (b.bounces === 0) {
            // 첫 바운드는 받는 사람의 코트여야 한다 (서브는 서버 자기 코트가 받는 쪽)
            if (side !== b.recv) return this.fault(b.lastHit, 'own');
            b.bounces = 1;
            b.vy = -Math.abs(b.vy) * 0.72; b.vx *= 0.88;
          } else {
            // 두 번째 바운드: 그 코트의 주인이 못 친 것
            return this.fault(side, 'double');
          }
        }
      }
    }

    // ─── CPU ───
    cpuThink(dt) {
      const side = 1, p = this.p[1], b = this.ball, c = this.cpu;
      const sp = 190 + this.level * 130;
      let tx = p.x;
      if (b.recv === side) {
        // 내 쪽으로 오는 공: 착지점 예측 → 바운드 후엔 공을 따라간다
        if (b.bounces === 0) {
          const t = this.timeToGround();
          const lx = clamp(b.x + b.vx * t, NET_X + 40, W - 30);
          tx = lx + (b.vx > 0 ? 18 : -18) * 0.6 + (this.rng() - 0.5) * 0.001;
          c.err = c.err == null ? (this.rng() - 0.5) * (1 - this.level) * 90 : c.err;
          tx += c.err;
        } else {
          tx = b.x;
        }
      } else { tx = W - 150; c.err = null; }
      const d = tx - p.x;
      p.vx = Math.abs(d) < 6 ? 0 : Math.sign(d) * Math.min(sp, Math.abs(d) * 8);
      if (b.recv === side && b.bounces === 1 && this.canHit(1) === 'ok') {
        c.wait -= dt;
        if (c.wait <= 0) {
          const smash = this.rng() < 0.25 + this.level * 0.3;
          this.swing(1, smash ? 'smash' : 'lob', this.rng() * 2 - 1);
          c.wait = 0.12 + (1 - this.level) * 0.25; c.err = null;
        }
      }
    }

    timeToGround() {
      const b = this.ball, h = GY - BR - b.y;
      // b.y + vy t + .5 G t^2 = GY-BR
      const a = 0.5 * G, bb = b.vy, cc = -h;
      const disc = bb * bb - 4 * a * cc;
      return disc < 0 ? 0 : Math.max(0, (-bb + Math.sqrt(disc)) / (2 * a));
    }
  }

  OneBounce.C = { W, H, GY, BR, NET_X, NET_H, REACH_X, REACH_Y, WIN };
  if (typeof module !== 'undefined' && module.exports) { module.exports = { OneBounce }; return; }
  root.OneBounce = OneBounce;

  // ───────────── 화면/입력 (브라우저) ─────────────
  const $ = (id) => document.getElementById(id);
  let game = null, raf = 0, last = 0, cv, ctx, keys = {}, holdL = false, holdR = false, banner = '', bannerT = 0, flash = 0;
  const sfx = (k, a) => { try { root.RF && root.RF.sfx && root.RF.sfx(k, a); } catch (e) { /* noop */ } };

  function build() {
    if ($('scr-bounce')) return;
    const el = document.createElement('section');
    el.id = 'scr-bounce'; el.className = 'hidden';
    el.innerHTML = `
      <canvas id="bcv"></canvas>
      <div id="bScore"><b id="bsL">0</b><span>원 바운스</span><b id="bsR">0</b></div>
      <button id="bExit" aria-label="나가기">✕</button>
      <div id="bBanner" class="hidden"></div>
      <div id="bHelp">공이 내 코트에 <b>딱 한 번</b> 튕긴 뒤에 치세요! (초록 링 = 칠 수 있음)</div>
      <div id="bCtl">
        <div class="bpad"><button id="bL">◀</button><button id="bR">▶</button></div>
        <div class="bpad"><button id="bLob" class="bhit">높게<small>Space</small></button><button id="bSmash" class="bhit sm">강하게<small>K</small></button></div>
      </div>
      <div id="bResult" class="overlay hidden"><div class="sheet result">
        <div id="brTitle" class="res-title">WIN</div><div id="brScore" class="res-score">0 : 0</div>
        <div class="row"><button id="brAgain" class="btn primary">다시 하기</button><button id="brExit" class="btn">로비로</button></div>
      </div></div>`;
    document.body.appendChild(el);
    cv = $('bcv'); ctx = cv.getContext('2d');
    const hold = (id, on) => {
      const b = $(id);
      const dn = (e) => { e.preventDefault(); on(true); b.classList.add('down'); };
      const up = (e) => { e && e.preventDefault(); on(false); b.classList.remove('down'); };
      b.addEventListener('pointerdown', dn); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold('bL', (v) => { holdL = v; }); hold('bR', (v) => { holdR = v; });
    hold('bLob', (v) => { if (v) act('lob'); }); hold('bSmash', (v) => { if (v) act('smash'); });
    $('bExit').addEventListener('click', close); $('brExit').addEventListener('click', close);
    $('brAgain').addEventListener('click', start);
    addEventListener('keydown', (e) => {
      if ($('scr-bounce').classList.contains('hidden')) return;
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', ' ', 'a', 'd', 'k', 'j'].includes(k)) e.preventDefault();
      if (e.repeat) return;
      keys[k] = true;
      if (k === ' ' || k === 'j') act('lob'); else if (k === 'k') act('smash');
    });
    addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
    addEventListener('resize', fit);
  }

  function act(kind) {
    if (!game || game.over) return;
    // 방향키를 누르고 있으면 코스를 정한다: 네트 쪽 방향 = 앞쪽, 반대 = 뒤쪽
    const aim = holdR || keys.arrowright || keys.d ? 1 : holdL || keys.arrowleft || keys.a ? -1 : null;
    game.swing(0, kind, aim);
  }

  function fit() {
    if (!cv) return;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const vw = innerWidth, vh = innerHeight;
    cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    cv._s = Math.min(vw / W, vh / H) * dpr; cv._ox = (cv.width - W * cv._s) / 2; cv._oy = (cv.height - H * cv._s) / 2;
  }

  function start() {
    build(); fit();
    game = new OneBounce({ level: 0.55 });
    $('bResult').classList.add('hidden'); $('scr-bounce').classList.remove('hidden');
    $('bsL').textContent = '0'; $('bsR').textContent = '0';
    showBanner('준비! 공이 한 번 튕기면 치세요');
    cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(loop);
  }
  function close() {
    cancelAnimationFrame(raf); game = null;
    $('scr-bounce').classList.add('hidden');
  }
  function showBanner(t) { banner = t; bannerT = 1.4; const e = $('bBanner'); e.textContent = t; e.classList.remove('hidden'); }

  const WHY = { volley: '튕기기 전에 쳤어요 (반칙)', own: '내 코트에 떨어졌어요', net: '네트에 걸렸어요', double: '두 번 튕겼어요' };
  function events() {
    for (const e of game.ev) {
      if (e.t === 'hit') { sfx('kick', e.kind === 'smash' ? 700 : 400); flash = 0.12; }
      else if (e.t === 'bounce') sfx('post');
      else if (e.t === 'point') {
        $('bsL').textContent = e.score[0]; $('bsR').textContent = e.score[1];
        const mine = e.side === 0;
        sfx(mine ? 'goal' : 'save');
        showBanner((mine ? '득점! ' : '실점… ') + (WHY[e.why] ? '(' + (mine ? '상대: ' : '') + WHY[e.why] + ')' : ''));
      }
    }
    game.ev.length = 0;
    if (game.over && $('bResult').classList.contains('hidden')) {
      $('brTitle').textContent = game.winner === 0 ? 'WIN' : 'LOSE';
      $('brScore').textContent = game.score[0] + ' : ' + game.score[1];
      $('bResult').classList.remove('hidden');
    }
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.033, (now - last) / 1000); last = now;
    if (!game) return;
    const m = (holdR || keys.arrowright || keys.d ? 1 : 0) - (holdL || keys.arrowleft || keys.a ? 1 : 0);
    game.setMove(0, m);
    game.update(dt);
    events();
    bannerT -= dt; if (bannerT <= 0) $('bBanner').classList.add('hidden');
    flash = Math.max(0, flash - dt);
    draw(now / 1000);
  }

  function draw(t) {
    const s = cv._s;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#0b1a2e'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, cv._ox, cv._oy);
    // 배경
    const sky = ctx.createLinearGradient(0, 0, 0, GY); sky.addColorStop(0, '#16336b'); sky.addColorStop(1, '#2a5aa8');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, GY);
    ctx.fillStyle = '#1f8a4c'; ctx.fillRect(0, GY, W, H - GY);
    ctx.fillStyle = '#26a55c'; ctx.fillRect(0, GY, W, 8);
    // 코트 라인
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3;
    ctx.beginPath(); ctx.moveTo(20, GY + 2); ctx.lineTo(W - 20, GY + 2); ctx.stroke();
    // 네트
    ctx.fillStyle = '#e9eef8'; ctx.fillRect(NET_X - 3, GY - NET_H, 6, NET_H);
    ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(NET_X - 9, GY - NET_H, 18, NET_H);
    // 선수
    for (let i = 0; i < 2; i++) drawPlayer(i);
    // 공
    const b = game.ball;
    const ok = game.phase === 'play' && game.canHit(0) === 'ok';
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(b.x, GY + 2, BR * (1 - Math.min(0.5, (GY - b.y) / 700)), 4, 0, 0, 6.2832); ctx.fill();
    if (b.recv === 0 && b.bounces === 1 && b.lastHit === 1 && game.phase === 'play') {
      ctx.strokeStyle = ok ? '#2cff8a' : 'rgba(44,255,138,.55)'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(b.x, b.y, BR + 7 + Math.sin(t * 10) * 2, 0, 6.2832); ctx.stroke();
    }
    const g = ctx.createRadialGradient(b.x - 3, b.y - 3, 1, b.x, b.y, BR + 1); g.addColorStop(0, '#fff'); g.addColorStop(1, '#cfd6e4');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(b.x, b.y, BR, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    // 바운드 표시
    ctx.fillStyle = '#fff'; ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(b.bounces === 0 ? '튕김 0' : '튕김 1 ✔', b.x, Math.max(16, b.y - BR - 12));
  }

  function drawPlayer(i) {
    const p = game.p[i], col = i === 0 ? '#2cff8a' : '#ff4d6a', dir = i === 0 ? 1 : -1;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(p.x, GY + 2, 24, 5, 0, 0, 6.2832); ctx.fill();
    // 몸
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(p.x - 17, GY - 62, 34, 56, 12) : ctx.rect(p.x - 17, GY - 62, 34, 56); ctx.fill();
    ctx.fillStyle = '#ffe2c4'; ctx.beginPath(); ctx.arc(p.x, GY - 76, 15, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(p.x + dir * 6, GY - 78, 2.4, 0, 6.2832); ctx.fill();
    // 팔 (스윙)
    const a = p.swing > 0 ? -1.2 + (0.2 - p.swing) / 0.2 * 2.2 : -0.3;
    ctx.strokeStyle = col; ctx.lineWidth = 9; ctx.lineCap = 'round';
    ctx.beginPath(); ctx.moveTo(p.x, GY - 50);
    ctx.lineTo(p.x + dir * Math.cos(a) * 44, GY - 50 + Math.sin(a) * 44); ctx.stroke();
  }

  root.RF = root.RF || {};
  root.RF.startBounce = start;
  addEventListener('DOMContentLoaded', () => { const b = $('btnBounce'); if (b) b.addEventListener('click', () => { sfx('tap'); start(); }); });
})(typeof window !== 'undefined' ? window : globalThis);
