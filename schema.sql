-- 司白画大学清迈分校「我的E校园」 · Cloudflare D1 schema
-- 应用方式：wrangler d1 execute sibaihua-e-campus --remote --file=./schema.sql
--           （本地开发：wrangler d1 execute sibaihua-e-campus --local --file=./schema.sql）

CREATE TABLE IF NOT EXISTS users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  username      TEXT UNIQUE NOT NULL,
  salt          TEXT NOT NULL,                 -- PBKDF2 salt（hex）
  password_hash TEXT NOT NULL,                 -- pbkdf2$iter$salt_b64$hash_b64
  password_enc  TEXT NOT NULL,                 -- AES-256-GCM iv.tag.cipher (base64)，用于开户还原密码
  role          TEXT NOT NULL DEFAULT 'user',  -- user | admin
  english_name  TEXT NOT NULL DEFAULT '',
  contact_email TEXT NOT NULL DEFAULT '',
  email_verified INTEGER NOT NULL DEFAULT 0,
  status        TEXT NOT NULL DEFAULT 'registered', -- registered | approved | failed
  email_account TEXT,
  apply_error   TEXT,
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
  code         TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL,
  client_id    TEXT NOT NULL,
  redirect_uri TEXT NOT NULL,
  expires_at   INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_clients (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  client_id     TEXT UNIQUE NOT NULL,
  client_secret TEXT NOT NULL,
  name          TEXT NOT NULL,
  redirect_uri  TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  updated_at    TEXT
);

CREATE TABLE IF NOT EXISTS captchas (
  id         TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS email_verifications (
  user_id      INTEGER PRIMARY KEY,
  email        TEXT NOT NULL,
  code         TEXT NOT NULL,
  expires_at   INTEGER NOT NULL,
  last_sent_at INTEGER NOT NULL
);

-- key-value 设置：mail_admin_email / mail_admin_password / mail_token_json /
--                mail_provider_json / turnstile_enabled
CREATE TABLE IF NOT EXISTS settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
