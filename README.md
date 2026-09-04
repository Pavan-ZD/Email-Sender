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
  "attachmentName": ["KR 4 R600-3", "KR C5 micro"]
}
```

- `to` (required): recipient's email address
- `subject` (required): email subject
- `text` and/or `html` (at least one required): email body
- `attachmentName` (optional): one file name or an array of file names, with or without the extension

`attachmentName` must match a file name stored in the `files` database table. The stored `key_path` must point to the corresponding object in DigitalOcean Spaces. The name may be sent with or without its extension.

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
    "attachmentName": "KR 4 R600-3"
  }'
```

## Notes

- Uses SMTP via Nodemailer, configurable for Gmail, Outlook, or any other SMTP provider — just update `.env`.
- `.env` is not included in version control; only `.env.example` is provided as a template. Never commit real credentials.
