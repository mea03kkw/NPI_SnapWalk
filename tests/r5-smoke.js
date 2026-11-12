#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE   = 'file:///C:/Users/310138406/Desktop/Python%20course/M4/NPI_SnapWalk/public/index.html';
const SHOTS  = path.join(__dirname, 'screenshots', 'r5-preview');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok  = l      => { pass++; console.log('  PASS', l); };
const no  = (l, d) => { fail++; console.error('  FAIL', l, d || ''); };

async function waitApp(page) {
    await page.waitForFunction(() => !document.body.classList.contains('preload'), { timeout: 15000 });
    await page.waitForTimeout(500);
}

async function setTheme(page, t) {
    await page.evaluate(th => {
        localStorage.setItem('npisnapwalk-theme-v1', th);
        document.documentElement.dataset.theme = th;
    }, t);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp(page);
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const errors = [];

    // ── T1: Factory world header visible in light mode ───────────
    console.log('\n── T1: Factory world header (mobile light) ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T1: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'light');

        // Factory header visible
        const fwhVisible = await pg.evaluate(() => {
            const h = document.querySelector('.factory-world-header');
            if (!h) return 'missing';
            const s = getComputedStyle(h);
            return s.display !== 'none' ? 'visible' : 'hidden';
        });
        fwhVisible === 'visible' ? ok('T1 factory header visible') : no('T1 factory header', fwhVisible);

        // Factory header height 60-90px
        const fwhH = await pg.evaluate(() => {
            const h = document.querySelector('.factory-world-header');
            return h ? h.getBoundingClientRect().height : 0;
        });
        (fwhH >= 60 && fwhH <= 95) ? ok('T1 factory header h=' + Math.round(fwhH)) : no('T1 factory header height', fwhH);

        // Sky blue background (gradient — check backgroundImage)
        const fwhBg = await pg.evaluate(() => {
            const h = document.querySelector('.factory-world-header');
            return h ? getComputedStyle(h).backgroundImage : 'none';
        });
        const hasSkyBlue = fwhBg.includes('85, 191') || fwhBg.includes('55, 191') || fwhBg.includes('168, 221');
        hasSkyBlue ? ok('T1 sky blue gradient') : no('T1 sky bg', fwhBg.slice(0, 60));

        // Inspector mascot present
        const mascot = await pg.evaluate(() => !!document.querySelector('.fwh-mascot'));
        mascot ? ok('T1 inspector mascot present') : no('T1 mascot missing');

        // Factory building present
        const bldg = await pg.evaluate(() => !!document.querySelector('.fwh-building'));
        bldg ? ok('T1 building present') : no('T1 building missing');

        // Pixel font loaded (brand-name)
        const brandFont = await pg.evaluate(() => {
            const b = document.querySelector('.brand-name');
            return b ? getComputedStyle(b).fontFamily : 'none';
        });
        brandFont.toLowerCase().includes('press start') ? ok('T1 Press Start 2P loaded: ' + brandFont.slice(0,30)) : no('T1 pixel font', brandFont);

        // No horizontal overflow
        const ov = await pg.evaluate(() => document.documentElement.scrollWidth > 390);
        !ov ? ok('T1 no overflow 390px') : no('T1 overflow at 390px');

        await pg.screenshot({ path: path.join(SHOTS, '01-mobile-light-header.png') });
        ok('T1 header screenshot saved');
        await ctx.close();
    }

    // ── T2: Shop-sign panel headers ──────────────────────────────
    console.log('\n── T2: Shop-sign panel headers (mobile light) ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T2: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'light');

        // Panel header has green gradient background (check backgroundImage)
        const phBg = await pg.evaluate(() => {
            const ph = document.querySelector('#module-eb .panel-header');
            return ph ? getComputedStyle(ph).backgroundImage : 'none';
        });
        // EB: should contain green rgb values e.g. rgb(18, 136, 59)
        const isGreen = phBg.includes('18, 136, 59') || phBg.includes('12, 136') || phBg.includes('136, 5') || phBg.includes('12, 88');
        isGreen ? ok('T2 EB panel header green sign') : no('T2 panel header bg', phBg.slice(0, 60));

        // Panel title color: white on green background
        const ptColor = await pg.evaluate(() => {
            const pt = document.querySelector('#module-eb .panel-title');
            return pt ? getComputedStyle(pt).color : 'none';
        });
        const isWhite = ptColor.includes('255, 255, 255') || ptColor.includes('255,255,255');
        isWhite ? ok('T2 panel title white on sign') : no('T2 panel title color', ptColor);

        // R@R panels have blue header (gradient — check backgroundImage)
        const rnrPanelHeaderBg = await pg.evaluate(() => {
            const ph = document.querySelector('#module-capacity .panel-header');
            if (!ph) return 'hidden-module';
            return getComputedStyle(ph).backgroundImage;
        });
        // Blue: rgb(22, 116, 209) or similar
        const isBlue = rnrPanelHeaderBg.includes('22, 116') || rnrPanelHeaderBg.includes('1674D1') ||
                       rnrPanelHeaderBg.includes('22,116') || rnrPanelHeaderBg.includes('18, 96');
        (isBlue || rnrPanelHeaderBg === 'hidden-module') ?
            ok('T2 R@R panel header blue (or module hidden)') :
            no('T2 R@R panel header not blue', rnrPanelHeaderBg.slice(0, 60));

        // Panel has dark outline border
        const panelBorder = await pg.evaluate(() => {
            const p = document.querySelector('.panel');
            return p ? getComputedStyle(p).borderTopColor : 'none';
        });
        const isDark = panelBorder.includes('16, 32, 51') || panelBorder.includes('16,32,51');
        isDark ? ok('T2 panel dark outline: ' + panelBorder) : no('T2 panel border', panelBorder);

        await pg.screenshot({ path: path.join(SHOTS, '02-mobile-light-panels.png') });
        ok('T2 panels screenshot');
        await ctx.close();
    }

    // ── T3: Module tabs are factory checkpoint signs ──────────────
    console.log('\n── T3: Module tabs (mobile light) ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T3: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'light');

        // Module tab uses pixel font
        const tabFont = await pg.evaluate(() => {
            const t = document.querySelector('.module-tab');
            return t ? getComputedStyle(t).fontFamily : 'none';
        });
        tabFont.toLowerCase().includes('press start') ? ok('T3 module tab pixel font') : no('T3 module tab font', tabFont);

        // Active tab has green background
        const activeTabBg = await pg.evaluate(() => {
            const t = document.querySelector('.module-tab.active, .module-tab[aria-selected="true"]');
            return t ? getComputedStyle(t).backgroundColor : 'none';
        });
        const activeCh2 = (activeTabBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/) || [0,0,0,0]).map(Number);
        const activeBgGreen = activeCh2[2] > activeCh2[1] && activeCh2[2] > activeCh2[3];
        activeBgGreen ? ok('T3 active tab green: ' + activeTabBg) : no('T3 active tab bg', activeTabBg);

        // R@R switch works
        const rnrClicked = await pg.evaluate(() => {
            for (const t of document.querySelectorAll('.module-tab')) {
                if (/run|rate/i.test(t.textContent)) { t.click(); return true; }
            }
            return false;
        });
        rnrClicked ? ok('T3 R@R tab clicked') : no('T3 R@R tab not found');
        await pg.waitForTimeout(400);

        const rnrVisible = await pg.evaluate(() => {
            const m = document.getElementById('module-capacity');
            return m && !m.classList.contains('hidden');
        });
        rnrVisible ? ok('T3 R@R module visible') : no('T3 R@R not visible');

        await pg.screenshot({ path: path.join(SHOTS, '03-mobile-light-rnr.png') });
        ok('T3 R@R screenshot');
        await ctx.close();
    }

    // ── T4: Action bar dark industrial treatment ──────────────────
    console.log('\n── T4: Action bar (mobile light) ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T4: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'light');

        // Bottom bar dark background
        const barBg = await pg.evaluate(() => {
            const b = document.querySelector('.bottom-bar');
            return b ? getComputedStyle(b).backgroundColor : 'none';
        });
        const barCh1 = parseInt((barBg.match(/rgb\((\d+)/) || [])[1] || 999);
        barCh1 < 30 ? ok('T4 action bar dark: ' + barBg) : no('T4 bar bg not dark', barBg);

        // Bar height usable
        const barH = await pg.evaluate(() => {
            const b = document.querySelector('.bottom-bar');
            return b ? b.getBoundingClientRect().height : 0;
        });
        barH >= 44 ? ok('T4 bar height ' + Math.round(barH)) : no('T4 bar too small', barH);

        // Follow-up panel works
        const toggleOk = await pg.evaluate(() => !!document.querySelector('.obs-detail-toggle'));
        if (toggleOk) {
            await pg.click('.obs-detail-toggle');
            await pg.waitForTimeout(300);
            const expanded = await pg.evaluate(() => !!document.querySelector('.obs-detail-panel'));
            expanded ? ok('T4 follow-up expands') : no('T4 follow-up not expanded');
        } else {
            no('T4 no obs-detail-toggle');
        }

        // Export guard fires
        let alerted = false;
        pg.once('dialog', async d => { alerted = true; await d.dismiss(); });
        await pg.evaluate(() => { if (typeof barExport === 'function') barExport(); });
        await pg.waitForTimeout(600);
        alerted ? ok('T4 export guard alert') : no('T4 no export alert');

        await pg.screenshot({ path: path.join(SHOTS, '04-mobile-light-bar.png') });
        ok('T4 action bar screenshot');
        await ctx.close();
    }

    // ── T5: Desktop light mode ────────────────────────────────────
    console.log('\n── T5: Desktop light mode ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T5: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'light');

        const ov = await pg.evaluate(() => document.documentElement.scrollWidth > 1280);
        !ov ? ok('T5 no overflow 1280px') : no('T5 overflow');

        const fwhH = await pg.evaluate(() => {
            const h = document.querySelector('.factory-world-header');
            return h ? h.getBoundingClientRect().height : 0;
        });
        (fwhH >= 75) ? ok('T5 desktop header taller: h=' + Math.round(fwhH)) : no('T5 desktop header', fwhH);

        await pg.screenshot({ path: path.join(SHOTS, '05-desktop-light.png') });
        ok('T5 desktop screenshot');
        await ctx.close();
    }

    // ── T6: Dark mode regression — factory header hidden ─────────
    console.log('\n── T6: Dark mode regression ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T6: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'dark');

        // Factory header hidden in dark mode
        const fwhDark = await pg.evaluate(() => {
            const h = document.querySelector('.factory-world-header');
            return h ? getComputedStyle(h).display : 'none';
        });
        fwhDark === 'none' ? ok('T6 factory header hidden in dark') : no('T6 factory header visible in dark', fwhDark);

        // Dark page background
        const bgDark = await pg.evaluate(() => getComputedStyle(document.body).backgroundColor);
        const ch1D = parseInt((bgDark.match(/rgb\((\d+)/) || [])[1] || 999);
        ch1D < 30 ? ok('T6 dark page bg: ' + bgDark) : no('T6 dark page bg', bgDark);

        // Panel bg dark
        const panBgD = await pg.evaluate(() => {
            const p = document.querySelector('.panel');
            return p ? getComputedStyle(p).backgroundColor : 'none';
        });
        const ch1P = parseInt((panBgD.match(/rgb\((\d+)/) || [])[1] || 999);
        ch1P < 40 ? ok('T6 dark panel bg clean: ' + panBgD) : no('T6 dark panel leaked', panBgD);

        // Panel header should NOT be bright green in dark mode
        const phDark = await pg.evaluate(() => {
            const ph = document.querySelector('.panel-header');
            return ph ? getComputedStyle(ph).backgroundColor : 'none';
        });
        const phRgb = phDark.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        const isBrightGreen = phRgb && parseInt(phRgb[2]) > 100 && parseInt(phRgb[2]) > parseInt(phRgb[1]) * 2;
        !isBrightGreen ? ok('T6 dark panel header no green leak: ' + phDark) : no('T6 green sign leaked into dark', phDark);

        await pg.screenshot({ path: path.join(SHOTS, '06-mobile-dark-regression.png') });
        ok('T6 dark regression screenshot');
        errors.filter(e => e.startsWith('T6')).length === 0 ? ok('T6 no console errors') : no('T6 errors');
        await ctx.close();
    }

    // ── T7: Font offline / no external requests ───────────────────
    console.log('\n── T7: Offline font check ──');
    {
        // Verify no google fonts requests were made
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        const externalFontRequests = [];
        pg.on('request', req => {
            const url = req.url();
            if ((url.includes('fonts.googleapis') || url.includes('fonts.gstatic')) && url.includes('Press')) {
                externalFontRequests.push(url);
            }
        });
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await setTheme(pg, 'light');
        await pg.waitForTimeout(1000);
        externalFontRequests.length === 0 ? ok('T7 no external font requests') : no('T7 external fonts requested', externalFontRequests[0]);
        await ctx.close();
    }

    console.log('\n── All errors ──');
    if (errors.length) errors.forEach(e => console.error(' ', e));
    else console.log('  (none)');

    console.log('\n──────────────────────────────');
    console.log('R5 smoke: ' + pass + ' PASS, ' + fail + ' FAIL');
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
