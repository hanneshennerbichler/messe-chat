require('dotenv').config();
const puppeteer = require('puppeteer');

// Dismiss Usercentrics cookie consent banner
async function dismissCookieConsent(page) {
  try {
    await new Promise(r => setTimeout(r, 2000));

    // Click coordinates where "Alles akzeptieren" button typically is (right side of modal)
    // Based on screenshot: modal is ~700px wide, button is on right third
    const viewport = await page.viewport();
    const centerX = viewport.width / 2;
    const centerY = viewport.height / 2;

    // The accept button is typically at x=590, y=383 based on modal layout
    // Try clicking in that region
    await page.mouse.click(590, 383);
    console.log('[ContactAgent] Clicked at coordinates (590, 383).');
    await new Promise(r => setTimeout(r, 1000));

    // Check if banner is still visible
    const stillVisible = await page.evaluate(() => {
      const modal = document.querySelector('[class*="uc-"]') ||
                    document.querySelector('[id*="usercentrics"]') ||
                    document.querySelector('[aria-modal="true"]');
      return modal && modal.offsetParent !== null;
    });

    if (stillVisible) {
      // Try another click position
      await page.mouse.click(600, 380);
      console.log('[ContactAgent] Retry click at (600, 380).');
      await new Promise(r => setTimeout(r, 500));
    }

  } catch (err) {
    console.log('[ContactAgent] Cookie dismissal error:', err.message);
  }
}

function buildContactUrl(name, directLinkId) {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .trim()
    .replace(/\s+/g, '-');
  return `https://www.hannovermesse.de/de/applikation/formulare/kontakt-aussteller/?exhibitor=${slug}&directLink=${directLinkId}`;
}

async function submitContactForm(exhibitor, sender) {
  const url = buildContactUrl(exhibitor.name, exhibitor.directLinkId);

  const browser = await puppeteer.launch({
    headless: 'new',
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage'],
  });

  const page = await browser.newPage();

  try {
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
    console.log(`[ContactAgent] Navigating to: ${url}`);
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });

    await page.screenshot({ path: '/tmp/page-loaded.png' });
    console.log('[ContactAgent] Page loaded, checking for cookie banner...');

    // Dismiss Usercentrics cookie consent if present
    await dismissCookieConsent(page);

    await page.screenshot({ path: '/tmp/after-cookie-dismiss.png' });
    console.log('[ContactAgent] After cookie dismiss attempt');

    await page.waitForSelector('form', { timeout: 10000 });

    // Fill the message field first (it's at the top of the form)
    await fillField(page, '#message', sender.message);

    // Scroll down to personal data section
    await page.evaluate(() => window.scrollBy(0, 300));
    await new Promise(r => setTimeout(r, 300));

    // Select salutation "Keine" (no title)
    await fillField(page, '#salutation_3', null, { click: true });

    // Fill personal information
    await fillField(page, '#firstName', sender.firstName);
    await fillField(page, '#lastName', sender.lastName);
    await fillField(page, '#senderEmail', sender.email);
    await fillField(page, '#company', sender.company || '');

    // Scroll down to see country field
    await page.evaluate(() => window.scrollBy(0, 400));
    await new Promise(r => setTimeout(r, 300));

    // Select country (required field) - click dropdown then select Germany
    try {
      await page.click('[data-cy="contactFormNationSelect"]');
      await new Promise(r => setTimeout(r, 500));
      // Click on Deutschland option
      await page.evaluate(() => {
        const options = document.querySelectorAll('li[role="option"], .mdc-list-item');
        for (const opt of options) {
          if (opt.innerText.includes('Deutschland') || opt.innerText.includes('Germany')) {
            opt.click();
            return;
          }
        }
      });
      await new Promise(r => setTimeout(r, 300));
    } catch (e) {
      console.log('[ContactAgent] Could not select country:', e.message);
    }

    // Scroll back up to find submit button
    await page.evaluate(() => window.scrollTo(0, 0));
    await new Promise(r => setTimeout(r, 300));

    // Find and scroll to submit button
    const submitBtn = await page.$('button[data-cy="contactFormSubmitButton"]');
    if (submitBtn) {
      await submitBtn.scrollIntoView();
      await new Promise(r => setTimeout(r, 300));
      await page.screenshot({ path: '/tmp/before-submit.png' });
      await submitBtn.click();
    } else {
      // Fallback: try finding by text
      await page.screenshot({ path: '/tmp/before-submit.png' });
      await page.evaluate(() => {
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.innerText.includes('Absenden') || btn.innerText.includes('Submit') || btn.innerText.includes('Senden')) {
            btn.click();
            return;
          }
        }
      });
    }

    // Wait for navigation/response
    await new Promise(r => setTimeout(r, 2000));

    // Dismiss cookie consent again (may reappear after form submission)
    await dismissCookieConsent(page);

    try {
      // Check for success confirmation
      const success = await page.evaluate(() => {
        const body = document.body.innerText.toLowerCase();
        return body.includes('vielen dank') ||
               body.includes('thank you') ||
               body.includes('erfolgreich') ||
               body.includes('gesendet') ||
               body.includes('nachricht wurde') ||
               body.includes('message sent') ||
               body.includes('successfully');
      });

      await page.screenshot({ path: '/tmp/after-submit.png' });

      if (success) {
        console.log('[ContactAgent] Form submitted successfully.');
        return { success: true, message: 'Contact form submitted successfully.' };
      }

      // If no success text, check if we're still on form page with errors
      const hasErrors = await page.evaluate(() => {
        const errorElements = document.querySelectorAll('.error, .field-error, [class*="error"]');
        return errorElements.length > 0;
      });

      if (hasErrors) {
        const errorText = await page.evaluate(() => {
          const errors = document.querySelectorAll('.error, .field-error, [class*="error"]');
          return Array.from(errors).map(e => e.innerText).join('; ');
        });
        console.warn('[ContactAgent] Form has errors:', errorText);
        return { success: false, message: `Form validation errors: ${errorText}` };
      }

      // No success text and no errors - might still be OK
      const bodyText = await page.evaluate(() => document.body.innerText);
      console.warn('[ContactAgent] Uncertain result:', bodyText.slice(0, 300));
      return { success: false, message: 'Form submitted but could not confirm success.' };

    } catch (err) {
      await page.screenshot({ path: '/tmp/after-submit.png' });
      console.warn('[ContactAgent] Error checking result:', err.message);
      return { success: false, message: 'Form submitted but could not confirm success.' };
    }

  } catch (err) {
    console.error('[ContactAgent] Error:', err.message);
    return { success: false, message: `Agent error: ${err.message}` };
  } finally {
    await browser.close();
  }
}

async function fillField(page, selector, value, { optional = false, click = false } = {}) {
  try {
    await page.waitForSelector(selector, { timeout: 5000 });
    if (click) {
      await page.click(selector);
      return;
    }
    await page.click(selector, { clickCount: 3 });
    await page.type(selector, value, { delay: 30 });
  } catch (err) {
    if (!optional) throw new Error(`Could not find field: ${selector}`);
  }
}

module.exports = { submitContactForm, buildContactUrl };