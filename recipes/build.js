#!/usr/bin/env node
// Builds the printable recipe cards: recipes/src/mNN.json -> recipes/mNN.pdf (front = cook it, back = kitchen crew,
// make-ahead, leftovers, "How'd it go?"), plus recipes/index.json, which the app reads to show the 🖨 Recipe card button.
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
const logo = 'data:image/png;base64,' + fs.readFileSync(path.join(DIR, '..', 'icons', 'poppy-logo.png')).toString('base64');

function splitName(name) {
  const seg = [...new Intl.Segmenter('en', { granularity: 'grapheme' }).segment(String(name))].map((x) => x.segment);
  if (seg.length && /\p{Extended_Pictographic}/u.test(seg[0])) return { icon: seg[0], title: seg.slice(1).join('').trim() };
  return { icon: '🍽️', title: String(name) };
}
const mins = (n) => (n >= 60 ? Math.floor(n / 60) + ' hr' + (n % 60 ? ' ' + (n % 60) : '') : n + ' min');

function footer(r, side) {
  return '<div class="ft"><span><img src="' + logo + '">Poppy 2.0 · ' + esc(r.id) + ' · ' + side + '</span>' +
    '<span>' + (r.draft === false ? 'Family-tested recipe' : 'Poppy\'s draft. Change something? Tell Poppy with 💡 so the card learns.').replace('💡', '<span class="emoji">💡</span>') + '</span></div>';
}

function render(r) {
  const n = splitName(r.name);
  const kind = r.kind || 'dinner';
  const total = (Number(r.prep) || 0) + (Number(r.cook) || 0);
  const ing = (r.ingredients || []).map((g) => '<div class="grp">' + emo(g.group) + '</div><ul class="ing">' + g.items.map((i) =>
    '<li class="' + (i.qty ? '' : 'noqty') + '"><span class="box"></span>' + (i.qty ? '<span class="qty">' + esc(i.qty) + '</span>' : '') + '<span>' + emo(i.name) + '</span></li>').join('') + '</ul>').join('');
  const steps = (r.steps || []).map((s) => '<li><div>' + emo(s.text) +
    ((s.kid || s.time) ? '<span class="chips">' + (s.kid ? '<span class="chip kid"><span class="emoji">🧒</span> Kids can do this</span>' : '') + (s.time ? '<span class="chip time">⏱ ' + esc(s.time) + '</span>' : '') + '</span>' : '') +
    '</div></li>').join('');
  const front = '<section class="page front k-' + kind + '">' +
    '<div class="hd"><div class="badge">' + esc(n.icon) + '</div><div class="hd-main"><div class="kicker">' + KIND[kind] + ' · Poppy\'s kitchen</div><h1>' + emo(n.title) + '</h1>' +
    (r.tagline ? '<p class="tag">' + emo(r.tagline) + '</p>' : '') + '</div>' +
    '<div class="meta"><div class="pill"><b>' + esc(r.serves || '4') + '</b><span>Serves</span></div><div class="pill"><b>' + mins(total) + '</b><span>Start to table</span></div>' +
    '<div class="pill"><b>' + mins(Number(r.prep) || 0) + '</b><span>Prep</span></div><div class="pill"><b>' + mins(Number(r.cook) || 0) + '</b><span>Cook</span></div>' +
    (r.level ? '<div class="level">' + esc(r.level) + '</div>' : '') + '</div></div>' +
    '<div class="cols"><div class="left"><div class="need"><h2><span class="emoji">🛒</span> What you need</h2>' + ing + '</div>' +
    ((r.gear && r.gear.length) || r.heads_up ? '<div class="gear">' + (r.heads_up ? '<p class="heads"><span class="emoji">⚡</span> <b>First:</b> ' + emo(r.heads_up) + '</p>' : '') +
      (r.gear && r.gear.length ? '<div class="grp">Gear</div><p>' + r.gear.map(esc).join(' · ') + '</p>' : '') + '</div>' : '') + '</div>' +
    '<div class="cook"><h2><span class="emoji">🔥</span> Let\'s cook</h2><ol class="steps">' + steps + '</ol>' +
    (r.chef_tip ? '<div class="secret"><span class="emoji">👨‍🍳</span><div><b>Chef\'s secret</b>' + emo(r.chef_tip) + '</div></div>' : '') + '</div></div>' +
    footer(r, 'front') + '</section>';
  const card = (title, body) => body ? '<div class="card"><h3>' + title + '</h3>' + body + '</div>' : '';
  const back = '<section class="page back k-' + kind + '">' +
    '<div class="hd"><div class="badge" style="width:.6in;height:.6in;font-size:24pt">' + esc(n.icon) + '</div><div class="hd-main"><div class="kicker">' + KIND[kind] + ' · flip side</div><h1 style="font-size:19pt">' + emo(n.title) + '</h1></div></div>' +
    (r.kid_jobs && r.kid_jobs.length ? '<div class="crew"><h2><span class="emoji">🧑‍🍳</span> Kitchen crew: kid jobs</h2><ul>' +
      r.kid_jobs.map((j) => '<li><span class="box"></span><span>' + emo(j.job) + '</span></li>').join('') + '</ul>' +
      '<p class="safety">Knives, the stove and the oven: a grown-up stays right there. Steps marked <b>🧒 Kids can do this</b> on the front are theirs to own.</p></div>' : '') +
    '<div class="grid4">' +
    card('<span class="emoji">⏰</span> Make it ahead', r.make_ahead ? '<p>' + emo(r.make_ahead) + '</p>' : '') +
    card('<span class="emoji">🥡</span> Leftovers', r.leftovers ? '<p>' + emo(r.leftovers) + '</p>' : '') +
    card('<span class="emoji">🔁</span> Swap it', r.swaps && r.swaps.length ? '<ul>' + r.swaps.map((s) => '<li>' + emo(s) + '</li>').join('') + '</ul>' : '') +
    card('<span class="emoji">🍽️</span> Serve it with', r.serve_with ? '<p>' + emo(r.serve_with) + '</p>' : '') +
    '</div>' +
    '<div class="howd"><h2><span class="emoji">📝</span> How\'d it go tonight?</h2>' +
    '<div class="faces"><span><span class="emoji">😍</span>Love it</span><span><span class="emoji">🙂</span>Like it</span><span><span class="emoji">😐</span>It\'s OK</span><span><span class="emoji">👎</span>Not for me</span></div>' +
    '<div class="fill"><span>Date</span><i></i><span>Cooked by</span><i></i><span>Helpers</span><i></i><span>Next time</span><i></i></div>' +
    '<div class="lines-label">Notes and tweaks (snap a photo and send it to Poppy with 💡)</div><div class="lines"></div></div>' +
    footer(r, 'back') + '</section>';
  return front + back;
}

