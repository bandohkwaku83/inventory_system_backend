const ARKESEL_SEND_URL = "https://sms.arkesel.com/api/v2/sms/send";

function getApiKey() {
  return process.env.ARKESEL_API_KEY || "";
}

function getSenderId() {
  return process.env.SMS_SENDER_ID || "Onyx";
}

function isConfigured() {
  return Boolean(getApiKey());
}

/**
 * Normalize Ghana (and E.164-ish) numbers to Arkesel format: 233XXXXXXXXX
 */
function normalizePhone(raw) {
  if (raw == null) return null;
  let digits = String(raw).replace(/\D/g, "");
  if (!digits) return null;

  if (digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.startsWith("0") && digits.length === 10) {
    digits = `233${digits.slice(1)}`;
  }
  if (digits.length === 9 && /^[235]/.test(digits)) {
    digits = `233${digits}`;
  }
  if (!/^\d{10,15}$/.test(digits)) {
    return null;
  }
  return digits;
}

/**
 * Sends SMS via Arkesel. Returns { sent, reason?, data? }.
 * Soft-fails when not configured so callers can continue in local/dev.
 */
async function sendSms({ recipients, message, sender } = {}) {
  const apiKey = getApiKey();
  if (!apiKey) {
    console.warn("[sms] ARKESEL_API_KEY not set — skipped sending");
    return { sent: false, reason: "not_configured" };
  }

  const text = typeof message === "string" ? message.trim() : "";
  if (!text) {
    return { sent: false, reason: "message is required" };
  }

  const list = Array.isArray(recipients) ? recipients : [recipients];
  const normalized = [];
  const invalid = [];
  for (const r of list) {
    const n = normalizePhone(r);
    if (n) normalized.push(n);
    else if (r != null && String(r).trim()) invalid.push(String(r).trim());
  }

  if (normalized.length === 0) {
    return {
      sent: false,
      reason: "no valid recipients",
      invalid,
    };
  }

  const body = {
    sender: (sender && String(sender).trim()) || getSenderId(),
    message: text,
    recipients: [...new Set(normalized)],
  };

  try {
    const res = await fetch(ARKESEL_SEND_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "api-key": apiKey,
      },
      body: JSON.stringify(body),
    });

    const data = await res.json().catch(() => null);

    if (!res.ok) {
      const reason =
        data?.message ||
        data?.error ||
        `Arkesel HTTP ${res.status}`;
      console.error("[sms] Arkesel error:", reason, data);
      return { sent: false, reason, data, invalid };
    }

    return {
      sent: true,
      recipients: body.recipients,
      sender: body.sender,
      data,
      invalid: invalid.length ? invalid : undefined,
    };
  } catch (err) {
    console.error("[sms] Failed to send:", err.message);
    return { sent: false, reason: err.message };
  }
}

function formatGhs(amount) {
  const n = Number(amount);
  if (!Number.isFinite(n)) return "0.00";
  return n.toFixed(2);
}

/**
 * Receipt SMS after a completed sale when a customer phone is available.
 * Never throws — sale flows must not fail because of SMS.
 */
async function notifySaleReceiptSms(sale, { phone } = {}) {
  try {
    if (!sale || sale.status !== "completed") {
      return { sent: false, reason: "not_completed" };
    }

    const name = String(sale.customer || "").trim();
    const walkIn =
      !name ||
      ["walk-in", "walk in", "walkin"].includes(
        name.toLowerCase().replace(/\s+/g, " ")
      );

    let to = phone || null;
    let customerName = walkIn ? null : name;

    if (!to && sale.customerId) {
      const Customer = require("../models/Customer");
      const doc = await Customer.findById(sale.customerId)
        .select("phone name")
        .lean();
      if (doc) {
        to = doc.phone;
        customerName = doc.name || customerName;
      }
    }

    if (!to || !normalizePhone(to)) {
      return { sent: false, reason: "no_customer_phone" };
    }

    let businessName = "Onyx";
    try {
      const Settings = require("../models/Settings");
      const settings = await Settings.findById("app").lean();
      if (settings?.business?.name) {
        businessName = settings.business.name;
      }
    } catch {
      // keep default
    }

    const receipt =
      sale.receiptId || sale.receiptNumber || sale.saleNumber || "";
    const greeting = customerName ? `Hi ${customerName}` : "Hi";
    const message = [
      `${greeting}, thanks for shopping at ${businessName}.`,
      receipt ? `Receipt ${receipt}.` : null,
      `Total: GHS ${formatGhs(sale.total)}.`,
      sale.paymentMethod ? `Paid via ${sale.paymentMethod}.` : null,
    ]
      .filter(Boolean)
      .join(" ");

    return sendSms({ recipients: [to], message });
  } catch (err) {
    console.error("[sms] notifySaleReceiptSms:", err.message);
    return { sent: false, reason: err.message };
  }
}

module.exports = {
  sendSms,
  notifySaleReceiptSms,
  normalizePhone,
  isConfigured,
  getSenderId,
};
