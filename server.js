require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const { ImapFlow } = require('imapflow');
const OpenAI = require('openai');
const { submitContactForm, buildContactUrl } = require('./contactAgent');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(__dirname));

const PORT = process.env.PORT || 3001;
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// ---------------------------------------------------------------------------
// Exhibitors data
// ---------------------------------------------------------------------------
let exhibitors = [];
try {
  exhibitors = JSON.parse(fs.readFileSync(path.join(__dirname, 'exhibitors.json'), 'utf8'));
  console.log(`[Server] Loaded ${exhibitors.length} exhibitors.`);
} catch (e) {
  console.error('[Server] Could not load exhibitors.json:', e.message);
}

// ---------------------------------------------------------------------------
// Bookings persistence
// ---------------------------------------------------------------------------
const BOOKINGS_FILE = path.join(__dirname, 'bookings.json');

function loadBookings() {
  try {
    if (fs.existsSync(BOOKINGS_FILE))
      return JSON.parse(fs.readFileSync(BOOKINGS_FILE, 'utf8'));
  } catch (e) {}
  return [];
}

function saveBookings(bookings) {
  fs.writeFileSync(BOOKINGS_FILE, JSON.stringify(bookings, null, 2));
}

// ---------------------------------------------------------------------------
// Email draft generator
// Booking ID is embedded in the subject so replies can be auto-matched.
// ---------------------------------------------------------------------------
function generateEmailDraft(booking) {
  const { exhibitor, visitor } = booking;

  const dateStr = visitor.preferredDate
    ? new Date(visitor.preferredDate).toLocaleDateString('de-DE', {
        weekday: 'long', day: 'numeric', month: 'long', year: 'numeric'
      })
    : null;
  const timeStr = visitor.preferredTime || null;

  // Booking ID in subject → used for reply matching
  const subject = `Meeting request at HANNOVER MESSE 2026 – ${visitor.company || visitor.name} [${booking.id}]`;

  const body = [
    `Dear ${exhibitor.name} team,`,
    ``,
    `My name is ${visitor.name}${visitor.company ? `, representing ${visitor.company}` : ''}. I am visiting HANNOVER MESSE 2026 (April 20–24, Hannover) and would very much like to schedule a meeting at your booth${exhibitor.booth ? ` (${exhibitor.booth})` : ''}.`,
    dateStr ? `\nMy preferred time would be ${dateStr}${timeStr ? ` at ${timeStr}` : ''}.` : '',
    visitor.message ? `\nTopics I'd like to discuss:\n${visitor.message}` : '',
    ``,
    `Please let me know if this works for you, or suggest an alternative time that suits your schedule.`,
    ``,
    `Best regards,`,
    visitor.name,
    visitor.company || '',
    visitor.email,
  ].filter(l => l !== null).join('\n').replace(/\n{3,}/g, '\n\n').trim();

  return { subject, body };
}

// ---------------------------------------------------------------------------
// AI reply classifier
// Uses local OpenAI key if available, otherwise proxies to Railway backend.
// ---------------------------------------------------------------------------
async function classifyReply(booking, replyText) {
  const prompt = `Original meeting request was for: ${booking.exhibitor.name}, ${booking.exhibitor.booth || ''}.\n\nReply received:\n\n${replyText}`;

  // Try local OpenAI key first
  if (process.env.OPENAI_API_KEY && !process.env.OPENAI_API_KEY.includes('your-key')) {
    try {
      const completion = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content:
              'You analyze email replies to trade fair meeting requests. ' +
              'Classify the reply and respond with JSON only — no markdown. ' +
              'Schema: {"status": "confirmed" | "declined" | "uncertain", "summary": "<one concise sentence in German describing the outcome>"}'
          },
          { role: 'user', content: prompt }
        ],
        response_format: { type: 'json_object' },
        temperature: 0,
      });
      return JSON.parse(completion.choices[0].message.content);
    } catch (err) {
      if (!err.message.includes('401')) throw err;
      console.warn('[IMAP] Local OpenAI key invalid, falling back to Railway…');
    }
  }

  // Fallback: proxy to Railway backend
  const RAILWAY = 'https://messe-chat-production.up.railway.app';
  const res = await fetch(`${RAILWAY}/classify-reply`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ booking, replyText }),
  });
  if (!res.ok) throw new Error(`Railway classify-reply: ${res.status}`);
  return res.json();
}

