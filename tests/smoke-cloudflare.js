#!/usr/bin/env node
/**
 * Post-deployment smoke test — runs against the live Cloudflare Pages URL.
 * Usage: node tests/smoke-cloudflare.js
 */
'use strict';
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const CHROME_EXE   = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const LIVE_URL     = 'https://npi-snapwalk.pages.dev';
const SCREENSHOTS  = path.join(__dirname, 'screenshots', 'smoke');
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

async function waitForDialogOpen(page, id) {
  await page.waitForFunction(
    id => { const el = document.getElementById(id); return el && !el.classList.contains('hidden'); },
    id, { timeout: 5000 }
  );
}
async function waitForDialogClosed(page, id) {
  await page.waitForFunction(
    id => { const el = document.getElementById(id); return el && el.classList.contains('hidden'); },
    id, { timeout: 5000 }
  );
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

(async () => {
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });

  const browser = await chromium.launch({
    executablePath: CHROME_EXE,
    headless: true,
    ignoreHTTPSErrors: true,  // handles corp network SSL revocation issue
    args: ['--no-sandbox', '--disable-setuid-sandbox',
           '--ignore-certificate-errors',
           '--ignore-certificate-errors-spki-list']
  });
  console.log(`  Browser: Chrome ${browser.version()}`);
  console.log(`  Target:  ${LIVE_URL}\n`);

  const consoleErrors = [];

  try {
    // ── Clean context (no stored draft) ───────────────────────────────────
    section('S1 — Page load, HTTPS, no console errors');
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('page-error: ' + e.message));

    const resp = await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    const status = resp ? resp.status() : 0;
    status === 200 ? ok(`HTTPS 200 OK (${LIVE_URL})`) : no(`HTTPS response status`, `got ${status}`);

    await waitForApp(page);
    ok('App initialised (preload removed, obs row attached)');

    // S1 screenshot
    await page.screenshot({ path: path.join(SCREENSHOTS, 'S1-load-mobile-light.png') });
    ok('Screenshot S1-load-mobile-light.png');

    // ── Version ───────────────────────────────────────────────────────────
    section('S2 — Correct version deployed');
    const version = await page.evaluate(() => {
      try { return typeof APP_VERSION !== 'undefined' ? APP_VERSION : null; } catch { return null; }
    });
    version === 'V2.3.16.01' ? ok(`Version: ${version}`) : no('Version mismatch', `got "${version}"`);

    // ── No Safari warning ─────────────────────────────────────────────────
    section('S3 — Safari warning absent');
    // Simulate standalone
    await page.evaluate(() => {
      const o = window.matchMedia;
      window.matchMedia = q => q === '(display-mode: standalone)'
        ? { matches: true, addListener() {}, removeEventListener() {} }
        : (o ? o.call(window, q) : { matches: false });
      sessionStorage.removeItem('appStandaloneWarningShown');
    });
    await page.evaluate(() => { if (typeof detectStandaloneMode === 'function') detectStandaloneMode(); });
    await page.waitForTimeout(400);
    const warnPresent = await page.evaluate(() => {
      const b = document.getElementById('appWarnings');
      return b ? Array.from(b.children).some(c => c.textContent.includes('Safari')) : false;
    });
    warnPresent ? no('No Safari warning on live URL') : ok('No Safari warning on live URL');
    await page.evaluate(() => { delete window.matchMedia; });

    // ── Modules ───────────────────────────────────────────────────────────
    section('S4 — EB Report Creator and Run@Rate Creator');
    const ebVisible = await page.isVisible('#module-eb');
    ebVisible ? ok('EB Report Creator module visible on load') : no('EB module not visible on load');

    // Switch to RnR
    await page.click('#tabCapacity');
    await page.waitForTimeout(400);
    const capVisible = await page.evaluate(() => {
      const el = document.getElementById('module-capacity');
      return el && !el.classList.contains('hidden');
    });
    capVisible ? ok('Run@Rate Creator module opens') : no('Run@Rate module failed to open');

    // Switch back to EB
    await page.click('#tabEb');
    await page.waitForTimeout(300);

    // ── Danger zone visibility swaps ──────────────────────────────────────
    section('S5 — Danger Zone visibility');

    // EB module active → EB danger visible, RnR hidden
    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');
    const ebDangerOnEb  = await page.isVisible('#ebResetFormItem');
    const rnrDangerOnEb = await page.isVisible('#rnrResetFormItem');
    ebDangerOnEb  ? ok('EB Danger Zone visible (EB module)') : no('EB Danger Zone not visible (EB module)');
    rnrDangerOnEb ? no('RnR Danger Zone hidden (EB module)')  : ok('RnR Danger Zone correctly hidden (EB module)');
    await closeDrawer(page);

    // Switch to RnR
    await page.click('#tabCapacity');
    await page.waitForTimeout(400);
    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');
    const rnrDangerOnRnr = await page.isVisible('#rnrResetFormItem');
    const ebDangerOnRnr  = await page.isVisible('#ebResetFormItem');
    rnrDangerOnRnr ? ok('RnR Danger Zone visible (RnR module)') : no('RnR Danger Zone not visible (RnR module)');
    ebDangerOnRnr  ? no('EB Danger Zone hidden (RnR module)')   : ok('EB Danger Zone correctly hidden (RnR module)');
    await closeDrawer(page);

    // Switch back to EB for reset tests
    await page.click('#tabEb');
    await page.waitForTimeout(300);

    // ── EB reset dialog + Cancel ──────────────────────────────────────────
    section('S6 — EB reset dialog opens and Cancel works');
    await page.fill('#projectName', 'SMOKE-TEST-DATA');
    await page.waitForTimeout(800); // autosave

    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');
    await page.click('#ebResetFormItem');
    await waitForDialogOpen(page, 'ebResetDialogOverlay');
    ok('EB reset dialog opens on live URL');

    const lockActive = await page.isDisabled('#ebResetConfirmBtn');
    lockActive ? ok('1-second lock active on live URL') : no('1-second lock absent');

    // Screenshot: dialog
    await page.screenshot({ path: path.join(SCREENSHOTS, 'S6-eb-reset-dialog.png') });
    ok('Screenshot S6-eb-reset-dialog.png');

    await page.click('#ebResetCancelBtn');
    await waitForDialogClosed(page, 'ebResetDialogOverlay');
    ok('Cancel closes EB reset dialog');

    const pnAfterCancel = await page.inputValue('#projectName');
    pnAfterCancel === 'SMOKE-TEST-DATA' ?
      ok('Cancel: data preserved on live URL') :
      no('Cancel: data changed', `got "${pnAfterCancel}"`);

    // ── Follow-up details rendering ───────────────────────────────────────
    section('S7 — Follow-up / Details dark-theme rendering');

    // Set dark theme, expand follow-up, screenshot
    await setTheme(page, 'dark');
    await page.waitForTimeout(300);

    // Add obs and expand
    await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await waitForApp(page);
    await page.click('#tabEb');
    await page.waitForTimeout(300);
    await setTheme(page, 'dark');

    const obsId = await addObs(page, 1, 'OP-15', 'Dark-mode follow-up smoke test');
    const toggleId = `#detail-toggle-${obsId}`;
    const toggle = await page.$(toggleId);
    if (toggle) {
      await toggle.click();
      await page.waitForTimeout(400);
      await page.fill(`#obs-detail-${obsId} .obs-followup`,    'Smoke test action item');
      await page.fill(`#obs-detail-${obsId} .obs-target-date`,  '2026-12-10');
      await page.fill(`#obs-detail-${obsId} .obs-complete-date`, '2026-12-20');
      await page.fill(`#obs-detail-${obsId} .obs-support-doc`,  'https://smoke-test.example.com/ref');
      ok('Follow-up fields filled in dark theme');
    } else {
      no('Follow-up toggle not found', `obsId=${obsId}`);
    }

    await page.evaluate(id => {
      const el = document.getElementById(id);
      if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
    }, `obs-detail-${obsId}`);
    await page.waitForTimeout(400);

    // Check dark td
    const tdBg = await page.evaluate(id => {
      const detRow = document.getElementById(id);
      if (!detRow) return null;
      const td = detRow.querySelector('td');
      return td ? getComputedStyle(td).backgroundColor : null;
    }, `obs-detail-${obsId}`);
    if (tdBg) {
      const m = tdBg.match(/rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/);
      if (m) {
        const isWhite = m[1] > 220 && m[2] > 220 && m[3] > 220;
        isWhite ? no(`Dark mode td background (live)`, `${tdBg}`) :
                  ok(`Dark mode: td background dark (live) ${tdBg}`);
      }
    } else {
      no('Dark td background check: detail row or td missing');
    }

    await page.screenshot({ path: path.join(SCREENSHOTS, 'S7-followup-mobile-dark.png') });
    ok('Screenshot S7-followup-mobile-dark.png');

    // ── Draft save and "Draft restored." ─────────────────────────────────
    section('S8 — Draft save + "Draft restored." on live URL');
    await setTheme(page, 'light');
    await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await waitForApp(page);
    await page.click('#tabEb');
    await page.waitForTimeout(300);
    await page.fill('#projectName', 'SMOKE-DRAFT-TEST');
    await page.waitForTimeout(1000); // autosave
    const ebKeySaved = await page.evaluate(() => localStorage.getItem('npisnapwalk-draft-v1-eb') !== null);
    ebKeySaved ? ok('EB draft key saved on live URL') : no('EB draft key not saved');

    await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await waitForApp(page);
    await page.waitForTimeout(600);
    const restored = await page.inputValue('#projectName');
    restored === 'SMOKE-DRAFT-TEST' ? ok('"Draft restored." — projectName correct') :
      no('"Draft restored." failed', `got "${restored}"`);
    const banner = await page.evaluate(() => {
      const b = document.getElementById('draftBanner');
      return b ? b.textContent.trim() : '';
    });
    banner.toLowerCase().includes('restored') ? ok('"Draft restored." banner visible') :
      no('"Draft restored." banner missing', `banner="${banner}"`);

    // ── No horizontal overflow (mobile) ───────────────────────────────────
    section('S9 — No horizontal overflow');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    overflow ? no('No horizontal overflow (mobile 390px)') : ok('No horizontal overflow (mobile 390px)');

    // ── Desktop viewport ──────────────────────────────────────────────────
    section('S10 — Desktop 1280×800 rendering');
    await page.setViewportSize({ width: 1280, height: 800 });
    await page.waitForTimeout(300);
    const desktopOverflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
    desktopOverflow ? no('No horizontal overflow (desktop 1280px)') : ok('No horizontal overflow (desktop 1280px)');
    await page.screenshot({ path: path.join(SCREENSHOTS, 'S10-desktop-light.png') });
    ok('Screenshot S10-desktop-light.png');

    // Desktop dark
    await setTheme(page, 'dark');
    await page.screenshot({ path: path.join(SCREENSHOTS, 'S10-desktop-dark.png') });
    ok('Screenshot S10-desktop-dark.png');

    // Mobile dark screenshot
    await page.setViewportSize({ width: 390, height: 844 });
    await setTheme(page, 'dark');
    await page.goto(LIVE_URL, { waitUntil: 'networkidle', timeout: TIMEOUT_NAV });
    await waitForApp(page);
    await page.click('#tabEb');
    await page.waitForTimeout(300);
    await page.screenshot({ path: path.join(SCREENSHOTS, 'S10-mobile-dark.png') });
    ok('Screenshot S10-mobile-dark.png');

    // Mobile light screenshot
    await setTheme(page, 'light');
    await page.screenshot({ path: path.join(SCREENSHOTS, 'S10-mobile-light.png') });
    ok('Screenshot S10-mobile-light.png');

    // ── Service worker / cache ────────────────────────────────────────────
    section('S11 — Service worker / cache check');
    const swInfo = await page.evaluate(() => {
      if (!('serviceWorker' in navigator)) return 'no SW support';
      return navigator.serviceWorker.getRegistrations().then(regs =>
        regs.length === 0 ? 'no SW registered' : `${regs.length} SW(s) registered`
      );
    });
    const swResult = typeof swInfo === 'string' ? swInfo : await swInfo;
    console.log(`    SW status: ${swResult}`);
    ok(`Service worker check complete (${swResult})`);

    // ── Console errors ────────────────────────────────────────────────────
    section('S12 — Console error audit (live URL)');
    consoleErrors.length === 0 ? ok('No console errors on live URL') :
      no('Console errors on live URL', consoleErrors.slice(0, 3).join(' | '));

  } finally {
    await browser.close();
  }

  section('SMOKE TEST RESULTS');
  console.log(`\n  PASS: ${pass}   FAIL: ${fail}\n`);
  if (failures.length > 0) {
    console.log('Failed checks:');
    failures.forEach(f => console.error(`  ✗ ${f}`));
  }
  const shots = fs.readdirSync(SCREENSHOTS).filter(f => f.endsWith('.png'));
  console.log(`\nScreenshots (${shots.length}):`);
  shots.forEach(f => console.log(`  ${path.join(SCREENSHOTS, f)}`));

  process.exit(fail > 0 ? 1 : 0);
})();
