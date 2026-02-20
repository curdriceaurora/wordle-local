const nodeCrypto = require("node:crypto");

function readAdminKeyHeader(req) {
  const headerValue = req?.headers?.["x-admin-key"];
  if (typeof headerValue === "string") {
    return headerValue;
  }
  if (Array.isArray(headerValue) && headerValue.length > 0) {
    return String(headerValue[0]);
  }
  return "";
}

function timingSafeEqualString(left, right) {
  const leftBuffer = Buffer.from(String(left), "utf8");
  const rightBuffer = Buffer.from(String(right), "utf8");
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return nodeCrypto.timingSafeEqual(leftBuffer, rightBuffer);
}

function isAuthorizedRequest(req, config) {
  const adminKey = String(config?.adminKey || "");
  const requireAdminKey = config?.requireAdminKey === true;

  if (!adminKey) {
    return !requireAdminKey;
  }

  return timingSafeEqualString(readAdminKeyHeader(req), adminKey);
}

function requireAdmin(config) {
  return (req, res, next) => {
    if (isAuthorizedRequest(req, config)) {
      next();
      return;
    }
    res.status(401).json({ error: "Admin key required." });
  };
}

module.exports = {
  isAuthorizedRequest,
  requireAdmin
};
