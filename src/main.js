        /* ============================================================
           APPLICATION STATE
           ============================================================ */
        let appState = {
            schemaVersion: 1,
            currentModule: MODULES.EB_REPORT,
            settings: {
                lastModule: MODULES.EB_REPORT
            }
        };

        /* ============================================================
           STATE
           ============================================================ */
        let obsCounter = 0;
        const photoStore = Object.create(null);
        const photoMetaStore = Object.create(null);
        const photoProcessing = Object.create(null);
        let photoCaptureCount = 0;
        let draftDebounceTimer = null;
        let draftBannerTimer = null;
        let isRestoring = false;
        let currentObsId = null;
        let pendingBarRow = null;
        let currentDraftId = null;
        let photoPersistWarnShown = false;
        let privateBrowsingWarningShown = false;

        const APP_ERROR_LOG_LIMIT = 20;
        const APP_EVENT_LOG_LIMIT = 100;
        const appErrorLog = [];
        const appEventLog = [];

        function appNowISO() {
            try { return new Date().toISOString(); } catch (e) { return ''; }
        }

        function logAppEvent(name, detail) {
            try {
                appEventLog.push({ at: appNowISO(), name: name, detail: detail === undefined ? '' : String(detail) });
                if (appEventLog.length > APP_EVENT_LOG_LIMIT) appEventLog.shift();
                console.info('[NPI SnapWalk]', name, detail === undefined ? '' : detail);
            } catch (e) {}
        }

        function logAppError(source, message, detail) {
            try {
                appErrorLog.push({ at: appNowISO(), source: source, message: String(message || ''), detail: detail === undefined ? '' : String(detail) });
                if (appErrorLog.length > APP_ERROR_LOG_LIMIT) appErrorLog.shift();
                console.warn('[NPI SnapWalk] error', source, message, detail === undefined ? '' : detail);
            } catch (e) {}
        }

        window.addEventListener('error', function(ev) {
            logAppError('window.onerror', ev.message, (ev.filename || '') + ':' + (ev.lineno || ''));
        });
        window.addEventListener('unhandledrejection', function(ev) {
            var reason = ev.reason;
            logAppError('unhandledrejection', reason && reason.message ? reason.message : reason);
        });

        /* ============================================================
           HELPERS
           ============================================================ */
        function fieldValue(id) {
            var el = document.getElementById(id);
            return el ? el.value : '';
        }

        function getVal(el, sel) {
            var found = el ? el.querySelector(sel) : null;
            return found ? found.value : '';
        }

        function cameraSvg() {
            return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>';
        }

        function generateUuid() {
            if (window.crypto && typeof window.crypto.randomUUID === 'function') {
                return window.crypto.randomUUID();
            }
            var t = Date.now().toString(36);
            var r = Math.random().toString(36).slice(2, 10);
            return 'eb-' + t + '-' + r;
        }

        /* Validate draftId / obsUid tokens before they are used as
           object keys or composite IndexedDB keys. This keeps a crafted
           or corrupted draft/store from polluting plain-object maps
           (e.g. "__proto__") or from collapsing distinct identities onto
           one key via a ":" delimiter. */
        function isSafeIdToken(v) {
            return typeof v === 'string' && v.length > 0 && v.length <= 64 &&
                v.indexOf(':') === -1 && v.indexOf('__') === -1 &&
                v !== 'constructor' && v !== 'prototype';
        }

        function ensureDraftId() {
            if (!currentDraftId || !isSafeIdToken(currentDraftId)) currentDraftId = generateUuid();
            return currentDraftId;
        }

        function readObservationData(row) {
            var obsId = parseInt(row.dataset.obsId);
            var descRow = row.nextElementSibling;
            var detailRow = document.getElementById('obs-detail-' + obsId);

            var category = getVal(row, '.obs-category');
            /* "Same as Above" rows inherit the administrative fields
               (Process ID, Follow-Up / Result, Target Date, Complete Date,
               Supporting Document), which are stored empty in the draft so
               the parent observation stays the single source of truth. The
               Observation Description defaults to the literal "Same as
               Above" marker and stays editable; it is stored as-is so a
               custom edit survives. Excel export writes the visible values
               (see readVisibleObservationData), not resolved parent values. */
            var inherited = isSameAsAboveCategory(category);

            var data = {
                obsId: obsId,
                obsUid: row.dataset.obsUid || '',
                category: category,
                issueDate: getVal(row, '.obs-issue-date'),
                status: normalizeObsStatus(getVal(row, '.obs-status')),
                owner: descRow && descRow.classList.contains('obs-desc-row') ? getVal(descRow, '.obs-owner') : '',
                processId: inherited ? '' : getVal(row, '.obs-process-id'),
                description: descRow && descRow.classList.contains('obs-desc-row') ? getVal(descRow, '.obs-description') : '',
                followUp: inherited ? '' : (detailRow ? getVal(detailRow, '.obs-followup') : ''),
                targetDate: inherited ? '' : (detailRow ? getVal(detailRow, '.obs-target-date') : ''),
                completeDate: inherited ? '' : (detailRow ? getVal(detailRow, '.obs-complete-date') : ''),
                supportDoc: inherited ? '' : (detailRow ? getVal(detailRow, '.obs-support-doc') : '')
            };
            if (inherited) data.inheritFrom = row.dataset.inheritFrom || '';
            var uid2 = data.obsUid;
            if (uid2 && photoMetaStore[uid2]) {
                data.photoMeta = photoMetaStore[uid2];
            }

            return data;
        }

        /* ============================================================
           SAME AS ABOVE — lightweight observation inheritance
           One observation = one row, one photo per row. A "Same as Above"
           row keeps its own photo, issue date and status. The administrative
           fields (Process ID, Follow-Up, Target Date, Complete Date,
           Supporting Document) resolve from the nearest row above whose
           category is NOT "Same as Above". The Observation Description is
           an editable field defaulting to the literal "Same as Above"
           marker: while the marker is kept it resolves to the parent
           description during export, and a custom edit is exported as-is.
           The inheritance relationship is order-based so it survives
           refresh, browser close and draft restore.
           ============================================================ */

        function getDescRow(row) {
            var next = row.nextElementSibling;
            return next && next.classList.contains('obs-desc-row') ? next : null;
        }

        function findMainRowForElement(el) {
            var node = el;
            while (node && node !== document.body) {
                if (node.classList && node.classList.contains('obs-row-main')) return node;
                node = node.parentNode;
            }
            return null;
        }

        /* Walk upward until the nearest observation whose category is NOT
           "Same as Above". Empty categories are skipped (an incomplete row
           cannot act as a source). Returns null when no parent exists. */
        function findParentObservationRow(row) {
            var rows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            var idx = -1;
            for (var i = 0; i < rows.length; i++) {
                if (rows[i] === row) { idx = i; break; }
            }
            if (idx <= 0) return null;
            for (var j = idx - 1; j >= 0; j--) {
                var catEl = rows[j].querySelector('.obs-category');
                if (catEl && catEl.value && !isSameAsAboveCategory(catEl.value)) return rows[j];
            }
            return null;
        }

        /* textMode=true puts the literal "Same as Above" marker in the field
           (text inputs / textareas). textMode=false uses a grey placeholder
           instead, because date inputs cannot hold arbitrary text. The
           Observation Description is NOT handled here: it defaults to the
           editable "Same as Above" marker (see enterSameAsAbove). */
        function setInheritedField(el, textMode) {
            if (!el) return;
            if (textMode) {
                el.value = SAME_AS_ABOVE_CATEGORY;
                el.placeholder = '';
            } else {
                el.value = '';
                el.placeholder = SAME_AS_ABOVE_CATEGORY;
            }
            el.disabled = true;
        }

        function enterSameAsAbove(row, parentRow) {
            row.dataset.inheritFrom = parentRow ? (parentRow.dataset.obsUid || '') : '';
            var obsId = row.dataset.obsId;
            var detailRow = document.getElementById('obs-detail-' + obsId);
            var descRow = getDescRow(row);
            setInheritedField(row.querySelector('.obs-process-id'), true);
            /* Observation Description: keep the field editable with the
               literal "Same as Above" marker as its default text. The parent
               description is NOT copied into the field — while the marker is
               kept it is resolved to the parent description during export,
               and a custom edit is exported as-is. The marker is only written
               when the field is empty, so a restored draft or an existing
               edit is never overwritten. */
            var ta = descRow ? descRow.querySelector('.obs-description') : null;
            if (ta) {
                ta.disabled = false;
                ta.placeholder = '';
                if (!ta.value) {
                    ta.value = SAME_AS_ABOVE_CATEGORY;
                    autoGrow(ta);
                }
            }
            setInheritedField(detailRow ? detailRow.querySelector('.obs-followup') : null, true);
            setInheritedField(detailRow ? detailRow.querySelector('.obs-target-date') : null, false);
            setInheritedField(detailRow ? detailRow.querySelector('.obs-complete-date') : null, false);
            setInheritedField(detailRow ? detailRow.querySelector('.obs-support-doc') : null, true);
        }

        function exitSameAsAbove(row) {
            delete row.dataset.inheritFrom;
            var obsId = row.dataset.obsId;
            var detailRow = document.getElementById('obs-detail-' + obsId);
            var descRow = getDescRow(row);
            var fields = [];
            var pi = row.querySelector('.obs-process-id');
            if (pi) fields.push(pi);
            if (descRow) {
                var ta = descRow.querySelector('.obs-description');
                if (ta) fields.push(ta);
            }
            if (detailRow) {
                var names = ['.obs-followup', '.obs-target-date', '.obs-complete-date', '.obs-support-doc'];
                for (var i = 0; i < names.length; i++) {
                    var el = detailRow.querySelector(names[i]);
                    if (el) fields.push(el);
                }
            }
            /* Only inherited fields are ever disabled by this engine; touch
               nothing else so a normal row's entered values are never wiped
               during a re-scan. The Observation Description is never disabled
               (it is editable), but if it still holds the literal "Same as
               Above" marker the marker is cleared so a normal row can never
               carry the marker text as its real description. */
            fields.forEach(function(el) {
                if (!el.disabled) return;
                el.disabled = false;
                el.placeholder = '';
                el.value = '';
            });
            if (descRow) {
                var ta = descRow.querySelector('.obs-description');
                if (ta && ta.value === SAME_AS_ABOVE_CATEGORY) {
                    ta.value = '';
                    autoGrow(ta);
                }
            }
        }

        /* Apply the inheritance state for one row based on its current
           category selection. On a user action with no valid parent, the
           selection is reverted with an alert instead of being kept. */
        function applySameAsAboveState(row, opts) {
            opts = opts || {};
            var catEl = row.querySelector('.obs-category');
            if (!catEl) return;
            if (isSameAsAboveCategory(catEl.value)) {
                var parentRow = findParentObservationRow(row);
                if (!parentRow) {
                    if (opts.userAction) {
                        var prev = catEl.dataset.prevCat || '';
                        catEl.value = prev;
                        alert('"Same as Above" requires a completed observation directly above it.');
                    } else {
                        catEl.value = '';
                    }
                    exitSameAsAbove(row);
                    return;
                }
                enterSameAsAbove(row, parentRow);
            } else {
                exitSameAsAbove(row);
            }
        }

        /* Re-scan every row and re-apply inheritance. Rows in "Same as Above"
           mode that lose their source observation (e.g. after a delete) exit
           the mode so no broken reference survives. Returns true when any row
           was changed to exit inheritance. */
        function reapplySameAsAbove() {
            var rows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            var changed = false;
            rows.forEach(function(row) {
                var catEl = row.querySelector('.obs-category');
                if (!catEl) return;
                if (isSameAsAboveCategory(catEl.value)) {
                    var parentRow = findParentObservationRow(row);
                    if (!parentRow) {
                        catEl.value = '';
                        exitSameAsAbove(row);
                        changed = true;
                    } else {
                        enterSameAsAbove(row, parentRow);
                    }
                } else {
                    exitSameAsAbove(row);
                }
            });
            return changed;
        }

        /* Resolve a row's effective observation data. For "Same as Above"
           rows the administrative fields (category, process ID, follow-up,
           target date, complete date, supporting document) are inherited from
           the nearest non-"Same as Above" ancestor. The Observation
           Description resolves to the source description only while the field
           still holds the literal "Same as Above" marker; a custom edit is
           exported as-is. Photo, issue date, status and identities stay the
           child's own. */
        function resolveObservationData(row) {
            var data = readObservationData(row);
            if (!isSameAsAboveCategory(data.category)) return data;
            var parentRow = findParentObservationRow(row);
            if (!parentRow) return data;
            var pdata = resolveObservationData(parentRow);
            data.category = pdata.category;
            data.processId = pdata.processId;
            if (data.description === SAME_AS_ABOVE_CATEGORY) {
                data.description = pdata.description;
            }
            data.followUp = pdata.followUp;
            data.targetDate = pdata.targetDate;
            data.completeDate = pdata.completeDate;
            data.supportDoc = pdata.supportDoc;
            data.parentObsId = pdata.obsId;
            data.parentObsUid = pdata.obsUid;
            return data;
        }

        /* Read a row's fields exactly as the user sees them on screen. For a
           "Same as Above" row the inherited fields contain the literal
           "Same as Above" marker (text inputs carry it as their value, date
           inputs as their placeholder), so this is what the Excel export
           must write — never the resolved parent values. */
        function visibleFieldValue(el) {
            if (!el) return '';
            var v = el.value || '';
            if (!v && el.placeholder === SAME_AS_ABOVE_CATEGORY) return SAME_AS_ABOVE_CATEGORY;
            return v;
        }

        function readVisibleObservationData(row) {
            var obsId = parseInt(row.dataset.obsId, 10);
            var detailRow = document.getElementById('obs-detail-' + obsId);
            var descRow = getDescRow(row);
            return {
                obsId: obsId,
                obsUid: row.dataset.obsUid || '',
                category: getVal(row, '.obs-category'),
                issueDate: getVal(row, '.obs-issue-date'),
                status: normalizeObsStatus(getVal(row, '.obs-status')),
                owner: descRow && descRow.classList.contains('obs-desc-row') ? getVal(descRow, '.obs-owner') : '',
                processId: visibleFieldValue(row.querySelector('.obs-process-id')),
                description: descRow && descRow.classList.contains('obs-desc-row') ? getVal(descRow, '.obs-description') : '',
                followUp: visibleFieldValue(detailRow ? detailRow.querySelector('.obs-followup') : null),
                targetDate: visibleFieldValue(detailRow ? detailRow.querySelector('.obs-target-date') : null),
                completeDate: visibleFieldValue(detailRow ? detailRow.querySelector('.obs-complete-date') : null),
                supportDoc: visibleFieldValue(detailRow ? detailRow.querySelector('.obs-support-doc') : null)
            };
        }

        /* ============================================================
           DRAFT PERSISTENCE — LocalStorage
           ============================================================ */
        function collectDraft() {
            var d = {};
            d.version = 2;
            d.draftId = currentDraftId || null;
            d.timestamp = new Date().toISOString();

            d.section1 = {
                projectName: fieldValue('projectName'),
                buildIdentity: fieldValue('buildIdentity'),
                buildDate: fieldValue('buildDate'),
                planQuantity: fieldValue('planQuantity'),
                visitorName: fieldValue('visitorName'),
                factoryLocation: fieldValue('factoryLocation'),
                specialRemark: fieldValue('specialRemark')
            };

            d.section3 = {
                actualBuildQty: fieldValue('actualBuildQty'),
                forRate: fieldValue('forRate'),
                bottleneckCycleTime: fieldValue('bottleneckCycleTime'),
                commentsRemarks: fieldValue('commentsRemarks')
            };

            d.section2 = { counter: obsCounter, observations: [] };
            var mainRows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            mainRows.forEach(function(row) {
                d.section2.observations.push(readObservationData(row));
            });

            return d;
        }

        function saveDraftSync() {
            if (isRestoring) return false;
            ensureDraftId();
            try {
                var draft = collectDraft();
                localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
                updateDraftStatus('saved', new Date());
                logAppEvent('draft-saved', 'draftId=' + currentDraftId);
                return true;
            } catch (e) {
                logAppError('draft-save', e && e.message);
                return false;
            }
        }

        function saveDraft() {
            saveDraftSync();
        }

        function saveDraftDebounced() {
            if (isRestoring) return;
            clearTimeout(draftDebounceTimer);
            draftDebounceTimer = setTimeout(saveDraft, DRAFT_DEBOUNCE_MS);
        }

        function saveDraftImmediate() {
            clearTimeout(draftDebounceTimer);
            draftDebounceTimer = setTimeout(saveDraft, 1);
        }

        /* Persist the current draft without touching the status indicator.
           Used during photo restore to clean stale photo metadata without
           overwriting the "Draft restored" status with "Saved HH:MM". */
        function saveDraftSilent() {
            if (isRestoring) return;
            ensureDraftId();
            try {
                localStorage.setItem(DRAFT_KEY, JSON.stringify(collectDraft()));
            } catch (e) {
                console.warn('Draft save failed:', e.message);
            }
        }

        function clearDraft() {
            localStorage.removeItem(DRAFT_KEY);
            updateDraftStatus('cleared');
        }

        function discardDraft() {
            if (!confirm('Delete the saved draft? All text data saved in browser storage will be permanently removed.')) return;
            /* Cancel any pending autosave so a scheduled save cannot
               silently resurrect the draft right after it is deleted. */
            clearTimeout(draftDebounceTimer);
            if (currentDraftId) {
                deleteEbPhotosForDraft(currentDraftId).then(function() {
                    console.info('[NPI SnapWalk] IndexedDB photos removed for draft', currentDraftId);
                }).catch(function(err) {
                    console.warn('[NPI SnapWalk] IndexedDB photo cleanup failed:', err && err.message);
                });
                currentDraftId = null;
            }
            clearDraft();
            resetSessionPhotos();
            showDraftBanner('Draft deleted.', false);
            closeAbout();
        }

        /* ============================================================
           START NEW REPORT — wipe the current EB report (saved draft,
           photos, IndexedDB records, observations) and begin a fresh
           report with a new report identity and one blank observation.
           ============================================================ */
        function startNewReport() {
            if (!confirm(
                'Start a new report?\n\n' +
                'This will:\n\n' +
                '\u2022 Delete all observations\n' +
                '\u2022 Delete all photos\n' +
                '\u2022 Delete saved draft\n' +
                '\u2022 Delete IndexedDB photos for this report\n' +
                '\u2022 Generate a new report ID\n\n' +
                'This action cannot be undone.\n\n' +
                'Continue?'
            )) return;

            /* 1. Cancel any pending autosave so it cannot silently
               resurrect the old draft after it is removed. */
            clearTimeout(draftDebounceTimer);

            /* 2. Remove IndexedDB photo records for the current report. */
            if (currentDraftId) {
                deleteEbPhotosForDraft(currentDraftId).then(function() {
                    console.info('[NPI SnapWalk] IndexedDB photos removed for draft', currentDraftId);
                }).catch(function(err) {
                    console.warn('[NPI SnapWalk] IndexedDB photo cleanup failed:', err && err.message);
                });
                currentDraftId = null;
            }

            /* 3-6. Release every preview URL and clear all photo state. */
            releaseAllPreviewUrls();
            var photoUids = Object.keys(photoStore);
            for (var i = 0; i < photoUids.length; i++) delete photoStore[photoUids[i]];
            var metaUids = Object.keys(photoMetaStore);
            for (var j = 0; j < metaUids.length; j++) delete photoMetaStore[metaUids[j]];
            var procUids = Object.keys(photoProcessing);
            for (var k = 0; k < procUids.length; k++) delete photoProcessing[procUids[k]];

            /* 7. Clear the saved draft. */
            clearDraft();

            /* 8. Reset all EB report fields. */
            ['projectName', 'buildIdentity', 'planQuantity', 'visitorName',
             'factoryLocation', 'specialRemark', 'actualBuildQty', 'forRate',
             'bottleneckCycleTime', 'commentsRemarks'].forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.value = '';
            });

            /* 9. buildDate = today. */
            var dateEl = document.getElementById('buildDate');
            if (dateEl) dateEl.value = new Date().toISOString().split('T')[0];

            /* 10. Remove all existing observations. */
            var container = document.getElementById('observationContainer');
            if (container) container.innerHTML = '';

            /* 11. Reset the observation counter. */
            obsCounter = 0;

            /* 12. Generate a new report identity. */
            currentDraftId = generateUuid();

            /* 13. Create one blank observation. */
            addObservationCardInternal(null);
            updateAddButtons();

            /* 14. Update export statistics. */
            updateExportStats();

            /* 15. Save the new draft under the new report identity. */
            saveDraftImmediate();

            /* 16. Confirm to the user. */
            showDraftBanner('New report started.', false);
        }

        function hasDraft() {
            var raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) return false;
            try {
                var draft = JSON.parse(raw);
                if (draft.timestamp) {
                    var saved = new Date(draft.timestamp);
                    var now = new Date();
                    var days = (now - saved) / (1000 * 60 * 60 * 24);
                    if (days > DRAFT_MAX_AGE_DAYS) {
                        var expiredDraftId = draft.draftId;
                        localStorage.removeItem(DRAFT_KEY);
                        if (expiredDraftId && isSafeIdToken(expiredDraftId)) {
                            deleteEbPhotosForDraft(expiredDraftId).then(function() {
                                console.info('[NPI SnapWalk] IndexedDB photos removed for expired draft', expiredDraftId);
                            }).catch(function(err) {
                                console.warn('[NPI SnapWalk] IndexedDB cleanup for expired draft failed:', err && err.message);
                            });
                        }
                        return false;
                    }
                }
            } catch (e) {
                localStorage.removeItem(DRAFT_KEY);
                return false;
            }
            return true;
        }

        function restoreDraft() {
            var raw = localStorage.getItem(DRAFT_KEY);
            if (!raw) return false;
            var draft;
            try {
                draft = JSON.parse(raw);
            } catch (e) {
                console.warn('Draft parse failed:', e.message);
                return false;
            }
            if (!draft || !draft.section1 || !draft.section2) return false;

            /* Adopt the stable draft identity. Older drafts (schema v1)
               have no draftId: generate one and persist it so stale
               IndexedDB photos can never attach to a different report.
               Unusable identity tokens are regenerated the same way. */
            if (!draft.draftId || !isSafeIdToken(draft.draftId)) {
                currentDraftId = generateUuid();
                draft.draftId = currentDraftId;
                try {
                    localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
                } catch (e) {
                    console.warn('Draft identity migration save failed:', e.message);
                }
            } else {
                currentDraftId = draft.draftId;
            }

            isRestoring = true;

            if (draft.section1.projectName !== undefined) document.getElementById('projectName').value = draft.section1.projectName;
            if (draft.section1.buildIdentity !== undefined) document.getElementById('buildIdentity').value = draft.section1.buildIdentity;
            if (draft.section1.buildDate) document.getElementById('buildDate').value = draft.section1.buildDate;
            if (draft.section1.planQuantity !== undefined) document.getElementById('planQuantity').value = draft.section1.planQuantity;
            if (draft.section1.visitorName !== undefined) document.getElementById('visitorName').value = draft.section1.visitorName;
            if (draft.section1.factoryLocation !== undefined) document.getElementById('factoryLocation').value = draft.section1.factoryLocation;
            if (draft.section1.specialRemark !== undefined) document.getElementById('specialRemark').value = draft.section1.specialRemark;

            if (draft.section3) {
                if (draft.section3.actualBuildQty !== undefined) document.getElementById('actualBuildQty').value = draft.section3.actualBuildQty;
                if (draft.section3.forRate !== undefined) document.getElementById('forRate').value = draft.section3.forRate;
                var bct = draft.section3.bottleneckCycleTime !== undefined ? draft.section3.bottleneckCycleTime : draft.section3.avgCycleTime;
                if (bct !== undefined) document.getElementById('bottleneckCycleTime').value = bct;
                if (draft.section3.commentsRemarks !== undefined) document.getElementById('commentsRemarks').value = draft.section3.commentsRemarks;
            }

            var container = document.getElementById('observationContainer');
            container.innerHTML = '';
            obsCounter = 0;

            if (draft.section2.observations && draft.section2.observations.length > 0) {
                draft.section2.observations.forEach(function(obs) {
                    addObservationCardInternal(obs);
                });
            }

            isRestoring = false;

            updateDraftStatus('restored', draft.timestamp ? new Date(draft.timestamp) : null);
            updateExportStats();

            /* Load matching compressed photo Blobs from IndexedDB and
               update the banner with the restore result. Never blocks the
               form: failures are handled per record. */
            restoreDraftPhotosAsync();

            return true;
        }

        function addObservationCardInternal(data) {
            obsCounter++;
            var container = document.getElementById('observationContainer');
            var rowId = 'obs-row-' + obsCounter;
            var detailId = 'obs-detail-' + obsCounter;

            /* Stable per-observation identity used for IndexedDB photo
               keys and draft metadata; preserved across renumbering and
               restoration. Unusable tokens are regenerated. */
            var obsUid = (data && data.obsUid && isSafeIdToken(data.obsUid)) ? data.obsUid : generateUuid();
            if (data && data.photoMeta) {
                photoMetaStore[obsUid] = data.photoMeta;
            } else if (data && data.obsUid) {
                delete photoMetaStore[obsUid];
            }

            var catOptions = '<option value="">--</option>';
            CATEGORIES.forEach(function(c) {
                catOptions += '<option value="' + c.label + '">' + c.label + '</option>';
            });
            var statusValue = (data && data.status) ? normalizeObsStatus(data.status) : DEFAULT_OBS_STATUS;

            var tr = document.createElement('tr');
            tr.id = rowId;
            tr.className = 'obs-row-main';
            tr.dataset.obsId = obsCounter;
            tr.dataset.obsUid = obsUid;
            tr.innerHTML =
                '<td class="col-item" data-label="Item">' + obsCounter + '</td>' +
                '<td class="col-category obs-required" data-label="Category">' +
                    '<span class="obs-mob-label">Category <span class="req">*</span></span>' +
                    '<div class="field"><select class="obs-category" required>' + catOptions + '</select></div>' +
                '</td>' +
                '<td class="col-process obs-required" data-label="Process ID">' +
                    '<span class="obs-mob-label">Process ID <span class="req">*</span></span>' +
                    '<div class="field"><input type="text" class="obs-process-id" placeholder="e.g. OP-15 / Station 3" required></div>' +
                '</td>' +
                '<td class="col-photo" data-label="Photo">' +
                    '<div id="photo-slot-' + obsCounter + '">' +
                        '<button type="button" class="obs-photo-add" onclick="triggerPhotoInput(' + obsCounter + ')">' + cameraSvg() + 'Photo</button>' +
                    '</div>' +
                '</td>' +
                '<td class="col-date" data-label="Issue Date">' +
                    '<div class="field"><input type="date" class="obs-issue-date" value=""></div>' +
                '</td>' +
                '<td class="col-actions">' +
                    '<button type="button" class="obs-delete-btn" onclick="confirmDeleteObs(' + obsCounter + ')" title="Delete observation"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg></button>' +
                    '<input type="hidden" class="obs-status" value="' + statusValue + '">' +
                '</td>';
            container.appendChild(tr);
            var slotEl = document.getElementById('photo-slot-' + obsCounter);
            if (slotEl) slotEl.dataset.obsUid = obsUid;

            var descTr = document.createElement('tr');
            descTr.className = 'obs-desc-row';
            descTr.dataset.obsId = obsCounter;
            descTr.innerHTML =
                '<td colspan="6">' +
                    '<div class="obs-desc-wrapper">' +
                        '<label class="obs-desc-label">Observation Description <span class="req">*</span></label>' +
                        '<textarea class="obs-description" placeholder="Describe the issue, observation, or evidence..." oninput="autoGrow(this)" rows="3" required></textarea>' +
                        '<input type="hidden" class="obs-owner">' +
                    '</div>' +
                '</td>';
            container.appendChild(descTr);

            var footerTr = document.createElement('tr');
            footerTr.className = 'obs-footer-row';
            footerTr.dataset.obsId = obsCounter;
            footerTr.innerHTML =
                '<td colspan="6">' +
                    '<div class="obs-card-footer">' +
                        '<button type="button" class="obs-detail-toggle" id="detail-toggle-' + obsCounter + '" onclick="toggleDetail(' + obsCounter + ')">Follow-up / Details ▾</button>' +
                        '<button type="button" class="obs-add-btn btn btn-outline" onclick="addObservationCard()">+ Add</button>' +
                    '</div>' +
                '</td>';
            container.appendChild(footerTr);

            var detailTr = document.createElement('tr');
            detailTr.id = detailId;
            detailTr.className = 'obs-detail-row hidden';
            detailTr.dataset.obsId = obsCounter;
            detailTr.innerHTML =
                '<td colspan="6">' +
                    '<div class="obs-detail-grid">' +
                        '<div class="field detail-followup"><label>Follow Up / Result</label><textarea class="obs-followup" placeholder="Action items..." rows="2"></textarea></div>' +
                        '<div class="field detail-target"><label>Target Date</label><input type="date" class="obs-target-date"></div>' +
                        '<div class="field detail-complete"><label>Complete Date</label><input type="date" class="obs-complete-date"></div>' +
                        '<div class="field detail-doc"><label>Supporting Document</label><input type="text" class="obs-support-doc" placeholder="Link or reference"></div>' +
                    '</div>' +
                '</td>';
            container.appendChild(detailTr);

            if (data) {
                if (data.issueDate) tr.querySelector('.obs-issue-date').value = data.issueDate;
                if (data.category) tr.querySelector('.obs-category').value = data.category;
                if (data.owner) descTr.querySelector('.obs-owner').value = data.owner;
                if (data.processId) tr.querySelector('.obs-process-id').value = data.processId;
                if (data.description) { var ta = descTr.querySelector('.obs-description'); ta.value = data.description; autoGrow(ta); }
                if (data.followUp) detailTr.querySelector('.obs-followup').value = data.followUp;
                if (data.targetDate) detailTr.querySelector('.obs-target-date').value = data.targetDate;
                if (data.completeDate) detailTr.querySelector('.obs-complete-date').value = data.completeDate;
                if (data.supportDoc) detailTr.querySelector('.obs-support-doc').value = data.supportDoc;
            }
            if (!data || !data.issueDate) {
                tr.querySelector('.obs-issue-date').value = new Date().toISOString().split('T')[0];
            }
            /* Apply inheritance state so restored "Same as Above" rows show
               the locked fields immediately. The restored description (marker
               or custom edit) is left untouched because enterSameAsAbove
               only writes the marker when the field is empty. */
            applySameAsAboveState(tr, {});
        }

        function updateDraftStatus(state, timestamp) {
            var el = document.getElementById('draftStatus');
            if (!el) return;
            var dotClass = '';
            var text = '';
            if (state === 'saved') {
                dotClass = 'saved';
                var timeStr = timestamp ? timestamp.toTimeString().slice(0, 5) : '';
                text = timeStr ? ('Saved ' + timeStr) : 'Saved';
            } else if (state === 'restored') {
                dotClass = 'restored';
                text = 'Draft restored';
            } else if (state === 'cleared') {
                dotClass = 'unsaved';
                text = '';
            }
            el.innerHTML = '<span class="draft-status-dot ' + dotClass + '"></span>' + (text ? '<span class="draft-status-label"> ' + text + '</span>' : '');
        }

        function showDraftBanner(msg, persistent, kind) {
            var banner = document.getElementById('draftBanner');
            if (!banner) return;
            clearTimeout(draftBannerTimer);
            banner.classList.toggle('warn', kind === 'warn');
            banner.querySelector('.draft-banner-msg').textContent = msg;
            banner.classList.remove('hidden');
            if (!persistent) {
                draftBannerTimer = setTimeout(function() { banner.classList.add('hidden'); }, 5000);
            }
        }

        function dismissDraftBanner() {
            clearTimeout(draftBannerTimer);
            var banner = document.getElementById('draftBanner');
            if (banner) banner.classList.add('hidden');
        }

        /* ============================================================
           STATE & STORAGE REFACTOR — migration + persistence
           ============================================================ */

        /* Migrate a legacy EB draft (old un-namespaced key) to the new
           namespaced module key without user action. Never discards data. */
        function migrateLegacyDraft() {
            try {
                if (!localStorage.getItem(DRAFT_KEY) && localStorage.getItem(LEGACY_DRAFT_KEY)) {
                    var legacy = localStorage.getItem(LEGACY_DRAFT_KEY);
                    localStorage.setItem(DRAFT_KEY, legacy);
                    localStorage.removeItem(LEGACY_DRAFT_KEY);
                }
            } catch (e) {
                console.warn('Draft migration failed:', e.message);
            }
        }

        /* Load persisted app state (current module, last module) with a
           safe default fallback if absent or corrupted. */
        function loadAppState() {
            var state = null;
            try {
                var raw = localStorage.getItem(STATE_KEY);
                if (raw) state = JSON.parse(raw);
            } catch (e) {
                console.warn('State load failed:', e.message);
            }
            if (state && state.currentModule) {
                appState.schemaVersion = state.schemaVersion || 1;
                appState.currentModule = state.currentModule;
                appState.settings = state.settings || { lastModule: appState.currentModule };
            } else {
                appState = {
                    schemaVersion: 1,
                    currentModule: MODULES.EB_REPORT,
                    settings: { lastModule: MODULES.EB_REPORT }
                };
            }
            return appState;
        }

        /* Persist app state whenever it changes. */
        function saveAppState() {
            try {
                localStorage.setItem(STATE_KEY, JSON.stringify(appState));
            } catch (e) {
                console.warn('State save failed:', e.message);
            }
        }

        /* ============================================================
           BRANDING & BROWSER TITLE
           ============================================================ */

        /* Centralized branding renderer. Sets browser tab title,
           header titles, footer, About dialog, and drawer footer
           from config constants. */
        function renderAppTitle() {
            var moduleTitle = MODULE_TITLES[appState.currentModule] || '';
            document.title = moduleTitle ? (APP_NAME + ' | ' + moduleTitle) : APP_NAME;

            var header = MODULE_HEADERS[appState.currentModule];
            if (header) {
                var desktopEl = document.getElementById('topbarTitle');
                var mobileEl = document.getElementById('topbarTitleMobile');
                if (desktopEl) desktopEl.textContent = header.desktop;
                if (mobileEl) mobileEl.textContent = header.mobile;
            }

            var versionEl = document.getElementById('appVersion');
            if (versionEl) versionEl.textContent = APP_TAGLINE + ' \u00b7 ' + APP_VERSION;

            var footerEl = document.getElementById('footerBrand');
            if (footerEl) footerEl.textContent = APP_NAME + ' \u2014 ' + APP_TAGLINE + ' \u2014 ' + APP_VERSION;

            var aboutTitle = document.getElementById('aboutTitle');
            if (aboutTitle) aboutTitle.textContent = header ? header.desktop : APP_NAME;

            var aboutVersion = document.getElementById('aboutTitleVersion');
            if (aboutVersion) aboutVersion.textContent = APP_NAME + ' \u2014 ' + APP_TAGLINE + ' \u2014 ' + APP_VERSION;
        }

        function showAppWarning(message) {
            var box = document.getElementById('appWarnings');
            if (!box) {
                box = document.createElement('div');
                box.id = 'appWarnings';
                box.style.cssText = 'position:fixed;left:12px;right:12px;bottom:12px;z-index:9998;display:flex;flex-direction:column;gap:8px;pointer-events:none;';
                document.body.appendChild(box);
            }
            var item = document.createElement('div');
            item.style.cssText = 'pointer-events:auto;background:#FFF3CD;border:1px solid #D39E00;color:#664D03;padding:10px 34px 10px 12px;border-radius:6px;font:13px/1.4 system-ui,sans-serif;box-shadow:0 2px 8px rgba(0,0,0,.18);position:relative;';
            item.textContent = message;
            var btn = document.createElement('button');
            btn.type = 'button';
            btn.setAttribute('aria-label', 'Dismiss warning');
            btn.textContent = '\u00d7';
            btn.style.cssText = 'position:absolute;top:4px;right:6px;border:0;background:transparent;color:#664D03;font-size:18px;line-height:1;cursor:pointer;padding:2px 6px;';
            btn.onclick = function() { if (item.parentNode) item.parentNode.removeChild(item); };
            item.appendChild(btn);
            box.appendChild(item);
        }

        function requestPersistentStorage() {
            if (!navigator.storage || typeof navigator.storage.persist !== 'function') {
                logAppEvent('persist', 'unsupported');
                return;
            }
            navigator.storage.persist().then(function(granted) {
                logAppEvent('persist', granted ? 'granted' : 'denied');
            }).catch(function(err) {
                logAppError('persist', err && err.message);
            });
        }

        function showPrivateBrowsingWarning() {
            if (privateBrowsingWarningShown) return;
            privateBrowsingWarningShown = true;
            logAppEvent('private-browsing-detected', 'warning shown');
            showAppWarning('Private Browsing deletes photos when the tab closes.');
        }

        function detectPrivateBrowsing() {
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                navigator.storage.estimate().then(function(info) {
                    var quota = info && info.quota ? info.quota : 0;
                    logAppEvent('storage-estimate', 'quota=' + quota + ' usage=' + (info && info.usage));
                    if (quota > 0 && quota < 120 * 1024 * 1024) showPrivateBrowsingWarning();
                }).catch(function(err) {
                    logAppError('storage-estimate', err && err.message);
                });
            }
            var probeId = '__npisnapwalk_write_probe__';
            openAppDatabase().then(function(db) {
                var tx;
                try {
                    tx = db.transaction(IDB_STORE, 'readwrite');
                } catch (e) {
                    logAppError('idb-write-test', e && e.message);
                    showPrivateBrowsingWarning();
                    return;
                }
                try {
                    tx.objectStore(IDB_STORE).put({ id: probeId, probe: true });
                } catch (e) {
                    logAppError('idb-write-test', e && e.message);
                    showPrivateBrowsingWarning();
                    return;
                }
                tx.oncomplete = function() {
                    try {
                        var tx2 = db.transaction(IDB_STORE, 'readwrite');
                        tx2.objectStore(IDB_STORE).delete(probeId);
                        tx2.oncomplete = function() { logAppEvent('idb-write-test', 'ok'); };
                    } catch (e) { logAppError('idb-write-test-cleanup', e && e.message); }
                };
                tx.onerror = function() {
                    logAppError('idb-write-test', 'write failed');
                    showPrivateBrowsingWarning();
                };
                tx.onabort = function() {
                    logAppError('idb-write-test', 'write aborted');
                    showPrivateBrowsingWarning();
                };
            }).catch(function(err) {
                logAppError('idb-write-test', err && err.message);
                showPrivateBrowsingWarning();
            });
        }

        function detectStandaloneMode() {
            var standalone = false;
            try {
                standalone = (window.navigator.standalone === true) ||
                    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
            } catch (e) {}
            logAppEvent('standalone', standalone ? 'yes' : 'no');
            if (standalone) {
                var shown = false;
                try { shown = sessionStorage.getItem('appStandaloneWarningShown') === '1'; } catch (e) {}
                if (!shown) {
                    try { sessionStorage.setItem('appStandaloneWarningShown', '1'); } catch (e) {}
                    showAppWarning('Use either Safari or the Home Screen icon, not both. They keep separate photo storage.');
                }
            }
        }

        function isDebugMode() {
            try {
                var q = (window.location && window.location.search) ? window.location.search : '';
                return /(?:^|[?&])debug=1(?:&|$)/.test(q);
            } catch (e) { return false; }
        }

        function debugBaseText() {
            var standalone = false;
            try {
                standalone = (window.navigator.standalone === true) ||
                    (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches);
            } catch (e) {}
            var lines = [];
            lines.push('NPI SnapWalk ' + APP_VERSION + ' debug @ ' + appNowISO());
            lines.push('userAgent=' + (navigator.userAgent || ''));
            lines.push('standalone=' + (standalone ? 'yes' : 'no'));
            lines.push('draftId=' + (currentDraftId || '(none)'));
            lines.push('observations=' + document.querySelectorAll('#observationContainer tr.obs-row-main').length);
            lines.push('photoMeta=' + Object.keys(photoMetaStore).length);
            return lines;
        }

        function copyDebugLog() {
            var pre = document.getElementById('appDebugPre');
            var text = pre ? pre.textContent : debugBaseText().join('\n');
            function fallback() {
                try {
                    var ta = document.createElement('textarea');
                    ta.value = text;
                    ta.style.cssText = 'position:fixed;top:-1000px;left:-1000px;';
                    document.body.appendChild(ta);
                    ta.select();
                    document.execCommand('copy');
                    document.body.removeChild(ta);
                } catch (e) { logAppError('debug-copy', e && e.message); }
            }
            if (navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
                navigator.clipboard.writeText(text).catch(fallback);
            } else {
                fallback();
            }
        }

        function renderDebugPanel() {
            var panel = document.getElementById('appDebugPanel');
            if (!panel) {
                panel = document.createElement('div');
                panel.id = 'appDebugPanel';
                panel.style.cssText = 'position:fixed;top:8px;right:8px;width:420px;max-width:calc(100% - 16px);max-height:70vh;overflow:auto;z-index:10000;background:#0b1220;color:#d7e2f0;border:1px solid #274060;border-radius:8px;padding:10px;font:12px/1.45 monospace;box-shadow:0 8px 24px rgba(0,0,0,.35);';
                document.body.appendChild(panel);
            }
            panel.innerHTML = '<div style="display:flex;gap:8px;align-items:center;margin-bottom:6px"><strong>NPI SnapWalk debug</strong><button type="button" id="appDebugCopy">Copy log</button><button type="button" id="appDebugRefresh">Refresh</button></div><pre id="appDebugPre" style="white-space:pre-wrap;margin:0"></pre>';
            document.getElementById('appDebugCopy').onclick = copyDebugLog;
            document.getElementById('appDebugRefresh').onclick = function() { renderDebugPanel(); };
            var pre = document.getElementById('appDebugPre');
            pre.textContent = debugBaseText().join('\n') + '\n\nLoading storage details...';
            var draftId = currentDraftId;
            var statsPromise = draftId ? getEbPhotoStatsForDraft(draftId) : Promise.resolve({ count: 0, bytes: 0 });
            var persistedPromise = (navigator.storage && typeof navigator.storage.persisted === 'function') ? navigator.storage.persisted() : Promise.resolve('unsupported');
            var estimatePromise = (navigator.storage && typeof navigator.storage.estimate === 'function') ? navigator.storage.estimate() : Promise.resolve(null);
            Promise.all([
                statsPromise.catch(function(err) { return { error: err && err.message }; }),
                persistedPromise.catch(function(err) { return 'error: ' + (err && err.message); }),
                estimatePromise.catch(function() { return null; })
            ]).then(function(results) {
                var stats = results[0] || {};
                var persisted = results[1];
                var estimate = results[2];
                var lines = debugBaseText();
                lines.push('idbRecords=' + (stats.error ? 'error: ' + stats.error : (stats.count || 0)));
                lines.push('idbBytes=' + (stats.error ? '?' : (stats.bytes || 0)));
                lines.push('persisted=' + (typeof persisted === 'string' ? persisted : (persisted ? 'yes' : 'no')));
                if (estimate) {
                    lines.push('estimate.usage=' + (estimate.usage || 0));
                    lines.push('estimate.quota=' + (estimate.quota || 0));
                } else {
                    lines.push('estimate=unsupported');
                }
                lines.push('');
                lines.push('errors (' + appErrorLog.length + '/' + APP_ERROR_LOG_LIMIT + '):');
                if (!appErrorLog.length) lines.push('  (none)');
                appErrorLog.slice(-APP_ERROR_LOG_LIMIT).forEach(function(e) {
                    lines.push('  ' + e.at + ' [' + e.source + '] ' + e.message + (e.detail ? ' | ' + e.detail : ''));
                });
                lines.push('');
                lines.push('events (' + appEventLog.length + '/' + APP_EVENT_LOG_LIMIT + '):');
                if (!appEventLog.length) lines.push('  (none)');
                appEventLog.slice(-APP_EVENT_LOG_LIMIT).forEach(function(e) {
                    lines.push('  ' + e.at + ' ' + e.name + (e.detail ? ' | ' + e.detail : ''));
                });
                pre.textContent = lines.join('\n');
            });
        }

        /* ============================================================
           INIT
           ============================================================ */
        document.getElementById('buildDate').valueAsDate = new Date();
        window.onload = function() {
            migrateLegacyDraft();
            loadAppState();
            saveAppState();
            renderAppTitle();
            var restored = hasDraft() ? restoreDraft() : false;
            if (!restored) {
                addObservationCard();
            }
            updateExportStats();
            bindAutoSaveListeners();
            updateAddButtons();
            bindHamburgerMenu();
            initRunRateModule();
            renderMenuActiveState();
            renderModuleView();
            /* The restore banner is set by restoreDraftPhotosAsync with the
               actual photo restore result instead of a fixed reattach notice. */
            logAppEvent('page-load', navigator.userAgent);
            logStorageEstimate();
            requestPersistentStorage();
            detectStandaloneMode();
            detectPrivateBrowsing();
            if (isDebugMode()) renderDebugPanel();
            /* Reveal the app now that the correct module is visible. */
            document.body.classList.remove('preload');
        };

        /* ============================================================
           AUTO-SAVE EVENT LISTENERS
           ============================================================ */
        function bindAutoSaveListeners() {
            var form = document.getElementById('buildForm');
            if (!form) return;

            /* "Same as Above" category handling runs before the autosave
               listeners so the DOM is consistent when a draft is collected. */
            form.addEventListener('focusin', function(e) {
                if (e.target.classList && e.target.classList.contains('obs-category')) {
                    e.target.dataset.prevCat = e.target.value;
                }
            });
            form.addEventListener('change', function(e) {
                if (e.target.classList && e.target.classList.contains('obs-category')) {
                    var row = findMainRowForElement(e.target);
                    if (row) applySameAsAboveState(row, { userAction: true });
                    reapplySameAsAbove();
                    updateExportStats();
                }
            });

            form.addEventListener('input', function(e) {
                var tag = e.target.tagName.toLowerCase();
                if (tag === 'input' && e.target.type === 'text' || tag === 'textarea') {
                    saveDraftDebounced();
                } else if (tag === 'select' || (tag === 'input' && (e.target.type === 'date' || e.target.type === 'number'))) {
                    saveDraftImmediate();
                }
            });
            form.addEventListener('change', function(e) {
                if (e.target.type === 'date' || e.target.tagName.toLowerCase() === 'select') {
                    saveDraftImmediate();
                }
            });
        }

        /* ============================================================
           OBSERVATION CARD MANAGEMENT — Table Row Style
           ============================================================ */
        function addObservationCard() {
            addObservationCardInternal(null);
            updateExportStats();
            saveDraftImmediate();
            updateAddButtons();
            var row = document.getElementById('obs-row-' + obsCounter);
            if (row) {
                row.scrollIntoView({ behavior: 'smooth', block: 'center' });
                var firstField = row.querySelector('select') || row.querySelector('input');
                if (firstField) setTimeout(function() { firstField.focus(); }, 300);
            }
        }

        function removeObservationCard(obsId) {
            if (pendingBarRow && pendingBarRow.obsId === obsId) pendingBarRow = null;
            var container = document.getElementById('observationContainer');
            if (container.children.length <= 4) {
                alert("At least one observation record is required.");
                return;
            }
            var uid = getObsUidForDomId(obsId);
            if (uid && photoProcessing[uid]) return;
            if (uid) {
                if (photoStore[uid]) {
                    revokePreviewUrl(uid);
                    delete photoStore[uid];
                    delete photoMetaStore[uid];
                }
                if (currentDraftId) {
                    deleteEbPhoto(currentDraftId, uid).then(function() {
                        console.info('[NPI SnapWalk] IndexedDB photo removed with observation', uid);
                    }).catch(function(err) {
                        console.warn('[NPI SnapWalk] IndexedDB photo delete failed:', err && err.message);
                    });
                }
            }
            var row = document.getElementById('obs-row-' + obsId);
            var descRow = row ? row.nextElementSibling : null;
            var detail = document.getElementById('obs-detail-' + obsId);
            var footerRow = document.querySelector('tr.obs-footer-row[data-obs-id="' + obsId + '"]');
            if (footerRow) footerRow.remove();
            if (detail) detail.remove();
            if (descRow && descRow.classList.contains('obs-desc-row')) descRow.remove();
            if (row) row.remove();
            renumberObservations();
            /* A "Same as Above" row whose source observation was deleted
               re-inherits from the next valid ancestor, or exits the mode
               when no source remains — never leaves a broken reference. */
            var inheritedReset = reapplySameAsAbove();
            updateExportStats();
            saveDraftImmediate();
            updateAddButtons();
            if (inheritedReset) {
                showDraftBanner('A "Same as Above" observation was reset because its source observation no longer exists.', false, 'warn');
            }
        }

        function renumberObservations() {
            var container = document.getElementById('observationContainer');
            var rows = container.querySelectorAll('tr.obs-row-main');
            rows.forEach(function(row, index) {
                var num = index + 1;
                var cell = row.querySelector('.col-item');
                if (cell) cell.textContent = num;
            });
        }

        function toggleDetail(obsId) {
            var detail = document.getElementById('obs-detail-' + obsId);
            var toggleBtn = document.getElementById('detail-toggle-' + obsId);
            if (!detail) return;

            var isHidden = detail.classList.contains('hidden');
            if (isHidden) {
                detail.classList.remove('hidden');
                if (toggleBtn) toggleBtn.innerHTML = 'Follow-up / Details ▲';
                var ta = detail.querySelector('.obs-followup');
                if (ta) ta.focus();
            } else {
                detail.classList.add('hidden');
                if (toggleBtn) toggleBtn.innerHTML = 'Follow-up / Details ▾';
            }
        }

        function confirmDeleteObs(obsId) {
            if (confirm('Delete this observation? This cannot be undone.')) {
                removeObservationCard(obsId);
            }
        }

        function updateAddButtons() {
            var addBtns = document.querySelectorAll('.obs-add-btn');
            addBtns.forEach(function(btn) { btn.classList.add('hidden'); });
            var rows = document.querySelectorAll('#observationContainer tr.obs-footer-row');
            if (rows.length > 0) {
                var lastFooter = rows[rows.length - 1];
                var lastBtn = lastFooter.querySelector('.obs-add-btn');
                if (lastBtn) lastBtn.classList.remove('hidden');
            }
        }

        function autoGrow(el) {
            el.style.height = 'auto';
            el.style.height = el.scrollHeight + 'px';
        }


        /* ============================================================
           PHOTO HANDLING — 1 photo per item, memory-safe compression
           ============================================================
           Pipeline notes:
           - FileReader.readAsDataURL() was removed from the capture path.
             A Data URL creates a large Base64 string plus a fully decoded
             source bitmap before compression, which spikes memory and can
             crash low-memory Android devices on the second camera photo.
             The source is now loaded via a temporary Object URL that is
             revoked after compression in every path.
           - IndexedDB stores ONLY already-compressed JPEG Blobs. Original
             camera files, Base64 strings, Data URLs and Object URLs are
             never persisted.
           - Stable draftId + obsUid identities keep IndexedDB records
             attached to the correct draft and observation even when
             observations are visually renumbered.
           - Object URLs are session-specific and are never persisted;
             each preview URL is revoked before replacement, on removal,
             on observation deletion, and on pagehide / beforeunload.
           ============================================================ */
        function triggerPhotoInput(obsId) {
            var uid = getObsUidForDomId(obsId);
            if (!uid) return;
            if (photoProcessing[uid]) return;
            currentObsId = obsId;
            document.getElementById('photoSourceOverlay').classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }

        function closePhotoSourceSelector(keepPendingRow) {
            document.getElementById('photoSourceOverlay').classList.add('hidden');
            document.body.style.overflow = '';
            currentObsId = null;
            if (keepPendingRow !== true) cleanupPendingBarRow();
        }

        function triggerCameraInput() {
            var obsId = currentObsId;
            closePhotoSourceSelector(true);
            if (!obsId) return;
            var input = createCameraInput(obsId);
            if (input) input.click();
        }

        function triggerExistingPhotoInput() {
            var obsId = currentObsId;
            closePhotoSourceSelector(true);
            if (!obsId) return;
            var input = createGalleryInput(obsId);
            if (input) input.click();
        }

        function createTemporaryPhotoInput(obsId, kind) {
            var slot = document.getElementById('photo-slot-' + obsId);
            if (!slot) return null;
            clearTemporaryInputs(slot);
            var input = document.createElement('input');
            input.type = 'file';
            input.accept = 'image/*';
            if (kind === 'camera') input.setAttribute('capture', 'environment');
            input.className = 'photo-temp-input';
            input.style.display = 'none';
            input.id = 'photo-input-' + kind + '-' + obsId;
            var sourceType = kind;
            input.onchange = function(e) { handlePhotoCapture(e, obsId, sourceType); };
            if (typeof input.addEventListener === 'function') {
                input.addEventListener('cancel', function() { cleanupTemporaryInput(input); cleanupPendingBarRow(); });
            }
            slot.appendChild(input);
            return input;
        }

        function createCameraInput(obsId) {
            return createTemporaryPhotoInput(obsId, 'camera');
        }

        function createGalleryInput(obsId) {
            return createTemporaryPhotoInput(obsId, 'gallery');
        }

        function clearTemporaryInputs(slot) {
            var temps = slot.querySelectorAll('input.photo-temp-input');
            for (var i = 0; i < temps.length; i++) cleanupTemporaryInput(temps[i]);
        }

        function cleanupTemporaryInput(input) {
            if (!input) return;
            input.onchange = null;
            try { input.value = ''; } catch (e) {}
            try { if (input.parentNode) input.parentNode.removeChild(input); } catch (e) {}
        }

        async function handlePhotoCapture(event, obsId, sourceType) {
            var input = event.target;
            var file = (input.files && input.files.length > 0) ? input.files[0] : null;
            if (!file) { cleanupTemporaryInput(input); cleanupPendingBarRow(); return; }

            var uid = getObsUidForDomId(obsId);
            if (!uid) { cleanupTemporaryInput(input); return; }
            if (photoProcessing[uid]) { cleanupTemporaryInput(input); return; }

            photoProcessing[uid] = true;
            try {
                var isReplacing = !!photoStore[uid];
                if (!isReplacing && getTotalPhotoCount() >= MAX_TOTAL_PHOTOS) {
                    alert('Photo limit reached: ' + MAX_TOTAL_PHOTOS + ' photos maximum per report.\nPlease remove an existing photo before adding a new one.');
                    return;
                }

                setSlotProcessing(obsId);

                var t0 = performance.now();
                var compressedBlob = await compressImage(file, sourceType);
                var compressMs = Math.round(performance.now() - t0);
                photoCaptureCount++;
                var jsHeapMB = (window.performance && performance.memory) ?
                    (performance.memory.usedJSHeapSize / 1048576).toFixed(1) : 'n/a';
                console.info('[NPI SnapWalk] photo', sourceType,
                    'inputBytes=' + file.size, 'mime=' + (file.type || '?'),
                    'outBytes=' + compressedBlob.size, 'compressMs=' + compressMs,
                    'sessionCapture=' + photoCaptureCount, 'jsHeapMB=' + jsHeapMB);
                logAppEvent('photo-captured', 'obs=' + uid + ' source=' + sourceType + ' bytes=' + compressedBlob.size);

                /* The observation may have been deleted while the image was
                   being compressed; discard the result instead of writing an
                   orphan record. */
                if (getObsUidForDomId(obsId) !== uid) {
                    console.info('[NPI SnapWalk] observation removed during photo processing; photo discarded', uid);
                    return;
                }

                ensureDraftId();
                var persisted = false;
                if (currentDraftId) {
                    try {
                        await saveEbPhoto(currentDraftId, uid, compressedBlob);
                        persisted = true;
                        logAppEvent('idb-write-ok', 'obs=' + uid + ' bytes=' + compressedBlob.size);
                        updatePhotoMeta(uid, compressedBlob);
                        await saveDraftSync();
                    } catch (e) {
                        persisted = false;
                        logAppError('photo-save', e && e.message, 'obs=' + uid);
                        logAppEvent('idb-write-fail', 'obs=' + uid);
                        showAppWarning('Photo could not be saved on this device.');
                        warnPhotoPersistence();
                    }
                }

                /* The observation may have been deleted while the IndexedDB
                   write was in flight; remove any record just written so no
                   orphan photo survives. */
                if (getObsUidForDomId(obsId) !== uid) {
                    if (persisted && currentDraftId) {
                        deleteEbPhoto(currentDraftId, uid).catch(function(err) {
                            console.warn('[NPI SnapWalk] orphan photo cleanup failed:', err && err.message);
                        });
                    }
                    console.info('[NPI SnapWalk] observation removed during photo save; photo discarded', uid);
                    return;
                }

                revokePreviewUrl(uid);
                var previewUrl = URL.createObjectURL(compressedBlob);
                photoStore[uid] = {
                    blob: compressedBlob,
                    previewUrl: previewUrl,
                    persisted: persisted,
                    size: compressedBlob.size,
                    updatedAt: new Date().toISOString()
                };
                renderPhotoSlot(obsId, uid);
                updateExportStats();
                saveDraftImmediate();
                pendingBarRow = null;
            } catch (err) {
                console.error('[NPI SnapWalk] Photo processing failed:', err);
                alert('Failed to process photo. Please try again.');
                renderPhotoSlot(obsId, uid);
            } finally {
                photoProcessing[uid] = false;
                cleanupTemporaryInput(input);
            }
        }

        function removePhoto(obsId) {
            var uid = getObsUidForDomId(obsId);
            if (!uid) return;
            if (photoProcessing[uid]) return;
            if (!photoStore[uid]) { renderPhotoSlotAdd(obsId, uid); return; }

            revokePreviewUrl(uid);
            delete photoStore[uid];
            delete photoMetaStore[uid];
            if (currentDraftId) {
                deleteEbPhoto(currentDraftId, uid).then(function() {
                    console.info('[NPI SnapWalk] IndexedDB photo removed', uid);
                }).catch(function(err) {
                    console.warn('[NPI SnapWalk] IndexedDB photo delete failed:', err && err.message);
                });
            }
            renderPhotoSlotAdd(obsId, uid);
            updateExportStats();
            saveDraftImmediate();
        }

        /* Memory-safe compression. The preferred path decodes the source
           with createImageBitmap() (EXIF orientation applied), downscales to
           PHOTO_MAX_WIDTH via the native decoder, and closes every decoded
           ImageBitmap deterministically — decoded source bitmaps are released
           immediately instead of waiting for garbage collection, so camera
           captures do not accumulate native memory. A fallback loads the
           source through a temporary Object URL (no Base64 source copy) and
           releases every temporary resource explicitly after toBlob. */
        function compressImage(file, sourceType) {
            return new Promise(function(resolve, reject) {
                var settled = false;
                var startedAt = performance.now();
                var bitmap = null;
                var srcUrl = null;
                var img = null;
                var canvas = null;
                var ctx = null;
                var srcSize = '';
                var outSize = '';
                var decoder = '';

                function releaseTempResources() {
                    if (bitmap) {
                        try { bitmap.close(); } catch (e) {}
                        bitmap = null;
                    }
                    if (img) {
                        try { img.onload = null; } catch (e) {}
                        try { img.onerror = null; } catch (e) {}
                        try { img.src = ''; } catch (e) {}
                        img = null;
                    }
                    if (ctx) { ctx = null; }
                    if (canvas) {
                        try {
                            var c = canvas.getContext('2d');
                            if (c) c.clearRect(0, 0, canvas.width, canvas.height);
                        } catch (e) {}
                        try { canvas.width = 1; canvas.height = 1; } catch (e) {}
                        canvas = null;
                    }
                    if (srcUrl) {
                        try { URL.revokeObjectURL(srcUrl); } catch (e) {}
                        srcUrl = null;
                    }
                }

                function finish(success, value, err) {
                    if (settled) return;
                    settled = true;
                    releaseTempResources();
                    if (success) {
                        console.info('[NPI SnapWalk] compression', sourceType || 'unknown',
                            'source=' + srcSize, 'out=' + outSize,
                            'bytes=' + value.size, 'mime=' + (value.type || 'image/jpeg'),
                            'decoder=' + decoder, 'ms=' + Math.round(performance.now() - startedAt));
                        resolve(value);
                    } else {
                        reject(err || new Error('Photo compression failed'));
                    }
                }

                function drawToCanvas(source, sw, sh) {
                    try {
                        var scale = Math.min(1, PHOTO_MAX_WIDTH / sw);
                        var width = Math.max(1, Math.round(sw * scale));
                        var height = Math.max(1, Math.round(sh * scale));
                        if (!srcSize) srcSize = sw + 'x' + sh;
                        outSize = width + 'x' + height;
                        canvas = document.createElement('canvas');
                        canvas.width = width;
                        canvas.height = height;
                        ctx = canvas.getContext('2d');
                        if (!ctx) {
                            finish(false, null, new Error('Canvas 2D context unavailable'));
                            return;
                        }
                        ctx.drawImage(source, 0, 0, width, height);
                        canvas.toBlob(function(blob) {
                            if (!blob || !blob.size) {
                                finish(false, null, new Error('Canvas toBlob returned null'));
                                return;
                            }
                            finish(true, blob);
                        }, 'image/jpeg', PHOTO_JPEG_QUALITY);
                    } catch (err) {
                        finish(false, null, err);
                    }
                }

                function startImageElementPath() {
                    try {
                        srcUrl = URL.createObjectURL(file);
                    } catch (e) {
                        finish(false, null, new Error('Could not create Object URL: ' + e.message));
                        return;
                    }
                    try {
                        img = new Image();
                        decoder = 'img';
                        img.onload = function() {
                            var sourceWidth = img.naturalWidth || img.width;
                            var sourceHeight = img.naturalHeight || img.height;
                            if (!sourceWidth || !sourceHeight) {
                                finish(false, null, new Error('Image has no usable dimensions'));
                                return;
                            }
                            drawToCanvas(img, sourceWidth, sourceHeight);
                        };
                        img.onerror = function() {
                            finish(false, null, new Error('Failed to load source image'));
                        };
                        img.src = srcUrl;
                    } catch (e) {
                        finish(false, null, e);
                    }
                }

                function startImageBitmapPath() {
                    decoder = 'createImageBitmap';
                    /* Decode once with EXIF orientation applied to learn the
                       true dimensions, then downscale via a second
                       createImageBitmap so sub-PHOTO_MAX_WIDTH images are
                       never upscaled. Every decoded ImageBitmap is closed
                       deterministically. */
                    window.createImageBitmap(file, { imageOrientation: 'from-image' }).then(function(srcBmp) {
                        if (settled) { try { srcBmp.close(); } catch (e) {} return; }
                        var sw = srcBmp.width || 0;
                        var sh = srcBmp.height || 0;
                        if (!sw || !sh) {
                            try { srcBmp.close(); } catch (e) {}
                            finish(false, null, new Error('Image has no usable dimensions'));
                            return;
                        }
                        srcSize = sw + 'x' + sh;
                        var scale = Math.min(1, PHOTO_MAX_WIDTH / sw);
                        var tw = Math.max(1, Math.round(sw * scale));
                        var th = Math.max(1, Math.round(sh * scale));
                        if (tw === sw && th === sh) {
                            bitmap = srcBmp;
                            drawToCanvas(bitmap, sw, sh);
                            return;
                        }
                        window.createImageBitmap(srcBmp, 0, 0, sw, sh, {
                            resizeWidth: tw,
                            resizeHeight: th,
                            resizeQuality: 'medium'
                        }).then(function(resizedBmp) {
                            try { srcBmp.close(); } catch (e) {}
                            if (settled) { try { resizedBmp.close(); } catch (e) {} return; }
                            bitmap = resizedBmp;
                            drawToCanvas(bitmap, tw, th);
                        }).catch(function(err) {
                            try { srcBmp.close(); } catch (e) {}
                            if (settled) return;
                            console.warn('[NPI SnapWalk] createImageBitmap resize failed, falling back to Image path:', err && err.message);
                            startImageElementPath();
                        });
                    }).catch(function(err) {
                        if (settled) return;
                        console.warn('[NPI SnapWalk] createImageBitmap failed, falling back to Image path:', err && err.message);
                        startImageElementPath();
                    });
                }

                if (typeof window.createImageBitmap === 'function') {
                    startImageBitmapPath();
                } else {
                    startImageElementPath();
                }
            });
        }

        function getObsUidForDomId(obsId) {
            var slot = document.getElementById('photo-slot-' + obsId);
            if (slot && slot.dataset.obsUid) return slot.dataset.obsUid;
            var row = document.getElementById('obs-row-' + obsId);
            return row ? (row.dataset.obsUid || null) : null;
        }

        function findObsDomIdByUid(uid) {
            var rows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            for (var i = 0; i < rows.length; i++) {
                if (rows[i].dataset.obsUid === uid) return parseInt(rows[i].dataset.obsId, 10);
            }
            return null;
        }

        function renderPhotoSlot(obsId, uid) {
            var slot = document.getElementById('photo-slot-' + obsId);
            if (!slot) return;
            var rec = photoStore[uid];
            if (!rec || !rec.blob) {
                renderPhotoSlotAdd(obsId, uid);
                return;
            }
            slot.innerHTML =
                '<img class="obs-photo-thumb" src="' + rec.previewUrl + '" alt="Photo" onclick="triggerPhotoInput(' + obsId + ')">' +
                '<br><button type="button" class="obs-remove-btn" onclick="removePhoto(' + obsId + ')" style="margin-top:4px">Remove</button>';
        }

        function renderPhotoSlotAdd(obsId, uid) {
            var slot = document.getElementById('photo-slot-' + obsId);
            if (!slot) return;
            slot.innerHTML =
                '<button type="button" class="obs-photo-add" onclick="triggerPhotoInput(' + obsId + ')">' + cameraSvg() + 'Photo</button>';
            if (uid) slot.dataset.obsUid = uid;
        }

        function setSlotProcessing(obsId) {
            var slot = document.getElementById('photo-slot-' + obsId);
            if (!slot) return;
            if (slot.querySelector('.obs-photo-processing')) return;
            var div = document.createElement('div');
            div.className = 'obs-photo-processing';
            div.textContent = 'Processing photo...';
            slot.appendChild(div);
        }

        function revokePreviewUrl(uid) {
            var rec = photoStore[uid];
            if (rec && rec.previewUrl) {
                try { URL.revokeObjectURL(rec.previewUrl); } catch (e) {}
                rec.previewUrl = null;
            }
        }

        function releaseAllPreviewUrls() {
            for (var uid in photoStore) {
                if (photoStore[uid]) revokePreviewUrl(uid);
            }
        }

        function attachRestoredPhoto(uid, domId, rec) {
            if (photoStore[uid] && photoStore[uid].blob) return;
            var previewUrl = URL.createObjectURL(rec.blob);
            photoStore[uid] = {
                blob: rec.blob,
                previewUrl: previewUrl,
                persisted: true,
                size: rec.blob.size,
                updatedAt: rec.updatedAt || new Date().toISOString()
            };
            photoMetaStore[uid] = { size: rec.blob.size, updatedAt: rec.updatedAt || null };
            renderPhotoSlot(domId, uid);
        }

        function restoreDraftPhotosAsync() {
            var draftId = currentDraftId;
            if (!draftId) {
                showDraftBanner('Draft restored.', false);
                updateExportStats();
                return;
            }
            var rows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            var expectedUids = [];
            var expectedCount = 0;
            rows.forEach(function(row) {
                var uid = row.dataset.obsUid;
                if (!uid) return;
                expectedUids.push(uid);
                if (photoMetaStore[uid]) expectedCount++;
            });

            getEbPhotosForDraft(draftId).then(function(result) {
                var valid = result.valid;
                var present = result.present;
                var restored = 0;
                var missing = 0;
                var cleaned = false;
                for (var i = 0; i < expectedUids.length; i++) {
                    var uid = expectedUids[i];
                    var rec = valid[uid];
                    if (rec) {
                        var domId = findObsDomIdByUid(uid);
                        if (domId === null) continue;
                        attachRestoredPhoto(uid, domId, rec);
                        restored++;
                    } else if (present[uid]) {
                        /* Corrupt record: the photo is expected but cannot
                           be delivered. Report it as missing. */
                        missing++;
                    } else if (photoMetaStore[uid]) {
                        /* Stale metadata with no durable record (e.g. the
                           IndexedDB write failed when the photo was taken).
                           Drop the expectation so the draft never claims a
                           photo that exists in neither store. */
                        delete photoMetaStore[uid];
                        cleaned = true;
                    }
                }
                if (cleaned) {
                    saveDraftSilent();
                }
                console.info('[NPI SnapWalk] photo restore', 'expected=' + expectedCount,
                    'restored=' + restored, 'missing=' + missing, 'cleaned=' + (cleaned ? 1 : 0));
                logAppEvent('photo-restore', 'expected=' + expectedCount + ' restored=' + restored + ' missing=' + missing + ' cleaned=' + (cleaned ? 1 : 0));
                updateExportStats();
                if (expectedCount === 0) {
                    showDraftBanner('Draft restored.', false);
                } else if (missing > 0) {
                    showDraftBanner('Draft restored. Some photos could not be restored.', false);
                } else if (restored > 0) {
                    showDraftBanner('Draft and photos restored.', false);
                } else {
                    showDraftBanner('Draft restored.', false);
                }
            }).catch(function(err) {
                logAppError('photo-read', err && err.message, 'draftId=' + draftId);
                logAppEvent('photo-restore-read-error', 'draftId=' + draftId);
                updateExportStats();
                showAppWarning('Photos could not be loaded. Do not remove them.');
                warnPhotoPersistence();
            });
        }

        function ensurePhotosInMemory(draftId) {
            var loads = [];
            var rows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            rows.forEach(function(row) {
                var uid = row.dataset.obsUid;
                if (!uid) return;
                if (photoStore[uid] && photoStore[uid].blob) return;
                if (!photoMetaStore[uid]) return;
                var domId = parseInt(row.dataset.obsId, 10);
                loads.push(getEbPhoto(draftId, uid).then(function(rec) {
                    if (rec && rec.blob instanceof Blob) {
                        attachRestoredPhoto(uid, domId, rec);
                    }
                }).catch(function(err) {
                    logAppError('photo-load-export', err && err.message, 'obs=' + uid);
                }));
            });
            return Promise.all(loads);
        }

        function updatePhotoMeta(uid, blob) {
            photoMetaStore[uid] = { size: blob.size, updatedAt: new Date().toISOString() };
        }

        function resetSessionPhotos() {
            var uids = [];
            for (var uid in photoStore) {
                if (photoStore[uid]) uids.push(uid);
            }
            uids.forEach(function(uid) {
                revokePreviewUrl(uid);
                delete photoStore[uid];
                delete photoMetaStore[uid];
            });
            document.querySelectorAll('#observationContainer tr.obs-row-main').forEach(function(row) {
                var domId = parseInt(row.dataset.obsId, 10);
                renderPhotoSlotAdd(domId, row.dataset.obsUid);
            });
            updateExportStats();
        }

        function warnPhotoPersistence() {
            if (photoPersistWarnShown) return;
            photoPersistWarnShown = true;
            console.warn('[NPI SnapWalk] IndexedDB unavailable — photos kept in memory for this session only.');
            showDraftBanner('Photo persistence unavailable. Photos stay for this session but may not survive a refresh.', true, 'warn');
        }

        document.addEventListener('visibilitychange', function() {
            logAppEvent('visibilitychange', document.visibilityState);
            if (document.visibilityState === 'hidden') saveDraftSync();
        });
        window.addEventListener('pagehide', function() {
            logAppEvent('pagehide');
            saveDraftSync();
            releaseAllPreviewUrls();
        });
        window.addEventListener('beforeunload', function() { releaseAllPreviewUrls(); });

        /* ============================================================
           EXPORT STATS
           ============================================================ */
        function getTotalPhotoCount() {
            var count = 0;
            for (var uid in photoStore) {
                if (photoStore[uid] && photoStore[uid].blob) count++;
            }
            return count;
        }

        function getEstimatedSizeMB() {
            var totalBytes = 0;
            for (var uid in photoStore) {
                if (photoStore[uid] && photoStore[uid].blob) {
                    totalBytes += photoStore[uid].blob.size;
                }
            }
            totalBytes += 500 * 1024;
            return totalBytes / (1024 * 1024);
        }

        function updateExportStats() {
            var photoCount = getTotalPhotoCount();
            var estimatedMB = getEstimatedSizeMB();
            var exportBtn = document.getElementById('exportBtn');

            document.getElementById('exportPhotoCount').textContent = photoCount + ' / ' + MAX_TOTAL_PHOTOS;
            document.getElementById('exportFileSize').textContent = estimatedMB.toFixed(1) + ' MB';

            var statusIcon = document.getElementById('exportStatusIcon');
            var statusText = document.getElementById('exportStatusText');
            var statusHint = document.getElementById('exportStatusHint');
            var sizeHint = document.getElementById('exportSizeHint');
            var fileValue = document.getElementById('exportFileSize');

            statusIcon.className = 'export-stat-icon status';
            statusText.className = 'export-stat-value';
            statusHint.className = 'export-stat-sub';
            fileValue.className = 'export-stat-value';
            sizeHint.className = 'export-stat-sub';

            if (estimatedMB < 8) {
                sizeHint.textContent = '';
                statusText.textContent = 'OK';
                statusHint.textContent = '';
                exportBtn.disabled = false;
            } else if (estimatedMB < 10) {
                sizeHint.textContent = 'Consider removing photos';
                fileValue.classList.add('is-warn');
                statusIcon.className = 'export-stat-icon warn';
                statusText.textContent = 'Warning';
                statusText.classList.add('is-warn');
                statusHint.textContent = 'File is getting large. Consider removing some photos.';
                exportBtn.disabled = false;
            } else if (estimatedMB <= 20) {
                sizeHint.textContent = 'Large file — confirmation required';
                fileValue.classList.add('is-danger');
                statusIcon.className = 'export-stat-icon warn';
                statusText.textContent = 'Strong Warning';
                statusText.classList.add('is-warn');
                statusHint.textContent = 'File is large. Export will require confirmation.';
                exportBtn.disabled = false;
            } else {
                sizeHint.textContent = 'Too large — reduce photos';
                fileValue.classList.add('is-danger');
                statusIcon.className = 'export-stat-icon danger';
                statusText.textContent = 'Blocked';
                statusText.classList.add('is-danger');
                statusHint.textContent = 'File exceeds safe size. Please reduce photos.';
                exportBtn.disabled = true;
            }
        }

        /* ============================================================
           EXCEL EXPORT — 1 row = 1 item = 1 photo
           ============================================================ */
        async function exportToExcel() {
            if (!window.ExcelJS) {
                alert('Excel export library not loaded. Please check your internet connection and reload the page.');
                return;
            }
            var exportBtn = document.getElementById('exportBtn');

            var errors = [];
            if (!fieldValue('projectName').trim()) errors.push('Project Name is required.');
            if (!fieldValue('buildIdentity').trim()) errors.push('Build Identity is required.');
            if (!fieldValue('buildDate')) errors.push('Date is required.');
            if (!fieldValue('planQuantity')) errors.push('Plan Quantity is required.');

            var obsRows = document.querySelectorAll('#observationContainer tr.obs-row-main');
            obsRows.forEach(function(row, index) {
                var itemNum = index + 1;
                var catEl = row.querySelector('.obs-category');
                var isSameAsAbove = !!(catEl && isSameAsAboveCategory(catEl.value));
                var obs = resolveObservationData(row);
                if (isSameAsAbove) {
                    /* Inherited values are validated against the resolved
                       source: a broken chain is reported explicitly, and the
                       description must resolve to real text (the marker is
                       replaced by the source description, an edit is checked
                       as-is, and an empty source/description still fails). */
                    if (!obs.parentObsId && !obs.processId.trim()) {
                        errors.push('Item #' + itemNum + ': "Same as Above" has no source observation above it.');
                    }
                    if (!obs.description.trim()) {
                        errors.push('Item #' + itemNum + ': Observation Description is required.');
                    }
                } else {
                    if (!obs.category) errors.push('Item #' + itemNum + ': Category is required.');
                    if (!obs.processId.trim()) errors.push('Item #' + itemNum + ': Process ID is required.');
                    if (!obs.description.trim()) errors.push('Item #' + itemNum + ': Observation Description is required.');
                }
                if (!obs.status) errors.push('Item #' + itemNum + ': Status is required.');
            });

            if (errors.length > 0) {
                alert('Please fix the following before exporting:\n\n\u2022 ' + errors.join('\n\u2022 '));
                return;
            }

            var estimatedMB = getEstimatedSizeMB();
            if (estimatedMB >= 10 && estimatedMB <= 20) {
                var proceed = confirm('Estimated file size: ' + estimatedMB.toFixed(1) + ' MB\nThis is a large file that may be difficult to share.\n\nProceed with export?');
                if (!proceed) return;
            }

            /* Make sure every expected photo Blob is in memory before the
               workbook is built. Restored blobs are reused; anything
               missing from memory but present in IndexedDB is loaded now. */
            if (currentDraftId) {
                try {
                    await ensurePhotosInMemory(currentDraftId);
                } catch (e) {
                    console.warn('[NPI SnapWalk] pre-export photo load failed:', e && e.message);
                }
            }

            exportBtn.innerText = "Generating...";
            exportBtn.disabled = true;

            try {
                var workbook = new ExcelJS.Workbook();
                var worksheet = workbook.addWorksheet('Build Observation', { views: [{ showGridLines: false }] });

                var LAST_COL = 'L';

                function cellAt(addr) { return worksheet.getCell(addr); }
                function merge(a, b) { worksheet.mergeCells(a + ':' + b); }
                function rowH(rr, h) { worksheet.getRow(rr).height = h; }

                function barRow(rr, text, fill, fontColor, height, size) {
                    merge('A' + rr, LAST_COL + rr);
                    var c = cellAt('A' + rr);
                    c.value = text;
                    c.font = { name: FONT, size: size, bold: true, color: { argb: fontColor } };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
                    c.alignment = { vertical: 'middle', horizontal: 'left' };
                    rowH(rr, height);
                }
                function sectionBar(rr, text) { barRow(rr, text, C.dark, C.white, 18, 11); }
                function subBar(rr, text) { barRow(rr, text, C.light, 'FF0B3D91', 15, 10); }

                function labelCell(addr, text) {
                    var c = cellAt(addr);
                    c.value = text;
                    c.font = { name: FONT, size: 9, color: { argb: C.gray } };
                    c.alignment = { vertical: 'middle', horizontal: 'left', wrapText: false };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.labelBg } };
                    return c;
                }
                function dashCell(addr, center) {
                    var c = cellAt(addr);
                    c.value = '—';
                    c.font = { name: FONT, size: 9, italic: true, color: { argb: C.faint } };
                    c.alignment = { vertical: 'middle', horizontal: center ? 'center' : 'left' };
                }
                function valueCell(addr, value, o) {
                    o = o || {};
                    var c = cellAt(addr);
                    var s = (value === null || value === undefined) ? '' : String(value);
                    if (o.dashEmpty && !s) { dashCell(addr, o.center); return c; }
                    c.value = s;
                    c.font = { name: FONT, size: 10, bold: !!o.bold, color: { argb: C.ink } };
                    c.alignment = { vertical: o.top ? 'top' : 'middle', horizontal: o.center ? 'center' : 'left', wrapText: o.wrap !== false };
                    if (o.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
                    if (o.border) c.border = { bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } } };
                    return c;
                }
                function thCell(addr, text, light) {
                    var c = cellAt(addr);
                    c.value = text;
                    c.font = { name: FONT, size: 9, bold: true, color: { argb: light ? 'FF0B3D91' : C.white } };
                    c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: light ? C.light : C.med } };
                    c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
                    c.border = { bottom: { style: 'medium', color: { argb: 'FF8FA3BF' } } };
                    return c;
                }
                function wideRow(rr, labelText, valueText) {
                    merge('A' + rr, 'C' + rr);
                    labelCell('A' + rr, labelText);
                    merge('D' + rr, LAST_COL + rr);
                    valueCell('D' + rr, valueText || '', { top: true, wrap: true });
                    rowH(rr, Math.max(18, wrapH(valueText || '', 150, 12)));
                    return rr + 1;
                }
                function ebStatusInfo(status) {
                    var s = normalizeObsStatus(status);
                    var grp = null;
                    for (var i = 0; i < STATUSES.length; i++) {
                        if (STATUSES[i].label === s) { grp = STATUSES[i].group; break; }
                    }
                    if (!grp || !EB_STATUS_GROUPS[grp]) return { label: s, fill: null, color: null };
                    var g = EB_STATUS_GROUPS[grp];
                    return { label: s, fill: g.bg.replace('#', 'FF'), color: g.text.replace('#', 'FF') };
                }
                function imageSizeOf(base64) {
                    return new Promise(function(resolve, reject) {
                        var img = new Image();
                        img.onload = function() { resolve({ w: img.width, h: img.height }); };
                        img.onerror = function() { reject(new Error('Failed to load photo for sizing')); };
                        img.src = 'data:image/jpeg;base64,' + base64;
                    });
                }

                var today = new Date();
                var exportDate = today.getFullYear() + '-' +
                    String(today.getMonth() + 1).padStart(2, '0') + '-' +
                    String(today.getDate()).padStart(2, '0');
                var r = 1;

                /* ---- Report header ---- */
                merge('A1', LAST_COL + '1');
                var titleCell = cellAt('A1');
                titleCell.value = 'ENGINEERING BUILD REPORT';
                titleCell.font = { name: FONT, size: 15, bold: true, color: { argb: C.white } };
                titleCell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dark } };
                titleCell.alignment = { vertical: 'middle', horizontal: 'left' };
                rowH(1, 24);

                merge('A2', LAST_COL + '2');
                var idCell = cellAt('A2');
                idCell.value = 'Project: ' + (fieldValue('projectName') || '—') +
                    '    |    Build: ' + (fieldValue('buildIdentity') || '—') +
                    '    |    Factory / Location / Line: ' + (fieldValue('factoryLocation') || '—') +
                    '    |    Export Date: ' + exportDate;
                idCell.font = { name: FONT, size: 9, color: { argb: C.gray } };
                idCell.alignment = { vertical: 'middle', horizontal: 'left' };
                rowH(2, 14);

                r = 4;

                /* ---- 1. Main Build Information ---- */
                sectionBar(r, '1. Main Build Information'); r++;
                // 3-pair info grid: label spans 2 columns, value spans 2 columns.
                var pairGrid = [
                    ['Project Name', fieldValue('projectName'),
                     'Build Identity', fieldValue('buildIdentity'),
                     'Date', fieldValue('buildDate')],
                    ['Plan Quantity', fieldValue('planQuantity'),
                     'Auditor Name', fieldValue('visitorName'),
                     'Factory / Location / Line', fieldValue('factoryLocation')]
                ];
                var LAB = [['A', 'B'], ['E', 'F'], ['I', 'J']];
                var VAL = [['C', 'D'], ['G', 'H'], ['K', 'L']];
                for (var pr = 0; pr < pairGrid.length; pr++) {
                    for (var pc = 0; pc < 3; pc++) {
                        merge(LAB[pc][0] + r, LAB[pc][1] + r);
                        labelCell(LAB[pc][0] + r, pairGrid[pr][pc * 2]);
                        merge(VAL[pc][0] + r, VAL[pc][1] + r);
                        valueCell(VAL[pc][0] + r, pairGrid[pr][pc * 2 + 1], { dashEmpty: true });
                    }
                    rowH(r, 18);
                    r++;
                }
                // Special Remark full width (label + wrapped value).
                r = wideRow(r, 'Special Remark', fieldValue('specialRemark'));

                /* ---- 2. Observations / Issue Tracking ---- */
                r++; // spacer
                sectionBar(r, '2. Observations / Issue Tracking'); r++;
                // Header row: primary columns (A-G) + supporting columns (H-L).
                var obsHeaders = ['Item', 'Category', 'Process ID / Workstation', 'Observation',
                    'Photo', 'Owner', 'Status', 'Issue Date', 'Follow-Up / Result', 'Target Date',
                    'Complete Date', 'Supporting Document'];
                for (var hc = 0; hc < obsHeaders.length; hc++) {
                    thCell(String.fromCharCode(65 + hc) + r, obsHeaders[hc], hc >= 7);
                }
                rowH(r, 28);
                r++;

                var itemNum = 0;
                for (var ci = 0; ci < obsRows.length; ci++) {
                    var obsRowEl = obsRows[ci];
                    itemNum++;
                    /* Excel export = visible form values. A "Same as Above"
                       row exports the literal "Same as Above" text the user
                       sees (including date placeholders), never the resolved
                       parent values. */
                    var obs = readVisibleObservationData(obsRowEl);
                    var st = ebStatusInfo(obs.status);

                    valueCell('A' + r, itemNum, { center: true, border: true });
                    valueCell('B' + r, obs.category || '', { wrap: true, border: true });
                    valueCell('C' + r, obs.processId || '', { wrap: true, border: true });
                    valueCell('D' + r, obs.description || '', { top: true, wrap: true, border: true });
                    valueCell('F' + r, obs.owner || '', { wrap: true, border: true });
                    valueCell('G' + r, st.label, { center: true, bold: true, fill: st.fill, border: true });
                    if (st.color) cellAt('G' + r).font.color = { argb: st.color };
                    valueCell('H' + r, obs.issueDate || '', { wrap: true, border: true });
                    valueCell('I' + r, obs.followUp || '', { top: true, wrap: true, border: true });
                    valueCell('J' + r, obs.targetDate || '', { wrap: true, border: true });
                    valueCell('K' + r, obs.completeDate || '', { wrap: true, border: true });
                    valueCell('L' + r, obs.supportDoc || '', { wrap: true, border: true });

                    var photoRec = obs.obsUid ? photoStore[obs.obsUid] : null;
                    var photos = (photoRec && photoRec.blob) ? [photoRec.blob] : [];

                    var obsH = Math.max(20,
                        wrapH(obs.description, 36, 12),
                        wrapH(obs.followUp, 26, 12),
                        wrapH(obs.supportDoc, 15, 12),
                        wrapH(obs.category, 10, 12),
                        wrapH(obs.processId, 14, 12),
                        wrapH(obs.owner, 11, 12));
                    if (photos.length > 0) {
                        var PHOTO_COL_PX = 130, PHOTO_ROW_PX = 90;
                        var COL_UNIT = 67, ROW_UNIT = 19;
                        var BOX_W = 122, BOX_H = 82, GAP = 4;
                        var thumbs = [];
                        for (var pmi = 0; pmi < photos.length; pmi++) {
                            var pb64 = await blobToBase64(photos[pmi]);
                            var pdim;
                            try { pdim = await imageSizeOf(pb64); }
                            catch (e) { pdim = { w: 4, h: 3 }; }
                            var scale = Math.min(BOX_W / pdim.w, BOX_H / pdim.h, 1);
                            thumbs.push({
                                imageId: workbook.addImage({ base64: pb64, extension: 'jpeg' }),
                                w: Math.max(1, Math.round(pdim.w * scale)),
                                h: Math.max(1, Math.round(pdim.h * scale))
                            });
                        }
                        var groupW = 0;
                        for (var tgi = 0; tgi < thumbs.length; tgi++) {
                            groupW += (tgi > 0 ? GAP : 0) + thumbs[tgi].w;
                        }
                        obsH = Math.max(obsH, 68);
                        rowH(r, obsH);
                        var rowPx = obsH * 4 / 3;
                        var xCursor = (PHOTO_COL_PX - groupW) / 2;
                        for (var ti = 0; ti < thumbs.length; ti++) {
                            worksheet.addImage(thumbs[ti].imageId, {
                                tl: {
                                    col: 4 + xCursor / COL_UNIT,
                                    row: r - 1 + Math.max(0, (rowPx - thumbs[ti].h) / 2 / ROW_UNIT)
                                },
                                ext: { width: thumbs[ti].w, height: thumbs[ti].h }
                            });
                            xCursor += thumbs[ti].w + GAP;
                        }
                        valueCell('E' + r, '', { center: true, border: true });
                    } else {
                        valueCell('E' + r, '—', { center: true, border: true });
                    }
                    rowH(r, obsH);
                    r++;
                }

                if (itemNum === 0) {
                    merge('A' + r, LAST_COL + r);
                    valueCell('A' + r, '(No observations recorded)', { center: true });
                    rowH(r, 18);
                    r++;
                }

                /* ---- 3. Build Result Summary ---- */
                r++; // spacer
                sectionBar(r, '3. Build Result Summary'); r++;
                // Horizontal KPI strip (label row + value row).
                var kpis = [
                    ['Actual Build Quantity', fieldValue('actualBuildQty') || '—'],
                    ['FOR', fieldValue('forRate') || '—'],
                    ['Bottleneck Cycle Time (s)', fieldValue('bottleneckCycleTime') || '—']
                ];
                var KPI_BLOCKS = [['A', 'D'], ['E', 'H'], ['I', 'L']];
                for (var kb = 0; kb < 3; kb++) {
                    merge(KPI_BLOCKS[kb][0] + r, KPI_BLOCKS[kb][1] + r);
                    var kl = cellAt(KPI_BLOCKS[kb][0] + r);
                    kl.value = kpis[kb][0];
                    kl.font = { name: FONT, size: 9, bold: true, color: { argb: 'FF0B3D91' } };
                    kl.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.light } };
                    kl.alignment = { vertical: 'middle', horizontal: 'center' };
                }
                rowH(r, 16);
                r++;
                for (var kv2 = 0; kv2 < 3; kv2++) {
                    merge(KPI_BLOCKS[kv2][0] + r, KPI_BLOCKS[kv2][1] + r);
                    var kvc = cellAt(KPI_BLOCKS[kv2][0] + r);
                    kvc.value = kpis[kv2][1];
                    kvc.font = { name: FONT, size: 13, bold: true, color: { argb: C.ink } };
                    kvc.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.derived } };
                    kvc.alignment = { vertical: 'middle', horizontal: 'center' };
                }
                rowH(r, 24);
                r++;

                // Overall comments (full width, wrapped).
                r = wideRow(r, 'Overall Comments & Remarks', fieldValue('commentsRemarks'));

                /* ---- Footer ---- */
                merge('A' + r, LAST_COL + r);
                var footCell = cellAt('A' + r);
                footCell.value = 'Engineering Build report generated ' + exportDate +
                    ' by NPI SnapWalk. Figures are exported exactly as entered in the form.';
                footCell.font = { name: FONT, size: 9, color: { argb: C.gray } };
                footCell.alignment = { vertical: 'top', horizontal: 'left', wrapText: true };
                rowH(r, 14);
                r++;

                /* ---- Column widths (A..L) ---- */
                var colWidths = [6, 12, 16, 40, 18, 13, 13, 11, 30, 11, 19, 19];
                for (var wci = 0; wci < colWidths.length; wci++) {
                    worksheet.getColumn(wci + 1).width = colWidths[wci];
                }

                /* ---- Layout, print and page setup ---- */
                worksheet.showGridLines = false;
                worksheet.properties.defaultRowHeight = 15;
                worksheet.pageSetup.orientation = 'landscape';
                worksheet.pageSetup.fitToPage = true;
                worksheet.pageSetup.fitToWidth = 1;
                worksheet.pageSetup.fitToHeight = 0;
                worksheet.pageSetup.paperSize = 9; // A4
                worksheet.pageSetup.horizontalCentered = true;
                worksheet.pageSetup.printArea = 'A1:' + LAST_COL + (r - 1);
                worksheet.pageSetup.printTitlesRow = '1:2';
                worksheet.pageMargins = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };

                var projName = (fieldValue('projectName') || 'Project').replace(/[^a-z0-9]/gi, '_');
                var buildId = (fieldValue('buildIdentity') || 'Build').replace(/[^a-z0-9]/gi, '_');
                var auditorRaw = fieldValue('visitorName').trim();
                var auditorName = auditorRaw ? auditorRaw.replace(/[^a-z0-9]/gi, '_') : '';
                var fileName = projName + '_' + buildId + '_Report' + (auditorName ? '_' + auditorName : '') + '.xlsx';

                var buffer = await workbook.xlsx.writeBuffer();
                var finalSizeMB = buffer.byteLength / (1024 * 1024);

                if (finalSizeMB > 20) {
                    var ok = confirm('Final file size: ' + finalSizeMB.toFixed(1) + ' MB.\nThis file is very large and may be difficult to share.\n\nProceed with download?');
                    if (!ok) {
                        exportBtn.innerText = "Export Build Report to Excel (.xlsx)";
                        exportBtn.disabled = false;
                        updateExportStats();
                        return;
                    }
                }

                saveAs(new Blob([buffer], { type: 'application/octet-stream' }), fileName);
            } catch (err) {
                alert("An error occurred while generating Excel: " + err.message);
                console.error(err);
            } finally {
                exportBtn.innerText = "Export Build Report to Excel (.xlsx)";
                exportBtn.disabled = false;
                updateExportStats();
            }
        }

        /* ============================================================
           ABOUT DIALOG
           ============================================================ */
        function showAbout() {
            var ebBody = document.getElementById('aboutBodyEb');
            var rnrBody = document.getElementById('aboutBodyRunRate');
            if (ebBody) ebBody.classList.toggle('hidden', appState.currentModule !== MODULES.EB_REPORT);
            if (rnrBody) rnrBody.classList.toggle('hidden', appState.currentModule !== MODULES.CAPACITY);
            document.getElementById('aboutDialog').classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }

        function closeAbout() {
            document.getElementById('aboutDialog').classList.add('hidden');
            document.body.style.overflow = '';
        }

        /* ============================================================
           SMART FACTORY IOT (FUTURE ROADMAP) INFO DIALOG
           ============================================================ */
        function openSmartFactoryInfo() {
            closeAppMenu();
            var dialog = document.getElementById('smartFactoryInfoDialog');
            if (!dialog) return;
            dialog.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }

        function closeSmartFactoryInfo() {
            var dialog = document.getElementById('smartFactoryInfoDialog');
            if (!dialog) return;
            dialog.classList.add('hidden');
            document.body.style.overflow = '';
        }

        function blobToBase64(blob) {
            return new Promise(function(resolve, reject) {
                var reader = new FileReader();
                reader.onload = function() { resolve(reader.result.split(',')[1]); };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
            });
        }

        /* ============================================================
           HAMBURGER NAVIGATION SHELL
           ============================================================ */
        function bindHamburgerMenu() {
            var btn = document.getElementById('appMenuBtn');
            var overlay = document.getElementById('appMenuOverlay');
            if (!btn || !overlay) return;
            btn.addEventListener('click', function(e) {
                e.preventDefault();
                openAppMenu();
            });
            overlay.addEventListener('click', function(e) {
                if (e.target === overlay) closeAppMenu();
            });
        }

        function openAppMenu() {
            var overlay = document.getElementById('appMenuOverlay');
            if (!overlay) return;
            overlay.classList.remove('hidden');
            document.body.style.overflow = 'hidden';
        }

        function closeAppMenu() {
            var overlay = document.getElementById('appMenuOverlay');
            if (!overlay) return;
            overlay.classList.add('hidden');
            document.body.style.overflow = '';
        }

        /* ============================================================
           MODULE SWITCHING (EB <-> Capacity)
           ============================================================ */
        function switchModule(moduleId) {
            if (moduleId !== MODULES.EB_REPORT && moduleId !== MODULES.CAPACITY) return;
            if (moduleId === appState.currentModule) {
                var openOverlay = document.getElementById('appMenuOverlay');
                if (openOverlay && !openOverlay.classList.contains('hidden')) closeAppMenu();
                return;
            }
            appState.currentModule = moduleId;
            appState.settings = appState.settings || {};
            appState.settings.lastModule = moduleId;
            saveAppState();
            renderMenuActiveState();
            renderModuleView();
            renderAppTitle();
            closeAppMenu();
            syncBarExport();
        }

        function renderModuleView() {
            var ebEl = document.getElementById('module-eb');
            var capEl = document.getElementById('module-capacity');
            var current = appState.currentModule;
            if (ebEl) ebEl.classList.toggle('hidden', current !== MODULES.EB_REPORT);
            if (capEl) capEl.classList.toggle('hidden', current !== MODULES.CAPACITY);
        }

        function renderMenuActiveState() {
            var ebItem = document.getElementById('ebMenuItem');
            var capItem = document.getElementById('capacityMenuItem');
            if (ebItem) ebItem.classList.toggle('app-menu-item-active', appState.currentModule === MODULES.EB_REPORT);
            if (capItem) capItem.classList.toggle('app-menu-item-active', appState.currentModule === MODULES.CAPACITY);
            var tabEb = document.getElementById('tabEb'), tabCap = document.getElementById('tabCapacity');
            if (tabEb) { tabEb.classList.toggle('active', appState.currentModule === MODULES.EB_REPORT); tabEb.setAttribute('aria-selected', String(appState.currentModule === MODULES.EB_REPORT)); }
            if (tabCap) { tabCap.classList.toggle('active', appState.currentModule === MODULES.CAPACITY); tabCap.setAttribute('aria-selected', String(appState.currentModule === MODULES.CAPACITY)); }
        }

        function barAddObservation() {
            addObservationCard();
        }

        function barExport() {
            var btn = document.getElementById(appState.currentModule === MODULES.CAPACITY ? 'rnrExportBtn' : 'exportBtn');
            if (!btn || btn.disabled) return;
            btn.click();
        }

        function barPhoto() {
            if (getTotalPhotoCount() >= MAX_TOTAL_PHOTOS) {
                alert('Photo limit reached: ' + MAX_TOTAL_PHOTOS + ' photos maximum per report.\nPlease remove an existing photo before adding a new one.');
                return;
            }
            var container = document.getElementById('observationContainer');
            var rows = container ? container.querySelectorAll('tr.obs-row-main') : [];
            var row = rows.length ? rows[rows.length - 1] : null;
            var reused = false;
            if (row) {
                var rowUid = row.dataset.obsUid;
                var descRow = row.nextElementSibling;
                var detail = document.getElementById('obs-detail-' + row.dataset.obsId);
                reused = !!rowUid && !photoStore[rowUid] && !photoMetaStore[rowUid] &&
                    !getVal(row, '.obs-category') && !getVal(row, '.obs-process-id') &&
                    !getVal(descRow, '.obs-description') &&
                    !getVal(detail, '.obs-followup') && !getVal(detail, '.obs-target-date') &&
                    !getVal(detail, '.obs-complete-date') && !getVal(detail, '.obs-support-doc');
            }
            if (!reused) {
                addObservationCardInternal(null);
                updateExportStats();
                saveDraftImmediate();
                updateAddButtons();
                row = document.getElementById('obs-row-' + obsCounter);
            }
            if (!row) return;
            var rowId = parseInt(row.dataset.obsId, 10);
            pendingBarRow = { obsId: rowId, uid: row.dataset.obsUid, created: !reused };
            row.scrollIntoView({ behavior: 'auto', block: 'center' });
            triggerPhotoInput(rowId);
        }

        function cleanupPendingBarRow() {
            if (!pendingBarRow || !pendingBarRow.created) { pendingBarRow = null; return; }
            var pending = pendingBarRow;
            pendingBarRow = null;
            var row = document.getElementById('obs-row-' + pending.obsId);
            if (!row || row.dataset.obsUid !== pending.uid) return;
            var descRow = row.nextElementSibling;
            var detail = document.getElementById('obs-detail-' + pending.obsId);
            var empty = !photoStore[pending.uid] && !photoMetaStore[pending.uid] &&
                !getVal(row, '.obs-category') && !getVal(row, '.obs-process-id') &&
                !getVal(descRow, '.obs-description') &&
                !getVal(detail, '.obs-followup') && !getVal(detail, '.obs-target-date') &&
                !getVal(detail, '.obs-complete-date') && !getVal(detail, '.obs-support-doc');
            if (!empty) return;
            var container = document.getElementById('observationContainer');
            if (!container || container.children.length <= 4) return;
            removeObservationCard(pending.obsId);
        }

        function barResetLine() {
            rnrClearActiveLine();
        }

        function barResetForm() {
            rnrClearEntireForm();
        }

        function syncBarExport() {
            var barBtn = document.getElementById('barExportBtn');
            if (!barBtn) return;
            var target = document.getElementById(appState.currentModule === MODULES.CAPACITY ? 'rnrExportBtn' : 'exportBtn');
            if (!target) return;
            var busy = /Generating/i.test(target.textContent || '');
            var disabled = !!target.disabled;
            barBtn.disabled = disabled;
            barBtn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
            var label = barBtn.querySelector('.bar-label');
            if (label) label.textContent = busy ? 'Exporting...' : 'Export Excel';
        }

        (function initBarExportMirror() {
            var targets = ['exportBtn', 'rnrExportBtn'].map(function(id) {
                return document.getElementById(id);
            }).filter(Boolean);
            if (typeof MutationObserver !== 'undefined') {
                var observer = new MutationObserver(function() { syncBarExport(); });
                targets.forEach(function(btn) {
                    observer.observe(btn, { attributes: true, attributeFilter: ['disabled'], childList: true, characterData: true, subtree: true });
                });
            }
            syncBarExport();
        })();



