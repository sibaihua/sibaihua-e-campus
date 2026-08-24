/**
 * 司白画大学清迈分校「我的E校园」— Cloudflare Worker 入口
 * 由原 sibaihua-admission/server.js（零依赖 Node）迁移而来：
 *   - 存储：db.json 内存对象 → Cloudflare D1（src/db.js）
 *   - 密码：scrypt → PBKDF2（Web Crypto，src/auth.js）
 *   - 发信：SMTP(net/tls) → MailChannels API（src/mail.js）
 *   - 其余接口路径与响应结构与原版完全一致，前端无需改动
 */
'use strict';

import db from './db.js';
import {
  hashPassword, verifyPassword, encryptPassword, decryptPassword,
} from './auth.js';
import { genCaptchaCode, makeCaptchaSvg } from './captcha.js';
import {
  sendMail, getMailProvider, saveMailProvider, mailVerifyCodeHtml, mailTestHtml,
} from './mail.js';
import { makeDbInit } from './schema.js';

const ensureDb = makeDbInit();

/* 首次使用预置管理员（幂等）：新部署无需任何配置即可登录管理后台
 * 用户名 iam（也可用 iam@stu.sibaihua.com 登录），密码默认 858308533，可用环境变量 SEED_ADMIN_PASSWORD 覆盖 */
async function seedAdmin(env) {
  if (await db.userByUsername(env, 'iam')) return;
  const seedPw = env.SEED_ADMIN_PASSWORD || '858308533';
  const salt = randomHex(16);
  await db.createUser(env, {
    username: 'iam',
    salt,
    passwordHash: await hashPassword(seedPw, salt),
    passwordEnc: await encryptPassword(env, seedPw),
    role: 'admin',
    englishName: 'Administrator',
    status: 'approved',
    emailAccount: `iam@${await mailDomain(env)}`,
    createdAt: new Date().toISOString(),
  });
  console.log('[seed] 已创建管理员账号 iam');
}

let readyPromise = null;
async function ensureReady(env) {
  if (!readyPromise) {
    readyPromise = (async () => {
      await ensureDb(env);
      await seedAdmin(env);
    })().catch((e) => {
      readyPromise = null; // 失败则下次请求重试
      throw e;
    });
  }
  await readyPromise;
}

/* ============================== 基础配置 ============================== */

const CONFIG = {
  appName: '司白画大学清迈分校“我的E校园”',
  smtpFromNameDefault: '司白画大学清迈分校 · 我的E校园',
  turnstileSiteKeyDefault: '0x4AAAAAAEWvmxLZVjDXieV9',
  turnstileSecretDefault: '0x4AAAAAAEWvm_-KpS9SUypKfVV_S-tgsdM',
  sessionTtlMs: 7 * 24 * 3600 * 1000,
  accessTokenTtlMs: 2 * 3600 * 1000,
  oauthCodeTtlMs: 5 * 60 * 1000,
  captchaTtlMs: 5 * 60 * 1000,
  emailCodeTtlMs: 10 * 60 * 1000,
  emailCodeCooldownMs: 60 * 1000,
  libraryUrlDefault: 'https://102007.xyz',
  libraryBasicUsernameDefault: 'sibaihua',
  libraryBasicPasswordDefault: 'sibaihua',
};

const RESERVED_USERNAMES = new Set([
  'admin', 'administrator', 'postmaster', 'root', 'abuse', 'webmaster',
  'support', 'info', 'mail', 'noreply', 'no-reply', 'sys', 'system', 'test',
]);
const USERNAME_RE = /^[a-z0-9]([a-z0-9._-]{0,28})[a-z0-9]$/;

/* ============================== 工具 ============================== */

class ApiError extends Error {
  constructor(status, message, data) {
    super(message);
    this.status = status;
    this.data = data;
  }
}

function randomHex(n) {
  const arr = new Uint8Array(n);
  crypto.getRandomValues(arr);
  return [...arr].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function json(status, obj, extraHeaders) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
      ...(extraHeaders || {}),
    },
  });
}

function ok(data, message) { return { status: 200, data, message: message || 'success' }; }

function normalizeUsername(raw) {
  return String(raw || '').trim().toLowerCase()
    .replace(/@stu\.sibaihua\.com$/, '')
    .replace(/@gayg\.de$/, '');
}

function usernameRuleError(username) {
  if (!USERNAME_RE.test(username) || username.length < 3) {
    return '用户名至少 3 位（最长 30 位），仅限字母/数字，可含 . _ - ，且以字母/数字开头结尾';
  }
  if (/^\d+$/.test(username)) return '用户名不能为纯数字，建议使用英文姓名或其简拼';
  if (RESERVED_USERNAMES.has(username)) return '该用户名为系统保留名';
  return null;
}

function publicUser(u) {
  return {
    id: u.id,
    username: u.username,
    role: u.role,
    englishName: u.englishName,
    contactEmail: u.contactEmail,
    emailVerified: !!u.emailVerified,
    status: u.status,
    emailAccount: u.emailAccount,
    campusEmail: `${u.username}@stu.sibaihua.com`,
    applyError: u.applyError,
    avatarUrl: u.avatarUrl || null,
    createdAt: u.createdAt,
    appliedAt: u.appliedAt,
  };
}

function bearerToken(request) {
  const m = /^Bearer\s+(.+)$/i.exec(request.headers.get('authorization') || '');
  return m ? m[1].trim() : null;
}

async function readBody(request) {
  const cl = parseInt(request.headers.get('content-length') || '0', 10);
  if (cl > 200 * 1024) throw new ApiError(400, '请求体过大');
  const text = await request.text().catch(() => '');
  if (!text) return {};
  try { return JSON.parse(text); } catch { throw new ApiError(400, '请求体不是合法的 JSON'); }
}

/* ============================== 设置 ============================== */

/* 校园邮箱域名固定为 stu.sibaihua.com；校园邮箱地址由「我的E校园」用户名推导为 username@stu.sibaihua.com。
   邮件系统域名为 mail.sibaihua.com，校园邮箱平台通过「我的E校园」OAuth 登录（首次登录后自动开通），因此不再需要校园邮箱管理员账号。
   仅入学申请已通过（status=approved）的用户可使用该 OAuth 授权；未申请或入学失败（status=failed）的用户将被拒绝。 */
const CAMPUS_EMAIL_DOMAIN = 'stu.sibaihua.com';
async function mailDomain() {
  return CAMPUS_EMAIL_DOMAIN;
}

async function getLibrarySettings(env) {
  return {
    url: (await db.getSetting(env, 'library_url')) || env.LIBRARY_URL || CONFIG.libraryUrlDefault,
    basicUsername: (await db.getSetting(env, 'library_basic_username')) || env.LIBRARY_BASIC_USERNAME || CONFIG.libraryBasicUsernameDefault,
    basicPassword: (await db.getSetting(env, 'library_basic_password')) || env.LIBRARY_BASIC_PASSWORD || CONFIG.libraryBasicPasswordDefault,
  };
}

function libraryAuthUrl(settings) {
  const raw = String(settings.url || '').trim();
  if (!raw) return '';
  const url = new URL(raw);
  const username = String(settings.basicUsername || '');
  const password = String(settings.basicPassword || '');
  if (username || password) {
    url.username = username;
    url.password = password;
  }
  return url.toString();
}

async function turnstileEnabled(env) {
  const raw = await db.getSetting(env, 'turnstile_enabled');
  if (raw === null || raw === undefined) return true;
  return raw !== '0';
}

/* ---------- 邮箱验证功能（可配置：auto / on / off） ----------
 * auto（默认）：仅当管理员已在后台配置过邮件服务（mail_provider_json 有 from）时才要求验证；
 * on：始终要求验证（未配置邮件服务时提示先配置）；
 * off：关闭邮箱验证，申请时直接填写联系邮箱即可。 */
async function emailVerifyMode(env) {
  const v = await db.getSetting(env, 'email_verify_mode');
  return v === 'on' || v === 'off' ? v : 'auto';
}

