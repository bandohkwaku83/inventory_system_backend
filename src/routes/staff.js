const express = require("express");
const mongoose = require("mongoose");
const Staff = require("../models/Staff");
const Attendance = require("../models/Attendance");
const User = require("../models/User");
const {
  STAFF_GENDERS,
  STAFF_RELATIONSHIPS,
  STAFF_DEPARTMENTS,
  STAFF_EMPLOYMENT_TYPES,
  STAFF_STATUSES,
} = require("../models/Staff");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);
router.use(requireEntitlement("staff", "payroll"));

const EMAIL_RE =
  /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;
const GHANA_CARD_RE = /^GHA-\d{9}-\d$/;

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

function parseDateOnly(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return { value: null };
  }
  const raw =
    value instanceof Date
      ? value.toISOString().slice(0, 10)
      : String(value).trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    return { error: `${fieldName} must be a valid date (YYYY-MM-DD)` };
  }
  const [y, m, day] = raw.split("-").map(Number);
  const iso = new Date(Date.UTC(y, m - 1, day));
  if (
    iso.getUTCFullYear() !== y ||
    iso.getUTCMonth() !== m - 1 ||
    iso.getUTCDate() !== day
  ) {
    return { error: `${fieldName} must be a valid date (YYYY-MM-DD)` };
  }
  return { value: iso };
}

function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function parseMoney(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return { value: 0 };
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n < 0) {
    return { error: `${fieldName} must be a non-negative number` };
  }
  return { value: Math.round(n * 100) / 100 };
}

function validateEmergencyContact(raw) {
  if (!raw || typeof raw !== "object") {
    return { error: "emergencyContact is required" };
  }
  const fullName = str(raw, "fullName") ?? "";
  if (!fullName) {
    return { error: "emergencyContact.fullName is required" };
  }
  const relationship = str(raw, "relationship") ?? "";
  if (!relationship || !STAFF_RELATIONSHIPS.includes(relationship)) {
    return {
      error: `emergencyContact.relationship must be one of: ${STAFF_RELATIONSHIPS.join(", ")}`,
    };
  }
  const phone = str(raw, "phone") ?? "";
  if (!phone) {
    return { error: "emergencyContact.phone is required" };
  }
  return {
    value: {
      fullName,
      relationship,
      phone,
      alternatePhone: str(raw, "alternatePhone") ?? "",
    },
  };
}