/* ============================================================
   RUN @ RATE CREATOR — V3 STATE COLLECTION, RENDER, PERSISTENCE
   ============================================================ */
var rnrState = {};          // holds input + computed per-line results
var rnrDebounceTimer = null;
var rnrSaveHideTimer = null;

/* ---------- V3 storage key ---------- */
const RUNRATE_DRAFT_KEY_V3 = STORAGE_PREFIX + '-draft-v3-run-rate';
const RUNRATE_DRAFT_KEY_V4 = STORAGE_PREFIX + '-draft-v4-run-rate';


/* ============================================================
   COLLECT: read shared fields + active line from the DOM into
   the persistent rnrState.input object.
   ============================================================ */
function rnrCollect() {
    var s = rnrState.input || (rnrState.input = rnrBlankInput());

    var p = s.project;
    // Only fields with a visible input are collected. Fields without a visible
    // Section 1 input (Product, 12NC, Supplier, Vendor, Site, Location, PO No.)
    // stay in state untouched so legacy drafts and the Excel export can use them.
    if (document.getElementById('rnrProjectName')) p.projectName = rnrVal('rnrProjectName') || '';
    if (document.getElementById('rnrBuildIdentity')) p.buildIdentity = rnrVal('rnrBuildIdentity') || '';
    if (document.getElementById('rnrBuildDate')) p.buildDate = rnrVal('rnrBuildDate') || '';
    if (document.getElementById('rnrAuditorName')) p.visitorName = rnrVal('rnrAuditorName') || '';
    if (document.getElementById('rnrFactoryLine')) p.factoryLine = rnrVal('rnrFactoryLine') || '';
    if (document.getElementById('rnrSpecialRemark')) p.specialRemark = rnrVal('rnrSpecialRemark') || '';

    var d = s.demand;
    // Service % stays removed. Vol Flex % and Seasonal % scale Base Dem/Wk into
    // Adj Dem/Wk, which drives every Machine check (DPV, Takt, Req CT, Plan Ratio).
    d.servicePercent = 0;
    if (document.getElementById('rnrVolumePct')) d.volumeFlexPercent = rnrVal('rnrVolumePct') || 0;
    if (document.getElementById('rnrSeasonalPct')) d.seasonalFlexPercent = rnrVal('rnrSeasonalPct') || 0;
    if (document.getElementById('rnrAnnualDemand')) d.annual = rnrVal('rnrAnnualDemand');
    if (document.getElementById('rnrCustomerWeeks')) d.customerWeeksPerYear = rnrVal('rnrCustomerWeeks');
    if (document.getElementById('rnrCustomerDays')) d.customerDaysPerWeek = rnrVal('rnrCustomerDays');
    // Annual-driven primary: Base Dem/Wk = Annual ÷ Wks/Yr is calculated and
    // read-only. A legacy weekly figure kept in state still computes when no
    // annual data is present.
    d.source = (d.annual !== null && d.annual > 0 && d.customerWeeksPerYear !== null && d.customerWeeksPerYear > 0)
        ? 'annual'
        : (d.enteredWeeklyDemand !== null && d.enteredWeeklyDemand > 0) ? 'weekly'
        : 'annual';

    if (s.activeLineIndex < s.lines.length) {
        s.lines[s.activeLineIndex] = rnrCollectActiveLine(s.lines[s.activeLineIndex] || rnrBlankLine());
    }

    var c = s.conclusion;
    c.reRunRequired = rnrVal('rnrReRunRequired') || '';
    c.summary = rnrVal('rnrSummaryConclusion') || '';
    return s;
}

