const crypto = require("crypto");
const bcrypt = require("bcryptjs");

const FORGOT_PASSWORD_TTL_MS = 60 * 60 * 1000; // 1 hour
const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

function hashToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

/**
 * Creates a one-time reset token and stores its hash on the user.
 * @param {import("mongoose").Document} user
 * @param {"forgot"|"invite"} purpose
 * @returns {Promise<string>} raw token (send this in the email link)
 */
async function issuePasswordResetToken(user, purpose = "forgot") {
  const rawToken = crypto.randomBytes(32).toString("hex");
  const ttl = purpose === "invite" ? INVITE_TTL_MS : FORGOT_PASSWORD_TTL_MS;

  user.passwordResetTokenHash = hashToken(rawToken);
  user.passwordResetExpires = new Date(Date.now() + ttl);
  await user.save();

  return rawToken;
}

function clearPasswordResetFields(user) {
  user.passwordResetTokenHash = undefined;
  user.passwordResetExpires = undefined;
}

/**
 * Finds a user by a raw reset token if it is still valid.
 */
async function findUserByResetToken(User, rawToken) {
  if (typeof rawToken !== "string" || !rawToken.trim()) {
    return null;
  }
  const tokenHash = hashToken(rawToken.trim());
  return User.findOne({
    passwordResetTokenHash: tokenHash,
    passwordResetExpires: { $gt: new Date() },
  }).select("+passwordHash +passwordResetTokenHash");
}

async function applyNewPassword(user, password) {
  user.passwordHash = await bcrypt.hash(password, 10);
  user.mustResetPassword = false;
  user.tokenVersion = (user.tokenVersion ?? 0) + 1;
  clearPasswordResetFields(user);
  await user.save();
}

function frontendBaseUrl() {
  const base = (process.env.FRONTEND_URL || process.env.CORS_ORIGIN || "http://localhost:3001")
    .trim()
    .replace(/\/$/, "");
  return base;
}

function buildResetPasswordUrl(rawToken) {
  return `${frontendBaseUrl()}/reset-password?token=${encodeURIComponent(rawToken)}`;
}

module.exports = {
  FORGOT_PASSWORD_TTL_MS,
  INVITE_TTL_MS,
  hashToken,
  issuePasswordResetToken,
  clearPasswordResetFields,
  findUserByResetToken,
  applyNewPassword,
  frontendBaseUrl,
  buildResetPasswordUrl,
};
