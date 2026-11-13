'use strict';
/* RANDOM FOOTBALL - meta.js : 저장소 / 사운드 / 로비 / 뽑기 / 보관함 / 도감 / 편성 UI */
(function () {
  const RF = (window.RF = { cat: null, byId: {}, state: {}, hooks: {} });
  const $ = (id) => document.getElementById(id);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  RF.$ = $; RF.sleep = sleep; RF.esc = esc;

  // ───────────── 저장소 (새로고침 후에도 유지) ─────────────
  const LS = {
    get(k, d) { try { const v = localStorage.getItem('rf_' + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem('rf_' + k, JSON.stringify(v)); } catch (e) { /* 저장 불가 환경 */ } },
    del(k) { try { localStorage.removeItem('rf_' + k); } catch (e) { /* noop */ } },
  };
  RF.LS = LS;
  function rid() {
    const a = new Uint8Array(12);
    (window.crypto || window.msCrypto).getRandomValues(a);
    return Array.from(a, (b) => b.toString(36).padStart(2, '0')).join('').slice(0, 20);
  }
  const S = RF.state;
  S.name = 'PLAYER';
  S.auth = LS.get('auth', '');   // 서버가 발급한 로그인 세션 (비밀번호는 저장하지 않음)
  S.uid = null;
  S.lineup = null;
  S.inv = {};
  S.pulls = 0;
  S.bal = 0;
  S.locked = 0;
  const won = (n) => Number(n).toLocaleString('ko-KR') + '원';
  RF.won = won;
  function updateBal() { const el = $('bal'); if (el) el.textContent = '💰 ' + won(S.bal || 0); }
  const COST = () => (RF.cat && RF.cat.pullCost) || 1000;
  /** 서버 API 호출 (로그인 세션 포함). 401 이면 다시 로그인 */
  RF.api = async (path, body) => {
    const r = await fetch(path, { method: body === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + S.auth }, body: body === undefined ? undefined : JSON.stringify(body) });
    if (r.status === 401) { RF.logout(true); throw new Error('로그인이 필요합니다'); }
    return r;
  };
  /** 서버가 확정한 계정 정보(잔액/보관함/닉네임) 적용 */
  RF.setAccount = (a) => {
    if (a.secret && RF.byId && RF.cat) for (const k in a.secret) { RF.byId[k] = a.secret[k]; const ix = RF.cat.players.findIndex((x) => x.id === k); if (ix >= 0) RF.cat.players[ix] = a.secret[k]; } // 보유한 초월 캐릭터의 실제 정보
    S.uid = a.id; S.inv = a.inv || {}; S.pulls = a.pulls || 0; S.bal = a.bal || 0; S.locked = a.locked || 0; S.name = a.nick || S.name; S.email = a.email; S.att = a.att || null; S.admin = !!a.admin;
    updateBal();
    if (RF.ready && RF.cat) { sanitizeLineup(); if (RF.screen === 'gacha') renderGacha(); if (RF.screen === 'home') renderHome(); }
  };
  RF.logout = (silent) => { LS.del('auth'); if (RF.socket) { try { RF.socket.disconnect(); } catch (e) { /* noop */ } } LS.del('session'); if (silent) RF.toast('다시 로그인해주세요', true); setTimeout(() => location.reload(), silent ? 600 : 0); };

  // ───────────── 토스트 ─────────────
  let toastT;
  RF.toast = (msg, err) => {
    const t = $('toast'); t.textContent = msg; t.className = 'toast show' + (err ? ' err' : '');
    clearTimeout(toastT); toastT = setTimeout(() => { t.className = 'toast'; }, 2600);
  };

  // ───────────── 사운드 (WebAudio 합성) ─────────────
  let ac = null, muted = LS.get('mute', false);
  function ctx() {
    if (!ac) { try { ac = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; } }
    if (ac.state === 'suspended') ac.resume();
    return ac;
  }
  function tone(f, d, type = 'sine', vol = 0.15, t0 = 0, slide) {
    const c = ctx(); if (!c || muted) return;
    const o = c.createOscillator(), g = c.createGain(), t = c.currentTime + t0;
    o.type = type; o.frequency.setValueAtTime(f, t); if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + d);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    o.connect(g).connect(c.destination); o.start(t); o.stop(t + d + 0.02);
  }
  function noise(d, vol = 0.2, f = 900, t0 = 0) {
    const c = ctx(); if (!c || muted) return;
    const n = Math.floor(c.sampleRate * d), buf = c.createBuffer(1, n, c.sampleRate), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) ch[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    fl.type = 'lowpass'; fl.frequency.value = f; g.gain.value = vol; s.buffer = buf;
    s.connect(fl).connect(g).connect(c.destination); s.start(c.currentTime + t0);
  }
  RF.sfx = (k, a) => {
    switch (k) {
      case 'tap': tone(660, 0.06, 'triangle', 0.08); break;
      case 'kick': noise(0.08, Math.min(0.35, 0.12 + (a || 500) / 4000), 700); tone(120, 0.08, 'sine', 0.2, 0, 60); break;
      case 'post': tone(1500, 0.25, 'triangle', 0.15); break;
      case 'save': noise(0.1, 0.2, 400); break;
      case 'whistle': tone(2500, 0.35, 'sine', 0.12); tone(2650, 0.35, 'sine', 0.1, 0.02); break;
      case 'count': tone(520, 0.12, 'square', 0.07); break;
      case 'goal': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, i * 0.1)); noise(1.6, 0.14, 1800, 0.1); break;
      case 'end': tone(2500, 0.3, 'sine', 0.12); tone(2500, 0.5, 'sine', 0.12, 0.4); break;
      case 'shake': noise(0.12, 0.12, 500); tone(90, 0.12, 'square', 0.05); break;
      case 'common': tone(440, 0.15, 'triangle', 0.1); break;
      case 'rare': [523, 659].forEach((f, i) => tone(f, 0.2, 'triangle', 0.12, i * 0.1)); break;
      case 'hero': [523, 659, 784].forEach((f, i) => tone(f, 0.25, 'triangle', 0.13, i * 0.1)); break;
      case 'legend': [523, 659, 784, 1047, 1319].forEach((f, i) => tone(f, 0.3, 'sawtooth', 0.09, i * 0.09)); break;
      case 'myth': [392, 523, 659, 784, 1047, 1319, 1568].forEach((f, i) => tone(f, 0.45, 'sawtooth', 0.1, i * 0.08)); noise(1.2, 0.1, 2500, 0.4); break;
      case 'trans': [392, 523, 659, 784, 1047, 1319, 1568, 2093].forEach((f, i) => tone(f, 0.55, 'sawtooth', 0.11, i * 0.09)); noise(1.6, 0.12, 3000, 0.5); break;
      default: break;
    }
  };
  /** 골 노래 "티키 퐁크": 원본 음원은 쓸 수 없어서 직접 만든 효과음 + 음성 합성으로 부른다.
   *  /goal.mp3 파일을 올려두면 그 파일을 대신 재생한다. */
  let goalFile = null; // null: 확인 전, false: 없음, Audio: 있음
  fetch('/goal.mp3', { method: 'HEAD' }).then((r) => { goalFile = r.ok && /audio|mpeg|octet/.test(r.headers.get('content-type') || '') ? new Audio('/goal.mp3') : false; }).catch(() => { goalFile = false; });
  RF.goalSong = () => {
    if (muted) return;
    if (goalFile) { try { goalFile.currentTime = 0; goalFile.volume = 0.9; goalFile.play(); setTimeout(() => { try { goalFile.pause(); } catch (e) { /* noop */ } }, 9000); return; } catch (e) { /* 합성음으로 */ } }
    const B = 0.27; // 한 박자
    const mel = [[1319, 1568, 330], [1175, 1480, 294], [1319, 1568, 330], [1568, 1760, 392]]; // 티·키 두 음 + 퐁 음높이
    for (let r = 0; r < 4; r++) {
      const t = r * B * 4;
      tone(mel[r][0], 0.09, 'square', 0.07, t); tone(mel[r][1], 0.09, 'square', 0.07, t + B * 0.5); // 티-키
      tone(mel[r][2] * 1.6, 0.22, 'sine', 0.2, t + B * 1.5, mel[r][2] * 0.5); // 퐁 (뿅 내려가는 소리)
      noise(0.05, 0.12, 2500, t + B * 3); tone(900, 0.05, 'square', 0.05, t + B * 3); // 크
    }
    [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.12, 4 * B * 4 + i * 0.09));
    try { // 가사 부분 (브라우저 음성 합성; 한국어 음성이 없는 기기에서는 효과음만 나옵니다)
      const ss = window.speechSynthesis; if (!ss) return;
      ss.cancel(); const u = new SpeechSynthesisUtterance('티키 퐁크! 티키 퐁크! 티키 퐁크!');
      u.lang = 'ko-KR'; u.rate = 1.25; u.pitch = 1.7; u.volume = 0.8; ss.speak(u);
    } catch (e) { /* noop */ }
  };
  RF.isMuted = () => muted;
  RF.setMuted = (m) => { muted = !!m; LS.set('mute', muted); };
  document.addEventListener('pointerdown', () => ctx(), { once: true, passive: true });

  // ───────────── 카탈로그/유틸 ─────────────
  const RAR = () => RF.cat.rarities;
  const rarOf = (k) => RAR().find((r) => r.key === k);
  RF.rarOf = rarOf;
  const isOwned = (id) => { const p = RF.byId[id]; return !!p && (p.starter || (S.inv[id] || 0) > 0); };
  const countOf = (id) => (RF.byId[id] && RF.byId[id].starter ? 1 : S.inv[id] || 0);
  const lvOf = (id) => (RF.byId[id].starter ? 0 : Math.min(RF.cat.maxDup, Math.max(0, countOf(id) - 1)));
  const eff = (id) => {
    const p = RF.byId[id], m = 1 + lvOf(id) * 0.02, o = {};
    for (const k in p.stats) o[k] = Math.min(100, Math.round(p.stats[k] * m));
    return o;
  };
  const effOvr = (id) => { const st = eff(id), k = Object.keys(st); return Math.round(k.reduce((a, x) => a + st[x], 0) / k.length); }; // 모든 능력치의 평균
  RF.isOwned = isOwned; RF.effOvr = effOvr;

  function sanitizeLineup() {
    const slots = RF.cat.slots;
    const starters = ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'S_FW2'];
    const out = []; const used = new Set();
    for (let i = 0; i < slots.length; i++) {
      let id = S.lineup && S.lineup[i];
      const p = RF.byId[id];
      if (!p || !isOwned(id) || used.has(id)) id = starters[i];
      used.add(id); out.push(id);
    }
    S.lineup = out; if (S.uid) LS.set('lineup_' + S.uid, out);
  }
  RF.teamPayload = () => ({ lineup: S.lineup });
  const teamAvg = () => Math.round(S.lineup.reduce((s, id, i) => s + effOvr(id, RF.cat.slots[i]), 0) / S.lineup.length);

  function jersey(p) {
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 10 4 22l8 12 8-6v28h24V28l8 6 8-12L44 10Q32 18 20 10z" fill="${p.c1}" stroke="#0008" stroke-width="2"/><path d="M20 10Q32 18 44 10v5Q32 23 20 15z" fill="${p.c2}"/><path d="M20 49h24v4H20z" fill="${p.c2}" opacity=".75"/><text x="32" y="43" text-anchor="middle" font-size="19" font-weight="900" fill="${p.c2}" stroke="#000a" stroke-width="1.2" paint-order="stroke">${p.number}</text></svg>`;
  }
  RF.cardHTML = (id, o = {}) => {
    const p = RF.byId[id]; const r = rarOf(p.rarity);
    const lock = !!o.locked; const lv = lock ? 0 : lvOf(id);
    return `<div class="pcard r-${p.rarity}${lock ? ' locked' : ''}${o.sel ? ' sel' : ''}${o.sm ? ' sm' : ''}" data-id="${id}">
      ${o.isNew ? '<div class="new">NEW</div>' : ''}
      <div class="t"><span class="ovr">${lock ? '?' : (o.base ? p.ovr : effOvr(id, o.pos))}</span><span class="pos">${lock && p.hidden ? '?' : (o.pos || p.pos)}</span></div>
      ${jersey(p)}
      <div class="nm">${lock ? '???' : esc(p.name)}</div>
      <div class="rar">${r.name}</div>
      ${lv > 0 ? `<div class="lv">Lv.${lv + 1}${lv >= RF.cat.maxDup ? ' MAX' : ''}</div>` : ''}
    </div>`;
  };

  // ───────────── 화면 전환 ─────────────
  const SCREENS = ['home', 'gacha', 'box', 'dex', 'team', 'rank', 'room'];
  RF.go = (name) => {
    if (!RF.cat && name !== 'home') { RF.toast('서버 데이터를 불러오는 중입니다', true); return; }
    if (name === 'home' && RF.hooks.inRoom && RF.hooks.inRoom()) name = 'room';
    SCREENS.forEach((s) => $('scr-' + s).classList.toggle('active', s === name));
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    RF.screen = name;
    ({ home: renderHome, gacha: renderGacha, box: renderBox, dex: renderDex, team: renderTeam, rank: renderRank, room: () => RF.hooks.renderRoom && RF.hooks.renderRoom() }[name] || (() => {}))();
    const sc = $('scr-' + name); if (sc) sc.scrollTop = 0;
  };
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => { RF.sfx('tap'); RF.go(b.dataset.go); }));

  // ───────────── 모달 ─────────────
  function openModal(html) { $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
  function closeModal() { $('modal').classList.add('hidden'); $('modalBody').innerHTML = ''; }
  RF.openModal = openModal; RF.closeModal = closeModal;
  $('modalX').addEventListener('click', closeModal);
  $('modal').addEventListener('pointerdown', (e) => { if (e.target === $('modal')) closeModal(); });

  const STAT_LABEL = [['spd', '속도'], ['sht', '슛'], ['pas', '패스'], ['def', '수비'], ['sta', '체력'], ['dri', '드리블'], ['gk', '골키퍼']];
  function detail(id, locked) {
    const p = RF.byId[id], r = rarOf(p.rarity), st = locked ? p.stats : eff(id);
    const lv = locked ? 0 : lvOf(id);
    let eq = '';
    if (!locked && isOwned(id)) {
      const idx = RF.cat.slots.map((s, i) => i);
      eq = '<div class="row">' + idx.map((i, n) => `<button class="btn primary" data-eq="${i}">${RF.cat.posName[RF.cat.slots[i]]}${RF.cat.slots.filter((x) => x === RF.cat.slots[i]).length > 1 ? (idx.filter((j) => RF.cat.slots[j] === RF.cat.slots[i]).indexOf(i) + 1) : ''}에 장착${S.lineup[i] === id ? ' ✓' : ''}</button>`).join('') + '</div>';
    }
    openModal(`<div class="det">${RF.cardHTML(id, { locked })}<div><h3>${locked ? '???' : esc(p.name)}</h3><p>${r.name} · ${locked && p.hidden ? '?' : RF.cat.posName[p.pos]} · #${p.number}</p>
      <p style="margin-top:6px">${locked ? '아직 획득하지 못한 선수입니다.' : p.starter ? '기본 지급 선수' : `보유 ${countOf(id)}장 · 강화 Lv.${lv + 1}${lv >= RF.cat.maxDup ? ' (MAX)' : ` (+${lv * 2}%)`}`}</p></div></div>
      <div class="bars">${(locked && p.hidden ? [] : STAT_LABEL).map(([k, n]) => `<div class="bar"><span>${n}</span><i><span style="width:${st[k]}%"></span></i><b>${st[k]}</b></div>`).join('')}</div>${eq}`);
    $('modalBody').querySelectorAll('[data-eq]').forEach((b) => b.addEventListener('click', () => { equip(+b.dataset.eq, id); closeModal(); }));
  }
  RF.detail = detail;
  function equip(slot, id) {
    const p = RF.byId[id]; const cur = S.lineup[slot];
    const other = S.lineup.findIndex((x, i) => i !== slot && x === id);
    if (other >= 0) S.lineup[other] = cur; // 같은 포지션 슬롯끼리 교환
    S.lineup[slot] = id; sanitizeLineup();
    RF.toast(`${p.name} 장착`); RF.sfx('tap');
    if (RF.hooks.onTeamChange) RF.hooks.onTeamChange();
    RF.go(RF.screen === 'room' ? 'room' : RF.screen || 'home');
  }

  // ───────────── 홈 ─────────────
  /** 일일 출석 카드: 이번 주 7일 보상표 + 오늘 출석 버튼 (서버가 판정) */
  function renderAttend() {
    const el = $('attend'); if (!el) return;
    const rewards = (RF.cat && RF.cat.attend) || [1000, 2000, 3000, 4000, 5000, 5000, 6000];
    const at = S.att || { n: 0, today: false, next: rewards[0] };
    const cells = rewards.map((r, i) => {
      const done = i < at.n, cur = i === at.n && !at.today;
      return `<div class="att-c${done ? ' done' : ''}${cur ? ' cur' : ''}"><small>${i + 1}일</small><b>${done ? '✔' : r / 1000 + '천'}</b></div>`;
    }).join('');
    const done = at.today || at.n >= rewards.length;
    el.innerHTML = `<div class="sec-title" style="margin:0 0 8px">📅 일일 출석 <small>매주 월요일 초기화</small></div><div class="att-grid">${cells}</div>
      <button id="btnAttend" class="btn ${done ? 'ghost' : 'primary'} big" style="width:100%;margin-top:10px" ${done ? 'disabled' : ''}>${done ? '오늘 출석 완료 ✓' : `출석 체크 · +${won(at.next)}`}</button>`;
    const b = $('btnAttend');
    if (b && !done) b.addEventListener('click', async () => {
      b.disabled = true;
      try {
        const r = await RF.api('/api/attend', {}); const j = await r.json();
        if (j.acct) RF.setAccount(j.acct);
        if (r.ok) { RF.sfx('legend'); RF.toast(`출석 ${j.day}일차! +${won(j.amount)}`); } else RF.toast(j.error === 'already' ? '오늘은 이미 출석했어요' : '출석 실패', true);
      } catch (e) { RF.toast('서버에 연결할 수 없습니다', true); b.disabled = false; }
    });
  }
  // ───────────── 랭킹 / 플레이어 목록 / 관리자 ─────────────
  let playersCache = null, playersAt = 0;
  async function loadPlayers(force) {
    if (!force && playersCache && Date.now() - playersAt < 15000) return playersCache;
    try { const r = await RF.api('/api/players'); if (r.ok) { playersCache = await r.json(); playersAt = Date.now(); } } catch (e) { /* noop */ }
    return playersCache;
  }
  RF.loadPlayers = loadPlayers;
  const medal = (i) => (i === 0 ? '👑' : i === 1 ? '🥈' : i === 2 ? '🥉' : i + 1);
  function renderTopLine(d) {
    const el = $('topLine'); if (!el || !d || !d.players.length) return;
    const t = d.players[0], myRank = d.players.findIndex((p) => p.me) + 1;
    el.style.display = ''; el.innerHTML = `<div><b>👑 ${esc(t.nick)}</b>돈 1위 · ${won(t.bal)}</div><div><b>${myRank ? myRank + '위' : '-'}</b>내 순위 (${d.players.length}명 중)</div>`;
  }
  async function renderRank() {
    const list = $('rankList'); list.innerHTML = '<p class="tiny center">불러오는 중…</p>';
    const d = await loadPlayers(true); if (!d) { list.innerHTML = '<p class="tiny center">불러오지 못했어요</p>'; return; }
    $('rankSub').textContent = `${d.players.length}명${d.admin ? ' · 관리자' : ''}`;
    list.innerHTML = d.players.map((p, i) => `<div class="rk${p.me ? ' me' : ''}${i === 0 ? ' top' : ''}">
      <span class="rn">${medal(i)}</span><span class="nm">${esc(p.nick)}${p.me ? ' <small>(나)</small>' : ''}<small>보유 캐릭터 ${p.owned}</small></span>
      <b class="bl">${won(p.bal)}</b>${d.admin ? `<span class="adm"><button data-money="${esc(p.id)}" data-nick="${esc(p.nick)}" data-bal="${p.bal}" aria-label="돈 관리">💰</button>${p.me ? '' : `<button data-del="${esc(p.id)}" data-nick="${esc(p.nick)}" aria-label="계정 삭제">🗑</button>`}</span>` : ''}</div>`).join('');
    list.querySelectorAll('[data-money]').forEach((b) => b.addEventListener('click', () => moneyModal(b.dataset.money, b.dataset.nick, +b.dataset.bal)));
    list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', () => delModal(b.dataset.del, b.dataset.nick)));
    renderTopLine(d);
  }
  async function adminCall(path, body) {
    try { const r = await RF.api(path, body); const j = await r.json(); return { ok: r.ok, j }; } catch (e) { return { ok: false, j: { error: 'network' } }; }
  }
  const AERR = { forbidden: '권한이 없어요', bad_amount: '금액을 확인해 주세요', no_account: '이미 없는 계정이에요', self: '내 계정은 삭제할 수 없어요', locked: '내기 진행 중인 계정이라 지금은 삭제할 수 없어요', network: '서버에 연결할 수 없어요' };
  function moneyModal(id, nick, bal) {
    openModal(`<h3>💰 ${esc(nick)} 돈 관리</h3><p class="tiny">현재 ${won(bal)}</p>
      <input id="admAmt" class="inp" inputmode="numeric" placeholder="금액 (숫자)" autocomplete="off">
      <div class="row" style="margin-top:10px"><button id="admSet" class="btn primary">이 금액으로 설정</button><button id="admAdd" class="btn">+ 더하기</button><button id="admSub" class="btn">− 빼기</button></div>`);
    const go = async (mode, sign) => {
      const n = Math.trunc(Number(String($('admAmt').value).replace(/[^0-9]/g, ''))); if (!(n >= 0) || $('admAmt').value === '') return RF.toast('금액을 입력해 주세요', true);
      const r = await adminCall('/api/admin/money', { target: id, mode, amount: sign * n });
      if (r.ok) { closeModal(); RF.toast(`${nick}: ${won(r.j.before)} → ${won(r.j.bal)}`); renderRank(); } else RF.toast(AERR[r.j.error] || '실패했어요', true);
    };
    $('admSet').addEventListener('click', () => go('set', 1)); $('admAdd').addEventListener('click', () => go('add', 1)); $('admSub').addEventListener('click', () => go('add', -1));
  }
  function delModal(id, nick) {
    openModal(`<h3>🗑 계정 삭제</h3><p class="tiny"><b>${esc(nick)}</b> 계정과 보유 캐릭터·잔액이 모두 사라지고 <b>되돌릴 수 없어요.</b></p>
      <div class="row"><button id="admDel" class="btn danger">삭제하기</button><button id="admNo" class="btn">취소</button></div>`);
    $('admNo').addEventListener('click', closeModal);
    $('admDel').addEventListener('click', async () => {
      const r = await adminCall('/api/admin/delete', { target: id });
      if (r.ok) { closeModal(); RF.toast(`${nick} 계정을 삭제했어요`); renderRank(); } else RF.toast(AERR[r.j.error] || '실패했어요', true);
    });
  }

  function renderHome() {
    renderAttend(); loadPlayers().then(renderTopLine);
    $('nameInput').value = S.name; $('acctMail').textContent = S.email || '';
    $('homeTeam').innerHTML = S.lineup.map((id, i) => {
      const p = RF.byId[id], c = rarOf(p.rarity).color;
      return `<div class="mini" style="--rc:${c}"><b>${effOvr(id, RF.cat.slots[i])}</b>${RF.cat.slots[i]}</div>`;
    }).join('');
    const total = RF.cat.players.filter((p) => !p.starter).length;
    const have = RF.cat.players.filter((p) => !p.starter && isOwned(p.id)).length;
    $('homeStats').innerHTML = `<div><b>${won(S.bal)}</b>내 잔액</div><div><b>${have}/${total}</b>도감</div><div><b>${teamAvg()}</b>팀 평균</div>`;
  }
  $('btnLogout').addEventListener('click', () => RF.logout(false));
  $('nameInput').readOnly = true; // 닉네임은 아이디로 고정

  // ───────────── 뽑기 ─────────────
  let busy = false;
  function renderGacha() {
    $('rates').innerHTML = RAR().map((r) => `<div class="rate" style="--rc:${r.color}"><i class="dot"></i><span style="width:34px">${r.name}</span><div class="bar2"><span style="width:${r.rate}%"></span></div><b>${r.rate}%</b></div>`).join('');
    $('pullStat').textContent = `누적 뽑기 ${S.pulls}회 · 1회 ${won(COST())} · CPU 연습 경기 승리 시 +${won((RF.cat && RF.cat.winReward) || 3000)}`;
    $('pull1').textContent = `1회 뽑기 · ${won(COST())}`;
    $('pull10').textContent = `10회 연속 · ${won(COST() * 10)}`;
    $('pull1').disabled = busy || S.bal < COST();
    $('pull10').disabled = busy || S.bal < COST() * 10;
    $('orbHint').textContent = S.bal < COST() ? `잔액 부족 — CPU를 이기면 ${won((RF.cat && RF.cat.winReward) || 3000)}!` : '탭해서 1회 뽑기';
  }
  async function doPull(n) {
    if (busy) return;
    if (S.bal < COST() * n) { RF.toast(`잔액이 부족합니다 (${won(S.bal)}). CPU 연습 경기에서 이기면 ${won((RF.cat && RF.cat.winReward) || 3000)}을 드려요!`, true); return; }
    busy = true;
    $('pull1').disabled = $('pull10').disabled = true;
    const orb = $('orb'); orb.classList.add('shake'); RF.sfx('shake'); $('orbHint').textContent = '추첨 중…';
    let data;
    try {
      const [r] = await Promise.all([RF.api('/api/pull', { n }), sleep(1100)]);
      if (!r.ok) throw new Error(r.status === 402 ? '잔액이 부족합니다' : r.status === 429 ? '너무 빠르게 뽑고 있어요. 잠시 후 다시!' : '서버 오류');
      data = await r.json();
    } catch (e) {
      orb.classList.remove('shake'); busy = false; renderGacha();
      RF.toast(e.message === 'Failed to fetch' ? '서버에 연결할 수 없습니다' : e.message, true); return;
    }
    RF.setAccount(data.acct); sanitizeLineup();
    const rank = (k) => RAR().findIndex((r) => r.key === k);
    const best = data.results.reduce((a, b) => (rank(RF.byId[b.id].rarity) > rank(RF.byId[a.id].rarity) ? b : a));
    const bc = rarOf(RF.byId[best.id].rarity).color;
    orb.style.setProperty('--oc', bc);
    await sleep(350);
    orb.classList.remove('shake'); $('orbHint').textContent = '탭해서 1회 뽑기';
    await reveal(data.results, bc);
    busy = false;
    renderGacha();
  }
  $('pull1').addEventListener('click', () => doPull(1));
  $('pull10').addEventListener('click', () => doPull(10));
  $('orb').addEventListener('click', () => doPull(1));

  // 파티클
  const fx = { ps: [], run: false };
  function fxLoop() {
    const cv = $('fxc'), c = cv.getContext('2d');
    const w = (cv.width = cv.clientWidth * (window.devicePixelRatio || 1)), h = (cv.height = cv.clientHeight * (window.devicePixelRatio || 1));
    c.clearRect(0, 0, w, h);
    fx.ps = fx.ps.filter((p) => p.life > 0);
    for (const p of fx.ps) {
      p.x += p.vx; p.y += p.vy; p.vy += p.g; p.life -= 1; p.a = Math.max(0, p.life / p.max);
      c.globalAlpha = p.a; c.fillStyle = p.c; c.beginPath(); c.arc(p.x * w, p.y * h, p.r * (window.devicePixelRatio || 1), 0, 6.3); c.fill();
    }
    c.globalAlpha = 1;
    if (fx.ps.length) requestAnimationFrame(fxLoop); else fx.run = false;
  }
  function burst(color, n, x = 0.5, y = 0.45) {
    for (let i = 0; i < n; i++) {
      const a = Math.random() * 6.283, s = 0.004 + Math.random() * 0.016;
      fx.ps.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s * 1.6 - 0.004, g: 0.0003, r: 2 + Math.random() * 4, c: color, life: 60 + Math.random() * 40, max: 100 });
    }
    if (!fx.run) { fx.run = true; requestAnimationFrame(fxLoop); }
  }
  RF.burst = burst;

  let skip = false;
  async function reveal(results, bestColor) {
    const ov = $('reveal'), st = $('revealStage'); skip = false;
    st.innerHTML = ''; ov.classList.remove('hidden'); $('revealClose').classList.add('hidden'); $('revealSkip').classList.remove('hidden');
    const flash = (c) => { const f = document.createElement('div'); f.className = 'flash'; f.style.setProperty('--fc', c); ov.appendChild(f); setTimeout(() => f.remove(), 950); };
    const power = { common: 0, rare: 18, hero: 36, legend: 70, myth: 120, trans: 220 };
    const info = (r) => (r.isNew ? '' : '');
    flash(bestColor);
    if (results.length === 1) {
      const r = results[0], p = RF.byId[r.id], rc = rarOf(p.rarity);
      st.innerHTML = `<div class="rv-single" style="--rc:${rc.color}"><div class="rtag">${rc.name}</div>${RF.cardHTML(r.id, { isNew: r.isNew })}<div style="margin-top:14px;font-weight:800">${r.isNew ? '🎉 새 선수 획득!' : `중복! 강화 Lv.${r.level + 1}${r.level >= RF.cat.maxDup ? ' (MAX)' : ' (+2% 능력치)'}`}</div></div>`;
      RF.sfx(p.rarity); burst(rc.color, 40 + power[p.rarity]);
      await sleep(900);
    } else {
      st.innerHTML = '<div class="rv-grid"></div>'; const g = st.firstChild;
      for (let i = 0; i < results.length; i++) {
        const r = results[i], p = RF.byId[r.id], rc = rarOf(p.rarity);
        const el = document.createElement('div'); el.innerHTML = RF.cardHTML(r.id, { isNew: r.isNew, sm: true });
        const card = el.firstChild; card.style.animationDelay = '0s'; g.appendChild(card);
        RF.sfx(p.rarity); burst(rc.color, 8 + power[p.rarity] / 2, 0.15 + 0.7 * ((i % 5) / 4), 0.25 + 0.4 * Math.floor(i / 5));
        if (power[p.rarity] >= 70) flash(rc.color);
        if (!skip) await sleep(p.rarity === 'trans' ? 1600 : p.rarity === 'myth' ? 900 : p.rarity === 'legend' ? 650 : 330);
      }
      const dups = results.filter((r) => !r.isNew).length;
      const note = document.createElement('div'); note.className = 'tiny center'; note.style.cssText = 'grid-column:1/-1;pointer-events:none';
      note.textContent = `신규 ${results.length - dups} · 중복 ${dups}`; g.appendChild(note);
    }
    $('revealSkip').classList.add('hidden'); $('revealClose').classList.remove('hidden');
    await new Promise((res) => { $('revealClose').onclick = () => { ov.classList.add('hidden'); res(); }; });
  }
  $('revealSkip').addEventListener('click', () => { skip = true; });

  // ───────────── 보관함 ─────────────
  let boxFilter = 'ALL';
  function renderBox() {
    const owned = RF.cat.players.filter((p) => isOwned(p.id));
    $('boxCount').textContent = `${owned.length}명 보유`;
    const f = ['ALL', 'GK', 'DF', 'MF', 'FW'];
    $('boxFilter').innerHTML = f.map((x) => `<button class="chip${x === boxFilter ? ' on' : ''}" data-f="${x}">${x === 'ALL' ? '전체' : RF.cat.posName[x]}</button>`).join('');
    $('boxFilter').querySelectorAll('.chip').forEach((b) => b.addEventListener('click', () => { boxFilter = b.dataset.f; renderBox(); }));
    const rank = (k) => RAR().findIndex((r) => r.key === k);
    const list = owned.filter((p) => boxFilter === 'ALL' || p.pos === boxFilter).sort((a, b) => rank(b.rarity) - rank(a.rarity) || effOvr(b.id) - effOvr(a.id));
    $('boxGrid').innerHTML = list.map((p) => RF.cardHTML(p.id, { sel: S.lineup.includes(p.id) })).join('') || '<p class="tiny">선수가 없습니다. 뽑기에서 선수를 뽑아보세요!</p>';
    $('boxGrid').querySelectorAll('.pcard').forEach((c) => c.addEventListener('click', () => detail(c.dataset.id)));
  }

  // ───────────── 도감 ─────────────
  function renderDex() {
    const all = RF.cat.players.filter((p) => !p.starter);
    const have = all.filter((p) => isOwned(p.id));
    $('dexCount').textContent = `${have.length}/${all.length} (${Math.round((have.length / all.length) * 100)}%)`;
    $('dexSummary').innerHTML = RAR().map((r) => {
      const t = all.filter((p) => p.rarity === r.key), h = t.filter((p) => isOwned(p.id));
      return `<div style="--rc:${r.color}"><b>${h.length}/${t.length}</b>${r.name}</div>`;
    }).join('');
    const rank = (k) => RAR().findIndex((r) => r.key === k);
    const list = all.slice().sort((a, b) => rank(b.rarity) - rank(a.rarity) || b.ovr - a.ovr);
    $('dexGrid').innerHTML = list.map((p) => RF.cardHTML(p.id, { locked: !isOwned(p.id), base: !isOwned(p.id) })).join('');
    $('dexGrid').querySelectorAll('.pcard').forEach((c) => c.addEventListener('click', () => {
      const id = c.dataset.id; if (isOwned(id)) detail(id); else detail(id, true);
    }));
  }

  // ───────────── 편성 ─────────────
  const SLOT_POS = [[50, 88], [24, 66], [76, 66], [50, 46], [26, 20], [74, 20]];
  function renderTeam() {
    $('teamOvr').textContent = `팀 평균 ${teamAvg()}`;
    $('teamField').innerHTML = RF.cat.slots.map((s, i) => `<div class="slot" style="left:${SLOT_POS[i][0]}%;top:${SLOT_POS[i][1]}%" data-i="${i}"><div class="tag">${s}</div>${RF.cardHTML(S.lineup[i], { sm: true, pos: s })}</div>`).join('');
    $('teamField').querySelectorAll('.slot').forEach((el) => el.addEventListener('click', () => pickSlot(+el.dataset.i)));
    $('teamList').textContent = '';
  }
  function pickSlot(i) {
    const pos = RF.cat.slots[i];
    const list = RF.cat.players.filter((p) => isOwned(p.id)).sort((a, b) => effOvr(b.id, pos) - effOvr(a.id, pos));
    openModal(`<h3 style="margin:0 0 10px">${RF.cat.posName[pos]} 선택</h3><div class="pick-list">` + list.map((p) => {
      const r = rarOf(p.rarity), st = eff(p.id);
      const main = (pos === 'GK' ? `골키퍼 ${st.gk}` : pos === 'FW' ? `슛 ${st.sht} · 속도 ${st.spd}` : pos === 'MF' ? `패스 ${st.pas} · 체력 ${st.sta}` : `수비 ${st.def} · 체력 ${st.sta}`) + ` · 드리블 ${st.dri}`;
      return `<button class="pick${S.lineup[i] === p.id ? ' cur' : ''}" style="--rc:${r.color}" data-id="${p.id}"><span class="o">${effOvr(p.id, pos)}</span><span class="n">${esc(p.name)}<small>${r.name} · ${main}${lvOf(p.id) ? ` · Lv.${lvOf(p.id) + 1}` : ''}</small></span><span>${S.lineup[i] === p.id ? '✓' : ''}</span></button>`;
    }).join('') + '</div>');
    $('modalBody').querySelectorAll('.pick').forEach((b) => b.addEventListener('click', () => { equip(i, b.dataset.id); closeModal(); }));
  }
  RF.pickSlot = pickSlot;

  // ───────────── 초기화 ─────────────
  async function loadCatalog() {
    for (let tries = 0; ; tries++) {
      let why = '';
      try {
        const ctl = new AbortController(); const to = setTimeout(() => ctl.abort(), 12000);
        const r = await fetch('/api/catalog?t=' + Date.now(), { signal: ctl.signal }); clearTimeout(to);
        if (!r.ok) { why = 'HTTP ' + r.status; throw new Error(why); }
        const ct = r.headers.get('content-type') || '';
        if (!ct.includes('json')) { why = '응답이 JSON이 아님(' + ct.split(';')[0] + ')'; throw new Error(why); }
        RF.cat = await r.json(); break;
      } catch (e) {
        why = why || (e.name === 'AbortError' ? '12초 안에 응답 없음' : e.message);
        const cached = LS.get('catalog', null);
        if (cached) { RF.cat = cached; break; }
        RF.toast((tries < 1 ? '서버에 연결 중…' : '서버를 깨우는 중입니다 (최대 1분)…') + ' [' + why + ']');
        console.warn('catalog load failed:', why);
        await sleep(3000);
      }
    }
    LS.set('catalog', RF.cat);
    RF.cat.players.forEach((p) => { RF.byId[p.id] = p; });
    await bootAuth();
  }

  // ───────────── 로그인 (구글) ─────────────
  function finishLogin(acct) {
    S.uid = acct.id;
    S.lineup = LS.get('lineup_' + acct.id, null);
    RF.setAccount(acct);
    sanitizeLineup();
    $('login').classList.add('hidden');
    RF.ready = true;
    RF.go('home');
    if (RF.hooks.onReady) RF.hooks.onReady();
    if (RF.hooks.onLogin) RF.hooks.onLogin();
  }
  async function doPw(kind) {
    const msg = $('loginMsg'); const username = $('lgId').value.trim(), password = $('lgPw').value;
    if (!username || !password) { msg.textContent = '아이디와 비밀번호를 입력해주세요'; return; }
    msg.textContent = kind === 'register' ? '가입 중…' : '로그인 중…';
    try {
      const legacy = LS.get('token', '');
      const r = await fetch(kind === 'register' ? '/api/register' : '/api/signin', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username, password, legacyToken: legacy || undefined }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        const E = { bad_username: '아이디는 2~20자로 만들어주세요', bad_password: '비밀번호는 6자 이상으로 해주세요', exists: '이미 있는 아이디예요', bad_login: '아이디 또는 비밀번호가 틀렸어요', locked: '로그인 실패가 많아 5분간 잠겼어요', too_many_requests: '시도가 너무 많아요. 잠시 후 다시!' };
        throw new Error(E[d.error] || '실패했어요. 다시 시도해주세요');
      }
      S.auth = d.session; LS.set('auth', d.session); LS.set('lastid', username); LS.del('token'); LS.del('cid');
      finishLogin(d.account);
    } catch (e) { msg.textContent = e.message === 'Failed to fetch' ? '서버에 연결할 수 없습니다' : e.message; }
  }
  $('lgId').value = LS.get('lastid', '');
  $('btnSignin').addEventListener('click', () => doPw('signin'));
  $('btnSignup').addEventListener('click', () => doPw('register'));
  $('lgPw').addEventListener('keydown', (e) => { if (e.key === 'Enter') doPw('signin'); });
  async function doLogin(credential) {
    const msg = $('loginMsg'); msg.textContent = '로그인 중…';
    try {
      const legacy = LS.get('token', '');
      const r = await fetch('/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ credential, legacyToken: legacy || undefined }) });
      if (!r.ok) throw new Error(r.status === 429 ? '시도가 너무 많아요. 잠시 후 다시!' : '로그인에 실패했습니다. 다시 시도해주세요.');
      const d = await r.json();
      S.auth = d.session; LS.set('auth', d.session); LS.del('token'); LS.del('cid');
      finishLogin(d.account);
    } catch (e) { msg.textContent = e.message === 'Failed to fetch' ? '서버에 연결할 수 없습니다' : e.message; }
  }
  function loadGsi() {
    return new Promise((res, rej) => {
      if (window.google && window.google.accounts) return res();
      const sc = document.createElement('script'); sc.src = 'https://accounts.google.com/gsi/client'; sc.async = true;
      sc.onload = res; sc.onerror = () => rej(new Error('구글 로그인 스크립트를 불러오지 못했어요'));
      document.head.appendChild(sc);
    });
  }
  async function showLogin() {
    $('login').classList.remove('hidden');
    let cfg = {};
    try { cfg = await (await fetch('/api/config')).json(); } catch (e) { $('loginMsg').textContent = '서버에 연결할 수 없습니다'; }
    if (cfg.devLogin) {
      const b = $('devLogin'); b.classList.remove('hidden');
      b.onclick = () => doLogin('dev:' + ($('devName').value || 'tester'));
    }
    if (cfg.github) {
      const g = $('ghbtn'); g.classList.remove('hidden');
      g.onclick = () => { location.href = '/auth/github' + (LS.get('token', '') ? '?legacy=' + encodeURIComponent(LS.get('token', '')) : ''); };
      $('loginMsg').textContent = '';
    }
    if (!cfg.googleClientId) return;
    try {
      await loadGsi();
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (resp) => doLogin(resp.credential), ux_mode: 'popup' });
      google.accounts.id.renderButton($('gbtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', width: 260, locale: 'ko' });
      $('loginMsg').textContent = '';
    } catch (e) { $('loginMsg').textContent = e.message; }
  }
  async function bootAuth() {
    try { // 깃허브 로그인 후 돌아온 주소(#auth=...)에서 세션 받기
      const h = new URLSearchParams(location.hash.slice(1));
      if (h.get('auth')) { S.auth = h.get('auth'); LS.set('auth', S.auth); LS.del('token'); history.replaceState(null, '', location.pathname); }
      else if (h.get('autherr')) { history.replaceState(null, '', location.pathname); RF.toast('로그인에 실패했어요. 다시 시도해주세요', true); }
    } catch (e) { /* noop */ }
    if (S.auth) {
      try {
        const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + S.auth } });
        if (r.ok) return finishLogin((await r.json()).account);
        if (r.status === 401) { LS.del('auth'); S.auth = ''; }
        else throw new Error('HTTP ' + r.status);
      } catch (e) { if (S.auth) { RF.toast('서버를 깨우는 중입니다…'); await sleep(3000); return bootAuth(); } }
    }
    await showLogin();
  }
  RF.refreshAll = () => { if (RF.ready && RF.screen) RF.go(RF.screen === 'room' ? 'room' : RF.screen); };
  RF.sanitizeLineup = sanitizeLineup;
  RF.teamAvg = teamAvg;
  loadCatalog();
})();


