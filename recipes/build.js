#!/usr/bin/env node
// Builds the printable recipe cards: recipes/src/mNN.json -> recipes/mNN.pdf (one page since Nov 7: the must-haves with a
// swap for each, a few big moves, the one thing that matters, when it's done, Plan B; schema = m01.json), plus recipes/index.json, which the app reads to show the 🖨 Recipe card button.
// Usage: node recipes/build.js            (every recipe)
//        node recipes/build.js m01 m47    (just these)
// Needs Playwright's Chromium (npm i -g playwright && npx playwright install chromium), Inter + Lora fonts for best looks.
const fs = require('fs');
const path = require('path');
let chromium;
try { ({ chromium } = require('playwright')); } catch (e) { ({ chromium } = require('/opt/npm-tools/node_modules/playwright')); }

const DIR = __dirname;
const SRC = path.join(DIR, 'src');
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// Wrap emoji in a span so they render with the color emoji font.
const emo = (s) => esc(s).replace(/(\p{Extended_Pictographic}(️|‍\p{Extended_Pictographic})*)/gu, '<span class="emoji">$1</span>');
const KIND = { breakfast: 'Breakfast', lunch: 'Lunch', snack: 'Snack', dinner: 'Dinner' };
let QR = null;
try { QR = require('qrcode'); } catch (e) { try { QR = require('/home/claude/qrtool/node_modules/qrcode'); } catch (e2) { QR = null; } }
const APP_URL = 'https://mm-fam.github.io/family-food/';
const QR_CACHE = {};
// The QR on the back opens this meal's card in the app (?meal=mNN). Needs `npm i qrcode` (falls back to no code).
function qrSvg(id) { return QR_CACHE[id] || ''; }
async function makeQr(id) { if (QR) QR_CACHE[id] = await QR.toString(APP_URL + '?meal=' + id, { type: 'svg', margin: 0, errorCorrectionLevel: 'M', color: { dark: '#1f2a24', light: '#0000' } }); }
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(DIR, '..', 'icons', 'poppy-logo.png')).toString('base64');

function splitName(name) {
  const seg = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(String(name))].map((x) => x.segment);
  if (seg.length && /\p{Extended_Pictographic}/u.test(seg[0])) return { icon: seg[0], title: seg.slice(1).join('').trim() };
  return { icon: '🍽️', title: String(name) };
}
const mins = (n) => (n >= 60 ? Math.floor(n / 60) + ' hr' + (n % 60 ? ' ' + (n % 60) : '') : n + ' min');

function render(r) {
  const n = splitName(r.name);
  const kind = r.kind || 'dinner';
  const draft = r.draft === false ? 'Family-tested recipe' : 'Poppy\'s draft, not family-tested yet';
  const rows = (r.core || []).map((c) => '<tr><td class="box"><i></i></td><td class="name">' + emo(c.name) + '</td><td class="out">' +
    (c.out ? '<b>Out?</b> ' + emo(c.out) : '') + '</td></tr>').join('');
  const moves = (r.moves || []).map((m) => '<li><div>' + emo(m.text) + (m.time ? '<span class="t">⏱ ' + esc(m.time) + '</span>' : '') + '</div></li>').join('');
  return '<section class="page k-' + kind + '">' +
    '<div class="hd"><div class="badge">' + esc(n.icon) + '</div><div class="hd-main"><div class="kicker">' + KIND[kind] + ' · Poppy\'s kitchen</div><h1>' + emo(n.title) + '</h1>' +
    (r.what ? '<p class="what">' + emo(r.what) + '</p>' : '') + '</div>' +
    '<div class="meta"><div class="pill"><b>' + mins(Number(r.minutes) || 0) + '</b><span>Start to table</span></div><div class="pill"><b>' + esc(r.serves || '4') + '</b><span>Serves</span></div></div></div>' +
    (r.early ? '<p class="early"><b><span class="emoji">⏰</span> Heads-up:</b> ' + emo(r.early) + '</p>' : '') +
    '<div class="must"><h2><span class="emoji">🧺</span> The must-haves</h2><p class="lead">Put these on the counter <b>before you start</b>. Out of one? Use the swap next to it. That\'s it, keep going.</p><table>' + rows + '</table></div>' +
    (r.extras ? '<p class="extras"><b><span class="emoji">✨</span> If we have them:</b> ' + emo(r.extras) + '. Skip any of these.</p>' : '') +
    '<div><h2><span class="emoji">🔥</span> How it goes</h2><ol>' + moves + '</ol></div>' +
    ((r.key || r.done) ? '<div class="two">' + (r.key ? '<div class="tip"><b><span class="emoji">🔑</span> The one thing that matters</b>' + emo(r.key) + '</div>' : '') +
      (r.done ? '<div class="tip"><b><span class="emoji">✅</span> It\'s done when</b>' + emo(r.done) + '</div>' : '') + '</div>' : '') +
    (r.plan_b ? '<div class="planb"><b><span class="emoji">🛟</span> Plan B:</b> ' + emo(r.plan_b) + '</div>' : '') +
    '<div class="ft"><div class="qr">' + qrSvg(r.id) + '</div><div class="grow"><b>Done? Tell Poppy how it went.</b> Scan to vote and send tweaks with <span class="emoji">💡</span>.<br>' + emo(draft) + '</div>' +
    '<span><img src="' + logo + '">Poppy 2.0 · ' + esc(r.id) + '</span></div></section>';
}

