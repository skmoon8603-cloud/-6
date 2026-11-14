'use strict';
/**
 * 원 바운스 (ONE BOUNCE) 클라이언트 — 발로 차는 1:1 코트 게임.
 * 모든 판정/점수/보상은 서버가 한다. 이 파일은 화면, 입력, 효과음만 담당한다.
 * 규칙: 공은 내 코트에 최대 한 번만 튕길 수 있다 (떠 있을 때 차도 OK). 두 번 튕기면 실점.
 */
(function () {
  const $ = (id) => document.getElementById(id);
  const RF = (window.RF = window.RF || {});
  let C = { W: 800, H: 450, GY: 340, BR: 12, NET_X: 400, NET_H: 74, REACH_X: 56, REACH_Y: 105, WIN: 7 };
  let side = 0, names = ['나', '상대'], inGame = false, raf = 0, last = 0, cv, ctx;
  let snaps = [], keys = {}, holdL = false, holdR = false, sentMove = 99, bannerT = 0, hitFlash = [0, 0];
  const sfx = (k, a) => { try { RF.sfx && RF.sfx(k, a); } catch (e) { /* noop */ } };
  const won = (n) => (RF.won ? RF.won(n) : n + '원');

  const WHY = { double: '두 번 튕겼어요', own: '공이 자기 코트에 먼저 떨어졌어요', net: '네트에 걸렸어요' };
  const ERR = { no_room: '방을 찾을 수 없어요', room_full: '이미 가득 찬 방이에요', self: '내가 만든 방이에요', invalid: '잠시 후 다시 시도해 주세요', server_busy: '서버가 바빠요', server_error: '오류가 났어요' };

  function build() {
    if ($('scr-bounce')) return;
    const el = document.createElement('section');
    el.id = 'scr-bounce'; el.className = 'hidden';
    el.innerHTML = `
      <canvas id="bcv"></canvas>
      <div id="bScore"><span id="bnL" class="bn"></span><b id="bsL">0</b><span class="bt">원 바운스</span><b id="bsR">0</b><span id="bnR" class="bn"></span></div>
      <button id="bExit" aria-label="나가기">✕</button>
      <div id="bBanner" class="hidden"></div>
      <div id="bHelp">공이 내 코트에 <b>두 번 튕기기 전에</b> 발로 차세요! (떠 있을 때 차도 OK)</div>
      <div id="bCtl">
        <div class="bpad"><button id="bL">◀</button><button id="bR">▶</button></div>
        <div class="bpad"><button id="bLob" class="bhit">높게<small>Space</small></button><button id="bSmash" class="bhit sm">강하게<small>K</small></button></div>
      </div>
      <div id="bMenu" class="overlay"><div class="sheet center" style="max-width:360px">
        <button id="bMenuX" class="x" aria-label="닫기">✕</button>
        <h3 style="margin:4px 0 2px">🏓 원 바운스</h3>
        <p class="tiny" style="margin:0 0 10px">공은 내 코트에 <b>최대 한 번</b>만 튕겨요. 떠 있을 때든 한 번 튕긴 뒤든 발로 차서 넘기세요. 두 번 튕기면 실점! 7점 먼저 내면 승리.</p>
        <button id="bzCpu" class="btn primary big" style="width:100%">🤖 AI와 대결 (승리 시 +${won(1000)})</button>
        <div class="lbl" style="margin-top:14px;text-align:left">👥 친구와 대결 (방 만들기)</div>
        <div class="lbl" style="text-align:left;margin:6px 0 4px">판돈 <span id="bzBal" style="float:right"></span></div>
        <div id="bzStakes" class="stakes"></div>
        <button id="bzCreate" class="btn big" style="width:100%;margin-top:8px">방 만들기</button>
        <div class="row" style="margin-top:8px"><input id="bzCode" class="inp code-inp" maxlength="8" placeholder="방 코드" autocomplete="off" autocapitalize="characters" spellcheck="false"><button id="bzJoin" class="btn">입장</button></div>
      </div></div>
      <div id="bWait" class="overlay hidden"><div class="sheet center" style="max-width:340px">
        <div class="lbl">친구에게 이 코드를 알려주세요</div>
        <div id="bWaitCode" class="res-score" style="letter-spacing:.2em">------</div>
        <div id="bWaitStake" class="tiny"></div>
        <p class="tiny">친구가 [원 바운스 → 코드 입력]으로 들어오면 바로 시작해요.</p>
        <button id="bWaitCancel" class="btn">취소</button>
      </div></div>
      <div id="bConfirm" class="overlay hidden"><div class="sheet center" style="max-width:320px">
        <h3 id="bcTitle" style="margin:0 0 6px">내기 방이에요</h3><p id="bcText" class="tiny"></p>
        <div class="row"><button id="bcYes" class="btn primary">입장</button><button id="bcNo" class="btn">취소</button></div>
      </div></div>
      <div id="bResult" class="overlay hidden"><div class="sheet result">
        <div id="brTitle" class="res-title">WIN</div><div id="brScore" class="res-score">0 : 0</div><div id="brNote" class="tiny"></div>
        <div class="row"><button id="brAgain" class="btn primary">다시 하기</button><button id="brExit" class="btn">나가기</button></div>
      </div></div>`;
    document.body.appendChild(el);
    cv = $('bcv'); ctx = cv.getContext('2d');
    const hold = (id, on) => {
      const b = $(id);
      const dn = (e) => { e.preventDefault(); on(true); b.classList.add('down'); };
      const up = (e) => { if (e) e.preventDefault(); on(false); b.classList.remove('down'); };
      b.addEventListener('pointerdown', dn); b.addEventListener('pointerup', up); b.addEventListener('pointercancel', up); b.addEventListener('pointerleave', up);
      b.addEventListener('contextmenu', (e) => e.preventDefault());
    };
    hold('bL', (v) => { holdL = v; }); hold('bR', (v) => { holdR = v; });
    hold('bLob', (v) => { if (v) act('lob'); }); hold('bSmash', (v) => { if (v) act('smash'); });
    $('bExit').addEventListener('click', exit); $('brExit').addEventListener('click', exit);
    $('bMenuX').addEventListener('click', exit);
    $('bzCpu').addEventListener('click', () => go('bz:cpu'));
    $('bzCreate').addEventListener('click', () => go('bz:create'));
    $('bzJoin').addEventListener('click', () => join($('bzCode').value));
    $('bcNo').addEventListener('click', () => $('bConfirm').classList.add('hidden'));
    $('bcYes').addEventListener('click', () => { $('bConfirm').classList.add('hidden'); go('bz:join', pendingCode); });
    $('bzCode').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
    $('bzCode').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter') join($('bzCode').value); });
    $('bWaitCancel').addEventListener('click', () => { leave(); $('bWait').classList.add('hidden'); $('bMenu').classList.remove('hidden'); });
    $('brAgain').addEventListener('click', () => { $('bResult').classList.add('hidden'); if (lastMode === 'bz:cpu') go('bz:cpu'); else $('bMenu').classList.remove('hidden'); });
    addEventListener('keydown', (e) => {
      if ($('scr-bounce').classList.contains('hidden') || !inGame) return;
      const k = e.key.toLowerCase();
      if (['arrowleft', 'arrowright', ' ', 'a', 'd', 'k', 'j'].includes(k)) e.preventDefault();
      if (e.repeat) return;
      keys[k] = true;
      if (k === ' ' || k === 'j') act('lob'); else if (k === 'k') act('smash');
    });
    addEventListener('keyup', (e) => { keys[e.key.toLowerCase()] = false; });
    addEventListener('resize', fit);
  }

  let lastMode = '', stake = 0, pendingCode = '';
  const STAKES = () => (RF.cat && RF.cat.stakes) || [0, 1000, 2000, 5000, 10000];
  function renderStakes() {
    const el = $('bzStakes'); if (!el) return;
    el.innerHTML = STAKES().map((v) => `<button data-v="${v}" class="${v === stake ? 'on' : ''}">${v ? won(v) : '없음'}</button>`).join('');
    el.querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { stake = +b.dataset.v; sfx('tap'); renderStakes(); }));
    const bal = $('bzBal'); if (bal) bal.textContent = '내 잔액 ' + won((RF.state && RF.state.bal) || 0);
  }
  /** 입장 전에 판돈을 확인하고, 내기 방이면 한 번 더 물어본다 */
  function join(code) {
    const s = sock(); if (!s) return RF.toast && RF.toast('서버에 연결 중이에요. 잠시 후 다시!', true);
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6) return RF.toast && RF.toast('방 코드를 입력해 주세요', true);
    bind(s);
    s.emit('bz:peek', { code }, (r) => {
      if (!r || !r.ok) return RF.toast && RF.toast(ERR[r && r.err] || '방을 찾을 수 없어요', true);
      if (!r.stake) return go('bz:join', code);
      pendingCode = code; $('bcTitle').textContent = '내기 방이에요 💰';
      $('bcText').innerHTML = `${r.host} 님의 방 · 판돈 <b>${won(r.stake)}</b><br>이기면 ${won(r.stake * 2)}을 받고, 지면 ${won(r.stake)}을 잃어요.`;
      $('bConfirm').classList.remove('hidden');
    });
  }
  function sock() { return RF.socket && RF.socket.connected ? RF.socket : null; }

  function bind(s) {
    if (s.__bz) return; s.__bz = true;
    s.on('bz:start', (d) => {
      C = d.C || C; side = d.side; names = d.names || ['나', '상대']; inGame = true; snaps = [];
      $('bMenu').classList.add('hidden'); $('bWait').classList.add('hidden'); $('bResult').classList.add('hidden');
      $('bnL').textContent = names[side]; $('bnR').textContent = names[1 - side];
      $('bsL').textContent = '0'; $('bsR').textContent = '0';
      $('bHelp').innerHTML = d.stake ? `💰 판돈 ${won(d.stake)} 내기! 두 번 튕기기 전에 발로 차세요` : '공이 내 코트에 <b>두 번 튕기기 전에</b> 발로 차세요! (떠 있을 때 차도 OK)';
      fit(); banner(d.cpu ? '준비! AI와 대결' : '친구와 대결 시작!');
      cancelAnimationFrame(raf); last = performance.now(); raf = requestAnimationFrame(loop);
    });
    s.on('bz:error', (d) => {
      $('bWait').classList.add('hidden'); $('bMenu').classList.remove('hidden');
      RF.toast && RF.toast(d.err === 'not_enough' ? `${d.who ? d.who + ' 님' : ''} 잔액이 부족해서 시작할 수 없어요 (판돈 ${won(d.stake)})` : d.err === 'locked' ? '다른 내기가 정산 중이에요. 잠시 후 다시!' : '시작할 수 없어요', true); renderStakes();
    });
    s.on('bz:snap', (sn) => { snaps.push({ t: performance.now(), s: sn }); if (snaps.length > 30) snaps.shift(); });
    s.on('bz:ev', (evs) => { for (const e of evs) onEv(e); });
    s.on('bz:left', () => { RF.toast && RF.toast('상대가 나갔어요', true); $('bWait').classList.remove('hidden'); });
    s.on('bz:end', (d) => {
      inGame = false;
      const win = d.winner === side;
      $('brTitle').textContent = win ? 'WIN' : 'LOSE';
      $('brScore').textContent = (side === 0 ? d.score[0] + ' : ' + d.score[1] : d.score[1] + ' : ' + d.score[0]);
      $('brNote').textContent = d.stake ? (d.pay > 0 ? `💰 판돈 획득 +${won(d.pay * 2 - d.pay)}` : d.pay < 0 ? `💸 판돈 −${won(-d.pay)}` : '판돈 환급') : d.reward ? `🎉 승리 보상 +${won(d.reward.amount)} (잔액 ${won(d.reward.bal)})` : (d.forfeit ? (win ? '상대가 나가서 승리했어요' : '') : '');
      $('bResult').classList.remove('hidden');
      sfx(win ? 'legend' : 'save');
    });
    s.on('disconnect', () => { if (inGame) { inGame = false; RF.toast && RF.toast('연결이 끊겨 경기가 종료됐어요', true); exit(true); } });
  }

  function go(ev, code, cb) {
    const s = sock(); if (!s) return RF.toast && RF.toast('서버에 연결 중이에요. 잠시 후 다시!', true);
    if (ev === 'bz:join' && String(code || '').length < 6) return RF.toast && RF.toast('방 코드를 입력해 주세요', true);
    bind(s); lastMode = ev; sfx('tap');
    s.emit(ev, ev === 'bz:join' ? { code } : ev === 'bz:create' ? { stake } : {}, (r) => {
      if (!r || !r.ok) { if (cb) cb(null); } if (!r || !r.ok) return RF.toast && RF.toast(r && r.err === 'not_enough' ? `잔액이 부족해요 (판돈 ${won(r.stake || stake)})` : ERR[r && r.err] || '시작할 수 없어요', true);
      if (ev === 'bz:create') { $('bMenu').classList.add('hidden'); $('bWaitCode').textContent = r.code; $('bWaitStake').textContent = r.stake ? `💰 판돈 ${won(r.stake)} (이기면 ${won(r.stake * 2)})` : '판돈 없음'; $('bWait').classList.remove('hidden'); if (cb) cb(r.code); }
    });
  }
  function leave() { const s = sock(); if (s) s.emit('bz:leave'); }

  function open() {
    build(); fit();
    const s = sock(); if (s) bind(s);
    inGame = false; $('bResult').classList.add('hidden'); $('bWait').classList.add('hidden'); $('bMenu').classList.remove('hidden');
    $('scr-bounce').classList.remove('hidden'); renderStakes(); if (RF.bgmDuck) RF.bgmDuck(0.25);
    draw(0, true);
  }
  function exit(skipLeave) {
    if (skipLeave !== true) leave();
    inGame = false; cancelAnimationFrame(raf); snaps = [];
    $('scr-bounce').classList.add('hidden'); if (RF.bgmDuck) RF.bgmDuck(1);
  }

  function act(kind) {
    const s = sock(); if (!s || !inGame) return;
    // 방향 키: 오른쪽 = 상대 코트 뒤쪽, 왼쪽 = 네트 앞쪽
    const aim = holdR || keys.arrowright || keys.d ? 1 : holdL || keys.arrowleft || keys.a ? -1 : 0.0;
    s.emit('bz:swing', { k: kind, a: aim === 0 ? (Math.random() * 2 - 1) : aim });
    hitFlash[0] = 0.22;
  }

  function fit() {
    if (!cv) return;
    const dpr = Math.min(2, devicePixelRatio || 1), vw = innerWidth, vh = innerHeight;
    cv.style.width = vw + 'px'; cv.style.height = vh + 'px';
    cv.width = Math.round(vw * dpr); cv.height = Math.round(vh * dpr);
    cv._s = Math.min(vw / C.W, vh / C.H) * dpr; cv._ox = (cv.width - C.W * cv._s) / 2; cv._oy = (cv.height - C.H * cv._s) / 2;
  }
  function banner(t) { bannerT = 1.5; const e = $('bBanner'); e.textContent = t; e.classList.remove('hidden'); }

  function onEv(e) {
    if (e.type === 'hit') { sfx('kick', e.kind === 'smash' ? 700 : 400); hitFlash[e.side === side ? 0 : 1] = 0.22; }
    else if (e.type === 'bounce') sfx('post');
    else if (e.type === 'point') {
      const sc = side === 0 ? e.score : [e.score[1], e.score[0]];
      $('bsL').textContent = sc[0]; $('bsR').textContent = sc[1];
      const mine = e.side === side; sfx(mine ? 'goal' : 'save');
      banner((mine ? '득점! ' : '실점… ') + (WHY[e.why] ? '(' + WHY[e.why] + ')' : ''));
    }
  }

  // 서버 스냅샷을 약간 뒤 시점으로 보간해 부드럽게
  function view(now) {
    const n = snaps.length; if (!n) return null;
    const t = now - 70; let a = snaps[0], b = null;
    for (let i = n - 1; i >= 0; i--) if (snaps[i].t <= t) { a = snaps[i]; b = snaps[i + 1] || null; break; }
    if (!b) return a.s;
    const f = Math.max(0, Math.min(1, (t - a.t) / Math.max(1, b.t - a.t))), A = a.s, B = b.s, L = (x, y) => x + (y - x) * f;
    return { ph: B.ph, sc: B.sc, b: [L(A.b[0], B.b[0]), L(A.b[1], B.b[1]), B.b[2], B.b[3], B.b[4], B.b[5], B.b[6]], p: A.p.map((q, i) => [L(q[0], B.p[i][0]), B.p[i][1], B.p[i][2]]) };
  }

  function loop(now) {
    raf = requestAnimationFrame(loop);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    if (inGame) {
      let m = (holdR || keys.arrowright || keys.d ? 1 : 0) - (holdL || keys.arrowleft || keys.a ? 1 : 0);
      if (m !== sentMove) { sentMove = m; const s = sock(); if (s) s.emit('bz:in', { m: side === 1 ? -m : m }); }
    }
    bannerT -= dt; if (bannerT <= 0) $('bBanner').classList.add('hidden');
    hitFlash[0] = Math.max(0, hitFlash[0] - dt); hitFlash[1] = Math.max(0, hitFlash[1] - dt);
    draw(now);
  }

  function draw(now, idle) {
    if (!ctx) return;
    const { W, H, GY, BR, NET_X, NET_H } = C, s = cv._s;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.fillStyle = '#0b1a2e'; ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.setTransform(s, 0, 0, s, cv._ox, cv._oy);
    const sky = ctx.createLinearGradient(0, 0, 0, GY); sky.addColorStop(0, '#16336b'); sky.addColorStop(1, '#2a5aa8');
    ctx.fillStyle = sky; ctx.fillRect(0, 0, W, GY);
    ctx.fillStyle = '#1f8a4c'; ctx.fillRect(0, GY, W, H - GY); ctx.fillStyle = '#26a55c'; ctx.fillRect(0, GY, W, 8);
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.lineWidth = 3; ctx.beginPath(); ctx.moveTo(20, GY + 2); ctx.lineTo(W - 20, GY + 2); ctx.stroke();
    ctx.fillStyle = '#e9eef8'; ctx.fillRect(NET_X - 3, GY - NET_H, 6, NET_H); ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fillRect(NET_X - 9, GY - NET_H, 18, NET_H);
    const v = idle ? null : view(now); if (!v) return;
    const fx = (x) => (side ? W - x : x);
    // 선수 (내 선수는 항상 왼쪽)
    drawPlayer(fx(v.p[side][0]), '#2cff8a', 1, v.p[side][2]);
    drawPlayer(fx(v.p[1 - side][0]), '#ff4d6a', -1, v.p[1 - side][2]);
    // 공
    const bx = fx(v.b[0]), by = v.b[1], bounces = v.b[4], recv = v.b[5], lastHit = v.b[6];
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(bx, GY + 2, BR * (1 - Math.min(0.5, (GY - by) / 700)), 4, 0, 0, 6.2832); ctx.fill();
    const mineBall = recv === side && lastHit !== side && v.ph === 'play';
    if (mineBall) {
      const px = fx(v.p[side][0]), near = Math.abs(bx - px) <= C.REACH_X && by >= GY - C.REACH_Y - BR;
      ctx.strokeStyle = near ? '#2cff8a' : (bounces === 1 ? '#ff4d6a' : 'rgba(44,255,138,.5)'); ctx.lineWidth = 3;
      ctx.beginPath(); ctx.arc(bx, by, BR + 7 + Math.sin(now / 90) * 2, 0, 6.2832); ctx.stroke();
    }
    const g = ctx.createRadialGradient(bx - 3, by - 3, 1, bx, by, BR + 1); g.addColorStop(0, '#fff'); g.addColorStop(1, '#cfd6e4');
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(bx, by, BR, 0, 6.2832); ctx.fill(); ctx.strokeStyle = 'rgba(0,0,0,.5)'; ctx.lineWidth = 1.5; ctx.stroke();
    ctx.font = 'bold 13px sans-serif'; ctx.textAlign = 'center';
    ctx.fillStyle = mineBall && bounces === 1 ? '#ff8a9a' : '#fff';
    ctx.fillText(mineBall && bounces === 1 ? '⚠ 이번에 차야 해요!' : '튕김 ' + bounces, bx, Math.max(16, by - BR - 12));
  }

  // 발로 차는 선수: 몸 + 머리 + 다리 (스윙 시 앞다리가 휙 올라간다)
  function drawPlayer(x, col, dir, sw) {
    const { GY } = C;
    ctx.fillStyle = 'rgba(0,0,0,.3)'; ctx.beginPath(); ctx.ellipse(x, GY + 2, 24, 5, 0, 0, 6.2832); ctx.fill();
    const k = sw > 0 ? Math.sin(Math.min(1, (0.22 - sw) / 0.22) * Math.PI) : 0; // 0~1~0
    // 뒷다리
    ctx.lineCap = 'round'; ctx.lineWidth = 10; ctx.strokeStyle = '#2b3350';
    ctx.beginPath(); ctx.moveTo(x - dir * 4, GY - 28); ctx.lineTo(x - dir * 8, GY - 2); ctx.stroke();
    // 몸
    ctx.fillStyle = col; ctx.beginPath(); ctx.roundRect ? ctx.roundRect(x - 16, GY - 66, 32, 42, 12) : ctx.rect(x - 16, GY - 66, 32, 42); ctx.fill();
    // 머리
    ctx.fillStyle = '#ffe2c4'; ctx.beginPath(); ctx.arc(x, GY - 80, 14, 0, 6.2832); ctx.fill();
    ctx.fillStyle = '#111'; ctx.beginPath(); ctx.arc(x + dir * 6, GY - 82, 2.3, 0, 6.2832); ctx.fill();
    // 앞다리 (차는 다리)
    const hx = x + dir * 4, hy = GY - 28;
    ctx.strokeStyle = '#2b3350'; ctx.lineWidth = 10;
    ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + dir * Math.sin(k * 1.4) * 40, hy + Math.cos(k * 1.4) * 28 - k * 18); ctx.stroke();
    // 신발
    ctx.fillStyle = col; ctx.beginPath(); ctx.arc(hx + dir * Math.sin(k * 1.4) * 40 + dir * 5, hy + Math.cos(k * 1.4) * 28 - k * 18, 6.5, 0, 6.2832); ctx.fill();
  }

  RF.openBounce = open;
  RF.joinBounce = (code) => { open(); join(code); };
  RF.createBounce = (cb) => { open(); stake = 0; go('bz:create', null, cb); }; // 대결 신청 수락 시 (판돈 없음)
  const bind0 = () => { const b = $('btnBounce'); if (b) b.addEventListener('click', () => { sfx('tap'); open(); }); };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bind0); else bind0();
})();
