require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static('.'));

// Load exhibitors from JSON file
const exhibitors = JSON.parse(fs.readFileSync('exhibitors.json', 'utf8'));
console.log(`Loaded ${exhibitors.length} exhibitors from JSON`);

// Extract hall number from booth string, e.g. "Hall 17, Stand F60" → 17
function getHall(booth) {
  if (!booth) return null;
  const m = booth.match(/Hall\s+(\d+)/i);
  return m ? parseInt(m[1]) : null;
}

function searchExhibitors(query) {
  const cleaned = query.toLowerCase()
    .replace(/where is|where can i find|find me|show me|tell me about|looking for|i want to visit|i want to find|stand of|booth of|what is the difference between|difference between|tell me more about|more about/g, '')
    .trim();

  const words = cleaned.split(' ').filter(w => w.length > 1);
  const results = [];
  const seen = new Set();

  for (const word of words) {
    for (const e of exhibitors) {
      if (seen.has(e.id)) continue;
      if (
        (e.name && e.name.toLowerCase().includes(word)) ||
        (e.country && e.country.toLowerCase().includes(word)) ||
        (e.city && e.city.toLowerCase().includes(word)) ||
        (e.booth && e.booth.toLowerCase().includes(word))
      ) {
        seen.add(e.id);
        results.push({ ...e, hall: getHall(e.booth) });
      }
    }
  }

  console.log(`Search: "${cleaned}" → ${results.length} results`);
  return results.slice(0, 20);
}

function searchByHistory(history) {
  if (!history || history.length === 0) return [];
  const results = [];
  const seen = new Set();

  for (let i = history.length - 1; i >= 0; i--) {
    const msg = history[i].content.toLowerCase();
    const words = msg.split(' ').filter(w => w.length > 3 && !['find', 'show', 'tell', 'what', 'where', 'which', 'that', 'this', 'they', 'them', 'those', 'these', 'have', 'with', 'from', 'your', 'their', 'about', 'more', 'also', 'hall', 'stand', 'messe', 'hannover', 'difference', 'between'].includes(w));

    for (const word of words) {
      for (const e of exhibitors) {
        if (seen.has(e.id)) continue;
        if (e.name && e.name.toLowerCase().includes(word)) {
          seen.add(e.id);
          results.push({ ...e, hall: getHall(e.booth) });
        }
      }
    }

    if (results.length > 0) break;
  }

  return results.slice(0, 20);
}

app.post('/chat', async (req, res) => {
  const { message, history } = req.body;
  const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

  let found = searchExhibitors(message);
  if (found.length === 0) {
    found = searchByHistory(history);
  }

  let exhibitorContext = '';
  if (found.length > 0) {
    exhibitorContext = '\n\n###DATABASE RESULTS (YOU MUST USE THIS DATA)###\n' +
      found.map(e =>
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

TOPIC TO HALL MAPPING - use when someone asks about a topic:
- Predictive maintenance → Hall 14-15 (industrial software, IIoT)
- Robotics → Hall 11-13
- AI / Machine learning → Hall 16
- Hydrogen → Hall 17
- Energy storage → Hall 17
- Cybersecurity → Hall 14-15
- Cloud computing → Hall 14-15
- Automation → Hall 11-13
- Logistics → Hall 26
- 3D printing → Hall 27
- Startups → Hall 13
- Research → Hall 23

ABSOLUTE RULES:
1. DATABASE RESULTS contains real data. You MUST use it. Always. No exceptions.
2. If DATABASE RESULTS contains entries, answer using ONLY those entries. Never say you don't have data.
3. NEVER say "check hannovermesse.de" if data exists in DATABASE RESULTS.
4. NEVER give generic answers when real data is available.
5. NEVER say "I couldn't find" if the company IS in DATABASE RESULTS.
6. For every company found always say: "You can find [company] at [hall and stand]."
7. If a company has multiple stands, list ALL of them clearly.
8. If asked about the difference between stands, use HALLS & TOPICS to explain what each hall focuses on.
9. If topic-based query with NO DATABASE RESULTS, recommend the relevant hall from TOPIC TO HALL MAPPING.
10. ONLY say a company is not found if DATABASE RESULTS explicitly says NO RESULTS FOUND.
11. Always speak directly to the visitor using "you". Never use third person.
12. Answer in the same language the user writes in. In German use "du".
13. Be warm and helpful like a knowledgeable friend at the fair.${exhibitorContext}`;

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

    res.json({
      reply: response.data.choices[0].message.content,
      exhibitors: found,
    });
  } catch (err) {
    console.error(err.response?.data || err.message);
    res.status(500).json({ error: 'Something went wrong' });
  }
});

app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
