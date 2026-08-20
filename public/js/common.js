/* 公共脚本：API 请求封装、校徽、顶栏 */
'use strict';

const API = {
  get token() { return localStorage.getItem('sib_token') || ''; },
  set token(v) { v ? localStorage.setItem('sib_token', v) : localStorage.removeItem('sib_token'); },

  async request(method, url, body) {
    const headers = { 'Content-Type': 'application/json' };
    if (this.token) headers['Authorization'] = 'Bearer ' + this.token;
    let res;
    try {
      res = await fetch(url, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (e) {
      return { code: -1, message: '网络错误，请稍后重试' };
    }
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !/\/api\/auth\/(login|register)/.test(url)) {
      this.token = '';
      location.href = '/';
    }
    return data;
  },

  get(url) { return this.request('GET', url); },
  post(url, body) { return this.request('POST', url, body); },
  del(url, body) { return this.request('DELETE', url, body); },
  put(url, body) { return this.request('PUT', url, body); },
};

const LOGO_URL = 'https://cdn.mriders.cn/img/2026/08/6a82000f8ce84.png';

/* ---------- Cloudflare Turnstile 人机验证（显式渲染模式） ---------- */
const TURNSTILE_SITE_KEY = '0x4AAAAAAEWvmxLZVjDXieV9';
let __pubConfig = null;

/* 获取公开配置（含 Turnstile 是否开启），前端据此决定是否渲染小部件 */
async function getPublicConfig() {
  if (__pubConfig) return __pubConfig;
  try {
    const r = await fetch('/api/config/public').then((r) => r.json());
    if (r.code === 200) __pubConfig = r.data;
  } catch (e) { /* ignore */ }
  return __pubConfig || { turnstileEnabled: true, turnstileSiteKey: TURNSTILE_SITE_KEY };
}

/* 按开关决定是否渲染小部件 */
async function maybeRenderTurnstile(elId) {
  const cfg = await getPublicConfig();
  if (cfg.turnstileEnabled) loadTurnstile(() => tsRender(elId));
  return cfg;
}

/* 加载 Turnstile api.js（显式模式），就绪后回调 */
function loadTurnstile(cb) {
  if (typeof window.turnstile === 'object') { cb && cb(); return; }
  if (window.__turnstileLoading) { return; } // 已在加载中，避免重复
  window.__turnstileLoading = true;
  const s = document.createElement('script');
  s.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
  s.async = true; s.defer = true;
  s.onload = () => cb && cb();
  document.head.appendChild(s);
}

/* 渲染小部件到指定容器（重复调用时先移除旧 widget 再重建） */
function tsRender(elId) {
  if (typeof window.turnstile !== 'object') return;
  const el = document.getElementById(elId);
  if (!el) return;
  if (window.__tsWidgets && window.__tsWidgets[elId]) {
    try { window.turnstile.remove(window.__tsWidgets[elId]); } catch (e) { /* ignore */ }
    delete window.__tsWidgets[elId];
    delete el.dataset.tsRendered;
  }
  if (el.dataset.tsRendered) return;
  try {
    const wid = window.turnstile.render(el, { sitekey: TURNSTILE_SITE_KEY, theme: 'light' });
    el.dataset.tsRendered = '1';
    window.__tsWidgets = window.__tsWidgets || {};
    window.__tsWidgets[elId] = wid;
  } catch (e) { /* 元素尺寸为 0 等情况，稍后重试 */ }
}

/* 获取小部件 token；未完成返回空串 */
function tsToken(elId) {
  try {
    if (typeof window.turnstile === 'object' && window.__tsWidgets && window.__tsWidgets[elId]) {
      return window.turnstile.getResponse(window.__tsWidgets[elId]) || '';
    }
  } catch (e) { /* ignore */ }
  return '';
}

/* 重置小部件（token 用过后失效，需重新验证） */
function tsReset(elId) {
  try {
    if (typeof window.turnstile === 'object' && window.__tsWidgets && window.__tsWidgets[elId]) {
      window.turnstile.reset(window.__tsWidgets[elId]);
    }
  } catch (e) { /* ignore */ }
}

const CREST_SVG = `
<svg class="crest" viewBox="0 0 48 48" width="46" height="46" aria-hidden="true">
  <circle cx="24" cy="24" r="23" fill="#1E3A5F"/>
  <circle cx="24" cy="24" r="19.5" fill="none" stroke="#5A7394" stroke-width="1.4"/>
  <circle cx="24" cy="24" r="17.5" fill="none" stroke="#ffffff" stroke-width="0.6" opacity="0.5"/>
  <text x="24" y="31" text-anchor="middle" font-size="19" fill="#ffffff"
        font-family="'PingFang SC','Microsoft YaHei',Arial,sans-serif" font-weight="bold">司</text>
</svg>`;

function crestImg(size = 56) {
  return `<img src="${LOGO_URL}" alt="" class="crest" width="${size}" height="${size}" onerror="this.outerHTML=CREST_SVG">`;
}

function renderBrand(el) {
  el.innerHTML = `${crestImg(48)}
    <span class="brand-text"><strong>我的E校园</strong><small>司白画大学清迈分校</small></span>`;
}

async function logout() {
  await API.post('/api/auth/logout');
  API.token = '';
  location.href = '/';
}

/* 状态徽章 */
function statusBadge(u) {
  if (u.role === 'admin') return '<span class="badge badge-admin">管理员</span>';
  if (u.status === 'approved') return '<span class="badge badge-approved">已录取</span>';
  if (u.status === 'failed') return '<span class="badge badge-failed">开户失败</span>';
  return '<span class="badge badge-registered">待申请</span>';
}

function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/* 用户头像 HTML：有 avatarUrl 显示图片（加载失败回退首字母），否则首字母圆 */
function avatarHtml(u) {
  const initial = esc((u.username || 'A').slice(0, 1).toUpperCase());
  if (u && u.avatarUrl) {
    return `<span class="avatar"><img src="${esc(u.avatarUrl)}" alt="" onerror="this.outerHTML='<span class=\\'avatar\\'>${initial}</span>'"></span>`;
  }
  return `<span class="avatar">${initial}</span>`;
}
