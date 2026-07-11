const bcrypt = require("bcryptjs");
const express = require("express");
const User = require("../models/User");
const { signToken, toAuthUser, loadAuthContext, requireAuth } = require("../middleware/auth");

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

module.exports = router;
