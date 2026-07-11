const express = require("express");
const mongoose = require("mongoose");
const Expense = require("../models/Expense");
const {
  EXPENSE_CATEGORIES,
  EXPENSE_STATUSES,
  CATEGORY_TO_CHART_ACCOUNT,
} = require("../models/Expense");
const { requireAuth, requireEntitlement } = require("../middleware/auth");

const router = express.Router();

router.use(requireAuth);
router.use(requireEntitlement("expenses"));

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

function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseDateOnly(value, fieldName) {
  if (value === undefined || value === null || value === "") {
    return { error: `${fieldName} is required` };
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

function parseMoney(value, fieldName, { required = true } = {}) {
  if (value === undefined || value === null || value === "") {
    if (required) {
      return { error: `${fieldName} is required` };
    }
    return { value: undefined };
  }
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    return { error: `${fieldName} must be a positive number` };
  }
  return { value: Math.round(n * 100) / 100 };
}

function formatExpense(doc) {
  const o = typeof doc.toObject === "function" ? doc.toObject() : { ...doc };
  if (o.date instanceof Date) {
    o.date = o.date.toISOString().slice(0, 10);
  } else if (o.date) {
    o.date = new Date(o.date).toISOString().slice(0, 10);
  }
  if (o.paidAt instanceof Date) {
    o.paidAt = o.paidAt.toISOString();
  }
  return o;
}

function parseStatus(raw) {
  if (raw === undefined || raw === null || raw === "") {
    return { value: undefined };
  }
  const s = String(raw).trim();
  const match = EXPENSE_STATUSES.find((x) => x.toLowerCase() === s.toLowerCase());
  if (!match) {
    return {
      error: `status must be one of: ${EXPENSE_STATUSES.join(", ")}`,
    };
  }
  return { value: match };
}

function parseMarkPaidFlag(body) {
  if (!body) return false;
  if (hasField(body, "markPaid")) {
    const raw = body.markPaid;
    return raw === true || raw === "true" || raw === "1" || raw === 1;
  }
  if (hasField(body, "paidNow")) {
    const raw = body.paidNow;
    return raw === true || raw === "true" || raw === "1" || raw === 1;
  }
  return false;
}

async function nextExpenseId() {
  const docs = await Expense.find({ expenseId: /^E-\d+$/i })
    .select("expenseId")
    .lean();
  let max = 0;
  for (const d of docs) {
    const n = Number.parseInt(String(d.expenseId).slice(2), 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return `E-${String(max + 1).padStart(4, "0")}`;
}

async function findExpenseByParam(idOrCode) {
  if (mongoose.Types.ObjectId.isValid(idOrCode)) {
    const byId = await Expense.findById(idOrCode);
    if (byId) return byId;
  }
  return Expense.findOne({ expenseId: String(idOrCode).trim() });
}

router.get("/meta", (_req, res) => {
  res.json({
    categories: EXPENSE_CATEGORIES,
    statuses: EXPENSE_STATUSES,
    chartAccountByCategory: CATEGORY_TO_CHART_ACCOUNT,
  });
});

router.get("/summary", async (_req, res, next) => {
  try {
    const [row] = await Expense.aggregate([
      {
        $group: {
          _id: null,
          totalAmount: { $sum: "$amount" },
          paidAmount: {
            $sum: {
              $cond: [{ $eq: ["$status", "Paid"] }, "$amount", 0],
            },
          },
          pendingAmount: {
            $sum: {
              $cond: [{ $eq: ["$status", "Pending"] }, "$amount", 0],
            },
          },
          pendingCount: {
            $sum: {
              $cond: [{ $eq: ["$status", "Pending"] }, 1, 0],
            },
          },
          expenseCount: { $sum: 1 },
        },
      },
    ]);

    res.json({
      totalAmount: Math.round((row?.totalAmount || 0) * 100) / 100,
      paidAmount: Math.round((row?.paidAmount || 0) * 100) / 100,
      pendingAmount: Math.round((row?.pendingAmount || 0) * 100) / 100,
      pendingCount: row?.pendingCount || 0,
      expenseCount: row?.expenseCount || 0,
      currency: "GHS",
    });
  } catch (err) {
    next(err);
  }
});

router.get("/", async (req, res, next) => {
  try {
    const page = Math.max(1, parseInt(String(req.query.page || "1"), 10) || 1);
    const limit = Math.min(
      100,
      Math.max(1, parseInt(String(req.query.limit || "20"), 10) || 20)
    );
    const skip = (page - 1) * limit;

    const filter = {};

    const statusResult = parseStatus(req.query.status);
    if (statusResult.error) {
      res.status(400).json({ message: statusResult.error });
      return;
    }
    if (statusResult.value) {
      filter.status = statusResult.value;
    }

    const category =
      typeof req.query.category === "string" ? req.query.category.trim() : "";
    if (category) {
      if (!EXPENSE_CATEGORIES.includes(category)) {
        res.status(400).json({
          message: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
        });
        return;
      }
      filter.category = category;
    }

    const q = typeof req.query.q === "string" ? req.query.q.trim() : "";
    if (q) {
      const rx = new RegExp(escapeRegex(q), "i");
      filter.$or = [
        { expenseId: rx },
        { description: rx },
        { reference: rx },
        { chartAccount: rx },
        { category: rx },
      ];
    }

    const [total, rows] = await Promise.all([
      Expense.countDocuments(filter),
      Expense.find(filter).sort({ date: -1, createdAt: -1 }).skip(skip).limit(limit).lean(),
    ]);

    res.json({
      items: rows.map(formatExpense),
      page,
      limit,
      total,
      totalPages: Math.max(1, Math.ceil(total / limit)),
    });
  } catch (err) {
    next(err);
  }
});

router.post("/", async (req, res, next) => {
  try {
    const body = req.body || {};

    const dateResult = parseDateOnly(body.date, "date");
    if (dateResult.error) {
      res.status(400).json({ message: dateResult.error });
      return;
    }

    const category = str(body, "category") ?? "";
    if (!category || !EXPENSE_CATEGORIES.includes(category)) {
      res.status(400).json({
        message: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
      });
      return;
    }

    const description = str(body, "description") ?? "";
    if (!description) {
      res.status(400).json({ message: "description is required" });
      return;
    }

    const amountResult = parseMoney(body.amount, "amount");
    if (amountResult.error) {
      res.status(400).json({ message: amountResult.error });
      return;
    }

    const reference = str(body, "reference") ?? "";

    let status = "Pending";
    if (parseMarkPaidFlag(body)) {
      status = "Paid";
    } else if (hasField(body, "status")) {
      const statusResult = parseStatus(body.status);
      if (statusResult.error) {
        res.status(400).json({ message: statusResult.error });
        return;
      }
      status = statusResult.value || "Pending";
    }

    const chartAccount =
      (str(body, "chartAccount") || CATEGORY_TO_CHART_ACCOUNT[category] || category);

    const payload = {
      date: dateResult.value,
      category,
      description,
      reference,
      chartAccount,
      amount: amountResult.value,
      currency: "GHS",
      status,
      paidAt: status === "Paid" ? new Date() : null,
    };

    let expense;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        expense = await Expense.create({
          ...payload,
          expenseId: await nextExpenseId(),
        });
        break;
      } catch (err) {
        if (err.code === 11000 && err.keyPattern?.expenseId && attempt < 4) {
          continue;
        }
        throw err;
      }
    }

    res.status(201).json(formatExpense(expense));
  } catch (err) {
    if (err.code === 11000) {
      res.status(409).json({ message: "An expense with this expenseId already exists" });
      return;
    }
    next(err);
  }
});

router.get("/:id", async (req, res, next) => {
  try {
    const expense = await findExpenseByParam(req.params.id);
    if (!expense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }
    res.json(formatExpense(expense));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/mark-paid", async (req, res, next) => {
  try {
    const expense = await findExpenseByParam(req.params.id);
    if (!expense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }
    if (expense.status === "Paid") {
      res.status(409).json({ message: "Expense is already paid" });
      return;
    }
    expense.status = "Paid";
    expense.paidAt = new Date();
    await expense.save();
    res.json(formatExpense(expense));
  } catch (err) {
    next(err);
  }
});

router.patch("/:id", async (req, res, next) => {
  try {
    const expense = await findExpenseByParam(req.params.id);
    if (!expense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }

    const body = req.body || {};
    const updates = {};

    if (hasField(body, "date")) {
      const dateResult = parseDateOnly(body.date, "date");
      if (dateResult.error) {
        res.status(400).json({ message: dateResult.error });
        return;
      }
      updates.date = dateResult.value;
    }

    if (hasField(body, "category")) {
      const category = str(body, "category") ?? "";
      if (!category || !EXPENSE_CATEGORIES.includes(category)) {
        res.status(400).json({
          message: `category must be one of: ${EXPENSE_CATEGORIES.join(", ")}`,
        });
        return;
      }
      updates.category = category;
      if (!hasField(body, "chartAccount")) {
        updates.chartAccount = CATEGORY_TO_CHART_ACCOUNT[category] || category;
      }
    }

    if (hasField(body, "description")) {
      const description = str(body, "description") ?? "";
      if (!description) {
        res.status(400).json({ message: "description cannot be empty" });
        return;
      }
      updates.description = description;
    }

    if (hasField(body, "reference")) {
      updates.reference = str(body, "reference") ?? "";
    }

    if (hasField(body, "chartAccount")) {
      const chartAccount = str(body, "chartAccount") ?? "";
      if (!chartAccount) {
        res.status(400).json({ message: "chartAccount cannot be empty" });
        return;
      }
      updates.chartAccount = chartAccount;
    }

    if (hasField(body, "amount")) {
      const amountResult = parseMoney(body.amount, "amount");
      if (amountResult.error) {
        res.status(400).json({ message: amountResult.error });
        return;
      }
      updates.amount = amountResult.value;
    }

    if (hasField(body, "status")) {
      const statusResult = parseStatus(body.status);
      if (statusResult.error) {
        res.status(400).json({ message: statusResult.error });
        return;
      }
      updates.status = statusResult.value;
      if (statusResult.value === "Paid" && expense.status !== "Paid") {
        updates.paidAt = new Date();
      }
      if (statusResult.value === "Pending") {
        updates.paidAt = null;
      }
    }

    if (Object.keys(updates).length === 0) {
      res.status(400).json({ message: "No updatable fields provided" });
      return;
    }

    Object.assign(expense, updates);
    await expense.save();
    res.json(formatExpense(expense));
  } catch (err) {
    next(err);
  }
});

router.delete("/:id", async (req, res, next) => {
  try {
    const expense = await findExpenseByParam(req.params.id);
    if (!expense) {
      res.status(404).json({ message: "Expense not found" });
      return;
    }
    await expense.deleteOne();
    res.status(204).send();
  } catch (err) {
    next(err);
  }
});

module.exports = router;
