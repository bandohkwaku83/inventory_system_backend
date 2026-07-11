const jwt = require("jsonwebtoken");
const User = require("../models/User");
const Role = require("../models/Role");

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set in the environment");
  }
  return secret;
}

function signToken(user, role) {
  return jwt.sign(
    {
      sub: String(user._id),
      email: user.email,
      roleId: String(user.roleId),
      roleSlug: role?.slug || null,
      tv: user.tokenVersion ?? 0,
    },
    getJwtSecret(),
    { expiresIn: process.env.JWT_EXPIRES_IN || "7d" }
  );
}

function toAuthUser(user, role) {
  const entitlements = role?.entitlements || [];
  return {
    _id: user._id,
    name: user.name,
    email: user.email,
    roleId: user.roleId,
    staffId: user.staffId || null,
    role: role
      ? {
          _id: role._id,
          name: role.name,
          slug: role.slug || null,
          entitlements,
        }
      : null,
    entitlements,
    categoryIds: user.categoryIds || [],
    active: user.active !== false,
  };
}

async function loadAuthContext(user) {
  const role = await Role.findById(user.roleId).lean();
  return { user, role };
}

async function requireAuth(req, res, next) {
  try {
    const header = req.get("Authorization") || "";
    const match = /^Bearer\s+(.+)$/i.exec(header);
    if (!match) {
      res.status(401).json({ message: "Authentication required" });
      return;
    }

    let payload;
    try {
      payload = jwt.verify(match[1], getJwtSecret());
    } catch {
      res.status(401).json({ message: "Invalid or expired token" });
      return;
    }

    const user = await User.findById(payload.sub).select("+passwordHash");
    if (!user || !user.active) {
      res.status(401).json({ message: "User not found or inactive" });
      return;
    }

    if ((payload.tv ?? 0) !== (user.tokenVersion ?? 0)) {
      res.status(401).json({ message: "Session expired. Please log in again." });
      return;
    }

    const { role } = await loadAuthContext(user);
    if (!role) {
      res.status(401).json({ message: "User role not found" });
      return;
    }

    req.user = user;
    req.authRole = role;
    req.authUser = toAuthUser(user, role);
    next();
  } catch (err) {
    next(err);
  }
}

function requireEntitlement(...entitlements) {
  return (req, res, next) => {
    const userEntitlements = req.authUser?.entitlements || [];
    const allowed = entitlements.some((key) => userEntitlements.includes(key));
    if (!allowed) {
      res.status(403).json({ message: "Insufficient permissions" });
      return;
    }
    next();
  };
}

/** @deprecated Use requireEntitlement instead. Kept for slug-based system role checks. */
function requireRole(...slugs) {
  return (req, res, next) => {
    const slug = req.authUser?.role?.slug;
    if (!slug || !slugs.includes(slug)) {
      res.status(403).json({ message: "Insufficient permissions" });
      return;
    }
    next();
  };
}

module.exports = {
  signToken,
  toAuthUser,
  loadAuthContext,
  requireAuth,
  requireEntitlement,
  requireRole,
};
