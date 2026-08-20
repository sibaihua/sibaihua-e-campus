/**
 * SVG 图形验证码（沿用原 server.js 实现，纯 JS 无依赖）
 */
'use strict';

const CAPTCHA_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

export function genCaptchaCode() {
  const arr = new Uint32Array(5);
  crypto.getRandomValues(arr);
  let s = '';
  for (const n of arr) s += CAPTCHA_CHARS[n % CAPTCHA_CHARS.length];
  return s;
}

export function makeCaptchaSvg(code) {
  const rand = (a, b) => a + Math.random() * (b - a);
  let x = 14;
  const texts = [];
  for (const ch of code) {
    const y = rand(28, 38);
    const rot = rand(-22, 22);
    texts.push(
      `<text x="${x.toFixed(1)}" y="${y.toFixed(1)}" font-size="${rand(24, 30).toFixed(0)}" fill="hsl(${rand(140, 220).toFixed(0)},55%,32%)" font-family="Arial,Helvetica,sans-serif" font-weight="bold" transform="rotate(${rot.toFixed(1)} ${x.toFixed(1)} ${y.toFixed(1)})">${ch}</text>`
    );
    x += rand(27, 34);
  }
  let lines = '';
  for (let i = 0; i < 5; i++) {
    lines += `<path d="M${rand(0, 40).toFixed(0)} ${rand(0, 50).toFixed(0)} Q ${rand(60, 120).toFixed(0)} ${rand(-10, 60).toFixed(0)} ${rand(140, 175).toFixed(0)} ${rand(0, 50).toFixed(0)}" stroke="hsl(${rand(140, 220).toFixed(0)},40%,65%)" stroke-width="1.2" fill="none" opacity="0.6"/>`;
  }
  let dots = '';
  for (let i = 0; i < 26; i++) {
    dots += `<circle cx="${rand(0, 175).toFixed(0)}" cy="${rand(0, 50).toFixed(0)}" r="1" fill="#9fb8b0" opacity="0.7"/>`;
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="180" height="50" viewBox="0 0 180 50" role="img" aria-label="captcha"><rect width="180" height="50" rx="6" fill="#eef4f2"/>${dots}${lines}${texts.join('')}</svg>`;
}
