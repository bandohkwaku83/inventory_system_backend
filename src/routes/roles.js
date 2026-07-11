const express = require("express");
const mongoose = require("mongoose");
const Role = require("../models/Role");
const User = require("../models/User");
const { ENTITLEMENT_GROUPS, validateEntitlements } = require("../constants/entitlements");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

router.get("/entitlements", (_req, res) => {
  res.json({ groups: ENTITLEMENT_GROUPS });
});

router.get("/", requireEntitlement("manage_roles"), async (_req, res, next) => {
  try {
    const roles = await Role.find().sort({ name: 1 }).lean();
    res.json(roles);
  } catch (err) {
    next(err);
  }
});

router.post("/", requireEntitlement("manage_roles"), async (req, res, next) => {
  try {
    const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
    const description =
      typeof req.body?.description === "string" ? req.body.description.trim() : "";

    if (!name) {
      res.status(400).json({ message: "name is required" });
      return;
    }

    const entResult = validateEntitlements(req.body?.entitlements ?? []);
    if (entResult.error) {
      res.status(400).json({ message: entResult.error });
      return;
    }

    const role = await Role.create({
      name,
      description,
      entitlements: entResult.value,
      isSystem: false,
    });

    res.status(201).json(role.toPublicJSON());
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ message: "A role with this name already exists" });
      return;
    }
    next(err);
  }
});

router.get("/:id", requireEntitlement("manage_roles"), async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid role id" });
      return;
    }
    const role = await Role.findById(req.params.id).lean();
    if (!role) {
      res.status(404).json({ message: "Role not found" });
      return;
    }
    res.json(role);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", requireEntitlement("manage_roles"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid role id" });
      return;
    }

    const role = await Role.findById(id);
    if (!role) {
      res.status(404).json({ message: "Role not found" });
      return;
    }

    const body = req.body || {};

    if (hasField(body, "name")) {
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (!name) {
        res.status(400).json({ message: "name cannot be empty" });
        return;
      }
      role.name = name;
    }

    if (hasField(body, "description")) {
      role.description =
        typeof body.description === "string" ? body.description.trim() : "";
    }

    if (hasField(body, "entitlements")) {
      const entResult = validateEntitlements(body.entitlements);
      if (entResult.error) {
        res.status(400).json({ message: entResult.error });
        return;
      }
      role.entitlements = entResult.value;
    }

    try {
      await role.save();
    } catch (err) {
      if (err.code === 11000) {
        res.status(409).json({ message: "A role with this name already exists" });
        return;
      }
      throw err;
    }

    res.json(role.toPublicJSON());
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", requireEntitlement("manage_roles"), async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid role id" });
      return;
    }

    const role = await Role.findById(id).lean();
    if (!role) {
      res.status(404).json({ message: "Role not found" });
      return;
    }

    if (role.isSystem) {
      res.status(409).json({ message: "System roles cannot be deleted" });
      return;
    }

    const assignedCount = await User.countDocuments({ roleId: id });
    if (assignedCount > 0) {
      res.status(409).json({
        message: `Cannot delete role: ${assignedCount} user(s) are assigned to it`,
      });
      return;
    }

    await Role.findByIdAndDelete(id);
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