async function emailVerifyRequired(env) {
  const mode = await emailVerifyMode(env);
  if (mode === 'off') return false;
  if (mode === 'on') return true;
  // auto：看管理员是否已在后台配置过邮件服务
  const raw = await db.getSetting(env, 'mail_provider_json');
  if (!raw) return false;
  try {
    const p = JSON.parse(raw);
    return !!(p && p.from && p.provider);
  } catch {
    return false;
  }
}

async function verifyTurnstile(env, token, ip) {
  if (!(await turnstileEnabled(env))) return true;
  if (!token || typeof token !== 'string' || token.length > 2048) return false;
  try {
    const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET || CONFIG.turnstileSecretDefault,
        response: token,
        remoteip: ip || '',
      }),
    });
    const j = await res.json();
    return !!(j && j.success);
  } catch {
    return false;
  }
}

/* ============================== 会话 ============================== */

const SESSION_COOKIE = 'sib_session';

/* 从 Cookie 中读取会话令牌（前端会话使用 HttpOnly Cookie，JS 无法读取） */
function cookieToken(request) {
  const h = request.headers.get('cookie') || '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(h);
  return m ? decodeURIComponent(m[1]) : null;
}

/* 设置会话 Cookie：HttpOnly + Secure + SameSite=Lax，7 天有效期（与 sessionTtlMs 一致） */
function sessionCookieHeader(token) {
  const maxAge = Math.floor(CONFIG.sessionTtlMs / 1000);
  return `${SESSION_COOKIE}=${encodeURIComponent(token)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${maxAge}`;
}

/* 清除会话 Cookie */
function clearSessionCookieHeader() {
  return `${SESSION_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0`;
}

async function createSession(env, userId) {
  const token = randomHex(32);
  await db.createSession(env, token, userId, Date.now() + CONFIG.sessionTtlMs);
  return token;
}

async function getSessionUser(env, request) {
  // 优先 Authorization: Bearer（服务端接入方/API 客户端），其次 HttpOnly Cookie（浏览器前端会话）
  const token = bearerToken(request) || cookieToken(request);
  if (!token) return null;
  const s = await db.getSession(env, token);
  if (!s) return null;
  if (s.expires_at < Date.now()) { await db.deleteSession(env, token); return null; }
  return db.userById(env, s.user_id);
}

async function createAccessToken(env, userId, clientId) {
  const token = randomHex(32);
  await db.createOauthToken(env, token, userId, clientId, Date.now() + CONFIG.accessTokenTtlMs);
  return token;
}

/* ============================== 认证 ============================== */

async function hRegister(ctx) {
  const { body, env } = ctx;
  const tsOk = await verifyTurnstile(env, body.cfTurnstileToken, ctx.ip);
  if (!tsOk) throw new ApiError(400, '人机验证未通过，请完成验证后重试');
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  const err = usernameRuleError(username);
  if (err) throw new ApiError(400, err);
  if (await db.userByUsername(env, username)) throw new ApiError(409, '该用户名已被注册');
  if (password.length < 6 || password.length > 64) throw new ApiError(400, '密码长度需为 6-64 位');

  const salt = randomHex(16);
  const user = await db.createUser(env, {
    username,
    salt,
    passwordHash: await hashPassword(password, salt),
    passwordEnc: await encryptPassword(env, password),
    role: 'user',
    status: 'registered',
    createdAt: new Date().toISOString(),
  });
  const token = await createSession(env, user.id);
  return {
    status: 200,
    data: { token, user: publicUser(user) },
    message: '注册成功',
    headers: { 'Set-Cookie': sessionCookieHeader(token) },
  };
}

async function hLogin(ctx) {
  const { body, env } = ctx;
  const username = normalizeUsername(body.username);
  const user = await db.userByUsername(env, username);
  if (!user || !(await verifyPassword(String(body.password || ''), user.passwordHash))) {
    throw new ApiError(401, '用户名或密码错误');
  }
  const token = await createSession(env, user.id);
  return {
    status: 200,
    data: { token, user: publicUser(user) },
    message: '登录成功',
    headers: { 'Set-Cookie': sessionCookieHeader(token) },
  };
}

async function hMe(ctx) {
  return ok({ user: publicUser(ctx.user) });
}

async function hChangePassword(ctx) {
  const { body, env, user } = ctx;
  const oldPw = String(body.oldPassword || '');
  const newPw = String(body.newPassword || '');
  if (!(await verifyPassword(oldPw, user.passwordHash))) throw new ApiError(400, '原密码不正确');
  if (newPw.length < 6 || newPw.length > 64) throw new ApiError(400, '新密码长度需为 6-64 位');
  const salt = randomHex(16);
  await db.updateUser(env, user.id, {
    salt,
    passwordHash: await hashPassword(newPw, salt),
    passwordEnc: await encryptPassword(env, newPw),
  });
  return ok(null, '密码已修改（仅同步“我的E校园”登录密码，校园邮箱密码不受影响）');
}

/* ============================== 验证码 / 邮箱验证 / 入学申请 ============================== */

async function hCaptcha(ctx) {
  const { env } = ctx;
  const code = genCaptchaCode();
  const id = randomHex(16);
  await db.createCaptcha(env, id, code, Date.now() + CONFIG.captchaTtlMs);
  return ok({ captchaId: id, image: makeCaptchaSvg(code) });
}

async function hApplyStatus(ctx) {
  return ok({ user: publicUser(ctx.user) });
}

