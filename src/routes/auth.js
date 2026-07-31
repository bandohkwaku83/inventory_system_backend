const bcrypt = require("bcryptjs");
const express = require("express");
const User = require("../models/User");
const { signToken, toAuthUser, loadAuthContext, requireAuth } = require("../middleware/auth");
const { sendPasswordResetEmail } = require("../utils/email");
const {
  issuePasswordResetToken,
  findUserByResetToken,
  applyNewPassword,
  buildResetPasswordUrl,
} = require("../utils/passwordReset");

const router = express.Router();

router.post("/login", async (req, res, next) => {
  try {
    const emailRaw = req.body?.email;
    const password = req.body?.password;

    if (typeof emailRaw !== "string" || !emailRaw.trim()) {
      res.status(400).json({ message: "email is required" });
      return;
    }
    if (typeof password !== "string" || !password) {
      res.status(400).json({ message: "password is required" });
      return;
    }

    const email = emailRaw.trim().toLowerCase();
    const user = await User.findOne({ email }).select("+passwordHash");
    if (!user) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }
    if (!user.active) {
      res.status(403).json({ message: "Account is inactive" });
      return;
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      res.status(401).json({ message: "Invalid email or password" });
      return;
    }

    const { role } = await loadAuthContext(user);
    if (!role) {
      res.status(500).json({ message: "User role not found" });
      return;
    }

    const token = signToken(user, role);
    res.json({
      token,
      user: toAuthUser(user, role),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/me", requireAuth, (req, res) => {
  res.json({ user: req.authUser });
});

router.post("/logout", requireAuth, async (req, res, next) => {
  try {
    await User.findByIdAndUpdate(req.user._id, { $inc: { tokenVersion: 1 } });
    res.json({ message: "Logged out successfully" });
  } catch (err) {
    next(err);
  }
});

/**
 * Request a password-reset email. Always returns the same message
 * so callers cannot probe which emails exist.
 */
router.post("/forgot-password", async (req, res, next) => {
  try {
    const emailRaw = req.body?.email;
    if (typeof emailRaw !== "string" || !emailRaw.trim()) {
      res.status(400).json({ message: "email is required" });
      return;
    }

    const email = emailRaw.trim().toLowerCase();
    const generic = {
      message:
        "If an account exists for that email, a password reset link has been sent.",
    };

    const user = await User.findOne({ email }).select(
      "+passwordHash +passwordResetTokenHash"
    );
    if (user && user.active) {
      const rawToken = await issuePasswordResetToken(user, "forgot");
      const resetUrl = buildResetPasswordUrl(rawToken);
      await sendPasswordResetEmail({
        to: user.email,
        name: user.name,
        resetUrl,
        purpose: "forgot",
      });
    }

    res.json(generic);
  } catch (err) {
    next(err);
  }
});

/**
 * Complete a password reset using the token from the email link.
 * Used for both forgot-password and first-login invite links.
 */
router.post("/reset-password", async (req, res, next) => {
  try {
    const token = req.body?.token;
    const password = req.body?.password;

    if (typeof token !== "string" || !token.trim()) {
      res.status(400).json({ message: "token is required" });
      return;
    }
    if (typeof password !== "string" || password.length < 6) {
      res.status(400).json({ message: "password must be at least 6 characters" });
      return;
    }

    const user = await findUserByResetToken(User, token);
    if (!user) {
      res.status(400).json({ message: "Invalid or expired reset token" });
      return;
    }
    if (!user.active) {
      res.status(403).json({ message: "Account is inactive" });
      return;
    }

    await applyNewPassword(user, password);

    const { role } = await loadAuthContext(user);
    if (!role) {
      res.status(500).json({ message: "User role not found" });
      return;
    }

    const authToken = signToken(user, role);
    res.json({
      message: "Password updated successfully",
      token: authToken,
      user: toAuthUser(user, role),
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Change password while logged in (first-login forced reset or voluntary).
 */
router.post("/change-password", requireAuth, async (req, res, next) => {
  try {
    const currentPassword = req.body?.currentPassword;
    const newPassword = req.body?.newPassword ?? req.body?.password;

    if (typeof currentPassword !== "string" || !currentPassword) {
      res.status(400).json({ message: "currentPassword is required" });
      return;
    }
    if (typeof newPassword !== "string" || newPassword.length < 6) {
      res.status(400).json({
        message: "newPassword must be at least 6 characters",
      });
      return;
    }

    const user = req.user;
    const valid = await bcrypt.compare(currentPassword, user.passwordHash);
    if (!valid) {
      res.status(401).json({ message: "Current password is incorrect" });
      return;
    }

    await applyNewPassword(user, newPassword);

    const { role } = await loadAuthContext(user);
    if (!role) {
      res.status(500).json({ message: "User role not found" });
      return;
    }

    const authToken = signToken(user, role);
    res.json({
      message: "Password updated successfully",
      token: authToken,
      user: toAuthUser(user, role),
    });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
