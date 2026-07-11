const express = require("express");
const mongoose = require("mongoose");
const Staff = require("../models/Staff");
const Attendance = require("../models/Attendance");
const { ATTENDANCE_STATUSES } = require("../models/Attendance");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);
router.use(requireEntitlement("staff_attendance", "staff", "payroll"));

function parseDateOnly(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return { error: `${fieldName} is required (YYYY-MM-DD)` };
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
  return { value: iso, iso: raw };
}

function startOfUtcDay(d = new Date()) {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function addUtcDays(date, n) {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + n);
  return d;
}

function toIsoDate(d) {
  return d.toISOString().slice(0, 10);
}

/** Calendar weeks within a month: week 1 = days 1–7, week 2 = 8–14, etc. */
function weekRangeInMonth(year, month, week) {
  const startDay = (week - 1) * 7 + 1;
  const lastDayOfMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (startDay > lastDayOfMonth) {
    return null;
  }
  const from = new Date(Date.UTC(year, month - 1, startDay));
  const endDay = Math.min(startDay + 6, lastDayOfMonth);
  const to = new Date(Date.UTC(year, month - 1, endDay));
  return { from, to };
}

router.get("/meta", (_req, res) => {
  res.json({ statuses: ATTENDANCE_STATUSES });
});

/** Daily attendance sheet: active staff + today's mark (if any). */
router.get("/daily", async (req, res, next) => {
  try {
    const dateRaw =
      req.query.date || toIsoDate(startOfUtcDay());
    const dateResult = parseDateOnly(dateRaw, "date");
    if (dateResult.error) {
      res.status(400).json({ message: dateResult.error });
      return;
    }
    const day = dateResult.value;
    const nextDay = addUtcDays(day, 1);

    const staff = await Staff.find({ status: "active" })
      .sort({ fullName: 1 })
      .select("_id fullName role employeeId status")
      .lean();

    const marks = await Attendance.find({
      staffId: { $in: staff.map((s) => s._id) },
      date: { $gte: day, $lt: nextDay },
    }).lean();

    const byStaff = new Map(marks.map((m) => [String(m.staffId), m]));

    res.json({
      date: dateResult.iso,
      staff: staff.map((s) => {
        const mark = byStaff.get(String(s._id));
        return {
          staffId: s._id,
          fullName: s.fullName,
          role: s.role,
          employeeId: s.employeeId,
          status: mark ? mark.status : null,
          attendanceId: mark ? mark._id : null,
        };
      }),
    });
  } catch (err) {
    next(err);
  }
});

