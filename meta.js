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
  // ── 티어 ──
  const tierName = (i) => (RF.cat && RF.cat.tiers && RF.cat.tiers[i] ? RF.cat.tiers[i].name : '');
  const tierIdx = (pts) => Math.min(((RF.cat && RF.cat.tiers && RF.cat.tiers.length) || 12) - 1, Math.floor((pts || 0) / ((RF.cat && RF.cat.tierStep) || 3)));
  /** 관리자 승리 보너스(문서경) 안내 */
  RF.hiddenNote = (h) => (h && h.first ? '🌟 히든 캐릭터 "문서경"을 획득했어요! 보관함에서 확인하세요' : h ? '🌟 관리자를 이겼어요! (문서경은 이미 보유 중)' : null);
  RF.tierChip = (t) => (t ? `<span class="tier" style="--tc:${t.color}">${esc(t.name)}</span>` : '');
  /** 대결 결과의 티어 변화 문장 { text, up, down } */
  RF.tierNote = (t) => {
    if (!t || !RF.cat || !RF.cat.tiers) return null;
    const step = RF.cat.tierStep || 3, ib = tierIdx(t.before), ia = tierIdx(t.after), top = ia === RF.cat.tiers.length - 1;
    let text = t.delta > 0 ? '🏅 티어 +1점' : t.delta < 0 ? '📉 티어 −1점' : '🏅 티어 점수 변화 없음 (0점 아래로는 내려가지 않아요)';
    text += ` · ${tierName(ia)}${top ? ` (${t.after}점)` : ` (${t.after - ia * step}/${step})`}`;
    if (ia > ib) text += ` 🎉 ${tierName(ia)}(으)로 승급!`; else if (ia < ib) text += ` ⬇ ${tierName(ia)}(으)로 강등`;
    return { text, up: ia > ib, down: ia < ib };
  };
  RF.won = won;
  function updateBal() { const el = $('bal'); if (el) el.textContent = '💰 ' + won(S.bal || 0); const m = $('mkBal'); if (m) m.textContent = won(S.bal || 0); }
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
    S.uid = a.id; S.inv = a.inv || {}; S.pulls = a.pulls || 0; S.bal = a.bal || 0; S.locked = a.locked || 0; S.name = a.nick || S.name; S.email = a.email; S.att = a.att || null; S.admin = !!a.admin; S.pts = a.pts || 0; S.tier = a.tier || null;
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
      case 'coin': tone(988, 0.08, 'square', 0.07); tone(1319, 0.28, 'square', 0.07, 0.08); break;
      case 'kick': noise(0.08, Math.min(0.35, 0.12 + (a || 500) / 4000), 700); tone(120, 0.08, 'sine', 0.2, 0, 60); break;
      case 'post': tone(1500, 0.25, 'triangle', 0.15); break;
      case 'save': noise(0.1, 0.2, 400); break;
      case 'whistle': tone(2500, 0.35, 'sine', 0.12); tone(2650, 0.35, 'sine', 0.1, 0.02); break;
      case 'count': tone(520, 0.12, 'square', 0.07); break;
      case 'goal': [523, 659, 784, 1047].forEach((f, i) => tone(f, 0.3, 'triangle', 0.14, i * 0.1)); noise(1.6, 0.14, 1800, 0.1); break;
      case 'win': [523, 659, 784, 1047, 784, 1047, 1319].forEach((f, i) => tone(f, 0.28, 'triangle', 0.15, i * 0.12)); tone(1568, 0.9, 'sawtooth', 0.07, 0.84); noise(1.2, 0.1, 6000, 0.8); break;
      case 'lose': [392, 349, 311, 262].forEach((f, i) => tone(f, 0.4, 'triangle', 0.12, i * 0.22)); break;
      case 'draw': [440, 440, 392].forEach((f, i) => tone(f, 0.3, 'triangle', 0.1, i * 0.2)); break;
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
  /** 골 확정 리플레이 음악: 질주하는 펑크 리프 (디스토션 기타 + 베이스 + 드럼, 150BPM, 약 5초).
   *  /goal.mp3 파일을 올려두면 그 파일을 대신 재생한다. 반환값: 박자 길이(초) — 화면 지진을 박자에 맞추는 데 쓴다. */
  // 골 리플레이 음악 3곡(phonk): 골마다 랜덤. hits = 킥(쿵) 타이밍(초) — 화면 지진을 실제 음악 박자에 맞추는 데 쓴다.
  const GOAL_TRACKS = [
    { n: 1, hits: [0.07, 0.55, 1.03, 1.26, 1.51, 1.74, 1.99, 2.47, 2.94, 3.42, 3.9, 4.38, 4.62, 4.86, 5.07, 5.34, 5.55, 5.81, 6.29, 6.77, 7.0, 7.73, 8.21, 8.68] },
    { n: 2, hits: [0.06, 0.47, 0.69, 1.13, 1.75, 2.0, 2.45, 2.66, 3.3, 3.67, 3.91, 4.17, 4.54, 4.96, 5.53, 5.74, 5.94, 6.28, 6.7, 6.99, 7.53, 7.77, 8.24] },
    { n: 3, hits: [4.94, 5.16, 5.36, 5.56, 5.77, 5.99, 6.2, 6.41, 6.78, 6.98, 7.39, 7.66, 7.86, 8.16, 8.62] },
  ];
  let curAudio = null;
  let goalAudio = null, lastTrack = -1, curHits = null; // goalAudio: null 확인 전 / [] 없음 / Audio 목록
  fetch('/api/version', { cache: 'no-store' }).then((r) => r.json()).then((j) => {
    goalAudio = ((j && j.goals) || []).map((n) => { const a = new Audio('/goal' + n + '.mp3'); a.preload = 'auto'; return { a, t: GOAL_TRACKS.find((x) => x.n === n) }; });
  }).catch(() => { goalAudio = []; });
  const distCurve = (() => { const n = 256, c = new Float32Array(n); for (let i = 0; i < n; i++) { const x = (i / (n - 1)) * 2 - 1; c[i] = Math.tanh(x * 7); } return c; })();
  function guitar(freqs, d, vol, t0) { // 디스토션 파워코드
    const c = ctx(); if (!c || muted) return;
    const t = c.currentTime + t0, ws = c.createWaveShaper(), lp = c.createBiquadFilter(), g = c.createGain();
    ws.curve = distCurve; lp.type = 'lowpass'; lp.frequency.value = 2600;
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol, t + 0.01); g.gain.setValueAtTime(vol, t + d * 0.7); g.gain.exponentialRampToValueAtTime(0.0001, t + d);
    freqs.forEach((f) => { const o = c.createOscillator(); o.type = 'sawtooth'; o.frequency.value = f; o.detune.value = (Math.random() - 0.5) * 12; o.connect(ws); o.start(t); o.stop(t + d + 0.03); });
    ws.connect(lp).connect(g).connect(c.destination);
  }
  function bass(f, d, vol, t0) { tone(f, d, 'sawtooth', vol, t0); tone(f / 2, d, 'sine', vol * 1.4, t0); }
  function kick(t0, v = 0.5) { tone(160, 0.16, 'sine', v, t0, 42); noise(0.02, 0.1, 3000, t0); }
  function snare(t0, v = 0.3) { noise(0.16, v, 5200, t0); tone(200, 0.09, 'triangle', 0.18, t0, 120); }
  function hat(t0, v = 0.06) { noise(0.03, v, 9000, t0); }
  function crash(t0, v = 0.25) { noise(1.4, v, 7500, t0); tone(5200, 0.5, 'square', 0.02, t0); }
  /** 리플레이 시작 때 호출: 음악 3곡 중 랜덤 재생 (직전과 다른 곡). 반환값: 박자 길이(초) 또는 0. 곡이 없으면 합성 펑크로 대신한다. */
  RF.goalHits = () => curHits;
  /** 리플레이가 끝나면 음악을 부드럽게 줄이며 멈춘다 */
  RF.goalStop = () => {
    const a = curAudio; if (!a || a.paused) return; curAudio = null;
    let v = a.volume; const iv = setInterval(() => { v -= 0.12; if (v <= 0.02) { clearInterval(iv); try { a.pause(); a.volume = 0.95; } catch (e) { /* noop */ } } else { try { a.volume = v; } catch (e) { clearInterval(iv); } } }, 40);
  };
  RF.goalSong = () => {
    if (muted) return 0;
    curHits = null;
    if (goalAudio && goalAudio.length) {
      let i = Math.floor(Math.random() * goalAudio.length); if (goalAudio.length > 1 && i === lastTrack) i = (i + 1) % goalAudio.length;
      lastTrack = i; const { a, t } = goalAudio[i]; curAudio = a;
      try { a.currentTime = 0; a.volume = 0.95; const pr = a.play(); if (pr && pr.catch) pr.catch(() => {}); curHits = t.hits; setTimeout(() => { try { a.pause(); } catch (e) { /* noop */ } }, 9500); return 0.4; } catch (e) { /* 합성음으로 */ }
    }
    const BEAT = 0.4, E = BEAT / 2; // 150BPM, 8분음표 = 0.2초
    const root = [82.41, 82.41, 110, 123.47];        // 마디별 뿌리음 E E A B
    const pw = (r) => [r * 2, r * 3, r * 4];          // 파워코드(1·5·8도)
    const riff = [0, 0, 3, 0, 5, 0, 3, 0];            // 한 마디 8분음표 베이스 리프 (반음 이동)
    crash(0, 0.22); kick(0, 0.5); guitar(pw(root[0]), 0.4, 0.12, 0);
    for (let m = 0; m < 3; m++) {
      const b0 = m * 4 * BEAT + (m === 0 ? BEAT : 0), r = root[m];
      for (let k = 0; k < 8; k++) {
        const t = m * 4 * BEAT + k * E; if (m === 0 && k < 2) continue;
        bass(r * Math.pow(2, riff[k] / 12), E * 0.9, 0.11, t);
        hat(t, k % 2 ? 0.05 : 0.08);
        if (k % 4 === 0) kick(t, 0.4); if (k % 4 === 2) snare(t, 0.22);
        if (k === 3 || k === 7) kick(t, 0.28);
        if (k % 2 === 0) guitar(pw(r * Math.pow(2, riff[k] / 12)), E * 0.85, 0.075, t); // 펑크 8비트 코드 스트럼
      }
      void b0;
    }
    // 피날레: 키 올리고 크래시 + 마지막 일격
    const tf = 3 * 4 * BEAT;
    [0, 1, 2, 3].forEach((i) => { snare(tf + i * E * 0.5, 0.3); });
    crash(tf + E * 2, 0.35); kick(tf + E * 2, 0.55); guitar(pw(164.81), 0.9, 0.14, tf + E * 2); bass(82.41, 0.9, 0.15, tf + E * 2);
    return BEAT;
  };
  // ───────────── 배경음악: 로비/메뉴에서만 노래(bgm.mp3) 반복 재생, 경기 중에는 배경음악 없음 ─────────────
  let bgmOn = LS.get('bgm', true), bgmLevel = 1, bgmEl = null;
  const BGM_VOL = 0.55;
  function bgmApply() {
    if (!bgmEl) return;
    const play = bgmOn && !muted && bgmLevel >= 1 && !document.hidden;
    bgmEl.volume = BGM_VOL;
    if (play) { const r = bgmEl.play(); if (r && r.catch) r.catch(() => {}); } else bgmEl.pause();
  }
  function bgmStart() {
    if (bgmEl) return;
    bgmEl = new Audio('/bgm.mp3'); bgmEl.loop = true; bgmEl.preload = 'auto'; bgmApply();
  }
  /** level: 1 로비(노래 재생) / 그 외(경기 중·리플레이)는 배경음악 끔 */
  RF.bgmDuck = (level) => { bgmLevel = level; bgmApply(); };
  RF.bgmToggle = () => { bgmOn = !bgmOn; LS.set('bgm', bgmOn); if (bgmOn) bgmStart(); bgmApply(); const b = document.getElementById('btnBgm'); if (b) { b.classList.toggle('off', !bgmOn); b.textContent = bgmOn ? '🎵' : '🔇'; } return bgmOn; };
  document.addEventListener('visibilitychange', () => { bgmApply(); if (!ac) return; if (document.hidden) ac.suspend && ac.suspend(); else ac.resume && ac.resume(); });
  RF.isMuted = () => muted;
  RF.setMuted = (m) => { muted = !!m; LS.set('mute', muted); bgmApply(); };
  document.addEventListener('pointerdown', () => { ctx(); if (bgmOn) bgmStart(); }, { once: true, passive: true });
  { const b = document.getElementById('btnBgm'); if (b) { b.classList.toggle('off', !bgmOn); b.textContent = bgmOn ? '🎵' : '🔇'; b.addEventListener('click', () => { RF.bgmToggle(); RF.sfx('tap'); }); } }

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
  const SCREENS = ['home', 'gacha', 'box', 'dex', 'team', 'rank', 'market', 'chat', 'room'];
  RF.go = (name) => {
    if (!RF.cat && name !== 'home') { RF.toast('서버 데이터를 불러오는 중입니다', true); return; }
    if (name === 'home' && RF.hooks.inRoom && RF.hooks.inRoom()) name = 'room';
    SCREENS.forEach((s) => $('scr-' + s).classList.toggle('active', s === name));
    document.querySelectorAll('#nav button').forEach((b) => b.classList.toggle('on', b.dataset.go === name || (name === 'dex' && b.dataset.go === 'box')));
    RF.screen = name;
    ({ home: renderHome, gacha: renderGacha, box: renderBox, dex: renderDex, team: renderTeam, rank: renderRank, market: () => RF.hubMarket && RF.hubMarket(), chat: () => RF.hubChat && RF.hubChat(), room: () => RF.hooks.renderRoom && RF.hooks.renderRoom() }[name] || (() => {}))();
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
    const mode = RF.rankMode || 'money';
    $('rankTop').innerHTML = `<div class="seg" id="rkTabs"><button data-m="money" class="${mode === 'money' ? 'on' : ''}">💰 돈 랭킹</button><button data-m="tier" class="${mode === 'tier' ? 'on' : ''}">🏅 티어 랭킹</button></div>`;
    if (d.admin) {
      const fb = document.createElement('button'); fb.className = 'flash-btn'; fb.textContent = '📸 접속자 화면에 1초 띄우기';
      fb.addEventListener('click', () => { if (!RF.socket) return; RF.socket.emit('admin:flash', {}, (r) => RF.toast(r && r.ok ? `${r.n}명에게 보냈어요` : r && r.error === 'slow' ? '3초 뒤에 다시 보내주세요' : '보내지 못했어요', !(r && r.ok))); });
      $('rankTop').appendChild(fb);
    }
    $('rkTabs').addEventListener('click', (e) => { const b = e.target.closest('[data-m]'); if (b) { RF.rankMode = b.dataset.m; renderRank(); } });
    const players = d.players.slice(); if (mode === 'tier') players.sort((a, b) => (b.pts || 0) - (a.pts || 0) || b.bal - a.bal);
    list.innerHTML = players.map((p, i) => `<div class="rk${p.me ? ' me' : ''}${i === 0 ? ' top' : ''}">
      <span class="rn">${medal(i)}</span><span class="nm">${esc(p.nick)}${p.me ? ' <small>(나)</small>' : ''}<small>${RF.cat.tiers && RF.cat.tiers[p.tier] ? `<span class="tier sm" style="--tc:${RF.cat.tiers[p.tier].color}">${esc(RF.cat.tiers[p.tier].name)}</span> ` : ''}${p.pts || 0}점 · 캐릭터 ${p.owned}</small></span>
      <b class="bl">${mode === 'tier' ? (p.pts || 0) + '점' : won(p.bal)}</b>${d.admin ? `<span class="adm"><button data-money="${esc(p.id)}" data-nick="${esc(p.nick)}" data-bal="${p.bal}" aria-label="돈 관리">💰</button>${p.me ? '' : `<button data-del="${esc(p.id)}" data-nick="${esc(p.nick)}" aria-label="계정 삭제">🗑</button>`}</span>` : ''}</div>`).join('');
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
    $('nameInput').value = S.name; $('profAv').textContent = (S.name || 'P').slice(0, 1).toUpperCase(); $('profOvr').textContent = teamAvg(); $('profTier').innerHTML = S.tier ? `${RF.tierChip(S.tier)}<span class="tdots">${Array.from({ length: S.tier.step }, (_, k) => `<i class="${S.tier.top || k < S.tier.into ? 'on' : ''}"></i>`).join('')}</span><small>${S.pts}점 · 이기면 +1 / 지면 −1</small>` : ''; $('profSub').textContent = won(S.bal) + ' · 획득 선수 ' + Object.keys(S.inv).length + '명'; $('acctMail').textContent = S.email || '';
    $('homeTeam').innerHTML = S.lineup.map((id, i) => {
      const p = RF.byId[id], c = rarOf(p.rarity).color;
      return `<div class="mini" style="--rc:${c}"><b>${effOvr(id, RF.cat.slots[i])}</b>${RF.cat.slots[i]}</div>`;
    }).join('');
    const total = RF.cat.players.filter((p) => !p.starter).length;
    const have = RF.cat.players.filter((p) => !p.starter && isOwned(p.id)).length;
    $('homeStats').innerHTML = `<div><b>${won(S.bal)}</b>내 잔액</div><div><b>${have}/${total}</b>도감</div><div><b>${teamAvg()}</b>팀 평균</div>`;
  }
  $('btnLogout').addEventListener('click', () => RF.logout(false));
  $('btnDex').addEventListener('click', () => RF.go('dex'));
  $('btnDexBack').addEventListener('click', () => RF.go('box'));
  $('nameInput').readOnly = true; // 닉네임은 아이디로 고정

  // ───────────── 뽑기 ─────────────
  let busy = false;
  function renderGacha() {
    $('rates').innerHTML = RAR().filter((r) => r.rate > 0).map((r) => `<div class="rate" style="--rc:${r.color}"><i class="dot"></i><span style="width:34px">${r.name}</span><div class="bar2"><span style="width:${r.rate}%"></span></div><b>${r.rate}%</b></div>`).join('');
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


  // ───────────── 고등급 카드 등장 연출 (전설: 회전 · 신화: 조각 합체 · 초월: 하늘에서 낙하) ─────────────
  const SHARDS = [[0,0,55,0,42,40,0,38],[55,0,100,0,100,45,42,40],[0,38,42,40,58,70,0,72],[42,40,100,45,100,75,58,70],[0,72,58,70,45,100,0,100],[58,70,100,75,100,100,45,100]];
  function fxCard(r, ov, flash) {
    const p = RF.byId[r.id], rc = rarOf(p.rarity), card = RF.cardHTML(r.id, { isNew: r.isNew });
    const note = `<div class="rv-note" style="margin-top:14px;font-weight:800">${r.isNew ? '🎉 새 선수 획득!' : `중복! 강화 Lv.${r.level + 1}${r.level >= RF.cat.maxDup ? ' (MAX)' : ' (+2% 능력치)'}`}</div>`;
    const wrap = (cls, inner) => `<div class="rv-single ${cls}" style="--rc:${rc.color}"><div class="rtag">${rc.name}</div>${inner}${note}</div>`;
    const shake = () => { ov.classList.remove('quake'); void ov.offsetWidth; ov.classList.add('quake'); setTimeout(() => ov.classList.remove('quake'), 700); };
    if (!['legend', 'myth', 'trans', 'hid'].includes(p.rarity)) return { dur: 900, html: wrap('', card), start() { burst(rc.color, 40 + ({ rare: 18, hero: 36 }[p.rarity] || 0)); } };
    if (p.rarity === 'legend') return { dur: 2300, html: wrap('fx-legend', `<div class="spin3d">${card}</div><div class="rays"></div>`), start() { setTimeout(() => { flash(rc.color); burst(rc.color, 120); burst('#ffffff', 50); }, 1250); } };
    if (p.rarity === 'myth') {
      const ps = SHARDS.map((q, i) => { const a = (i / 6) * 6.283 + 0.6; return `<div class="shard" style="clip-path:polygon(${q[0]}% ${q[1]}%,${q[2]}% ${q[3]}%,${q[4]}% ${q[5]}%,${q[6]}% ${q[7]}%);--dx:${Math.round(Math.cos(a) * 260)}px;--dy:${Math.round(Math.sin(a) * 340)}px;--r:${(i % 2 ? 1 : -1) * (160 + i * 40)}deg;animation-delay:${(0.15 + i * 0.28).toFixed(2)}s">${card}</div>`; }).join('');
      return { dur: 3300, html: wrap('fx-myth', `<div class="shards">${ps}<div class="cracks"></div></div>`), start() { for (let i = 0; i < 6; i++) setTimeout(() => { burst(rc.color, 18, 0.5 + Math.cos(i) * 0.2, 0.42 + Math.sin(i) * 0.2); try { RF.sfx('tap'); } catch (e) { /* noop */ } }, 150 + i * 280 + 500); setTimeout(() => { flash('#ffffff'); burst(rc.color, 200); burst('#ffd45e', 80); shake(); }, 2500); } };
    }
    // 초월: 하늘에서 낙하
    return { dur: 3600, html: wrap('fx-trans', `<div class="beam"></div><div class="skyfall">${card}</div><div class="shock"></div><div class="shock s2"></div>`), start() { setTimeout(() => { flash('#ffffff'); burst(rc.color, 260); burst('#ffffff', 120); shake(); try { RF.sfx('lose'); } catch (e) { /* noop */ } }, 1150); setTimeout(() => { burst(rc.color, 120); shake(); }, 1700); } };
  }

  let skip = false;
  async function reveal(results, bestColor) {
    const ov = $('reveal'), st = $('revealStage'); skip = false;
    st.innerHTML = ''; ov.classList.remove('hidden'); $('revealClose').classList.add('hidden'); $('revealSkip').classList.remove('hidden');
    const flash = (c) => { const f = document.createElement('div'); f.className = 'flash'; f.style.setProperty('--fc', c); ov.appendChild(f); setTimeout(() => f.remove(), 950); };
    const power = { common: 0, rare: 18, hero: 36, legend: 70, myth: 120, trans: 220, hid: 220 };
    const info = (r) => (r.isNew ? '' : '');
    flash(bestColor);
    if (results.length === 1) {
      const r = results[0], p = RF.byId[r.id];
      const fxc = fxCard(r, ov, flash);
      st.innerHTML = fxc.html;
      RF.sfx(p.rarity); fxc.start(st);
      await sleep(fxc.dur);
    } else {
      st.innerHTML = '<div class="rv-grid"></div>'; const g = st.firstChild;
      for (let i = 0; i < results.length; i++) {
        const r = results[i], p = RF.byId[r.id], rc = rarOf(p.rarity);
        const el = document.createElement('div'); el.innerHTML = RF.cardHTML(r.id, { isNew: r.isNew, sm: true });
        const card = el.firstChild; card.style.animationDelay = '0s';
        if (power[p.rarity] >= 70 && !skip) { const sp = document.createElement('div'); sp.className = 'rv-spot'; const fxc = fxCard(r, ov, flash); sp.innerHTML = fxc.html; ov.appendChild(sp); RF.sfx(p.rarity); fxc.start(sp); const t0 = Date.now(); while (!skip && Date.now() - t0 < fxc.dur) await sleep(80); sp.remove(); skip = false; }
        g.appendChild(card);
        RF.sfx(p.rarity); burst(rc.color, 8 + power[p.rarity] / 2, 0.15 + 0.7 * ((i % 5) / 4), 0.25 + 0.4 * Math.floor(i / 5));
        if (power[p.rarity] >= 70) flash(rc.color);
        if (!skip) await sleep(power[p.rarity] >= 70 ? 400 : 330);
      }
      const dups = results.filter((r) => !r.isNew).length;
      const note = document.createElement('div'); note.className = 'tiny center'; note.style.cssText = 'grid-column:1/-1;pointer-events:none';
      note.textContent = `신규 ${results.length - dups} · 중복 ${dups}`; g.appendChild(note);
    }
    $('revealSkip').classList.add('hidden'); $('revealClose').classList.remove('hidden');
    await new Promise((res) => { $('revealClose').onclick = () => { ov.classList.add('hidden'); res(); }; });
  }
  $('revealSkip').addEventListener('click', () => { skip = true; });
  RF.__reveal = reveal; // 테스트/연출 확인용

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
