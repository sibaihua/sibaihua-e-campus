/**
 * D1 建表 SQL（自动初始化用）
 * Worker 首次处理 API 请求时执行（幂等：全部使用 IF NOT EXISTS），
 * 因此**无需任何命令行**即可完成建表 —— 只要在 Workers 控制台为 Worker
 * 绑定了 D1 数据库（binding 名称 DB）。
 */
'use strict';

export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  salt          TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_enc  TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'user',
  english_name  TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  email_verified INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'registered',
  email_account TEXT,
  apply_error   TEXT,
  avatar_url    TEXT,
  created_at    TEXT NOT NULL,
  applied_at    TEXT
);
CREATE TABLE IF NOT EXISTS sessions (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
CREATE TABLE IF NOT EXISTS oauth_tokens (
  token      TEXT PRIMARY KEY,
  user_id    INTEGER NOT NULL,
  client_id  TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_oauth_tokens_user ON oauth_tokens(user_id);
CREATE TABLE IF NOT EXISTS oauth_codes (
  code                  TEXT PRIMARY KEY,
  user_id               INTEGER NOT NULL,
  client_id             TEXT NOT NULL,
  redirect_uri          TEXT NOT NULL,
  code_challenge        TEXT NOT NULL DEFAULT '',
  code_challenge_method TEXT NOT NULL DEFAULT '',
  expires_at            INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oauth_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT UNIQUE NOT NULL,
  client_secret TEXT NOT NULL,
  name          TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL DEFAULT '',
  logo_url      TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);
CREATE TABLE IF NOT EXISTS email_verifications (
  user_id      INTEGER PRIMARY KEY,
  email        TEXT NOT NULL,
  code         TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** 幂等初始化：并发请求只执行一次，失败后允许重试 */
export function makeDbInit() {
  let promise = null;
  // 按分号拆成单条语句执行（D1 exec 对多语句批处理兼容性不如逐条稳定）
  const statements = SCHEMA_SQL
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => s + ';'); // exec 需要语句以分号结尾（miniflare 本地模拟同样要求）

  // 老库补充新列（CREATE TABLE IF NOT EXISTS 不会给已存在的表加列）
  // 格式：[表, 列, 类型]；用 PRAGMA table_info 检查，缺列才 ALTER
  const extraColumns = [
    ['users', 'avatar_url', 'TEXT'],
    ['oauth_clients', 'logo_url', 'TEXT NOT NULL DEFAULT \'\''],
    ['oauth_codes', 'code_challenge', 'TEXT NOT NULL DEFAULT \'\''],
    ['oauth_codes', 'code_challenge_method', 'TEXT NOT NULL DEFAULT \'\''],
  ];

  return async function ensureDb(env) {
    if (!env.DB) {
      throw new Error('数据库未就绪：请在 Cloudflare Workers 控制台为该 Worker 添加 D1 绑定（binding 名称必须为 DB）');
    }
    if (!promise) {
      promise = (async () => {
        for (const stmt of statements) {
          try {
            await env.DB.prepare(stmt).run();
          } catch (e) {
            throw new Error(`建表语句执行失败: ${stmt.slice(0, 80)}… (${e.message})`);
          }
        }
        for (const [table, column, colType] of extraColumns) {
          const cols = await env.DB.prepare(`PRAGMA table_info(${table})`).all();
          const exists = (cols.results || []).some((c) => c.name === column);
          if (!exists) {
            await env.DB.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${colType}`).run();
          }
        }
      })().catch((e) => {
        promise = null; // 失败则下次请求重试
        throw e;
      });
    }
    await promise;
  };
}
