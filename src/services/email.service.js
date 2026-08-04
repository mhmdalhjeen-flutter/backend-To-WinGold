const nodemailer = require("nodemailer");
const { maskIdentifier, safeLog } = require("../utils/logSanitize.util");

const APP_NAME = process.env.APP_NAME || "Offers Tech";

function isEmailConfigured() {
  return Boolean(
    process.env.SMTP_HOST &&
    process.env.SMTP_USER &&
    process.env.SMTP_PASS
  );
}

let transporter;

function getTransporter() {
  if (!isEmailConfigured()) return null;
  if (!transporter) {
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: Number(process.env.SMTP_PORT || 587),
      secure: process.env.SMTP_SECURE === "true",
      auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS,
      },
    });
  }
  return transporter;
}

function buildVerificationEmailHtml({ name, code, verifyLink }) {
  const greeting = name ? `مرحباً ${name}` : "مرحباً";
  const linkBlock = verifyLink
    ? `<p style="margin:24px 0;">
        <a href="${verifyLink}" style="display:inline-block;background:#dc2626;color:#fff;padding:14px 28px;border-radius:12px;text-decoration:none;font-weight:bold;">
          تأكيد البريد الإلكتروني
        </a>
      </p>
      <p style="font-size:12px;color:#666;">أو انسخ الرابط:<br/><span dir="ltr">${verifyLink}</span></p>`
    : "";

  return `<!DOCTYPE html>
<html dir="rtl" lang="ar">
<body style="font-family:Tahoma,Arial,sans-serif;background:#f4f4f5;padding:24px;">
  <div style="max-width:480px;margin:0 auto;background:#fff;border-radius:16px;padding:32px;">
    <h2 style="color:#111;margin:0 0 8px;">${APP_NAME}</h2>
    <p style="color:#444;">${greeting}،</p>
    <p style="color:#444;">رمز توثيق حسابك:</p>
    <p style="font-size:32px;font-weight:bold;letter-spacing:8px;color:#dc2626;text-align:center;margin:16px 0;" dir="ltr">${code}</p>
    <p style="color:#666;font-size:13px;">صالح لمدة 10 دقائق. لا تشارك هذا الرمز مع أحد.</p>
    ${linkBlock}
  </div>
</body>
</html>`;
}

async function sendVerificationEmail({ to, name, code, verifyLink }) {
  if (!to) throw new Error("عنوان البريد مطلوب");

  const subject = `${APP_NAME} — رمز توثيق حسابك`;
  const html = buildVerificationEmailHtml({ name, code, verifyLink });
  const text = `رمز توثيق ${APP_NAME}: ${code}${verifyLink ? `\nرابط التفعيل: ${verifyLink}` : ""}`;

  const transport = getTransporter();
  if (!transport) {
    safeLog("warn", "email_skipped_not_configured", {
      to: maskIdentifier(to),
      type: "verification",
      hasVerifyLink: !!verifyLink,
    });
    return { sent: false, skipped: true, reason: "SMTP_NOT_CONFIGURED" };
  }

  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
  });

  return { sent: true };
}

async function sendPasswordResetEmail({ to, name, code }) {
  if (!to) throw new Error("عنوان البريد مطلوب");

  const subject = `${APP_NAME} — رمز إعادة تعيين كلمة المرور`;
  const html = `<!DOCTYPE html><html dir="rtl"><body style="font-family:Tahoma,sans-serif;padding:24px;">
    <p>مرحباً${name ? ` ${name}` : ""}،</p>
    <p>رمز إعادة تعيين كلمة المرور:</p>
    <p style="font-size:28px;font-weight:bold;letter-spacing:6px;color:#dc2626;" dir="ltr">${code}</p>
    <p style="color:#666;font-size:13px;">صالح 10 دقائق.</p>
  </body></html>`;

  const transport = getTransporter();
  if (!transport) {
    safeLog("warn", "email_skipped_not_configured", {
      to: maskIdentifier(to),
      type: "password_reset",
    });
    return { sent: false, skipped: true, reason: "SMTP_NOT_CONFIGURED" };
  }

  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to,
    subject,
    html,
    text: `رمز إعادة التعيين: ${code}`,
  });

  return { sent: true };
}

module.exports = {
  isEmailConfigured,
  sendVerificationEmail,
  sendPasswordResetEmail,
};
