require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const axios = require('axios');

const app = express();
const db = new Database('exhibitors.db');

app.use(cors());
app.use(express.json());
app.use(express.static('.'));

function searchExhibitors(query) {
  const cleaned = query.toLowerCase()
    .replace(/where is|where can i find|find me|show me|tell me about|looking for|i want to visit|i want to find|stand of|booth of|what is the difference between|difference between|tell me more about|more about/g, '')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 1);
  const results = [];
  const seen = new Set();

  for (const word of words) {
    const rows = db.prepare(`
      SELECT * FROM exhibitors 
      WHERE LOWER(name) LIKE ?
      OR LOWER(country) LIKE ?
      OR LOWER(city) LIKE ?
      OR LOWER(booth) LIKE ?
      LIMIT 20
    `).all(`%${word}%`, `%${word}%`, `%${word}%`, `%${word}%`);

    for (const row of rows) {
      if (!seen.has(row.id)) {
        seen.add(row.id);
        results.push(row);
      }
    }
  }

  console.log(`Search: "${cleaned}" → ${results.length} results`);
  return results.slice(0, 20);
}

function extractCompanyNamesFromHistory(history) {
  // Get the last assistant message and extract any company names mentioned
  for (let i = history.length - 1; i >= 0; i--) {
    if (history[i].role === 'assistant') {
      const text = history[i].content;
      // Find companies mentioned in format "You can find X at"
      const matches = text.match(/You can find ([^a]+?) at/g);
      if (matches && matches.length > 0) {
        return matches.map(m => m.replace('You can find ', '').replace(' at', '').trim());
      }
    }
  }
  return [];
}

app.post('/chat', async (req, res) => {
  const { message, history } = req.body;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  let exhibitors = searchExhibitors(message);

  // If no results found, try to search based on companies mentioned in conversation history
  if (exhibitors.length === 0 && history && history.length > 0) {
    const companies = extractCompanyNamesFromHistory(history);
    console.log('No results for current query, trying companies from history:', companies);
    for (const company of companies) {
      const rows = db.prepare(`
        SELECT * FROM exhibitors WHERE LOWER(name) LIKE ? LIMIT 20
      `).all(`%${company.toLowerCase()}%`);
      exhibitors.push(...rows);
    }
    // Also search the last user message from history for company names
    const lastMessages = history.slice(-4).map(h => h.content).join(' ');
    const historyWords = lastMessages.toLowerCase().split(' ').filter(w => w.length > 3);
    for (const word of historyWords) {
      if (['find', 'show', 'tell', 'what', 'where', 'which', 'that', 'this', 'they', 'them', 'those', 'these', 'have', 'with', 'from', 'your', 'their', 'about', 'more', 'also', 'can', 'will', 'hall', 'stand', 'messe', 'hannover'].includes(word)) continue;
      const rows = db.prepare(`
        SELECT * FROM exhibitors WHERE LOWER(name) LIKE ? LIMIT 5
      `).all(`%${word}%`);
      exhibitors.push(...rows);
    }
    // Deduplicate
    const seen = new Set();
    exhibitors = exhibitors.filter(r => {
      if (seen.has(r.id)) return false;
      seen.add(r.id);
      return true;
    }).slice(0, 20);
  }

  let exhibitorContext = '';
  if (exhibitors.length > 0) {
    exhibitorContext = '\n\n###DATABASE RESULTS (YOU MUST USE THIS DATA)###\n' +
      exhibitors.map(e =>
        `- ${e.name} | ${e.country}${e.city ? ', ' + e.city : ''} | ${e.booth} | ${e.url}`
      ).join('\n') +
      '\n###END OF DATABASE RESULTS###';
  } else {
    exhibitorContext = '\n\n###DATABASE RESULTS###\nNO RESULTS FOUND FOR THIS QUERY\n###END###';
  }

  const systemPrompt = `You are a stand finder and guide for HANNOVER MESSE 2026 visitors. Your ONLY job is to tell visitors exactly where to find companies and what halls to visit using the database results provided to you.

HANNOVER MESSE 2026:
- Dates: April 20-24, 2026
- Location: Hannover, Germany
- Hours: 9am-6pm daily
- Getting there: Hannover Hauptbahnhof → direct subway to fairground

HALLS & TOPICS:
- Hall 11-13: Industrial automation, robotics, motion control
- Hall 14-15: IIoT, wireless, cloud, IT/OT security, industrial software
- Hall 16: Digital transformation, AI in manufacturing
- Hall 17: Energy technologies, hydrogen, energy storage
- Hall 23: Research & innovation transfer
- Hall 26: Supply chain, logistics, production technology
- Hall 27: Industrial components, construction solutions

ABSOLUTE RULES - VIOLATION IS NOT PERMITTED:
1. DATABASE RESULTS contains real data. You MUST use it. Always. No exceptions.
2. If DATABASE RESULTS contains entries, answer using ONLY those entries. Never say you don't have data.
3. NEVER say "check hannovermesse.de" if data exists in DATABASE RESULTS.
4. NEVER give generic answers when real data is available.
5. NEVER say "I couldn't find" if the company IS in DATABASE RESULTS.
6. For every company found always say: "You can find [company] at [hall and stand]."
7. If a company has multiple stands, list ALL of them clearly.
8. If asked about the difference between stands, use the HALLS & TOPICS above to explain what each hall focuses on — for example "Hall 17 focuses on energy technologies, so that stand likely showcases their energy solutions."
9. ONLY say a company is not found if DATABASE RESULTS explicitly says NO RESULTS FOUND.
10. Always speak directly to the visitor using "you". Never use third person.
11. Answer in the same language the user writes in. In German use "du".
12. Be warm and helpful like a knowledgeable friend at the fair.${exhibitorContext}`;

  try {
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: 'gpt-4o',
      max_tokens: 1000,
      messages: [
        { role: 'system', content: systemPrompt },
        ...history,
        { role: 'user', content: message }
      ]
    }, {
      headers: {
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
        'Content-Type': 'application/json'
      }
    });

    res.json({ reply: response.data.choices[0].message.content });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});