// authz.js
export const requireRole = (...roles) => (req, res, next) => {
  try {
    const user = req.user; // assume populated by your JWT middleware
    if (!user || !roles.includes(user.role)) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
};
