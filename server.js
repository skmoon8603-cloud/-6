'use strict';
/**
 * RANDOM FOOTBALL 서버
 *  - Express: 정적 파일(public/) + REST(/api/catalog, /api/pull, /api/inventory, /healthz)
 *  - Socket.IO: 방 생성/입장, 실시간 경기 (서버 권한)
 */
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const fs = require('fs');
// 폴더 구조(lib/, public/)로 올리든, 모든 파일을 한 폴더에 평평하게 올리든 동작하도록 경로를 자동 탐색
const modPath = (n) => (fs.existsSync(path.join(__dirname, 'lib', n + '.js')) ? './lib/' + n : './' + n);
const api = require(modPath('api'));
const net = require(modPath('net'));
const bounceNet = require(modPath('bouncenet'));
const VERSION = require(modPath('version')).compute(path.join(__dirname, 'public'), __dirname);
const auth = require(modPath('auth'));
const { createStore } = require(modPath('store'));
const { Accounts, isAdmin } = require(modPath('accounts'));
const ADMIN_ID_ = process.env.ADMIN_ID || 'u-skmoon';
const { Market } = require(modPath('market'));
const chatNet = require(modPath('chat'));
const flashNet = require(modPath('flash'));
const presenceNet = require(modPath('presence'));
const C = require(modPath('catalog'));

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1); // Render 등 프록시 뒤에서 실제 IP 사용
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

const store = createStore();
const accounts = new Accounts(store);
const market = new Market(store);
let chat = { sys() {} };
let presence = { stop() {} };
let ioRef = null;
const pushAcct = (uid, acct) => { if (!ioRef || !acct) return; for (const [, s] of ioRef.of('/').sockets) if (s.data && s.data.uid === uid) s.emit('account', acct); };
const onMarket = (op, uid, out) => {
  pushAcct(uid, out.acct);
  if (op === 'buy') {
    pushAcct(out.seller, out.sellerAcct);
    const p = C.BY_ID[out.pid];
    if (p && ['hero', 'legend', 'myth'].includes(p.rarity)) chat.sys(`💸 이적 완료! ${out.buyerNick} 님이 ${out.sellerNick} 님의 ${p.name} 선수를 ${Number(out.price).toLocaleString('ko-KR')}원에 영입했어요`);
  }
  if (ioRef) ioRef.emit('market:changed');
};
const A = api.create({ accounts, auth, market, onMarket });
let game = { stats: () => ({}), stop() {} };
let bounce = { stop() {} };
app.get('/healthz', (_req, res) => res.json({ ok: true, db: store.kind, ...game.stats(), uptime: Math.round(process.uptime()) }));
app.get('/api/catalog', (_req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.json(api.catalogPayload()); });
app.get('/api/config', A.config);
app.post('/api/login', A.login);
app.post('/api/register', A.register);
app.post('/api/signin', A.signin);
app.get('/auth/github', A.githubStart);
app.get('/auth/github/callback', A.githubCallback);
app.get('/api/me', A.me);
app.post('/api/pull', A.pull);
app.post('/api/nick', A.nick);
app.post('/api/attend', A.attend);
app.get('/api/players', A.players);
app.get('/api/market', A.marketView);
app.post('/api/market', A.marketAct);
app.post('/api/admin/money', A.adminMoney);
app.post('/api/admin/delete', A.adminDelete);
app.get('/api/version', (_req, res) => { res.set('Cache-Control', 'no-store'); res.json({ v: VERSION, goals: [1, 2, 3].filter((i) => ['goal' + i + '.mp3', 'public/goal' + i + '.mp3'].some((f) => fs.existsSync(path.join(__dirname, f)))) }); });

const PUB = path.join(__dirname, 'public');
if (fs.existsSync(path.join(PUB, 'index.html'))) {
  app.use(express.static(PUB, { maxAge: 0, etag: true, extensions: ['html'], setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') }));
} else {
  // 평평한 구조: 클라이언트 파일만 공개 (server.js 등은 노출하지 않음)
  const CLIENT = ['index.html', 'style.css', 'meta.js', 'render.js', 'game.js', 'bounce.js', 'hub.js'];
  if (fs.existsSync(path.join(__dirname, 'flash.jpg'))) app.get('/flash.jpg', (_req, res) => res.sendFile(path.join(__dirname, 'flash.jpg')));
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  CLIENT.forEach((f) => app.get('/' + f, (_req, res) => res.sendFile(path.join(__dirname, f))));
  for (const i of [1, 2, 3]) if (fs.existsSync(path.join(__dirname, `goal${i}.mp3`))) app.get(`/goal${i}.mp3`, (_req, res) => res.sendFile(path.join(__dirname, `goal${i}.mp3`))); // 골 리플레이 음악 3곡
}

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CORS_ORIGIN || false },
  pingInterval: 10000,
  pingTimeout: 15000,
  maxHttpBufferSize: 1e5,
});
(async () => {
  await store.init();
  const n = await accounts.refundAllLocked();
  if (n) console.log('[내기] 서버 재시작으로 중단된 내기 환급:', n);
  try { const t = await accounts.grantTier(ADMIN_ID_, 33, 'grantedTop'); console.log('[지급] 관리자 티어 승엄급:', t.ok ? (t.already ? '이미 지급됨' : '완료') : '계정 없음'); } catch (e) { console.error('[지급] 오류', e.message); }
  try { const h = await accounts.grantItem(ADMIN_ID_, 'X77', 'grantedHid'); console.log('[지급] 관리자 문서경:', h.ok ? (h.already ? '이미 지급됨' : '완료') : '계정 없음'); } catch (e) { console.error('[지급] 오류', e.message); }
  try { // 운영자 요청: 닉네임 skmoon 계정에 모든 캐릭터 1장씩 (1회성)
    const g = await accounts.grantAllByNick('skmoon');
    console.log('[지급] skmoon:', g.ok ? (g.already ? '이미 지급됨' : '모든 캐릭터 지급 완료') : `실패 (일치하는 계정 ${g.found}개)`);
  } catch (e) { console.error('[지급] 오류', e.message); }
  ioRef = io;
  game = net.attach(io, { accounts, auth });
  chat = chatNet.attach(io, { accounts, isAdmin });
  flashNet.attach(io, { isAdmin });
  presence = presenceNet.attach(io, { accounts });
  bounce = bounceNet.attach(io, { accounts });
  server.listen(PORT, () => console.log(`RANDOM FOOTBALL listening on :${PORT} (db=${store.kind})`));
})().catch((e) => { console.error('시작 실패', e); process.exit(1); });

function shutdown() { game.stop(); bounce.stop(); presence.stop(); io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
