'use strict';
/**
 * 계정 저장소. 운영: PostgreSQL(DATABASE_URL, 예: Neon 무료), 개발/테스트: 메모리.
 * 모든 쓰기는 txn(ids, fn) 안에서 행 잠금(FOR UPDATE)과 함께 원자적으로 수행된다.
 *   fn(map) 에서 map[id] 를 수정(또는 null 이던 항목에 객체 대입)하면 커밋 시 저장된다.
 */
const clone = (o) => (o == null ? o : JSON.parse(JSON.stringify(o)));

class MemoryStore {
  constructor() { this.acc = new Map(); this.lock = Promise.resolve(); this.kind = 'memory'; }
  async init() { /* noop */ }
  async get(id) { return clone(this.acc.get(id)) || null; }
  async txn(ids, fn) {
    const run = async () => {
      const uniq = [...new Set(ids)].sort();
      const map = {};
      for (const id of uniq) map[id] = clone(this.acc.get(id)) || null;
      const res = await fn(map);
      for (const id of uniq) if (map[id]) this.acc.set(id, clone(map[id]));
      return res;
    };
    const p = this.lock.then(run, run);
    this.lock = p.catch(() => {});
    return p;
  }
  async findByNick(nick) { return [...this.acc.values()].filter((a) => String(a.nick || '').toLowerCase() === nick).map((a) => a.id); }
  async listLocked() { return [...this.acc.values()].filter((a) => a.locked).map((a) => a.id); }
  async close() { /* noop */ }
}

class PgStore {
  constructor(url) {
    const { Pool } = require('pg'); // 운영에서만 필요한 의존성
    const local = /localhost|127\.0\.0\.1/.test(url);
    this.pool = new Pool({ connectionString: url, max: 5, idleTimeoutMillis: 20000, connectionTimeoutMillis: 15000, ssl: local ? false : { rejectUnauthorized: false } });
    this.pool.on('error', (e) => console.error('[pg] pool error', e.message));
    this.kind = 'postgres';
  }
  async init() {
    await this.pool.query('create table if not exists accounts (id text primary key, data jsonb not null, updated_at timestamptz not null default now())');
  }
  async get(id) {
    const r = await this.pool.query('select data from accounts where id = $1', [id]);
    return r.rows[0] ? r.rows[0].data : null;
  }
  async txn(ids, fn) {
    const c = await this.pool.connect();
    try {
      await c.query('begin');
      const uniq = [...new Set(ids)].sort();
      const map = {};
      for (const id of uniq) {
        const r = await c.query('select data from accounts where id = $1 for update', [id]);
        map[id] = r.rows[0] ? r.rows[0].data : null;
      }
      const res = await fn(map);
      for (const id of uniq) {
        if (map[id]) await c.query('insert into accounts (id, data) values ($1, $2) on conflict (id) do update set data = excluded.data, updated_at = now()', [id, JSON.stringify(map[id])]);
      }
      await c.query('commit');
      return res;
    } catch (e) {
      try { await c.query('rollback'); } catch (x) { /* noop */ }
      throw e;
    } finally { c.release(); }
  }
  async findByNick(nick) {
    const r = await this.pool.query("select id from accounts where lower(data->>'nick') = $1", [nick]);
    return r.rows.map((x) => x.id);
  }
  async listLocked() {
    const r = await this.pool.query("select id from accounts where data->'locked' is not null and data->>'locked' <> 'null'");
    return r.rows.map((x) => x.id);
  }
  async close() { await this.pool.end(); }
}

function createStore() {
  if (process.env.DATABASE_URL) return new PgStore(process.env.DATABASE_URL);
  console.warn('[경고] DATABASE_URL 이 없어 메모리 저장소를 사용합니다. 서버가 재시작되면 모든 계정/잔액이 사라집니다!');
  return new MemoryStore();
}

module.exports = { MemoryStore, PgStore, createStore };