async function hLibraryLaunch(ctx) {
  const settings = await getLibrarySettings(ctx.env);
  let url;
  try {
    url = libraryAuthUrl(settings);
  } catch {
    throw new ApiError(500, '图书馆链接配置不正确，请联系管理员');
  }
  if (!/^https?:\/\//i.test(url)) throw new ApiError(500, '图书馆链接配置不正确，请联系管理员');
  return ok({ url });
}

/* 免验证模式下的联系邮箱更新（个人设置直接保存） */
async function hProfileContactEmail(ctx) {
  const { body, env, user } = ctx;
  const email = String(body.contactEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, '邮箱格式不正确');
  const updated = await db.updateUser(env, user.id, { contactEmail: email });
  return ok({ user: publicUser(updated) }, '联系邮箱已更新');
}

/* 个人资料更新（联系邮箱 + 头像链接，均为可选字段；提供即覆盖，空串表示清空） */
async function hProfileUpdate(ctx) {
  const { body, env, user } = ctx;
  const fields = {};
  if (body.contactEmail !== undefined) {
    const email = String(body.contactEmail || '').trim().toLowerCase();
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, '邮箱格式不正确');
    fields.contactEmail = email;
  }
  if (body.avatarUrl !== undefined) {
    const avatar = String(body.avatarUrl || '').trim();
    if (avatar && !/^https?:\/\//i.test(avatar)) throw new ApiError(400, '头像链接必须以 http(s):// 开头');
    if (avatar.length > 500) throw new ApiError(400, '头像链接过长');
    fields.avatarUrl = avatar || null;
  }
  if (!Object.keys(fields).length) throw new ApiError(400, '没有需要更新的字段');
  const updated = await db.updateUser(env, user.id, fields);
  return ok({ user: publicUser(updated) }, '个人资料已更新');
}

async function hVerifyEmailSend(ctx) {
  const { body, env, user } = ctx;
  const mode = await emailVerifyMode(env);
  if (mode === 'off') {
    throw new ApiError(400, '邮箱验证功能已关闭，无需验证（管理员可在后台开启）');
  }
  const email = String(body.email || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new ApiError(400, '邮箱格式不正确');
  const now = Date.now();
  const rec = await db.getEmailVerification(env, user.id);
  if (rec && rec.email === email && now - rec.lastSentAt < CONFIG.emailCodeCooldownMs) {
    const wait = Math.ceil((CONFIG.emailCodeCooldownMs - (now - rec.lastSentAt)) / 1000);
    throw new ApiError(429, `发送过于频繁，请 ${wait} 秒后再试`);
  }
  const code = String(Math.floor(100000 + Math.random() * 900000));
  await db.upsertEmailVerification(env, user.id, {
    email, code, expiresAt: now + CONFIG.emailCodeTtlMs, lastSentAt: now,
  });
  try {
    await sendMail(env, db, { to: email, subject: '【我的E校园】个人联系邮箱验证码', html: mailVerifyCodeHtml(code, 10) });
    return ok({ sentTo: email }, '验证码已发送，请查收邮件');
  } catch (e) {
    await db.deleteEmailVerification(env, user.id);
    throw new ApiError(502, `邮件发送失败：${e.message}`);
  }
}

async function hVerifyEmailConfirm(ctx) {
  const { body, env, user } = ctx;
  const email = String(body.email || '').trim().toLowerCase();
  const code = String(body.code || '').trim();
  const rec = await db.getEmailVerification(env, user.id);
  if (!rec || rec.expiresAt < Date.now()) {
    await db.deleteEmailVerification(env, user.id);
    throw new ApiError(400, '验证码已过期，请重新发送');
  }
  if (rec.email !== email || rec.code !== code) throw new ApiError(400, '验证码不正确');
  await db.deleteEmailVerification(env, user.id);
  await db.updateUser(env, user.id, { contactEmail: email, emailVerified: true });
  const fresh = await db.userById(env, user.id);
  return ok({ user: publicUser(fresh) }, '邮箱验证成功');
}

async function hApply(ctx) {
  const { body, env, user, ip } = ctx;
  const tsOk = await verifyTurnstile(env, body.cfTurnstileToken, ip);
  if (!tsOk) throw new ApiError(400, '人机验证未通过，请完成验证后重试');
  if (user.role === 'admin') throw new ApiError(400, '管理员账号无需申请入学');
  if (user.status === 'approved') return ok({ user: publicUser(user) }, '入学申请已通过，无需重复申请');

  const captchaId = String(body.captchaId || '');
  const cap = await db.getCaptcha(env, captchaId);
  await db.deleteCaptcha(env, captchaId);
  if (!cap || cap.expiresAt < Date.now()) throw new ApiError(400, '验证码已过期，请点击图片刷新后重试');
  if (String(body.captchaCode || '').trim().toUpperCase() !== cap.code) throw new ApiError(400, '验证码不正确');

  const englishName = String(body.englishName || '').trim();
  if (!/^[A-Za-z][A-Za-z .'\-]{1,59}$/.test(englishName)) {
    throw new ApiError(400, '请输入有效的英文姓名（仅英文字母，可含空格/连字符）');
  }
  const contactEmail = String(body.contactEmail || '').trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contactEmail)) throw new ApiError(400, '请输入有效的个人联系邮箱');
  // 邮箱验证为可选功能：开启时才要求已验证且一致；关闭/未配置时直接采用所填联系邮箱
  const needVerify = await emailVerifyRequired(env);
  if (needVerify) {
    if (user.emailVerified !== true || user.contactEmail !== contactEmail) {
      throw new ApiError(400, '请先完成个人联系邮箱验证（系统会向该邮箱发送验证码）');
    }
  }

  const emailAccount = `${user.username}@${await mailDomain(env)}`;
  const updated = await db.updateUser(env, user.id, {
    englishName,
    contactEmail,
    status: 'approved',
    emailAccount,
    applyError: null,
    appliedAt: new Date().toISOString(),
  });
  return ok({ user: publicUser(updated) }, '入学申请已通过');
}

/* ============================== 管理后台 ============================== */

function requireAdmin(user) {
  if (!user) throw new ApiError(401, '未登录或登录已过期');
  if (user.role !== 'admin') throw new ApiError(403, '需要管理员权限');
}

async function hAdminUsers(ctx) {
  requireAdmin(ctx.user);
  const users = (await db.listUsers(ctx.env)).map(publicUser);
  return ok({
    users,
    stats: {
      total: users.length,
      registered: users.filter((u) => u.status === 'registered').length,
      approved: users.filter((u) => u.status === 'approved').length,
      failed: users.filter((u) => u.status === 'failed').length,
    },
  });
}

async function hAdminUsersCreate(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  const username = normalizeUsername(body.username);
  const password = String(body.password || '');
  const err = usernameRuleError(username);
  if (err) throw new ApiError(400, err);
  if (await db.userByUsername(env, username)) throw new ApiError(409, '该用户名已被占用');
  if (password.length < 6 || password.length > 64) throw new ApiError(400, '密码长度需为 6-64 位');

  const salt = randomHex(16);
  const contactEmail = String(body.contactEmail || '').trim();
  const newUser = await db.createUser(env, {
    username,
    salt,
    passwordHash: await hashPassword(password, salt),
    passwordEnc: await encryptPassword(env, password),
    role: body.role === 'admin' ? 'admin' : 'user',
    englishName: String(body.englishName || '').trim(),
    contactEmail,
    emailVerified: !!contactEmail,
    status: 'registered',
    createdAt: new Date().toISOString(),
  });
  return ok({ user: publicUser(newUser) }, '用户已创建');
}

async function hAdminUsersUpdate(ctx) {
  requireAdmin(ctx.user);
  const { body, env, user: me } = ctx;
  const target = await db.userById(env, parseInt(body.id, 10));
  if (!target) throw new ApiError(404, '用户不存在');

  const fields = {};
  if (body.username !== undefined) {
    const username = normalizeUsername(body.username);
    if (username !== target.username) {
      const err = usernameRuleError(username);
      if (err) throw new ApiError(400, err);
      if (await db.userByUsername(env, username)) throw new ApiError(409, '该用户名已被占用');
      fields.username = username;
      if (target.emailAccount && target.emailAccount.includes('@')) {
        fields.emailAccount = `${username}@${CAMPUS_EMAIL_DOMAIN}`;
      }
    }
  }
  if (body.password) {
    const pw = String(body.password);
    if (pw.length < 6 || pw.length > 64) throw new ApiError(400, '密码长度需为 6-64 位');
    const salt = randomHex(16);
    fields.salt = salt;
    fields.passwordHash = await hashPassword(pw, salt);
    fields.passwordEnc = await encryptPassword(env, pw);
  }
  if (body.englishName !== undefined) fields.englishName = String(body.englishName || '').trim();
  if (body.contactEmail !== undefined) {
    const ce = String(body.contactEmail || '').trim();
    if (ce && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(ce)) throw new ApiError(400, '联系邮箱格式不正确');
    fields.contactEmail = ce;
    fields.emailVerified = !!ce;
  }
  if (body.role !== undefined) {
    const role = body.role === 'admin' ? 'admin' : 'user';
    if (target.id === me.id && role !== 'admin') throw new ApiError(400, '不能取消自己的管理员权限');
    fields.role = role;
  }
  if (body.status !== undefined) {
    const st = String(body.status);
    if (!['registered', 'approved', 'failed'].includes(st)) throw new ApiError(400, '无效的状态');
    fields.status = st;
    if (st === 'approved' && !target.emailAccount) {
      fields.emailAccount = `${target.username}@${CAMPUS_EMAIL_DOMAIN}`;
    }
  }
  if (body.emailAccount !== undefined) {
    fields.emailAccount = String(body.emailAccount || '').trim() || null;
  }
  if (body.avatarUrl !== undefined) {
    const avatar = String(body.avatarUrl || '').trim();
    if (avatar && !/^https?:\/\//i.test(avatar)) throw new ApiError(400, '头像链接必须以 http(s):// 开头');
    fields.avatarUrl = avatar || null;
  }
  const updated = await db.updateUser(env, target.id, fields);
  return ok({ user: publicUser(updated) }, '用户已更新');
}

async function hAdminUsersDelete(ctx) {
  requireAdmin(ctx.user);
  const { body, env, user: me } = ctx;
  const id = parseInt(body.id, 10);
  if (id === me.id) throw new ApiError(400, '不能删除自己的账号');
  const target = await db.userById(env, id);
  if (!target) throw new ApiError(404, '用户不存在');
  await db.deleteSessionsByUser(env, id);
  await db.deleteOauthTokensByUser(env, id);
  await db.deleteUser(env, id);
  return ok(null, '用户已删除');
}

/* ---------- 系统设置 ---------- */

async function hAdminSettingsGet(ctx) {
  requireAdmin(ctx.user);
  const mail = await getMailProvider(ctx.env, db);
  const library = await getLibrarySettings(ctx.env);
  return ok({
    campusEmailDomain: CAMPUS_EMAIL_DOMAIN,
    library: {
      url: library.url,
      basicUsername: library.basicUsername,
      hasBasicPassword: !!library.basicPassword,
    },
    turnstileEnabled: await turnstileEnabled(ctx.env),
    turnstileSiteKey: ctx.env.TURNSTILE_SITE_KEY || CONFIG.turnstileSiteKeyDefault,
    emailVerifyMode: await emailVerifyMode(ctx.env),
    emailVerifyEnabled: await emailVerifyRequired(ctx.env),
    mail: {
      provider: mail.provider,
      from: mail.from,
      fromName: mail.fromName,
      domain: mail.domain,
      hasApiKey: !!mail.apiKey,
    },
  });
}

async function hAdminSettingsSave(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  if (body.turnstileEnabled !== undefined) {
    const on = body.turnstileEnabled === true || body.turnstileEnabled === 'true' || body.turnstileEnabled === 1 || body.turnstileEnabled === '1';
    await db.setSetting(env, 'turnstile_enabled', on ? '1' : '0');
  }
  if (body.emailVerifyMode !== undefined) {
    const m = String(body.emailVerifyMode);
    if (['auto', 'on', 'off'].includes(m)) await db.setSetting(env, 'email_verify_mode', m);
  }
  if (body.libraryUrl !== undefined) {
    const libraryUrl = String(body.libraryUrl || '').trim();
    if (!/^https?:\/\//i.test(libraryUrl)) throw new ApiError(400, '图书馆链接必须以 http(s):// 开头');
    new URL(libraryUrl);
    await db.setSetting(env, 'library_url', libraryUrl);
  }
  if (body.libraryBasicUsername !== undefined) {
    const libraryBasicUsername = String(body.libraryBasicUsername || '').trim();
    if (libraryBasicUsername.length > 100) throw new ApiError(400, '图书馆 Basic 用户名过长');
    await db.setSetting(env, 'library_basic_username', libraryBasicUsername);
  }
  if (body.libraryBasicPassword !== undefined && String(body.libraryBasicPassword || '') !== '') {
    const libraryBasicPassword = String(body.libraryBasicPassword || '');
    if (libraryBasicPassword.length > 200) throw new ApiError(400, '图书馆 Basic 密码过长');
    await db.setSetting(env, 'library_basic_password', libraryBasicPassword);
  }
  return ok({
    campusEmailDomain: CAMPUS_EMAIL_DOMAIN,
    turnstileEnabled: await turnstileEnabled(env),
    emailVerifyMode: await emailVerifyMode(env),
  }, '设置已保存');
}

async function hPublicConfig(ctx) {
  const env = ctx.env;
  return ok({
    turnstileEnabled: await turnstileEnabled(env),
    turnstileSiteKey: env.TURNSTILE_SITE_KEY || CONFIG.turnstileSiteKeyDefault,
    emailVerifyMode: await emailVerifyMode(env),
    emailVerifyEnabled: await emailVerifyRequired(env),
  });
}

/* ---------- 邮件服务配置（替代原 SMTP） ---------- */

async function hAdminMailGet(ctx) {
  requireAdmin(ctx.user);
  return ok({ mail: await getMailProvider(ctx.env, db) });
}

async function hAdminMailSave(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  const provider = body.provider === 'custom' ? 'custom' : 'mailchannels';
  const from = String(body.from || '').trim();
  const fromName = String(body.fromName || '').trim();
  if (!from) throw new ApiError(400, '发件邮箱不能为空');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(from)) throw new ApiError(400, '发件邮箱格式不正确');
  const cur = await getMailProvider(env, db);
  const cfg = {
    provider,
    from,
    fromName,
    domain: from.split('@')[1] || '',
    apiKey: body.apiKey ? String(body.apiKey).trim() : cur.apiKey, // 留空不修改
  };
  await saveMailProvider(env, db, cfg);
  return ok({ mail: cfg }, '邮件服务配置已保存');
}

async function hAdminMailTest(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  const cur = await getMailProvider(env, db);
  const cfg = {
    provider: body.provider === 'custom' ? 'custom' : 'mailchannels',
    from: String(body.from || '').trim() || cur.from,
    fromName: String(body.fromName || '').trim() || cur.fromName,
    domain: (String(body.from || '').trim() || cur.from).split('@')[1] || '',
    apiKey: body.apiKey ? String(body.apiKey).trim() : cur.apiKey,
  };
  const to = String(body.to || '').trim() || cfg.from;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) throw new ApiError(400, '测试收件邮箱格式不正确');
  try {
    await sendMail(env, db, { to, subject: '【我的E校园】邮件服务测试', html: mailTestHtml(), cfgOverride: cfg });
    return ok({ sentTo: to }, `测试邮件已发送至 ${to}，请查收确认`);
  } catch (e) {
    throw new ApiError(502, `测试邮件发送失败：${e.message}`);
  }
}

/* ---------- OAuth 客户端管理 ---------- */

async function hAdminClientsList(ctx) {
  requireAdmin(ctx.user);
  return ok({ clients: await db.listOauthClients(ctx.env) });
}

async function hAdminClientsCreate(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  const name = String(body.name || '').trim();
  const redirectUri = String(body.redirectUri || '').trim();
  const logoUrl = String(body.logoUrl || '').trim();
  if (!name || name.length > 60) throw new ApiError(400, '请输入客户端名称（60 字以内）');
  if (redirectUri && !/^https?:\/\//i.test(redirectUri)) throw new ApiError(400, '回调地址必须是 http(s):// 开头的 URL');
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) throw new ApiError(400, 'Logo 链接必须是 http(s):// 开头的 URL');
  const client = {
    clientId: 'sib_' + randomHex(8),
    clientSecret: randomHex(24),
    name,
    redirectUri: redirectUri || '',
    logoUrl: logoUrl || '',
    createdAt: new Date().toISOString(),
  };
  const created = await db.createOauthClient(env, client);
  return ok({ client: created }, '客户端创建成功');
}

async function hAdminClientsUpdate(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  const clientId = String(body.clientId || '');
  const client = await db.oauthClientById(env, clientId);
  if (!client) throw new ApiError(404, '客户端不存在');
  const name = String(body.name || '').trim();
  const redirectUri = body.redirectUri === undefined ? client.redirectUri : String(body.redirectUri || '').trim();
  const logoUrl = body.logoUrl === undefined ? client.logoUrl : String(body.logoUrl || '').trim();
  if (name && name.length <= 60) {
    // 名称留空表示不修改
  }
  if (redirectUri && !/^https?:\/\//i.test(redirectUri)) {
    throw new ApiError(400, '回调地址必须是 http(s):// 开头的 URL');
  }
  if (logoUrl && !/^https?:\/\//i.test(logoUrl)) {
    throw new ApiError(400, 'Logo 链接必须是 http(s):// 开头的 URL');
  }
  const updated = await db.updateOauthClient(env, clientId, {
    name: name || client.name,
    redirectUri,
    logoUrl,
  });
  return ok({ client: updated }, '客户端已更新');
}

async function hAdminClientsDelete(ctx) {
  requireAdmin(ctx.user);
  const { body, env } = ctx;
  const clientId = String(body.clientId || '');
  const client = await db.oauthClientById(env, clientId);
  if (!client) throw new ApiError(404, '客户端不存在');
  await db.deleteOauthClient(env, clientId);
  return ok(null, '客户端已删除');
}

/* ============================== OAuth ============================== */

async function hOauthAuthorizeInfo(ctx) {
  const { query, env } = ctx;
  const clientId = query.get('client_id') || '';
  const redirectUri = query.get('redirect_uri') || '';
  const client = await db.oauthClientById(env, clientId);
  if (!client) throw new ApiError(400, '无效的 client_id，请先在“我的E校园”管理后台创建 OAuth 客户端');
  if (client.redirectUri && redirectUri !== client.redirectUri) {
    throw new ApiError(400, 'redirect_uri 与客户端登记的回调地址不一致');
  }
  if (!/^https?:\/\//i.test(redirectUri)) throw new ApiError(400, 'redirect_uri 必须是合法的 http(s) URL');
  return ok({ client: { name: client.name, clientId: client.clientId, logoUrl: client.logoUrl || '' }, redirectUri });
}

async function hOauthAuthorizeConfirm(ctx) {
  const { body, env, user } = ctx;
  // 仅入学申请已通过（已录取）的用户可使用校园邮箱 OAuth 授权；
  // 未申请入学或入学失败（status=failed）的用户不允许使用。
  if (user.status !== 'approved') {
    throw new ApiError(403, '仅入学申请已通过（已录取）的用户可使用校园邮箱 OAuth 授权；未申请入学或入学失败的用户不可使用');
  }
  const client = await db.oauthClientById(env, String(body.clientId || ''));
  const redirectUri = String(body.redirectUri || '');
  const codeChallenge = String(body.codeChallenge || '').trim();
  const codeChallengeMethod = String(body.codeChallengeMethod || '').trim();
  if (!client) throw new ApiError(400, '无效的 client_id');
  if (client.redirectUri && redirectUri !== client.redirectUri) {
    throw new ApiError(400, 'redirect_uri 与客户端登记的回调地址不一致');
  }
  if (!/^https?:\/\//i.test(redirectUri)) throw new ApiError(400, 'redirect_uri 必须是合法的 http(s) URL');
  if (codeChallenge && !codeChallengeMethod) throw new ApiError(400, '使用 PKCE 时必须提交 code_challenge_method=S256');
  if (codeChallengeMethod && codeChallengeMethod.toUpperCase() !== 'S256') throw new ApiError(400, 'code_challenge_method 仅支持 S256');
  if (codeChallengeMethod && !codeChallenge) throw new ApiError(400, '使用 PKCE 时必须提交 code_challenge');

  const code = randomHex(16);
  await db.createOauthCode(env, code, {
    userId: user.id,
    clientId: client.clientId,
    redirectUri,
    codeChallenge,
    codeChallengeMethod: codeChallenge ? 'S256' : '',
    expiresAt: Date.now() + CONFIG.oauthCodeTtlMs,
  });
  const sep = redirectUri.includes('?') ? '&' : '?';
  return ok({ redirect: `${redirectUri}${sep}code=${code}&state=${encodeURIComponent(String(body.state || ''))}` });
}

function timingSafeEqual(aText, bText) {
  const a = new TextEncoder().encode(String(aText || ''));
  const b = new TextEncoder().encode(String(bText || ''));
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function clientSecretOk(client, secret) {
  return !!client && timingSafeEqual(client.clientSecret, secret);
}

function base64Url(bytes) {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

async function pkceChallenge(verifier) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

async function hOauthToken(ctx) {
  const { body, env } = ctx;
  const grant = String(body.grant_type || '');
  const client = await db.oauthClientById(env, String(body.client_id || ''));
  if (!client) throw new ApiError(401, 'client_id 无效');

  if (grant === 'password') {
    if (!clientSecretOk(client, String(body.client_secret || ''))) {
      throw new ApiError(401, 'client_id 或 client_secret 无效');
    }
    const username = normalizeUsername(body.username);
    const user = await db.userByUsername(env, username);
    if (!user || !(await verifyPassword(String(body.password || ''), user.passwordHash))) {
      throw new ApiError(401, '用户名或密码错误');
    }
    // 仅入学申请已通过（已录取）的用户可使用校园邮箱 OAuth 授权
    if (user.status !== 'approved') {
      throw new ApiError(403, '仅入学申请已通过（已录取）的用户可使用校园邮箱 OAuth 授权；未申请入学或入学失败的用户不可使用');
    }
    const token = await createAccessToken(env, user.id, client.clientId);
    return ok({
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(CONFIG.accessTokenTtlMs / 1000),
      scope: 'userinfo',
    });
  }

  if (grant === 'authorization_code') {
    const code = String(body.code || '');
    const rec = await db.getOauthCode(env, code);
    if (!rec || rec.expiresAt < Date.now()) throw new ApiError(400, '授权码无效或已过期');
    if (rec.clientId !== client.clientId) throw new ApiError(400, '授权码与客户端不匹配');
    if (rec.redirectUri !== String(body.redirect_uri || '')) throw new ApiError(400, 'redirect_uri 与授权时不一致');

    if (rec.codeChallenge) {
      const verifier = String(body.code_verifier || '');
      if (!verifier) throw new ApiError(400, 'PKCE 模式必须提交 code_verifier');
      if ((rec.codeChallengeMethod || '').toUpperCase() !== 'S256') throw new ApiError(400, '不支持的 code_challenge_method');
      const expected = await pkceChallenge(verifier);
      if (!timingSafeEqual(expected, rec.codeChallenge)) throw new ApiError(401, 'code_verifier 校验失败');
    } else if (!clientSecretOk(client, String(body.client_secret || ''))) {
      throw new ApiError(401, '未使用 PKCE 的授权码模式必须提交有效 client_secret');
    }

    await db.deleteOauthCode(env, code);
    const token = await createAccessToken(env, rec.userId, client.clientId);
    return ok({
      access_token: token,
      token_type: 'Bearer',
      expires_in: Math.floor(CONFIG.accessTokenTtlMs / 1000),
      scope: 'userinfo',
    });
  }

  throw new ApiError(400, '不支持的 grant_type，仅支持 password / authorization_code');
}

async function hOauthUserinfo(ctx) {
  const token = bearerToken(ctx.request);
  const rec = token ? await db.getOauthToken(ctx.env, token) : null;
  if (!rec || rec.expires_at < Date.now()) throw new ApiError(401, '无效或已过期的 access_token');
  const user = await db.userById(ctx.env, rec.user_id);
  if (!user) throw new ApiError(401, 'access_token 对应的用户不存在');
  return ok({
    id: user.id,
    username: user.username,
    email: `${user.username}@${CAMPUS_EMAIL_DOMAIN}`,
    englishName: user.englishName,
    contactEmail: user.contactEmail,
    role: user.role,
    status: user.status,
    createdAt: user.createdAt,
  });
}

/* ============================== API 文档 ============================== */

async function apiDocs(ctx) {
  const base = ctx.env.SITE_URL || `https://${ctx.request.headers.get('host') || 'localhost'}`;
  const domain = await mailDomain(ctx.env);
  return ok({
    baseUrl: base,
    mailDomain: domain,
    updatedAt: new Date().toISOString(),
    aiIntegrationNote: `本接口文档面向其他 AI 助手或智能体。如果你是代表某个校园系统（选课、图书馆、门户等）接入“我的E校园”的 AI，请按以下步骤操作：

1. 由系统管理员在“我的E校园”管理后台「OAuth 客户端」页面创建客户端，获取 client_id 与 client_secret。
2. 管理员可通过 PUT /api/admin/oauth-clients 修改该客户端的回调地址 redirect_uri。
3. 如果接入方是可信任的第一方服务端系统，可以使用 password 模式，并在服务端保存 client_secret。
4. 如果接入方包含浏览器前端，必须使用授权码模式 + PKCE：前端只使用 client_id；前端生成 code_verifier；前端根据 code_verifier 计算 code_challenge；授权请求携带 code_challenge 和 code_challenge_method=S256；换取 token 时提交 code_verifier；不得把 client_secret 写入浏览器前端代码。
5. 使用 access_token 调用 /api/oauth/userinfo 获取用户身份。所有受保护接口均在 Authorization 请求头中携带 Bearer <token>。
6. 注意：access_token 有效期 2 小时；授权码 5 分钟且一次性；本系统所有 JSON 响应均包含 code / message / data 字段，code 为 200 表示成功。`, 
    groups: [
      {
        title: '一、OAuth 2.0 统一账号接入接口（供其他校园系统使用）',
        desc: '其他校园系统可通过标准 OAuth 2.0 流程接入本系统账号体系。AI 助手在集成时，应引导调用方先完成客户端创建与回调地址配置。',
        items: [
          { method: 'POST', path: '/api/oauth/token', desc: '获取 Access Token。密码模式仅适合可信任的第一方服务端系统；浏览器前端应使用授权码模式 + PKCE。', params: [
            { name: 'grant_type', type: 'string', required: '是', desc: 'password 或 authorization_code' },
            { name: 'client_id', type: 'string', required: '是', desc: '客户端 ID' },
            { name: 'client_secret', type: 'string', required: 'password 模式必填；未使用 PKCE 的服务端授权码模式必填', desc: '客户端密钥，不得写入浏览器前端' },
            { name: 'username', type: 'string', required: 'password 模式必填', desc: '用户名' },
            { name: 'password', type: 'string', required: 'password 模式必填', desc: '用户密码' },
            { name: 'code', type: 'string', required: 'authorization_code 模式必填', desc: '授权码' },
            { name: 'redirect_uri', type: 'string', required: 'authorization_code 模式必填', desc: '必须与授权请求一致' },
            { name: 'code_verifier', type: 'string', required: 'PKCE 模式必填', desc: '与 code_challenge 对应的 verifier' },
          ], example: `PKCE 换 token 示例：\ncurl -X POST ${base}/api/oauth/token \\\n  -H "Content-Type: application/json" \\\n  -d '{\n    "grant_type": "authorization_code",\n    "client_id": "sib_xxx",\n    "code": "回调中收到的授权码",\n    "redirect_uri": "https://portal.example.com/callback",\n    "code_verifier": "前端保存的 PKCE verifier"\n  }'`, response: '{\n  "code": 200,\n  "message": "success",\n  "data": {\n    "access_token": "3f9c...（64位十六进制）",\n    "token_type": "Bearer",\n    "expires_in": 7200,\n    "scope": "userinfo"\n  }\n}' },
          { method: 'GET', path: '/oauth?response_type=code&client_id=...&redirect_uri=...&state=...&code_challenge=...&code_challenge_method=S256', desc: '授权码模式第 1 步：将用户浏览器重定向到此授权页。浏览器前端使用授权码模式时，必须携带 PKCE 参数。用户登录并确认授权后，浏览器会携带 code 与 state 参数跳回 redirect_uri。', params: [
            { name: 'response_type', type: 'string', required: '是', desc: '固定为 code' },
            { name: 'client_id', type: 'string', required: '是', desc: '客户端 ID' },
            { name: 'redirect_uri', type: 'string', required: '是', desc: '回调地址' },
            { name: 'state', type: 'string', required: '建议必填', desc: '防 CSRF 随机串' },
            { name: 'code_challenge', type: 'string', required: '浏览器前端必填', desc: '由 code_verifier 计算得到' },
            { name: 'code_challenge_method', type: 'string', required: '浏览器前端必填', desc: '固定为 S256' },
          ], example: `${base}/oauth\n  ?response_type=code\n  &client_id=sib_xxx\n  &redirect_uri=${encodeURIComponent('https://portal.example.com/callback')}\n  &state=xyz\n  &code_challenge=xxxxx\n  &code_challenge_method=S256`, response: '用户确认授权后浏览器跳转到：\nhttps://portal.example.com/callback?code=8a1b...&state=xyz' },
          { method: 'GET', path: '/api/oauth/userinfo', desc: '凭 Access Token 获取当前授权用户的基本信息。AI 助手在拿到 access_token 后应调用此接口完成登录态映射。', headers: 'Authorization: Bearer <access_token>', example: `curl ${base}/api/oauth/userinfo -H "Authorization: Bearer <access_token>"`, response: '{\n  "code": 200,\n  "message": "success",\n  "data": {\n    "id": 2,\n    "username": "zhangsan",\n    "email": "zhangsan@stu.sibaihua.com",\n    "englishName": "San Zhang",\n    "contactEmail": "zhangsan@gmail.com",\n    "role": "user",\n    "status": "approved"\n  }\n}' },
          { method: 'GET', path: '/api/oauth/authorize/info', desc: '授权页预检接口。AI 助手可在引导用户跳转前先调用此接口，验证 client_id 与 redirect_uri 是否有效，并获取客户端名称用于展示。', params: [
            { name: 'client_id', type: 'string', required: '是', desc: '客户端 ID' },
            { name: 'redirect_uri', type: 'string', required: '是', desc: '回调地址' },
          ], response: '{ "code": 200, "data": { "client": { "name": "...", "clientId": "..." }, "redirectUri": "..." } }' },
        ],
      },
      {
        title: '二、“我的E校园”内部接口',
        desc: '本系统前端的注册、登录、验证码与入学申请均基于以下接口。AI 助手若需替用户完成批量或自动化操作，可直接调用；注意入学申请接口需要图形验证码。',
        items: [
          { method: 'POST', path: '/api/auth/register', desc: '注册“我的E校园”账号。注册成功后默认状态为 registered，可继续完成个人联系邮箱验证并调用 /api/apply 提交入学申请。入学审核通过后，校园邮箱地址即为 <用户名>@stu.sibaihua.com，但不会立即开通；需前往校园邮箱平台（mail.sibaihua.com）使用「我的E校园」账号完成 OAuth 登录后自动开通。注意：仅入学已通过（status=approved）的用户可使用校园邮箱 OAuth 授权，未申请入学或入学失败（status=failed）的用户将被拒绝。若管理后台开启 Turnstile 人机验证，则需附带 cfTurnstileToken。', params: [
            { name: 'cfTurnstileToken', type: 'string', required: '开关开启时', desc: 'Cloudflare Turnstile 前端小部件返回的 token（管理后台「系统设置」可开关）' },
            { name: 'username', type: 'string', required: '是', desc: '至少 3 位（最长 30 位），仅限字母/数字，可含 . _ -，且以字母/数字开头结尾，不能为纯数字，建议使用英文姓名或其简拼；即校园邮箱 username@stu.sibaihua.com 的前缀' },
            { name: 'password', type: 'string', required: '是', desc: '6-64 位；用于「我的E校园」登录（校园邮箱通过 OAuth 登录，无需单独密码）' },
          ], response: '{ "code": 200, "data": { "token": "会话令牌", "user": { "id": 3, "username": "zhangsan", "status": "registered", ... } } }' },
          { method: 'POST', path: '/api/auth/login', desc: '登录并获取会话令牌。用户名可输入 "zhangsan" 或 "zhangsan@stu.sibaihua.com"，效果相同。登录不需要人机验证。', params: [
            { name: 'username', type: 'string', required: '是', desc: '用户名（自动忽略 @stu.sibaihua.com 后缀）' },
            { name: 'password', type: 'string', required: '是', desc: '密码' },
          ], response: '{ "code": 200, "data": { "token": "会话令牌", "user": { ... } } }' },
          { method: 'GET', path: '/api/auth/me', desc: '获取当前登录用户信息。会话令牌通过 Authorization: Bearer <token> 传递。', headers: 'Authorization: Bearer <会话令牌>', response: '{ "code": 200, "data": { "user": { ... } } }' },
          { method: 'POST', path: '/api/verify-email/send', desc: '向指定的个人联系邮箱发送 6 位数字验证码（通过邮件服务）。AI 助手在代用户操作时，应引导用户本人接收并输入验证码，不要代填。', headers: 'Authorization: Bearer <会话令牌>', params: [
            { name: 'email', type: 'string', required: '是', desc: '要验证的个人联系邮箱' },
          ], response: '{ "code": 200, "message": "验证码已发送，请查收邮件", "data": { "sentTo": "zhangsan@gmail.com" } }' },
          { method: 'POST', path: '/api/verify-email/confirm', desc: '提交邮箱验证码完成验证。验证成功后该邮箱即被记录为用户的个人联系邮箱（contactEmail），也是提交入学申请的前置条件。', headers: 'Authorization: Bearer <会话令牌>', params: [
            { name: 'email', type: 'string', required: '是', desc: '与发送验证码时一致的邮箱' },
            { name: 'code', type: 'string', required: '是', desc: '邮件中收到的 6 位验证码' },
          ], response: '{ "code": 200, "message": "邮箱验证成功", "data": { "user": { "emailVerified": true, ... } } }' },
          { method: 'POST', path: '/api/auth/change-password', desc: '修改“我的E校园”登录密码。校园邮箱通过「我的E校园」OAuth 登录，无需单独密码，因此此处仅影响「我的E校园」登录。', headers: 'Authorization: Bearer <会话令牌>', params: [
            { name: 'oldPassword', type: 'string', required: '是', desc: '原登录密码' },
            { name: 'newPassword', type: 'string', required: '是', desc: '新密码 6-64 位' },
          ], response: '{ "code": 200, "message": "密码已修改（仅同步“我的E校园”登录密码，校园邮箱密码不受影响）" }' },
          { method: 'GET', path: '/api/captcha', desc: '获取图形验证码。返回 SVG 图形与 captchaId，5 分钟有效、一次性使用。调用 /api/apply 前必须先获取并让用户识别验证码。', response: '{ "code": 200, "data": { "captchaId": "uuid", "image": "<svg ...>" } }' },
          { method: 'POST', path: '/api/apply', desc: '提交入学申请。前置条件：个人联系邮箱已通过 /api/verify-email/* 完成验证（emailVerified=true）。验证码校验通过后自动录取（status=approved）。录取后校园邮箱地址即为 <用户名>@stu.sibaihua.com，但不会立即开通；需前往校园邮箱平台（mail.sibaihua.com）使用「我的E校园」账号完成 OAuth 登录后才会自动开通。', headers: 'Authorization: Bearer <会话令牌>', params: [
            { name: 'cfTurnstileToken', type: 'string', required: '开关开启时', desc: 'Cloudflare Turnstile token（管理后台「系统设置」可开关）' },
            { name: 'englishName', type: 'string', required: '是', desc: '英文姓名，2-60 位英文字母（可含空格、连字符、单引号、点）' },
            { name: 'contactEmail', type: 'string', required: '是', desc: '个人联系邮箱（任意域名均可），必须与已验证的邮箱完全一致' },
            { name: 'captchaId', type: 'string', required: '是', desc: '图形验证码 ID' },
            { name: 'captchaCode', type: 'string', required: '是', desc: '图形验证码字符（不区分大小写）' },
          ], response: '{ "code": 200, "message": "入学申请已通过", "data": { "user": { "status": "approved", "campusEmail": "zhangsan@stu.sibaihua.com", ... } } }' },
          { method: 'GET', path: '/api/application/status', desc: '查询当前用户入学申请状态。', headers: 'Authorization: Bearer <会话令牌>', response: '{ "code": 200, "data": { "user": { "status": "approved", "campusEmail": "zhangsan@stu.sibaihua.com", ... } } }' },
          { method: 'GET', path: '/api/health', desc: '健康检查。', response: '{ "code": 200, "data": { "app": "司白画大学清迈分校“我的E校园”", "time": "..." } }' },
        ],
      },
      {
        title: '三、管理员接口（仅管理员账号可调用）',
        desc: '用于管理用户（查询/创建/编辑/删除）、OAuth 客户端与系统设置。AI 助手在帮管理员操作时，应始终携带管理员会话令牌。',
        items: [
          { method: 'GET', path: '/api/admin/users', desc: '获取所有用户列表与统计信息。', headers: 'Authorization: Bearer <管理员会话令牌>', response: '{ "code": 200, "data": { "users": [...], "stats": { "total": 10, "registered": 3, "approved": 6, "failed": 1 } } }' },
          { method: 'POST', path: '/api/admin/users', desc: '由管理员直接创建用户（不经过注册流程，用户需自行通过「我的E校园」OAuth 登录后校园邮箱才会开通）。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'username', type: 'string', required: '是', desc: '用户名，规则同注册' },
            { name: 'password', type: 'string', required: '是', desc: '密码 6-64 位' },
            { name: 'role', type: 'string', required: '否', desc: 'user（默认）或 admin' },
            { name: 'englishName', type: 'string', required: '否', desc: '英文姓名' },
            { name: 'contactEmail', type: 'string', required: '否', desc: '联系邮箱' },
          ], response: '{ "code": 200, "message": "用户已创建", "data": { "user": { ... } } }' },
          { method: 'PUT', path: '/api/admin/users', desc: '编辑用户。所有字段均可选，只传需要修改的。校园邮箱由用户名推导为 <用户名>@stu.sibaihua.com（使用「我的E校园」OAuth 登录后自动开通，故修改用户名会同步更新该推导值）；修改密码只更新「我的E校园」登录密码（哈希与密文），不影响校园邮箱的 OAuth 登录。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'id', type: 'integer', required: '是', desc: '用户 ID' },
            { name: 'username', type: 'string', required: '否', desc: '新用户名（不能与现有用户重复）' },
            { name: 'password', type: 'string', required: '否', desc: '新密码（6-64 位，不传或空则不修改）' },
            { name: 'englishName', type: 'string', required: '否', desc: '英文姓名' },
            { name: 'contactEmail', type: 'string', required: '否', desc: '联系邮箱' },
            { name: 'role', type: 'string', required: '否', desc: 'user 或 admin；不能取消自己的管理员权限' },
            { name: 'status', type: 'string', required: '否', desc: 'registered / approved / failed' },
            { name: 'emailAccount', type: 'string', required: '否', desc: '手动修正校园邮箱地址' },
          ], response: '{ "code": 200, "message": "用户已更新", "data": { "user": { ... } } }' },
          { method: 'DELETE', path: '/api/admin/users', desc: '删除用户，并清理其所有登录会话与 OAuth 令牌。不能删除自己的账号。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'id', type: 'integer', required: '是', desc: '用户 ID' },
          ], response: '{ "code": 200, "message": "用户已删除", "data": null }' },
          { method: 'GET', path: '/api/admin/settings', desc: '获取系统设置：Turnstile 人机验证开关、校园邮箱域名、图书馆入口、邮件服务配置（API Key 不返回明文）。', headers: 'Authorization: Bearer <管理员会话令牌>', response: '{ "code": 200, "data": { "campusEmailDomain": "stu.sibaihua.com", "turnstileEnabled": true, "turnstileSiteKey": "0x4A...", "mail": { "provider": "mailchannels", "from": "...", "hasApiKey": true } } }' },
          { method: 'POST', path: '/api/admin/settings', desc: '保存系统设置：Cloudflare Turnstile 人机验证开关、邮箱验证模式、图书馆入口（含 Basic 认证用户名/密码）。校园邮箱无需配置（由用户名推导为 username@stu.sibaihua.com，校园邮箱通过「我的E校园」OAuth 登录）。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'turnstileEnabled', type: 'boolean', required: '否', desc: 'true=开启人机验证（默认），false=关闭；留空表示不修改' },
            { name: 'emailVerifyMode', type: 'string', required: '否', desc: 'auto / on / off；留空表示不修改' },
            { name: 'libraryUrl', type: 'string', required: '否', desc: '校园图书馆入口链接（http(s)）' },
            { name: 'libraryBasicUsername', type: 'string', required: '否', desc: '图书馆 Basic 认证用户名' },
            { name: 'libraryBasicPassword', type: 'string', required: '否', desc: '图书馆 Basic 认证密码（留空 = 不修改）' },
          ], response: '{ "code": 200, "data": { "campusEmailDomain": "stu.sibaihua.com", "turnstileEnabled": true } }' },
          { method: 'POST', path: '/api/admin/settings/mail', desc: '保存邮件服务配置（MailChannels 通道，用于个人联系邮箱验证发信）。API Key 留空表示不修改。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'provider', type: 'string', required: '否', desc: '固定值：mailchannels（默认）' },
            { name: 'from', type: 'string', required: '是', desc: '发件邮箱地址（需在 MailChannels 验证过的域名下）' },
            { name: 'fromName', type: 'string', required: '否', desc: '发件人显示名称' },
            { name: 'apiKey', type: 'string', required: '否', desc: 'MailChannels API Key（留空 = 不修改）' },
          ], response: '{ "code": 200, "message": "邮件服务配置已保存", "data": { "mail": { ... } } }' },
          { method: 'POST', path: '/api/admin/settings/test-mail', desc: '使用提交的（或已保存的）邮件服务配置向指定邮箱发送一封测试邮件，用于验证连通性。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'to', type: 'string', required: '否', desc: '测试收件邮箱，缺省发送到发件邮箱本身' },
            { name: 'from', type: 'string', required: '否', desc: '覆盖测试用的发件邮箱（不保存）' },
            { name: 'fromName', type: 'string', required: '否', desc: '覆盖发件人名称' },
            { name: 'apiKey', type: 'string', required: '否', desc: '覆盖 API Key' },
          ], response: '{ "code": 200, "message": "测试邮件已发送至 xxx，请查收确认", "data": { "sentTo": "xxx" } }' },
          { method: 'GET', path: '/api/admin/oauth-clients', desc: '获取所有 OAuth 客户端列表。', headers: 'Authorization: Bearer <管理员会话令牌>', response: '{ "code": 200, "data": { "clients": [{ "id": 1, "clientId": "sib_xxx", "clientSecret": "...", "name": "...", "redirectUri": "...", ... }] } }' },
          { method: 'POST', path: '/api/admin/oauth-clients', desc: '创建新的 OAuth 客户端。创建时会自动生成 client_id 与 client_secret。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'name', type: 'string', required: '是', desc: '客户端名称，如图书馆管理系统' },
            { name: 'redirectUri', type: 'string', required: '否', desc: '回调地址，必须以 http:// 或 https:// 开头' },
          ], response: '{ "code": 200, "message": "客户端创建成功", "data": { "client": { ... } } }' },
          { method: 'PUT', path: '/api/admin/oauth-clients', desc: '修改 OAuth 客户端的名称和/或回调地址。如需更换回调地址，调用此接口即可，无需删除重建。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'clientId', type: 'string', required: '是', desc: '要修改的客户端 ID' },
            { name: 'name', type: 'string', required: '否', desc: '新的客户端名称' },
            { name: 'redirectUri', type: 'string', required: '否', desc: '新的回调地址，必须以 http:// 或 https:// 开头' },
          ], response: '{ "code": 200, "message": "客户端已更新", "data": { "client": { ... } } }' },
          { method: 'DELETE', path: '/api/admin/oauth-clients', desc: '删除 OAuth 客户端。删除后使用该客户端的所有系统将无法继续接入。', headers: 'Authorization: Bearer <管理员会话令牌>', params: [
            { name: 'clientId', type: 'string', required: '是', desc: '要删除的客户端 ID' },
          ], response: '{ "code": 200, "message": "客户端已删除", "data": null }' },
        ],
      },
    ],
  });
}

