/**
 * D1 数据访问层
 * 把原 server.js 中 db.json 的内存对象模型映射为 SQLite 表。
 * 行字段 snake_case <-> 对象字段 camelCase 自动转换。
 */
'use strict';

function rowToUser(r) {
  if (!r) return null;
  return {
    id: r.id,
    username: r.username,
    salt: r.salt,
    passwordHash: r.password_hash,
    passwordEnc: r.password_enc,
    role: r.role,
    englishName: r.english_name || '',
    contactEmail: r.contact_email || '',
    emailVerified: !!r.email_verified,
    status: r.status,
    emailAccount: r.email_account || null,
    applyError: r.apply_error || null,
    avatarUrl: r.avatar_url || null,
    createdAt: r.created_at,
    appliedAt: r.applied_at || null,
  };
}

function userToRow(u) {
  return {
    username: u.username,
    salt: u.salt,
    password_hash: u.passwordHash,
    password_enc: u.passwordEnc,
    role: u.role,
    english_name: u.englishName || '',
    contact_email: u.contactEmail || '',
    email_verified: u.emailVerified ? 1 : 0,
    status: u.status,
    email_account: u.emailAccount || null,
    apply_error: u.applyError || null,
    avatar_url: u.avatarUrl || null,
    created_at: u.createdAt,
    applied_at: u.appliedAt || null,
  };
}

