const crypto = require("crypto");

// The string clients send as "Authorization: Basic <string>"
const BASIC_TOKEN = process.env.AUTH_BASIC_TOKEN;

if (!BASIC_TOKEN) {
  throw new Error("Auth is not configured. Add AUTH_BASIC_TOKEN to .env.");
}

// Compares two strings in constant time so response timing doesn't leak how much matched
const safeEqual = (a, b) => {
  const hashA = crypto.createHash("sha256").update(String(a)).digest();
  const hashB = crypto.createHash("sha256").update(String(b)).digest();
  return crypto.timingSafeEqual(hashA, hashB);
};

// Expects "Authorization: Basic <AUTH_BASIC_TOKEN>"
const requireAuth = (req, res, next) => {
  const [scheme, token] = String(req.headers.authorization || "").split(" ");

  if (scheme === "Basic" && token && safeEqual(token, BASIC_TOKEN)) {
    return next();
  }

  return res.status(401).json({
    success: false,
    error: "Unauthorized. Send a valid 'Authorization: Basic <token>' header.",
  });
};

module.exports = { requireAuth };
