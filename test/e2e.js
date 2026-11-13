// Playwright E2E: 실제 클라이언트(public/*) <-> 실제 서버 로직(lib/*) (devserver 경유)
const { chromium, devices } = require('playwright');
const OUT = process.env.SHOTS || '/tmp/shots';
const URL = 'http://localhost:3100/';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let fails = 0;
const ok = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

(async () => {
  const browser = await chromium.launch();
  const mk = async (name) => {
    const ctx = await browser.newContext({ viewport: { width: 412, height: 800 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, userAgent: devices['Pixel 7'].userAgent });
    await ctx.addInitScript(() => { Element.prototype.requestFullscreen = undefined; }); const page = await ctx.newPage(); const errs = [];
    page.on('pageerror', (e) => errs.push('pageerror: ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('console: ' + m.text()); });
    await page.goto(URL); await page.waitForSelector('#devLogin:not(.hidden)', { timeout: 15000 });
    await page.fill('#devName', name + Date.now() % 100000); await page.click('#devLogin button');
    await page.waitForFunction(() => window.RF && RF.ready, null, { timeout: 15000 });
    return { ctx, page, errs, name };
  };
  const A = await mk('A'), B = await mk('B');
  ok((await A.page.textContent('#bal')).includes('0원'), '신규 계정 시작 잔액 0원 표시');
  ok(await A.page.evaluate(() => document.getElementById('login').classList.contains('hidden')), '로그인 후 로그인 창 닫힘');
  const grant = async (p, amt) => { const uid = await p.page.evaluate(() => RF.state.uid); await fetch(`http://localhost:3100/__test/grant?uid=${encodeURIComponent(uid)}&amt=${amt}`); return uid; };
  const uidA = await grant(A, 12000); const uidB = await grant(B, 12000);
  await A.page.reload(); await A.page.waitForFunction(() => window.RF && RF.ready); await B.page.reload(); await B.page.waitForFunction(() => window.RF && RF.ready);
  ok((await A.page.textContent('#bal')).includes('12,000원'), '잔액 12,000원 반영');
  const shot = (p, n) => p.page.screenshot({ path: `${OUT}/${p.name}-${n}.png` });

  console.log('[1] 로비/뽑기/보관함');
  await shot(A, '01-home');
  await A.page.click('#nav [data-go=gacha]'); await sleep(300); await shot(A, '02-gacha');
  await A.page.click('#pull10');
  await A.page.waitForSelector('#reveal:not(.hidden) .rv-grid .pcard', { timeout: 8000 });
  await sleep(1800); await shot(A, '03-reveal-mid');
  await A.page.click('#revealSkip'); await A.page.waitForSelector('#revealClose:not(.hidden)', { timeout: 20000 });
  await shot(A, '04-reveal-done');
  const nCards = await A.page.locator('#revealStage .pcard').count(); ok(nCards === 10, `10연차 카드 ${nCards}장 표시`);
  await A.page.click('#revealClose');
  await A.page.click('#pull1'); await A.page.waitForSelector('#reveal:not(.hidden) .rv-single', { timeout: 8000 }); await sleep(1200); await shot(A, '05-reveal-single');
  await A.page.click('#revealSkip').catch(() => {}); await A.page.waitForSelector('#revealClose:not(.hidden)'); await A.page.click('#revealClose');
  const pulls = await A.page.evaluate(() => RF.state.pulls); ok(pulls === 11, `누적 뽑기 횟수 ${pulls}`);
  await A.page.click('#nav [data-go=box]'); await sleep(300); await shot(A, '06-box');
  const boxN = await A.page.locator('#boxGrid .pcard').count(); ok(boxN >= 7, `보관함 카드 ${boxN}장 (기본 6 + 획득)`);
  await A.page.click('#boxGrid .pcard'); await sleep(250); await shot(A, '07-detail'); await A.page.click('#modalX');
  await A.page.click('#nav [data-go=dex]'); await sleep(300); await shot(A, '08-dex');
  await A.page.click('#nav [data-go=team]'); await sleep(300); await shot(A, '09-team');
  // 새로고침 후 유지
  const before = await A.page.evaluate(() => JSON.stringify({ inv: RF.state.inv, name: RF.state.name }));
  await A.page.reload(); await A.page.waitForFunction(() => window.RF && RF.ready);
  const after = await A.page.evaluate(() => JSON.stringify({ inv: RF.state.inv, name: RF.state.name }));
  ok(before === after && before.length > 30, '새로고침 후 보관함/닉네임 유지');

  console.log('[2] 방 만들기 / 입장'); await grant(A, 5000);
  await A.page.click('#nav [data-go=home]'); await A.page.click('#btnCreate'); await A.page.waitForSelector('#scr-room.active');
  await sleep(300);
  const code = (await A.page.textContent('#roomCode')).trim(); ok(/^[A-Z2-9]{6}$/.test(code), `방 코드 ${code}`); await shot(A, '10-room-host');
  await B.page.fill('#codeInput', code.toLowerCase()); await B.page.click('#btnJoin');
  await B.page.waitForSelector('#scr-room.active'); await sleep(400);
  ok((await A.page.locator('#roomPlayers .rp').count()) === 2 && (await A.page.textContent('#roomPlayers')).includes(await B.page.evaluate(() => RF.state.name)), '방장 화면에 친구 입장 반영');
  await shot(B, '11-room-guest');
  const stk = A.page.locator('#stakeBox .chip[data-v="2000"]'); await stk.click(); await sleep(600);
  ok((await B.page.textContent('#stakeBox')).includes('4,000원'), '방장이 정한 판돈 2,000원(합계 4,000원)이 친구 화면에도 표시');
  ok(await B.page.locator('#stakeBox .chip').first().isDisabled(), '참가자는 판돈 변경 불가');
  await A.page.click('#btnReady'); await sleep(300);
  ok((await B.page.textContent('#roomPlayers')).includes('준비 완료'), '준비 상태 실시간 동기화');

  console.log('[3] 경기');
  for (const p of [A, B]) await p.page.setViewportSize({ width: 915, height: 412 });
  await B.page.click('#btnReady');
  await A.page.waitForSelector('#scr-match:not(.hidden)', { timeout: 5000 }); await B.page.waitForSelector('#scr-match:not(.hidden)', { timeout: 5000 });
  ok(true, '양쪽 경기 화면 진입'); await sleep(800); await shot(A, '12-countdown');
  await sleep(3600);
  // A: 조이스틱 드래그 (우측으로) + 질주
  const joyBox = await A.page.locator('#joy').boundingBox();
  const jx = joyBox.x + 120, jy = joyBox.y + joyBox.height - 90;
  const posOf = (p) => p.page.evaluate(() => { const s = window.__lastSnap; return s; });
  await A.page.mouse.move(jx, jy); await A.page.mouse.down(); await A.page.mouse.move(jx + 60, jy, { steps: 4 });
  await sleep(1200); await shot(A, '13-joystick-move');
  const inpA = await A.page.evaluate(() => { const b = document.getElementById('joyBase'); return b.className; });
  ok(inpA.includes('act'), '가상 조이스틱 활성화');
  const bb = await A.page.locator('#joyBase').boundingBox(); ok(Math.abs(bb.x + bb.width / 2 - jx) < 4 && Math.abs(bb.y + bb.height / 2 - jy) < 4, `조이스틱이 터치한 곳에 나타남 (오차 ${Math.round(Math.hypot(bb.x + bb.width / 2 - jx, bb.y + bb.height / 2 - jy))}px)`);
  await A.page.mouse.up();
  // 서버 스냅샷으로 위치 비교 (A, B 모두 같은 서버 상태를 수신)
  await sleep(500);
  const hud = async (p) => ({ l: await p.page.textContent('#scL'), r: await p.page.textContent('#scR'), t: await p.page.textContent('#timer') });
  const ha = await hud(A), hb = await hud(B); console.log('   HUD A', ha, 'B', hb);
  ok(ha.t === hb.t || Math.abs(+ha.t.split(':')[1] - +hb.t.split(':')[1]) <= 1, '두 클라이언트 경기 시간 동기화');
  // 버튼들: 슛(길게), 패스, 질주, 교체
  const press = async (p, sel, ms = 80) => { const b = await p.page.locator(sel).boundingBox(); await p.page.mouse.move(b.x + b.width / 2, b.y + b.height / 2); await p.page.mouse.down(); await sleep(ms); await p.page.mouse.up(); };
  await press(A, '#bSwitch'); await press(A, '#bPass'); await press(A, '#bSprint', 80); await press(A, '#bShoot', 450);
  ok(await A.page.evaluate(() => document.getElementById('bSprint').classList.contains('latch')), '질주 버튼 탭 → 래치');
  // B: 키보드 조작
  await B.page.keyboard.down('d'); await B.page.keyboard.down('Shift'); await sleep(900); await B.page.keyboard.up('d'); await B.page.keyboard.up('Shift');
  await B.page.keyboard.press('e'); await B.page.keyboard.press('q'); await B.page.keyboard.down(' '); await sleep(300); await B.page.keyboard.up(' ');
  await sleep(1500); await shot(A, '14-match-A'); await shot(B, '15-match-B');
  const nFrames = await A.page.evaluate(() => new Promise((r) => { let n = 0; const t0 = performance.now(); const f = () => { n++; if (performance.now() - t0 < 1000) requestAnimationFrame(f); else r(n); }; requestAnimationFrame(f); }));
  ok(nFrames > 20, `렌더링 프레임레이트 ${nFrames}fps (헤드리스 소프트웨어 렌더링 기준)`);

  console.log('[4] 새로고침 재접속');
  await B.page.reload(); await B.page.waitForSelector('#scr-match:not(.hidden)', { timeout: 10000 }); ok(true, 'B 새로고침 후 자동 재접속 → 경기 화면 복귀'); await sleep(2500);
  await B.page.evaluate(() => window.__sock._drop()); await sleep(300);
  ok(!(await A.page.locator('#banner').evaluate((e) => e.classList.contains('hidden'))), 'A에 상대 연결 끊김 배너 표시');
  await sleep(1500); await shot(A, '16-opp-dc');
  await B.page.waitForFunction(() => document.getElementById('banner').classList.contains('hidden'), null, { timeout: 8000 }).catch(() => {});
  await sleep(2500);
  ok(await A.page.locator('#banner').evaluate((e) => e.classList.contains('hidden')), '재접속 후 배너 사라지고 경기 재개');

  console.log('[5] 나가기');
  await B.page.click('#btnMenu'); await B.page.click('#mLeave');
  await A.page.waitForSelector('#resultPanel:not(.hidden)', { timeout: 5000 });
  await shot(A, '17-result');
  ok((await A.page.textContent('#resTitle')) === 'WIN', '상대가 나가면 남은 사람 승리(기권승) 표시');
  ok(/내기 승리/.test(await A.page.textContent('#resReward')), '결과 창에 내기 승리 표시');
  const gb = async (u) => (await (await fetch(`http://localhost:3100/__test/bal?uid=${encodeURIComponent(u)}`)).json()).bal;
  ok((await gb(uidA)) === 8000 && (await gb(uidB)) === 10000, `내기 정산: 승자 8,000원 / 패자 10,000원 (${await gb(uidA)} / ${await gb(uidB)})`);
  await A.page.click('#resLobby'); await sleep(400); await shot(A, '18-after');
  console.log('[6] 로그아웃');
  await A.page.click('#btnLeave'); await sleep(300); await shot(A, '19-home'); await A.page.click('#btnLogout'); await A.page.waitForSelector('#devLogin:not(.hidden)', { timeout: 8000 });
  ok(true, '로그아웃 후 로그인 화면으로 복귀');

  console.log('\n페이지 오류:'); for (const p of [A, B]) console.log(' ', p.name, p.errs.length ? p.errs : '없음');
  const total = A.errs.length + B.errs.length;
  await browser.close();
  console.log(fails || total ? `\n실패 ${fails}, 오류 ${total}` : '\nE2E 모두 통과');
  process.exit(fails || total ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });
