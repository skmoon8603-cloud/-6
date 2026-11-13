'use strict';
/* RANDOM FOOTBALL - game.js : 네트워크 / 방 / 경기 진행 / 입력(터치·키보드) */
(function () {
  const RF = window.RF, $ = RF.$, LS = RF.LS, esc = RF.esc;
  const R = RF.Render;
  R.init($('cv'), $('radar'));

  let socket = null, room = null, session = LS.get('session', null), accountOn = false;
  let inMatch = false, mInfo = null, side = 0, lastPhase = '', lastCount = 0;
  const snaps = [];
  let loopOn = false, pingMs = 0;
  const ready = [];
  const whenReady = (fn) => (RF.ready ? fn() : ready.push(fn));
  const prevOnReady = RF.hooks.onReady;
  RF.hooks.onReady = () => { if (prevOnReady) prevOnReady(); ready.splice(0).forEach((f) => f()); };

  // ───────────── 연결 상태 ─────────────
  function setConn(on, txt) { $('conn').className = 'conn ' + (on ? 'on' : 'off'); $('connTxt').textContent = txt || (on ? '온라인' : '연결 끊김'); }
  function banner(html) { const b = $('banner'); if (!html) { b.dataset.k = ''; b.classList.add('hidden'); return; } b.innerHTML = html; b.classList.remove('hidden'); }

  function connect() {
    if (typeof io === 'undefined') { setConn(false, '서버 스크립트 로드 실패'); RF.toast('서버에 연결할 수 없습니다. 새로고침 해주세요.', true); return; }
    socket = io({ auth: { token: RF.state.auth }, transports: ['websocket', 'polling'], reconnection: true, reconnectionDelay: 400, reconnectionDelayMax: 3000, timeout: 10000 });
    RF.socket = socket;
    socket.on('connect', () => {
      setConn(true); if (RF.checkVersion) RF.checkVersion(); // 서버 재시작/재배포 후 재접속 시 새 버전 확인
      if (session && session.code) {
        socket.emit('room:rejoin', { code: session.code }, (r) => {
          if (r && r.ok) {
            banner('');
            if (r.state !== 'match') whenReady(() => { if (!inMatch) RF.go('room'); });
          } else {
            session = null; LS.del('session');
            if (inMatch) { endMatchUI(); RF.toast('경기가 종료되어 방이 사라졌습니다', true); }
            whenReady(() => RF.go('home'));
          }
        });
      }
    });
    socket.on('disconnect', () => {
      setConn(false, '재접속 중…');
      if (inMatch) banner('📡 연결이 끊겼습니다<br><small>재접속 중… (제한 시간 안에 돌아오면 경기가 이어집니다)</small>');
    });
    socket.on('connect_error', (e) => { if (e && e.message === 'unauthorized') { RF.logout(true); return; } setConn(false, '서버 연결 중…'); });
    socket.on('account', (a) => RF.setAccount(a));
    socket.on('room:error', (d) => {
      const nm = d.who ? d.who + ' 님' : '';
      RF.toast(d.err === 'not_enough' ? `${nm} 잔액이 부족해서 내기를 시작할 수 없어요 (판돈 ${RF.won(d.stake)})` : d.err === 'locked' ? '다른 내기가 아직 정산 중이에요. 잠시 후 다시!' : '경기를 시작할 수 없습니다', true);
    });
    socket.io.on('reconnect_attempt', () => setConn(false, '재접속 중…'));

    socket.on('room:state', (st) => { room = st; if (RF.screen === 'room' && !inMatch) renderRoom(); });
    socket.on('opp:joined', (d) => { RF.toast(`${d.name} 님이 입장했어요!`); RF.sfx('rare'); });
    socket.on('opp:left', () => { RF.toast('상대가 방을 나갔습니다', true); });
    socket.on('opp:status', (d) => {
      if (d.connected) { banner(''); RF.toast('상대가 다시 연결되었습니다'); return; }
      const until = Date.now() + (d.graceMs || 30000);
      const tick = () => {
        const left = Math.ceil((until - Date.now()) / 1000);
        if (left <= 0 || $('banner').dataset.k !== String(until)) return;
        banner(`⚠️ 상대 연결 끊김<br><small>재접속 대기 중… ${left}초 후 승리 처리</small>`); $('banner').dataset.k = until; setTimeout(tick, 500);
      };
      banner('⚠️ 상대 연결 끊김'); $('banner').dataset.k = until; tick();
      if (!inMatch) RF.toast('상대 연결이 끊겼습니다', true);
    });
    socket.on('match:start', startMatchUI);
    socket.on('snap', onSnap);
    socket.on('ev', onEvents);
    socket.on('match:end', onMatchEnd);
    setInterval(() => {
      if (!socket.connected) return; const t = Date.now();
      socket.emit('ping:c', null, () => { pingMs = Date.now() - t; $('ping').textContent = pingMs + 'ms'; });
    }, 2500);
  }

  // ───────────── 방 만들기 / 입장 ─────────────
  const ERR = { bad_code: '방 코드는 6~8자리 영문/숫자입니다', not_found: '해당 코드의 방이 없습니다', room_full: '이미 2명이 있는 방입니다', invalid: '요청이 올바르지 않습니다', server_busy: '서버가 가득 찼습니다. 잠시 후 다시 시도해주세요', use_rejoin: '이미 이 방에 참가 중입니다', not_enough: '잔액이 부족합니다', host_only: '방장만 바꿀 수 있어요', server_error: '서버 오류. 잠시 후 다시 시도해주세요' };
  function needConn() { if (!socket || !socket.connected) { RF.toast('서버에 연결 중입니다. 잠시만요…', true); return true; } return false; }
  function enter(code) { session = { code }; LS.set('session', session); RF.go('room'); }
  function tryFullscreen() {
    try {
      const el = document.documentElement;
      const p = !document.fullscreenElement && el.requestFullscreen ? el.requestFullscreen() : null;
      const lock = () => { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(() => {}); };
      if (p && p.then) p.then(lock).catch(() => {}); else lock();
    } catch (e) { /* 지원 안 함 */ }
  }

  $('btnCreate').addEventListener('click', () => {
    if (needConn()) return; RF.sfx('tap');
    socket.emit('room:create', RF.teamPayload(), (r) => { if (r && r.ok) { RF.toast('방이 만들어졌어요! 코드를 친구에게 알려주세요'); enter(r.code); } else RF.toast(ERR[r && r.err] || '방 생성 실패', true); });
  });
  function join(code) {
    if (needConn()) return;
    code = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (code.length < 6 || code.length > 8) return RF.toast(ERR.bad_code, true);
    if (code.length === 7 && code[0] === 'B' && RF.joinBounce) return RF.joinBounce(code); // 원 바운스 방 코드
    socket.emit('room:join', { ...RF.teamPayload(), code }, (r) => { if (r && r.ok) { RF.toast('입장 성공!'); enter(r.code); } else RF.toast(ERR[r && r.err] || '입장 실패', true); });
  }
  $('btnJoin').addEventListener('click', () => { RF.sfx('tap'); join($('codeInput').value); });
  $('codeInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') join($('codeInput').value); });
  $('codeInput').addEventListener('input', (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); });
  $('btnPractice').addEventListener('click', () => {
    if (needConn()) return; RF.sfx('tap'); tryFullscreen();
    socket.emit('room:practice', RF.teamPayload(), (r) => { if (r && r.ok) { session = { code: r.code }; LS.set('session', session); } else RF.toast(ERR[r && r.err] || '시작 실패', true); });
  });

  // URL 초대 링크: ?room=ABC123
  try {
    const q = new URLSearchParams(location.search).get('room');
    if (q) { $('codeInput').value = q.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 8); whenReady(() => RF.toast('초대 코드가 입력되었어요. [입장]을 눌러주세요')); history.replaceState(null, '', location.pathname); }
  } catch (e) { /* noop */ }

  // ───────────── 대기방 ─────────────
  RF.hooks.inRoom = () => !!session && !!room && !inMatch && (room.state === 'lobby' || room.state === 'ended') && !room.practice;
  RF.hooks.renderRoom = renderRoom;
  RF.hooks.onTeamChange = () => { if (socket && socket.connected && session && !inMatch) socket.emit('room:lineup', RF.teamPayload()); };

  function renderRoom() {
    if (!room) { $('roomCode').textContent = session ? session.code : '------'; $('roomPlayers').innerHTML = '<p class="tiny center">방 정보를 불러오는 중…</p>'; return; }
    $('roomCode').textContent = room.code;
    const me = room.players[room.you];
    const full = room.players.length === 2;
    let html = '';
    for (let i = 0; i < 2; i++) {
      const p = room.players[i];
      if (!p) { html += '<div class="rp empty"><div class="av">?</div><div class="info"><b>친구를 기다리는 중…</b><small>코드를 알려주세요</small></div></div>'; continue; }
      const st = !p.connected ? '<span class="st off">연결 끊김</span>' : p.ready ? '<span class="st ready">준비 완료</span>' : '<span class="st">대기 중</span>';
      html += `<div class="rp"><div class="av">${esc(p.name.slice(0, 1).toUpperCase())}</div><div class="info"><b>${esc(p.name)}${i === room.you ? ' (나)' : ''}</b><small>팀 평균 ${p.avg} · ${i === 0 ? '방장' : '참가자'}</small></div>${st}</div>`;
    }
    $('roomPlayers').innerHTML = html;
    renderStake();
    const btn = $('btnReady');
    btn.textContent = me && me.ready ? '준비 취소' : room.state === 'ended' ? '다시 하기 (준비)' : '준비 완료';
    btn.disabled = !full;
    let hint = full ? '둘 다 ‘준비 완료’를 누르면 경기가 시작됩니다.' : '친구에게 코드를 알려주세요. 친구가 입장하면 준비 버튼이 켜집니다.';
    if (room.last) hint = `지난 경기 ${room.last.score[0]} : ${room.last.score[1]}${room.last.forfeit ? ' (기권승)' : ''} · ` + hint;
    $('roomHint').textContent = hint;
  }
  function renderStake() {
    const box = $('stakeBox'); if (!box) return;
    const host = room.you === 0, stakes = (RF.cat && RF.cat.stakes) || [0];
    const lock = room.state === 'match';
    let h = `<div class="lbl">💰 내기 금액 <small class="tiny">(이긴 사람이 판돈 전부 · 게임 속 가상 재화)</small></div><div class="chips" style="flex-wrap:wrap">`;
    h += stakes.map((v) => `<button class="chip${room.stake === v ? ' on' : ''}" data-v="${v}" ${host && !lock ? '' : 'disabled'}>${v ? RF.won(v) : '내기 없음'}</button>`).join('');
    h += '</div>';
    h += room.stake ? `<div class="tiny">현재 판돈 ${RF.won(room.stake)} × 2 = <b>${RF.won(room.stake * 2)}</b> · 내 잔액 ${RF.won(RF.state.bal)}${RF.state.bal < room.stake ? ' <b style="color:#ff6b6b">(부족!)</b>' : ''}</div>` : '<div class="tiny">내기 없이 친선 경기</div>';
    if (!host) h += '<div class="tiny">방장이 금액을 정해요. 준비를 누르면 시작할 때 판돈이 걸립니다.</div>';
    box.innerHTML = h;
    box.querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => {
      if (needConn()) return; RF.sfx('tap');
      socket.emit('room:stake', { stake: Number(b.dataset.v) }, (r) => { if (!r || !r.ok) RF.toast(ERR[r && r.err] || '변경 실패', true); });
    }));
  }
  $('btnReady').addEventListener('click', () => {
    if (needConn() || !room) return; RF.sfx('tap'); tryFullscreen();
    const me = room.players[room.you];
    socket.emit('room:ready', { ready: !(me && me.ready) });
  });
  $('btnRoomTeam').addEventListener('click', () => RF.go('team'));
  $('btnLeave').addEventListener('click', () => leaveRoom());
  function leaveRoom() {
    if (socket && socket.connected) socket.emit('room:leave');
    session = null; room = null; LS.del('session'); RF.go('home');
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) return navigator.clipboard.writeText(text).then(() => true, () => false);
    try { const t = document.createElement('textarea'); t.value = text; document.body.appendChild(t); t.select(); const ok = document.execCommand('copy'); t.remove(); return Promise.resolve(ok); } catch (e) { return Promise.resolve(false); }
  }
  $('btnCopy').addEventListener('click', async () => { if (room && await copy(room.code)) RF.toast('코드를 복사했어요: ' + room.code); else RF.toast('복사할 수 없어요. 코드를 직접 알려주세요', true); });
  $('btnShare').addEventListener('click', async () => {
    if (!room) return;
    const url = `${location.origin}/?room=${room.code}`;
    const text = `RANDOM FOOTBALL 같이 해요! 방 코드: ${room.code}`;
    if (navigator.share) { try { await navigator.share({ title: 'RANDOM FOOTBALL', text, url }); return; } catch (e) { if (e && e.name === 'AbortError') return; } }
    if (await copy(`${text}\n${url}`)) RF.toast('초대 링크를 복사했어요'); else RF.toast(url);
  });

  // ───────────── 경기 시작/종료 ─────────────
  let wake = null;
  async function lockWake() { try { if (navigator.wakeLock) wake = await navigator.wakeLock.request('screen'); } catch (e) { /* noop */ } }
  function checkOrient() { $('rotate').classList.toggle('hidden', !(inMatch && window.innerHeight > window.innerWidth * 1.05)); R.resize(); }
  window.addEventListener('resize', checkOrient); window.addEventListener('orientationchange', () => setTimeout(checkOrient, 300));
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') { if (inMatch) lockWake(); if (socket && !socket.connected) socket.connect(); }
  });

  function startMatchUI(info) {
    mInfo = info; side = info.side; inMatch = true; snaps.length = 0; replay = null; lastPhase = ''; lastCount = 0;
    RF.closeModal(); $('reveal').classList.add('hidden');
    $('scr-match').classList.remove('hidden'); $('resultPanel').classList.add('hidden'); $('menuPanel').classList.add('hidden'); $('goalfx').classList.add('hidden');
    banner('');
    const names = info.names;
    $('nmL').textContent = names[side]; $('nmR').textContent = names[1 - side];
    $('scL').textContent = '0'; $('scR').textContent = '0'; $('timer').textContent = fmt(info.seconds); $('timer').classList.remove('low');
    R.setMatch(info);
    checkOrient(); lockWake(); tryFullscreen();
    try { history.pushState({ m: 1 }, ''); } catch (e) { /* noop */ }
    if (!loopOn) { loopOn = true; requestAnimationFrame(loop); }
    RF.sfx('tap');
  }
  function endMatchUI() {
    inMatch = false; stopReplay(); $('scr-match').classList.add('hidden'); $('rotate').classList.add('hidden');
    try { if (wake) wake.release(); } catch (e) { /* noop */ } wake = null;
    try { if (document.fullscreenElement) document.exitFullscreen(); } catch (e) { /* noop */ }
    releaseAll();
  }
  const fmt = (s) => { s = Math.max(0, Math.ceil(s)); return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0'); };

  function onMatchEnd(d) {
    if (!inMatch) return;
    const you = d.you, win = d.winner === you, draw = d.winner === -1;
    const sc = side === 0 ? d.score : [d.score[1], d.score[0]];
    const t = $('resTitle');
    t.textContent = draw ? 'DRAW' : win ? 'WIN' : 'LOSE'; t.className = 'res-title ' + (draw ? 'draw' : win ? 'win' : 'lose');
    $('resScore').textContent = `${sc[0]} : ${sc[1]}`;
    $('resNote').textContent = d.forfeit ? (win ? '상대가 경기를 떠나 기권승 처리되었습니다.' : '기권패 처리되었습니다.') : draw ? '무승부입니다. 한 판 더?' : win ? '축하합니다! 승리했어요 🎉' : '아쉽네요. 다시 도전해보세요!';
    $('resAgain').disabled = false; $('resAgain').textContent = '다시 하기';
    const old = document.getElementById('resReward'); if (old) old.remove();
    let extra = '';
    if (d.reward) extra = `💰 +${RF.won(d.reward.amount)} 획득! (잔액 ${RF.won(d.reward.bal)})`;
    else if (d.stake) extra = d.pay > 0 ? `💰 내기 승리! +${RF.won(d.stake)} (판돈 ${RF.won(d.stake * 2)} 획득)` : d.pay < 0 ? `💸 내기 패배 -${RF.won(d.stake)}` : `🤝 무승부 — 판돈 ${RF.won(d.stake)} 환급`;
    if (extra) { const rw = document.createElement('div'); rw.id = 'resReward'; rw.className = 'res-reward'; rw.textContent = extra; $('resNote').after(rw); }
    setTimeout(() => { $('resultPanel').classList.remove('hidden'); banner(''); $('countdown').classList.add('hidden'); }, d.forfeit ? 0 : 1200);
    RF.sfx('end'); releaseAll();
  }
  $('resAgain').addEventListener('click', () => {
    if (!socket || !socket.connected) return RF.toast('연결 중입니다', true);
    socket.emit('room:ready', { ready: true }); $('resAgain').disabled = true; $('resAgain').textContent = room && room.practice ? '시작 중…' : '상대 기다리는 중…';
  });
  $('resLobby').addEventListener('click', () => {
    endMatchUI();
    if (room && room.practice) { leaveRoom(); return; }
    RF.go(room ? 'room' : 'home');
  });

  // ───────────── 스냅샷 / 이벤트 ─────────────
  function onSnap(s) {
    snaps.push({ k: s.k, t: performance.now(), s });
    if (snaps.length > 120) snaps.shift(); // 골 장면 다시보기용으로 약 4초 분량 보관
  }
  function onEvents(evs) {
    if (!inMatch) return;
    const st = snaps.length ? snaps[snaps.length - 1].s : null;
    for (const e of evs) {
      if (e.type === 'goal') {
        RF.sfx('goal'); R.goalFx(e.side); startReplay();
        const mine = e.side === side;
        const sc = side === 0 ? e.score : [e.score[1], e.score[0]];
        $('scL').textContent = sc[0]; $('scR').textContent = sc[1];
        const g = $('goalfx'); g.innerHTML = `<div><div class="g">GOAL!</div><div class="s">${mine ? '⚽ 우리 팀 득점' : '😵 상대 팀 득점'} · ${e.by ? '#' + e.num + ' ' + esc(e.by) : ''}${e.own ? ' (자책골)' : ''} · ${sc[0]} : ${sc[1]}</div></div>`;
        g.classList.remove('hidden'); clearTimeout(g._t); g._t = setTimeout(() => g.classList.add('hidden'), 1150);
        if (navigator.vibrate) navigator.vibrate(mine ? [60, 40, 120] : 80);
      } else if (e.type === 'kick') {
        if (st) R.kickFx(st.b[0], st.b[1], e.pw); RF.sfx('kick', e.pw);
      } else if (e.type === 'post') RF.sfx('post');
      else if (e.type === 'save') RF.sfx('save');
      else if (e.type === 'whistle' || e.type === 'kickoff') RF.sfx('whistle');
    }
  }

  // ───────────── 보간 렌더링 ─────────────
  const angLerp = (a, b, t) => { let d = (b - a) % 6.2832; if (d > 3.1416) d -= 6.2832; if (d < -3.1416) d += 6.2832; return a + d * t; };
  function interp(now) {
    const n = snaps.length; if (!n) return null;
    const last = snaps[n - 1];
    const est = last.k + (now - last.t) / (1000 / 60);
    return mixAt(snaps, est - 7, last.s);
  }
  /** arr(스냅샷 배열)에서 틱 target 위치의 장면을 보간해 만든다 */
  function mixAt(arr, target, cur) {
    const n = arr.length, last = arr[n - 1];
    let a = arr[0], b = null;
    for (let i = n - 1; i >= 0; i--) if (arr[i].k <= target) { a = arr[i]; b = arr[i + 1] || null; break; }
    const A = a.s;
    if (!b || b.k === a.k) return { cur, b: A.b.slice(), p: A.p.map((q) => [q[0], q[1], q[2], q[3], q[4], 0, 0]), c: last.s.c };
    const B = b.s, dk = b.k - a.k, f = Math.max(0, Math.min(1, (target - a.k) / dk)), sec = dk / 60;
    return {
      cur, c: B.c,
      b: [A.b[0] + (B.b[0] - A.b[0]) * f, A.b[1] + (B.b[1] - A.b[1]) * f, A.b[2] + (B.b[2] - A.b[2]) * f, A.b[3] + (B.b[3] - A.b[3]) * f],
      p: A.p.map((q, i) => { const r = B.p[i]; return [q[0] + (r[0] - q[0]) * f, q[1] + (r[1] - q[1]) * f, angLerp(q[2], r[2], f), r[3], q[4] | r[4], (r[0] - q[0]) / sec, (r[1] - q[1]) / sec]; }),
    };
  }
  // ───────────── 골 장면 다시보기 (슬로모션) ─────────────
  let replay = null; const REPLAY_TICKS = 120, REPLAY_DELAY = 900;
  function startReplay() {
    const n = snaps.length; if (n < 20) return;
    const frames = snaps.slice(Math.max(0, n - Math.ceil(REPLAY_TICKS / 2) - 1));
    replay = { frames, k: frames[0].k, kEnd: frames[frames.length - 1].k, at: performance.now() + REPLAY_DELAY, last: 0, on: false, t0: 0, beat: 0.4 };
  }
  function stopReplay() { replay = null; const t = $('replayTag'); if (t) t.classList.add('hidden'); const m = $('scr-match'); m.classList.remove('replaying'); m.style.transform = ''; }
  function replayFrame(now, live) {
    if (!replay) return live;
    if (now < replay.at) return live;
    if (live.cur.ph === 'play' || live.cur.ph === 'ended') { stopReplay(); return live; }
    if (!replay.on) { replay.on = true; replay.last = now; replay.t0 = now; replay.beat = RF.goalSong ? (RF.goalSong() || 0.4) : 0.4; $('replayTag').classList.remove('hidden'); $('scr-match').classList.add('replaying'); }
    const dt = Math.min(0.05, (now - replay.last) / 1000); replay.last = now;
    const remain = replay.kEnd - replay.k;
    replay.k += dt * 60 * (remain < 30 ? 0.25 : 0.5); // 슬로모션 (마지막 순간은 더 느리게)
    // 화면 지진: 계속 흔들리고, 음악 박자(킥)마다 크게 쿵! 하고 흔들린다
    const el = (now - replay.t0) / 1000, ph = (el % replay.beat) / replay.beat, pulse = Math.exp(-ph * 7), amp = 5 + 16 * pulse;
    const sx = (Math.random() - 0.5) * 2 * amp, sy = (Math.random() - 0.5) * 2 * amp, rot = (Math.random() - 0.5) * 0.012 * (1 + pulse * 2);
    $('scr-match').style.transform = `translate(${sx.toFixed(1)}px,${sy.toFixed(1)}px) rotate(${rot.toFixed(4)}rad) scale(1.04)`;
    if (replay.k >= replay.kEnd + 20) { stopReplay(); return live; }
    return mixAt(replay.frames, Math.min(replay.k, replay.kEnd), live.cur);
  }
  let lastTm = -1;
  function loop(now) {
    requestAnimationFrame(loop);
    if (!inMatch) return;
    let f = interp(now); if (!f) return;
    f = replayFrame(now, f);
    R.frame(f, now);
    const s = f.cur;
    // 스코어/시간
    const my = side === 0 ? s.sc[0] : s.sc[1], op = side === 0 ? s.sc[1] : s.sc[0];
    if ($('scL').textContent !== String(my)) $('scL').textContent = my;
    if ($('scR').textContent !== String(op)) $('scR').textContent = op;
    const tm = Math.ceil(s.tm);
    if (tm !== lastTm) { lastTm = tm; $('timer').textContent = fmt(s.tm); $('timer').classList.toggle('low', s.tm <= 10 && s.tm > 0); }
    // 카운트다운
    const cd = $('countdown');
    if (s.ph === 'countdown') {
      const n = Math.ceil(s.pt);
      if (n !== lastCount) { lastCount = n; cd.innerHTML = `<span>${n > 0 ? n : 'GO!'}</span>`; cd.classList.remove('hidden'); cd.classList.remove('pop'); void cd.offsetWidth; cd.classList.add('pop'); RF.sfx('count'); }
    } else if (!cd.classList.contains('hidden')) { cd.classList.add('hidden'); lastCount = 0; }
    lastPhase = s.ph;
  }

  // ───────────── 입력: 조이스틱 / 버튼 / 키보드 ─────────────
  const inp = { jx: 0, jy: 0, kx: 0, ky: 0, sprintHold: false, sprintLatch: false };
  const keys = new Set();
  const joy = $('joy'), base = $('joyBase'), knob = $('joyKnob');
  let joyId = null, jc = { x: 0, y: 0 };
  const JR = 54;
  joy.addEventListener('pointerdown', (e) => {
    if (joyId !== null) return; joyId = e.pointerId; joy.setPointerCapture(e.pointerId);
    const r = joy.getBoundingClientRect(); // 조이스틱은 #joy 안에 배치되므로 #joy 기준 좌표 (기존: #controls 기준이라 위로 어긋났음)
    jc = { x: e.clientX, y: e.clientY };
    base.style.left = e.clientX - r.left + 'px'; base.style.top = e.clientY - r.top + 'px'; base.classList.add('act');
    moveJoy(e); e.preventDefault();
  });
  function moveJoy(e) {
    let dx = e.clientX - jc.x, dy = e.clientY - jc.y; const l = Math.hypot(dx, dy);
    if (l > JR) { dx = (dx / l) * JR; dy = (dy / l) * JR; }
    knob.style.transform = `translate(${dx}px,${dy}px)`;
    const m = Math.min(1, l / JR);
    if (m < 0.14) { inp.jx = inp.jy = 0; } else { const nx = dx / (l || 1), ny = dy / (l || 1); const mag = Math.min(1, (m - 0.14) / 0.6); inp.jx = nx * mag; inp.jy = ny * mag; }
  }
  joy.addEventListener('pointermove', (e) => { if (e.pointerId === joyId) { moveJoy(e); e.preventDefault(); } });
  const joyEnd = (e) => { if (e.pointerId !== joyId) return; joyId = null; inp.jx = inp.jy = 0; knob.style.transform = ''; base.classList.remove('act'); base.style.left = ''; base.style.top = ''; };
  joy.addEventListener('pointerup', joyEnd); joy.addEventListener('pointercancel', joyEnd); joy.addEventListener('lostpointercapture', joyEnd);

  function press(el, down, up) {
    el.addEventListener('pointerdown', (e) => { e.preventDefault(); try { el.setPointerCapture(e.pointerId); } catch (x) { /* noop */ } el.classList.add('pressed'); down(e); });
    const end = (e) => { if (!el.classList.contains('pressed')) return; el.classList.remove('pressed'); if (up) up(e); };
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end); el.addEventListener('lostpointercapture', end);
    el.addEventListener('contextmenu', (e) => e.preventDefault());
  }
  const act = (t, p) => { if (socket && socket.connected && inMatch) socket.emit('act', { t, p }); };
  let shootT = 0;
  function shootDown() { shootT = performance.now(); $('bShoot').classList.add('charging'); }
  function shootUp() {
    if (!shootT) return; const hold = (performance.now() - shootT) / 1000; shootT = 0; $('bShoot').classList.remove('charging');
    act('shoot', 0.55 + 0.45 * Math.min(1, hold / 0.5));
  }
  press($('bShoot'), shootDown, shootUp);
  press($('bPass'), () => act('pass'));
  press($('bSwitch'), () => act('switch'));
  let spT = 0;
  press($('bSprint'), () => { spT = performance.now(); inp.sprintHold = true; }, () => {
    inp.sprintHold = false;
    if (inp.sprintLatch) inp.sprintLatch = false; else if (performance.now() - spT < 260) inp.sprintLatch = true;
    $('bSprint').classList.toggle('latch', inp.sprintLatch);
  });
  function releaseAll() { inp.jx = inp.jy = inp.kx = inp.ky = 0; inp.sprintHold = inp.sprintLatch = false; keys.clear(); shootT = 0; $('bSprint').classList.remove('latch'); $('bShoot').classList.remove('charging'); sendInput(true); }

  // 키보드
  const KMAP = { ArrowUp: 'u', ArrowDown: 'd', ArrowLeft: 'l', ArrowRight: 'r', w: 'u', s: 'd', a: 'l', d: 'r', W: 'u', S: 'd', A: 'l', D: 'r' };
  window.addEventListener('keydown', (e) => {
    if (!inMatch || e.target.tagName === 'INPUT') return;
    const k = e.key;
    if (KMAP[k]) { keys.add(KMAP[k]); e.preventDefault(); }
    else if (k === ' ' || e.code === 'Space') { e.preventDefault(); if (!e.repeat && !shootT) shootDown(); }
    else if (k === 'e' || k === 'E') { if (!e.repeat) act('pass'); }
    else if (k === 'q' || k === 'Q') { if (!e.repeat) act('switch'); }
    else if (k === 'Shift') inp.sprintHold = true;
    else if (k === 'Escape') $('menuPanel').classList.toggle('hidden');
  });
  window.addEventListener('keyup', (e) => {
    if (!inMatch) return; const k = e.key;
    if (KMAP[k]) keys.delete(KMAP[k]);
    else if (k === ' ' || e.code === 'Space') shootUp();
    else if (k === 'Shift') inp.sprintHold = false;
  });
  window.addEventListener('blur', () => { if (inMatch) releaseAll(); });

  // 입력 전송 (서버 좌표계: 2번 플레이어는 화면이 180도 회전되어 있으므로 반전)
  let last = { mx: 9, my: 9, sp: null, t: 0 };
  function sendInput(force) {
    if (!socket || !socket.connected) return;
    let mx = inp.jx, my = inp.jy;
    const kx = (keys.has('r') ? 1 : 0) - (keys.has('l') ? 1 : 0), ky = (keys.has('d') ? 1 : 0) - (keys.has('u') ? 1 : 0);
    if (kx || ky) { const l = Math.hypot(kx, ky); mx = kx / l; my = ky / l; }
    if (side === 1) { mx = -mx; my = -my; }
    mx = Math.round(mx * 100) / 100; my = Math.round(my * 100) / 100;
    const sp = inp.sprintHold || inp.sprintLatch;
    const now = performance.now();
    if (force || mx !== last.mx || my !== last.my || sp !== last.sp || now - last.t > 200) {
      socket.emit('input', { mx, my, sp }); last = { mx, my, sp, t: now };
    }
  }
  setInterval(() => { if (inMatch) sendInput(false); }, 33);

  // 메뉴 / 전체화면 / 소리 / 뒤로가기
  $('btnMenu').addEventListener('click', () => $('menuPanel').classList.remove('hidden'));
  $('mResume').addEventListener('click', () => $('menuPanel').classList.add('hidden'));
  $('mLeave').addEventListener('click', () => { $('menuPanel').classList.add('hidden'); endMatchUI(); leaveRoom(); });
  $('btnFs').addEventListener('click', () => { if (document.fullscreenElement) document.exitFullscreen(); else tryFullscreen(); });
  const sndBtn = () => { $('btnSnd').textContent = RF.isMuted() ? '🔇' : '🔊'; };
  $('btnSnd').addEventListener('click', () => { RF.setMuted(!RF.isMuted()); sndBtn(); }); sndBtn();
  window.addEventListener('popstate', () => { if (inMatch && $('resultPanel').classList.contains('hidden')) { $('menuPanel').classList.remove('hidden'); try { history.pushState({ m: 1 }, ''); } catch (e) { /* noop */ } } });
  $('scr-match').addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => { if (inMatch) e.preventDefault(); });
  window.addEventListener('beforeunload', () => { /* 새로고침 시 세션(방 코드)은 localStorage에 남아 자동 재접속 */ });

  RF.hooks.onLogin = () => { if (!socket) connect(); };
})();
