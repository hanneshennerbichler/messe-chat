# Messe Contact Agent

Agentic microservice that automatically fills and submits the Hannover Messe exhibitor contact form on behalf of a user. Built with Puppeteer + Express.

## Folder structure

```
messe-contact-agent/
├── server.js          ← Express API
├── contactAgent.js    ← Puppeteer automation core
├── package.json
├── railway.toml       ← Railway deploy config
├── nixpacks.toml      ← Chrome deps for Railway
├── .env.example
└── README.md
```

## How it works

1. Receives a POST request with exhibitor info + sender details
2. Generates the Hannover Messe contact URL:
   `https://www.hannovermesse.de/de/applikation/formulare/kontakt-aussteller/?exhibitor={slug}&directLink={directLinkId}`
3. Launches a headless Chromium browser via Puppeteer
4. Navigates to the form, fills in all fields, submits
5. Returns success/failure

## Setup

```bash
cd messe-contact-agent
npm install
cp .env.example .env
npm run dev
```

## API

### POST /contact

```json
{
  "exhibitor": {
    "name": "Aashirwad Press Tools",
    "directLinkId": "N1611362"
  },
  "sender": {
    "firstName": "Hannes",
    "lastName": "Hennerbichler",
    "email": "hannes@example.com",
    "company": "Heise Medien",
    "message": "I'd like to schedule a meeting at your booth."
  }
}
```

**Response (success):**
```json
{ "success": true, "message": "Contact form submitted successfully." }
```

**Response (failure):**
```json
{ "success": false, "error": "Agent error: ..." }
```

### GET /preview-url?name=Aashirwad+Press+Tools&directLinkId=N1611362

Returns the URL that would be used, without running Puppeteer. Good for debugging.

### GET /health

Returns `{ "status": "ok" }`.

## Integrating with Messe Chat

In your existing Messe Chat backend, add a call to this service when the user expresses contact intent:

```js
// In your chat handler, after GPT-4o detects intent:
const response = await fetch('http://localhost:3001/contact', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    exhibitor: { name: matchedExhibitor.name, directLinkId: matchedExhibitor.directLinkId },
    sender: { firstName, lastName, email, message },
  }),
});
const result = await response.json();
```

## Deploying to Railway

1. Create a new Railway project in the `messe-contact-agent` folder
2. Railway auto-detects `nixpacks.toml` and installs Chrome
3. Set `PORT` in Railway env vars (or let Railway set it automatically)
4. Deploy — no extra config needed

> **Note:** Puppeteer on Railway requires the `nixpacks.toml` Chrome deps. Without them you'll get `Could not find Chrome` errors.

## Troubleshooting

| Issue | Fix |
|---|---|
| `Could not find Chrome` | Make sure `nixpacks.toml` is committed and Railway rebuilds |
| Form fields not found | The Hannover Messe form HTML may have changed — update selectors in `contactAgent.js` |
| Timeout on form load | The site may be rate-limiting; add a delay or rotate User-Agent |
| Cookie banner blocks fill | Add its selector to the cookie-dismiss block in `contactAgent.js` |
