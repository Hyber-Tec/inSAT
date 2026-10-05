// Optional transactional email via Resend. If RESEND_API_KEY isn't set, this is
// a no-op - callers fall back to showing the invite link for manual sharing.

import { config } from './config.js';

export async function sendInvite(to, link, ctx = {}) {
  if (!config.resendApiKey) return { sent: false, reason: 'no_provider' };
  const who = ctx.institution || 'insat';
  const html = `
    <div style="font-family:system-ui,sans-serif;line-height:1.6">
      <p>You've been invited to <b>${who}</b>${ctx.role ? ` as ${ctx.role}` : ''}.</p>
      <p><a href="${link}" style="background:#394447;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none">Set your password &amp; sign in</a></p>
      <p style="color:#67787c;font-size:13px">Or paste this link into your browser:<br>${link}</p>
    </div>`;
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${config.resendApiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ from: config.mailFrom, to, subject: `Your ${who} invitation`, html }),
    });
    return { sent: res.ok, reason: res.ok ? null : `resend_${res.status}` };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}
