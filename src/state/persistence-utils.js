        /* ============================================================
           PERSISTENCE UTILITY HELPERS — field merge and type conversion
           Used by migration normalization functions.
           ============================================================ */
function first() { for (var i = 0; i < arguments.length; i++) { if (arguments[i] !== undefined && arguments[i] !== null && arguments[i] !== '') return arguments[i]; } return ''; }
function num(x) { var v = parseFloat(x); return isFinite(v) ? v : null; }

function mergeProject(src, dst) {
    if (!src) return;
    ['projectName','product','buildIdentity','twelveNc','supplier','site','siteLocation',
     'vendorCode','productionOrder','buildDate','visitorName','factoryLine','specialRemark'].forEach(function(k){
        if (src[k] !== undefined && src[k] !== '') dst[k] = src[k];
    });
    // Combine legacy Site + Site Location into the single Factory / Location / Line field.
    if (!dst.factoryLine && (dst.site || dst.siteLocation)) {
        dst.factoryLine = [dst.site, dst.siteLocation].filter(Boolean).join(' / ');
    }
}
function mergeDemand(src, dst) {
    if (!src) return;
    if (src.source === 'weekly' || src.source === 'annual') dst.source = src.source;
    dst.annual = num(src.annual);
    dst.customerWeeksPerYear = num(src.customerWeeksPerYear);
    dst.enteredWeeklyDemand = num(src.enteredWeeklyDemand);
    dst.customerDaysPerWeek = num(src.customerDaysPerWeek);
    dst.servicePercent = num(src.servicePercent) || 0;
    dst.volumeFlexPercent = num(src.volumeFlexPercent) || 0;
    dst.seasonalFlexPercent = num(src.seasonalFlexPercent) || 0;
    // Accept any V3 legacy field names that may still be present.
    if (dst.customerWeeksPerYear === null && src.weeks !== undefined) dst.customerWeeksPerYear = num(src.weeks);
    if (dst.enteredWeeklyDemand === null && src.enteredWeekly !== undefined) dst.enteredWeeklyDemand = num(src.enteredWeekly);
    if (dst.customerDaysPerWeek === null && src.days !== undefined) dst.customerDaysPerWeek = num(src.days);
    if (dst.servicePercent === 0 && src.servicePct) dst.servicePercent = num(src.servicePct) || 0;
    if (dst.volumeFlexPercent === 0 && src.volumePct) dst.volumeFlexPercent = num(src.volumePct) || 0;
    if (dst.seasonalFlexPercent === 0 && src.seasonalPct) dst.seasonalFlexPercent = num(src.seasonalPct) || 0;
}

function mergeConclusion(src, dst) {
    if (!src) return;
    if (src.reRunRequired) dst.reRunRequired = src.reRunRequired;
    if (src.summary) dst.summary = src.summary;
}