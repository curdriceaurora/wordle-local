function isAuthorizedRequest(req, config) {
  const adminKey = String(config?.adminKey || "");
  const requireAdminKey = config?.requireAdminKey === true;

  if (!adminKey) {
    return !requireAdminKey;
  }

  return req.headers["x-admin-key"] === adminKey;
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
