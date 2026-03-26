const axios = require('axios');
const cheerio = require('cheerio');

async function checkHTML() {
  const url = `https://www.hannovermesse.de/de/suche/?category=ep`;
  try {
    const res = await axios.get(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'de-DE,de;q=0.9',
      }
    });

    const $ = cheerio.load(res.data);
    console.log('Page title:', $('title').text());
    console.log('\n--- First 3000 chars of body ---');
    console.log(res.data.substring(0, 3000));

  } catch (err) {
    console.error('Error:', err.message);
  }
}

checkHTML();