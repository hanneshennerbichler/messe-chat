const fs = require('fs');
const Database = require('better-sqlite3');

const db = new Database('exhibitors.db');

db.exec(`DROP TABLE IF EXISTS exhibitors`);

db.exec(`
  CREATE TABLE IF NOT EXISTS exhibitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT,
    country TEXT,
    zip TEXT,
    city TEXT,
    state TEXT,
    booth TEXT,
    url TEXT
  )
`);

const insert = db.prepare(`
  INSERT INTO exhibitors (name, country, zip, city, state, booth, url)
  VALUES (@name, @country, @zip, @city, @state, @booth, @url)
`);

const raw = fs.readFileSync('exhibitors.csv', 'utf8');
const lines = raw.split('\n');

let count = 0;

for (let i = 2; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;

  const cols = line.split(';');
  if (cols[0]?.trim() !== 'Exhibitor') continue;

  const name = cols[1]?.trim() || '';
  const country = cols[2]?.trim() || '';
  const zip = cols[3]?.trim() || '';
  const city = cols[4]?.trim() || '';
  const state = cols[5]?.trim() || '';
  const booth = cols[8]?.replace(/"/g, '').trim() || '';
  const url = cols[9]?.trim() || '';

  if (!name) continue;

  insert.run({ name, country, zip, city, state, booth, url });
  count++;
}

console.log(`Imported ${count} exhibitors into database!`);
db.close();