function rnrCollectActiveLine(base) {
    var id = base.identity;
    id.processName = rnrVal('rnrProcessName') || '';
    id.location = rnrVal('rnrLocation') || '';
    var pi = base.plannedInputs;
    var op = pi.operating;
    op.shifts = rnrVal('rnrShiftsPerDay');
    op.hours = rnrVal('rnrHoursPerShift');
    op.breakMin = rnrVal('rnrBreakMin');
    op.maintMin = rnrVal('rnrMaintMin');
    op.prodDaysPerWeek = rnrVal('rnrOpWorkDays');
    op.prodWeeksPerYear = rnrVal('rnrOpWorkWeeks');
    var ls = pi.losses;
    ls.changeoverMin = rnrVal('rnrChangeoverMin');
    ls.manualChangeoversPerShift = rnrVal('rnrManualChangeovers');
    ls.inspectionMinPerShift = rnrVal('rnrInspMin');
    ls.breakdownMinPerShift = rnrVal('rnrBreakdownMin');
    ls.scrapPercent = rnrVal('rnrScrapPct');
    // V5: C/O per Shift is entered directly — no mix-derived changeover mode.
    ls.useCalculatedChangeovers = false;
    pi.mcpCycleTimeSeconds = rnrVal('rnrMcpCycleTime');
    var ai = base.actualInputs;
    ai.totalRunMinutes = rnrVal('rnrTotalRunMin');
    ai.actualBreakMinutes = rnrVal('rnrBreakMinActual');
    ai.actualChangeoverInspectionMinutes = rnrVal('rnrCOInspMinActual');
    ai.actualUnplannedMinutes = rnrVal('rnrUnplannedMin');
    ai.totalParts = rnrVal('rnrTotalParts');
    ai.rejectQuantity = rnrVal('rnrRejectParts');
    // Good Qty is derived, never collected from a user input.
    ai.firstPassGoodParts = (ai.totalParts !== null && ai.rejectQuantity !== null)
        ? Math.max(0, ai.totalParts - ai.rejectQuantity) : null;
    ai.rejectReason = rnrVal('rnrRejectReason') || '';
    ai.runNote = rnrVal('rnrRunNote') || '';
    var tr = base.tracking;
    tr.gapReason = rnrVal('rnrGapReasonActive') || '';
    tr.correctiveAction = rnrVal('rnrCorrectiveAction') || '';
    return base;
}