function buildStaffPayload(body, { partial = false } = {}) {
  const updates = {};

  const take = (key) => (partial ? hasField(body, key) : true);

  if (take("fullName")) {
    if (!partial || hasField(body, "fullName")) {
      const fullName = str(body, "fullName") ?? "";
      if (!fullName) return { error: partial ? "fullName cannot be empty" : "fullName is required" };
      updates.fullName = fullName;
    }
  } else if (!partial) {
    return { error: "fullName is required" };
  }

  if (hasField(body, "dateOfBirth")) {
    const dob = parseDateOnly(body.dateOfBirth, "dateOfBirth");
    if (dob.error) return { error: dob.error };
    updates.dateOfBirth = dob.value;
  }

  if (hasField(body, "gender")) {
    const gender = str(body, "gender");
    if (!gender) {
      updates.gender = undefined;
    } else if (!STAFF_GENDERS.includes(gender)) {
      return { error: `gender must be one of: ${STAFF_GENDERS.join(", ")}` };
    } else {
      updates.gender = gender;
    }
  }

  if (hasField(body, "ghanaCardId") || !partial) {
    const ghanaCardId = (str(body, "ghanaCardId") ?? "").toUpperCase();
    if (ghanaCardId && !GHANA_CARD_RE.test(ghanaCardId)) {
      return { error: "ghanaCardId must match GHA-XXXXXXXXX-X" };
    }
    updates.ghanaCardId = ghanaCardId;
  }

  if (hasField(body, "phone") || !partial) {
    const phone = str(body, "phone") ?? "";
    if (!phone) return { error: partial ? "phone cannot be empty" : "phone is required" };
    updates.phone = phone;
  }

  if (hasField(body, "email") || !partial) {
    const email = str(body, "email") ?? "";
    if (email && !EMAIL_RE.test(email)) {
      return { error: "Invalid email address" };
    }
    updates.email = email;
  }

  if (hasField(body, "city") || !partial) {
    updates.city = str(body, "city") ?? "";
  }

  if (hasField(body, "residentialAddress") || !partial) {
    updates.residentialAddress = str(body, "residentialAddress") ?? "";
  }

  if (hasField(body, "emergencyContact") || !partial) {
    const ec = validateEmergencyContact(body.emergencyContact);
    if (ec.error) return { error: ec.error };
    updates.emergencyContact = ec.value;
  }

  if (hasField(body, "role") || !partial) {
    const role = str(body, "role") ?? "";
    if (!role) return { error: partial ? "role cannot be empty" : "role is required" };
    updates.role = role;
  }

  if (hasField(body, "department")) {
    const department = str(body, "department");
    if (!department) {
      updates.department = undefined;
    } else if (!STAFF_DEPARTMENTS.includes(department)) {
      return { error: `department must be one of: ${STAFF_DEPARTMENTS.join(", ")}` };
    } else {
      updates.department = department;
    }
  }

  if (hasField(body, "hireDate") || !partial) {
    const hire = parseDateOnly(body.hireDate, "hireDate");
    if (hire.error) return { error: hire.error };
    if (!hire.value) return { error: "hireDate is required" };
    updates.hireDate = hire.value;
  }

  if (hasField(body, "employmentType")) {
    const employmentType = str(body, "employmentType") ?? "";
    if (!STAFF_EMPLOYMENT_TYPES.includes(employmentType)) {
      return {
        error: `employmentType must be one of: ${STAFF_EMPLOYMENT_TYPES.join(", ")}`,
      };
    }
    updates.employmentType = employmentType;
  } else if (!partial) {
    updates.employmentType = "full_time";
  }

  if (hasField(body, "status")) {
    const status = str(body, "status") ?? "";
    if (!STAFF_STATUSES.includes(status)) {
      return { error: `status must be one of: ${STAFF_STATUSES.join(", ")}` };
    }
    updates.status = status;
  } else if (!partial) {
    updates.status = "active";
  }

  for (const moneyField of [
    "baseSalary",
    "transport",
    "otherAllowances",
    "ssnitDeduction",
    "payeDeduction",
  ]) {
    if (hasField(body, moneyField) || !partial) {
      const m = parseMoney(body[moneyField], moneyField);
      if (m.error) return { error: m.error };
      updates[moneyField] = m.value;
    }
  }

  if (hasField(body, "bankName") || !partial) {
    updates.bankName = str(body, "bankName") ?? "";
  }

  if (hasField(body, "accountNumber") || !partial) {
    updates.accountNumber = str(body, "accountNumber") ?? "";
  }

  if (hasField(body, "notes") || !partial) {
    updates.notes = str(body, "notes") ?? "";
  }

  return { value: updates };
}

router.get("/meta", (_req, res) => {
  res.json({
    genders: STAFF_GENDERS,
    relationships: STAFF_RELATIONSHIPS,
    departments: STAFF_DEPARTMENTS,
    employmentTypes: STAFF_EMPLOYMENT_TYPES,
    statuses: STAFF_STATUSES,
  });
});

