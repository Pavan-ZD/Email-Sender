const nodemailer = require("nodemailer");
const path = require("path");
const sharp = require("sharp");
const { S3Client, GetObjectCommand } = require("@aws-sdk/client-s3");
const { getSignedUrl } = require("@aws-sdk/s3-request-presigner");
const mysql = require("mysql2/promise");

const s3 = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
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

const generatePlaceholderThumbnail = async (
  label = "FILE",
  type = "document",
) => {
  const safeLabel = String(label || "FILE")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .slice(0, 12)
    .toUpperCase();
  const palettes = [
    ["#0f172a", "#2563eb"],
    ["#3f1d38", "#be185d"],
    ["#12372a", "#16a34a"],
    ["#431407", "#ea580c"],
    ["#312e81", "#7c3aed"],
  ];
  const [startColor, endColor] =
    palettes[Math.floor(Math.random() * palettes.length)];
  const icon =
    type === "video"
      ? '<circle cx="70" cy="70" r="25" fill="rgba(255,255,255,0.2)"/><path d="M62 56 L88 70 L62 84 Z" fill="#fff"/>'
      : type === "image"
        ? '<rect x="43" y="45" width="54" height="48" rx="4" fill="rgba(255,255,255,0.15)" stroke="#fff" stroke-opacity="0.8" stroke-width="2"/><circle cx="59" cy="59" r="6" fill="#fff" fill-opacity="0.8"/><path d="M47 85l14-15 10 9 8-8 14 14" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>'
        : '<path d="M42 38h34l12 12v52H42z" fill="rgba(255,255,255,0.2)" stroke="#fff" stroke-opacity="0.8" stroke-width="2"/><path d="M76 38v14h12" fill="none" stroke="#fff" stroke-opacity="0.8" stroke-width="2"/><path d="M52 72h26M52 84h20" stroke="#fff" stroke-opacity="0.8" stroke-width="3" stroke-linecap="round"/>';

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="240" height="140" viewBox="0 0 240 140">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="${startColor}"/>
          <stop offset="100%" stop-color="${endColor}"/>
        </linearGradient>
      </defs>
      <rect width="240" height="140" fill="url(#g)" rx="12"/>
      ${icon}
      <text x="138" y="80" text-anchor="middle" font-family="Arial, sans-serif" font-size="18" font-weight="700" fill="#ffffff">${safeLabel}</text>
    </svg>
  `;

  const imageBuffer = await sharp(Buffer.from(svg))
    .resize({ width: 240, height: 140, fit: "cover" })
    .png()
    .toBuffer();

  return `data:image/png;base64,${imageBuffer.toString("base64")}`;
};

const generateThumbnailForName = async (name, key) => {
  const sourceKey = key || name;
  const ext = (
    path.extname(String(sourceKey)) || path.extname(String(name))
  ).toLowerCase();

  if (videoExtensions.has(ext)) {
    const label = path.basename(sourceKey, ext) || name || "VIDEO";
    return generatePlaceholderThumbnail(label, "video");
  }

  if (imageExtensions.has(ext)) {
    return generatePlaceholderThumbnail(
      path.basename(sourceKey, ext) || name,
      "image",
    );
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

const escapeHtml = (value) =>
  String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");

const buildLinkMessage = ({ text, html, links }) => {
  const normalizedLinks = links.filter((item) => item && item.url);

  if (!normalizedLinks.length) {
    return { text, html };
  }

  const listText = normalizedLinks
    .map((item) => `${item.name || "File"}: ${item.url}`)
    .join("\n");

  const countLabel =
    normalizedLinks.length === 1 ? "1 file" : `${normalizedLinks.length} files`;

  const listHtml = normalizedLinks
    .map((item) => {
      const safeName = escapeHtml(item.name || "Download file");
      const safeUrl = escapeHtml(item.url);
      const thumbnailUrl = escapeHtml(item.thumbnailUrl || item.url);
      return `
        <tr>
          <td style="padding: 0 0 14px 0;">
            <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="border: 1px solid #dbe3ee; border-radius: 12px; background: #ffffff;">
              <tr>
                <td style="padding: 12px; width: 150px; vertical-align: middle;">
                  <a href="${safeUrl}" target="_blank" style="text-decoration: none;">
                    <img src="${thumbnailUrl}" width="150" alt="${safeName}" style="display: block; width: 150px; height: 88px; object-fit: cover; border-radius: 8px; border: 0;" />
                  </a>
                </td>
                <td style="padding: 12px 14px 12px 4px; vertical-align: middle;">
                  <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 20px; font-weight: 700; color: #172033; word-break: break-word;">${safeName}</div>
                  <div style="font-family: Arial, sans-serif; font-size: 12px; line-height: 18px; color: #718096; padding-top: 3px;">Shared file</div>
                  <a href="${safeUrl}" target="_blank" style="display: inline-block; margin-top: 9px; padding: 8px 14px; border-radius: 6px; background: #2563eb; color: #ffffff; font-family: Arial, sans-serif; font-size: 12px; line-height: 16px; font-weight: 700; text-decoration: none;">Open file</a>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      `;
    })
    .join("");

  const listHtmlSection = `
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width: 620px; margin: 24px auto; background: #f4f7fb;">
      <tr>
        <td style="padding: 26px 22px 12px 22px;">
          <div style="font-family: Arial, sans-serif; font-size: 12px; line-height: 18px; letter-spacing: 1px; text-transform: uppercase; color: #2563eb; font-weight: 700;">Files shared with you</div>
          <div style="font-family: Arial, sans-serif; font-size: 24px; line-height: 30px; color: #172033; font-weight: 700; padding-top: 4px;">Your ${countLabel} are ready</div>
          <div style="font-family: Arial, sans-serif; font-size: 14px; line-height: 21px; color: #64748b; padding-top: 5px;">Select a file below to view or download it securely.</div>
        </td>
      </tr>
      <tr>
        <td style="padding: 8px 22px 12px 22px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">${listHtml}</table>
        </td>
      </tr>
      <tr>
        <td style="padding: 4px 22px 24px 22px; font-family: Arial, sans-serif; font-size: 11px; line-height: 17px; color: #94a3b8;">Links may expire for security. Please contact the sender if a link is no longer available.</td>
      </tr>
    </table>
  `;

  return {
    text: [text, "\n\nDownload links:\n", listText].filter(Boolean).join(""),
    html: [html, listHtmlSection].filter(Boolean).join(""),
  };
};

const getPresignedUrl = (key) => {
  if (!key || !process.env.DO_SPACES_BUCKET) {
    return null;
  }

  return getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: key,
    }),
    { expiresIn: Number(process.env.DO_SPACES_URL_EXPIRES || 3600) },
  );
};

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
    const extensionlessNames = normalizedNames.map((name) =>
      path.extname(name) ? path.basename(name, path.extname(name)) : name,
    );
    const [rows] = await db.query(
      `SELECT name, key_path AS file_key, thumbnail_url AS thumbnailUrl
       FROM files
       WHERE LOWER(name) IN (${placeholders})
          OR LOWER(SUBSTRING_INDEX(name, '.', 1)) IN (${extensionlessNames
            .map(() => "?")
            .join(", ")})`,
      [...normalizedNames, ...extensionlessNames],
    );

    console.log(rows, " DB query executed successfully.");

    (rows || []).forEach((row) => {
      const rowName = String(row.name || "");
      const record = {
        name: rowName,
        key: row.file_key,
        thumbnailUrl: row.thumbnailUrl || row.imageUrl || null,
      };
      fileLookup.set(rowName.toLowerCase(), record);
      const normalizedRowName = normalizeAttachmentName(rowName);
      fileLookup.set(normalizedRowName, record);
      fileLookup.set(
        normalizeAttachmentName(path.basename(rowName, path.extname(rowName))),
        record,
      );
    });
  } catch (error) {
    throw new Error(`Database attachment lookup failed: ${error.message}`);
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
      const fileRecord =
        foundFiles.get(lookupKey) ||
        foundFiles.get(normalizeAttachmentName(normalizedName));

      if (!fileRecord) {
        continue;
      }

      dbMatchFound = true;
      const signedUrl = await getPresignedUrl(fileRecord.key);
      if (!signedUrl) {
        throw new Error(
          `DigitalOcean Spaces is not configured for attachment "${normalizedName}". Add DO_SPACES_BUCKET, DO_SPACES_KEY, DO_SPACES_SECRET, DO_SPACES_ENDPOINT, and DO_SPACES_REGION.`,
        );
      }

      let thumbnailUrl = fileRecord.thumbnailUrl || null;
      if (thumbnailUrl) {
        thumbnailUrl = (await getPresignedUrl(thumbnailUrl)) || thumbnailUrl;
      }
      if (!thumbnailUrl) {
        thumbnailUrl = await generateThumbnailForName(
          fileRecord.name || normalizedName,
          fileRecord.key,
        );
      }

      dbLinks.push({
        name: fileRecord.name || normalizedName,
        url: signedUrl,
        thumbnailUrl,
      });
    }

    if (dbLinks.length === attachmentNames.length) {
      const linkMessage = buildLinkMessage({
        text: message.text,
        html: message.html,
        links: dbLinks,
      });
      message.text = linkMessage.text;
      message.html = linkMessage.html;
      return transport.sendMail(message);
    }

    if (dbMatchFound || attachmentNames.length) {
      const missingNames = attachmentNames.filter(
        (name) => !foundFiles.has(String(name).trim().toLowerCase()),
      );
      throw new Error(
        `Attachment not found in database: ${missingNames.join(", ") || attachmentNames.join(", ")}`,
      );
    }
  }

  return transport.sendMail(message);
};

module.exports = { sendEmail };
