        /* ============================================================
           APPLICATION CONSTANTS
           ============================================================ */
        const MODULES = {
            EB_REPORT: "eb",
            CAPACITY: "capacity"
        };
        const MODULE_TITLES = {
            eb: "EB Report Creator",
            capacity: "Run@Rate Creator"
        };
        const MODULE_HEADERS = {
            eb: { desktop: "Engineering Build Report Creator", mobile: "EB Report Creator" },
            capacity: { desktop: "Run@Rate Creator", mobile: "Run@Rate Creator" }
        };

        /* ============================================================
           CONSTANTS
           ============================================================ */
        const CATEGORIES = [
            { code: '1', label: 'Mechanical' },
            { code: '2', label: 'Electrical' },
            { code: '3', label: 'Software' },
            { code: '4', label: 'Process' },
            { code: '5', label: 'Tooling' },
            { code: '6', label: 'Material' },
            { code: '7', label: 'Packaging' },
            { code: '8', label: 'Operator' },
            { code: '9', label: 'Documentation' },
            { code: '10', label: 'Capacity' },
            { code: '11', label: 'Testing' },
            { code: '12', label: 'Same as Above' }
        ];

        /* "Same as Above" — lightweight observation inheritance. A row with
           this category inherits its observation fields from the nearest
           observation above whose category is NOT "Same as Above". One photo
           per item and one row per observation stay unchanged. */
        const SAME_AS_ABOVE_CATEGORY = 'Same as Above';

        function isSameAsAboveCategory(cat) {
            return cat === SAME_AS_ABOVE_CATEGORY;
        }

        const EB_STATUS_GROUPS = {
            red:    { key: 'red',    label: 'Open Items (Red)',          bg: '#FDECEC', text: '#C62828' },
            yellow: { key: 'yellow', label: 'Work In Progress (Yellow)', bg: '#FFF8E1', text: '#E65100' },
            green:  { key: 'green',  label: 'Completed (Green)',         bg: '#E8F5E9', text: '#2E7D32' }
        };
        const STATUSES = [
            { code: '1', label: 'OPEN', group: 'red' },
            { code: '2', label: 'NOT ADDRESSED', group: 'red' },
            { code: '3', label: 'IN PROGRESS', group: 'yellow' },
            { code: '4', label: 'UNDER ACTION', group: 'yellow' },
            { code: '5', label: 'IMPLEMENTED', group: 'green' },
            { code: '6', label: 'CLOSED', group: 'green' }
        ];
        const DEFAULT_OBS_STATUS = 'OPEN';

        function normalizeObsStatus(status) {
            var s = (status || '').toString().trim();
            if (!s) return DEFAULT_OBS_STATUS;
            var low = s.toLowerCase();
            if (low.indexOf('no solution') !== -1 || low.indexOf('high risk') !== -1) return 'OPEN';
            if (low.indexOf('further investigation') !== -1) return 'UNDER ACTION';
            if (low.indexOf('in progress') !== -1) return 'IN PROGRESS';
            if (low.indexOf('solid solution') !== -1) return 'IMPLEMENTED';
            if (low.indexOf('closed') !== -1) return 'CLOSED';
            var up = s.toUpperCase();
            for (var i = 0; i < STATUSES.length; i++) {
                if (STATUSES[i].label === up) return up;
            }
            return DEFAULT_OBS_STATUS;
        }

        const PHOTO_MAX_WIDTH = 1280;
        const PHOTO_JPEG_QUALITY = 0.77;
        const MAX_TOTAL_PHOTOS = 50;
        /* Storage keys — namespaced per module for multi-module support. */
        const STATE_KEY = STORAGE_PREFIX + '-state-v1';
        const DRAFT_KEY = STORAGE_PREFIX + '-draft-v1-eb';
        const RUNRATE_DRAFT_KEY = STORAGE_PREFIX + '-draft-v2-run-rate';
        const LEGACY_CAPACITY_DRAFT_KEY = STORAGE_PREFIX + '-draft-v1-capacity';
        const LEGACY_DRAFT_KEY = STORAGE_PREFIX + '-legacy-draft-v1';
        const DRAFT_DEBOUNCE_MS = 500;
        const DRAFT_MAX_AGE_DAYS = 30;

        /* IndexedDB — durable photo persistence for compressed Blobs only.
           No original files, Base64 strings or Data URLs are stored here.
           localStorage keeps only text, numbers, structure and lightweight
           photo metadata; blobs never touch localStorage. */
        const IDB_NAME = STORAGE_PREFIX;
        const IDB_VERSION = 1;
        const IDB_STORE = 'eb-photos';
        const IDB_RETRY_MS = 10000;
        const PHOTO_RECORD_SCHEMA_VERSION = 2;


        /* ============================================================
           INDEXEDDB PHOTO STORAGE — native wrapper, no libraries
           Each record is keyed by "<draftId>:<obsUid>" so a photo always
           belongs to exactly one draft observation, even after visual
           renumbering. stable draftId + obsUid are required because the
           transient numeric obsId changes when observations are deleted.
           ============================================================ */
        let idbPromise = null;
        let idbFailedAt = 0;

        function openAppDatabase() {
            if (idbPromise) return idbPromise;
            if (typeof indexedDB === 'undefined' || !indexedDB.open) {
                return Promise.reject(new Error('IndexedDB is not available in this browser'));
            }
            if (idbFailedAt && Date.now() - idbFailedAt < IDB_RETRY_MS) {
                return Promise.reject(new Error('IndexedDB unavailable after a recent failure'));
            }
            idbPromise = new Promise(function(resolve, reject) {
                var req;
                try {
                    req = indexedDB.open(IDB_NAME, IDB_VERSION);
                } catch (e) {
                    idbFailedAt = Date.now();
                    idbPromise = null;
                    reject(e);
                    return;
                }
                req.onupgradeneeded = function(ev) {
                    var db = ev.target.result;
                    if (!db.objectStoreNames.contains(IDB_STORE)) {
                        var store = db.createObjectStore(IDB_STORE, { keyPath: 'id' });
                        store.createIndex('byDraft', 'draftId', { unique: false });
                    }
                };
                req.onsuccess = function(ev) {
                    idbFailedAt = 0;
                    resolve(ev.target.result);
                };
                req.onerror = function(ev) {
                    idbFailedAt = Date.now();
                    idbPromise = null;
                    reject(ev.target.error || new Error('IndexedDB open failed'));
                };
                req.onblocked = function() {
                    console.warn('[NPI SnapWalk] IndexedDB open blocked by another connection');
                };
            });
            return idbPromise;
        }

        function blobToArrayBuffer(blob) {
            if (blob && typeof blob.arrayBuffer === 'function') {
                return blob.arrayBuffer();
            }
            return new Promise(function(resolve, reject) {
                try {
                    var reader = new FileReader();
                    reader.onload = function() { resolve(reader.result); };
                    reader.onerror = function() { reject(reader.error || new Error('FileReader failed')); };
                    reader.readAsArrayBuffer(blob);
                } catch (e) {
                    reject(e);
                }
            });
        }

        function normalizePhotoRecord(rec) {
            if (!rec) return null;
            if (rec.buffer instanceof ArrayBuffer) {
                try {
                    rec.blob = new Blob([rec.buffer], { type: rec.mimeType || 'image/jpeg' });
                } catch (e) {
                    return null;
                }
            }
            if (rec.blob instanceof Blob) return rec;
            return null;
        }

        function saveEbPhoto(draftId, obsUid, blob) {
            if (!isSafeIdToken(draftId) || !isSafeIdToken(obsUid) || !(blob instanceof Blob)) {
                return Promise.reject(new Error('Invalid photo record identity or blob'));
            }
            return blobToArrayBuffer(blob).then(function(buffer) {
                return openAppDatabase().then(function(db) {
                    return new Promise(function(resolve, reject) {
                        var record = {
                            id: draftId + ':' + obsUid,
                            draftId: draftId,
                            obsUid: obsUid,
                            buffer: buffer,
                            mimeType: blob.type || 'image/jpeg',
                            size: blob.size,
                            updatedAt: new Date().toISOString(),
                            schemaVersion: PHOTO_RECORD_SCHEMA_VERSION
                        };
                        var tx;
                        try {
                            tx = db.transaction(IDB_STORE, 'readwrite');
                        } catch (e) {
                            reject(e);
                            return;
                        }
                        tx.objectStore(IDB_STORE).put(record);
                        tx.oncomplete = function() { resolve(record); };
                        tx.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB write failed')); };
                        tx.onabort = function(ev) { reject((ev.target && ev.target.error) || new Error('IndexedDB write aborted')); };
                    });
                });
            });
        }

        function getEbPhoto(draftId, obsUid) {
            if (!isSafeIdToken(draftId) || !isSafeIdToken(obsUid)) {
                return Promise.reject(new Error('Invalid photo record identity'));
            }
            return openAppDatabase().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx;
                    try {
                        tx = db.transaction(IDB_STORE, 'readonly');
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    var req = tx.objectStore(IDB_STORE).get(draftId + ':' + obsUid);
                    req.onsuccess = function() {
                        resolve(normalizePhotoRecord(req.result));
                    };
                    req.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB read failed')); };
                });
            });
        }

        function deleteEbPhoto(draftId, obsUid) {
            if (!isSafeIdToken(draftId) || !isSafeIdToken(obsUid)) {
                return Promise.reject(new Error('Invalid photo record identity'));
            }
            return openAppDatabase().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx;
                    try {
                        tx = db.transaction(IDB_STORE, 'readwrite');
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    tx.objectStore(IDB_STORE).delete(draftId + ':' + obsUid);
                    tx.oncomplete = function() { resolve(); };
                    tx.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB delete failed')); };
                    tx.onabort = function(ev) { reject((ev.target && ev.target.error) || new Error('IndexedDB delete aborted')); };
                });
            });
        }

        function getEbPhotosForDraft(draftId) {
            if (!isSafeIdToken(draftId)) {
                return Promise.reject(new Error('Invalid draft identity'));
            }
            return openAppDatabase().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var valid = Object.create(null);
                    var present = Object.create(null);
                    var tx;
                    try {
                        tx = db.transaction(IDB_STORE, 'readonly');
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    var req = tx.objectStore(IDB_STORE).index('byDraft').getAll(draftId);
                    req.onsuccess = function() {
                        var list = req.result || [];
                        for (var i = 0; i < list.length; i++) {
                            var raw = list[i];
                            if (!raw || !isSafeIdToken(raw.obsUid)) continue;
                            var rec = normalizePhotoRecord(raw);
                            present[raw.obsUid] = rec || raw;
                            if (rec && rec.blob instanceof Blob) valid[raw.obsUid] = rec;
                        }
                        resolve({ valid: valid, present: present });
                    };
                    req.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB read failed')); };
                });
            });
        }

        function getEbPhotoStatsForDraft(draftId) {
            if (!isSafeIdToken(draftId)) {
                return Promise.reject(new Error('Invalid draft identity'));
            }
            return openAppDatabase().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx;
                    try {
                        tx = db.transaction(IDB_STORE, 'readonly');
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    var req = tx.objectStore(IDB_STORE).index('byDraft').getAll(draftId);
                    req.onsuccess = function() {
                        var list = req.result || [];
                        var bytes = 0;
                        for (var i = 0; i < list.length; i++) {
                            if (list[i] && typeof list[i].size === 'number') bytes += list[i].size;
                        }
                        resolve({ count: list.length, bytes: bytes });
                    };
                    req.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB read failed')); };
                });
            });
        }

        function deleteEbPhotosForDraft(draftId) {
            return openAppDatabase().then(function(db) {
                return new Promise(function(resolve, reject) {
                    var tx;
                    try {
                        tx = db.transaction(IDB_STORE, 'readwrite');
                    } catch (e) {
                        reject(e);
                        return;
                    }
                    var store = tx.objectStore(IDB_STORE);
                    var keysReq = store.index('byDraft').getAllKeys(draftId);
                    keysReq.onsuccess = function() {
                        var keys = keysReq.result || [];
                        for (var i = 0; i < keys.length; i++) store.delete(keys[i]);
                    };
                    keysReq.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB read failed')); };
                    tx.oncomplete = function() { resolve(); };
                    tx.onerror = function(ev) { reject(ev.target.error || new Error('IndexedDB delete failed')); };
                    tx.onabort = function(ev) { reject((ev.target && ev.target.error) || new Error('IndexedDB delete aborted')); };
                });
            });
        }

        function logStorageEstimate() {
            if (navigator.storage && typeof navigator.storage.estimate === 'function') {
                navigator.storage.estimate().then(function(info) {
                    console.info('[NPI SnapWalk] storage estimate quota=' + (info.quota || '?') + ' used=' + (info.usage || '?'));
                }).catch(function() {});
            }
        }