(async () => {
  // A heads-up for the → Hearth note when the meal needs an early start ("Night before: thaw the puff pastry").
  // "Optional, Sunday: …" stays on the card but isn't a Hearth heads-up.
  const earlyStep = (r) => (/^optional/i.test(String(r.early || '').trim()) ? '' : String(r.early || '').trim());
  const want = process.argv.slice(2);
  const files = fs.readdirSync(SRC).filter((f) => /^m\d+\.json$/.test(f)).sort();
  const tpl = fs.readFileSync(path.join(DIR, 'card.html'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 }, deviceScaleFactor: 1.25 });
  const index = {};
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
    index[r.id] = { name: r.name, pdf: 'recipes/' + r.id + '.pdf', img: ['recipes/img/' + r.id + '-1.jpg'], serves: r.serves || '', minutes: Number(r.minutes) || 0, draft: r.draft !== false, early: earlyStep(r) };
    if (want.length && want.indexOf(r.id) < 0) continue;
    await makeQr(r.id);
    const tmp = path.join(DIR, '.tmp-' + r.id + '.html');
    fs.writeFileSync(tmp, tpl.replace('__BODY__', render(r)));
    await page.goto('file://' + tmp);
    await page.evaluate(() => document.fonts.ready);
    // Shrink the type until the page fits.
    let fs_ = 12.4;
    for (; fs_ >= 7.6; fs_ -= 0.2) {
      const over = await page.evaluate((v) => {
        document.documentElement.style.setProperty('--fs', v + 'pt');
        return [...document.querySelectorAll('.page')].some((p) => p.scrollHeight > p.clientHeight + 1 ||
          [...p.children].filter((c) => !c.classList.contains('ft')).some((c) => c.getBoundingClientRect().bottom > p.querySelector('.ft').getBoundingClientRect().top - 4));
      }, fs_.toFixed(1));
      if (!over) break;
    }
    if (fs_ < 7.6) console.warn('⚠ ' + r.id + ' still overflows at the smallest size');
    await page.pdf({ path: path.join(DIR, r.id + '.pdf'), format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    // Page pictures for the app's recipe sheet (the iPhone home-screen app can't show a PDF with a way back).
    fs.mkdirSync(path.join(DIR, 'img'), { recursive: true });
    const pages = await page.$$('.page');
    for (let i = 0; i < pages.length; i++) await pages[i].screenshot({ path: path.join(DIR, 'img', r.id + '-' + (i + 1) + '.jpg'), type: 'jpeg', quality: 72 });
    fs.unlinkSync(tmp);
    console.log(r.id, 'ok', fs_.toFixed(1) + 'pt');
  }
  await browser.close();
  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), recipes: index }, null, 1) + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