// ---------------------------------------------------------------------------
// Decode quoted-printable encoding, then decode as UTF-8 (handles ä, ö, ü …)
// ---------------------------------------------------------------------------
function decodeQuotedPrintable(str) {
  // First remove soft line breaks
  const withoutSoft = str.replace(/=\r?\n/g, '');
  // Collect bytes, decode as UTF-8 buffer
  const bytes = [];
  let i = 0;
  while (i < withoutSoft.length) {
    if (withoutSoft[i] === '=' && i + 2 < withoutSoft.length) {
      bytes.push(parseInt(withoutSoft.slice(i + 1, i + 3), 16));
      i += 3;
    } else {
      bytes.push(withoutSoft.charCodeAt(i));
      i++;
    }
  }
  return Buffer.from(bytes).toString('utf8');
}

// ---------------------------------------------------------------------------
// Extract plain-text body from a raw MIME email.
// Handles multipart and quoted-printable encoding.
// Strips the quoted original message (lines starting with ">").
// ---------------------------------------------------------------------------
function extractPlainText(raw) {
  const text = raw.toString();

  // Find text/plain part in multipart email
  const plainMatch = text.match(
    /Content-Type:\s*text\/plain[^\r\n]*\r?\nContent-Transfer-Encoding:\s*quoted-printable\r?\n\r?\n([\s\S]*?)(?:\r?\n--|\r?\n\r?\nContent-Type:|$)/i
  );

  let body = '';
  if (plainMatch) {
    body = decodeQuotedPrintable(plainMatch[1]);
  } else {
    // Fallback: plain text without encoding
    const plainFallback = text.match(
      /Content-Type:\s*text\/plain[^\r\n]*\r?\n(?:Content-Transfer-Encoding:\s*7bit\r?\n)?\r?\n([\s\S]*?)(?:\r?\n--|\r?\nContent-Type:|$)/i
    );
    if (plainFallback) {
      body = plainFallback[1];
    } else {
      // Last resort: everything after double-CRLF header block
      const idx = text.indexOf('\r\n\r\n');
      body = idx > -1 ? text.slice(idx + 4) : text;
    }
  }

  // Remove quoted lines (lines starting with ">") and trailing whitespace
  const lines = body.split('\n')
    .map(l => l.trimEnd())
    .filter(l => !l.startsWith('>') && !l.startsWith('On ') && l !== '--');

  return lines.join('\n').trim();
}

