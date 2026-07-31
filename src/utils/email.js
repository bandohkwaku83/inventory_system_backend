const { Resend } = require("resend");

let resendClient = null;

function getResend() {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) {
    return null;
  }
  if (!resendClient) {
    resendClient = new Resend(apiKey);
  }
  return resendClient;
}

function fromAddress() {
  return (
    process.env.RESEND_FROM_EMAIL ||
    "Inventory <onboarding@resend.dev>"
  );
}

/**
 * Sends an email via Resend. Logs and returns false when not configured
 * so auth flows can still succeed in local/dev without mail.
 */
async function sendEmail({ to, subject, html, text }) {
  const resend = getResend();
  if (!resend) {
    console.warn(
      `[email] RESEND_API_KEY not set — skipped sending "${subject}" to ${to}`
    );
    return { sent: false, reason: "not_configured" };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: fromAddress(),
      to: [to],
      subject,
      html,
      text,
    });

    if (error) {
      console.error("[email] Resend error:", error);
      return { sent: false, reason: error.message || "send_failed" };
    }

    return { sent: true, id: data?.id };
  } catch (err) {
    console.error("[email] Failed to send:", err.message);
    return { sent: false, reason: err.message };
  }
}

async function sendPasswordResetEmail({ to, name, resetUrl, purpose }) {
  const isInvite = purpose === "invite";
  const subject = isInvite
    ? "Set your password"
    : "Reset your password";
  const heading = isInvite
    ? "Welcome — set your password"
    : "Reset your password";
  const intro = isInvite
    ? `Hi ${name || "there"}, an account was created for you. Use the button below to choose your password.`
    : `Hi ${name || "there"}, we received a request to reset your password. Use the button below to continue.`;
  const expiryNote = isInvite
    ? "This link expires in 7 days."
    : "This link expires in 1 hour.";
  const cta = isInvite ? "Set password" : "Reset password";

  const html = `
    <div style="font-family: system-ui, -apple-system, sans-serif; max-width: 480px; margin: 0 auto; color: #111;">
      <h1 style="font-size: 20px; font-weight: 600;">${heading}</h1>
      <p style="line-height: 1.5; color: #333;">${intro}</p>
      <p style="margin: 28px 0;">
        <a href="${resetUrl}"
           style="display: inline-block; background: #111; color: #fff; text-decoration: none; padding: 12px 20px; border-radius: 6px; font-weight: 500;">
          ${cta}
        </a>
      </p>
      <p style="font-size: 13px; color: #666; line-height: 1.5;">
        ${expiryNote} If you did not expect this email, you can ignore it.
      </p>
      <p style="font-size: 12px; color: #999; word-break: break-all;">
        Or copy this link:<br />${resetUrl}
      </p>
    </div>
  `;

  const text = [
    heading,
    "",
    intro,
    "",
    `${cta}: ${resetUrl}`,
    "",
    expiryNote,
    "If you did not expect this email, you can ignore it.",
  ].join("\n");

  return sendEmail({ to, subject, html, text });
}

module.exports = {
  sendEmail,
  sendPasswordResetEmail,
};
