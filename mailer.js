const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");

const attachmentDirectory = __dirname;
const attachmentFiles = fs
  .readdirSync(attachmentDirectory)
  .filter((fileName) =>
    fs.statSync(path.join(attachmentDirectory, fileName)).isFile(),
  );

const normalizeAttachmentName = (value) => {
  const parsed = path.parse(String(value || "").trim());
  const baseName = parsed.name || String(value || "").trim();

  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const findAttachment = (attachmentName) => {
  if (typeof attachmentName !== "string" || !attachmentName.trim()) {
    return null;
  }

  const requestedName = normalizeAttachmentName(attachmentName);
  const matchingFile = attachmentFiles.find((fileName) => {
    const fileNameNormalized = normalizeAttachmentName(fileName);
    return (
      fileNameNormalized === requestedName ||
      fileNameNormalized.includes(requestedName) ||
      requestedName.includes(fileNameNormalized)
    );
  });

  return matchingFile ? path.join(attachmentDirectory, matchingFile) : null;
};

const config = {
  ...(process.env.SMTP_SERVICE
    ? { service: process.env.SMTP_SERVICE }
    : { host: process.env.SMTP_HOST }),
  port: Number(process.env.SMTP_PORT || 587),
  secure: process.env.SMTP_SECURE === "true",
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

const sendEmail = async ({
  to,
  subject,
  text,
  html,
  replyTo,
  attachmentName,
}) => {
  const transport = nodemailer.createTransport(config);
  const message = {
    from: process.env.MAIL_FROM || process.env.SMTP_USER,
    to,
    subject,
    text,
    html,
    replyTo,
  };

  const attachmentNames = attachmentName
    ? Array.isArray(attachmentName)
      ? attachmentName
      : [attachmentName]
    : [];
  const attachmentPaths = attachmentNames.map(findAttachment);

  const missingIndex = attachmentPaths.findIndex(
    (attachmentPath) => !attachmentPath,
  );
  if (missingIndex !== -1) {
    throw new Error(`Attachment not found: ${attachmentNames[missingIndex]}`);
  }
  if (attachmentPaths.length) {
    message.attachments = attachmentPaths.map((attachmentPath) => ({
      filename: path.basename(attachmentPath),
      path: attachmentPath,
    }));
  }

  return transport.sendMail(message);
};

module.exports = { sendEmail };
