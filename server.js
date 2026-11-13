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

const PORT = process.env.PORT || 3000;
const app = express();
app.set('trust proxy', 1); // Render 등 프록시 뒤에서 실제 IP 사용
app.disable('x-powered-by');
app.use(express.json({ limit: '32kb' }));

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});

app.get('/healthz', (_req, res) => res.json({ ok: true, ...game.stats(), uptime: Math.round(process.uptime()) }));
app.get('/api/catalog', (_req, res) => { res.set('Cache-Control', 'public, max-age=300'); res.json(api.catalogPayload()); });
app.post('/api/pull', (req, res) => { const r = api.handlePull(req.body, req.ip); res.status(r.status).json(r.body); });
app.post('/api/inventory', (req, res) => { const r = api.handleInventory(req.body, req.ip); res.status(r.status).json(r.body); });

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
const game = net.attach(io);

server.listen(PORT, () => console.log(`RANDOM FOOTBALL listening on :${PORT}`));

function shutdown() { game.stop(); io.close(); server.close(() => process.exit(0)); setTimeout(() => process.exit(0), 3000).unref(); }
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
