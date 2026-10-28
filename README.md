# Email API

A small Node.js + Express project exposing a POST endpoint that sends an email to a specific person via SMTP (using Nodemailer).

## Setup

1. Install dependencies:

   ```bash
   npm install
   ```

2. Copy `.env.example` to `.env` and fill in your SMTP credentials:

   ```bash
   cp .env.example .env
   ```

   If using Gmail:
   - Enable 2-Step Verification on your Google account.
   - Create an "App Password" (Google Account → Security → App Passwords).
   - Use that app password as `SMTP_PASS` (not your normal Gmail password).

3. Start the server:
   ```bash
   npm start
   ```
   or, for auto-reload during development:
   ```bash
   npm run dev
   ```

The API will run on `http://localhost:3000` by default.

## Deploy for live testing

This project can be deployed as a Node web service on Render:

1. Push the project to a GitHub repository. Attachments are read from the database and DigitalOcean Spaces, so attachment files do not need to be included in the repository.
2. In Render, create a **Web Service** and select the repository.
3. Use these settings:

- **Build command:** `npm install`
- **Start command:** `npm start`

4. Add these environment variables in Render. Do not upload the local `.env` file:

- `SMTP_SERVICE`: `Outlook365`
- `SMTP_PORT`: `587`
- `SMTP_SECURE`: `false`
- `SMTP_USER`: your Outlook email address
- `SMTP_PASS`: your Outlook password or app password
- `MAIL_FROM`: your sender email address

5. Deploy and open the generated URL. Test the health endpoint at `/`, then send mail with `POST /api/send-email`.

The hosted endpoint will look like:
`https://your-service-name.onrender.com/api/send-email`

## Upload files from the frontend

### POST /api/files

Uploads any file to DigitalOcean Spaces, creates a thumbnail, and stores the
original file key and thumbnail key in MySQL. Use `multipart/form-data` with
the field name `file`.

Example frontend request:

```js
const formData = new FormData();
formData.append("file", selectedFile);

const response = await fetch("http://localhost:3000/api/files", {
  method: "POST",
  body: formData,
});

const result = await response.json();
console.log(result.file.hash);
```

The upload response contains the file name, its SHA-256 hash, and the stored
object keys. Send `result.file.hash` as `attachmentHash` to `/api/send-email`.
The email API then generates signed URLs and does not attach the remote file to
the email.

The `files` table must contain these columns:

```sql
CREATE TABLE files (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  file_hash CHAR(64) NOT NULL,
  key_path VARCHAR(1024) NOT NULL,
  thumbnail_url VARCHAR(1024) NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_files_file_hash (file_hash)
);
```

If the table already exists, run this migration before uploading again:

```sql
ALTER TABLE files
  MODIFY name VARCHAR(255) NOT NULL,
  ADD COLUMN file_hash CHAR(64) NULL AFTER name,
  MODIFY key_path VARCHAR(1024) NOT NULL,
  MODIFY thumbnail_url VARCHAR(1024) NULL,
  ADD INDEX idx_files_file_hash (file_hash);
```

Rows uploaded before this migration have no hash, so re-upload them (or
backfill `file_hash`) before sending them by hash.

Images receive a resized thumbnail, videos receive a frame captured by
FFmpeg, and other file types receive a generated file preview image.

### POST /api/files/exists

Checks whether files with the given hashes have already been uploaded. Send
`hash` as JSON in the request body, either as one string or as an array.

With an array, the response has one entry per hash, in the same order:

```json
// Request
{ "hash": ["<hash1>", "<hash2>"] }

// Response
{
  "success": true,
  "results": [
    { "hash": "<hash1>", "exists": true },
    { "hash": "<hash2>", "exists": false }
  ]
}
```

With a single string:

```js
const response = await fetch("http://localhost:3000/api/files/exists", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ hash }),
});
const { exists } = await response.json(); // true or false
```

**Response (200):**

```json
{ "success": true, "exists": true }
```

## Endpoint

### POST /api/send-email

Sends an email to a specific recipient.

**Request body (JSON):**

```json
{
  "to": "recipient@example.com",
  "subject": "Hello!",
  "text": "This is a plain text email.",
  "html": "<p>This is an <b>HTML</b> email.</p>",
  "attachmentHash": ["<hash returned by /api/files>"]
}
```

- `to` (required): recipient's email address
- `subject` (required): email subject
- `text` and/or `html` (at least one required): email body
- `attachmentHash` (optional): one file hash or an array of file hashes

Each `attachmentHash` must match a `file_hash` stored in the `files` database table. The stored `key_path` must point to the corresponding object in DigitalOcean Spaces.

**Success response (200):**

```json
{
  "success": true,
  "message": "Email sent to recipient@example.com",
  "messageId": "<...>"
}
```

**Error response (400/500):**

```json
{
  "success": false,
  "error": "Description of what went wrong"
}
```

## Example request (curl)

```bash
curl -X POST http://localhost:3000/api/send-email \
  -H "Content-Type: application/json" \
  -d '{
    "to": "someone@example.com",
    "subject": "Test Email",
    "text": "Hello from the Email API!",
    "attachmentHash": "<hash returned by /api/files>"
  }'
```

## Notes

- Uses SMTP via Nodemailer, configurable for Gmail, Outlook, or any other SMTP provider — just update `.env`.
- `.env` is not included in version control; only `.env.example` is provided as a template. Never commit real credentials.
