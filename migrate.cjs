/**
 * 数据迁移脚本（本地 Node.js 运行，非 Worker 代码）
 * 作用：读取原系统 data/db.json，生成可直接导入 Cloudflare D1 的 SQL 文件。
 *
 * 关键转换：
 *  1. 密码哈希：Node scrypt  →  Worker 兼容的 PBKDF2（pbkdf2$iter$saltHex$hashHex）
 *  2. 密码密文：scrypt 派生的 AES-GCM → PBKDF2(SECRET,'admission-pw-enc-v2') 派生的 AES-GCM
 *     （Worker 端 auth.js 用同一派生参数解密，用于开户时还原明文密码）
 *
 * 用法：
 *  ​node migrate.js [--db ../sibaihua-admission/data/db.json] [--out ./migrate_users.sql] [--secret <SECRET>]
 * 然后执行：wrangler d1 execute sibaihua-e-campus --file=./migrate_users.sql
 *（本地验证：wrangler d1 execute sibaihua-e-campus --local --file=./migrate_users.sql）
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PBKDF2_ITER = 100000;
const ENC_SALT = 'admission-pw-enc-v2';
const DEFAULT_SECRET = 'sibaihua-admission-2026-default-secret';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i > -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const dbPath = path.resolve(arg('db', path.join(__dirname, '..', 'sibaihua-admission', 'data', 'db.json')));
const outPath = path.resolve(arg('out', path.join(__dirname, 'migrate_users.sql')));
const secret = arg('secret', process.env.SECRET || DEFAULT_SECRET);

const db = JSON.parse(fs.readFileSync(dbPath, 'utf8'));
const sql = [];
sql.push('-- 由 migrate.js 生成的迁移脚本（' + new Date().toISOString() + '）');
sql.push('PRAGMA foreign_keys = OFF;');

/* ---------- 1) 用户：scrypt 哈希 → PBKDF2；密码密文重新加密 ---------- */

// 旧密钥（原 server.js：scryptSync(SECRET,'admission-pw-enc-v1',32)）
const OLD_ENC_KEY = crypto.scryptSync(secret, 'admission-pw-enc-v1', 32);
// 新密钥（Worker auth.js：PBKDF2(SECRET,'admission-pw-enc-v2',100000)）
const NEW_ENC_KEY = crypto.pbkdf2Sync(secret, ENC_SALT, PBKDF2_ITER, 32, 'sha256');

function oldDecrypt(blob) {
  const [ivB, tagB, encB] = String(blob).split('.');
  const d = crypto.createDecipheriv('aes-256-gcm', OLD_ENC_KEY, Buffer.from(ivB, 'base64'));
  d.setAuthTag(Buffer.from(tagB, 'base64'));
  return Buffer.concat([d.update(Buffer.from(encB, 'base64')), d.final()]).toString('utf8');
}

function newEncrypt(plain) {
  const iv = crypto.randomBytes(12);
  const c = crypto.createCipheriv('aes-256-gcm', NEW_ENC_KEY, iv);
  const enc = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString('base64')).join('.');
}

