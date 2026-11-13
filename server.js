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
const auth = require(modPath('auth'));
const { createStore } = require(modPath('store'));
const { Accounts } = require(modPath('accounts'));

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
const A = api.create({ accounts, auth });
let game = { stats: () => ({}), stop() {} };
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

const PUB = path.join(__dirname, 'public');
if (fs.existsSync(path.join(PUB, 'index.html'))) {
  app.use(express.static(PUB, { maxAge: '5m', extensions: ['html'] }));
} else {
  // 평평한 구조: 클라이언트 파일 5개만 공개 (server.js 등은 노출하지 않음)
  const CLIENT = ['index.html', 'style.css', 'meta.js', 'render.js', 'game.js'];
  app.get('/', (_req, res) => res.sendFile(path.join(__dirname, 'index.html')));
  CLIENT.forEach((f) => app.get('/' + f, (_req, res) => res.sendFile(path.join(__dirname, f))));
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
  try { // 운영자 요청: 닉네임 skmoon 계정에 모든 캐릭터 1장씩 (1회성)
    const g = await accounts.grantAllByNick('skmoon');
    console.log('[지급] skmoon:', g.ok ? (g.already ? '이미 지급됨' : '모든 캐릭터 지급 완료') : `실패 (일치하는 계정 ${g.found}개)`);
  } catch (e) { console.error('[지급] 오류', e.message); }
  game = net.attach(io, { accounts, auth });
  server.listen(PORT, () => console.log(`RANDOM FOOTBALL listening on :${PORT} (db=${store.kind})`));
})().catch((e) => { console.error('시작 실패', e); process.exit(1); });

function shutdown() { game.stop(); io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