router.get("/summary", async (req, res, next) => {
  try {
    const dateResult = parseDateOnly(
      req.query.date || startOfUtcDay().toISOString().slice(0, 10),
      "date"
    );
    if (dateResult.error) {
      res.status(400).json({ message: dateResult.error });
      return;
    }
    const day = dateResult.value;
    const nextDay = new Date(day);
    nextDay.setUTCDate(nextDay.getUTCDate() + 1);

    const activeStaff = await Staff.countDocuments({ status: "active" });
    const activeIds = await Staff.find({ status: "active" }).select("_id").lean();
    const idList = activeIds.map((s) => s._id);

    const marks = await Attendance.find({
      staffId: { $in: idList },
      date: { $gte: day, $lt: nextDay },
    }).lean();

    let presentToday = 0;
    let absentToday = 0;
    let lateToday = 0;
    for (const m of marks) {
      if (m.status === "present") presentToday += 1;
      else if (m.status === "absent") absentToday += 1;
      else if (m.status === "late") lateToday += 1;
    }

    res.json({
      date: day.toISOString().slice(0, 10),
      activeStaff,
      presentToday,
      absentToday,
      lateToday,
      unmarked: Math.max(0, activeStaff - marks.length),
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const filter = {};
    if (req.query.status && STAFF_STATUSES.includes(req.query.status)) {
      filter.status = req.query.status;
    }
    if (req.query.department && STAFF_DEPARTMENTS.includes(req.query.department)) {
      filter.department = req.query.department;
    }
    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      filter.$or = [
        { fullName: re },
        { employeeId: re },
        { role: re },
        { phone: re },
      ];
    }

    const staff = await Staff.find(filter).sort({ fullName: 1 }).lean();
    res.json(staff);
  } catch (err) {
    next(err);
  }
});

async function nextEmployeeId() {
  const docs = await Staff.find({ employeeId: /^EMP-\d+$/i })
    .select("employeeId")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.employeeId).slice(4), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `EMP-${String(max + 1).padStart(3, "0")}`;
}

router.post("/", async (req, res, next) => {
  try {
    const result = buildStaffPayload(req.body || {}, { partial: false });
    if (result.error) {
      res.status(400).json({ message: result.error });
      return;
    }

    let staff;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        staff = await Staff.create({
          ...result.value,
          employeeId: await nextEmployeeId(),
        });
        break;
      } catch (err) {
        if (err.code === 11000 && err.keyPattern?.employeeId && attempt < 4) {
          continue;
        }
        throw err;
      }
    }

    res.status(201).json(staff.toJSON());
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ message: "A staff member with this employeeId already exists" });
      return;
    }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    if (!mongoose.Types.ObjectId.isValid(req.params.id)) {
      res.status(400).json({ message: "Invalid staff id" });
      return;
    }
    const staff = await Staff.findById(req.params.id).lean();
    if (!staff) {
      res.status(404).json({ message: "Staff member not found" });
      return;
    }
    res.json(staff);
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid staff id" });
      return;
    }

    const staff = await Staff.findById(id);
    if (!staff) {
      res.status(404).json({ message: "Staff member not found" });
      return;
    }

    const result = buildStaffPayload(req.body || {}, { partial: true });
    if (result.error) {
      res.status(400).json({ message: result.error });
      return;
    }

    for (const [key, value] of Object.entries(result.value)) {
      if (value === undefined) {
        staff.set(key, undefined);
      } else {
        staff[key] = value;
      }
    }

    try {
      await staff.save();
    } catch (err) {
      if (err.code === 11000) {
        res.status(409).json({ message: "A staff member with this employeeId already exists" });
        return;
      }
      throw err;
    }

    if (result.value.fullName) {
      await User.updateMany(
        { staffId: staff._id },
        { $set: { name: staff.fullName } }
      );
    }

    res.json(staff.toJSON());
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const { id } = req.params;
    if (!mongoose.Types.ObjectId.isValid(id)) {
      res.status(400).json({ message: "Invalid staff id" });
      return;
    }

    const linkedUser = await User.findOne({ staffId: id }).lean();
    if (linkedUser) {
      res.status(409).json({
        message: "Cannot delete staff member: a user account is linked to them",
      });
      return;
    }

    const removed = await Staff.findByIdAndDelete(id).lean();
    if (!removed) {
      res.status(404).json({ message: "Staff member not found" });
      return;
    }

    await Attendance.deleteMany({ staffId: id });
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