/* ============================================================
   PER-LINE CALCULATION ORCHESTRATION (reuses pure RunRateCalc)
   ============================================================ */
function rnrCalcLineObject(l, demand) {
    var planned = null, actual = null, run = null, comparison = null;
    if (!l) return { planned: null, actual: null, run: null, comparison: null };
    var pi = l.plannedInputs || {};
    var ai = l.actualInputs || {};

    var op = RunRateCalc.calcOperating({
        shifts: pi.operating && pi.operating.shifts,
        hours: pi.operating && pi.operating.hours,
        breakMin: pi.operating && pi.operating.breakMin,
        maintMin: pi.operating && pi.operating.maintMin,
        prodDaysPerWeek: pi.operating && pi.operating.prodDaysPerWeek,
        prodWeeksPerYear: pi.operating && pi.operating.prodWeeksPerYear
    });

    var mix = RunRateCalc.calcMix({
        totalSku: pi.mix && pi.mix.totalSku,
        skuQty: pi.mix && pi.mix.skuQty,
        shiftQty: pi.mix && pi.mix.shiftQty,
        shiftsPerDay: op.shiftsPerDay,
        prodDaysPerWeek: op.prodDaysPerWeek
    });

    var losses = RunRateCalc.calcLosses({
        changeoverMin: pi.losses && pi.losses.changeoverMin,
        inspectionMinPerShift: pi.losses && pi.losses.inspectionMinPerShift,
        breakdownMinPerShift: pi.losses && pi.losses.breakdownMinPerShift,
        scrapPercent: pi.losses && pi.losses.scrapPercent,
        manualChangeoversPerShift: pi.losses && pi.losses.manualChangeoversPerShift
    }, op);

    planned = RunRateCalc.calcPlannedCapacity(
        { mcpCycleTimeSeconds: pi.mcpCycleTimeSeconds }, op, losses, demand);

    run = RunRateCalc.calcActualRun({
        totalRunMinutes: ai.totalRunMinutes,
        actualBreakMinutes: ai.actualBreakMinutes,
        actualChangeoverInspectionMinutes: ai.actualChangeoverInspectionMinutes,
        actualUnplannedMinutes: ai.actualUnplannedMinutes,
        totalParts: ai.totalParts,
        rejectQuantity: ai.rejectQuantity,
        firstPassGoodParts: ai.firstPassGoodParts
    });

    actual = RunRateCalc.calcActualResults(run, op, demand, pi.mcpCycleTimeSeconds,
        planned ? planned.plannedCapacityRatio : null);

    comparison = RunRateCalc.calcComparison(planned, run, actual, demand);

    return { op: op, mix: mix, losses: losses, planned: planned, run: run, actual: actual, comparison: comparison };
}

