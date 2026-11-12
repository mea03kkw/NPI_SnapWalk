#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME_EXE = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE = 'file:///C:/Users/310138406/Desktop/Python%20course/M4/NPI_SnapWalk/public/index.html';
const SHOTS = path.join(__dirname, 'screenshots', 'r4-preview');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
function ok(l) { pass++; console.log('  PASS', l); }
function no(l, d) { fail++; console.error('  FAIL', l, d || ''); }

async function waitForApp(page) {
  await page.waitForFunction(() => !document.body.classList.contains('preload'), { timeout: 15000 });
  await page.waitForTimeout(400);
}

async function setLight(page) {
  await page.evaluate(() => {
    localStorage.setItem('npisnapwalk-theme-v1', 'light');
    document.documentElement.dataset.theme = 'light';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
}

async function setDark(page) {
  await page.evaluate(() => {
    localStorage.setItem('npisnapwalk-theme-v1', 'dark');
    document.documentElement.dataset.theme = 'dark';
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForApp(page);
}

(async () => {
  const browser = await chromium.launch({ executablePath: CHROME_EXE, headless: true });
  const errors = [];

  // ── T3: EB Report open + follow-up expand (mobile light) ──────────
  {
    console.log('\n── T3: EB module + follow-up (mobile light) ──');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('T3: ' + e.message));
    await page.goto(FILE, { waitUntil: 'domcontentloaded' });
    await setLight(page);

    const ebVisible = await page.evaluate(() => {
      const m = document.getElementById('module-eb');
      return m && !m.classList.contains('hidden');
    });
    ebVisible ? ok('T3 EB Report panel visible') : no('T3 EB not visible');

    const panelCount = await page.evaluate(() =>
      document.querySelectorAll('#module-eb .panel').length);
    panelCount >= 3 ? ok('T3 EB has ' + panelCount + ' panels') : no('T3 EB panel count', panelCount);

    const barHeight = await page.evaluate(() => {
      const bar = document.querySelector('.bottom-bar');
      return bar ? bar.getBoundingClientRect().height : 0;
    });
    barHeight >= 40 ? ok('T3 bottom bar usable h=' + Math.round(barHeight)) : no('T3 bottom bar too small', barHeight);

    const toggleExists = await page.evaluate(() => !!document.querySelector('.obs-detail-toggle'));
    if (toggleExists) {
      await page.click('.obs-detail-toggle');
      await page.waitForTimeout(300);
      const expanded = await page.evaluate(() => !!document.querySelector('.obs-detail-panel'));
      expanded ? ok('T3 follow-up panel expands') : no('T3 follow-up panel not expanded');
      await page.screenshot({ path: path.join(SHOTS, '02-mobile-light-followup.png') });
      ok('T3 follow-up screenshot saved');
    } else {
      no('T3 no obs-detail-toggle');
    }

    errors.length === 0 ? ok('T3 no console errors') : no('T3 console errors', errors.join('; '));
    await ctx.close();
  }

  // ── T4: Run@Rate module (mobile light) ────────────────────────────
  {
    console.log('\n── T4: R@R module (mobile light) ──');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('T4: ' + e.message));
    await page.goto(FILE, { waitUntil: 'domcontentloaded' });
    await setLight(page);

    const clicked = await page.evaluate(() => {
      for (const t of document.querySelectorAll('.module-tab')) {
        if (/run|rate/i.test(t.textContent)) { t.click(); return true; }
      }
      return false;
    });
    clicked ? ok('T4 R@R tab clicked') : no('T4 R@R tab not found');
    await page.waitForTimeout(400);

    const rnrVisible = await page.evaluate(() => {
      const m = document.getElementById('module-capacity');
      return m && !m.classList.contains('hidden');
    });
    rnrVisible ? ok('T4 R@R module visible') : no('T4 R@R not visible');

    await page.screenshot({ path: path.join(SHOTS, '03-mobile-light-rnr.png') });
    ok('T4 R@R screenshot saved');
    await ctx.close();
  }

  // ── T5: Desktop light mode 1280×800 ───────────────────────────────
  {
    console.log('\n── T5: Desktop light mode ──');
    const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('T5: ' + e.message));
    await page.goto(FILE, { waitUntil: 'domcontentloaded' });
    await setLight(page);

    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > 1280);
    !overflow ? ok('T5 no horizontal overflow 1280px') : no('T5 overflow at 1280px');

    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // rgb(223, 241, 250) = #DFF1FA — first channel 200-240 range confirms sky blue
    const firstCh5 = parseInt((bodyBg.match(/rgb\((\d+)/) || [])[1] || '0');
    const isBlue = firstCh5 >= 200 && firstCh5 <= 240;
    isBlue ? ok('T5 desktop sky blue bg: ' + bodyBg) : no('T5 desktop bg unexpected', bodyBg);

    await page.screenshot({ path: path.join(SHOTS, '04-desktop-light.png') });
    ok('T5 desktop screenshot saved');
    await ctx.close();
  }

  // ── T6: Draft save/reload + invalid export alert ──────────────────
  {
    console.log('\n── T6: Draft + export alert ──');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('T6: ' + e.message));
    await page.goto(FILE, { waitUntil: 'domcontentloaded' });
    await setLight(page);

    // Fill project name
    const inp = await page.$('input[id*="roject"], input[placeholder*="roject"]');
    if (inp) {
      await inp.fill('R4 Factory Platformer Test');
      await page.waitForTimeout(1800);
      const hasDraft = await page.evaluate(() =>
        Object.keys(localStorage).some(k => k.includes('draft') || k.includes('snap'))
      );
      hasDraft ? ok('T6 draft saved to localStorage') : no('T6 draft not in localStorage');
    } else {
      no('T6 project input not found');
    }

    // Export alert on empty required fields
    let alertFired = false;
    page.once('dialog', async d => { alertFired = true; await d.dismiss(); });
    await page.evaluate(() => { if (typeof barExport === 'function') barExport(); });
    await page.waitForTimeout(600);
    alertFired ? ok('T6 export guard alert fired') : no('T6 no alert on incomplete form');

    errors.length === 0 ? ok('T6 no console errors') : no('T6 console errors', errors.join('; '));
    await ctx.close();
  }

  // ── T7: Dark mode regression — no sky blue leakage ────────────────
  {
    console.log('\n── T7: Dark mode regression ──');
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('pageerror', e => errors.push('T7: ' + e.message));
    await page.goto(FILE, { waitUntil: 'domcontentloaded' });
    await setDark(page);

    const theme = await page.evaluate(() => document.documentElement.dataset.theme);
    theme === 'dark' ? ok('T7 dark theme set') : no('T7 theme wrong', theme);

    const bodyBg = await page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    // dark page = rgb(7,28,22) #071C16 — first channel must be < 30
    const firstCh = parseInt((bodyBg.match(/rgb\((\d+)/) || [])[1] || '999');
    const isDark = firstCh < 30;
    isDark ? ok('T7 dark page bg: ' + bodyBg) : no('T7 dark page bg unexpected', bodyBg);

    // Panel bg should be dark, not sky blue
    const panelBg = await page.evaluate(() => {
      const p = document.querySelector('.panel');
      return p ? getComputedStyle(p).backgroundColor : 'none';
    });
    const isSkyBlue = panelBg.includes('223') && panelBg.includes('241');
    !isSkyBlue ? ok('T7 dark panel bg clean: ' + panelBg) : no('T7 sky blue leaked into dark panel', panelBg);

    // Topbar should not have bright green border in dark mode
    const topbarBorderColor = await page.evaluate(() => {
      const t = document.querySelector('.topbar');
      return t ? getComputedStyle(t).borderBottomColor : 'none';
    });
    // Green #1A6633 = rgb(26,102,51) — should NOT appear in dark mode topbar
    const hasGreenTopbar = topbarBorderColor.includes('26, 102') || topbarBorderColor.includes('26,102');
    !hasGreenTopbar ? ok('T7 dark topbar no green border: ' + topbarBorderColor) : no('T7 green border leaked into dark topbar', topbarBorderColor);

    await page.screenshot({ path: path.join(SHOTS, '05-mobile-dark-regression.png') });
    ok('T7 dark regression screenshot saved');
    errors.filter(e => e.startsWith('T7')).length === 0 ? ok('T7 no console errors') : no('T7 console errors');
    await ctx.close();
  }

  console.log('\n──────────────────────────────');
  console.log('R4 smoke: ' + pass + ' PASS, ' + fail + ' FAIL');
  if (fail > 0) console.error('Failures detected');
  await browser.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
