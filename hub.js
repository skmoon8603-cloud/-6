'use strict';
/* RANDOM FOOTBALL - hub.js : 이적시장 + 실시간 채팅 (모든 거래/검증은 서버가 한다) */
(function () {
  const RF = window.RF, $ = RF.$, esc = RF.esc, S = RF.state, won = RF.won;
  const ERR = { gone: '이미 팔렸거나 취소된 매물이에요', own: '내 매물은 살 수 없어요', not_enough: '잔액이 부족해요', not_owned: '보유하지 않은 선수예요', not_sellable: '거래할 수 없는 선수예요', too_many: '매물은 최대 8개까지 올릴 수 있어요', bad_price: '가격 범위를 확인해 주세요', too_many_requests: '잠시 후 다시 시도해 주세요', server_error: '서버 오류가 났어요' };
  const POS = ['GK', 'DF', 'MF', 'FW'], RAR = ['common', 'rare', 'hero', 'legend', 'myth'];
  const rn = (k) => RF.cat.rarities.find((r) => r.key === k).name;
  const sfx = (k) => { try { RF.sfx(k); } catch (e) { /* noop */ } };

  // ───────────── 이적시장 ─────────────
  const M = { tab: 'buy', data: null, f: { rar: 'all', pos: 'all', sort: 'new', q: '' }, busy: false, t: 0 };
  async function mkLoad() {
    try { const r = await RF.api('/api/market'); if (!r.ok) throw new Error(); M.data = await r.json(); } catch (e) { if (!M.data) RF.toast('시장을 불러오지 못했어요', true); }
  }
  async function mkAct(body) {
    if (M.busy) return null; M.busy = true;
    try {
      const r = await RF.api('/api/market', body); const j = await r.json();
      if (!r.ok || j.error) { RF.toast(j.error === 'bad_price' ? `가격은 ${won(j.lo)} ~ ${won(j.hi)} 사이로 정해 주세요` : ERR[j.error] || '실패했어요', true); sfx('lose'); await mkLoad(); return null; }
      if (j.acct) RF.setAccount(j.acct);
      return j;
    } catch (e) { RF.toast('네트워크 오류', true); return null; } finally { M.busy = false; }
  }
  const chipRow = (id, items, cur) => `<div class="chips" id="${id}">${items.map(([k, n]) => `<button class="chip${cur === k ? ' on' : ''}" data-k="${k}">${n}</button>`).join('')}</div>`;
  const last = (pid) => (M.data && M.data.last[pid]) || null;

  function renderMarket() {
    $('mkBal').textContent = won(S.bal || 0);
    document.querySelectorAll('#mkTabs button').forEach((b) => b.classList.toggle('on', b.dataset.t === M.tab));
    if (!M.data) { $('mkBody').innerHTML = '<p class="tiny center">불러오는 중…</p>'; return; }
    const mine = M.data.list.filter((l) => l.mine).length;
    $('mkSub').textContent = `매물 ${M.data.list.length}개 · 수수료 ${M.data.fee}% · 내 매물 ${mine}/${M.data.maxListings}`;
    ({ buy: viewBuy, sell: viewSell, mine: viewMine }[M.tab])();
  }

  function listingCard(l, extra) {
    const p = RF.byId[l.pid], h = last(l.pid);
    return `<div class="mk-item${l.sys ? ' sys' : ''}" data-lid="${l.id}" data-pid="${l.pid}">${RF.cardHTML(l.pid, { base: true })}
      <div class="mk-price">💰 ${l.price.toLocaleString('ko-KR')}</div>
      <div class="mk-meta">${extra || `<span>${l.sys ? '🏟️ ' : ''}${esc(l.seller)}</span>`}${h ? `<span title="최근 거래가">📈 ${h.p.toLocaleString('ko-KR')}</span>` : ''}</div></div>`;
  }

  function viewBuy() {
    const f = M.f;
    let list = M.data.list.filter((l) => !l.mine);
    list = list.filter((l) => { const p = RF.byId[l.pid]; return (f.rar === 'all' || p.rarity === f.rar) && (f.pos === 'all' || p.pos === f.pos) && (!f.q || p.name.toLowerCase().includes(f.q.toLowerCase())); });
    const ov = (l) => RF.byId[l.pid].ovr;
    list.sort({ new: (a, b) => b.ts - a.ts, low: (a, b) => a.price - b.price, high: (a, b) => b.price - a.price, ovr: (a, b) => ov(b) - ov(a) }[f.sort]);
    $('mkBody').innerHTML = `
      <input id="mkQ" class="inp" placeholder="🔍 선수 이름 검색" value="${esc(f.q)}" style="height:42px;margin-bottom:8px">
      ${chipRow('mkR', [['all', '전체 등급'], ...RAR.map((k) => [k, rn(k)])], f.rar)}
      ${chipRow('mkP', [['all', '전체 포지션'], ...POS.map((k) => [k, k])], f.pos)}
      ${chipRow('mkS', [['new', '최신순'], ['low', '낮은 가격'], ['high', '높은 가격'], ['ovr', '능력치순']], f.sort)}
      <div class="grid mk-grid">${list.map((l) => listingCard(l)).join('') || '<p class="tiny center" style="grid-column:1/-1">조건에 맞는 매물이 없어요. 다른 사람이 선수를 올리면 여기에 나타나요!</p>'}</div>`;
    $('mkQ').addEventListener('input', (e) => { f.q = e.target.value; const pos = e.target.selectionStart; viewBuy(); const q = $('mkQ'); q.focus(); q.setSelectionRange(pos, pos); });
    for (const [id, key] of [['mkR', 'rar'], ['mkP', 'pos'], ['mkS', 'sort']]) $(id).addEventListener('click', (e) => { const b = e.target.closest('[data-k]'); if (b) { f[key] = b.dataset.k; sfx('tap'); viewBuy(); } });
    $('mkBody').querySelectorAll('.mk-item').forEach((el) => el.addEventListener('click', () => buyModal(+el.dataset.lid)));
  }

  function statBars(pid) {
    const st = RF.byId[pid].stats;
    return `<div class="bars">${[['spd', '속도'], ['sht', '슛'], ['pas', '패스'], ['def', '수비'], ['sta', '체력'], ['dri', '드리블'], ['gk', '골키퍼']].map(([k, n]) => `<div class="bar"><span>${n}</span><i><span style="width:${st[k]}%"></span></i><b>${st[k]}</b></div>`).join('')}</div>`;
  }

  function buyModal(lid) {
    const l = M.data.list.find((x) => x.id === lid); if (!l) return;
    const p = RF.byId[l.pid], h = last(l.pid), have = S.inv[l.pid] || 0, after = S.bal - l.price;
    RF.openModal(`<div class="det">${RF.cardHTML(l.pid, { base: true })}<div><h3>${esc(p.name)}</h3><p>${rn(p.rarity)} · ${RF.cat.posName[p.pos]} · #${p.number}</p>
      <p style="margin-top:6px">${l.sys ? '🏟️ 구단 오늘의 특가 (매일 5명, 자정에 교체)' : '판매자 ' + esc(l.seller)}${have ? `<br>이미 ${have}장 보유 (중복 시 강화 +2%)` : '<br>새로운 선수예요!'}</p></div></div>
      ${statBars(l.pid)}
      <div class="mk-deal"><div><small>가격</small><b>${won(l.price)}</b></div><div><small>${h ? '최근 거래가' : '거래 기록'}</small><b>${h ? won(h.p) : '없음'}</b></div><div><small>구매 후 잔액</small><b class="${after < 0 ? 'neg' : ''}">${after < 0 ? '부족' : won(after)}</b></div></div>
      <button id="mkBuy" class="btn primary big" style="width:100%" ${after < 0 ? 'disabled' : ''}>${after < 0 ? '잔액이 부족해요' : `💸 ${won(l.price)}에 영입하기`}</button>`);
    $('mkBuy').addEventListener('click', async () => {
      const j = await mkAct({ op: 'buy', id: lid }); if (!j) { RF.closeModal(); renderMarket(); return; }
      RF.closeModal(); sfx('win'); RF.toast(`🎉 ${p.name} 영입 완료!`); await mkLoad(); renderMarket();
    });
  }

  function viewSell() {
    const owned = RF.cat.players.filter((p) => !p.starter && !p.hidden && (S.inv[p.id] || 0) > 0).sort((a, b) => b.ovr - a.ovr);
    const used = {}; if (M.data) M.data.list.filter((l) => l.mine).forEach((l) => { used[l.pid] = (used[l.pid] || 0) + 1; });
    $('mkBody').innerHTML = `<p class="tiny" style="margin-top:0">팔고 싶은 선수를 눌러 가격을 정하세요. 팔리면 수수료 ${M.data.fee}%를 뺀 금액이 들어와요.</p>
      <div class="grid mk-grid">${owned.map((p) => `<div class="mk-item" data-pid="${p.id}">${RF.cardHTML(p.id, { base: true })}<div class="mk-meta"><span>보유 ${S.inv[p.id]}장</span>${used[p.id] ? `<span>매물 ${used[p.id]}</span>` : ''}</div></div>`).join('') || '<p class="tiny center" style="grid-column:1/-1">판매할 수 있는 선수가 없어요. 뽑기에서 선수를 뽑아보세요!</p>'}</div>`;
    $('mkBody').querySelectorAll('.mk-item').forEach((el) => el.addEventListener('click', () => sellModal(el.dataset.pid)));
  }

  function sellModal(pid) {
    const p = RF.byId[pid], q = M.data.quick[p.rarity], hi = Math.min(M.data.maxPrice, q * 200), h = last(pid);
    const def = h ? h.p : q * 3, cnt = S.inv[pid] || 0;
    const inTeam = S.lineup.includes(pid) && cnt === 1;
    RF.openModal(`<div class="det">${RF.cardHTML(pid, { base: true })}<div><h3>${esc(p.name)}</h3><p>${rn(p.rarity)} · ${RF.cat.posName[p.pos]} · 보유 ${cnt}장</p>
      <p style="margin-top:6px">${h ? `최근 거래가 ${won(h.p)}` : '아직 거래 기록이 없어요'}</p></div></div>
      ${inTeam ? '<p class="tiny" style="color:var(--gold)">⚠️ 출전 선수예요. 팔면 편성에서 빠져요.</p>' : ''}
      <div class="lbl" style="margin-top:12px">판매 가격 (${won(q)} ~ ${won(hi)})</div>
      <input id="slPrice" class="inp" inputmode="numeric" value="${def}" style="font-size:20px;font-weight:800;text-align:center">
      <div id="slNet" class="tiny center"></div>
      <button id="slList" class="btn primary big" style="width:100%">📌 시장에 등록</button>
      <button id="slQuick" class="btn gold" style="width:100%;margin-top:8px">⚡ 구단에 즉시 판매 · ${won(q)}</button>`);
    const inp = $('slPrice');
    const upd = () => { const v = Math.trunc(+inp.value.replace(/[^\d]/g, '')) || 0; $('slNet').textContent = `팔리면 실수령 ${won(v - Math.floor(v * M.data.fee / 100))}`; };
    inp.addEventListener('input', upd); upd();
    $('slList').addEventListener('click', async () => {
      const price = Math.trunc(+inp.value.replace(/[^\d]/g, '')) || 0;
      const j = await mkAct({ op: 'list', pid, price }); if (!j) return;
      RF.closeModal(); sfx('tap'); RF.toast('매물로 등록했어요'); await mkLoad(); M.tab = 'mine'; renderMarket();
    });
    $('slQuick').addEventListener('click', async () => {
      if (!confirm(`${p.name} 선수를 구단에 ${won(q)}에 바로 팔까요?`)) return;
      const j = await mkAct({ op: 'quick', pid }); if (!j) return;
      RF.closeModal(); sfx('coin'); RF.toast(`+${won(j.amount)} 받았어요`); renderMarket();
    });
  }

  function viewMine() {
    const mine = M.data.list.filter((l) => l.mine);
    $('mkBody').innerHTML = `<div class="grid mk-grid">${mine.map((l) => listingCard(l, '<span>탭하면 취소</span>')).join('') || '<p class="tiny center" style="grid-column:1/-1">등록한 매물이 없어요. ‘판매’ 탭에서 선수를 올려보세요.</p>'}</div>`;
    $('mkBody').querySelectorAll('.mk-item').forEach((el) => el.addEventListener('click', async () => {
      const id = +el.dataset.lid, l = mine.find((x) => x.id === id); if (!l) return;
      if (!confirm(`${RF.byId[l.pid].name} 매물을 취소하고 보관함으로 되돌릴까요?`)) return;
      const j = await mkAct({ op: 'cancel', id }); if (!j) return;
      RF.toast('매물을 취소했어요'); await mkLoad(); renderMarket();
    }));
  }

  document.addEventListener('click', (e) => { const b = e.target.closest('#mkTabs button'); if (b) { M.tab = b.dataset.t; sfx('tap'); renderMarket(); } });
  RF.hubMarket = async () => { renderMarket(); await mkLoad(); if (RF.screen === 'market') renderMarket(); };

  // ───────────── 채팅 ─────────────
  const CH = { joined: false, admin: false, unread: 0, hist: [] };
  const CERR = { slow: '너무 빨라요! 잠깐만요', repeat: '같은 말은 반복할 수 없어요', empty: '', not_joined: '채팅에 연결 중이에요' };
  const hue = (s) => { let h = 0; for (const c of String(s)) h = (h * 31 + c.charCodeAt(0)) % 360; return h; };
  const hm = (ts) => { const d = new Date(ts); return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0'); };
  function msgHTML(m) {
    if (m.sys) return `<div class="cm sys" data-id="${m.id}"><span>${esc(m.t)}</span></div>`;
    const me = m.u === S.uid;
    return `<div class="cm ${me ? 'me' : ''}" data-id="${m.id}">${me ? '' : `<div class="cav" style="--h:${hue(m.n)}">${esc((m.n || '?').slice(0, 1).toUpperCase())}</div>`}
      <div class="cb">${me ? '' : `<div class="cn" style="--h:${hue(m.n)}">${esc(m.n)}${m.adm ? '<em>관리자</em>' : ''}</div>`}<div class="ct"><span>${esc(m.t)}</span><small>${hm(m.ts)}</small>${CH.admin ? `<button class="cdel" data-del="${m.id}" aria-label="삭제">✕</button>` : ''}</div></div></div>`;
  }
  function chRender() {
    const el = $('chList'); el.innerHTML = CH.hist.map(msgHTML).join('') || '<p class="tiny center">아직 대화가 없어요. 첫 인사를 남겨보세요 👋</p>';
    el.scrollTop = el.scrollHeight;
  }
  function chAdd(m) {
    CH.hist.push(m); if (CH.hist.length > 120) CH.hist.shift();
    const el = $('chList'); const near = el.scrollHeight - el.scrollTop - el.clientHeight < 90;
    if (el.querySelector('p.tiny')) el.innerHTML = '';
    el.insertAdjacentHTML('beforeend', msgHTML(m));
    while (el.children.length > 120) el.removeChild(el.firstChild);
    if (near || m.u === S.uid) el.scrollTop = el.scrollHeight;
    if (RF.screen !== 'chat' && !m.sys && m.u !== S.uid) { CH.unread++; badge(); }
  }
  function badge() { const b = $('chBadge'); b.textContent = CH.unread > 99 ? '99+' : CH.unread; b.classList.toggle('hidden', !CH.unread); }
  function chJoin() {
    const s = RF.socket; if (!s || !s.connected) return;
    s.emit('chat:join', {}, (r) => { if (!r) return; CH.joined = true; CH.admin = !!r.admin; CH.hist = r.hist || []; $('chOnline').lastChild.textContent = (r.online || 0) + '명'; chRender(); });
  }
  let hooked = null;
  function chHook() {
    const s = RF.socket; if (!s || hooked === s) return; hooked = s;
    s.on('connect', chJoin); if (s.connected) chJoin();
    s.on('disconnect', () => { CH.joined = false; });
    s.on('chat:msg', chAdd);
    s.on('chat:online', (n) => { $('chOnline').lastChild.textContent = n + '명'; });
    s.on('chat:del', (id) => { CH.hist = CH.hist.filter((m) => m.id !== id); const e = $('chList').querySelector(`[data-id="${id}"]`); if (e) e.remove(); });
    s.on('market:changed', () => { clearTimeout(M.t); M.t = setTimeout(async () => { if (RF.screen === 'market' && !M.busy) { await mkLoad(); if (!document.querySelector('#modal:not(.hidden)')) renderMarket(); } else M.data = null; }, 400); });
  }
  setInterval(chHook, 700);
  RF.hubChat = () => { CH.unread = 0; badge(); chHook(); if (!CH.joined) chJoin(); else chRender(); setTimeout(() => { const el = $('chList'); el.scrollTop = el.scrollHeight; }, 30); };
  $('chForm').addEventListener('submit', (e) => {
    e.preventDefault(); const inp = $('chInp'), t = inp.value.trim(); if (!t) return;
    if (!CH.joined) { RF.toast('채팅에 연결 중이에요', true); return; }
    RF.socket.emit('chat:send', { t }, (r) => { if (r && r.error) { if (CERR[r.error]) RF.toast(CERR[r.error], true); } else { inp.value = ''; } });
    inp.focus();
  });
  $('chList').addEventListener('click', (e) => { const b = e.target.closest('[data-del]'); if (b && RF.socket) RF.socket.emit('chat:del', { id: +b.dataset.del }); });
})();