/** Weekly history grid for Attendance History tab. */
router.get("/history", async (req, res, next) => {
  try {
    let from;
    let to;

    if (req.query.from && req.query.to) {
      const fromR = parseDateOnly(req.query.from, "from");
      const toR = parseDateOnly(req.query.to, "to");
      if (fromR.error) {
        res.status(400).json({ message: fromR.error });
        return;
      }
      if (toR.error) {
        res.status(400).json({ message: toR.error });
        return;
      }
      from = fromR.value;
      to = toR.value;
    } else {
      const year = Number(req.query.year) || startOfUtcDay().getUTCFullYear();
      const month = Number(req.query.month) || startOfUtcDay().getUTCMonth() + 1;
      const week = Number(req.query.week) || 1;
      if (
        !Number.isInteger(year) ||
        !Number.isInteger(month) ||
        month < 1 ||
        month > 12 ||
        !Number.isInteger(week) ||
        week < 1 ||
        week > 6
      ) {
        res.status(400).json({
          message: "Provide from&to (YYYY-MM-DD) or year, month (1-12), and week (1-6)",
        });
        return;
      }
      ({ from, to } = weekRangeInMonth(year, month, week) || {});
      if (!from || !to) {
        res.status(400).json({
          message: `week ${week} is out of range for ${year}-${String(month).padStart(2, "0")}`,
        });
        return;
      }
    }

    if (to < from) {
      res.status(400).json({ message: "to must be on or after from" });
      return;
    }

    const days = [];
    for (let d = new Date(from); d <= to; d = addUtcDays(d, 1)) {
      days.push(toIsoDate(d));
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    const staffFilter = { status: "active" };
    if (q) {
      const re = new RegExp(q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
      staffFilter.$or = [{ fullName: re }, { role: re }, { employeeId: re }];
    }

    const staff = await Staff.find(staffFilter)
      .sort({ fullName: 1 })
      .select("_id fullName role employeeId")
      .lean();

    const rangeEnd = addUtcDays(to, 1);
    const marks = await Attendance.find({
      staffId: { $in: staff.map((s) => s._id) },
      date: { $gte: from, $lt: rangeEnd },
    }).lean();

    const byStaff = new Map();
    for (const m of marks) {
      const key = String(m.staffId);
      if (!byStaff.has(key)) byStaff.set(key, {});
      byStaff.get(key)[toIsoDate(m.date)] = m.status;
    }

    res.json({
      from: toIsoDate(from),
      to: toIsoDate(to),
      days,
      rows: staff.map((s) => ({
        staff: {
          _id: s._id,
          fullName: s.fullName,
          role: s.role,
          employeeId: s.employeeId,
        },
        attendance: byStaff.get(String(s._id)) || {},
      })),
    });
  } catch (err) {
    next(err);
  }
});

/** Upsert a single staff member's status for a date. */
router.put("/", async (req, res, next) => {
  try {
    const staffId = req.body?.staffId;
    if (!staffId || !mongoose.Types.ObjectId.isValid(staffId)) {
      res.status(400).json({ message: "Valid staffId is required" });
      return;
    }

    const dateResult = parseDateOnly(
      req.body?.date || toIsoDate(startOfUtcDay()),
      "date"
    );
    if (dateResult.error) {
      res.status(400).json({ message: dateResult.error });
      return;
    }

    const status = typeof req.body?.status === "string" ? req.body.status.trim() : "";
    if (!status || !ATTENDANCE_STATUSES.includes(status)) {
      res.status(400).json({
        message: `status must be one of: ${ATTENDANCE_STATUSES.join(", ")}`,
      });
      return;
    }

    const staff = await Staff.findById(staffId).lean();
    if (!staff) {
      res.status(404).json({ message: "Staff member not found" });
      return;
    }
    if (staff.status !== "active") {
      res.status(409).json({ message: "Cannot mark attendance for inactive staff" });
      return;
    }

    const record = await Attendance.findOneAndUpdate(
      { staffId, date: dateResult.value },
      { $set: { status } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    res.json(record.toJSON());
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ message: "Attendance already recorded for this staff and date" });
      return;
    }
    next(err);
  }
});

/** Mark all active staff present for a date. */
router.post("/mark-all-present", async (req, res, next) => {
  try {
    const dateResult = parseDateOnly(
      req.body?.date || toIsoDate(startOfUtcDay()),
      "date"
    );
    if (dateResult.error) {
      res.status(400).json({ message: dateResult.error });
      return;
    }

    const staff = await Staff.find({ status: "active" }).select("_id").lean();
    if (staff.length === 0) {
      res.json({ date: dateResult.iso, updated: 0, records: [] });
      return;
    }

    const ops = staff.map((s) => ({
      updateOne: {
        filter: { staffId: s._id, date: dateResult.value },
        update: { $set: { status: "present" } },
        upsert: true,
      },
    }));
    await Attendance.bulkWrite(ops);

    const nextDay = addUtcDays(dateResult.value, 1);
    const records = await Attendance.find({
      staffId: { $in: staff.map((s) => s._id) },
      date: { $gte: dateResult.value, $lt: nextDay },
    }).lean();

    res.json({
      date: dateResult.iso,
      updated: records.length,
      records,
    });
  } catch (err) {
    next(err);
  }
});

/** Clear a mark (optional — returns staff to unmarked). */
router.delete("/", async (req, res, next) => {
  try {
    const staffId = req.body?.staffId || req.query.staffId;
    const dateRaw = req.body?.date || req.query.date;
    if (!staffId || !mongoose.Types.ObjectId.isValid(staffId)) {
      res.status(400).json({ message: "Valid staffId is required" });
      return;
    }
    const dateResult = parseDateOnly(dateRaw || toIsoDate(startOfUtcDay()), "date");
    if (dateResult.error) {
      res.status(400).json({ message: dateResult.error });
      return;
    }

    const removed = await Attendance.findOneAndDelete({
      staffId,
      date: dateResult.value,
    }).lean();

    if (!removed) {
      res.status(404).json({ message: "Attendance record not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
