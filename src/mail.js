/**
 * 邮件发送（Cloudflare Worker 版）
 * Worker 无 net/tls，不能用 SMTP 直连；改为 Resend Transactional Email API
 * （https://api.resend.com/emails）。发件域名需在 Resend 后台完成 DNS 验证。
 * 发送失败时会抛出带中文信息的 Error。
 */
'use strict';

/* ---------- 邮件模板（与官网一致的深藏蓝 + 彩虹视觉，沿用原 server.js） ---------- */
function mailShell(innerHtml) {
  const rainbow = 'linear-gradient(90deg,#E40303,#FF8C00,#FFED00,#008026,#24408E,#732982)';
  return `<!DOCTYPE html><html lang="zh-CN"><body style="margin:0;padding:0;background:#eef1f6;font-family:'PingFang SC','Microsoft YaHei',Arial,sans-serif">
<div style="background:${rainbow};height:6px"></div>
<div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="max-width:600px;margin:0 auto;padding:28px 16px">
  <div style="background:#ffffff;border-radius:14px;overflow:hidden;border:1px solid #e3e8ef;box-shadow:0 6px 24px rgba(20,39,64,.08)">
    <div style="padding:30px 34px 26px;text-align:center;background:#f8fafc;border-bottom:1px solid #eef1f6">
      <div style="font-size:20px;font-weight:bold;color:#1E3A5F;letter-spacing:2px">司白画大学清迈分校</div>
      <div style="font-size:12px;color:#5A7394;margin-top:4px">Sibaihua University · Chiang Mai Campus · 我的E校园</div>
    </div>
    <div style="padding:28px 34px;color:#2b3544;font-size:14.5px;line-height:1.9">
      ${innerHtml}
    </div>
    <div style="padding:16px 34px;background:#f8fafc;border-top:1px solid #eef1f6;color:#5A7394;font-size:12px;line-height:1.8">
      此邮件由「我的E校园」系统自动发送，请勿直接回复。<br>
      One World, One Dream · © 2026 Sibaihua University Chiang Mai Campus
    </div>
  </div>
</div>
</div>
</body></html>`;
}

export function mailVerifyCodeHtml(code, minutes) {
  const inner = `
    <p>你好：</p>
    <p>你正在使用「我的E校园」进行<strong>个人联系邮箱验证</strong>，你的验证码为：</p>
    <div style="margin:22px 0;padding:16px;background:#f2f6fb;border:1px dashed #9db4d0;border-radius:10px;text-align:center">
      <span style="font-size:30px;font-weight:bold;letter-spacing:8px;color:#1E3A5F">${code}</span>
    </div>
    <p style="color:#5A7394;font-size:13px">验证码 <strong>${minutes} 分钟</strong>内有效。如非本人操作，请忽略本邮件，并注意保护账号安全。</p>`;
  return mailShell(inner);
}

export function mailTestHtml() {
  const inner = `
    <p>你好：</p>
    <p>这是一封来自「我的E校园」的<strong>邮件服务测试邮件</strong>。</p>
    <p style="color:#5A7394;font-size:13px">如果你收到了这封邮件，说明邮件发送通道配置正确，个人联系邮箱验证功能已可正常使用。</p>`;
  return mailShell(inner);
}

/**
 * 读取邮件服务配置（后台设置优先，其次环境变量/默认值）。
 * 返回 { provider, from, fromName, apiKey, domain }
 */
export async function getMailProvider(env, db) {
  const raw = await db.getSetting(env, 'mail_provider_json');
  let s = {};
  if (raw) { try { s = JSON.parse(raw); } catch { s = {}; } }
  return {
    provider: s.provider || 'resend',
    from: s.from || env.MAIL_FROM || 'no-reply@sibh.cn',
    fromName: s.fromName || env.MAIL_FROM_NAME || '司白画大学清迈分校 · 我的E校园',
    apiKey: s.apiKey || env.RESEND_API_KEY || '',
    domain: s.domain || (s.from || '').split('@')[1] || '',
  };
}

/** 保存邮件服务配置 */
export async function saveMailProvider(env, db, cfg) {
  await db.setSetting(env, 'mail_provider_json', JSON.stringify(cfg));
}

/** 通过 Resend API 发送 HTML 邮件 */
async function sendViaResend(cfg, { to,  subject, html }) {
  const from = cfg.fromName ? `${cfg.fromName} <${cfg.from}>` : cfg.from;
  const payload = {
    from,
    to: [to],
    subject,
    html,
  };
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${cfg.apiKey}`,
  };
  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
  });
  if (res.status >= 400) {
    const text = await res.text();
    throw new Error(`邮件服务返回错误（HTTP ${res.status}）: ${text.slice(0, 200)}`);
  }
  return { ok: true };
}

/**
 * 发送一封 HTML 邮件。入口：sendMail(env, db, { to, subject, html })
 * 支持 provider：resend（默认）
 */
export async function sendMail(env, db, { to, subject, html, cfgOverride }) {
  const cfg = cfgOverride || (await getMailProvider(env, db));
  if (!cfg.from) throw new Error('邮件服务未配置，请在管理后台「系统设置 · 邮件服务」中填写发件邮箱');
  if (cfg.provider === 'resend') {
    return sendViaResend(cfg, { to, subject, html });
  }
  throw new Error(`不支持的邮件服务类型: ${cfg.provider}`);
}
