const bcrypt = require("bcryptjs");
const express = require("express");
const mongoose = require("mongoose");
const User = require("../models/User");
const Role = require("../models/Role");
const Category = require("../models/Category");
const Staff = require("../models/Staff");
const { requireAuth, requireEntitlement, toAuthUser } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);
router.use(requireEntitlement("users"));

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

async function validateCategoryIds(ids) {
  if (!Array.isArray(ids)) {
    return { error: "categoryIds must be an array" };
  }
  const unique = [...new Set(ids.map(String))];
  for (const id of unique) {
    if (!mongoose.Types.ObjectId.isValid(id)) {
      return { error: "categoryIds contains an invalid id" };
    }
  }
  if (unique.length === 0) {
    return { value: [] };
  }
  const count = await Category.countDocuments({ _id: { $in: unique } });
  if (count !== unique.length) {
    return { error: "One or more categories were not found" };
  }
  return { value: unique };
}

async function validateRoleId(roleId) {
  const raw =
    typeof roleId === "string" ? roleId.trim() : String(roleId ?? "").trim();
  if (!raw) {
    return { error: "roleId is required" };
  }

  let role = null;
  // Strict ObjectId check — mongoose.isValid is too loose for short strings.
  if (/^[a-fA-F0-9]{24}$/.test(raw)) {
    role = await Role.findById(raw).lean();
  }
  if (!role) {
    role = await Role.findOne({ slug: raw.toLowerCase() }).lean();
  }
  if (!role) {
    // Frontend often sends the display name instead of _id.
    role = await Role.findOne({ name: raw })
      .collation({ locale: "en", strength: 2 })
      .lean();
  }
  if (!role) {
    return {
      error: `Role not found for "${raw}". Pass role _id, slug (e.g. cashier), or role name from GET /api/roles.`,
    };
  }
  return { value: role };
}

function pickRoleId(body) {
  if (!body || typeof body !== "object") return undefined;
  if (Object.prototype.hasOwnProperty.call(body, "roleId")) return body.roleId;
  if (Object.prototype.hasOwnProperty.call(body, "role")) return body.role;
  return undefined;
}

async function resolveStaff(staffId, { excludeUserId } = {}) {
  if (!staffId || !mongoose.Types.ObjectId.isValid(staffId)) {
    return { error: "Valid staffId is required" };
  }
  const staff = await Staff.findById(staffId).lean();
  if (!staff) {
    return { error: "Staff member not found" };
  }
  if (staff.status !== "active") {
    return { error: "Staff member must be active" };
  }

  const linkedFilter = { staffId: staff._id };
  if (excludeUserId) {
    linkedFilter._id = { $ne: excludeUserId };
  }
  const existing = await User.findOne(linkedFilter).lean();
  if (existing) {
    return { error: "This staff member already has a user account" };
  }

  return { value: staff };
}

async function formatUser(user) {
  const role = await Role.findById(user.roleId).lean();
  return toAuthUser(user, role);
}

router.get("/", async (_req, res, next) => {
  try {
    const users = await User.find().sort({ name: 1 }).lean();
    const roles = await Role.find().lean();
    const roleById = new Map(roles.map((r) => [String(r._id), r]));
    res.json(
      users.map((u) => toAuthUser(u, roleById.get(String(u.roleId)) || null))
    );
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const staffId = req.body?.staffId;
    const emailRaw = req.body?.email;
    const password = req.body?.password;
    const roleId = pickRoleId(req.body);

    const staffResult = await resolveStaff(staffId);
    if (staffResult.error) {
      res.status(400).json({ message: staffResult.error });
      return;
    }

    if (typeof emailRaw !== "string" || !emailRaw.trim()) {
      res.status(400).json({ message: "email is required" });
      return;
    }
    if (typeof password !== "string" || password.length < 6) {
      res.status(400).json({ message: "password must be at least 6 characters" });
      return;
    }
    if (roleId === undefined || roleId === null || roleId === "") {
      res.status(400).json({ message: "roleId is required" });
      return;
    }

    const roleResult = await validateRoleId(roleId);
    if (roleResult.error) {
      res.status(400).json({ message: roleResult.error });
      return;
    }

    const catResult = await validateCategoryIds(req.body?.categoryIds ?? []);
    if (catResult.error) {
      res.status(400).json({ message: catResult.error });
      return;
    }

    const email = emailRaw.trim().toLowerCase();
    const passwordHash = await bcrypt.hash(password, 10);
    const active = req.body?.active !== false;

    const user = await User.create({
      name: staffResult.value.fullName,
      staffId: staffResult.value._id,
      email,
      passwordHash,
      roleId: roleResult.value._id,
      categoryIds: catResult.value,
      active,
    });

    res.status(201).json(await formatUser(user));
  } catch (err) {
    if (err.code === 11000) {
      if (err.keyPattern?.staffId) {
        res.status(409).json({ message: "This staff member already has a user account" });
        return;
      }
      res.status(409).json({ message: "A user with this email already exists" });
      return;
    }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid user id" });
      return;
    }
    const user = await User.findById(req.params.id).lean();
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }
    res.json(await formatUser(user));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid user id" });
      return;
    }

    const user = await User.findById(id).select("+passwordHash");
    if (!user) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    const body = req.body || {};

    if (hasField(body, "name")) {
      res.status(400).json({
        message: "name is taken from the linked staff member; update staff or change staffId",
      });
      return;
    }

    if (hasField(body, "staffId")) {
      const staffResult = await resolveStaff(body.staffId, { excludeUserId: user._id });
      if (staffResult.error) {
        res.status(400).json({ message: staffResult.error });
        return;
      }
      user.staffId = staffResult.value._id;
      user.name = staffResult.value.fullName;
    }

    if (hasField(body, "email")) {
      const emailRaw = body.email;
      if (typeof emailRaw !== "string" || !emailRaw.trim()) {
        res.status(400).json({ message: "email cannot be empty" });
        return;
      }
      user.email = emailRaw.trim().toLowerCase();
    }

    if (hasField(body, "roleId") || hasField(body, "role")) {
      const roleResult = await validateRoleId(pickRoleId(body));
      if (roleResult.error) {
        res.status(400).json({ message: roleResult.error });
        return;
      }
      user.roleId = roleResult.value._id;
    }

    if (hasField(body, "categoryIds")) {
      const catResult = await validateCategoryIds(body.categoryIds);
      if (catResult.error) {
        res.status(400).json({ message: catResult.error });
        return;
      }
      user.categoryIds = catResult.value;
    }

    if (hasField(body, "active")) {
      user.active = Boolean(body.active);
    }

    if (hasField(body, "password")) {
      const password = body.password;
      if (typeof password !== "string" || password.length < 6) {
        res.status(400).json({ message: "password must be at least 6 characters" });
        return;
      }
      user.passwordHash = await bcrypt.hash(password, 10);
      user.tokenVersion = (user.tokenVersion ?? 0) + 1;
    }

    try {
      await user.save();
    } catch (err) {
      if (err.code === 11000) {
        if (err.keyPattern?.staffId) {
          res.status(409).json({ message: "This staff member already has a user account" });
          return;
        }
        res.status(409).json({ message: "A user with this email already exists" });
        return;
      }
      throw err;
    }

    res.json(await formatUser(user));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid user id" });
      return;
    }

    if (String(req.authUser._id) === String(id)) {
      res.status(409).json({ message: "You cannot delete your own account" });
      return;
    }

    const removed = await User.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({ message: "User not found" });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
