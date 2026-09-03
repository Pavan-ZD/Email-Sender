const nodemailer = require("nodemailer");
const fs = require("fs");
const path = require("path");
const sharp = require("sharp");
const AWS = require("aws-sdk");
const mysql = require("mysql2/promise");

const attachmentDirectory = __dirname;
const attachmentFiles = fs
  .readdirSync(attachmentDirectory)
  .filter((fileName) =>
    fs.statSync(path.join(attachmentDirectory, fileName)).isFile(),
  );

const s3 = new AWS.S3({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  accessKeyId: process.env.DO_SPACES_KEY,
  secretAccessKey: process.env.DO_SPACES_SECRET,
  region: process.env.DO_SPACES_REGION,
  signatureVersion: "v4",
});

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

const imageExtensions = new Set([
  ".jpg",
  ".jpeg",
  ".png",
  ".webp",
  ".gif",
  ".bmp",
]);

const videoExtensions = new Set([
  ".mp4",
  ".mov",
  ".avi",
  ".mkv",
  ".webm",
  ".m4v",
  ".wmv",
  ".flv",
]);

const generatePlaceholderThumbnail = async (label = "FILE") => {
  const safeLabel = String(label || "FILE")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 12)
    .toUpperCase();

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#0f172a"/>
          <stop offset="100%" stop-color="#1d4ed8"/>
        </linearGradient>
      </defs>
      <rect width="240" height="140" fill="url(#g)" rx="12"/>
      <circle cx="84" cy="70" r="24" fill="rgba(255,255,255,0.18)"/>
      <path d="M76 56 L106 70 L76 84 Z" fill="#fff"/>
      <text x="120" y="95" text-anchor="middle" font-family="Arial, sans-serif" font-size="20" font-weight="700" fill="#ffffff">${safeLabel}</text>
    </svg>
  `;

  const imageBuffer = await sharp(Buffer.from(svg))
    .resize({ width: 240, height: 140, fit: "cover" })
    .png()
    .toBuffer();

  return `data:image/png;base64,${imageBuffer.toString("base64")}`;
};

const generateThumbnailFromSource = async (
  sourcePath,
  fallbackName = "FILE",
) => {
  if (!sourcePath || !fs.existsSync(sourcePath)) {
    return null;
  }

  const ext = path.extname(sourcePath).toLowerCase();

  if (imageExtensions.has(ext)) {
    const buffer = await sharp(sourcePath)
      .resize({
        width: 240,
        height: 240,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 72, progressive: true })
      .toBuffer();

    return `data:image/jpeg;base64,${buffer.toString("base64")}`;
  }

  if (videoExtensions.has(ext)) {
    const label = path.basename(sourcePath, ext) || fallbackName;
    return generatePlaceholderThumbnail(label);
  }

  return null;
};

const generateThumbnailForName = async (name, key) => {
  const localPath = findAttachment(name);
  if (localPath) {
    return generateThumbnailFromSource(localPath, name);
  }

  const sourceKey = key || name;
  const ext = path.extname(String(sourceKey)).toLowerCase();

  if (imageExtensions.has(ext)) {
    const label = path.basename(sourceKey, ext) || name || "IMAGE";
    return generateThumbnailFromSource(
      path.join(attachmentDirectory, `${path.basename(sourceKey)}`),
      label,
    );
  }

  if (videoExtensions.has(ext)) {
    const label = path.basename(sourceKey, ext) || name || "VIDEO";
    return generatePlaceholderThumbnail(label);
  }

  return generatePlaceholderThumbnail(name || "FILE");
};

const normalizeUrlList = (value) => {
  if (!value) return [];

  if (Array.isArray(value)) {
    return value.flatMap((entry) => normalizeUrlList(entry));
  }

  if (typeof value === "string") {
    return value.trim() ? [value.trim()] : [];
  }

  if (typeof value === "object") {
    const itemUrl = value.url || value.link || value.downloadUrl || value.href;
    const itemName = value.name || value.filename || value.title;

    if (itemUrl && typeof itemUrl === "string") {
      return [{ name: itemName || itemUrl, url: itemUrl }];
    }
  }

  return [];
};

const buildLinkMessage = ({ text, html, links }) => {
  const normalizedLinks = links.filter((item) => item && item.url);

  if (!normalizedLinks.length) {
    return { text, html };
  }

  const listText = normalizedLinks
    .map((item) => `${item.name || "File"}: ${item.url}`)
    .join("\n");

  const defaultThumbnail =
    "https://placehold.co/240x140/0f172a/ffffff?text=Download";

  const listHtml = normalizedLinks
    .map((item) => {
      const thumbnailUrl = item.thumbnailUrl || defaultThumbnail;
      return `
        <div style="margin-bottom: 18px;">
          <a href="${item.url}" target="_blank" rel="noopener noreferrer">
            <img
              src="${thumbnailUrl}"
              alt="${item.name || "Download file"}"
              style="width: 220px; height: auto; border-radius: 8px; display: block; margin-bottom: 8px; border: 1px solid #e2e8f0;"
            />
          </a>
          <a href="${item.url}" target="_blank" rel="noopener noreferrer" style="color: #0f172a; text-decoration: none; font-weight: 600;">
            ${item.name || "Download file"}
          </a>
        </div>
      `;
    })
    .join("");

  return {
    text: [text, "\n\nDownload links:\n", listText].filter(Boolean).join(""),
    html: [html, listHtml].filter(Boolean).join(""),
  };
};

const getPresignedUrl = (key) => {
  if (!key || !process.env.DO_SPACES_BUCKET) {
    return null;
  }

  return s3.getSignedUrl("getObject", {
    Bucket: process.env.DO_SPACES_BUCKET,
    Key: key,
    Expires: Number(process.env.DO_SPACES_URL_EXPIRES || 3600),
  });
};

console.log("DigitalOcean Spaces configuration:", {
  bucket: process.env.DO_SPACES_BUCKET,
  endpoint: process.env.DO_SPACES_ENDPOINT,
  key: process.env.DO_SPACES_KEY ? "configured" : "not configured",
  secret: process.env.DO_SPACES_SECRET ? "configured" : "not configured",
  region: process.env.DO_SPACES_REGION,
  urlExpires: process.env.DO_SPACES_URL_EXPIRES || "3600",
});

const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
});

const findFilesByNames = async (names) => {
  const fileLookup = new Map();

  if (!Array.isArray(names) || !names.length) {
    return fileLookup;
  }

  const normalizedNames = names
    .filter((name) => typeof name === "string" && name.trim())
    .map((name) => name.trim().toLowerCase());

  if (!normalizedNames.length) {
    return fileLookup;
  }

  try {
    const placeholders = normalizedNames.map(() => "?").join(", ");
    const [rows] = await db.query(
      `SELECT name, key_path AS file_key, thumbnail_url AS thumbnailUrl FROM files WHERE LOWER(name) IN (${placeholders})`,
      normalizedNames,
    );
    console.log("DB lookup results:", rows);

    (rows || []).forEach((row) => {
      fileLookup.set(String(row.name).toLowerCase(), {
        key: row.file_key,
        thumbnailUrl: row.thumbnailUrl || row.imageUrl || null,
      });
    });
  } catch (error) {
    console.error("DB lookup failed:", error);
  }

  return fileLookup;
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

  const attachmentNames = Array.isArray(attachmentName)
    ? attachmentName
    : attachmentName
      ? [attachmentName]
      : [];

  if (attachmentNames.length) {
    const foundFiles = await findFilesByNames(attachmentNames);
    const dbLinks = [];
    let dbMatchFound = false;

    for (const name of attachmentNames) {
      const normalizedName = String(name).trim();
      const lookupKey = normalizedName.toLowerCase();
      const fileRecord = foundFiles.get(lookupKey);

      if (!fileRecord) {
        continue;
      }

      dbMatchFound = true;
      const signedUrl = getPresignedUrl(fileRecord.key);
      if (!signedUrl) {
        throw new Error(
          `DigitalOcean Spaces is not configured for attachment "${normalizedName}". Add DO_SPACES_BUCKET, DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_ENDPOINT, and DO_SPACES_REGION.`,
        );
      }

      let thumbnailUrl = fileRecord.thumbnailUrl || null;
      if (!thumbnailUrl) {
        thumbnailUrl = await generateThumbnailForName(
          normalizedName,
          fileRecord.key,
        );
      }

      dbLinks.push({
        name: normalizedName,
        url: signedUrl,
        thumbnailUrl,
      });
    }

    if (dbLinks.length) {
      const linkMessage = buildLinkMessage({
        text: message.text,
        html: message.html,
        links: dbLinks,
      });
      message.text = linkMessage.text;
      message.html = linkMessage.html;
      return transport.sendMail(message);
    }

    if (dbMatchFound) {
      throw new Error(
        "Database file matched, but no signed URL could be generated. Check your DigitalOcean Spaces configuration.",
      );
    }
  }

  const attachmentPaths = attachmentNames.map(findAttachment);

  const missingIndex = attachmentPaths.findIndex(
    (attachmentPath) => !attachmentPath,
  );
  if (missingIndex !== -1) {
    throw new Error(`Attachment not found: ${attachmentNames[missingIndex]}`);
  }

  return transport.sendMail(message);
};

module.exports = { sendEmail };
