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
const api = require('./lib/api');
const net = require('./lib/net');

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

app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m', extensions: ['html'] }));

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