function rnrComputeAll() {
    var in0 = rnrState.input;
    var demandInput = in0.demand;
    // No 'dpv' source in V4. Demand uses annual or weekly on the customer calendar.
    var demand = RunRateCalc.calcDemand(demandInput);
    var lineObjs = [null, null, null, null, null];
    for (var i = 0; i < in0.enabledLineCount; i++) {
        lineObjs[i] = rnrCalcLineObject(in0.lines[i], demand);
    }
    return { demand: demand, lines: lineObjs };
}

/* ============================================================
   RENDER — demand strip, tabs, active editor, conclusion
   ============================================================ */
function rnrRender() {
    // Build the active editor only when the active line changed (or absent).
    // On routine input renders we must NOT rebuild, or the focused field and
    // the user's typing would be clobbered.
    rnrEnsureEditor(rnrState.input);
    var in0 = rnrCollect();
    var computed = rnrComputeAll();
    rnrState.demand = computed.demand;
    rnrState.lines = computed.lines;
    rnrRenderDemand(computed.demand);
    rnrRenderTabs(in0);
    rnrRenderActiveResults(computed.lines[in0.activeLineIndex]);
    rnrRenderConclusion(in0);
    rnrRenderCapacitySummary(in0);
}

/* Build/populate the active-line editor only when needed (first render or
   the active line index changed). Returns true if it (re)built the editor. */
function rnrEnsureEditor(input) {
    var wrap = document.getElementById('rnrActiveEditor');
    if (!wrap || !input) return false;
    var idx = input.activeLineIndex;
    if (wrap.getAttribute('data-active') === String(idx) && wrap.childNodes.length) {
        return false;
    }
    rnrBuildEditorInto(wrap, input, idx);
    return true;
}

/* Write shared project/demand/conclusion state into the static DOM
   inputs (used when restoring a draft before rnrRender collects). */
function rnrApplySharedToDOM(input) {
    var p = input.project;
    var s = function(id, val) { var el = document.getElementById(id); if (el && val !== undefined && val !== null && val !== '') el.value = val; };
    s('rnrProjectName', p.projectName);
    s('rnrBuildIdentity', p.buildIdentity);
    s('rnrBuildDate', p.buildDate);
    s('rnrAuditorName', p.visitorName);
    s('rnrFactoryLine', p.factoryLine);
    s('rnrSpecialRemark', p.specialRemark);
    var d = input.demand;
    s('rnrAnnualDemand', d.annual);
    s('rnrCustomerWeeks', d.customerWeeksPerYear);
    s('rnrCustomerDays', d.customerDaysPerWeek);
    s('rnrVolumePct', d.volumeFlexPercent);
    s('rnrSeasonalPct', d.seasonalFlexPercent);
    var c = input.conclusion;
    s('rnrReRunRequired', c.reRunRequired);
    s('rnrSummaryConclusion', c.summary);
    var sel = document.getElementById('rnrLineCountSelect');
    if (sel) sel.value = String(input.enabledLineCount || 1);
}

function rnrRenderDemand(d) {
    var wkCalc = document.getElementById('rnrDemandWkCalc');
    if (wkCalc) wkCalc.value = (d.baseDemandPerWeek != null) ? rnrFmt(d.baseDemandPerWeek, 0) : '—';
    var adjCalc = document.getElementById('rnrAdjDemWkCalc');
    if (adjCalc) adjCalc.value = (d.adjustedDemandPerWeek != null) ? rnrFmt(d.adjustedDemandPerWeek, 0) : '—';
    var dpvCalc = document.getElementById('rnrDpvCalc');
    if (dpvCalc) dpvCalc.value = rnrFmt(d.dpv, 1);
}

