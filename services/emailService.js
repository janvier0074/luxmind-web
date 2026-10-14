// services/emailService.js
// Sends transactional emails via Gmail SMTP.

const nodemailer = require('nodemailer');

const GMAIL_USER = process.env.GMAIL_USER;
const GMAIL_APP_PASSWORD = process.env.GMAIL_APP_PASSWORD;
const FROM_NAME = 'LuxMind';
const APP_URL = process.env.APP_URL || 'https://luxmind.onrender.com';

let transporter = null;
if (GMAIL_USER && GMAIL_APP_PASSWORD) {
  transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
      user: GMAIL_USER,
      pass: GMAIL_APP_PASSWORD.replace(/\s+/g, ''),
    },
  });
  console.log('📧 Gmail email service initialized as ' + GMAIL_USER);
} else {
  console.warn('⚠️  GMAIL_USER / GMAIL_APP_PASSWORD not set — emails will be skipped');
}

/**
 * Low-level send. Returns { ok: true } or { ok: false, error }.
 */
async function sendEmail({ to, subject, html, text }) {
  if (!transporter) {
    return { ok: false, error: 'Email service not configured' };
  }
  try {
    const info = await transporter.sendMail({
      from: FROM_NAME + ' <' + GMAIL_USER + '>',
      to,
      subject,
      html: html || text,
      text: text || undefined,
    });
    return { ok: true, id: info.messageId };
  } catch (e) {
    console.error('sendEmail error:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Shared HTML wrapper so every email has a consistent look.
 */
function wrap(title, bodyHtml) {
  return `
  <div style="font-family:system-ui,-apple-system,'Segoe UI',sans-serif;background:#f8fafc;padding:32px 16px;">
    <div style="max-width:560px;margin:0 auto;background:#fff;border-radius:16px;overflow:hidden;box-shadow:0 4px 16px rgba(15,23,42,.05);">
      <div style="padding:24px 32px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;">
        <div style="font-size:1.25rem;font-weight:800;letter-spacing:-.02em;">LuxMind</div>
      </div>
      <div style="padding:32px;">
        <h1 style="margin:0 0 16px 0;font-size:1.4rem;color:#0f172a;">${title}</h1>
        ${bodyHtml}
      </div>
      <div style="padding:20px 32px;background:#f8fafc;border-top:1px solid #eef0f6;font-size:.8rem;color:#94a3b8;text-align:center;">
        LuxMind LMS &middot; <a href="${APP_URL}" style="color:#6366f1;text-decoration:none;">${APP_URL}</a>
      </div>
    </div>
  </div>`;
}

function btn(href, label) {
  return `<a href="${href}" style="display:inline-block;padding:12px 22px;background:linear-gradient(135deg,#6366f1,#8b5cf6);color:#fff;text-decoration:none;border-radius:10px;font-weight:700;font-size:.92rem;">${label}</a>`;
}

// ---------------------------------------------------------------------------
// Event-specific senders
// ---------------------------------------------------------------------------

async function sendWelcome({ to, name }) {
  return sendEmail({
    to,
    subject: 'Welcome to LuxMind',
    html: wrap('Welcome to LuxMind', `
      <p style="color:#334155;line-height:1.65;margin:0 0 16px 0;">Hi ${name || 'there'},</p>
      <p style="color:#334155;line-height:1.65;margin:0 0 24px 0;">Your account is ready. Explore your courses, take quizzes, and track your progress — all in one place.</p>
      ${btn(APP_URL + '/dashboard', 'Open LuxMind')}
    `),
  });
}

async function sendNewMessage({ to, recipientName, senderName, preview }) {
  return sendEmail({
    to,
    subject: 'New message from ' + senderName,
    html: wrap('You have a new message', `
      <p style="color:#334155;line-height:1.65;margin:0 0 12px 0;">Hi ${recipientName || 'there'},</p>
      <p style="color:#334155;line-height:1.65;margin:0 0 16px 0;"><strong>${senderName}</strong> sent you a message on LuxMind:</p>
      <blockquote style="margin:0 0 24px 0;padding:14px 18px;background:#f8fafc;border-left:3px solid #6366f1;color:#475569;border-radius:6px;font-style:italic;">${preview}</blockquote>
      ${btn(APP_URL + '/messages', 'Read message')}
    `),
  });
}

async function sendAssignmentGraded({ to, studentName, assignmentTitle, courseName, score, maxPoints, feedback }) {
  const pct = maxPoints ? Math.round((score / maxPoints) * 100) : 0;
  return sendEmail({
    to,
    subject: 'Your assignment was graded: ' + assignmentTitle,
    html: wrap('Assignment graded', `
      <p style="color:#334155;line-height:1.65;margin:0 0 12px 0;">Hi ${studentName || 'there'},</p>
      <p style="color:#334155;line-height:1.65;margin:0 0 16px 0;">Your submission for <strong>${assignmentTitle}</strong> in <strong>${courseName}</strong> has been graded.</p>
      <div style="margin:0 0 20px 0;padding:18px;background:#ecfdf5;border-radius:10px;text-align:center;">
        <div style="font-size:2rem;font-weight:800;color:#047857;">${score} / ${maxPoints}</div>
        <div style="color:#059669;font-size:.85rem;margin-top:4px;">${pct}%</div>
      </div>
      ${feedback ? `<p style="color:#334155;line-height:1.65;margin:0 0 24px 0;"><strong>Feedback:</strong> ${feedback}</p>` : ''}
      ${btn(APP_URL + '/student/assignments', 'View all assignments')}
    `),
  });
}

async function sendNewAnnouncement({ to, studentName, courseName, title, body, authorName }) {
  return sendEmail({
    to,
    subject: 'New announcement in ' + courseName,
    html: wrap('New announcement', `
      <p style="color:#334155;line-height:1.65;margin:0 0 12px 0;">Hi ${studentName || 'there'},</p>
      <p style="color:#334155;line-height:1.65;margin:0 0 16px 0;"><strong>${authorName}</strong> posted an announcement in <strong>${courseName}</strong>.</p>
      <div style="margin:0 0 24px 0;padding:18px;background:#f8fafc;border-radius:10px;">
        <div style="font-weight:700;color:#0f172a;margin-bottom:8px;">${title}</div>
        <div style="color:#475569;line-height:1.6;font-size:.92rem;">${body}</div>
      </div>
      ${btn(APP_URL + '/student/announcements', 'Read on LuxMind')}
    `),
  });
}

async function sendCertificateEarned({ to, studentName, courseName, code }) {
  return sendEmail({
    to,
    subject: 'You earned a certificate for ' + courseName,
    html: wrap('🎉 Certificate earned', `
      <p style="color:#334155;line-height:1.65;margin:0 0 12px 0;">Hi ${studentName || 'there'},</p>
      <p style="color:#334155;line-height:1.65;margin:0 0 16px 0;">Congratulations! You completed <strong>${courseName}</strong> and earned a certificate.</p>
      <div style="margin:0 0 24px 0;padding:16px;background:#fef3c7;border-radius:10px;text-align:center;">
        <div style="font-size:.8rem;text-transform:uppercase;letter-spacing:.08em;color:#92400e;font-weight:700;">Certificate ID</div>
        <div style="font-family:ui-monospace,monospace;font-size:1rem;color:#78350f;margin-top:6px;">${code}</div>
      </div>
      ${btn(APP_URL + '/my-certificates', 'View certificate')}
    `),
  });
}

module.exports = {
  sendEmail,
  sendWelcome,
  sendNewMessage,
  sendAssignmentGraded,
  sendNewAnnouncement,
  sendCertificateEarned,
};