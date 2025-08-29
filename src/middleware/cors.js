// src/middleware/cors.js
// Simple origin allow-list CORS middleware.
// Add/remove origins here as you go live on custom domains.

const ALLOW_LIST = new Set([
  "https://maxtt-billing-tools.onrender.com",
  // Add your custom tools domain in Step 3, e.g.:
  // "https://tools.maxtt.in"
]);

export function corsAllowList(req, res, next) {
  const origin = req.headers.origin;
  if (origin && ALLOW_LIST.has(origin)) {
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
