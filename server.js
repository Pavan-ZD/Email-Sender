require("dotenv").config();
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const { sendEmail } = require("./mailer");
const {
  saveFile,
  findExistingHashes,
  normalizeHash,
} = require("./file-storage");
const { readFileSync } = require("fs");

const privateKey = readFileSync("/etc/pki/tls/private/zerodistance_io.key");
const certificate = readFileSync(
  "/etc/pki/tls/certs/STAR_zerodistance_io_2026.crt",
);
const intCertificate = readFileSync(
  "/etc/pki/tls/certs/STAR_zerodistance_io_2026.ca-bundle",
);
const credentials = {
  key: privateKey,
  cert: certificate,
  ca: intCertificate,
};
const app = express({ https: credentials });

app.use(cors());
app.use(express.json());

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: Number(process.env.UPLOAD_MAX_SIZE_MB || 500) * 1024 * 1024,
  },
});

// Simple email format check (not exhaustive, just a sanity check)
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Email API is running" });
});

app.post(
  "/api/files",
  (req, res, next) => {
    upload.single("file")(req, res, (error) => {
      if (error) {
        return next(error);
      }
      return next();
    });
  },
  async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({
          success: false,
          error: 'Send one file using the multipart field name "file".',
        });
      }

      const savedFile = await saveFile(req.file);
      return res.status(201).json({
        success: true,
        message: "File uploaded successfully",
        file: savedFile,
      });
    } catch (error) {
      console.error("Error uploading file:", error);
      return res.status(500).json({
        success: false,
        error: "Failed to upload file",
        details: error.message,
      });
    }
  },
);

/**
 * POST /api/files/exists
 * Body: { "hash": "<file hash>" }          -> { "success": true, "exists": true | false }
 * Body: { "hash": ["<hash1>", "<hash2>"] } -> { "success": true, "results": [{ "hash": "<hash1>", "exists": true }, ...] }
 */
app.post("/api/files/exists", async (req, res) => {
  try {
    const { hash } = req.body || {};
    const isList = Array.isArray(hash);
    const hashes = isList ? hash : [hash];

    if (
      !hashes.length ||
      hashes.some((item) => typeof item !== "string" || !item.trim())
    ) {
      return res.status(400).json({
        success: false,
        error:
          '"hash" must be a non-empty string or an array of non-empty strings.',
      });
    }

    const existing = await findExistingHashes(hashes);

    if (!isList) {
      return res
        .status(200)
        .json({ success: true, exists: existing.has(normalizeHash(hash)) });
    }

    return res.status(200).json({
      success: true,
      results: hashes.map((item) => ({
        hash: item,
        exists: existing.has(normalizeHash(item)),
      })),
    });
  } catch (error) {
    console.error("Error checking file hash:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to check file",
      details: error.message,
    });
  }
});

/**
 * POST /api/send-email
 * Body: { "to": "person@example.com", "subject": "Hi", "text": "Hello!", "attachmentHash": ["<hash from /api/files>", "..."] }
 */
app.post("/api/send-email", async (req, res) => {
  try {
    const { to, subject, text, html, attachmentHash } = req.body;

    if (!to || !subject || (!text && !html)) {
      return res.status(400).json({
        success: false,
        error:
          'Fields "to", "subject", and one of "text" or "html" are required.',
      });
    }

    if (!isValidEmail(to)) {
      return res.status(400).json({
        success: false,
        error: `"${to}" is not a valid email address.`,
      });
    }

    const attachmentHashes = Array.isArray(attachmentHash)
      ? attachmentHash
      : attachmentHash
        ? [attachmentHash]
        : [];

    if (
      attachmentHashes.some((hash) => typeof hash !== "string" || !hash.trim())
    ) {
      return res.status(400).json({
        success: false,
        error:
          '"attachmentHash" must be a file hash or an array of file hashes.',
      });
    }

    const info = await sendEmail({
      to,
      subject,
      text,
      html,
      attachmentHash: attachmentHashes,
    });

    return res.status(200).json({
      success: true,
      message: `Email sent to ${to}`,
      messageId: info.messageId,
    });
  } catch (err) {
    console.error("Error sending email:", err);
    return res.status(500).json({
      success: false,
      error: "Failed to send email",
      details: err.message,
    });
  }
});

app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    const message =
      error.code === "LIMIT_FILE_SIZE"
        ? `File is too large. Maximum size is ${process.env.UPLOAD_MAX_SIZE_MB || 500} MB.`
        : error.message;
    return res.status(400).json({ success: false, error: message });
  }

  console.error("Unhandled API error:", error);
  return res.status(500).json({
    success: false,
    error: "Internal server error",
    details: error.message,
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Email API listening on port ${PORT}`);
});
