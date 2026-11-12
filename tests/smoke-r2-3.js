#!/usr/bin/env node
/**
 * R2.3 live smoke test — npi-snapwalk.pages.dev
 * Checks Bug 1 (RnR alert) and Bug 2 (panel corners) on the live deployment.
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CHROME_EXE   = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE_URL     = 'https://npi-snapwalk.pages.dev';
const SCREENSHOTS  = path.join(__dirname, 'screenshots', 'smoke-r2-3');
const TIMEOUT_NAV  = 30000;

let pass = 0, fail = 0;
const failures = [];
function ok(label)             { pass++; console.log(`  ✓ ${label}`); }
function no(label, detail = '') {
  fail++;
  const msg = detail ? `${label} — ${detail}` : label;
  failures.push(msg);
  console.error(`  ✗ ${msg}`);
}
function section(t) { console.log(`\n── ${t} ──`); }

async function waitForApp(page) {
  await page.waitForFunction(() => !document.body.classList.contains('preload'), { timeout: 15000 });
  await page.waitForSelector('#observationContainer tr.obs-row-main',
    { timeout: 10000, state: 'attached' });
  await page.waitForTimeout(400);
}
async function closeDrawer(page) {
  await page.evaluate(() => { if (typeof closeAppMenu === 'function') closeAppMenu(); });
  await page.waitForTimeout(200);
}
async function setTheme(page, theme) {
  await page.click('#appMenuBtn');
  await page.waitForSelector('.app-menu-overlay:not(.hidden)');
  await page.click(`[data-theme-choice="${theme}"]`);
  await page.waitForTimeout(200);
  await closeDrawer(page);
}
async function addObs(page, categoryIdx, processId, desc) {
  await page.click('.bar-add');
  await page.waitForTimeout(300);
  const rows  = await page.$$('#observationContainer tr.obs-row-main');
  const row   = rows[rows.length - 1];
  const obsId = await row.getAttribute('data-obs-id');
  const sel   = await row.$('select.obs-category');
  if (sel) await sel.selectOption({ index: categoryIdx });
  const inp   = await row.$('input.obs-process-id');
  if (inp)   await inp.fill(processId);
  const descRow = await page.$(`#observationContainer tr.obs-desc-row[data-obs-id="${obsId}"]`);
  if (descRow) {
    const ta = await descRow.$('textarea.obs-description');
    if (ta) await ta.fill(desc);
  }
  return obsId;
}
async function expandFollowup(page, obsId) {
  const btn = await page.$(`#detail-toggle-${obsId}`);
  if (!btn) return false;
  await btn.click();
  await page.waitForSelector(`#obs-detail-${obsId}:not(.hidden)`,
    { state: 'attached', timeout: 4000 });
  await page.waitForTimeout(200);
  return true;
}
async function getPanelStyles(page, obsId) {
  return page.evaluate(id => {
    const row   = document.getElementById(id);
    if (!row) return null;
    const panel = row.querySelector('.obs-detail-panel');
    if (!panel) return null;
    const cs = getComputedStyle(panel);
    return {
      tl: cs.borderTopLeftRadius,
      tr: cs.borderTopRightRadius,
      bl: cs.borderBottomLeftRadius,
      br: cs.borderBottomRightRadius,
      bg: cs.backgroundColor,
    };
  }, `obs-detail-${obsId}`);
}
async function panelShot(page, obsId, fname) {
  const row   = await page.$(`#obs-detail-${obsId}`);
  if (!row) return;
  const panel = await row.$('.obs-detail-panel');
  if (!panel) return;
  await panel.scrollIntoViewIfNeeded();
  await page.waitForTimeout(200);
  const box = await panel.boundingBox();
  if (box) {
    await page.screenshot({
      path: path.join(SCREENSHOTS, fname),
      clip: { x: Math.max(0,box.x-12), y: Math.max(0,box.y-12),
               width: box.width+24, height: box.height+24 }
    });
  }
  ok(`Screenshot: ${fname}`);
}

(async () => {
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });
  const browser = await chromium.launch({
    executablePath: CHROME_EXE, headless: true,
    ignoreHTTPSErrors: true,
    args: ['--no-sandbox','--disable-setuid-sandbox','--ignore-certificate-errors']
  });
  console.log(`  Browser: Chrome ${browser.version()}`);
  console.log(`  Target:  ${LIVE_URL}\n`);
  const consoleErrors = [];

  try {
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('page-error: ' + e.message));

    // ── Load + version ────────────────────────────────────────────────────
    section('L1 — Live page load');
    const resp = await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    resp && resp.status() === 200 ? ok('HTTPS 200') : no('HTTP status', String(resp && resp.status()));
    await waitForApp(page);
    ok('App initialised');
    const ver = await page.evaluate(() => { try { return APP_VERSION; } catch { return null; } });
    ver === 'V2.3.16.00' ? ok(`Version: ${ver}`) : no('Version wrong', `${ver}`);

    // ── Bug 1: RnR alert on live URL ──────────────────────────────────────
    section('L2 — RnR export validation uses browser alert (live)');
    await page.click('#tabCapacity');
    await page.waitForFunction(
      () => { const el=document.getElementById('module-capacity'); return el&&!el.classList.contains('hidden'); },
      { timeout: 5000 }
    );
    await page.waitForTimeout(400);
    await page.evaluate(() => {
      ['rnrProjectName','rnrBuildIdentity'].forEach(id => {
        const el = document.getElementById(id);
        if (el) { el.value=''; el.dispatchEvent(new Event('input',{bubbles:true})); }
      });
    });

    let alertMsg = null, alertType = null;
    page.once('dialog', async d => { alertType=d.type(); alertMsg=d.message(); await d.accept(); });
    await page.click('#barExportBtn');
    await page.waitForTimeout(600);

    alertType === 'alert' ? ok('Live: RnR alert type = alert') : no('Live: RnR dialog type wrong', alertType);
    (alertMsg && alertMsg.startsWith('Please fix the following before exporting:')) ?
      ok('Live: RnR alert prefix correct') : no('Live: RnR alert prefix wrong', alertMsg?.slice(0,80));
    if (alertMsg) {
      const bullets = alertMsg.split('\n').filter(l => l.trim().startsWith('•'));
      bullets.length >= 2 ? ok(`Live: ${bullets.length} bullet lines`) :
        no('Live: insufficient bullet lines', JSON.stringify(bullets));
    }
    const noSemicolon = alertMsg && !alertMsg.includes(';');
    noSemicolon ? ok('Live: no semicolons in alert') : no('Live: semicolons present');
    const inlineShown = await page.evaluate(() => {
      const el = document.getElementById('rnrExportStatus');
      return el && el.style.display !== 'none' && el.textContent.includes('fix');
    });
    inlineShown ? no('Live: inline validation message visible') : ok('Live: no inline validation message');

    // ── Bug 2: Panel corners on live URL ──────────────────────────────────
    section('L3 — Follow-up panel corners on live URL');

    async function liveCornerCheck(vpW, vpH, theme) {
      const label = `${vpW<=500?'mobile':'desktop'}/${theme}`;
      await page.setViewportSize({ width: vpW, height: vpH });
      await setTheme(page, theme);
      await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
      await waitForApp(page);
      await page.click('#tabEb');
      await page.waitForTimeout(300);

      const obsId = await addObs(page, 1, 'OP-01', `Live corner test ${label}`);
      await expandFollowup(page, obsId);
      await page.fill(`#obs-detail-${obsId} .obs-followup`,    'Live action item');
      await page.fill(`#obs-detail-${obsId} .obs-target-date`,  '2026-12-01');
      await page.fill(`#obs-detail-${obsId} .obs-complete-date`, '2026-12-15');
      await page.fill(`#obs-detail-${obsId} .obs-support-doc`, 'https://live-test.example.com/ref');

      const styles = await getPanelStyles(page, obsId);
      if (!styles) { no(`${label}: panel not found on live URL`); return; }
      const r = s => parseFloat(s) || 0;
      r(styles.tl) > 0 ? ok(`${label}: top-left radius = ${styles.tl}`) : no(`${label}: top-left = 0`);
      r(styles.tr) > 0 ? ok(`${label}: top-right radius = ${styles.tr}`) : no(`${label}: top-right = 0`);
      r(styles.bl) > 0 ? ok(`${label}: bottom-left radius = ${styles.bl}`) : no(`${label}: bottom-left = 0`);
      r(styles.br) > 0 ? ok(`${label}: bottom-right radius = ${styles.br}`) : no(`${label}: bottom-right = 0`);

      if (theme === 'dark') {
        const m = styles.bg.match(/rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/);
        if (m && parseInt(m[1]) > 220 && parseInt(m[2]) > 220 && parseInt(m[3]) > 220) {
          no(`${label}: panel bg is light/white`, styles.bg);
        } else {
          ok(`${label}: panel bg is dark ${styles.bg}`);
        }
      }

      await panelShot(page, obsId, `live-panel-${label.replace('/','_')}.png`);
    }

    await liveCornerCheck(390,  844, 'light');
    await liveCornerCheck(390,  844, 'dark');
    await liveCornerCheck(1280, 800, 'light');
    await liveCornerCheck(1280, 800, 'dark');

    // ── Regression: draft + banner ────────────────────────────────────────
    section('L4 — Draft restored banner');
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, 'light');
    await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await waitForApp(page);
    await page.click('#tabEb');
    await page.waitForTimeout(300);
    await page.fill('#projectName', 'LIVE-R23-SMOKE');
    await page.waitForTimeout(1000);
    await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await waitForApp(page);
    await page.waitForTimeout(600);
    const restored = await page.inputValue('#projectName');
    restored === 'LIVE-R23-SMOKE' ? ok('"Draft restored." — projectName correct') :
      no('"Draft restored." failed', `got "${restored}"`);

    // ── Console errors ────────────────────────────────────────────────────
    section('L5 — Console errors');
    consoleErrors.length === 0 ? ok('0 console errors on live URL') :
      no('Console errors', consoleErrors.slice(0,3).join(' | '));

  } finally {
    await browser.close();
  }

  section('LIVE SMOKE RESULTS');
  console.log(`\n  PASS: ${pass}   FAIL: ${fail}\n`);
  if (failures.length > 0) {
    console.log('Failed:');
    failures.forEach(f => console.error(`  ✗ ${f}`));
  }
  const shots = fs.readdirSync(SCREENSHOTS).filter(f => f.endsWith('.png'));
  console.log(`\nScreenshots (${shots.length}):`);
  shots.forEach(f => console.log(`  ${path.join(SCREENSHOTS, f)}`));

  process.exit(fail > 0 ? 1 : 0);
})();