/* ---------- Active line editor template ---------- */
function rnrLineName(input, i) {
    return (input.lines[i] && input.lines[i].identity && input.lines[i].identity.processName)
        ? input.lines[i].identity.processName : '';
}
function rnrActiveEditorTemplate(lineNo) {
    return [
    '<div class="rnr-sect-label">Line Identity</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell text"><label title="System line identifier">Line</label><div class="rnr-in rnr-static">Line ' + (lineNo + 1) + '</div></div>',
      '<div class="rnr-cell text"><label title="Process / Name (e.g. Final Assembly, Line 1)">Process / Name</label><div class="rnr-in"><input type="text" id="rnrProcessName"></div></div>',
      '<div class="rnr-cell text"><label title="Line Location">Location</label><div class="rnr-in"><input type="text" id="rnrLocation"></div></div>',
    '</div>',

    '<div class="rnr-stage rnr-stage-planned">',
    '<div class="panel-title">3.1 Planned Capacity</div>',
    '<div class="rnr-sect-label">Operating (production calendar)</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell"><label title="Shifts per Day">Shifts <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrShiftsPerDay" min="0" step="0.1"><span class="rnr-unit">#</span></div></div>',
      '<div class="rnr-cell"><label title="Total Hours per Shift">Hrs/Shift <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrHoursPerShift" min="0" step="0.1"><span class="rnr-unit">h</span></div></div>',
      '<div class="rnr-cell"><label title="Lunch and Breaks per Shift">Break <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrBreakMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
    '</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell"><label title="Planned Maintenance per Shift">Maint <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrMaintMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
      '<div class="rnr-cell"><label title="Production Days per Week">Prod Days/Wk <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrOpWorkDays" min="0" step="0.1"><span class="rnr-unit">d</span></div></div>',
      '<div class="rnr-cell"><label title="Production Weeks per Year">Prod Wks/Yr <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrOpWorkWeeks" min="0" step="0.1"><span class="rnr-unit">wk</span></div></div>',
    '</div>',
    '<div class="rnr-sect-label">Planned Losses</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell"><label title="Changeover Time (minutes per changeover)">C/O Time</label><div class="rnr-in"><input type="number" id="rnrChangeoverMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
      '<div class="rnr-cell"><label title="Average Changeovers per Shift">C/O per Shift</label><div class="rnr-in"><input type="number" id="rnrManualChangeovers" min="0" step="any"><span class="rnr-unit">#</span></div></div>',
      '<div class="rnr-cell"><label title="Inspections per Shift">Insp</label><div class="rnr-in"><input type="number" id="rnrInspMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
    '</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell"><label title="Breakdown / Unscheduled Downtime per Shift">Breakdown</label><div class="rnr-in"><input type="number" id="rnrBreakdownMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
      '<div class="rnr-cell"><label title="Expected Scrap and Rework Rate">Scrap %</label><div class="rnr-in"><input type="number" id="rnrScrapPct" min="0" max="100" step="0.1"><span class="rnr-unit">%</span></div></div>',
      '<div class="rnr-cell"><label title="Machine design cycle time committed for this line">Machine CT</label><div class="rnr-in"><input type="number" id="rnrMcpCycleTime" min="0" step="0.1"><span class="rnr-unit">s</span></div></div>',
    '</div>',
    '<div id="rnrPlannedTrace" class="rnr-oee-calc"></div>',
    '<div id="rnrPlannedRes" class="rnr-out"></div>',
    '</div>',

    '<div class="rnr-stage rnr-stage-actual">',
    '<div class="panel-title">3.2 Actual Run</div>',
    '<div class="rnr-sect-label">Actual Run Inputs</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell"><label title="Total run duration">Run Min <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrTotalRunMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
      '<div class="rnr-cell"><label title="Actual planned break + maintenance during run">Break Min <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrBreakMinActual" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
      '<div class="rnr-cell"><label title="Actual changeover, setup, inspection downtime">C/O+Insp <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrCOInspMinActual" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
    '</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell"><label title="Actual unplanned downtime">Unpl Min <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrUnplannedMin" min="0" step="1"><span class="rnr-unit">min</span></div></div>',
      '<div class="rnr-cell"><label title="Total parts produced">Parts <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrTotalParts" min="0" step="1"><span class="rnr-unit">pcs</span></div></div>',
      '<div class="rnr-cell"><label title="Rejected parts">Reject <span class="req">*</span></label><div class="rnr-in"><input type="number" id="rnrRejectParts" min="0" step="1"><span class="rnr-unit">pcs</span></div></div>',
    '</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-kpi" title="Good Qty = Parts Produced − Reject Qty"><span class="rnr-kpi-label">Good Qty</span><span class="rnr-kpi-value" id="rnrGoodQtyKpi">—</span></div>',
      '<div class="rnr-kpi" title="Quality = Good Qty ÷ Parts Produced"><span class="rnr-kpi-label">Quality</span><span class="rnr-kpi-value" id="rnrQualityKpi">—</span></div>',
      '<div class="rnr-cell"></div>',
    '</div>',
    '<div class="rnr-cells wide">',
      '<div class="rnr-cell text wide"><label title="Reason for Rejections">Reject Reason</label><textarea id="rnrRejectReason" rows="2" placeholder="Describe rejection causes..."></textarea></div>',
      '<div class="rnr-cell text wide"><label title="Run Observation / Comment">Run Note</label><textarea id="rnrRunNote" rows="2" placeholder="Trial observations..."></textarea></div>',
    '</div>',
    '<div id="rnrRunVal" class="rnr-validation"></div>',
    '</div>',

    '<div class="rnr-stage rnr-stage-compare">',
    '<div class="panel-title">3.3 Capacity Gap Analysis</div>',
    '<div id="rnrCompareRes"></div>',
    '<div class="rnr-sect-label">Gap Tracking (fill when a gap is detected)</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell text wide"><label title="Observed cause of any gap">Gap Reason</label><div class="rnr-in"><input type="text" id="rnrGapReasonActive" placeholder="Observed cause..."></div></div>',
    '</div>',
    '<div class="rnr-cells">',
      '<div class="rnr-cell text wide"><label title="Corrective action to close the gap">Corrective Action</label><div class="rnr-in"><input type="text" id="rnrCorrectiveAction" placeholder="Action..."></div></div>',
    '</div>',
    '</div>'
    ].join('\n');
}

function rnrRenderTabs(input) {
    var wrap = document.getElementById('rnrLineTabs');
    if (!wrap) return;
    var html = '';
    for (var i = 0; i < 5; i++) {
        var enabled = (i < input.enabledLineCount);
        if (enabled) {
            var active = (i === input.activeLineIndex);
            var nm = rnrLineName(input, i);
            html += '<button type="button" class="rnr-tab' + (active ? ' active' : '') + '" onclick="rnrSelectLine(' + i + ')">Line ' + (i + 1) + (nm ? ' &middot; ' + nm : '') + '</button>';
        } else {
            html += '<button type="button" class="rnr-tab disabled">Line ' + (i + 1) + '</button>';
        }
    }
    wrap.innerHTML = html;
}

function rnrBuildEditorInto(wrap, input, idx) {
    var line = input.lines[idx];
    // Build the editor into a detached host first, then swap it in atomically.
    // This prevents a browser change/input event (fired when the focused input
    // is destroyed by the swap) from re-entering rnrCollect mid-build, which
    // would otherwise leak the previous line's DOM values into the new line.
    // Values are written as attributes so they survive serialization into the
    // live DOM (element.value properties do not serialize into innerHTML).
    var host = document.createElement('div');
    host.innerHTML = rnrActiveEditorTemplate(idx);
    var set = function(id, val) {
        if (val === null || val === undefined) return;
        var el = host.querySelector('#' + id);
        if (!el) return;
        if (el.tagName === 'SELECT') {
            var esc = String(val).replace(/"/g, '&quot;');
            var opt = el.querySelector('option[value="' + esc + '"]');
            if (opt) opt.setAttribute('selected', 'selected');
        } else if (el.tagName === 'TEXTAREA') {
            el.textContent = String(val);
        } else {
            el.setAttribute('value', String(val));
        }
    };
    var idt = line.identity;
    set('rnrProcessName', idt.processName); set('rnrLocation', idt.location);
    var op = line.plannedInputs.operating;
    set('rnrShiftsPerDay', op.shifts); set('rnrHoursPerShift', op.hours);
    set('rnrBreakMin', op.breakMin); set('rnrMaintMin', op.maintMin);
    set('rnrOpWorkDays', op.prodDaysPerWeek); set('rnrOpWorkWeeks', op.prodWeeksPerYear);
    var ls = line.plannedInputs.losses;
    set('rnrChangeoverMin', ls.changeoverMin); set('rnrManualChangeovers', ls.manualChangeoversPerShift);
    set('rnrInspMin', ls.inspectionMinPerShift);
    set('rnrBreakdownMin', ls.breakdownMinPerShift); set('rnrScrapPct', ls.scrapPercent);
    set('rnrMcpCycleTime', line.plannedInputs.mcpCycleTimeSeconds);
    var ai = line.actualInputs;
    set('rnrTotalRunMin', ai.totalRunMinutes); set('rnrBreakMinActual', ai.actualBreakMinutes);
    set('rnrCOInspMinActual', ai.actualChangeoverInspectionMinutes); set('rnrUnplannedMin', ai.actualUnplannedMinutes);
    set('rnrTotalParts', ai.totalParts); set('rnrRejectParts', ai.rejectQuantity);
    set('rnrRejectReason', ai.rejectReason); set('rnrRunNote', ai.runNote);
    var tr = line.tracking;
    set('rnrGapReasonActive', tr.gapReason); set('rnrCorrectiveAction', tr.correctiveAction);
    // Mark the target before swapping so any re-entrant render keeps the new
    // active line instead of rebuilding (and observing) a half-built editor.
    wrap.setAttribute('data-active', String(idx));
    wrap.innerHTML = host.innerHTML;
}

function rnrRenderActiveResults(computedLine) {
    var line = rnrState.input.lines[rnrState.input.activeLineIndex];
    rnrRenderLineResults(line, computedLine);
}

function rnrRenderLineResults(line, cl) {
    if (!cl) return;
    var v = rnrFmt, rate = rnrFmtRate;

    /* Machine Planned baseline (read-only, system generated). */
    var planRes = document.getElementById('rnrPlannedRes');
    if (planRes && cl.planned) {
        var p = cl.planned;
        // Compact Machine baseline: only the most decision-relevant planned results.
        // Full A/P/Q/OEE and capacity detail is shown in the Planned vs Actual table.
        planRes.innerHTML =
            '<div class="rnr-oee-title cap">CAPACITY CHECK</div>' +
            '<div class="rnr-val small">Customer Takt<b>' + v(p.customerTaktSeconds, 0) + 's</b></div>' +
            '<div class="rnr-val small">Required CT<b>' + v(p.requiredCycleTimeSeconds, 1) + 's</b></div>' +
            '<div class="rnr-val small">Machine CT<b>' + v(p.mcpCycleTimeSeconds, 1) + 's</b></div>' +
            '<div class="rnr-val small">Plan/Wk<b>' + v(p.plannedCapacityPerWeek, 0) + '</b></div>' +
            '<div class="rnr-val small">Plan Ratio<b>' + v(p.plannedCapacityRatio, 2) + '</b></div>';
    }

    /* Machine Planned OEE — official time-loss cascade from the OEE template.
       Planned Production Time = scheduled − break − maintenance.
       Operating Time = PPT − changeover − inspection − breakdown.
       No separate planned P-loss input ⇒ Net Operating Time = Operating Time
       and OEE-P = 100%. Scrap reduces Net Operating to Fully Productive Time,
       so OEE-Q = 1 − Scrap%. Projected OEE = OEE-A × OEE-P × OEE-Q. */
    var planTrace = document.getElementById('rnrPlannedTrace');
    if (planTrace && cl.planned && cl.op && cl.losses) {
        var p2 = cl.planned, ls = cl.losses;
        var ppt = cl.op.netAvailableHoursPerWeek;
        var opt = p2.effectiveProductionHoursPerWeek;
        var h = '<div class="rnr-oee-title">OEE CALCULATION</div>';
        if (ppt > 0 && opt !== null && opt > 0) {
            var fpt = opt * p2.plannedQuality;
            h += '<div class="rnr-oee-row"><span>Planned Production Time</span><b>' + rnrFmt(ppt, 1) + ' h/wk</b></div>';
            h += '<div class="rnr-oee-row"><span>Operating Time</span><b>' + rnrFmt(opt, 1) + ' h/wk</b></div>';
            h += '<div class="rnr-oee-row fx"><span>OEE-A</span><code>' + rnrFmt(opt, 1) + ' ÷ ' + rnrFmt(ppt, 1) + ' = ' + rate(ls.plannedAvailability) + '</code></div>';
            h += '<div class="rnr-oee-row"><span>Net Operating Time</span><b>' + rnrFmt(opt, 1) + ' h/wk</b></div>';
            h += '<div class="rnr-oee-row fx"><span>OEE-P</span><code>' + rnrFmt(opt, 1) + ' ÷ ' + rnrFmt(opt, 1) + ' = ' + rate(p2.plannedPerformance) + '</code></div>';
            h += '<div class="rnr-oee-note">No planned performance-loss input — Net Operating Time = Operating Time.</div>';
            h += '<div class="rnr-oee-row"><span>Fully Productive Time</span><b>' + rnrFmt(fpt, 1) + ' h/wk</b></div>';
            h += '<div class="rnr-oee-row fx"><span>OEE-Q</span><code>' + rnrFmt(fpt, 1) + ' ÷ ' + rnrFmt(opt, 1) + ' = ' + rate(ls.plannedQuality) + '</code></div>';
            h += '<div class="rnr-oee-row result"><span>PROJECTED OEE</span><code>' + rate(ls.plannedAvailability) + ' × ' + rate(p2.plannedPerformance) + ' × ' + rate(ls.plannedQuality) + ' = ' + rate(p2.projectedOee) + '</code></div>';
        } else {
            h += '<div class="rnr-oee-note">Enter the operating pattern and planned losses to calculate projected OEE.</div>';
        }
        planTrace.innerHTML = h;
    }

    /* Good Qty / Quality KPI cards (derived, system generated).
       These stay in Section 4 because they are direct arithmetic on the
       entered run data. Every other calculated performance metric is shown
       once, in Process Section Capacity Gap Analysis. */
    var aiDisp = line.actualInputs || {};
    var hasParts = (aiDisp.totalParts !== null && aiDisp.totalParts !== undefined);
    var hasReject = (aiDisp.rejectQuantity !== null && aiDisp.rejectQuantity !== undefined);
    var goodKpi = document.getElementById('rnrGoodQtyKpi');
    if (goodKpi) {
        goodKpi.innerHTML = (hasParts && hasReject)
            ? v(Math.max(0, aiDisp.totalParts - aiDisp.rejectQuantity), 0) + '<span class="rnr-unit">pcs</span>'
            : '—';
    }
    var qualityKpi = document.getElementById('rnrQualityKpi');
    if (qualityKpi) {
        qualityKpi.innerHTML = (hasParts && hasReject && cl.run && cl.run.totalParts > 0)
            ? rate(cl.run.actualQuality) : '—';
    }

    /* Planned vs Actual comparison (read-only, system generated).
       Process Section is the single management view: Required vs Achieved vs Gap.
       Facts only — no Check column, no PASS/FAIL interpretation. */
    var cmp = document.getElementById('rnrCompareRes');
    if (cmp && cl.comparison) {
        var c = cl.comparison;
        var demC = rnrState.demand || {};
        var hasDpv = demC.dpv !== null && demC.dpv !== undefined && isFinite(demC.dpv);
        var hasDemWk = demC.adjustedDemandPerWeek !== null && demC.adjustedDemandPerWeek !== undefined && isFinite(demC.adjustedDemandPerWeek);
        var dpvReq = hasDpv ? rnrCompact(demC.dpv, 0) : '—';
        var demWkReq = hasDemWk ? rnrCompact(demC.adjustedDemandPerWeek, 0) : '—';
        var dpvGap = (hasDpv && cl.actual.actualShipPerDay !== null) ? rnrCompactSigned(cl.actual.actualShipPerDay - demC.dpv, 0) : '—';
        var demWkGap = (hasDemWk && cl.actual.actualShipPerWeek !== null) ? rnrCompactSigned(cl.actual.actualShipPerWeek - demC.adjustedDemandPerWeek, 0) : '—';
        // Single optional data-quality statement, only when demonstrated
        // performance exceeds the Machine design pace (>100%).
        var flagNote = cl.actual.reviewFlag
            ? '<div class="rnr-val-warn">⚠ Actual Performance &gt;100% — ' + cl.actual.reviewFlag + '</div>' : '';
        cmp.innerHTML =
            '<div class="rnr-comp-wrap">' +
            '<table class="rnr-comp-table">' +
            '<thead><tr><th>Metric</th><th>Machine</th><th>Actual</th><th>Gap</th></tr></thead>' +
            '<tbody>' +
            '<tr><td>DPV</td><td>' + dpvReq + '</td><td>' + rnrCompact(cl.actual.actualShipPerDay, 0) + '</td><td' + rnrGapAttr('supply', cl.actual.actualShipPerDay !== null ? cl.actual.actualShipPerDay - demC.dpv : null, demC.dpv) + '>' + dpvGap + '</td></tr>' +
            '<tr><td>Dem/Wk</td><td>' + demWkReq + '</td><td>' + rnrCompact(cl.actual.actualShipPerWeek, 0) + '</td><td' + rnrGapAttr('supply', cl.actual.actualShipPerWeek !== null ? cl.actual.actualShipPerWeek - demC.adjustedDemandPerWeek : null, demC.adjustedDemandPerWeek) + '>' + demWkGap + '</td></tr>' +
            '<tr><td>CT</td><td>' + rnrCompact(cl.planned.mcpCycleTimeSeconds, 1) + '</td><td>' + rnrCompact(cl.run.actualCycleTimeSeconds, 1) + '</td><td' + rnrGapAttr('ct', c.cycleTimeGapSeconds, cl.planned.mcpCycleTimeSeconds) + '>' + rnrCompactSigned(c.cycleTimeGapSeconds, 1, 's') + '</td></tr>' +
            '<tr><td>OEE-A</td><td>' + rnrCompactPct(cl.planned.plannedAvailability) + '</td><td>' + rnrCompactPct(cl.run.actualAvailability) + '</td><td' + rnrGapAttr('oee', c.availabilityGapPoints, 1) + '>' + rnrCompactPoints(c.availabilityGapPoints) + '</td></tr>' +
            '<tr><td>OEE-P</td><td>' + rnrCompactPct(cl.planned.plannedPerformance) + '</td><td>' + rnrCompactPct(cl.actual.actualPerformance) + '</td><td' + rnrGapAttr('oee', c.performanceGapPoints, 1) + '>' + rnrCompactPoints(c.performanceGapPoints) + '</td></tr>' +
            '<tr><td>OEE-Q</td><td>' + rnrCompactPct(cl.planned.plannedQuality) + '</td><td>' + rnrCompactPct(cl.run.actualQuality) + '</td><td' + rnrGapAttr('oee', c.qualityGapPoints, 1) + '>' + rnrCompactPoints(c.qualityGapPoints) + '</td></tr>' +
            '<tr><td>OEE</td><td>' + rnrCompactPct(cl.planned.projectedOee) + '</td><td>' + rnrCompactPct(cl.actual.actualOee) + '</td><td' + rnrGapAttr('oee', c.oeeGapPoints, 1) + '>' + rnrCompactPoints(c.oeeGapPoints) + '</td></tr>' +
            '<tr><td>Ratio</td><td>' + rnrCompact(cl.planned.plannedCapacityRatio, 2) + '</td><td>' + rnrCompact(cl.actual.actualCapacityRatio, 2) + '</td><td' + rnrGapAttr('supply', c.capacityGapPercent, 1) + '>' + rnrCompactSignedPct(c.capacityGapPercent) + '</td></tr>' +
            '</tbody></table></div>' + flagNote;
    }

    var val = document.getElementById('rnrRunVal');
    if (val) {
        var msgs = [];
        (cl.run.validationErrors || []).forEach(function(m){ msgs.push('<div class="rnr-val-error">' + m + '</div>'); });
        (cl.run.validationWarnings || []).forEach(function(m){ msgs.push('<div class="rnr-val-warn">' + m + '</div>'); });
        (cl.op.validationErrors || []).forEach(function(m){ msgs.push('<div class="rnr-val-error">' + m + '</div>'); });
        if (!msgs.length && cl.planned && cl.planned.plannedAvailableHoursPerWeek > 0 &&
            (cl.planned.customerTaktSeconds === null || cl.planned.customerTaktSeconds === undefined || !isFinite(cl.planned.customerTaktSeconds))) {
            msgs.push('<div class="rnr-val-warn">Enter adjusted demand to calculate Customer Takt.</div>');
        }
        val.innerHTML = msgs.join('');
    }
}


function rnrRenderConclusion(input) {
    var c = input.conclusion;
    var set = function(id, val){ var el = document.getElementById(id); if (el && val !== undefined && val !== null) el.value = val; };
    set('rnrReRunRequired', c.reRunRequired);
    set('rnrSummaryConclusion', c.summary);
}

/* Capacity status — factual, decision-friendly wording only. */
function rnrCapacityStatus(shipWk, demandWk) {
    if (shipWk === null || shipWk === undefined || !isFinite(shipWk) ||
        demandWk === null || demandWk === undefined || !isFinite(demandWk) || demandWk <= 0) {
        return { label: '—', cls: 'empty' };
    }
    if (shipWk >= demandWk) return { label: 'Achieved', cls: 'good' };
    if (shipWk < 0.8 * demandWk) return { label: 'Major Gap', cls: 'major' };
    return { label: 'Gap', cls: 'warn' };
}

function rnrEscapeHtml(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function(ch) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch];
    });
}

function rnrRenderCapacitySummary(input) {
    var wrap = document.getElementById('rnrCapacitySummary');
    if (!wrap) return;
    var dm = rnrState.demand || {};
    var demandWk = (dm.adjustedDemandPerWeek !== null && dm.adjustedDemandPerWeek !== undefined)
        ? dm.adjustedDemandPerWeek : null;
    var statusEmoji = { good: '✅', warn: '🟠', major: '🔴', empty: '' };
    var html = '<div class="rnr-cap-lines">';
    for (var i = 0; i < input.enabledLineCount; i++) {
        var lo = rnrState.lines[i];
        var ln = input.lines[i];
        var nm = rnrLineName(input, i) || ('Line ' + (i + 1));
        var planWk = (lo && lo.planned && lo.planned.plannedCapacityPerWeek !== null)
            ? Math.round(lo.planned.plannedCapacityPerWeek) : null;
        var shipWk = (lo && lo.actual && lo.actual.actualShipPerWeek !== null)
            ? Math.round(lo.actual.actualShipPerWeek) : null;
        var st = rnrCapacityStatus(shipWk, demandWk);
        var pill = (st.cls === 'empty') ? '—' : (statusEmoji[st.cls] + ' ' + st.label);
        html += '<div class="rnr-cap-line">' +
            '<div class="rnr-cap-line-name">L' + (i + 1) + ' ' + rnrEscapeHtml(nm) + '</div>' +
            '<div class="rnr-cap-grid">' +
            '<div class="rnr-cap-col"><span class="rnr-cap-label">Demand</span><b class="rnr-cap-value">' + rnrFmt(demandWk, 0) + '</b></div>' +
            '<div class="rnr-cap-col"><span class="rnr-cap-label">Plan</span><b class="rnr-cap-value">' + rnrFmt(planWk, 0) + '</b></div>' +
            '<div class="rnr-cap-col"><span class="rnr-cap-label">Actual</span><b class="rnr-cap-value">' + rnrFmt(shipWk, 0) + '</b></div>' +
            '<div class="rnr-cap-col"><span class="rnr-cap-label">Status</span><span class="rnr-summary-status ' + st.cls + '">' + pill + '</span></div>' +
            '</div>' +
            '</div>';
    }
    wrap.innerHTML = html + '</div>';
}
/* ============================================================
   RUN @ RATE CREATOR — LINE MANAGEMENT ACTIONS
   ============================================================ */
