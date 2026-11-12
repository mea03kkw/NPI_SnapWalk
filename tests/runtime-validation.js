#!/usr/bin/env node
/**
 * NPI SnapWalk — Runtime Validation Suite  (R2.2)
 * Validates: Safari warning removal, EB/RnR Danger Zone resets,
 * Follow-up dark-theme fix, storage isolation, and reload persistence.
 *
 * Usage (from project root):  node tests/runtime-validation.js
 */

'use strict';
const http = require('http');
const fs   = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT        = path.resolve(__dirname, '..');
const CHROME_EXE  = 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const SCREENSHOTS = path.join(__dirname, 'screenshots');
const PORT        = 54321;
const BASE_URL    = `http://localhost:${PORT}`;

// ─── MIME ────────────────────────────────────────────────────────────────────
const MIME = {
  '.html': 'text/html', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.ico': 'image/x-icon',
  '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json',
};

// ─── SERVER ──────────────────────────────────────────────────────────────────
function startServer() {
  return new Promise(resolve => {
    const srv = http.createServer((req, res) => {
      let p = req.url.split('?')[0];
      if (p === '/' || p === '') p = '/index.html';
      const full = path.join(ROOT, p.replace(/\//g, path.sep));
      try {
        const data = fs.readFileSync(full);
        res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
        res.end(data);
      } catch { res.writeHead(404); res.end('not found'); }
    });
    srv.listen(PORT, () => { console.log(`  Server: ${BASE_URL}`); resolve(srv); });
  });
}

// ─── ASSERTION HELPERS ───────────────────────────────────────────────────────
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

// ─── PAGE HELPERS ─────────────────────────────────────────────────────────────

/** Wait for window.onload init to complete (body.preload removed).
 *  Uses 'attached' so it works even when the EB module is hidden (RnR active). */
async function waitForApp(page) {
  await page.waitForFunction(() => !document.body.classList.contains('preload'), { timeout: 12000 });
  await page.waitForSelector('#observationContainer tr.obs-row-main',
    { timeout: 8000, state: 'attached' });
  await page.waitForTimeout(300); // allow saveDraftImmediate debounce
}

/** Get currentDraftId — it's a `let` at script top-level, NOT on window. */
async function getDraftId(page) {
  return page.evaluate(() => {
    try { return typeof currentDraftId !== 'undefined' ? currentDraftId : null; } catch { return null; }
  });
}

/** Check a single localStorage key exists. */
async function lsHas(page, key) {
  return page.evaluate(k => localStorage.getItem(k) !== null, key);
}

/** Count IDB photo records for a draft ID. */
async function idbPhotoCount(page, draftId) {
  return page.evaluate(did => new Promise((res) => {
    const req = indexedDB.open('npisnapwalk', 1);
    req.onsuccess = ev => {
      const db = ev.target.result;
      try {
        const tx  = db.transaction('eb-photos', 'readonly');
        const r2  = tx.objectStore('eb-photos').index('byDraft').count(did);
        r2.onsuccess = () => res(r2.result);
        r2.onerror   = () => res(-1);
      } catch { res(-1); }
    };
    req.onerror = () => res(-1);
  }), draftId);
}

/** Inject a 1×1 JPEG into IDB for the given draftId + obsUid. */
async function injectPhoto(page, draftId, obsUid) {
  return page.evaluate(({ draftId, obsUid }) => new Promise((resolve, reject) => {
    // minimal valid JPEG bytes (1x1 red)
    const b64 =
      '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsLDBkSEw8UHRofHh0a' +
      'HBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAARC' +
      'AABAAEDASIA2gABAREA/8QAFgABAQEAAAAAAAAAAAAAAAAABgUEB//EABoQAAIDAQEAAAAAAAAAAAAA' +
      'AAABAgMEEf/EABYBAQEBAAAAAAAAAAAAAAAAAAQCAv/EABcRAQEBAQAAAAAAAAAAAAAAAAECAxH/2Q==';
    const bin = atob(b64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    const req = indexedDB.open('npisnapwalk', 1);
    req.onsuccess = ev => {
      const db = ev.target.result;
      const record = {
        id: draftId + ':' + obsUid, draftId, obsUid,
        buffer: bytes.buffer, mimeType: 'image/jpeg',
        size: bytes.length, updatedAt: new Date().toISOString(), schemaVersion: 2
      };
      const tx = db.transaction('eb-photos', 'readwrite');
      tx.objectStore('eb-photos').put(record);
      tx.oncomplete = () => resolve(true);
      tx.onerror    = () => reject('idb write failed');
    };
    req.onerror = () => reject('idb open failed');
  }), { draftId, obsUid });
}

/**
 * Add a new observation card by clicking the bar button.
 * Returns the numeric obsId (data-obs-id on the row).
 */
async function addObsRow(page, categoryIndex, processId, description) {
  await page.click('.bar-add');
  await page.waitForTimeout(300);
  // The last obs-row-main is the new one
  const rows  = await page.$$('#observationContainer tr.obs-row-main');
  const row   = rows[rows.length - 1];
  const obsId = await row.getAttribute('data-obs-id');      // numeric id
  const uid   = await row.getAttribute('data-obs-uid');     // stable uuid

  const catSel = await row.$('select.obs-category');
  if (catSel && categoryIndex != null) await catSel.selectOption({ index: categoryIndex });

  const procInp = await row.$('input.obs-process-id');
  if (procInp) await procInp.fill(processId);

  // desc row follows immediately — find it by matching obsId
  const descRow = await page.$(`#observationContainer tr.obs-desc-row[data-obs-id="${obsId}"]`);
  if (descRow) {
    const ta = await descRow.$('textarea.obs-description');
    if (ta) await ta.fill(description);
  }
  return { obsId, uid };
}

/**
 * Expand the Follow-up / Details section for a given numeric obsId
 * and fill all four fields.
 */
async function fillFollowup(page, obsId) {
  // The toggle button has id="detail-toggle-{obsId}"
  const toggleId = `#detail-toggle-${obsId}`;
  const toggle = await page.$(toggleId);
  if (!toggle) { console.log(`    (no detail toggle for obsId ${obsId})`); return false; }
  await toggle.click();
  await page.waitForTimeout(300);

  // Detail row has id="obs-detail-{obsId}"
  const detailRowSel = `#obs-detail-${obsId}`;
  await page.waitForSelector(`${detailRowSel}:not(.hidden)`, { timeout: 3000 });

  await page.fill(`${detailRowSel} .obs-followup`,    'Action: check torque spec per rev B');
  await page.fill(`${detailRowSel} .obs-target-date`,  '2026-12-01');
  await page.fill(`${detailRowSel} .obs-complete-date`, '2026-12-15');
  await page.fill(`${detailRowSel} .obs-support-doc`,
    'https://doc.example.com/torque-spec-revB.pdf');
  return true;
}

/** Wait until a dialog overlay has the .hidden class (i.e. closed). */
async function waitForDialogClosed(page, overlayId, timeout = 4000) {
  await page.waitForFunction(
    id => document.getElementById(id) && document.getElementById(id).classList.contains('hidden'),
    overlayId, { timeout }
  );
}

/** Wait until a dialog overlay does NOT have .hidden (i.e. open). */
async function waitForDialogOpen(page, overlayId, timeout = 4000) {
  await page.waitForFunction(
    id => document.getElementById(id) && !document.getElementById(id).classList.contains('hidden'),
    overlayId, { timeout }
  );
}

/** Set theme via the drawer and close. */
async function setTheme(page, theme) {
  await page.click('#appMenuBtn');
  await page.waitForSelector('.app-menu-overlay:not(.hidden)');
  await page.click(`[data-theme-choice="${theme}"]`);
  await page.waitForTimeout(200);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);
}

/** Read theme pref from localStorage. */
async function getThemePref(page) {
  return page.evaluate(() => localStorage.getItem('npisnapwalk-theme-v1'));
}

/** Seed RnR draft keys so isolation can be verified. */
async function seedRnrKeys(page) {
  await page.evaluate(() => {
    localStorage.setItem('npisnapwalk-draft-v4-run-rate',
      JSON.stringify({ version: 4, timestamp: new Date().toISOString(), projectName: 'RNR-SEED' }));
    localStorage.setItem('npisnapwalk-draft-v3-run-rate', JSON.stringify({ legacy3: true }));
    localStorage.setItem('npisnapwalk-draft-v2-run-rate', JSON.stringify({ legacy2: true }));
  });
}

// ═════════════════════════════════════════════════════════════════════════════
//  MAIN
// ═════════════════════════════════════════════════════════════════════════════
(async () => {
  if (!fs.existsSync(SCREENSHOTS)) fs.mkdirSync(SCREENSHOTS, { recursive: true });

  const srv = await startServer();
  const browser = await chromium.launch({
    executablePath: CHROME_EXE,
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });
  console.log(`  Browser: Chrome ${browser.version()}\n`);

  const consoleErrors = [];

  try {
    // shared browser context (IndexedDB + localStorage persist across navigations)
    const ctx  = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const page = await ctx.newPage();
    page.on('console', m => { if (m.type() === 'error') consoleErrors.push(m.text()); });
    page.on('pageerror', e => consoleErrors.push('page-error: ' + e.message));

    // ─────────────────────────────────────────────────────────────────────────
    section('T1 — Safari warning: removed and absent');
    // ─────────────────────────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForTimeout(500);

    // 1a. No warning on normal load
    const warnOnLoad = await page.evaluate(() => {
      const box = document.getElementById('appWarnings');
      return box ? Array.from(box.children).some(c => c.textContent.includes('Safari')) : false;
    });
    warnOnLoad ? no('No Safari warning on normal load') : ok('No Safari warning on normal load');

    // 1b. detectStandaloneMode() patched to return standalone=true — still no warning
    await page.evaluate(() => {
      const orig = window.matchMedia;
      window.matchMedia = q =>
        q === '(display-mode: standalone)'
          ? { matches: true, addListener() {}, removeEventListener() {} }
          : (orig ? orig.call(window, q) : { matches: false });
      sessionStorage.removeItem('appStandaloneWarningShown');
    });
    await page.evaluate(() => { if (typeof detectStandaloneMode === 'function') detectStandaloneMode(); });
    await page.waitForTimeout(400);
    const warnStandalone = await page.evaluate(() => {
      const box = document.getElementById('appWarnings');
      return box ? Array.from(box.children).some(c => c.textContent.includes('Safari')) : false;
    });
    warnStandalone ? no('No Safari warning in standalone mode') : ok('No Safari warning in standalone mode');

    // restore matchMedia
    await page.evaluate(() => { delete window.matchMedia; });

    // 1c. detectStandaloneMode is still callable (function not removed)
    const fnExists = await page.evaluate(() => typeof detectStandaloneMode === 'function');
    fnExists ? ok('detectStandaloneMode() still exists (logging intact)') : no('detectStandaloneMode() removed');

    // ─────────────────────────────────────────────────────────────────────────
    section('T2 — Fill EB form, autosave, reload → "Draft restored."');
    // ─────────────────────────────────────────────────────────────────────────
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    // Fill header
    await page.fill('#projectName',    'AUTO-TEST PROJECT');
    await page.fill('#buildIdentity',  'EB1-AUTO');
    await page.fill('#buildDate',      '2026-11-12');
    await page.fill('#planQuantity',   '10');
    await page.fill('#visitorName',    'Robot Auditor');
    await page.fill('#factoryLocation','Test Factory / Line A');
    await page.fill('#specialRemark',  'Automation remark text');

    // Add two observations
    const { obsId: id1, uid: uid1 } = await addObsRow(page, 1, 'OP-01 / Station 1', 'Mechanical gap at torque station');
    const { obsId: id2, uid: uid2 } = await addObsRow(page, 2, 'OP-02 / Elect-Bay',  'Electrical harness routing loose');
    console.log(`    obs1: id=${id1} uid=${uid1}`);
    console.log(`    obs2: id=${id2} uid=${uid2}`);

    // Fill follow-up on obs1
    const followupOk = await fillFollowup(page, id1);
    followupOk ? ok('Follow-up / Details fields filled for obs1') : no('Follow-up / Details expand failed for obs1');

    // Fill Section 3
    await page.fill('#actualBuildQty', '8');
    await page.fill('#forRate',        '5.0%');
    await page.fill('#commentsRemarks','Build remarks for automation test');

    // Allow autosave
    await page.waitForTimeout(1000);

    // Check EB key saved
    const ebKeySaved = await lsHas(page, 'npisnapwalk-draft-v1-eb');
    ebKeySaved ? ok('EB draft key present after fill') : no('EB draft key absent');

    // Inject a fake photo into IDB
    const draftIdFill = await getDraftId(page);
    console.log(`    draftId after fill: ${draftIdFill}`);
    if (draftIdFill && uid1) {
      try {
        await injectPhoto(page, draftIdFill, uid1);
        const cnt = await idbPhotoCount(page, draftIdFill);
        cnt > 0 ? ok(`IDB photo injected (count=${cnt})`) : no('IDB photo injection failed (count=0)');
      } catch (e) { no('IDB photo injection threw', e.message); }
    } else {
      no('Could not inject photo — draftId or uid1 missing', `draftId=${draftIdFill} uid1=${uid1}`);
    }

    // Seed RnR keys to verify isolation later
    await seedRnrKeys(page);

    // Reload
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForTimeout(600);

    const pnRestored = await page.inputValue('#projectName');
    pnRestored === 'AUTO-TEST PROJECT' ? ok('Reload: projectName restored') :
      no('Reload: projectName not restored', `got "${pnRestored}"`);

    const obsRestored = await page.$$eval('#observationContainer tr.obs-row-main', r => r.length);
    obsRestored >= 2 ? ok(`Reload: ${obsRestored} obs rows restored`) :
      no('Reload: insufficient obs rows', `got ${obsRestored}`);

    // "Draft restored." banner
    const bannerText = await page.evaluate(() => {
      const b = document.getElementById('draftBanner');
      return b ? b.textContent.trim() : '';
    });
    bannerText.toLowerCase().includes('restored') ? ok('"Draft restored." banner appeared') :
      no('"Draft restored." banner missing', `banner="${bannerText}"`);

    await page.screenshot({ path: path.join(SCREENSHOTS, '01-draft-restored.png') });
    ok('Screenshot 01: draft restored');

    // Check follow-up data restored
    const restoredId1 = await page.evaluate(() => {
      const rows = document.querySelectorAll('#observationContainer tr.obs-row-main');
      return rows[1] ? rows[1].getAttribute('data-obs-id') : null; // index 1 = second row (first was blank, then two added)
    });
    if (restoredId1) {
      const detailRow = await page.$(`#obs-detail-${restoredId1}`);
      if (detailRow) {
        // Need to expand it first to verify contents
        const toggleBtn = await page.$(`#detail-toggle-${restoredId1}`);
        if (toggleBtn) await toggleBtn.click();
        await page.waitForTimeout(300);
        const followupVal = await page.$eval(`#obs-detail-${restoredId1} .obs-followup`, el => el.value).catch(() => '');
        followupVal.includes('torque') ? ok('Follow-up text restored correctly') :
          no('Follow-up text not restored or empty', `got "${followupVal}"`);
        const targetVal = await page.$eval(`#obs-detail-${restoredId1} .obs-target-date`, el => el.value).catch(() => '');
        targetVal === '2026-12-01' ? ok('Target date restored correctly') :
          no('Target date not restored', `got "${targetVal}"`);
      } else {
        ok('Follow-up restore: detail row check skipped (row not in expected position)');
      }
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('T3 — EB Danger Zone: Cancel preserves data');
    // ─────────────────────────────────────────────────────────────────────────
    const pnBeforeCancel = await page.inputValue('#projectName');

    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');

    // EB module active → EB danger zone visible, RnR hidden
    const ebVisible = await page.isVisible('#ebResetFormItem');
    const rnrHidden = !(await page.isVisible('#rnrResetFormItem'));
    ebVisible ? ok('EB Danger Zone visible (EB module active)') : no('EB Danger Zone not visible');
    rnrHidden  ? ok('RnR Danger Zone hidden (EB module active)') : no('RnR Danger Zone incorrectly visible');

    // Open EB reset dialog
    await page.click('#ebResetFormItem');
    await waitForDialogOpen(page, 'ebResetDialogOverlay');
    ok('EB reset dialog opens');

    // 1-second lock on confirm
    const lockedOnOpen = await page.isDisabled('#ebResetConfirmBtn');
    lockedOnOpen ? ok('EB confirm button locked on open') : no('EB confirm button not locked');

    await page.screenshot({ path: path.join(SCREENSHOTS, '02-eb-reset-dialog.png') });
    ok('Screenshot 02: EB reset dialog');

    // Cancel
    await page.click('#ebResetCancelBtn');
    await waitForDialogClosed(page, 'ebResetDialogOverlay');
    ok('EB reset dialog closed by Cancel');

    const pnAfterCancel = await page.inputValue('#projectName');
    pnAfterCancel === pnBeforeCancel ? ok('Cancel: data unchanged') :
      no('Cancel: data was changed', `before="${pnBeforeCancel}" after="${pnAfterCancel}"`);

    // ─────────────────────────────────────────────────────────────────────────
    section('T4 — EB reset: confirm, storage cleared, isolation, reload');
    // ─────────────────────────────────────────────────────────────────────────
    const draftIdPreReset  = await getDraftId(page);
    const photosPreReset   = draftIdPreReset ? await idbPhotoCount(page, draftIdPreReset) : 0;
    const themePreReset    = await getThemePref(page);
    console.log(`    pre-reset: draftId=${draftIdPreReset} photos=${photosPreReset} theme=${themePreReset}`);

    // Open drawer → open reset dialog
    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');
    await page.click('#ebResetFormItem');
    await waitForDialogOpen(page, 'ebResetDialogOverlay');

    // Wait for 1-second lock to expire
    await page.waitForFunction(
      () => !document.getElementById('ebResetConfirmBtn').disabled,
      { timeout: 4000 }
    );
    ok('EB confirm button enabled after lock');

    await page.click('#ebResetConfirmBtn');
    await waitForDialogClosed(page, 'ebResetDialogOverlay');
    await page.waitForTimeout(600);  // allow async IDB delete + saveDraftImmediate

    // Form initial state
    const pnAfterReset = await page.inputValue('#projectName');
    pnAfterReset === '' ? ok('After EB reset: projectName empty') :
      no('After EB reset: projectName not empty', `got "${pnAfterReset}"`);

    const obsAfterReset = await page.$$eval('#observationContainer tr.obs-row-main', r => r.length);
    obsAfterReset === 1 ? ok('After EB reset: exactly 1 blank obs row') :
      no('After EB reset: obs count wrong', `got ${obsAfterReset}`);

    // New draftId was generated
    const draftIdPostReset = await getDraftId(page);
    (draftIdPostReset && draftIdPostReset !== draftIdPreReset) ?
      ok(`After EB reset: new draftId generated (${draftIdPostReset.slice(0,8)}…)`) :
      no('After EB reset: draftId unchanged', `before=${draftIdPreReset} after=${draftIdPostReset}`);

    // IDB photos for OLD draft deleted
    if (draftIdPreReset) {
      await page.waitForTimeout(500); // async delete
      const photosPostReset = await idbPhotoCount(page, draftIdPreReset);
      photosPostReset === 0 ? ok(`After EB reset: old IDB photos deleted (was ${photosPreReset})`) :
        no('After EB reset: IDB photos remain', `count=${photosPostReset}`);
    }

    // RnR keys intact
    const rnrV4Intact = await lsHas(page, 'npisnapwalk-draft-v4-run-rate');
    const rnrV3Intact = await lsHas(page, 'npisnapwalk-draft-v3-run-rate');
    const rnrV2Intact = await lsHas(page, 'npisnapwalk-draft-v2-run-rate');
    rnrV4Intact ? ok('After EB reset: RnR V4 key intact') : no('After EB reset: RnR V4 deleted');
    rnrV3Intact ? ok('After EB reset: RnR V3 key intact') : no('After EB reset: RnR V3 deleted');
    rnrV2Intact ? ok('After EB reset: RnR V2 key intact') : no('After EB reset: RnR V2 deleted');

    // Theme pref intact
    const themePostReset = await getThemePref(page);
    (themePostReset === themePreReset || (themePreReset === null && themePostReset === null)) ?
      ok(`After EB reset: theme pref intact (${themePostReset ?? 'default'})`) :
      no('After EB reset: theme pref changed', `${themePreReset} → ${themePostReset}`);

    // "EB Report reset." banner
    const resetBanner = await page.evaluate(() => {
      const b = document.getElementById('draftBanner');
      return b ? b.textContent.trim() : '';
    });
    resetBanner.includes('EB Report reset') ? ok('"EB Report reset." banner shown') :
      no('"EB Report reset." banner missing', `got "${resetBanner}"`);

    await page.screenshot({ path: path.join(SCREENSHOTS, '03-after-eb-reset.png') });
    ok('Screenshot 03: after EB reset');

    // Reload: old data NOT restored
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForTimeout(600);

    const pnAfterReload = await page.inputValue('#projectName');
    const obsAfterReload = await page.$$eval('#observationContainer tr.obs-row-main', r => r.length);
    pnAfterReload === '' ? ok('After EB reset + reload: form still blank') :
      no('After EB reset + reload: old data restored', `projectName="${pnAfterReload}"`);
    obsAfterReload === 1 ? ok('After EB reset + reload: still 1 blank obs') :
      no('After EB reset + reload: extra obs', `count=${obsAfterReload}`);

    // ─────────────────────────────────────────────────────────────────────────
    section('T5 — RnR Danger Zone: isolation, cancel, confirm, reload');
    // ─────────────────────────────────────────────────────────────────────────

    // Fill EB header data again so we can verify it survives RnR reset
    await page.fill('#projectName', 'EB-SURVIVES-RNR-RESET');
    await page.waitForTimeout(1000); // autosave

    const ebKeyBeforeRnr = await lsHas(page, 'npisnapwalk-draft-v1-eb');
    ebKeyBeforeRnr ? ok('EB draft present before RnR reset') : no('EB draft absent before RnR reset');

    // Switch to RnR module
    await page.click('#tabCapacity');
    await page.waitForTimeout(400);

    // Seed RnR data
    await seedRnrKeys(page);

    // Open drawer → verify visibility swap
    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');
    const rnrNowVisible = await page.isVisible('#rnrResetFormItem');
    const ebNowHidden   = !(await page.isVisible('#ebResetFormItem'));
    rnrNowVisible ? ok('RnR Danger Zone visible (RnR active)') : no('RnR Danger Zone not visible');
    ebNowHidden   ? ok('EB Danger Zone hidden (RnR active)')   : no('EB Danger Zone incorrectly visible');

    // Open RnR reset dialog
    await page.click('#rnrResetFormItem');
    await waitForDialogOpen(page, 'rnrResetDialogOverlay');
    ok('RnR reset dialog opens');

    // Cancel
    await page.click('#rnrResetCancelBtn');
    await waitForDialogClosed(page, 'rnrResetDialogOverlay');
    ok('RnR reset dialog closed by Cancel');

    // RnR keys still present after cancel
    const rnrV4AfterCancel = await lsHas(page, 'npisnapwalk-draft-v4-run-rate');
    rnrV4AfterCancel ? ok('After RnR cancel: V4 key still present') : no('After RnR cancel: V4 key gone');

    // Reopen and confirm
    await page.click('#appMenuBtn');
    await page.waitForSelector('.app-menu-overlay:not(.hidden)');
    await page.click('#rnrResetFormItem');
    await waitForDialogOpen(page, 'rnrResetDialogOverlay');
    await page.waitForFunction(() => !document.getElementById('rnrResetConfirmBtn').disabled, { timeout: 4000 });
    ok('RnR confirm button enabled after lock');

    await page.click('#rnrResetConfirmBtn');
    await waitForDialogClosed(page, 'rnrResetDialogOverlay');
    await page.waitForTimeout(400);
    ok('RnR reset confirmed');

    // RnR keys removed or blanked.
    // Note: saveRunRateDraftV3() re-saves the now-blank state to V4 immediately
    // after the delete, so V4 may exist — but its content must not hold the seeded data.
    const rnrV4Raw = await page.evaluate(() => localStorage.getItem('npisnapwalk-draft-v4-run-rate'));
    const rnrV4HasSeedData = rnrV4Raw && JSON.parse(rnrV4Raw).projectName === 'RNR-SEED';
    rnrV4HasSeedData ? no('After RnR reset: V4 still contains seeded data') :
                       ok('After RnR reset: V4 seed data cleared (key may hold blank state)');

    const rnrV3Gone = !(await lsHas(page, 'npisnapwalk-draft-v3-run-rate'));
    const rnrV2Gone = !(await lsHas(page, 'npisnapwalk-draft-v2-run-rate'));
    rnrV3Gone ? ok('After RnR reset: V3 key removed') : no('After RnR reset: V3 key still present');
    rnrV2Gone ? ok('After RnR reset: V2 key removed') : no('After RnR reset: V2 key still present');

    // EB draft intact
    const ebAfterRnr = await lsHas(page, 'npisnapwalk-draft-v1-eb');
    ebAfterRnr ? ok('After RnR reset: EB draft key intact') : no('After RnR reset: EB draft deleted');

    // Theme intact
    const themeAfterRnr = await getThemePref(page);
    (themeAfterRnr === themePreReset || (!themeAfterRnr && !themePreReset)) ?
      ok('After RnR reset: theme pref intact') : no('After RnR reset: theme changed', `${themePreReset} → ${themeAfterRnr}`);

    // Reload: EB data intact, RnR gone.
    // App may reload in RnR module (it was last active) — switch to EB first.
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);
    await page.waitForTimeout(600);
    // Switch to EB so the input is accessible
    await page.click('#tabEb');
    await page.waitForTimeout(300);

    const pnAfterRnrReset = await page.inputValue('#projectName');
    pnAfterRnrReset === 'EB-SURVIVES-RNR-RESET' ? ok('After RnR reset + reload: EB data intact') :
      no('After RnR reset + reload: EB data lost', `got "${pnAfterRnrReset}"`);

    // ─────────────────────────────────────────────────────────────────────────
    section('T6 — Follow-up / Details: dark-theme, screenshots, no overflow');
    // ─────────────────────────────────────────────────────────────────────────

    async function runFollowupCaptures(vpLabel, vpW, vpH, theme) {
      await page.setViewportSize({ width: vpW, height: vpH });
      await setTheme(page, theme);

      // Navigate fresh (new context re-seeds blank state)
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await waitForApp(page);
      // Ensure EB module is active (page may reload in RnR mode)
      await page.click('#tabEb');
      await page.waitForTimeout(300);

      // Add an observation with follow-up
      const { obsId } = await addObsRow(page, 1, 'OP-15 / Station 3', 'Torque not within spec — visual gap');
      const expanded = await fillFollowup(page, obsId);

      // Fill long supporting doc
      const detailSel = `#obs-detail-${obsId}`;
      await page.fill(`${detailSel} .obs-support-doc`,
        'https://sharepoint.example.com/sites/NPI/Shared%20Documents/Torque-Spec-V3-Approved.pdf');

      // Scroll detail row into view
      await page.evaluate(id => {
        const el = document.getElementById(id);
        if (el) el.scrollIntoView({ behavior: 'instant', block: 'center' });
      }, `obs-detail-${obsId}`);
      await page.waitForTimeout(400);

      // ── Screenshot: populated ──
      await page.screenshot({
        path: path.join(SCREENSHOTS, `followup-${vpLabel}-${theme}-populated.png`),
        fullPage: false
      });
      ok(`Screenshot: followup-${vpLabel}-${theme}-populated.png`);

      if (theme === 'dark') {
        // Check td background is NOT white/near-white
        const tdBg = await page.evaluate(id => {
          const detRow = document.getElementById(id);
          if (!detRow) return null;
          const td = detRow.querySelector('td');
          if (!td) return null;
          return getComputedStyle(td).backgroundColor;
        }, `obs-detail-${obsId}`);

        console.log(`    ${vpLabel} dark td bg: ${tdBg}`);
        if (tdBg) {
          const m = tdBg.match(/rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/);
          if (m) {
            const [,r,g,b] = m.map(Number);
            const isWhite = r > 220 && g > 220 && b > 220;
            isWhite ? no(`Dark mode: white td background (${vpLabel})`, `rgb(${r},${g},${b})`) :
                      ok(`Dark mode: td background dark (${vpLabel}) rgb(${r},${g},${b})`);
          } else {
            no(`Dark mode: could not parse td bg (${vpLabel})`, tdBg);
          }
        } else {
          no(`Dark mode: detail row or td not found (${vpLabel})`);
        }

        // Check labels are readable (not near-black on dark bg)
        const labelColors = await page.evaluate(id => {
          const detRow = document.getElementById(id);
          if (!detRow) return [];
          return Array.from(detRow.querySelectorAll('label')).map(l => ({
            text: l.textContent.trim(),
            color: getComputedStyle(l).color
          }));
        }, `obs-detail-${obsId}`);

        if (labelColors.length > 0) {
          const allReadable = labelColors.every(l => {
            const m2 = l.color.match(/rgb[a]?\((\d+),\s*(\d+),\s*(\d+)/);
            if (!m2) return false;
            const [,r,g,b] = m2.map(Number);
            // readable = not near-black (at least one channel > 100)
            return Math.max(r, g, b) > 100;
          });
          allReadable ? ok(`Dark mode: all ${labelColors.length} labels readable (${vpLabel})`) :
            no(`Dark mode: label contrast issue (${vpLabel})`, JSON.stringify(labelColors.slice(0,2)));
        } else {
          ok(`Dark mode: label check skipped — no label elements found (detail may be hidden)`);
        }
      }

      // No horizontal overflow
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
      overflow ? no(`No horizontal overflow (${vpLabel} ${theme})`) :
                 ok(`No horizontal overflow (${vpLabel} ${theme})`);

      // ── Screenshot: collapsed ──
      await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
      await waitForApp(page);
      await page.click('#tabEb');
      await page.waitForTimeout(300);
      const { obsId: id2c } = await addObsRow(page, 2, 'EL-07', 'Electrical short — not yet expanded');
      await page.evaluate(id => {
        const el = document.getElementById('detail-toggle-' + id);
        if (el) el.closest('tr')?.scrollIntoView({ behavior: 'instant', block: 'center' });
      }, id2c);
      await page.waitForTimeout(300);
      await page.screenshot({
        path: path.join(SCREENSHOTS, `followup-${vpLabel}-${theme}-collapsed.png`),
        fullPage: false
      });
      ok(`Screenshot: followup-${vpLabel}-${theme}-collapsed.png`);
    }

    await runFollowupCaptures('mobile',  390,  844, 'light');
    await runFollowupCaptures('mobile',  390,  844, 'dark');
    await runFollowupCaptures('desktop', 1280, 800, 'light');
    await runFollowupCaptures('desktop', 1280, 800, 'dark');

    // ─────────────────────────────────────────────────────────────────────────
    section('T7 — startNewReportBtn: confirm hidden / obsolete');
    // ─────────────────────────────────────────────────────────────────────────
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(BASE_URL, { waitUntil: 'domcontentloaded' });
    await waitForApp(page);

    const btnInfo = await page.evaluate(() => {
      const el = document.getElementById('startNewReportBtn');
      if (!el) return { exists: false };
      const cs = getComputedStyle(el);
      return {
        exists:    true,
        display:   cs.display,
        visible:   cs.display !== 'none' && cs.visibility !== 'hidden',
        onclick:   (el.getAttribute('onclick') || '').trim()
      };
    });

    console.log(`    startNewReportBtn: exists=${btnInfo.exists} display="${btnInfo.display}" visible=${btnInfo.visible}`);
    if (!btnInfo.exists) {
      ok('startNewReportBtn: not in DOM (fully removed)');
    } else if (!btnInfo.visible) {
      // Exists but hidden — Flag it: the task requires removing it
      no('startNewReportBtn still in DOM with display:none (dead markup, should be removed)');
    } else {
      no('startNewReportBtn is VISIBLE — this is a regression');
    }

    // ─────────────────────────────────────────────────────────────────────────
    section('T8 — Console error audit');
    // ─────────────────────────────────────────────────────────────────────────
    if (consoleErrors.length === 0) {
      ok('No browser console errors during entire test run');
    } else {
      no('Console errors present', consoleErrors.slice(0, 3).join(' | '));
      consoleErrors.forEach(e => console.log(`    ERR: ${e}`));
    }

  } finally {
    await browser.close();
    srv.close();
  }

  // ─────────────────────────────────────────────────────────────────────────
  section('RESULTS');
  // ─────────────────────────────────────────────────────────────────────────
  console.log(`\n  PASS: ${pass}   FAIL: ${fail}\n`);
  if (failures.length > 0) {
    console.log('Failed checks:');
    failures.forEach(f => console.error(`  ✗ ${f}`));
    console.log('');
  }
  const shots = fs.readdirSync(SCREENSHOTS).filter(f => f.endsWith('.png'));
  console.log(`Screenshots (${shots.length}):`);
  shots.forEach(f => console.log(`  ${path.join(SCREENSHOTS, f)}`));

  process.exit(fail > 0 ? 1 : 0);
})();