// ───────────── 새 버전 자동 새로고침 ─────────────
// 서버가 새로 배포되면(/api/version 값이 바뀌면) 경기 중이 아닐 때 자동으로 새로고침한다.
(function () {
  const RF = window.RF; let cur = null, pending = false, timer = 0;
  const vis = (id) => { const e = document.getElementById(id); return !!e && !e.classList.contains('hidden'); };
  // 진행 중인 경기/방/뽑기 연출 중에는 새로고침하지 않는다
  const busy = () => vis('scr-match') || vis('reveal') || (vis('scr-bounce') && !vis('bMenu') && !vis('bResult'));
  async function check() {
    try {
      const r = await fetch('/api/version', { cache: 'no-store' }); if (!r.ok) return;
      const v = (await r.json()).v; if (!v) return;
      if (cur === null) { cur = v; return; }
      if (v !== cur) pending = true;
    } catch (e) { /* 서버 재시작 중: 다음에 다시 */ }
    if (pending) apply();
  }
  function apply() {
    if (!pending) return;
    if (busy()) { clearTimeout(timer); timer = setTimeout(apply, 3000); return; }
    pending = false;
    try { RF.toast('🔄 새 버전이 나왔어요. 새로고침합니다…'); } catch (e) { /* noop */ }
    setTimeout(() => location.reload(), 1200);
  }
  // 관리자가 돈을 바꾸는 등 서버 쪽 변경이 내 화면에도 반영되도록 가끔 내 계정을 새로 받아온다
  async function refreshMe() { if (busy() || !RF.state || !RF.state.auth) return; try { const r = await fetch('/api/me', { headers: { Authorization: 'Bearer ' + RF.state.auth } }); if (r.ok) RF.setAccount((await r.json()).account); } catch (e) { /* noop */ } }
  check(); setInterval(check, 45000); setInterval(refreshMe, 30000);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { check(); refreshMe(); } });
  addEventListener('focus', check); addEventListener('online', check);
  RF.checkVersion = check;
})();