const db = {
  /* ---------- 用户 ---------- */
  async userByUsername(env, username) {
    const r = await env.DB.prepare('SELECT * FROM users WHERE username = ?').bind(username).first();
    return rowToUser(r);
  },
  async userById(env, id) {
    const r = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
    return rowToUser(r);
  },
  async listUsers(env) {
    const { results } = await env.DB.prepare('SELECT * FROM users ORDER BY id DESC').all();
    return (results || []).map(rowToUser);
  },
  async createUser(env, u) {
    const r = await env.DB.prepare(
      `INSERT INTO users (username, salt, password_hash, password_enc, role, english_name, contact_email, email_verified, status, email_account, apply_error, avatar_url, created_at, applied_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      u.username, u.salt, u.passwordHash, u.passwordEnc, u.role,
      u.englishName || '', u.contactEmail || '', u.emailVerified ? 1 : 0,
      u.status, u.emailAccount || null, u.applyError || null, u.avatarUrl || null, u.createdAt, u.appliedAt || null
    ).run();
    return db.userById(env, r.meta.last_row_id);
  },
  async updateUser(env, id, fields) {
    const u = await db.userById(env, id);
    if (!u) return null;
    const merged = { ...u, ...fields };
    await env.DB.prepare(
      `UPDATE users SET username=?, salt=?, password_hash=?, password_enc=?, role=?, english_name=?, contact_email=?, email_verified=?, status=?, email_account=?, apply_error=?, avatar_url=?, applied_at=?
       WHERE id=?`
    ).bind(
      merged.username, merged.salt, merged.passwordHash, merged.passwordEnc, merged.role,
      merged.englishName || '', merged.contactEmail || '', merged.emailVerified ? 1 : 0,
      merged.status, merged.emailAccount || null, merged.applyError || null, merged.avatarUrl || null, merged.appliedAt || null,
      id
    ).run();
    return db.userById(env, id);
  },
  async deleteUser(env, id) {
    await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  },

  /* ---------- 会话 ---------- */
  async createSession(env, token, userId, expiresAt) {
    await env.DB.prepare('INSERT INTO sessions (token, user_id, expires_at) VALUES (?, ?, ?)').bind(token, userId, expiresAt).run();
  },
  async getSession(env, token) {
    return env.DB.prepare('SELECT * FROM sessions WHERE token = ?').bind(token).first();
  },
  async deleteSession(env, token) {
    await env.DB.prepare('DELETE FROM sessions WHERE token = ?').bind(token).run();
  },
  async deleteSessionsByUser(env, userId) {
    await env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(userId).run();
  },

  /* ---------- OAuth ---------- */
  async createOauthToken(env, token, userId, clientId, expiresAt) {
    await env.DB.prepare('INSERT INTO oauth_tokens (token, user_id, client_id, expires_at) VALUES (?, ?, ?, ?)').bind(token, userId, clientId, expiresAt).run();
  },
  async getOauthToken(env, token) {
    return env.DB.prepare('SELECT * FROM oauth_tokens WHERE token = ?').bind(token).first();
  },
  async deleteOauthTokensByUser(env, userId) {
    await env.DB.prepare('DELETE FROM oauth_tokens WHERE user_id = ?').bind(userId).run();
  },
  async createOauthCode(env, code, rec) {
    await env.DB.prepare('INSERT INTO oauth_codes (code, user_id, client_id, redirect_uri, code_challenge, code_challenge_method, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .bind(code, rec.userId, rec.clientId, rec.redirectUri, rec.codeChallenge || '', rec.codeChallengeMethod || '', rec.expiresAt).run();
  },
  async getOauthCode(env, code) {
    const r = await env.DB.prepare('SELECT * FROM oauth_codes WHERE code = ?').bind(code).first();
    if (!r) return null;
    return {
      userId: r.user_id,
      clientId: r.client_id,
      redirectUri: r.redirect_uri,
      codeChallenge: r.code_challenge || '',
      codeChallengeMethod: r.code_challenge_method || '',
      expiresAt: r.expires_at,
    };
  },
  async deleteOauthCode(env, code) {
    await env.DB.prepare('DELETE FROM oauth_codes WHERE code = ?').bind(code).run();
  },
  async listOauthClients(env) {
    const { results } = await env.DB.prepare('SELECT * FROM oauth_clients ORDER BY id DESC').all();
    return (results || []).map((r) => ({
      id: r.id, clientId: r.client_id, clientSecret: r.client_secret, name: r.name,
      redirectUri: r.redirect_uri || '', logoUrl: r.logo_url || '', createdAt: r.created_at, updatedAt: r.updated_at || null,
    }));
  },
  async oauthClientById(env, clientId) {
    const r = await env.DB.prepare('SELECT * FROM oauth_clients WHERE client_id = ?').bind(clientId).first();
    if (!r) return null;
    return {
      id: r.id, clientId: r.client_id, clientSecret: r.client_secret, name: r.name,
      redirectUri: r.redirect_uri || '', logoUrl: r.logo_url || '', createdAt: r.created_at, updatedAt: r.updated_at || null,
    };
  },
  async createOauthClient(env, c) {
    const r = await env.DB.prepare(
      'INSERT INTO oauth_clients (client_id, client_secret, name, redirect_uri, logo_url, created_at) VALUES (?, ?, ?, ?, ?, ?)'
    ).bind(c.clientId, c.clientSecret, c.name, c.redirectUri || '', c.logoUrl || '', c.createdAt).run();
    return { id: r.meta.last_row_id, ...c };
  },
  async updateOauthClient(env, clientId, fields) {
    const cur = await db.oauthClientById(env, clientId);
    if (!cur) return null;
    const merged = { ...cur, ...fields, updatedAt: new Date().toISOString() };
    await env.DB.prepare('UPDATE oauth_clients SET name=?, redirect_uri=?, logo_url=?, updated_at=? WHERE client_id=?')
      .bind(merged.name, merged.redirectUri || '', merged.logoUrl || '', merged.updatedAt, clientId).run();
    return db.oauthClientById(env, clientId);
  },
  async deleteOauthClient(env, clientId) {
    await env.DB.prepare('DELETE FROM oauth_clients WHERE client_id = ?').bind(clientId).run();
  },

  /* ---------- 验证码 ---------- */
  async createCaptcha(env, id, code, expiresAt) {
    await env.DB.prepare('INSERT INTO captchas (id, code, expires_at) VALUES (?, ?, ?)').bind(id, code, expiresAt).run();
  },
  async getCaptcha(env, id) {
    const r = await env.DB.prepare('SELECT * FROM captchas WHERE id = ?').bind(id).first();
    if (!r) return null;
    return { code: r.code, expiresAt: r.expires_at };
  },
  async deleteCaptcha(env, id) {
    await env.DB.prepare('DELETE FROM captchas WHERE id = ?').bind(id).run();
  },

  /* ---------- 邮箱验证 ---------- */
  async getEmailVerification(env, userId) {
    const r = await env.DB.prepare('SELECT * FROM email_verifications WHERE user_id = ?').bind(userId).first();
    if (!r) return null;
    return { email: r.email, code: r.code, expiresAt: r.expires_at, lastSentAt: r.last_sent_at };
  },
  async upsertEmailVerification(env, userId, rec) {
    await env.DB.prepare(
      `INSERT INTO email_verifications (user_id, email, code, expires_at, last_sent_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET email=excluded.email, code=excluded.code, expires_at=excluded.expires_at, last_sent_at=excluded.last_sent_at`
    ).bind(userId, rec.email, rec.code, rec.expiresAt, rec.lastSentAt).run();
  },
  async deleteEmailVerification(env, userId) {
    await env.DB.prepare('DELETE FROM email_verifications WHERE user_id = ?').bind(userId).run();
  },

  /* ---------- 设置（key-value） ---------- */
  async getSetting(env, key) {
    const r = await env.DB.prepare('SELECT value FROM settings WHERE key = ?').bind(key).first();
    return r ? r.value : null;
  },
  async setSetting(env, key, value) {
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value'
    ).bind(key, String(value)).run();
  },
};

export default db;
