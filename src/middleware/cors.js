// src/middleware/cors.js
// Origin allow-list middleware

const ALLOW_LIST = (process.env.ALLOWED_ORIGINS ?? "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export function corsAllowList(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOW_LIST.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  }
  if (req.method === "OPTIONS") {
    return res.status(200).end();
  }
  next();
}