const esc = (s) => String(s == null ? '' : s).replace(/'/g, "''");

for (const u of (db.users || [])) {
  let plain = null;
  if (u.passwordEnc && u.passwordEnc.includes('.')) {
    try {
      plain = oldDecrypt(u.passwordEnc);
      console.log(`[users] ${u.username}: 密码已解密并重新加密`);
    } catch (e) {
      console.warn(`[users] ${u.username}: 旧密文解密失败（${e.message}），该账号将无法登录，需管理员重置密码`);
    }
  }
  const passwordEnc = plain ? newEncrypt(plain) : (u.passwordEnc || null);
  let passwordHash = null;
  let salt = '';
  if (plain) {
    salt = crypto.randomBytes(16).toString('hex');
    // 注意：Node 的 pbkdf2Sync 需传入 Buffer.from(salt, 'hex')，
    // 与 Worker auth.js 的 hexToBytes 保持字节级一致
    passwordHash = `pbkdf2$${PBKDF2_ITER}$${salt}$${crypto.pbkdf2Sync(plain, Buffer.from(salt, 'hex'), PBKDF2_ITER, 32, 'sha256').toString('hex')}`;
  }
  sql.push(
    `INSERT INTO users (id, username, salt, password_hash, password_enc, role, english_name, contact_email, email_verified, status, email_account, apply_error, created_at, applied_at) VALUES (` +
    `${u.id}, '${esc(u.username)}', '${salt}', ` +
    `${passwordHash ? `'${passwordHash}'` : 'NULL'}, ` +
    `${passwordEnc ? `'${esc(passwordEnc)}'` : 'NULL'}, ` +
    `'${esc(u.role || 'user')}', '${esc(u.englishName || '')}', '${esc(u.contactEmail || '')}', ` +
    `${u.emailVerified ? 1 : 0}, '${esc(u.status || 'registered')}', ` +
    `${u.emailAccount ? `'${esc(u.emailAccount)}'` : 'NULL'}, ` +
    `${u.applyError ? `'${esc(u.applyError)}'` : 'NULL'}, ` +
    `'${esc(u.createdAt)}', ${u.appliedAt ? `'${esc(u.appliedAt)}'` : 'NULL'});`
  );
}

/* ---------- 2) OAuth 客户端 ---------- */
for (const c of (db.oauthClients || [])) {
  sql.push(
    `INSERT INTO oauth_clients (id, client_id, client_secret, name, redirect_uri, created_at, updated_at) VALUES (` +
    `${c.id}, '${esc(c.clientId)}', '${esc(c.clientSecret)}', '${esc(c.name)}', '${esc(c.redirectUri || '')}', ` +
    `'${esc(c.createdAt)}', ${c.updatedAt ? `'${esc(c.updatedAt)}'` : 'NULL'});`
  );
}

/* ---------- 3) 设置 ---------- */
const s = db.settings || {};
if (s.mailAdminEmail) sql.push(`INSERT INTO settings (key, value) VALUES ('mail_admin_email', '${esc(s.mailAdminEmail)}');`);
if (s.mailAdminPassword) sql.push(`INSERT INTO settings (key, value) VALUES ('mail_admin_password', '${esc(s.mailAdminPassword)}');`);
sql.push(`INSERT INTO settings (key, value) VALUES ('turnstile_enabled', '${s.turnstileEnabled === false || s.turnstileEnabled === '0' ? '0' : '1'}');`);
if (s.smtp && s.smtp.from) {
  sql.push(`INSERT INTO settings (key, value) VALUES ('mail_provider_json', '${esc(JSON.stringify({ provider: 'resend', from: s.smtp.from, fromName: s.smtp.fromName || '', domain: (s.smtp.from || '').split('@')[1] || '', apiKey: '' }))}');`);
}

/* ---------- 4) 未过期的会话 / OAuth 令牌（可选，易失数据） ---------- */
const now = Date.now();
let transient = 0;
for (const [token, rec] of Object.entries(db.sessions || {})) {
  if (rec.expiresAt > now) {
    sql.push(`INSERT INTO sessions (token, user_id, expires_at) VALUES ('${token}', ${rec.userId}, ${rec.expiresAt});`);
    transient++;
  }
}
for (const [token, rec] of Object.entries(db.oauthTokens || {})) {
  if (rec.expiresAt > now) {
    sql.push(`INSERT INTO oauth_tokens (token, user_id, client_id, expires_at) VALUES ('${token}', ${rec.userId}, '${esc(rec.clientId)}', ${rec.expiresAt});`);
    transient++;
  }
}

fs.writeFileSync(outPath, sql.join('\n'), 'utf8');
console.log('--------------------------------------------------');
console.log(`✅ 迁移脚本已生成：${outPath}`);
console.log(`   - 用户 ${(db.users || []).length} 个 · OAuth 客户端 ${(db.oauthClients || []).length} 个`);
console.log(`   - 未过期会话/令牌 ${transient} 条（已保留）`);
console.log('下一步（在 cloudflare-worker 目录）：');
console.log(`   wrangler d1 execute sibaihua-e-campus --file=./migrate_users.sql`);
console.log('   本地验证：wrangler d1 execute sibaihua-e-campus --local --file=./migrate_users.sql');
console.log('注意：SECRET 必须与 wrangler.toml / 部署时环境变量 SECRET 一致，否则 passwordEnc 无法解密。');
