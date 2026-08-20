/**
 * 密码学工具（Web Crypto，Cloudflare Worker 兼容）
 *  - 密码哈希：PBKDF2-SHA256（格式 pbkdf2$iter$saltHex$hashHex），替代 Node scrypt
 *  - 密码可逆加密：AES-256-GCM，密钥由 PBKDF2(SECRET, 'admission-pw-enc-v2') 派生
 *    与迁移脚本 migrate.js 保持一致；存储格式 iv.tag.cipher (base64, 用 . 连接)
 */
'use strict';

const enc = (s) => new TextEncoder().encode(String(s));
const dec = (b) => new TextDecoder().decode(b);

export const PBKDF2_ITER = 100000;
const ENC_SALT = 'admission-pw-enc-v2';

function bytesToHex(buf) {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex) {
  const arr = new Uint8Array(hex.length / 2);
  for (let i = 0; i < arr.length; i++) arr[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return arr;
}

export function bufToB64(buf) {
  let s = '';
  const arr = new Uint8Array(buf);
  for (let i = 0; i < arr.length; i += 0x8000) {
    s += String.fromCharCode.apply(null, arr.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

export function b64ToBytes(b64) {
  const s = atob(b64);
  const arr = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) arr[i] = s.charCodeAt(i);
  return arr;
}

/* 恒定时间比较（hex 字符串） */
function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function pbkdf2(password, saltBytes, iterations) {
  const key = await crypto.subtle.importKey('raw', enc(password), 'PBKDF2', false, ['deriveBits']);
  return crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations },
    key,
    256
  );
}

/** 生成带格式的 PBKDF2 哈希 */
export async function hashPassword(password, saltHex) {
  const bits = await pbkdf2(password, hexToBytes(saltHex), PBKDF2_ITER);
  return `pbkdf2$${PBKDF2_ITER}$${saltHex}$${bytesToHex(bits)}`;
}

/** 校验密码。兼容 pbkdf2$iter$saltHex$hashHex 格式 */
export async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 4 || parts[0] !== 'pbkdf2') return false;
  const [, iterStr, saltHex, hashHex] = parts;
  const iterations = parseInt(iterStr, 10);
  if (!(iterations > 0 && iterations <= 10000000)) return false;
  try {
    const bits = await pbkdf2(password, hexToBytes(saltHex), iterations);
    return timingSafeEq(bytesToHex(bits), hashHex);
  } catch {
    return false;
  }
}

/* ---------- AES-256-GCM 可逆加密（开户时还原明文密码） ---------- */

async function encKey(env) {
  const secret = String(env.SECRET || 'sibaihua-admission-2026-default-secret');
  const keyBits = await pbkdf2(secret, enc(ENC_SALT), PBKDF2_ITER);
  return crypto.subtle.importKey('raw', keyBits, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

/** 加密：返回 iv.tag.cipher (base64, 点分隔) —— 与原 Node 版格式一致 */
export async function encryptPassword(env, password) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await encKey(env);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv, tagLength: 128 }, key, enc(password)));
  const tag = ct.slice(ct.length - 16);
  const body = ct.slice(0, ct.length - 16);
  return [bufToB64(iv), bufToB64(tag), bufToB64(body)].join('.');
}

/** 解密 iv.tag.cipher */
export async function decryptPassword(env, blob) {
  const parts = String(blob).split('.');
  if (parts.length !== 3) throw new Error('密码密文格式不正确');
  const [ivB, tagB, bodyB] = parts;
  const key = await encKey(env);
  const payload = new Uint8Array([...b64ToBytes(bodyB), ...b64ToBytes(tagB)]);
  const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: b64ToBytes(ivB), tagLength: 128 }, key, payload);
  return dec(pt);
}
