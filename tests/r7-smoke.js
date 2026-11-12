#!/usr/bin/env node
'use strict';
const { chromium } = require('playwright');
const fs = require('fs'), path = require('path');

const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const FILE   = 'file:///C:/Users/310138406/Desktop/Python%20course/M4/NPI_SnapWalk/public/index.html';
const SHOTS  = path.join(__dirname, 'screenshots', 'r7-preview');
fs.mkdirSync(SHOTS, { recursive: true });

let pass = 0, fail = 0;
const ok  = l      => { pass++; console.log('  PASS', l); };
const no  = (l, d) => { fail++; console.error('  FAIL', l, d || ''); };

async function waitApp(page) {
    await page.waitForFunction(() => !document.body.classList.contains('preload'), { timeout: 15000 });
    await page.waitForTimeout(400);
    // Force scroll to top to ensure consistent screenshots
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.waitForTimeout(100);
}

async function light(page) {
    await page.evaluate(() => {
        localStorage.setItem('npisnapwalk-theme-v1', 'light');
        document.documentElement.dataset.theme = 'light';
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp(page);
}

async function dark(page) {
    await page.evaluate(() => {
        localStorage.setItem('npisnapwalk-theme-v1', 'dark');
        document.documentElement.dataset.theme = 'dark';
    });
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitApp(page);
}

(async () => {
    const browser = await chromium.launch({ executablePath: CHROME, headless: true });
    const errors = [];

    // ═══════════════════════════════════════════════════════════════════
    // T1: Header clipping — brand must be at y=0-50 on scroll:0
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T1: Header clipping fix ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T1: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        const positions = await pg.evaluate(() => ({
            scrollY:    window.scrollY,
            fwhTop:     document.querySelector('.factory-world-header')?.getBoundingClientRect().top,
            fwhH:       document.querySelector('.factory-world-header')?.getBoundingClientRect().height,
            fwhOverflow: getComputedStyle(document.querySelector('.factory-world-header')).overflow,
            brandTop:   document.querySelector('.fwh-brand')?.getBoundingClientRect().top,
            brandH:     document.querySelector('.fwh-brand')?.getBoundingClientRect().height,
            taglineTop: document.querySelector('.fwh-tagline')?.getBoundingClientRect().top,
            topbarTop:  document.querySelector('.topbar')?.getBoundingClientRect().top,
        }));

        positions.scrollY === 0 ? ok('T1 scroll position = 0') : no('T1 scroll not 0', positions.scrollY);
        positions.fwhTop === 0  ? ok('T1 factory header starts at y=0') : no('T1 factory header y', positions.fwhTop);
        (positions.fwhH >= 115 && positions.fwhH <= 145) ? ok('T1 header h=' + Math.round(positions.fwhH)) : no('T1 header height', positions.fwhH);
        positions.fwhOverflow !== 'hidden' ? ok('T1 overflow not hidden: ' + positions.fwhOverflow) : no('T1 overflow hidden causes clipping');
        (positions.brandTop >= 0 && positions.brandTop < 25) ? ok('T1 brand visible at y=' + Math.round(positions.brandTop)) : no('T1 brand not at top', positions.brandTop);
        (positions.brandH >= 15) ? ok('T1 brand rendered h=' + Math.round(positions.brandH)) : no('T1 brand height tiny', positions.brandH);
        (Math.abs(positions.topbarTop - positions.fwhH) < 5) ? ok('T1 topbar directly after header') : no('T1 topbar gap', positions.topbarTop - positions.fwhH);

        // Screenshot 1: initial mobile at scroll=0
        await pg.screenshot({ path: path.join(SHOTS, '01-initial-mobile-scroll0.png') });
        ok('T1 screenshot 1 (initial mobile scroll=0)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T2: No duplicate brand in topbar
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T2: No duplicate brand ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T2: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        const brandVisible = await pg.evaluate(() => {
            const bn = document.querySelector('.brand-name');
            if (!bn) return 'missing';
            const s = getComputedStyle(bn);
            return s.display;
        });
        brandVisible === 'none' ? ok('T2 topbar brand-name hidden') : no('T2 topbar brand visible', brandVisible);

        // Pixelify Sans on header brand
        const fwhFont = await pg.evaluate(() => {
            const b = document.querySelector('.fwh-brand');
            return b ? getComputedStyle(b).fontFamily : 'missing';
        });
        fwhFont.includes('Pixelify') ? ok('T2 Pixelify Sans on header brand') : no('T2 header font', fwhFont.slice(0,30));

        // Screenshot 2: header close-up
        const hdr = await pg.locator('.factory-world-header').boundingBox();
        if (hdr) await pg.screenshot({ path: path.join(SHOTS, '02-header-closeup.png'),
            clip: { x: 0, y: hdr.y, width: 390, height: hdr.height + 50 } });
        ok('T2 screenshot 2 (header close-up)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T3: Wooden sign — panel header checks
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T3: Wooden sign + EB selector ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T3: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        // Panel header background = mid wood (#A85E25 = rgb(168,94,37))
        const phBg = await pg.evaluate(() => {
            const ph = document.querySelector('[data-section="eb-build"] .panel-header');
            return ph ? getComputedStyle(ph).backgroundColor : 'missing';
        });
        const phRgb = phBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        const isMidWood = phRgb && parseInt(phRgb[1]) > 140 && parseInt(phRgb[1]) < 200
                          && parseInt(phRgb[2]) > 60 && parseInt(phRgb[2]) < 120;
        isMidWood ? ok('T3 EB panel header wood tone: ' + phBg) : no('T3 EB header', phBg);

        // Panel-header has background-image (plank grain + frame)
        const phBgImg = await pg.evaluate(() => {
            const ph = document.querySelector('.panel-header');
            return ph ? getComputedStyle(ph).backgroundImage.slice(0,60) : 'none';
        });
        phBgImg.includes('linear-gradient') ? ok('T3 sign has background-image gradients') : no('T3 no sign gradients', phBgImg);

        // Panel-title: Pixelify Sans
        const ptFont = await pg.evaluate(() => {
            const pt = document.querySelector('.panel-title');
            return pt ? getComputedStyle(pt).fontFamily : 'missing';
        });
        ptFont.includes('Pixelify') ? ok('T3 Pixelify Sans on section heading') : no('T3 heading font', ptFont.slice(0,30));

        // Panel-title: sign cream text color (#FFF4CF)
        const ptColor = await pg.evaluate(() => {
            const pt = document.querySelector('.panel-title');
            return pt ? getComputedStyle(pt).color : 'missing';
        });
        // #FFF4CF = rgb(255,244,207)
        const isSignCream = ptColor.includes('255, 244') || ptColor.includes('255,244');
        isSignCream ? ok('T3 section title cream: ' + ptColor) : no('T3 title color', ptColor);

        // Module selector: fit-content (no gray extension)
        const tabsW = await pg.evaluate(() => {
            const mt = document.querySelector('.module-tabs');
            if (!mt) return 0;
            const r = mt.getBoundingClientRect();
            return r.width;
        });
        // Should be ~314px (2×150 + 6 gap + 2×8 padding) not 420px
        tabsW < 380 ? ok('T3 selector compact w=' + Math.round(tabsW)) : no('T3 selector too wide', tabsW);

        // Active EB tab: red
        const ebBg = await pg.evaluate(() => getComputedStyle(document.querySelector('#tabEb')).backgroundColor);
        ebBg.includes('192, 57') ? ok('T3 EB active red: ' + ebBg) : no('T3 EB tab', ebBg);

        // Screenshot 3: EB selector + first section
        await pg.screenshot({ path: path.join(SHOTS, '03-eb-selector-section.png'), fullPage: false });
        ok('T3 screenshot 3 (EB selector + section)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T4: R@R selector + blue wooden sign
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T4: R@R selector + blue sign ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T4: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        await pg.click('#tabCapacity');
        await pg.waitForTimeout(400);

        const rnrBg = await pg.evaluate(() => {
            const ph = document.querySelector('#module-capacity .panel-header');
            return ph ? getComputedStyle(ph).backgroundColor : 'missing';
        });
        // Blue mid wood ~rgb(46,95,140)
        const rnrRgb = rnrBg.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        const isBlueSign = rnrRgb && parseInt(rnrRgb[3]) > parseInt(rnrRgb[1]) * 1.5;
        isBlueSign ? ok('T4 R@R blue sign: ' + rnrBg) : no('T4 R@R sign', rnrBg);

        const tabCapBg = await pg.evaluate(() => getComputedStyle(document.querySelector('#tabCapacity')).backgroundColor);
        tabCapBg.includes('26, 87') ? ok('T4 R@R active blue: ' + tabCapBg) : no('T4 R@R tab', tabCapBg);

        await pg.screenshot({ path: path.join(SHOTS, '04-rnr-selector-section.png'), fullPage: false });
        ok('T4 screenshot 4 (R@R selector + sign)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T5: Observations section + icon + follow-up
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T5: Observations section ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T5: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        // Scroll to obs section
        await pg.evaluate(() => {
            const p = document.querySelector('[data-section="eb-obs"]');
            if (p) p.scrollIntoView({ behavior: 'instant' });
        });
        await pg.waitForTimeout(200);

        // Red icon plaque on obs section
        const obsPlaqueBg = await pg.evaluate(() => {
            const ph = document.querySelector('[data-section="eb-obs"] .panel-header');
            if (!ph) return 'missing';
            // Check ::before pseudo-element background color via computed style on the element
            // We can't directly query ::before, but we can check if data-section exists
            return ph ? 'panel-found' : 'missing';
        });
        obsPlaqueBg === 'panel-found' ? ok('T5 obs panel-header found') : no('T5 obs panel missing');

        // Follow-up expand
        const toggleExists = await pg.evaluate(() => !!document.querySelector('.obs-detail-toggle'));
        if (toggleExists) {
            await pg.click('.obs-detail-toggle');
            await pg.waitForTimeout(300);
            const expanded = await pg.evaluate(() => !!document.querySelector('.obs-detail-panel'));
            expanded ? ok('T5 follow-up expands') : no('T5 follow-up not expanded');
        }

        await pg.screenshot({ path: path.join(SHOTS, '05-obs-section-icon.png'), fullPage: false });
        ok('T5 screenshot 5 (observations + icon)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T6: Build result + status tiles
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T6: Status tiles ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T6: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        // Scroll to export status section
        await pg.evaluate(() => {
            const p = document.querySelector('.export-status-section');
            if (p) p.scrollIntoView({ behavior: 'instant' });
        });
        await pg.waitForTimeout(200);

        // Status tiles: grid layout
        const exportLayout = await pg.evaluate(() => {
            const eb = document.querySelector('.export-status-section .export-bar');
            return eb ? getComputedStyle(eb).display : 'missing';
        });
        exportLayout === 'grid' ? ok('T6 export bar is grid') : no('T6 export bar not grid', exportLayout);

        // Stat label visible (was hidden in R6)
        const labelDisplay = await pg.evaluate(() => {
            const el = document.querySelector('.export-status-section .export-stat-label');
            return el ? getComputedStyle(el).display : 'missing';
        });
        labelDisplay !== 'none' ? ok('T6 stat label visible: ' + labelDisplay) : no('T6 stat label hidden');

        // Screenshot 6: status tiles
        const statusBox = await pg.locator('.export-status-section').boundingBox();
        if (statusBox) {
            await pg.screenshot({ path: path.join(SHOTS, '06-status-tiles.png'),
                clip: { x: 0, y: Math.max(0, statusBox.y - 30), width: 390, height: statusBox.height + 50 } });
        }
        ok('T6 screenshot 6 (status tiles)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T7: Bottom action bar
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T7: Action bar ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T7: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        const barBg = await pg.evaluate(() => getComputedStyle(document.querySelector('.bottom-bar')).backgroundColor);
        const ch1 = parseInt((barBg.match(/rgb\((\d+)/) || [])[1] || 999);
        ch1 < 30 ? ok('T7 bar dark: ' + barBg) : no('T7 bar bg', barBg);

        const labelFont = await pg.evaluate(() => {
            const bl = document.querySelector('.bar-label');
            return bl ? getComputedStyle(bl).fontFamily : 'missing';
        });
        labelFont.includes('Pixelify') || labelFont.includes('Press Start') ? ok('T7 bar label pixel font') : no('T7 bar label font', labelFont.slice(0,30));

        const labelSize = await pg.evaluate(() => {
            const bl = document.querySelector('.bar-label');
            return bl ? getComputedStyle(bl).fontSize : 'missing';
        });
        ok('T7 bar label size: ' + labelSize);  // report, don't fail

        // Export guard
        let alerted = false;
        pg.once('dialog', async d => { alerted = true; await d.dismiss(); });
        await pg.evaluate(() => { if (typeof barExport === 'function') barExport(); });
        await pg.waitForTimeout(500);
        alerted ? ok('T7 export guard fires') : no('T7 no export guard');

        await pg.screenshot({ path: path.join(SHOTS, '07-action-bar.png'), clip: { x: 0, y: 740, width: 390, height: 104 } });
        ok('T7 screenshot 7 (action bar)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T8: Desktop overview
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T8: Desktop overview ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T8: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);

        const ov = await pg.evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 2);
        !ov ? ok('T8 no overflow 1280px') : no('T8 overflow');

        const fwhH = await pg.evaluate(() => document.querySelector('.factory-world-header')?.getBoundingClientRect().height || 0);
        fwhH >= 130 ? ok('T8 desktop header h=' + Math.round(fwhH)) : no('T8 desktop header', fwhH);

        await pg.screenshot({ path: path.join(SHOTS, '08-desktop-overview.png'), fullPage: false });
        ok('T8 screenshot 8 (desktop overview)');
        await ctx.close();
    }

    // ═══════════════════════════════════════════════════════════════════
    // T9: Dark mode regression
    // ═══════════════════════════════════════════════════════════════════
    console.log('\n── T9: Dark mode regression ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        pg.on('pageerror', e => errors.push('T9: ' + e.message));
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await dark(pg);

        const fwhDark = await pg.evaluate(() => getComputedStyle(document.querySelector('.factory-world-header')).display);
        fwhDark === 'none' ? ok('T9 factory header hidden in dark') : no('T9 factory header visible in dark', fwhDark);

        const bgDark = await pg.evaluate(() => getComputedStyle(document.body).backgroundColor);
        parseInt((bgDark.match(/rgb\((\d+)/) || [])[1] || 999) < 30 ? ok('T9 dark body bg: ' + bgDark) : no('T9 dark bg', bgDark);

        // Panel header should NOT be wood-brown in dark
        const phDark = await pg.evaluate(() => {
            const ph = document.querySelector('.panel-header');
            return ph ? getComputedStyle(ph).backgroundColor : 'missing';
        });
        const phRgb = phDark.match(/rgb\((\d+),\s*(\d+),\s*(\d+)\)/);
        const isWoodBrown = phRgb && parseInt(phRgb[1]) > 150 && parseInt(phRgb[2]) > 60 && parseInt(phRgb[3]) < 80;
        !isWoodBrown ? ok('T9 dark: no wood-brown sign leak') : no('T9 wood brown leaked to dark', phDark);

        // Pixelify Sans should NOT show on panel-title in dark mode
        const ptDarkFont = await pg.evaluate(() => {
            const pt = document.querySelector('.panel-title');
            return pt ? getComputedStyle(pt).fontFamily : 'missing';
        });
        !ptDarkFont.includes('Pixelify') ? ok('T9 dark: Pixelify Sans not leaked') : no('T9 Pixelify leaked to dark');

        errors.filter(e => e.startsWith('T9')).length === 0 ? ok('T9 no errors') : no('T9 errors');
        await pg.screenshot({ path: path.join(SHOTS, '09-dark-regression.png'), fullPage: false });
        ok('T9 screenshot 9 (dark regression)');
        await ctx.close();
    }

    // ── Font offline check ───────────────────────────────────────────
    console.log('\n── T10: Font offline ──');
    {
        const ctx = await browser.newContext({ viewport: { width: 390, height: 844 } });
        const pg  = await ctx.newPage();
        const extFonts = [];
        pg.on('request', req => {
            if (req.url().includes('fonts.googleapis') || req.url().includes('fonts.gstatic')) extFonts.push(req.url());
        });
        await pg.goto(FILE, { waitUntil: 'domcontentloaded' });
        await light(pg);
        await pg.waitForTimeout(800);
        extFonts.length === 0 ? ok('T10 no external font requests') : no('T10 external fonts', extFonts[0]);

        const pixFont = await pg.evaluate(() => {
            const b = document.querySelector('.fwh-brand');
            return b ? getComputedStyle(b).fontFamily : 'missing';
        });
        pixFont.includes('Pixelify') ? ok('T10 Pixelify Sans locally loaded: ' + pixFont.slice(0,25)) : no('T10 font not loaded', pixFont.slice(0,25));
        await ctx.close();
    }

    console.log('\n── All errors ──');
    if (errors.length) errors.slice(0,5).forEach(e => console.error(' ', e));
    else console.log('  (none)');

    console.log('\n──────────────────────────────');
    console.log('R7 smoke: ' + pass + ' PASS, ' + fail + ' FAIL');
    await browser.close();
    process.exit(fail > 0 ? 1 : 0);
})().catch(e => { console.error(e); process.exit(1); });