function rnrSetLineCount(n) {
    if (!rnrState.input) rnrState.input = rnrBlankInput();
    n = Math.max(1, Math.min(5, n));
    rnrState.input.enabledLineCount = n;
    if (rnrState.input.activeLineIndex >= n) rnrState.input.activeLineIndex = n - 1;
    rnrRender();
    saveRunRateDraftV3();
}

function rnrSelectLine(i) {
    if (!rnrState.input || i >= rnrState.input.enabledLineCount) return;
    rnrState.input.activeLineIndex = i;
    rnrRender();
    saveRunRateDraftV3();
}

function rnrClearSharedDOM() {
    var sharedIds = ['rnrProjectName','rnrBuildIdentity','rnrBuildDate','rnrAuditorName','rnrFactoryLine','rnrSpecialRemark',
        'rnrAnnualDemand','rnrCustomerWeeks','rnrCustomerDays','rnrVolumePct','rnrSeasonalPct',
        'rnrReRunRequired','rnrSummaryConclusion'];
    sharedIds.forEach(function(id){ var el = document.getElementById(id); if (el) el.value = ''; });
}

function rnrForceEditorRebuild() {
    var wrap = document.getElementById('rnrActiveEditor');
    if (wrap) wrap.removeAttribute('data-active');
}

function rnrClearActiveLine() {
    if (!window.confirm('Clear only the active line (' + (rnrState.input.activeLineIndex+1) + ')? Project and other lines are kept.')) return;
    rnrState.input.lines[rnrState.input.activeLineIndex] = rnrBlankLine();
    rnrForceEditorRebuild();
    rnrRender();
    saveRunRateDraftV3();
}

function rnrClearEntireForm() {
    if (!window.confirm('Clear ALL Run @ Rate data (project, demand, all lines, conclusion)? This cannot be undone. EB Report data is untouched.')) return;
    try { localStorage.removeItem(RUNRATE_DRAFT_KEY_V4); } catch (e) {}
    try { localStorage.removeItem(RUNRATE_DRAFT_KEY_V3); } catch (e) {}
    try { localStorage.removeItem(RUNRATE_DRAFT_KEY); } catch (e) {}
    rnrState.input = rnrBlankInput();
    rnrClearSharedDOM();
    rnrForceEditorRebuild();
    try { document.getElementById('rnrBuildDate').value = new Date().toISOString().slice(0,10); } catch(e){}
    rnrRender();
    saveRunRateDraftV3();
    showRnrExportStatus('Form cleared.', 'info');
}

/* ============================================================
   RUN @ RATE CREATOR — WIRE UP + INIT
   ============================================================ */
function recalcRunRate() {
    // called on any input; re-uses DOM collection + render
    rnrRender();
    saveRunRateDraftV3Debounced();
}

function rnrRenderAllUI() {
    rnrRender();
}

function initRunRateModule() {
    var dateEl = document.getElementById('rnrBuildDate');
    if (dateEl && !dateEl.value) dateEl.value = new Date().toISOString().slice(0, 10);
    rnrState.input = restoreRunRateDraftV3() || rnrBlankInput();
    rnrApplySharedToDOM(rnrState.input);
    bindRunRateListenersV3();
    rnrRender();
}

function bindRunRateListenersV3() {
    var form = document.getElementById('rnrForm');
    if (!form) return;
    form.addEventListener('input', function(e) {
        if (e.target) recalcRunRate();
    });
    form.addEventListener('change', function(e) {
        recalcRunRate();
        saveRunRateDraftV3();
    });
}

/* ============================================================
   RUN @ RATE CREATOR — PERSISTENCE V3 + MIGRATION
   ============================================================ */
function collectRunRateStateV3() {
    // ensure active line is collected before serializing
    var in0 = rnrCollect();
    return { version: 4, timestamp: new Date().toISOString(), ...in0 };
}

function saveRunRateDraftV3() {
    try {
        var in0 = rnrCollect();
        var payload = {
            version: 4,
            timestamp: new Date().toISOString(),
            enabledLineCount: in0.enabledLineCount,
            activeLineIndex: in0.activeLineIndex,
            project: in0.project,
            demand: in0.demand,
            lines: in0.lines,
            conclusion: in0.conclusion,
            migrationReview: in0.migrationReview || []
        };
        localStorage.setItem(RUNRATE_DRAFT_KEY_V4, JSON.stringify(payload));
        var status = document.getElementById('rnrDraftStatus');
        if (status) {
            status.textContent = 'Draft saved automatically.';
            status.classList.remove('hidden');
            rnrSaveHideTimer && clearTimeout(rnrSaveHideTimer);
            rnrSaveHideTimer = setTimeout(function(){ status.classList.add('hidden'); }, 2200);
        }
    } catch (e) { console.warn('Run@Rate draft save failed:', e.message); }
}

function saveRunRateDraftV3Debounced() {
    clearTimeout(rnrDebounceTimer);
    rnrDebounceTimer = setTimeout(saveRunRateDraftV3, 400);
}


/* V4 restore + migration from V3 (and V2). Never touch EB Report storage. */
function restoreRunRateDraftV3() {
    var payload = null;
    var migrationNotes = [];

    // 1) Try the V4 storage key.
    try {
        var raw4 = localStorage.getItem(RUNRATE_DRAFT_KEY_V4);
        if (raw4) {
            var p4 = JSON.parse(raw4);
            if (p4 && p4.version === 4) payload = normalizeV3(p4);
        }
    } catch (e) {}

    // 2) If absent, migrate from V3 key.
    if (!payload) {
        try {
            var raw3 = localStorage.getItem(RUNRATE_DRAFT_KEY_V3);
            if (raw3) {
                var p3 = JSON.parse(raw3);
                if (p3 && p3.version === 3) {
                    payload = normalizeV3(p3);
                    migrationNotes.push('Migrated from V3 draft to V4. Stale calculated results were not carried over.');
                }
            }
        } catch (e) {}
    }

    // 3) Otherwise migrate from V2 single-line draft.
    if (!payload) {
        payload = migrateFromV2();
        if (payload) migrationNotes.push('Migrated from V2 draft to V4.');
    }

    // 4) Blank template as a last resort.
    if (!payload) {
        payload = rnrBlankV3Template();
    }

    payload.migrationReview = (payload.migrationReview || []).concat(migrationNotes);

    var input = {
        project: payload.project || {},
        demand: payload.demand || {},
        enabledLineCount: payload.enabledLineCount || 1,
        activeLineIndex: payload.activeLineIndex || 0,
        lines: payload.lines && payload.lines.length === 5 ? payload.lines :
               [rnrBlankLine(), rnrBlankLine(), rnrBlankLine(), rnrBlankLine(), rnrBlankLine()],
        conclusion: payload.conclusion || {},
        migrationReview: payload.migrationReview || []
    };
    // Cleanup: drop fields removed from the R@R form so they never reappear
    // after draft restoration, and are not carried into export.
    delete input.capacityRelationship;
    ['assessmentResult','mcpAlignment','reRunDate','supplyEngineer','npiEngineer','gapReason','openActions',
     'owner','targetDate','suggestedConclusion'].forEach(function(k){ delete input.conclusion[k]; });
    ['buildPhase','trialDate','assessor','assessorTitle','planQuantity'].forEach(function(k){ delete input.project[k]; });
    input.lines.forEach(function(l){ if (l && l.tracking) { delete l.tracking.owner; delete l.tracking.targetDate; } });
    return input;
}


function migrateFromV2() {
    try {
        var raw = localStorage.getItem(RUNRATE_DRAFT_KEY); // old V2 key (kept for compat)
        if (!raw) return null;
        var d = JSON.parse(raw);
        if (!d) return null;
        var v = rnrBlankV3Template();
        // project identity (V2 kept fields under s1 and flat paths)
        v.project.projectName = first(d.s1 && d.s1.projectName, d.s1 && d.s1.product, '');
        v.project.product = first(d.s1 && d.s1.product, '');
        v.project.buildIdentity = first(d.s1 && d.s1.productDesc, d["s1.productDesc"], '');
        v.project.twelveNc = first(d.s1 && d.s1.twelveNc, '');
        v.project.supplier = first(d.s1 && d.s1.supplierName, '');
        v.project.site = first(d.s1 && d.s1.manufacturingSite, '');
        v.project.siteLocation = first(d.s1 && d.s1.siteLocation, '');
        v.project.vendorCode = first(d.s1 && d.s1.vendorCode, '');
        v.project.buildDate = first(d.s1 && d.s1.dateOfTrial, d["s1.dateOfTrial"], '');
        v.project.productionOrder = first(d.s1 && d.s1.productionOrder, '');
        v.project.visitorName = first(d.s1 && d.s1.assessorName, '');
        // demand
        v.demand.source = (d.demand && d.demand.source) || d.demandSource || 'annual';
        v.demand.annual = num(d.demand && d.demand.annual);
        v.demand.customerWeeksPerYear = num(d.demand && d.demand.weeks);
        v.demand.enteredWeeklyDemand = num(d.demand && d.demand.enteredWeekly);
        v.demand.customerDaysPerWeek = num(d.demand && d.demand.days);
        v.demand.servicePercent = num(d.demand && d.demand.servicePct) || 0;
        v.demand.volumeFlexPercent = num(d.demand && d.demand.volumePct) || 0;
        v.demand.seasonalFlexPercent = num(d.demand && d.demand.seasonalPct) || 0;
        // Line 1 full dataset
        v.lines[0] = normalizeLine({
            lineName: first(d.s1 && d.s1.lineName, ''),
            processDesc: first(d.s1 && d.s1.processDesc, ''),
            op: d.op || {},
            mix: d.mix || {},
            losses: d.losses || { useCalcChangeover: d.useCalcChangeover },
            idealCycleTime: num(d.idealCycleTime),
            run: d.run || {}
        }, v.lines[0]);
        // conclusion
        v.conclusion.reRunRequired = first(d.conclusion && d.conclusion.reRunRequired, '');
        v.conclusion.summary = first(d.conclusion && d.conclusion.summary, '');
        return v;
    } catch (e) { console.warn('Run@Rate V2 migration warning:', e.message); return null; }
}

/* Convert a legacy V3 line (op/mix/losses/idealCycleTime/run) into V4 shape. */

function showRnrExportStatus(msg, kind) {
    var el = document.getElementById('rnrExportStatus');
    if (el) { el.style.display = 'flex'; el.textContent = msg; el.style.background = kind === 'error' ? 'var(--red-bg)' : 'var(--green-bg)'; }
}
/* ============================================================
   RUN @ RATE CREATOR — EXCEL EXPORT
   One professional "Run @ Rate Report" sheet:
     1. Main Build Information
     2. Demand & Daily Production Volume
     3. All-Line Capacity Comparison
     4. Detailed Line Blocks (one full-width block per enabled line)
     5. Overall Conclusion & Follow-Up
   Scalable from one to five enabled lines. All values are written
   from the validated rnrCollect/rnrComputeAll data (no parallel
   Excel calculation model), so the export matches the UI exactly.
   ============================================================ */

