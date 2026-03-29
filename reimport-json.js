/**
 * reimport-json.js
 * Reads Exhibitors.csv and writes an enriched exhibitors.json with:
 *   - All original fields (id, name, country, zip, city, state, booth, url)
 *   - website  (CSV column 7)
 *   - directLinkId  (last path segment of the exhibitor presentation URL, e.g. "N1611362")
 */

const fs = require('fs');
const path = require('path');

const csvPath = path.join(__dirname, 'Exhibitors.csv');
const outPath = path.join(__dirname, 'exhibitors.json');

const raw = fs.readFileSync(csvPath, 'utf8');
const lines = raw.split('\n');

const exhibitors = [];
let id = 1;

for (let i = 2; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;

  // CSV uses semicolons; booth field is quoted
  const cols = line.split(';');
  if (cols[0]?.trim() !== 'Exhibitor') continue;

  const name          = cols[1]?.trim() || '';
  const country       = cols[2]?.trim() || '';
  const zip           = cols[3]?.trim() || '';
  const city          = cols[4]?.trim() || '';
  const state         = cols[5]?.trim() || '';
  // col 6 = CCI District (ignored)
  const website       = cols[7]?.trim() || '';
  const booth         = cols[8]?.replace(/"/g, '').trim() || '';
  const presUrl       = cols[9]?.trim() || '';

  if (!name) continue;

  // Extract directLinkId: last non-empty path segment of the URL
  const directLinkId = presUrl.split('/').filter(Boolean).pop() || '';

  exhibitors.push({ id: id++, name, country, zip, city, state, website, booth, url: presUrl, directLinkId });
}

fs.writeFileSync(outPath, JSON.stringify(exhibitors));
console.log(`✓ Exported ${exhibitors.length} exhibitors → exhibitors.json`);