(async () => {
  const want = process.argv.slice(2);
  const files = fs.readdirSync(SRC).filter((f) => /^m\d+\.json$/.test(f)).sort();
  const tpl = fs.readFileSync(path.join(DIR, 'card.html'), 'utf8');
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const index = {};
  for (const f of files) {
    const r = JSON.parse(fs.readFileSync(path.join(SRC, f), 'utf8'));
    index[r.id] = { name: r.name, pdf: 'recipes/' + r.id + '.pdf', serves: r.serves || '', minutes: (Number(r.prep) || 0) + (Number(r.cook) || 0), draft: r.draft !== false };
    if (want.length && want.indexOf(r.id) < 0) continue;
    const tmp = path.join(DIR, '.tmp-' + r.id + '.html');
    fs.writeFileSync(tmp, tpl.replace('__BODY__', render(r)));
    await page.goto('file://' + tmp);
    await page.evaluate(() => document.fonts.ready);
    // Shrink the type until each page's content fits (front: steps + ingredients; back: crew + cards).
    let fs_ = 12;
    for (; fs_ >= 7.6; fs_ -= 0.2) {
      const over = await page.evaluate((v) => {
        document.documentElement.style.setProperty('--fs', v + 'pt');
        return [...document.querySelectorAll('.page')].some((p) => p.scrollHeight > p.clientHeight + 1 ||
          [...p.querySelectorAll('.cols > *')].some((c) => c.getBoundingClientRect().bottom > p.querySelector('.ft').getBoundingClientRect().top - 4));
      }, fs_.toFixed(1));
      if (!over) break;
    }
    if (fs_ < 7.6) console.warn('⚠ ' + r.id + ' still overflows at the smallest size');
    await page.pdf({ path: path.join(DIR, r.id + '.pdf'), format: 'Letter', printBackground: true, margin: { top: 0, right: 0, bottom: 0, left: 0 } });
    fs.unlinkSync(tmp);
    console.log(r.id, 'ok', fs_.toFixed(1) + 'pt');
  }
  await browser.close();
  fs.writeFileSync(path.join(DIR, 'index.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), recipes: index }, null, 1) + '\n');
})().catch((e) => { console.error(e); process.exit(1); });