var RNR_XLSX = (function () {
    var PAGE_HEIGHT = 470;     // usable points per page below the repeating title rows
    var page = { used: 38 };   // rows 1-2 (title band) repeat on every printed page
    var LABCOLS = ['A', 'C', 'E'];
    var VALCOLS = ['B', 'D', 'F'];

    function isNum(v) { return v !== null && v !== undefined && isFinite(v); }
    function rnd(v) { return isNum(v) ? Math.round(v) : null; }
    function cell(ws, addr) { return ws.getCell(addr); }
    function blankFill(c) { c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.labelBg } }; }

    function dash(c, center) {
        c.value = '—';
        c.font = { name: FONT, size: 9, italic: true, color: { argb: C.faint } };
        c.alignment = { vertical: 'middle', horizontal: center ? 'center' : 'right' };
    }

    /* Numeric value cell. Missing/unavailable -> '—'. */
    function num(ws, addr, value, fmt, o) {
        o = o || {};
        var c = cell(ws, addr);
        if (!isNum(value)) { dash(c, o.center); return c; }
        c.value = value;
        c.numFmt = fmt;
        c.font = { name: FONT, size: 10, bold: !!o.bold, color: { argb: C.ink } };
        c.alignment = { vertical: 'middle', horizontal: o.center ? 'center' : 'right', wrapText: !!o.wrap };
        if (o.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
        return c;
    }

    /* Text value cell. */
    function txt(ws, addr, value, o) {
        o = o || {};
        var c = cell(ws, addr);
        var s = (value === null || value === undefined) ? '' : String(value);
        if (o.dashEmpty && !s) { dash(c, o.center); return c; }
        c.value = s;
        c.font = { name: FONT, size: 10, bold: !!o.bold, color: { argb: o.gray ? C.gray : C.ink } };
        c.alignment = { vertical: o.top ? 'top' : 'middle', horizontal: o.center ? 'center' : 'left', wrapText: o.wrap !== false };
        if (o.fill) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
        return c;
    }

    /* Muted label cell with subtle gray fill. */
    function label(ws, addr, text) {
        var c = cell(ws, addr);
        c.value = text;
        c.font = { name: FONT, size: 9, color: { argb: C.gray } };
        c.alignment = { vertical: 'middle', wrapText: true };
        blankFill(c);
        return c;
    }

    /* Full-width bar: dark blue section bar, medium blue line bar,
       light blue subsection bar. */
    function bar(ws, row, text, fillColor, fontColor, height, size) {
        ws.mergeCells('A' + row + ':F' + row);
        var c = cell(ws, 'A' + row);
        c.value = text;
        c.font = { name: FONT, size: size, bold: true, color: { argb: fontColor } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fillColor } };
        c.alignment = { vertical: 'middle', horizontal: 'left' };
        ws.getRow(row).height = height;
    }
    function sectionBar(ws, row, text) { bar(ws, row, text, C.dark, C.white, 18, 11); }
    function lineBar(ws, row, text) { bar(ws, row, text, C.med, C.white, 20, 11); }
    function subBar(ws, row, text) { bar(ws, row, text, C.light, 'FF0B3D91', 15, 10); }

    /* Table header cell (white on medium blue). */
    function th(ws, addr, text) {
        var c = cell(ws, addr);
        c.value = text;
        c.font = { name: FONT, size: 9, bold: true, color: { argb: C.white } };
        c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.med } };
        c.alignment = { vertical: 'middle', horizontal: 'center', wrapText: true };
        return c;
    }


    /* Page-break aware vertical-space tracker. Keeps a section together. */
    function pageCheck(ws, row, height) {
        if (page.used + height > PAGE_HEIGHT) {
            ws.getRow(row).addPageBreak();
            page.used = 0;
        }
        page.used += height;
    }

    /* One row of up to three label/value pairs across A-F. */
    function pairs(ws, row, items, height) {
        for (var i = 0; i < 3; i++) {
            var it = items[i];
            if (!it) continue;
            label(ws, LABCOLS[i] + row, it[0]);
            if (it[2] === 'n') num(ws, VALCOLS[i] + row, it[1], it[3], it[4] || {});
            else txt(ws, VALCOLS[i] + row, it[1], it[4] || {});
        }
        ws.getRow(row).height = height;
    }

    /* Multi-row pair grid with automatic label/value wrap heights.
       Returns the next free row. */
    function pairRows(ws, row, rowsArr, forceH) {
        for (var i = 0; i < rowsArr.length; i++) {
            var items = rowsArr[i];
            var h = forceH || 16;
            if (!forceH) {
                for (var j = 0; j < items.length; j++) {
                    if (!items[j]) continue;
                    var lh = wrapH(items[j][0], 19, 11);
                    if (lh > h) h = lh;
                    if (items[j][2] !== 'n' && items[j][1] !== null && items[j][1] !== undefined) {
                        var vh = wrapH(String(items[j][1]), 12, 11);
                        if (vh > h) h = vh;
                    }
                }
                h = Math.max(16, h);
            }
            pairs(ws, row, items, h);
            row++;
        }
        return row;
    }

    /* Full-width label/value row (value merged B:F, wrapped). */
    function longRow(ws, row, textLabel, value, o) {
        o = o || {};
        label(ws, 'A' + row, textLabel);
        ws.mergeCells('B' + row + ':F' + row);
        txt(ws, 'B' + row, value, { top: true, wrap: true, bold: !!o.bold });
        if (o.fill) cell(ws, 'B' + row).fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: o.fill } };
        ws.getRow(row).height = o.height || 20;
    }

    function lineNameOf(input, i) {
        return (input.lines[i] && input.lines[i].identity && input.lines[i].identity.processName) || '';
    }

    /* All-line comparison metric row values for one enabled line. */
    function lineMetricVals(input, cl, dem, i) {
        var idt = (input.lines[i] && input.lines[i].identity) || {};
        var nm = idt.processName || ('Line ' + (i + 1));
        var demandWk = rnd(dem.adjustedDemandPerWeek);
        var planWk = (cl && cl.planned && isNum(cl.planned.plannedCapacityPerWeek))
            ? Math.round(cl.planned.plannedCapacityPerWeek) : null;
        var shipWk = (cl && cl.actual && isNum(cl.actual.actualShipPerWeek))
            ? Math.round(cl.actual.actualShipPerWeek) : null;
        var st = rnrCapacityStatus(shipWk, demandWk);
        var sf = { good: C.good, warn: C.warn, major: C.major, empty: C.empty }[st.cls];
        var gap = (shipWk !== null && demandWk !== null) ? (shipWk - demandWk) : null;
        var planned = cl ? cl.planned : null, run = cl ? cl.run : null, actual = cl ? cl.actual : null;
        return [
            { v: nm, t: true, center: true, bold: true },
            { v: demandWk, fmt: '#,##0' },
            { v: planWk, fmt: '#,##0' },
            { v: shipWk, fmt: '#,##0' },
            { v: gap, fmt: '#,##0;#,##0;-', fill: isNum(gap) ? sf : null },
            { v: planned ? planned.plannedCapacityRatio : null, fmt: '0.00' },
            { v: actual ? actual.actualCapacityRatio : null, fmt: '0.00' },
            { v: st.label, t: true, center: true, bold: true, fill: st.cls === 'empty' ? null : sf },
            { v: planned ? planned.customerTaktSeconds : null, fmt: '0.0' },
            { v: planned ? planned.mcpCycleTimeSeconds : null, fmt: '0.0' },
            { v: run ? run.actualCycleTimeSeconds : null, fmt: '0.0' },
            { v: planned ? planned.projectedOee : null, fmt: '0.0%' },
            { v: actual ? actual.actualOee : null, fmt: '0.0%' }
        ];
    }

    var COMPARE_METRICS = [
        'Process / Name', 'Demand / Week', 'Plan / Week', 'Actual / Week',
        'Gap to Demand', 'Plan Ratio', 'Actual Ratio', 'Status',
        'Customer Takt (s)', 'Machine Cycle Time (s)', 'Actual Cycle Time (s)',
        'Projected OEE', 'Actual OEE'
    ];

    /* Machine vs Actual gap-analysis rows (matches Process Section of the HTML form). */
    function gapRowsFor(cl, dem) {
        var out = [];
        if (!cl) return out;
        var planned = cl.planned || {}, run = cl.run || {}, actual = cl.actual || {}, comp = cl.comparison || {};
        var hasDpv = isNum(dem.dpv);
        var hasDem = isNum(dem.adjustedDemandPerWeek);
        function pts(v) { return isNum(v) ? v * 100 : null; }
        var dpvM = hasDpv ? Math.round(dem.dpv) : null;
        var shipDay = isNum(actual.actualShipPerDay) ? Math.round(actual.actualShipPerDay) : null;
        var demM = hasDem ? Math.round(dem.adjustedDemandPerWeek) : null;
        var shipWk = isNum(actual.actualShipPerWeek) ? Math.round(actual.actualShipPerWeek) : null;
        out.push(['DPV', dpvM, '#,##0', shipDay, '#,##0',
                  (dpvM !== null && shipDay !== null) ? shipDay - dpvM : null, '+#,##0;-#,##0;0']);
        out.push(['Demand / Week', demM, '#,##0', shipWk, '#,##0',
                  (demM !== null && shipWk !== null) ? shipWk - demM : null, '+#,##0;-#,##0;0']);
        out.push(['Cycle Time', planned.mcpCycleTimeSeconds, '0.0', run.actualCycleTimeSeconds, '0.0',
                  comp.cycleTimeGapSeconds, '+0.0;-0.0;0.0']);
        out.push(['OEE-A', planned.plannedAvailability, '0.0%', run.actualAvailability, '0.0%',
                  isNum(comp.availabilityGapPoints) ? pts(comp.availabilityGapPoints) : null, '+0;-0;0']);
        out.push(['OEE-P', planned.plannedPerformance, '0.0%', actual.actualPerformance, '0.0%',
                  isNum(comp.performanceGapPoints) ? pts(comp.performanceGapPoints) : null, '+0;-0;0']);
        out.push(['OEE-Q', planned.plannedQuality, '0.0%', run.actualQuality, '0.0%',
                  isNum(comp.qualityGapPoints) ? pts(comp.qualityGapPoints) : null, '+0;-0;0']);
        out.push(['OEE', planned.projectedOee, '0.0%', actual.actualOee, '0.0%',
                  isNum(comp.oeeGapPoints) ? pts(comp.oeeGapPoints) : null, '+0;-0;0']);
        out.push(['Ratio', planned.plannedCapacityRatio, '0.00', actual.actualCapacityRatio, '0.00',
                  comp.capacityGapPercent, '+0.0%;-0.0%;0.0%']);
        return out;
    }

    /* ------------------------------------------------------------------
       Main sheet builder
       ------------------------------------------------------------------ */
    function build(ws, input, demand, lines) {
        var p = input.project;
        var d = input.demand;
        var concl = input.conclusion;
        var n = input.enabledLineCount;
        var today = new Date();
        var exportDate = today.getFullYear() + '-' +
            String(today.getMonth() + 1).padStart(2, '0') + '-' +
            String(today.getDate()).padStart(2, '0');
        var row = 1;

        /* ---- Report Header ---- */
        ws.mergeCells('A1:F1');
        var t = cell(ws, 'A1');
        t.value = 'RUN @ RATE ASSESSMENT REPORT';
        t.font = { name: FONT, size: 15, bold: true, color: { argb: C.white } };
        t.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: C.dark } };
        t.alignment = { vertical: 'middle', horizontal: 'left' };
        ws.getRow(1).height = 24;

        ws.mergeCells('A2:F2');
        var idc = cell(ws, 'A2');
        idc.value = 'Project: ' + (p.projectName || '—') +
            '    |    Build: ' + (p.buildIdentity || '—') +
            '    |    Factory / Location / Line: ' + (p.factoryLine || '—') +
            '    |    Export Date: ' + exportDate;
        idc.font = { name: FONT, size: 9, color: { argb: C.gray } };
        idc.alignment = { vertical: 'middle', horizontal: 'left' };
        ws.getRow(2).height = 14;

        row = 4;

        /* ---- 1. Main Build Information ---- */
        pageCheck(ws, row, 18 + 32 + 32 + 20);
        sectionBar(ws, row, '1. Main Build Information'); row++;
        row = pairRows(ws, row, [
            [['Project Name', p.projectName || '', 't', null, { bold: true, dashEmpty: true }],
             ['Build Identity', p.buildIdentity || '', 't', null, { bold: true, dashEmpty: true }]],
            [['Date', p.buildDate || '', 't', null, { bold: true }],
             ['Auditor Name', p.visitorName || '', 't', null, { bold: true, dashEmpty: true }]]
        ], 16);
        longRow(ws, row, 'Factory / Location / Line',
            p.factoryLine || p.siteLocation || '',
            { height: Math.max(16, wrapH(p.factoryLine || p.siteLocation || '', 85, 12)) }); row++;
        longRow(ws, row, 'Special Remark', p.specialRemark || '',
            { height: Math.max(18, wrapH(p.specialRemark, 85, 12)) }); row++;

        /* ---- 2. Demand & Daily Production Volume ---- */
        row++; // spacer
        pageCheck(ws, row, 18 + 16 + 16 + 16 + 14);
        sectionBar(ws, row, '2. Demand & Daily Production Volume'); row++;
        row = pairRows(ws, row, [
            [['Annual Volume (pcs/yr)', d.annual, 'n', '#,##0', { bold: true }],
             ['Customer Weeks / Year', d.customerWeeksPerYear, 'n', '0', {}],
             ['Customer Days / Week', d.customerDaysPerWeek, 'n', '0', {}]],
            [['Volume Flex %', d.volumeFlexPercent, 'n', '0.0"%"', {}],
             ['Seasonal Flex %', d.seasonalFlexPercent, 'n', '0.0"%"', {}],
             null],
            [['Base Demand / Week (derived)', isNum(demand.baseDemandPerWeek) ? Math.round(demand.baseDemandPerWeek) : null, 'n', '#,##0', { bold: true, fill: C.derived }],
             ['Adjusted Demand / Week (derived)', isNum(demand.adjustedDemandPerWeek) ? Math.round(demand.adjustedDemandPerWeek) : null, 'n', '#,##0', { bold: true, fill: C.derived }],
             ['DPV (derived)', isNum(demand.dpv) ? Math.round(demand.dpv * 10) / 10 : null, 'n', '#,##0.0', { bold: true, fill: C.derived }]]
        ], 16);
        ws.mergeCells('A' + row + ':F' + row);
        txt(ws, 'A' + row, 'Base Demand / Week, Adjusted Demand / Week and DPV are calculated from the entered annual volume, flex and customer-calendar inputs.',
            { gray: true, wrap: true, top: true });
        ws.getRow(row).height = 14; row++;

        /* ---- 3. All-Line Capacity Comparison ---- */
        row++; // spacer
        pageCheck(ws, row, 18 + 14 + 16 + (COMPARE_METRICS.length * 15));
        sectionBar(ws, row, '3. All-Line Capacity Comparison'); row++;
        ws.mergeCells('A' + row + ':F' + row);
        txt(ws, 'A' + row, 'Unit: pcs/week for Demand, Plan, Actual and Gap to Demand. Status reflects the same thresholds as the form: Achieved / Gap / Major Gap / —.',
            { gray: true, wrap: true, top: true });
        ws.getRow(row).height = 14; row++;

        var hr = row;
        th(ws, 'A' + hr, 'Metric');
        for (var i = 0; i < n; i++) {
            var nm = lineNameOf(input, i);
            th(ws, String.fromCharCode(66 + i) + hr, 'L' + (i + 1) + (nm ? ' ' + nm : ''));
        }
        ws.getRow(hr).height = 30;
        row = hr + 1;

        var vals = [];
        for (var i = 0; i < n; i++) vals.push(lineMetricVals(input, lines[i], demand, i));
        for (var m = 0; m < COMPARE_METRICS.length; m++) {
            txt(ws, 'A' + row, COMPARE_METRICS[m], { bold: m < 6 });
            for (var i = 0; i < n; i++) {
                var it = vals[i][m];
                var addr = String.fromCharCode(66 + i) + row;
                if (it.t) txt(ws, addr, it.v, { center: true, bold: it.bold, fill: it.fill, gray: it.gray });
                else num(ws, addr, it.v, it.fmt, { fill: it.fill, bold: it.bold });
            }
            ws.getRow(row).height = 15;
            row++;
        }

        /* ---- 4. Detailed Line Blocks ---- */
        row++; // spacer
        pageCheck(ws, row, 18 + 20 + 15 + 32);
        sectionBar(ws, row, '4. Detailed Line Blocks'); row++;

        for (var li = 0; li < n; li++) {
            var cl = lines[li];
            var ln = input.lines[li] || {};
            var idt = ln.identity || {};
            var opIn = (ln.plannedInputs && ln.plannedInputs.operating) || {};
            var lsIn = (ln.plannedInputs && ln.plannedInputs.losses) || {};
            var aiIn = ln.actualInputs || {};
            var trIn = ln.tracking || {};
            var planned = cl ? cl.planned : null;
            var run = cl ? cl.run : null;
            var actual = cl ? cl.actual : null;
            var op = cl ? cl.op : null;
            var losses = cl ? cl.losses : null;
            var lbName = lineNameOf(input, li);
            var hasParts = isNum(aiIn.totalParts);
            var hasReject = isNum(aiIn.rejectQuantity);
            var goodQty = (hasParts && hasReject && run) ? run.firstPassGoodParts : null;
            var qualityVal = (hasParts && hasReject && run && run.totalParts > 0) ? run.actualQuality : null;
            var rrH = Math.max(16, wrapH(aiIn.rejectReason || '', 85, 12));
            var rnH = Math.max(16, wrapH(aiIn.runNote || '', 85, 12));
            var gapH = Math.max(16, wrapH(trIn.gapReason || '', 85, 12));
            var actH = Math.max(16, wrapH(trIn.correctiveAction || '', 85, 12));

            /* Keep the line header with its first subsection. */
            pageCheck(ws, row, 20 + 15 + 16 + 16);
            lineBar(ws, row, 'LINE ' + (li + 1) + (lbName ? ': ' + lbName : ''));
            row++;

            pageCheck(ws, row, 15 + 16 + 16);
            subBar(ws, row, 'Line Identity'); row++;
            row = pairRows(ws, row, [
                [['Line', 'Line ' + (li + 1), 't', null, { bold: true }],
                 ['Process / Name', idt.processName || '', 't', null, { bold: true, dashEmpty: true }],
                 ['Location', idt.location || '', 't', null, { dashEmpty: true }]]
            ], 16);

            pageCheck(ws, row, 15 + 16 + 16);
            subBar(ws, row, 'Planned Operating Calendar'); row++;
            row = pairRows(ws, row, [
                [['Shifts (shift/day)', opIn.shifts, 'n', '0', {}],
                 ['Hours / Shift (hr/shift)', opIn.hours, 'n', '0.0', {}],
                 ['Break (min/shift)', opIn.breakMin, 'n', '0', {}]],
                [['Maintenance (min/shift)', opIn.maintMin, 'n', '0', {}],
                 ['Production Days / Week (day/week)', opIn.prodDaysPerWeek, 'n', '0', {}],
                 ['Production Weeks / Year (week/year)', opIn.prodWeeksPerYear, 'n', '0', {}]]
            ]);

            pageCheck(ws, row, 15 + 16 + 16);
            subBar(ws, row, 'Planned Losses'); row++;
            row = pairRows(ws, row, [
                [['Changeover Time (min)', lsIn.changeoverMin, 'n', '0', {}],
                 ['Changeovers per Shift (#)', lsIn.manualChangeoversPerShift, 'n', '0.0', {}],
                 ['Inspection Allowance (min/shift)', lsIn.inspectionMinPerShift, 'n', '0', {}]],
                [['Breakdown Allowance (min/shift)', lsIn.breakdownMinPerShift, 'n', '0', {}],
                 ['Scrap %', lsIn.scrapPercent, 'n', '0.0"%"', {}],
                 ['Machine Cycle Time (s)', ln.plannedInputs ? ln.plannedInputs.mcpCycleTimeSeconds : null, 'n', '0.0', {}]]
            ]);

            if (op && planned && losses && isNum(op.netAvailableHoursPerWeek) && op.netAvailableHoursPerWeek > 0 &&
                isNum(planned.effectiveProductionHoursPerWeek) && planned.effectiveProductionHoursPerWeek > 0) {
                var fpt = planned.effectiveProductionHoursPerWeek * planned.plannedQuality;
                pageCheck(ws, row, 15 + 16 + 16 + 16 + 14);
                subBar(ws, row, 'Planned OEE Calculation'); row++;
                row = pairRows(ws, row, [
                    [['Planned Production Time (h/wk)', op.netAvailableHoursPerWeek, 'n', '0.0', { bold: true }],
                     ['Operating Time (h/wk)', planned.effectiveProductionHoursPerWeek, 'n', '0.0', { bold: true }],
                     ['OEE-A', losses.plannedAvailability, 'n', '0.0%', { bold: true }]],
                    [['Net Operating Time (h/wk)', planned.effectiveProductionHoursPerWeek, 'n', '0.0', {}],
                     ['OEE-P', planned.plannedPerformance, 'n', '0.0%', {}],
                     ['Fully Productive Time (h/wk)', fpt, 'n', '0.0', { bold: true }]],
                    [['OEE-Q', losses.plannedQuality, 'n', '0.0%', {}],
                     ['Projected OEE', planned.projectedOee, 'n', '0.0%', { bold: true, fill: C.derived }],
                     null]
                ], 16);
                ws.mergeCells('A' + row + ':F' + row);
                txt(ws, 'A' + row,
                    'OEE-A = Operating Time ÷ Planned Production Time; OEE-P = 100% (no planned performance-loss input); OEE-Q = Fully Productive Time ÷ Operating Time; Projected OEE = OEE-A × OEE-P × OEE-Q.',
                    { gray: true, wrap: true, top: true });
                ws.getRow(row).height = 14; row++;
            } else {
                pageCheck(ws, row, 15 + 16);
                subBar(ws, row, 'Planned OEE Calculation'); row++;
                ws.mergeCells('A' + row + ':F' + row);
                txt(ws, 'A' + row, 'Enter the operating pattern and planned losses to calculate projected OEE.',
                    { gray: true, wrap: true });
                ws.getRow(row).height = 16; row++;
            }

            pageCheck(ws, row, 15 + 16 + 16);
            subBar(ws, row, 'Planned Capacity Check'); row++;
            row = pairRows(ws, row, [
                [['Customer Takt (s)', planned ? planned.customerTaktSeconds : null, 'n', '0.0', {}],
                 ['Required Cycle Time (s)', planned ? planned.requiredCycleTimeSeconds : null, 'n', '0.0', {}],
                 ['Machine Cycle Time (s)', planned ? planned.mcpCycleTimeSeconds : null, 'n', '0.0', {}]],
                [['Plan / Week (pcs)', planned ? rnd(planned.plannedCapacityPerWeek) : null, 'n', '#,##0', { bold: true }],
                 ['Plan Ratio', planned ? planned.plannedCapacityRatio : null, 'n', '0.00', { bold: true }],
                 null]
            ], 16);

            pageCheck(ws, row, 15 + 16 + 16 + 16 + rrH + rnH);
            subBar(ws, row, 'Actual Production Run'); row++;
            row = pairRows(ws, row, [
                [['Run Minutes (min)', aiIn.totalRunMinutes, 'n', '0', {}],
                 ['Break Minutes (min)', aiIn.actualBreakMinutes, 'n', '0', {}],
                 ['Changeover + Inspection Minutes (min)', aiIn.actualChangeoverInspectionMinutes, 'n', '0', {}]],
                [['Unplanned Minutes (min)', aiIn.actualUnplannedMinutes, 'n', '0', {}],
                 ['Parts (pcs)', aiIn.totalParts, 'n', '#,##0', {}],
                 ['Rejects (pcs)', aiIn.rejectQuantity, 'n', '#,##0', {}]],
                [['Good Quantity (pcs)', goodQty, 'n', '#,##0', { bold: true, fill: C.derived }],
                 ['Quality %', qualityVal, 'n', '0.0%', { bold: true, fill: C.derived }],
                 null]
            ], 16);
            longRow(ws, row, 'Reject Reason', aiIn.rejectReason || '', { height: rrH }); row++;
            longRow(ws, row, 'Run Note', aiIn.runNote || '', { height: rnH }); row++;

            pageCheck(ws, row, 15 + 16 + 16 + 16);
            subBar(ws, row, 'Actual OEE and Capacity Results'); row++;
            row = pairRows(ws, row, [
                [['Actual Availability', run ? run.actualAvailability : null, 'n', '0.0%', {}],
                 ['Actual Performance', actual ? actual.actualPerformance : null, 'n', '0.0%', {}],
                 ['Actual Quality', run ? run.actualQuality : null, 'n', '0.0%', {}]],
                [['Actual OEE', actual ? actual.actualOee : null, 'n', '0.0%', { bold: true, fill: C.derived }],
                 ['Actual Cycle Time (s)', run ? run.actualCycleTimeSeconds : null, 'n', '0.0', {}],
                 ['Actual Ship / Day (pcs)', actual ? actual.actualShipPerDay : null, 'n', '#,##0', {}]],
                [['Actual Ship / Week (pcs)', actual ? actual.actualShipPerWeek : null, 'n', '#,##0', { bold: true }],
                 ['Actual Ratio', actual ? actual.actualCapacityRatio : null, 'n', '0.00', { bold: true }],
                 null]
            ], 16);

            var gapRows = gapRowsFor(cl, demand);
            pageCheck(ws, row, 15 + 16 + (gapRows.length * 15) + 14);
            subBar(ws, row, 'Machine vs Actual Gap Analysis'); row++;
            ws.mergeCells('A' + row + ':B' + row);
            th(ws, 'A' + row, 'Metric');
            th(ws, 'C' + row, 'Machine / Plan');
            th(ws, 'D' + row, 'Actual');
            ws.mergeCells('E' + row + ':F' + row);
            th(ws, 'E' + row, 'Gap');
            ws.getRow(row).height = 16; row++;
            for (var g = 0; g < gapRows.length; g++) {
                var gr = gapRows[g];
                ws.mergeCells('A' + row + ':B' + row);
                txt(ws, 'A' + row, gr[0], {});
                num(ws, 'C' + row, gr[1], gr[2], {});
                num(ws, 'D' + row, gr[3], gr[4], {});
                ws.mergeCells('E' + row + ':F' + row);
                num(ws, 'E' + row, gr[5], gr[6], {});
                ws.getRow(row).height = 15;
                row++;
            }
            ws.mergeCells('A' + row + ':F' + row);
            txt(ws, 'A' + row, 'Gap units — DPV & Demand / Week: pcs; Cycle Time: s; OEE rows: percentage points; Ratio: % of plan.',
                { gray: true, wrap: true, top: true });
            ws.getRow(row).height = 14; row++;

            pageCheck(ws, row, 15 + gapH + actH);
            subBar(ws, row, 'Gap Tracking'); row++;
            longRow(ws, row, 'Gap Reason', trIn.gapReason || '', { height: gapH }); row++;
            longRow(ws, row, 'Corrective Action', trIn.correctiveAction || '', { height: actH }); row++;
        }

        /* ---- 5. Overall Conclusion & Follow-Up ---- */
        var conclH = Math.max(24, wrapH(concl.summary || '', 85, 12) + 8);
        pageCheck(ws, row, 18 + 15 + 16 + (n * 15) + 15 + conclH + 15 + 16 + 15 + 44 + 14);
        sectionBar(ws, row, '5. Overall Conclusion & Follow-Up'); row++;
        subBar(ws, row, 'Capacity Summary'); row++;
        th(ws, 'A' + row, 'Line');
        th(ws, 'B' + row, 'Demand');
        th(ws, 'C' + row, 'Plan');
        th(ws, 'D' + row, 'Actual');
        th(ws, 'E' + row, 'Gap to Demand');
        th(ws, 'F' + row, 'Status');
        ws.getRow(row).height = 16; row++;
        var demandWkC = rnd(demand.adjustedDemandPerWeek);
        for (var ci = 0; ci < n; ci++) {
            var ccl = lines[ci];
            var cnm = lineNameOf(input, ci) || ('Line ' + (ci + 1));
            var cplan = (ccl && ccl.planned && isNum(ccl.planned.plannedCapacityPerWeek))
                ? Math.round(ccl.planned.plannedCapacityPerWeek) : null;
            var cship = (ccl && ccl.actual && isNum(ccl.actual.actualShipPerWeek))
                ? Math.round(ccl.actual.actualShipPerWeek) : null;
            var cst = rnrCapacityStatus(cship, demandWkC);
            var csf = { good: C.good, warn: C.warn, major: C.major, empty: C.empty }[cst.cls];
            var cgap = (cship !== null && demandWkC !== null) ? (cship - demandWkC) : null;
            txt(ws, 'A' + row, cnm, { center: true, bold: true });
            num(ws, 'B' + row, demandWkC, '#,##0', {});
            num(ws, 'C' + row, cplan, '#,##0', {});
            num(ws, 'D' + row, cship, '#,##0', {});
            num(ws, 'E' + row, cgap, '#,##0;#,##0;-', { fill: isNum(cgap) ? csf : null });
            txt(ws, 'F' + row, cst.label, { center: true, bold: true, fill: cst.cls === 'empty' ? null : csf });
            ws.getRow(row).height = 16;
            row++;
        }
        subBar(ws, row, 'Conclusion'); row++;
        longRow(ws, row, 'Summary / Conclusion', concl.summary || '', { height: conclH }); row++;
        subBar(ws, row, 'Re-run'); row++;
        pairs(ws, row, [['Re-run Required?', concl.reRunRequired || '', 't', null, { bold: true }]], 16); row++;
        subBar(ws, row, 'Sign-off'); row++;
        txt(ws, 'A' + row, 'NPI SnapWalk:', { gray: true });
        ws.mergeCells('B' + row + ':C' + row);
        cell(ws, 'B' + row).border = { bottom: { style: 'thin', color: { argb: 'FF374151' } } };
        txt(ws, 'D' + row, 'Date:', { gray: true });
        ws.mergeCells('E' + row + ':F' + row);
        cell(ws, 'E' + row).border = { bottom: { style: 'thin', color: { argb: 'FF374151' } } };
        ws.getRow(row).height = 20; row++;
        txt(ws, 'A' + row, 'Supplier Representative:', { gray: true });
        ws.mergeCells('B' + row + ':C' + row);
        cell(ws, 'B' + row).border = { bottom: { style: 'thin', color: { argb: 'FF374151' } } };
        txt(ws, 'D' + row, 'Date:', { gray: true });
        ws.mergeCells('E' + row + ':F' + row);
        cell(ws, 'E' + row).border = { bottom: { style: 'thin', color: { argb: 'FF374151' } } };
        ws.getRow(row).height = 20; row++;

        /* ---- Footer ---- */
        ws.mergeCells('A' + row + ':F' + row);
        txt(ws, 'A' + row, 'Run @ Rate report generated ' + exportDate +
            ' by NPI SnapWalk. Figures are exported exactly as entered and calculated in the form.',
            { gray: true, wrap: true, top: true });
        ws.getRow(row).height = 14; row++;

        /* ---- Layout, print and page setup ---- */
        ws.getColumn(1).width = 22;
        ws.getColumn(2).width = 15;
        ws.getColumn(3).width = 22;
        ws.getColumn(4).width = 15;
        ws.getColumn(5).width = 22;
        ws.getColumn(6).width = 15;

        ws.showGridLines = false;
        ws.properties.defaultRowHeight = 15;
        ws.pageSetup.orientation = 'landscape';
        ws.pageSetup.fitToPage = true;
        ws.pageSetup.fitToWidth = 1;
        ws.pageSetup.fitToHeight = 0;
        ws.pageSetup.paperSize = 9; // A4
        ws.pageSetup.horizontalCentered = true;
        ws.pageSetup.printArea = 'A1:F' + (row - 1);
        ws.pageSetup.printTitlesRow = '1:2';
        ws.pageMargins = { left: 0.4, right: 0.4, top: 0.5, bottom: 0.5, header: 0.2, footer: 0.2 };
    }

    return { build: build };
})();

function rnrBuildSummarySheet(ws, input, lines) {
    RNR_XLSX.build(ws, input, rnrState.demand || {}, lines);
}

function exportRunRateExcel() {
    var errors = [];
    if (!rnrVal('rnrProjectName') || !String(rnrVal('rnrProjectName')).trim()) errors.push('Project Name is required.');
    if (!rnrVal('rnrBuildIdentity') || !String(rnrVal('rnrBuildIdentity')).trim()) errors.push('Build Identity is required.');
    if (!rnrVal('rnrBuildDate')) errors.push('Date is required.');
    if (errors.length > 0) {
        showRnrExportStatus('Please fix the following before exporting: ' + errors.join('; '), 'error');
        return;
    }
    var input = rnrCollect();
    rnrState.input = input;
    var computed = rnrComputeAll();
    rnrState.lines = computed.lines;
    rnrState.demand = computed.demand;

    if (!window.ExcelJS) {
        showRnrExportStatus('ExcelJS library not loaded. Check internet connection.', 'error');
        return;
    }
    var wb = new ExcelJS.Workbook();
    var ws = wb.addWorksheet('Run @ Rate Report', { views: [{ showGridLines: false }] });
    rnrBuildSummarySheet(ws, input, computed.lines);

    var safeName = function(s) {
        return s.trim()
            .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    };
    var project = safeName(String(input.project.projectName || ''));
    var build = safeName(String(input.project.buildIdentity || ''));
    if (!project) project = 'Project';
    var fname = build ? project + '_Run@Rate_Report_' + build + '.xlsx' : project + '_Run@Rate_Report.xlsx';

    wb.xlsx.writeBuffer().then(function(buffer) {
        var blob = new Blob([buffer], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' });
        if (window.saveAs) {
            saveAs(blob, fname);
            showRnrExportStatus('Exported: ' + fname, 'ok');
        } else {
            var url = URL.createObjectURL(blob);
            var a = document.createElement('a');
            a.href = url; a.download = fname;
            document.body.appendChild(a); a.click();
            document.body.removeChild(a);
            showRnrExportStatus('Exported: ' + fname, 'ok');
        }
    }).catch(function(err) {
        showRnrExportStatus('Export failed: ' + err.message, 'error');
    });
}
