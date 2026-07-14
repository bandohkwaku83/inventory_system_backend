const express = require("express");
const mongoose = require("mongoose");
const Department = require("../models/Department");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);
router.use(requireEntitlement("departments", "staff"));

function hasField(body, key) {
  return body != null && Object.prototype.hasOwnProperty.call(body, key);
}

function str(body, key) {
  const v = body?.[key];
  if (v === undefined || v === null) {
    return undefined;
  }
  if (typeof v !== "string") {
    return String(v).trim();
  }
  return v.trim();
}

function parseDivisionNames(raw) {
  if (raw === undefined) {
    return { value: undefined };
  }
  if (!Array.isArray(raw)) {
    return { error: "divisions must be an array" };
  }

  const names = [];
  const seen = new Set();
  for (const item of raw) {
    let name;
    if (typeof item === "string") {
      name = item.trim();
    } else if (item && typeof item === "object" && typeof item.name === "string") {
      name = item.name.trim();
    } else {
      return { error: "each division must be a string or { name }" };
    }
    if (!name) {
      return { error: "division name cannot be empty" };
    }
    if (name.length > 120) {
      return { error: "division name must be at most 120 characters" };
    }
    const key = name.toLowerCase();
    if (seen.has(key)) {
      return { error: `duplicate division name: ${name}` };
    }
    seen.add(key);
    names.push(name);
  }
  return { value: names };
}

function formatDepartment(doc) {
  if (!doc) return doc;
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  delete o.__v;
  return o;
}

async function listDepartments(req, res, next) {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit || "50"), 10) || 50)
    );
    const skip = (page - 1) * limit;

    const filter = {};
    const q = String(req.query.q || req.query.search || "").trim();
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { name: re },
        { "divisions.name": re },
      ];
    }

    const [rows, total] = await Promise.all([
      Department.find(filter).sort({ name: 1 }).skip(skip).limit(limit).lean(),
      Department.countDocuments(filter),
    ]);

    res.json({
      items: rows.map((d) => formatDepartment(d)),
      page,
      limit,
      total,
      totalPages: Math.ceil(total / limit) || 0,
    });
  } catch (err) {
    next(err);
  }
}

async function getDepartmentById(req, res, next) {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({
        message: "Invalid department id",
        error: "Invalid department id",
      });
      return;
    }
    const department = await Department.findById(req.params.id).lean();
    if (!department) {
      res.status(404).json({
        message: "Department not found",
        error: "Department not found",
      });
      return;
    }
    res.json(formatDepartment(department));
  } catch (err) {
    next(err);
  }
}

async function createDepartment(req, res, next) {
  try {
    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({
        message: "Department name is required",
        error: "Department name is required",
      });
      return;
    }

    const divisionsResult = parseDivisionNames(
      hasField(req.body, "divisions") ? req.body.divisions : []
    );
    if (divisionsResult.error) {
      res.status(400).json({
        message: divisionsResult.error,
        error: divisionsResult.error,
      });
      return;
    }

    const department = await Department.create({
      name,
      divisions: divisionsResult.value.map((n) => ({ name: n })),
    });

    res.status(201).json(formatDepartment(department));
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({
        message: "A department with this name already exists",
        error: "A department with this name already exists",
      });
      return;
    }
    next(err);
  }
}

async function updateDepartment(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        message: "Invalid department id",
        error: "Invalid department id",
      });
      return;
    }

    const department = await Department.findById(id);
    if (!department) {
      res.status(404).json({
        message: "Department not found",
        error: "Department not found",
      });
      return;
    }

    const body = req.body || {};
    let changed = false;

    if (hasField(body, "name")) {
      const name = str(body, "name") ?? "";
      if (!name) {
        res.status(400).json({
          message: "Department name cannot be empty",
          error: "Department name cannot be empty",
        });
        return;
      }
      department.name = name;
      changed = true;
    }

    if (hasField(body, "divisions")) {
      const divisionsResult = parseDivisionNames(body.divisions);
      if (divisionsResult.error) {
        res.status(400).json({
          message: divisionsResult.error,
          error: divisionsResult.error,
        });
        return;
      }
      department.divisions = divisionsResult.value.map((n) => ({ name: n }));
      changed = true;
    }

    if (!changed) {
      res.status(400).json({
        message: "No updatable fields provided",
        error: "No updatable fields provided",
      });
      return;
    }

    try {
      await department.save({ validateBeforeSave: true });
    } catch (err) {
      if (err.code === 11000) {
        res.status(409).json({
          message: "A department with this name already exists",
          error: "A department with this name already exists",
        });
        return;
      }
      if (err.name === "ValidationError") {
        const msg =
          Object.values(err.errors || {})[0]?.message ||
          err.message ||
          "Validation failed";
        res.status(400).json({ message: msg, error: msg });
        return;
      }
      throw err;
    }

    res.json(formatDepartment(department));
  } catch (err) {
    next(err);
  }
}