/* ============================== 路由 ============================== */

const routes = [
  ['GET', /^\/api\/health$/, async (ctx) => ok({ app: CONFIG.appName, time: new Date().toISOString() })],
  ['GET', /^\/api\/docs$/, apiDocs],
  ['GET', /^\/api\/config\/public$/, hPublicConfig],

  ['POST', /^\/api\/auth\/register$/, hRegister],
  ['POST', /^\/api\/auth\/login$/, hLogin],
  ['POST', /^\/api\/auth\/logout$/, async (ctx) => {
    const token = bearerToken(ctx.request) || cookieToken(ctx.request);
    if (token) await db.deleteSession(ctx.env, token);
    return { status: 200, data: null, message: '已退出登录', headers: { 'Set-Cookie': clearSessionCookieHeader() } };
  }],
  ['GET', /^\/api\/auth\/me$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hMe(ctx);
  }],
  ['POST', /^\/api\/auth\/change-password$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hChangePassword(ctx);
  }],

  ['GET', /^\/api\/captcha$/, hCaptcha],
  ['POST', /^\/api\/verify-email\/send$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hVerifyEmailSend(ctx);
  }],
  ['POST', /^\/api\/verify-email\/confirm$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hVerifyEmailConfirm(ctx);
  }],
  ['POST', /^\/api\/apply$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hApply(ctx);
  }],
  ['GET', /^\/api\/library\/launch$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hLibraryLaunch(ctx);
  }],
  ['GET', /^\/api\/application\/status$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hApplyStatus(ctx);
  }],
  ['POST', /^\/api\/profile\/contact-email$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hProfileContactEmail(ctx);
  }],
  ['POST', /^\/api\/profile\/update$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hProfileUpdate(ctx);
  }],

  ['GET', /^\/api\/admin\/users$/, hAdminUsers],
  ['POST', /^\/api\/admin\/users$/, hAdminUsersCreate],
  ['PUT', /^\/api\/admin\/users$/, hAdminUsersUpdate],
  ['DELETE', /^\/api\/admin\/users$/, hAdminUsersDelete],
  ['GET', /^\/api\/admin\/settings$/, hAdminSettingsGet],
  ['POST', /^\/api\/admin\/settings$/, hAdminSettingsSave],
  ['POST', /^\/api\/admin\/settings\/mail$/, hAdminMailSave],
  ['POST', /^\/api\/admin\/settings\/test-mail$/, hAdminMailTest],
  ['GET', /^\/api\/admin\/oauth-clients$/, hAdminClientsList],
  ['POST', /^\/api\/admin\/oauth-clients$/, hAdminClientsCreate],
  ['PUT', /^\/api\/admin\/oauth-clients$/, hAdminClientsUpdate],
  ['DELETE', /^\/api\/admin\/oauth-clients$/, hAdminClientsDelete],

  ['GET', /^\/api\/oauth\/authorize\/info$/, hOauthAuthorizeInfo],
  ['POST', /^\/api\/oauth\/authorize$/, async (ctx) => {
    if (!ctx.user) throw new ApiError(401, '未登录或登录已过期');
    return hOauthAuthorizeConfirm(ctx);
  }],
  ['POST', /^\/api\/oauth\/token$/, hOauthToken],
  ['GET', /^\/api\/oauth\/userinfo$/, hOauthUserinfo],
];

