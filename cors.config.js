// cors.config.js — central CORS policy for MaxTT API
import cors from "cors";

const ORIGINS = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);

export const corsMiddleware = cors({
  origin: function (origin, cb) {
    // allow same-origin or no-origin (curl/Hopscotch), plus configured origins
    if (!origin || ORIGINS.includes(origin)) return cb(null, true);
    return cb(new Error("CORS: origin not allowed: " + origin));
  },
  methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  allowedHeaders: [
    "Content-Type",
    "X-ADMIN-KEY",
    "X-ADMIN-USER",
    "X-SA-KEY",
    "X-SA-USER"
  ],
  credentials: false,   // we don't use cookies
  maxAge: 86400
});