async function deleteDepartment(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        message: "Invalid department id",
        error: "Invalid department id",
      });
      return;
    }

    const removed = await Department.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({
        message: "Department not found",
        error: "Department not found",
      });
      return;
    }

    res.status(204).send();
  } catch (err) {
    next(err);
  }
}

async function addDivision(req, res, next) {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        message: "Invalid department id",
        error: "Invalid department id",
      });
      return;
    }

    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({
        message: "Division name is required",
        error: "Division name is required",
      });
      return;
    }

    const department = await Department.findById(id);
    if (!department) {
      res.status(404).json({
        message: "Department not found",
        error: "Department not found",
      });
      return;
    }

    const exists = department.divisions.some(
      (d) => d.name.toLowerCase() === name.toLowerCase()
    );
    if (exists) {
      res.status(409).json({
        message: "A division with this name already exists in the department",
        error: "A division with this name already exists in the department",
      });
      return;
    }

    department.divisions.push({ name });
    await department.save();
    res.status(201).json(formatDepartment(department));
  } catch (err) {
    next(err);
  }
}

async function updateDivision(req, res, next) {
  try {
    const { id, divisionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        message: "Invalid department id",
        error: "Invalid department id",
      });
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(divisionId)) {
      res.status(400).json({
        message: "Invalid division id",
        error: "Invalid division id",
      });
      return;
    }

    const name = str(req.body, "name") ?? "";
    if (!name) {
      res.status(400).json({
        message: "Division name is required",
        error: "Division name is required",
      });
      return;
    }

    const department = await Department.findById(id);
    if (!department) {
      res.status(404).json({
        message: "Department not found",
        error: "Department not found",
      });
      return;
    }

    const division = department.divisions.id(divisionId);
    if (!division) {
      res.status(404).json({
        message: "Division not found",
        error: "Division not found",
      });
      return;
    }

    const conflict = department.divisions.some(
      (d) =>
        d._id.toString() !== divisionId &&
        d.name.toLowerCase() === name.toLowerCase()
    );
    if (conflict) {
      res.status(409).json({
        message: "A division with this name already exists in the department",
        error: "A division with this name already exists in the department",
      });
      return;
    }

    division.name = name;
    await department.save();
    res.json(formatDepartment(department));
  } catch (err) {
    next(err);
  }
}

async function deleteDivision(req, res, next) {
  try {
    const { id, divisionId } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({
        message: "Invalid department id",
        error: "Invalid department id",
      });
      return;
    }
    if (!mongoose.Types.ObjectId.isValid(divisionId)) {
      res.status(400).json({
        message: "Invalid division id",
        error: "Invalid division id",
      });
      return;
    }

    const department = await Department.findById(id);
    if (!department) {
      res.status(404).json({
        message: "Department not found",
        error: "Department not found",
      });
      return;
    }

    const division = department.divisions.id(divisionId);
    if (!division) {
      res.status(404).json({
        message: "Division not found",
        error: "Division not found",
      });
      return;
    }

    division.deleteOne();
    await department.save();
    res.json(formatDepartment(department));
  } catch (err) {
    next(err);
  }
}

router.get("/", listDepartments);
router.post("/", createDepartment);
router.get("/:id", getDepartmentById);
router.patch("/:id", updateDepartment);
router.delete("/:id", deleteDepartment);
router.post("/:id/divisions", addDivision);
router.patch("/:id/divisions/:divisionId", updateDivision);
router.delete("/:id/divisions/:divisionId", deleteDivision);

module.exports = {
  router,
  listDepartments,
  formatDepartment,
};