// ---------------------------------------------------------------------------
// IMAP inbox poller — runs every 60 seconds
// Looks for replies to sent booking emails, auto-classifies them with AI.
// ---------------------------------------------------------------------------
async function pollInbox() {
  if (!process.env.SMTP_USER || !process.env.SMTP_PASS) return;

  const client = new ImapFlow({
    host: 'imap.gmail.com',
    port: 993,
    secure: true,
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    logger: false,
  });

  try {
    await client.connect();
    await client.mailboxOpen('INBOX');

    const bookings = loadBookings();
    const pendingIds = new Set(bookings.filter(b => b.status === 'email_sent').map(b => b.id));

    if (pendingIds.size === 0) {
      await client.logout();
      return;
    }

    let changed = false;

    for await (const msg of client.fetch('1:*', { envelope: true, source: true })) {
      const subject = msg.envelope?.subject || '';
      const idMatch = subject.match(/\[BK(\d+)\]/);
      if (!idMatch) continue;

      const bookingId = 'BK' + idMatch[1];
      if (!pendingIds.has(bookingId)) continue;

      const booking = bookings.find(b => b.id === bookingId);

      const replyText = extractPlainText(msg.source);
      console.log(`[IMAP] Reply for ${bookingId}:\n${replyText.slice(0, 300)}`);

      if (!replyText || replyText.length < 5) {
        console.warn(`[IMAP] Empty body for ${bookingId}, skipping.`);
        continue;
      }

      try {
        const analysis = await classifyReply(booking, replyText);
        booking.status = analysis.status;
        booking.replyText = replyText.slice(0, 2000);
        booking.replyAnalysis = analysis.summary;
        booking.repliedAt = new Date().toISOString();
        changed = true;
        pendingIds.delete(bookingId);
        console.log(`[IMAP] Booking ${bookingId} → ${analysis.status}: ${analysis.summary}`);
      } catch (err) {
        console.error(`[IMAP] AI error for ${bookingId}:`, err.message);
      }
    }

    if (changed) saveBookings(bookings);
    await client.logout();
  } catch (err) {
    console.error('[IMAP] Poll error:', err.message);
    try { await client.logout(); } catch (_) {}
  }
}

// IMAP polling only runs when SMTP is fully configured (i.e. locally, not on Railway)
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  setTimeout(() => {
    pollInbox();
    setInterval(pollInbox, 60 * 1000);
  }, 5000);
  console.log('[IMAP] Poller enabled — checking inbox every 60s');
} else {
  console.log('[IMAP] Poller disabled — SMTP not configured');
}

// ---------------------------------------------------------------------------
// GET /exhibitors
// ---------------------------------------------------------------------------
app.get('/exhibitors', (req, res) => {
  const { q, hall, limit = 30 } = req.query;
  let results = exhibitors;

  if (q) {
    const query = q.toLowerCase();
    results = results.filter(e =>
      e.name?.toLowerCase().includes(query) ||
      e.country?.toLowerCase().includes(query) ||
      e.city?.toLowerCase().includes(query)
    );
  }
  if (hall) results = results.filter(e => e.booth?.includes(`Hall ${hall}`));

  res.json({ total: results.length, results: results.slice(0, parseInt(limit, 10)) });
});

// ---------------------------------------------------------------------------
// POST /bookings
// ---------------------------------------------------------------------------
app.post('/bookings', (req, res) => {
  const { exhibitor, visitor } = req.body;
  if (!exhibitor?.name || !visitor?.name || !visitor?.email)
    return res.status(400).json({ error: 'exhibitor.name, visitor.name and visitor.email are required.' });

  const bookings = loadBookings();
  const booking = {
    id: `BK${Date.now()}${Math.floor(Math.random() * 1000)}`,
    exhibitor,
    visitor,
    createdAt: new Date().toISOString(),
    status: 'draft',
  };

  bookings.push(booking);
  saveBookings(bookings);
  console.log(`[Server] Booking ${booking.id} (draft): ${visitor.name} → ${exhibitor.name}`);
  res.json({ success: true, booking });
});

// ---------------------------------------------------------------------------
// GET /bookings
// ---------------------------------------------------------------------------
app.get('/bookings', (req, res) => res.json(loadBookings()));

// ---------------------------------------------------------------------------
// DELETE /bookings/:id
// ---------------------------------------------------------------------------
app.delete('/bookings/:id', (req, res) => {
  let bookings = loadBookings();
  const before = bookings.length;
  bookings = bookings.filter(b => b.id !== req.params.id);
  if (bookings.length === before) return res.status(404).json({ error: 'Booking not found.' });
  saveBookings(bookings);
  res.json({ success: true });
});

// ---------------------------------------------------------------------------
// GET /bookings/:id/email-draft
// ---------------------------------------------------------------------------
app.get('/bookings/:id/email-draft', (req, res) => {
  const booking = loadBookings().find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });
  if (booking.emailSubject && booking.emailBody)
    return res.json({ subject: booking.emailSubject, body: booking.emailBody });
  res.json(generateEmailDraft(booking));
});

