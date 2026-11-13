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
    S.uid = a.id; S.inv = a.inv || {}; S.pulls = a.pulls || 0; S.bal = a.bal || 0; S.locked = a.locked || 0; S.name = a.nick || S.name; S.email = a.email;
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
      default: break;
    }
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
    for (const k in p.stats) o[k] = Math.min(99, Math.round(p.stats[k] * m));
    return o;
  };
  const effOvr = (id) => Math.min(99, Math.round(RF.byId[id].ovr * (1 + lvOf(id) * 0.02)));
  RF.isOwned = isOwned; RF.effOvr = effOvr;

  function sanitizeLineup() {
    const slots = RF.cat.slots;
    const starters = ['S_GK', 'S_DF1', 'S_DF2', 'S_MF', 'S_FW1', 'S_FW2'];
    const out = []; const used = new Set();
    for (let i = 0; i < slots.length; i++) {
      let id = S.lineup && S.lineup[i];
      const p = RF.byId[id];
      if (!p || p.pos !== slots[i] || !isOwned(id) || used.has(id)) id = starters[i];
      used.add(id); out.push(id);
    }
    S.lineup = out; if (S.uid) LS.set('lineup_' + S.uid, out);
  }
  RF.teamPayload = () => ({ lineup: S.lineup });
  const teamAvg = () => Math.round(S.lineup.reduce((s, id) => s + effOvr(id), 0) / S.lineup.length);

  function jersey(p) {
    return `<svg viewBox="0 0 64 64" aria-hidden="true"><path d="M20 10 4 22l8 12 8-6v28h24V28l8 6 8-12L44 10Q32 18 20 10z" fill="${p.c1}" stroke="#0008" stroke-width="2"/><path d="M20 10Q32 18 44 10v5Q32 23 20 15z" fill="${p.c2}"/><path d="M20 49h24v4H20z" fill="${p.c2}" opacity=".75"/><text x="32" y="43" text-anchor="middle" font-size="19" font-weight="900" fill="${p.c2}" stroke="#000a" stroke-width="1.2" paint-order="stroke">${p.number}</text></svg>`;
  }
  RF.cardHTML = (id, o = {}) => {
    const p = RF.byId[id]; const r = rarOf(p.rarity);
    const lock = !!o.locked; const lv = lock ? 0 : lvOf(id);
    return `<div class="pcard r-${p.rarity}${lock ? ' locked' : ''}${o.sel ? ' sel' : ''}${o.sm ? ' sm' : ''}" data-id="${id}">
      ${o.isNew ? '<div class="new">NEW</div>' : ''}
      <div class="t"><span class="ovr">${lock ? '?' : (o.base ? p.ovr : effOvr(id))}</span><span class="pos">${p.pos}</span></div>
      ${jersey(p)}
      <div class="nm">${lock ? '???' : esc(p.name)}</div>
      <div class="rar">${r.name}</div>
      ${lv > 0 ? `<div class="lv">Lv.${lv + 1}${lv >= RF.cat.maxDup ? ' MAX' : ''}</div>` : ''}
    </div>`;
  };

  // ───────────── 화면 전환 ─────────────
  const SCREENS = ['home', 'gacha', 'box', 'dex', 'team', 'room'];
  RF.go = (name) => {
    if (!RF.cat && name !== 'home') { RF.toast('서버 데이터를 불러오는 중입니다', true); return; }
    if (name === 'home' && RF.hooks.inRoom && RF.hooks.inRoom()) name = 'room';
    SCREENS.forEach((s) => $('scr-' + s).classList.toggle('active', s === name));
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === name));
    RF.screen = name;
    ({ home: renderHome, gacha: renderGacha, box: renderBox, dex: renderDex, team: renderTeam, room: () => RF.hooks.renderRoom && RF.hooks.renderRoom() }[name] || (() => {}))();
    const sc = $('scr-' + name); if (sc) sc.scrollTop = 0;
  };
  document.querySelectorAll('#nav button').forEach((b) => b.addEventListener('click', () => { RF.sfx('tap'); RF.go(b.dataset.go); }));

  // ───────────── 모달 ─────────────
  function openModal(html) { $('modalBody').innerHTML = html; $('modal').classList.remove('hidden'); }
  function closeModal() { $('modal').classList.add('hidden'); $('modalBody').innerHTML = ''; }
  RF.openModal = openModal; RF.closeModal = closeModal;
  $('modalX').addEventListener('click', closeModal);
  $('modal').addEventListener('pointerdown', (e) => { if (e.target === $('modal')) closeModal(); });

  const STAT_LABEL = [['spd', '속도'], ['sht', '슛'], ['pas', '패스'], ['def', '수비'], ['sta', '체력'], ['gk', '골키퍼']];
  function detail(id, locked) {
    const p = RF.byId[id], r = rarOf(p.rarity), st = locked ? p.stats : eff(id);
    const lv = locked ? 0 : lvOf(id);
    let eq = '';
    if (!locked && isOwned(id)) {
      const idx = RF.cat.slots.map((s, i) => (s === p.pos ? i : -1)).filter((i) => i >= 0);
      eq = '<div class="row">' + idx.map((i, n) => `<button class="btn primary" data-eq="${i}">${idx.length > 1 ? `${p.pos} 슬롯 ${n + 1}에 ` : ''}장착${S.lineup[i] === id ? ' ✓' : ''}</button>`).join('') + '</div>';
    }
    openModal(`<div class="det">${RF.cardHTML(id, { locked })}<div><h3>${locked ? '???' : esc(p.name)}</h3><p>${r.name} · ${RF.cat.posName[p.pos]} · #${p.number}</p>
      <p style="margin-top:6px">${locked ? '아직 획득하지 못한 선수입니다.' : p.starter ? '기본 지급 선수' : `보유 ${countOf(id)}장 · 강화 Lv.${lv + 1}${lv >= RF.cat.maxDup ? ' (MAX)' : ` (+${lv * 2}%)`}`}</p></div></div>
      <div class="bars">${STAT_LABEL.map(([k, n]) => `<div class="bar"><span>${n}</span><i><span style="width:${st[k]}%"></span></i><b>${st[k]}</b></div>`).join('')}</div>${eq}`);
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
  function renderHome() {
    $('nameInput').value = S.name; $('acctMail').textContent = S.email || '';
    $('homeTeam').innerHTML = S.lineup.map((id) => {
      const p = RF.byId[id], c = rarOf(p.rarity).color;
      return `<div class="mini" style="--rc:${c}"><b>${effOvr(id)}</b>${p.pos}</div>`;
    }).join('');
    const total = RF.cat.players.filter((p) => !p.starter).length;
    const have = RF.cat.players.filter((p) => !p.starter && isOwned(p.id)).length;
    $('homeStats').innerHTML = `<div><b>${won(S.bal)}</b>내 잔액</div><div><b>${have}/${total}</b>도감</div><div><b>${teamAvg()}</b>팀 평균</div>`;
  }
  $('btnLogout').addEventListener('click', () => RF.logout(false));
  let nickT;
  $('nameInput').addEventListener('input', (e) => {
    S.name = e.target.value.replace(/[^\p{L}\p{N} _\-]/gu, '').slice(0, 12);
    clearTimeout(nickT);
    nickT = setTimeout(() => { if (S.name.trim()) RF.api('/api/nick', { nick: S.name }).catch(() => {}); }, 700);
  });

  // ───────────── 뽑기 ─────────────
  let busy = false;
  function renderGacha() {
    $('rates').innerHTML = RAR().map((r) => `<div class="rate" style="--rc:${r.color}"><i class="dot"></i><span style="width:34px">${r.name}</span><div class="bar2"><span style="width:${r.rate}%"></span></div><b>${r.rate}%</b></div>`).join('');
    $('pullStat').textContent = `누적 뽑기 ${S.pulls}회 · 1회 ${won(COST())} · CPU 연습 경기 승리 시 +${won((RF.cat && RF.cat.winReward) || 1000)}`;
    $('pull1').textContent = `1회 뽑기 · ${won(COST())}`;
    $('pull10').textContent = `10회 연속 · ${won(COST() * 10)}`;
    $('pull1').disabled = busy || S.bal < COST();
    $('pull10').disabled = busy || S.bal < COST() * 10;
    $('orbHint').textContent = S.bal < COST() ? '잔액 부족 — CPU를 이기면 1,000원!' : '탭해서 1회 뽑기';
  }
  async function doPull(n) {
    if (busy) return;
    if (S.bal < COST() * n) { RF.toast(`잔액이 부족합니다 (${won(S.bal)}). CPU 연습 경기에서 이기면 ${won((RF.cat && RF.cat.winReward) || 1000)}을 드려요!`, true); return; }
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
    const power = { common: 0, rare: 18, hero: 36, legend: 70, myth: 120 };
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
        if (!skip) await sleep(p.rarity === 'myth' ? 900 : p.rarity === 'legend' ? 650 : 330);
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
    $('teamField').innerHTML = RF.cat.slots.map((s, i) => `<div class="slot" style="left:${SLOT_POS[i][0]}%;top:${SLOT_POS[i][1]}%" data-i="${i}"><div class="tag">${s}</div>${RF.cardHTML(S.lineup[i], { sm: true })}</div>`).join('');
    $('teamField').querySelectorAll('.slot').forEach((el) => el.addEventListener('click', () => pickSlot(+el.dataset.i)));
    $('teamList').textContent = '';
  }
  function pickSlot(i) {
    const pos = RF.cat.slots[i];
    const list = RF.cat.players.filter((p) => p.pos === pos && isOwned(p.id)).sort((a, b) => effOvr(b.id) - effOvr(a.id));
    openModal(`<h3 style="margin:0 0 10px">${RF.cat.posName[pos]} 선택</h3><div class="pick-list">` + list.map((p) => {
      const r = rarOf(p.rarity), st = eff(p.id);
      const main = pos === 'GK' ? `GK ${st.gk}` : pos === 'FW' ? `슛 ${st.sht} · 속도 ${st.spd}` : pos === 'MF' ? `패스 ${st.pas} · 체력 ${st.sta}` : `수비 ${st.def} · 체력 ${st.sta}`;
      return `<button class="pick${S.lineup[i] === p.id ? ' cur' : ''}" style="--rc:${r.color}" data-id="${p.id}"><span class="o">${effOvr(p.id)}</span><span class="n">${esc(p.name)}<small>${r.name} · ${main}${lvOf(p.id) ? ` · Lv.${lvOf(p.id) + 1}` : ''}</small></span><span>${S.lineup[i] === p.id ? '✓' : ''}</span></button>`;
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
    if (!cfg.googleClientId) { if (!cfg.devLogin) $('loginMsg').textContent = '서버에 구글 로그인이 아직 설정되지 않았어요 (관리자: GOOGLE_CLIENT_ID 필요)'; return; }
    try {
      await loadGsi();
      google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: (resp) => doLogin(resp.credential), ux_mode: 'popup' });
      google.accounts.id.renderButton($('gbtn'), { theme: 'filled_blue', size: 'large', text: 'signin_with', shape: 'pill', width: 260, locale: 'ko' });
      $('loginMsg').textContent = '';
    } catch (e) { $('loginMsg').textContent = e.message; }
  }
  async function bootAuth() {
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
