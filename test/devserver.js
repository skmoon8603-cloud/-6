'use strict';
/**
 * [테스트 전용] express/socket.io 없이 실제 서버 로직(lib/*)을 브라우저와 연결해 보는 개발용 서버.
 * socket.io 호환 최소 shim(SSE + fetch)을 /socket.io/socket.io.js 로 제공한다.
 * 실제 배포에서는 server.js(Express + Socket.IO)를 사용한다.
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
process.env.DEV_LOGIN = '1'; process.env.SESSION_SECRET = 'dev-e2e';
const api = require('../lib/api');
const net = require('../lib/net');
const auth = require('../lib/auth');
const { MemoryStore } = require('../lib/store');
const { Accounts } = require('../lib/accounts');
const store = new MemoryStore(); const accounts = new Accounts(store);
const A = api.create({ accounts, auth });
const mw = [];

const PUB = path.join(__dirname, '..', 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };
const handlersOnConn = [];
const io = { use: (fn) => mw.push(fn), on: (ev, fn) => { if (ev === 'connection') handlersOnConn.push(fn); } };
const game = net.attach(io, { accounts, auth });
const bounceGame = require('../lib/bouncenet').attach(io, { accounts });
const socks = new Map();

const SHIM = `(function(){
  window.io=function(opts){
    const H={};let es=null,sid=null,closed=false;
    const s={connected:false,
      on(ev,fn){(H[ev]=H[ev]||[]).push(fn);return s;},
      emit(ev,data,ack){ if(!s.connected)return; const has=typeof ack==='function';
        fetch('/__sock/emit',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({sid,ev,data,has})})
          .then(r=>r.json()).then(j=>{if(has)ack(j.ack);}).catch(()=>{}); },
      disconnect(){closed=true;if(es)es.close();fire('disconnect');},
      connect(){closed=false;open();},
      io:{on(){}}, _drop(){ if(es){es.close();} s.connected=false; fire('disconnect'); setTimeout(()=>{ if(!closed) open(); },400);} };
    s.volatile=s;
    function fire(ev,d){(H[ev]||[]).forEach(f=>f(d));}
    function open(){
      sid=Math.random().toString(36).slice(2);
      es=new EventSource('/__sock/stream?sid='+sid+'&token='+encodeURIComponent((opts&&opts.auth&&opts.auth.token)||''));
      es.onopen=()=>{s.connected=true;fire('connect');};
      es.onmessage=(m)=>{const o=JSON.parse(m.data);fire(o.ev,o.d);};
      es.onerror=()=>{ if(s.connected){s.connected=false;fire('disconnect');} es.close(); if(!closed) setTimeout(open,800); };
    }
    open(); window.__sock=s; return s;
  };
})();`;

function body(req) { return new Promise((res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => { try { res(JSON.parse(b || '{}')); } catch (e) { res({}); } }); }); }

http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/socket.io/socket.io.js') { res.writeHead(200, { 'Content-Type': 'text/javascript' }); return res.end(SHIM); }
  if (url.pathname === '/api/catalog') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify(api.catalogPayload())); }
  const routes = { '/api/config': A.config, '/api/login': A.login, '/api/register': A.register, '/api/signin': A.signin, '/api/me': A.me, '/api/pull': A.pull, '/api/nick': A.nick };
  if (routes[url.pathname]) {
    const b = req.method === 'POST' ? await body(req) : undefined;
    const rq = { headers: req.headers, body: b, ip: req.socket.remoteAddress };
    const rs = { json: (o) => { res.writeHead(rs.code || 200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }, status: (c) => { rs.code = c; return rs; } };
    return routes[url.pathname](rq, rs);
  }
  if (url.pathname === '/__test/grant') { const a = await accounts.reward(url.searchParams.get('uid'), Number(url.searchParams.get('amt'))); res.writeHead(200); return res.end(JSON.stringify(a)); }
  if (url.pathname === '/__test/bal') { const a = await accounts.get(url.searchParams.get('uid')); res.writeHead(200); return res.end(JSON.stringify(a)); }
  if (url.pathname === '/healthz') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, ...game.stats() })); }
  if (url.pathname === '/__sock/stream') {
    const sid = url.searchParams.get('sid');
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write(': ok\n\n');
    const h = {};
    const push = (ev, d) => { try { res.write('data: ' + JSON.stringify({ ev, d }) + '\n\n'); } catch (e) { /* closed */ } };
    const sock = { id: sid, data: {}, handshake: { auth: { token: url.searchParams.get('token') } }, on: (ev, fn) => { const prev = h[ev]; h[ev] = prev ? (...a) => { prev(...a); return fn(...a); } : fn; }, emit: push, leave() {}, disconnect() { res.end(); }, volatile: { emit: push } };
    socks.set(sid, { h, sock });
    try { for (const fn of mw) await new Promise((ok, no) => fn(sock, (e) => (e ? no(e) : ok()))); } catch (e) { return res.end(); }
    handlersOnConn.forEach((fn) => fn(sock));
    req.on('close', () => { socks.delete(sid); if (h.disconnect) h.disconnect(); });
    return;
  }
  if (url.pathname === '/__sock/emit' && req.method === 'POST') {
    const { sid, ev, data, has } = await body(req);
    const s = socks.get(sid);
    if (!s || !s.h[ev]) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{}'); }
    let done = false;
    const finish = (v) => { if (done) return; done = true; res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ ack: v })); };
    s.h[ev](data, has ? finish : undefined);
    if (!has) finish(null); else setTimeout(() => finish(null), 3000);
    return;
  }
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const f = path.join(PUB, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!f.startsWith(PUB) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
  fs.createReadStream(f).pipe(res);
}).listen(process.env.PORT || 3100, () => console.log('devserver on :' + (process.env.PORT || 3100)));
