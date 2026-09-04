const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");
const { spawn } = require("child_process");
const sharp = require("sharp");
const { S3Client, PutObjectCommand } = require("@aws-sdk/client-s3");
const mysql = require("mysql2/promise");
const ffmpegPath = require("ffmpeg-static");

const s3 = new S3Client({
  endpoint: process.env.DO_SPACES_ENDPOINT,
  region: process.env.DO_SPACES_REGION,
  credentials: {
    accessKeyId: process.env.DO_SPACES_KEY,
    secretAccessKey: process.env.DO_SPACES_SECRET,
  },
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

const requireStorageConfig = () => {
  const required = [
    "DO_SPACES_ENDPOINT",
    "DO_SPACES_KEY",
    "DO_SPACES_SECRET",
    "DO_SPACES_BUCKET",
    "DO_SPACES_REGION",
  ];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(
      `Missing DigitalOcean configuration: ${missing.join(", ")}`,
    );
  }
};

const safeFileName = (originalName) => {
  const parsed = path.parse(originalName || "file");
  const base =
    parsed.name.replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") ||
    "file";
  const extension = parsed.ext.toLowerCase().replace(/[^a-z0-9.]/g, "");
  return `${base}${extension}`;
};

const uploadObject = async ({ key, body, contentType }) => {
  await s3.send(
    new PutObjectCommand({
      Bucket: process.env.DO_SPACES_BUCKET,
      Key: key,
      Body: body,
      ContentType: contentType || "application/octet-stream",
    }),
  );
};

const createPlaceholder = async (label) => {
  const safeLabel = String(label || "FILE")
    .replace(/[^a-zA-Z0-9 _-]/g, "")
    .slice(0, 18)
    .toUpperCase();
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="360"><rect width="640" height="360" fill="#172554"/><circle cx="320" cy="145" r="58" fill="#2563eb"/><path d="M300 112 L360 145 L300 178 Z" fill="white"/><text x="320" y="270" text-anchor="middle" font-family="Arial" font-size="30" font-weight="bold" fill="white">${safeLabel || "FILE"}</text></svg>`;
  return sharp(Buffer.from(svg)).jpeg({ quality: 82 }).toBuffer();
};

const runFfmpeg = (inputPath, outputPath) =>
  new Promise((resolve, reject) => {
    const process = spawn(ffmpegPath, [
      "-y",
      "-ss",
      "00:00:01",
      "-i",
      inputPath,
      "-frames:v",
      "1",
      "-vf",
      "scale=640:-2",
      outputPath,
    ]);
    let errorOutput = "";
    process.stderr.on("data", (chunk) => {
      errorOutput += chunk.toString();
    });
    process.on("error", reject);
    process.on("close", (code) => {
      if (code === 0) resolve();
      else
        reject(
          new Error(
            `FFmpeg failed with code ${code}: ${errorOutput.slice(-500)}`,
          ),
        );
    });
  });

const createThumbnail = async (file) => {
  const extension = path.extname(file.originalname).toLowerCase();
  if (imageExtensions.has(extension)) {
    return sharp(file.buffer)
      .resize({
        width: 640,
        height: 360,
        fit: "inside",
        withoutEnlargement: true,
      })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
  }

  if (videoExtensions.has(extension)) {
    const temporaryDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), "email-upload-"),
    );
    const inputPath = path.join(
      temporaryDirectory,
      safeFileName(file.originalname),
    );
    const outputPath = path.join(temporaryDirectory, "thumbnail.jpg");
    try {
      await fs.promises.writeFile(inputPath, file.buffer);
      await runFfmpeg(inputPath, outputPath);
      return await fs.promises.readFile(outputPath);
    } catch (error) {
      console.warn(
        `Video thumbnail generation failed for ${file.originalname}: ${error.message}`,
      );
      return createPlaceholder(path.parse(file.originalname).name);
    } finally {
      await fs.promises.rm(temporaryDirectory, {
        recursive: true,
        force: true,
      });
    }
  }

  return createPlaceholder(path.parse(file.originalname).name);
};

const saveFile = async (file) => {
  requireStorageConfig();
  if (!file || !file.buffer || !file.originalname) {
    throw new Error("A file is required.");
  }

  const originalName = safeFileName(file.originalname);
  const databaseName = path.parse(file.originalname).name;
  const token = crypto.randomBytes(8).toString("hex");
  const folder = (process.env.DO_SPACES_FOLDER || "email-files").replace(
    /^\/+|\/+$/g,
    "",
  );
  const fileKey = `${folder}/${token}-${originalName}`;
  const thumbnailKey = `${folder}/thumbnails/${token}-${path.parse(originalName).name}.jpg`;
  const thumbnailBuffer = await createThumbnail(file);

  await uploadObject({
    key: fileKey,
    body: file.buffer,
    contentType: file.mimetype,
  });
  await uploadObject({
    key: thumbnailKey,
    body: thumbnailBuffer,
    contentType: "image/jpeg",
  });

  const [result] = await db.execute(
    "INSERT INTO files (name, key_path, thumbnail_url) VALUES (?, ?, ?)",
    [databaseName, fileKey, thumbnailKey],
  );

  return {
    id: result.insertId,
    name: databaseName,
    key: fileKey,
    thumbnailKey,
  };
};

module.exports = { saveFile };
