'use strict';
/* RANDOM FOOTBALL - render.js : Canvas 경기장/선수/공/이펙트 렌더러 */
(function () {
  const RF = window.RF;
  const W = 1800, H = 1100, M = 78, GOAL_W = 270, GOAL_D = 70, PR = 15, BR = 8;
  const VEST = { red: '#e8363d', blue: '#2a74ff' };
  let TEAM_COL = [VEST.blue, VEST.red]; // [내 팀, 상대 팀] 조끼 색 — 경기마다 랜덤(R.setMatch)
  const R = (RF.Render = {});
  let cv, ctx, radar, rctx, dpr = 1, cw = 0, ch = 0, sc = 1;
  let pitch = null, pitchScale = 0;
  let side = 0, roster = null;
  const cam = { x: W / 2, y: H / 2, init: false };
  let shakeAmp = 0;
  const parts = [], rings = [], trail = [];
  let ballRot = 0, lastT = 0, time = 0;
  const dust = [];

  const flipX = (x) => (side ? W - x : x);
  const flipY = (y) => (side ? H - y : y);

  // ───────────── 경기장 사전 렌더링 ─────────────
  function buildPitch(s) {
    const c = document.createElement('canvas');
    c.width = Math.ceil((W + 2 * M) * s); c.height = Math.ceil((H + 2 * M) * s);
    const g = c.getContext('2d');
    g.scale(s, s); g.translate(M, M);
    // 관중석/바깥
    const bg = g.createLinearGradient(-M, -M, W + M, H + M);
    bg.addColorStop(0, '#0b1a2e'); bg.addColorStop(1, '#10223a');
    g.fillStyle = bg; g.fillRect(-M, -M, W + 2 * M, H + 2 * M);
    // 관중 점
    for (let i = 0; i < 700; i++) {
      const x = -M + Math.random() * (W + 2 * M), y = -M + Math.random() * (H + 2 * M);
      if (x > -30 && x < W + 30 && y > -30 && y < H + 30) continue;
      g.fillStyle = `hsl(${Math.random() * 360} 55% ${30 + Math.random() * 25}%)`;
      g.fillRect(x, y, 3, 3);
    }
    // 광고판
    const boards = ['#0f4c9a', '#c8102e', '#f5b700', '#0d8f5a', '#6d2fd1'];
    const bw = 70;
    for (let x = -30, i = 0; x < W + 30; x += bw, i++) {
      g.fillStyle = boards[i % 5]; g.fillRect(x, -30, bw - 4, 14); g.fillRect(x, H + 16, bw - 4, 14);
      g.fillStyle = '#ffffffcc'; g.fillRect(x + 6, -26, bw - 16, 2); g.fillRect(x + 6, H + 20, bw - 16, 2);
    }
    for (let y = -30, i = 0; y < H + 30; y += bw, i++) {
      g.fillStyle = boards[(i + 2) % 5]; g.fillRect(-30, y, 14, bw - 4); g.fillRect(W + 16, y, 14, bw - 4);
    }
    // 잔디 줄무늬
    g.save(); g.beginPath(); g.rect(-16, -16, W + 32, H + 32); g.clip();
    const n = 14, sw = (W + 32) / n;
    for (let i = 0; i < n; i++) { g.fillStyle = i % 2 ? '#2f9a4d' : '#37ab57'; g.fillRect(-16 + i * sw, -16, sw + 1, H + 32); }
    const sh = g.createRadialGradient(W / 2, H / 2, 120, W / 2, H / 2, W * 0.7);
    sh.addColorStop(0, 'rgba(255,255,255,.05)'); sh.addColorStop(1, 'rgba(0,0,0,.22)');
    g.fillStyle = sh; g.fillRect(-16, -16, W + 32, H + 32);
    g.restore();
    // 라인
    g.strokeStyle = 'rgba(255,255,255,.92)'; g.lineWidth = 3; g.lineCap = 'round';
    g.strokeRect(0, 0, W, H);
    g.beginPath(); g.moveTo(W / 2, 0); g.lineTo(W / 2, H); g.stroke();
    g.beginPath(); g.arc(W / 2, H / 2, 82, 0, 6.2832); g.stroke();
    g.fillStyle = '#fff'; g.beginPath(); g.arc(W / 2, H / 2, 4, 0, 6.2832); g.fill();
    for (const left of [true, false]) {
      const x0 = left ? 0 : W, dir = left ? 1 : -1;
      g.strokeRect(left ? 0 : W - 300, H / 2 - 310, 300, 620);
      g.strokeRect(left ? 0 : W - 100, H / 2 - 150, 100, 300);
      g.beginPath(); g.arc(x0 + dir * 215, H / 2, 4, 0, 6.2832); g.fill();
      g.beginPath(); g.arc(x0 + dir * 215, H / 2, 82, left ? -0.93 : Math.PI - 0.93 + 0, left ? 0.93 : Math.PI + 0.93); g.stroke();
      // 골대 그물
      g.save();
      g.fillStyle = 'rgba(255,255,255,.14)';
      const gx = left ? -GOAL_D : W;
      g.fillRect(gx, H / 2 - GOAL_W / 2, GOAL_D, GOAL_W);
      g.strokeStyle = 'rgba(255,255,255,.35)'; g.lineWidth = 1;
      for (let i = 0; i <= GOAL_D; i += 8) { g.beginPath(); g.moveTo(gx + i, H / 2 - GOAL_W / 2); g.lineTo(gx + i, H / 2 + GOAL_W / 2); g.stroke(); }
      for (let j = 0; j <= GOAL_W; j += 8) { g.beginPath(); g.moveTo(gx, H / 2 - GOAL_W / 2 + j); g.lineTo(gx + GOAL_D, H / 2 - GOAL_W / 2 + j); g.stroke(); }
      g.strokeStyle = '#fff'; g.lineWidth = 4; g.strokeRect(gx, H / 2 - GOAL_W / 2, GOAL_D, GOAL_W);
      g.restore();
      for (const sy of [-1, 1]) { g.fillStyle = '#fff'; g.beginPath(); g.arc(x0, H / 2 + sy * GOAL_W / 2, 6, 0, 6.2832); g.fill(); g.strokeStyle = '#aaa'; g.lineWidth = 1.5; g.stroke(); }
    }
    g.strokeStyle = 'rgba(255,255,255,.9)'; g.lineWidth = 3;
    for (const [cx, cy, a] of [[0, 0, 0], [W, 0, 1.5708], [W, H, 3.1416], [0, H, 4.7124]]) { g.beginPath(); g.arc(cx, cy, 16, a, a + 1.5708); g.stroke(); }
    return c;
  }

  // ───────────── 초기화/리사이즈 ─────────────
  R.init = (canvas, radarCanvas) => {
    cv = canvas; ctx = cv.getContext('2d'); radar = radarCanvas; rctx = radar.getContext('2d');
    window.addEventListener('resize', R.resize); window.addEventListener('orientationchange', () => setTimeout(R.resize, 250));
  };
  R.resize = () => {
    if (!cv) return;
    dpr = Math.min(window.devicePixelRatio || 1, 3);
    cw = cv.clientWidth; ch = cv.clientHeight;
    cv.width = Math.round(cw * dpr); cv.height = Math.round(ch * dpr);
    const viewH = 470;
    sc = ch / viewH;
    if (cw / sc > W + 2 * M) sc = cw / (W + 2 * M);
    let need = Math.min(2.4, Math.max(1, sc * dpr));
    need = Math.min(need, Math.sqrt(12e6 / ((W + 2 * M) * (H + 2 * M))), 4000 / (W + 2 * M)); // 가로세로 4096 화소 이하(모바일 GPU 텍스처 한도)로 제한 // 모바일 캔버스 크기 한도(약 1,600만 화소) 안전 마진
    if (!pitch || Math.abs(need - pitchScale) > 0.25) { pitch = buildPitch(need); pitchScale = need; }
  };
  R.setMatch = (info) => {
    side = info.side; roster = info.roster;
    { const v0 = info.vest != null ? info.vest : (Math.random() < 0.5 ? 0 : 1); const s0 = v0 === 0 ? VEST.red : VEST.blue, s1 = v0 === 0 ? VEST.blue : VEST.red; TEAM_COL = side === 0 ? [s0, s1] : [s1, s0]; const rt = document.documentElement.style; rt.setProperty('--myc', TEAM_COL[0]); rt.setProperty('--opc', TEAM_COL[1]); } cam.init = false; parts.length = rings.length = trail.length = dust.length = 0;
    R.resize();
  };

  // ───────────── 이펙트 ─────────────
  R.shake = (a) => { shakeAmp = Math.max(shakeAmp, a * 0.4); };
  R.kickFx = (x, y, power) => { rings.push({ x, y, r: 6, a: 0.7, w: 2 + power / 500 }); };
  R.goalFx = (scorerSide) => {
    const gx = scorerSide === 0 ? W : 0;
    const cols = scorerSide === side ? [TEAM_COL[0], '#ffffff', '#ffc53d', '#2cff8a'] : [TEAM_COL[1], '#ffffff', '#ffc53d', '#ff9b3d'];
    for (let i = 0; i < 160; i++) {
      const a = Math.random() * 6.283, s = 120 + Math.random() * 520;
      parts.push({ x: gx, y: H / 2, vx: Math.cos(a) * s * (gx === 0 ? 1 : -1) * 0.7 + (gx === 0 ? 120 : -120), vy: Math.sin(a) * s, life: 1.6 + Math.random(), max: 2.6, c: cols[i % cols.length], s: 3 + Math.random() * 5, g: 260 });
    }
    rings.push({ x: gx, y: H / 2, r: 10, a: 1, w: 8, grow: 700 });
    R.shake(14);
  };

  // ───────────── 그리기 ─────────────
  function drawPlayer(p, idx, st) {
    const tSide = idx >= 6 ? 1 : 0;
    const info = roster[tSide][idx % 6];
    const x = flipX(p[0]), y = flipY(p[1]);
    const ang = p[2] + (side ? Math.PI : 0);
    const mine = tSide === side;
    const ctrlIdx = st.c[tSide] + tSide * 6;
    const isCtrl = idx === ctrlIdx;
    // 그림자
    ctx.fillStyle = 'rgba(0,0,0,.28)'; ctx.beginPath(); ctx.ellipse(x + 3, y + 7, PR * 1.05, PR * 0.6, 0, 0, 6.2832); ctx.fill();
    // 팀 링
    if (isCtrl && mine) { // 내가 조종하는 선수: 노란 빛나는 링
      ctx.strokeStyle = '#ffe14a'; ctx.lineWidth = 3.5; ctx.globalAlpha = 0.55 + 0.35 * Math.sin(time * 8);
      ctx.beginPath(); ctx.arc(x, y, PR + 9, 0, 6.2832); ctx.stroke(); ctx.globalAlpha = 1;
      ctx.fillStyle = 'rgba(255,225,74,.18)'; ctx.beginPath(); ctx.arc(x, y, PR + 9, 0, 6.2832); ctx.fill();
    }
    ctx.strokeStyle = isCtrl && mine ? '#ffe14a' : TEAM_COL[mine ? 0 : 1]; ctx.lineWidth = isCtrl && mine ? 4 : 3; ctx.globalAlpha = isCtrl ? 1 : 0.9;
    ctx.beginPath(); ctx.arc(x, y, PR + 3, 0, 6.2832); ctx.stroke(); ctx.globalAlpha = 1;
    // 발(달리기 애니메이션)
    const sp = Math.hypot(p[5] || 0, p[6] || 0);
    const ph = Math.sin(time * 14 + idx) * (p[4] & 2 ? 7 : 5) * Math.min(1, sp / 60);
    ctx.save(); ctx.translate(x, y); ctx.rotate(ang);
    ctx.fillStyle = '#111';
    ctx.beginPath(); ctx.ellipse(PR * 0.55 + ph * 0.3, -PR * 0.45, 4.2, 3.2, 0, 0, 6.2832); ctx.fill();
    ctx.beginPath(); ctx.ellipse(PR * 0.55 - ph * 0.3, PR * 0.45, 4.2, 3.2, 0, 0, 6.2832); ctx.fill();
    // 몸
    ctx.fillStyle = info.c1; ctx.beginPath(); ctx.arc(0, 0, PR, 0, 6.2832); ctx.fill();
    ctx.save(); ctx.beginPath(); ctx.arc(0, 0, PR, 0, 6.2832); ctx.clip();
    ctx.fillStyle = info.c2; ctx.globalAlpha = 0.9; ctx.fillRect(-5, -PR, 5, PR * 2); ctx.globalAlpha = 1;
    ctx.restore();
    if (info.pos !== 'GK') { // 팀 조끼(빨강/파랑): 몸통을 덮고 소매(원래 유니폼 색)만 가장자리로 보인다
      ctx.fillStyle = TEAM_COL[mine ? 0 : 1]; ctx.beginPath(); ctx.arc(0, 0, PR - 2.5, 0, 6.2832); ctx.fill();
      ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(-PR + 4, -2, PR * 2 - 8, 4);
    }
    ctx.strokeStyle = 'rgba(0,0,0,.55)'; ctx.lineWidth = 1.5; ctx.beginPath(); ctx.arc(0, 0, PR, 0, 6.2832); ctx.stroke();
    // 머리(진행 방향)
    ctx.fillStyle = '#f1c9a2'; ctx.beginPath(); ctx.arc(PR * 0.28, 0, 5.2, 0, 6.2832); ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,.4)'; ctx.lineWidth = 1; ctx.stroke();
    if (info.pos === 'GK') { ctx.fillStyle = '#ffe14a'; ctx.beginPath(); ctx.arc(PR * 0.1, -PR - 1, 4, 0, 6.2832); ctx.arc(PR * 0.1, PR + 1, 4, 0, 6.2832); ctx.fill(); }
    // 킥 모션
    if (p[4] & 1) { ctx.strokeStyle = '#fff'; ctx.lineWidth = 3; ctx.globalAlpha = 0.8; ctx.beginPath(); ctx.arc(0, 0, PR + 9, -0.7, 0.7); ctx.stroke(); ctx.globalAlpha = 1; }
    ctx.restore();
    // 등번호 (항상 정방향)
    ctx.font = '900 12px system-ui,sans-serif'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.lineWidth = 3; ctx.strokeStyle = 'rgba(0,0,0,.75)'; ctx.fillStyle = '#fff';
    const num = String(info.num); ctx.strokeText(num, x - 1, y + 1); ctx.fillText(num, x - 1, y + 1);
    // 질주 먼지
    if ((p[4] & 2) && Math.random() < 0.5) dust.push({ x: x - Math.cos(ang) * PR, y: y - Math.sin(ang) * PR, life: 0.4, max: 0.4 });
    if (isCtrl) {
      const bob = Math.sin(time * 8) * 2;
      ctx.fillStyle = mine ? '#ffe14a' : '#ffffffcc'; ctx.strokeStyle = '#000'; ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(x, y - PR - 8 + bob); ctx.lineTo(x - 7, y - PR - 20 + bob); ctx.lineTo(x + 7, y - PR - 20 + bob); ctx.closePath(); ctx.stroke(); ctx.fill();
      if (mine) { // 스태미나 바
        const bw = 30, f = Math.max(0, Math.min(1, p[3] / 100));
        ctx.fillStyle = 'rgba(0,0,0,.6)'; ctx.fillRect(x - bw / 2, y + PR + 6, bw, 5);
        ctx.fillStyle = f > 0.3 ? '#2cff8a' : '#ff5b5b'; ctx.fillRect(x - bw / 2 + 1, y + PR + 7, (bw - 2) * f, 3);
      }
    }
  }

  function drawBall(b, dt) {
    const x = flipX(b[0]), y = flipY(b[1]);
    const sp = Math.hypot(b[2], b[3]);
    ballRot += (sp * dt) / BR;
    if (sp > 300) { trail.push({ x, y, a: 0.45 }); if (trail.length > 8) trail.shift(); } else if (trail.length) trail.shift();
    trail.forEach((t, i) => { ctx.globalAlpha = t.a * (i / trail.length); ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(t.x, t.y, BR * 0.8, 0, 6.2832); ctx.fill(); });
    ctx.globalAlpha = 1;
    ctx.fillStyle = 'rgba(0,0,0,.32)'; ctx.beginPath(); ctx.ellipse(x + 3, y + 6, BR, BR * 0.55, 0, 0, 6.2832); ctx.fill();
    ctx.save(); ctx.translate(x, y); ctx.rotate(ballRot * (side ? -1 : 1) + Math.atan2(b[3], b[2]) * 0);
    const g = ctx.createRadialGradient(-2, -2, 1, 0, 0, BR + 1); g.addColorStop(0, '#fff'); g.addColorStop(1, '#cfd6e4');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, BR, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#1b2333';
    ctx.beginPath(); for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.2832 - 1.57; ctx.lineTo(Math.cos(a) * 3.2, Math.sin(a) * 3.2); } ctx.closePath(); ctx.fill();
    for (let i = 0; i < 5; i++) { const a = (i / 5) * 6.2832 - 1.57; ctx.beginPath(); ctx.arc(Math.cos(a) * 7, Math.sin(a) * 7, 1.8, 0, 6.2832); ctx.fill(); }
    ctx.restore();
    ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1; ctx.beginPath(); ctx.arc(x, y, BR, 0, 6.2832); ctx.stroke();
  }

  /** st: 보간된 상태 {b:[x,y,vx,vy], p:[[x,y,ang,stam,flags,vx,vy]*12], c:[a,b]} */
  R.frame = (st, nowMs) => {
    if (!cv || !roster || !st || !pitch) return;
    const t = nowMs / 1000; const dt = Math.min(0.05, lastT ? t - lastT : 0.016); lastT = t; time = t;
    // 카메라 목표
    const me = st.p[st.c[side] + side * 6];
    const bx = flipX(st.b[0]), by = flipY(st.b[1]);
    const mx = flipX(me[0]), my = flipY(me[1]);
    let tx = bx * 0.7 + mx * 0.3 + (side ? -st.b[2] : st.b[2]) * 0.04;
    let ty = by * 0.7 + my * 0.3;
    const vw = cw / sc, vh = ch / sc;
    const clampC = (v, half, lo, hi) => (half * 2 >= hi - lo ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, v)));
    tx = clampC(tx, vw / 2, -M + 20, W + M - 20); ty = clampC(ty, vh / 2, -M + 20, H + M - 20);
    if (!cam.init) { cam.x = tx; cam.y = ty; cam.init = true; }
    const k = 1 - Math.exp(-dt * 3.5); cam.x += (tx - cam.x) * k; cam.y += (ty - cam.y) * k;
    // 흔들림
    shakeAmp *= Math.exp(-dt * 7); const sx = (Math.random() - 0.5) * shakeAmp, sy = (Math.random() - 0.5) * shakeAmp;

    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0b1a2e'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(dpr * sc, 0, 0, dpr * sc, (cw / 2 - cam.x * sc + sx * sc) * dpr, (ch / 2 - cam.y * sc + sy * sc) * dpr);
    { // 화면에 보이는 부분만 그린다 (거대한 경기장 이미지를 통째로 그리면 폰 GPU 한도를 넘어 특정 구역에서 버벅임)
      const pad = 40, vx0 = Math.max(-M, cam.x - cw / sc / 2 - pad), vy0 = Math.max(-M, cam.y - ch / sc / 2 - pad);
      const vx1 = Math.min(W + M, cam.x + cw / sc / 2 + pad), vy1 = Math.min(H + M, cam.y + ch / sc / 2 + pad);
      ctx.drawImage(pitch, (vx0 + M) * pitchScale, (vy0 + M) * pitchScale, (vx1 - vx0) * pitchScale, (vy1 - vy0) * pitchScale, vx0, vy0, vx1 - vx0, vy1 - vy0);
    }

    // 먼지/링
    for (let i = dust.length - 1; i >= 0; i--) { const d = dust[i]; d.life -= dt; if (d.life <= 0) { dust.splice(i, 1); continue; } ctx.globalAlpha = (d.life / d.max) * 0.35; ctx.fillStyle = '#e8f5d0'; ctx.beginPath(); ctx.arc(d.x, d.y, 3 + (1 - d.life / d.max) * 5, 0, 6.2832); ctx.fill(); }
    ctx.globalAlpha = 1;
    for (let i = rings.length - 1; i >= 0; i--) { const r = rings[i]; r.r += (r.grow || 160) * dt; r.a -= dt * (r.grow ? 0.9 : 2.2); if (r.a <= 0) { rings.splice(i, 1); continue; } ctx.strokeStyle = '#fff'; ctx.globalAlpha = r.a; ctx.lineWidth = r.w; ctx.beginPath(); ctx.arc(flipX(r.x), flipY(r.y), r.r, 0, 6.2832); ctx.stroke(); }
    ctx.globalAlpha = 1;

    // 선수/공 (y 정렬)
    const order = st.p.map((p, i) => i).sort((a, c) => flipY(st.p[a][1]) - flipY(st.p[c][1]));
    const ballFirst = false;
    if (ballFirst) drawBall(st.b, dt);
    for (const i of order) drawPlayer(st.p[i], i, st);
    drawBall(st.b, dt);

    // 파티클(골 축하)
    for (let i = parts.length - 1; i >= 0; i--) {
      const q = parts[i]; q.life -= dt; if (q.life <= 0) { parts.splice(i, 1); continue; }
      q.vy += q.g * dt; q.x += q.vx * dt; q.y += q.vy * dt;
      ctx.globalAlpha = Math.min(1, q.life / 0.6); ctx.fillStyle = q.c; ctx.fillRect(flipX(q.x) - q.s / 2, flipY(q.y) - q.s / 2, q.s, q.s * 0.6);
    }
    ctx.globalAlpha = 1;
    drawRadar(st);
  };

  function drawRadar(st) {
    const rw = radar.width, rh = radar.height;
    rctx.clearRect(0, 0, rw, rh);
    rctx.fillStyle = 'rgba(20,90,45,.75)'; rctx.fillRect(0, 0, rw, rh);
    rctx.strokeStyle = 'rgba(255,255,255,.6)'; rctx.lineWidth = 1; rctx.strokeRect(2, 2, rw - 4, rh - 4);
    rctx.beginPath(); rctx.moveTo(rw / 2, 2); rctx.lineTo(rw / 2, rh - 2); rctx.stroke();
    const px = (x) => 4 + (flipX(x) / W) * (rw - 8), py = (y) => 4 + (flipY(y) / H) * (rh - 8);
    st.p.forEach((p, i) => {
      const own = (i >= 6 ? 1 : 0) === side; const isC = st.c[i >= 6 ? 1 : 0] + (i >= 6 ? 6 : 0) === i;
      rctx.fillStyle = isC && own ? '#ffe14a' : TEAM_COL[own ? 0 : 1]; rctx.beginPath(); rctx.arc(px(p[0]), py(p[1]), isC ? 4.2 : 3, 0, 6.2832); rctx.fill();
      if (isC && own) { rctx.strokeStyle = '#fff'; rctx.lineWidth = 1.5; rctx.stroke(); }
    });
    rctx.fillStyle = '#fff'; rctx.beginPath(); rctx.arc(px(st.b[0]), py(st.b[1]), 3, 0, 6.2832); rctx.fill();
  }
})();