// ---------------------------------------------------------------------------
// POST /bookings/:id/send
// ---------------------------------------------------------------------------
app.post('/bookings/:id/send', async (req, res) => {
  const { recipientEmail, subject, body } = req.body;
  if (!recipientEmail || !subject || !body)
    return res.status(400).json({ error: 'recipientEmail, subject, and body are required.' });

  const bookings = loadBookings();
  const booking = bookings.find(b => b.id === req.params.id);
  if (!booking) return res.status(404).json({ error: 'Booking not found.' });

  if (!process.env.SMTP_HOST || !process.env.SMTP_USER || !process.env.SMTP_PASS)
    return res.status(503).json({ error: 'SMTP not configured in .env.' });

  try {
    const transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port: parseInt(process.env.SMTP_PORT || '587', 10),
      secure: process.env.SMTP_SECURE === 'true',
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    });

    await transporter.sendMail({
      from: process.env.SMTP_FROM || process.env.SMTP_USER,
      to: recipientEmail,
      subject,
      text: body,
    });

    booking.status = 'email_sent';
    booking.emailSentAt = new Date().toISOString();
    booking.recipientEmail = recipientEmail;
    booking.emailSubject = subject;
    booking.emailBody = body;
    saveBookings(bookings);

    console.log(`[Server] Email sent for booking ${booking.id} → ${recipientEmail}`);
    res.json({ success: true });
  } catch (err) {
    console.error('[Server] SMTP error:', err.message);
    res.status(500).json({ error: `SMTP error: ${err.message}` });
  }
});

// ---------------------------------------------------------------------------
// POST /contact (Puppeteer)
// ---------------------------------------------------------------------------
app.post('/contact', async (req, res) => {
  const { exhibitor, sender } = req.body;
  if (!exhibitor?.name || !exhibitor?.directLinkId)
    return res.status(400).json({ error: 'exhibitor.name and exhibitor.directLinkId are required.' });
  if (!sender?.firstName || !sender?.lastName || !sender?.email || !sender?.message)
    return res.status(400).json({ error: 'sender.firstName, lastName, email and message are required.' });

  const result = await submitContactForm(exhibitor, sender);
  if (result.success) return res.json({ success: true, message: result.message });
  return res.status(500).json({ success: false, error: result.message });
});

// ---------------------------------------------------------------------------
// GET /preview-url
// ---------------------------------------------------------------------------
app.get('/preview-url', (req, res) => {
  const { name, directLinkId } = req.query;
  if (!name || !directLinkId) return res.status(400).json({ error: 'name and directLinkId required.' });
  res.json({ url: buildContactUrl(name, directLinkId) });
});

// ---------------------------------------------------------------------------
// POST /classify-reply  (used by local server when OpenAI key is on Railway)
// Body: { booking, replyText }
// ---------------------------------------------------------------------------
app.post('/classify-reply', async (req, res) => {
  const { booking, replyText } = req.body;
  if (!booking || !replyText) return res.status(400).json({ error: 'booking and replyText required.' });
  try {
    const completion = await openai.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content:
            'You analyze email replies to trade fair meeting requests. ' +
            'Classify the reply and respond with JSON only — no markdown. ' +
            'Schema: {"status": "confirmed" | "declined" | "uncertain", "summary": "<one concise sentence in German describing the outcome>"}'
        },
        {
          role: 'user',
          content: `Original meeting request was for: ${booking.exhibitor.name}, ${booking.exhibitor.booth || ''}.\n\nReply received:\n\n${replyText}`
        }
      ],
      response_format: { type: 'json_object' },
      temperature: 0,
    });
    res.json(JSON.parse(completion.choices[0].message.content));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------------------------------------------------------------------------
// Health check
// ---------------------------------------------------------------------------
app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`[MesseContactAgent] Running on http://localhost:${PORT}`);
});