/* ============================== Worker 入口 ============================== */

const PAGE_ROUTES = {
  '/': '/index.html',
  '/app': '/app.html',
  '/admin': '/admin.html',
  '/oauth': '/oauth.html',
};

async function serveAsset(env, url) {
  const assetPath = PAGE_ROUTES[url.pathname] || url.pathname;
  const assetUrl = new URL(assetPath, url.origin);
  const resp = await env.ASSETS.fetch(assetUrl);
  if (resp.status === 404 && assetPath === '/favicon.ico') {
    return new Response(null, { status: 204 });
  }
  return resp;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type,Authorization',
        },
      });
    }

    if (url.pathname.startsWith('/api/')) {
      let body = {};
      if (['POST', 'PUT', 'DELETE'].includes(request.method)) {
        try { body = await readBody(request); } catch (e) {
          if (e instanceof ApiError) return json(e.status, { code: e.status, message: e.message, data: null });
          throw e;
        }
      }
      // 自动初始化 D1 表结构 + 预置管理员（幂等；健康检查除外，便于无绑定部署时也能探活）
      if (url.pathname !== '/api/health') {
        try {
          await ensureReady(env);
        } catch (e) {
          return json(503, { code: 503, message: e.message || '数据库未就绪', data: null });
        }
      }
      const ctx = {
        request,
        url,
        body,
        query: url.searchParams,
        env,
        user: await getSessionUser(env, request),
        ip: request.headers.get('CF-Connecting-IP') || '',
      };
      try {
        for (const [method, re, handler] of routes) {
          if (request.method === method && re.test(url.pathname)) {
            const r = await handler(ctx);
            return json(r.status || 200, { code: r.status || 200, message: r.message || 'success', data: r.data === undefined ? null : r.data }, r.headers);
          }
        }
        return json(404, { code: 404, message: `接口不存在: ${request.method} ${url.pathname}`, data: null });
      } catch (e) {
        if (e instanceof ApiError) {
          return json(e.status, { code: e.status, message: e.message, data: e.data === undefined ? null : e.data });
        }
        console.error('[worker]', e);
        return json(500, { code: 500, message: '服务器内部错误', data: null });
      }
    }

    try {
      return await serveAsset(env, url);
    } catch (e) {
      console.error('[assets]', e);
      return json(500, { code: 500, message: '静态资源服务失败', data: null });
    }
  },
};
