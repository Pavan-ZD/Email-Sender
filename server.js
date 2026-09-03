require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { sendEmail } = require("./mailer");

const app = express();
app.use(cors());
app.use(express.json());

// Simple email format check (not exhaustive, just a sanity check)
const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

app.get("/", (req, res) => {
  res.json({ status: "ok", message: "Email API is running" });
});

/**
 * POST /api/send-email
 * Body: { "to": "person@example.com", "subject": "Hi", "text": "Hello!", "attachmentName": ["KR 4 R600-3", "KR C5 micro"] }
 */
app.post("/api/send-email", async (req, res) => {
  try {
    const { to, subject, text, html, attachmentName } = req.body;

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

    const attachmentNames = Array.isArray(attachmentName)
      ? attachmentName
      : attachmentName
        ? [attachmentName]
        : [];

    if (
      attachmentNames.some((name) => typeof name !== "string" || !name.trim())
    ) {
      return res.status(400).json({
        success: false,
        error: '"attachmentName" must be a filename or an array of filenames.',
      });
    }

    const info = await sendEmail({
      to,
      subject,
      text,
      html,
      attachmentName: attachmentNames,
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Email API listening on port ${PORT}`);
});
