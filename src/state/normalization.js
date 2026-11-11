        /* ============================================================
           NORMALIZATION — V3→V4 and legacy line field mapping
           Transforms stored draft schemas to current V4 structure.
           ============================================================ */
function normalizeV3(p) {
    var v = rnrBlankV3Template();
    v.enabledLineCount = Math.max(1, Math.min(5, p.enabledLineCount || 1));
    v.activeLineIndex = Math.max(0, Math.min(v.enabledLineCount - 1, p.activeLineIndex || 0));
    mergeProject(p.project, v.project);
    mergeDemand(p.demand, v.demand);
    if (Array.isArray(p.lines)) {
        for (var i = 0; i < Math.min(5, p.lines.length); i++) {
            if (p.lines[i]) v.lines[i] = normalizeLine(p.lines[i], v.lines[i]);
        }
    }
    mergeConclusion(p.conclusion, v.conclusion);
    v.migrationReview = Array.isArray(p.migrationReview) ? p.migrationReview.slice() : [];
    return v;
}

function normalizeLine(src, dst) {
    var s = src || {};
    var out = dst || rnrBlankLine();
    var idt = out.identity;
    idt.processName = first(s.processName, s.identity && s.identity.processName, s.lineName, s.processDesc, s.identity && s.identity.lineName, s.identity && s.identity.process, '');
    idt.location = first(s.location, s.identity && s.identity.location, '');

    var op = s.op || (s.plannedInputs && s.plannedInputs.operating) || {};
    var oper = out.plannedInputs.operating;
    oper.shifts = num(op.shifts); oper.hours = num(op.hours);
    oper.breakMin = num(op.breakMin); oper.maintMin = num(op.maintMin);
    oper.prodDaysPerWeek = num(op.prodDaysPerWeek); if (oper.prodDaysPerWeek === null) oper.prodDaysPerWeek = num(op.days);
    oper.prodWeeksPerYear = num(op.prodWeeksPerYear); if (oper.prodWeeksPerYear === null) oper.prodWeeksPerYear = num(op.weeks);

    var mx = s.mix || (s.plannedInputs && s.plannedInputs.mix) || {};
    var mix = out.plannedInputs.mix;
    mix.totalSku = num(mx.totalSku);
    mix.skuQty = num(mx.skuQty); if (mix.skuQty === null) mix.skuQty = num(mx.skuBatch);
    mix.shiftQty = num(mx.shiftQty); if (mix.shiftQty === null) mix.shiftQty = num(mx.shiftBatch);

    var ls = s.losses || (s.plannedInputs && s.plannedInputs.losses) || {};
    var losses = out.plannedInputs.losses;
    losses.changeoverMin = num(ls.changeoverMin);
    losses.inspectionMinPerShift = num(ls.inspectionMinPerShift); if (losses.inspectionMinPerShift === null) losses.inspectionMinPerShift = num(ls.inspectionsMin);
    losses.breakdownMinPerShift = num(ls.breakdownMinPerShift); if (losses.breakdownMinPerShift === null) losses.breakdownMinPerShift = num(ls.breakdownMin);
    losses.scrapPercent = num(ls.scrapPercent); if (losses.scrapPercent === null) losses.scrapPercent = num(ls.scrapPct);
    losses.manualChangeoversPerShift = num(ls.manualChangeoversPerShift);
    if (losses.manualChangeoversPerShift === null) losses.manualChangeoversPerShift = num(ls.manualChangeovers);
    // V5: C/O per Shift is entered directly. Migrate legacy mix-derived changeovers.
    var legacyCalc = (ls.useCalculatedChangeovers !== undefined) ? !!ls.useCalculatedChangeovers : (ls.useCalcChangeover !== undefined ? !!ls.useCalcChangeover : false);
    if (legacyCalc && losses.manualChangeoversPerShift === null && mix.skuQty !== null && mix.shiftQty !== null && mix.shiftQty > 0) {
        losses.manualChangeoversPerShift = Math.max(0, mix.skuQty / mix.shiftQty - 1);
    }
    losses.useCalculatedChangeovers = false;

    out.plannedInputs.mcpCycleTimeSeconds = num(s.idealCycleTime);
    if (out.plannedInputs.mcpCycleTimeSeconds === null && s.plannedInputs && s.plannedInputs.mcpCycleTimeSeconds !== undefined) {
        out.plannedInputs.mcpCycleTimeSeconds = num(s.plannedInputs.mcpCycleTimeSeconds);
    }

    var rn = s.run || (s.actualInputs) || {};
    var ai = out.actualInputs;
    ai.totalRunMinutes = num(rn.totalRunMinutes);
    ai.actualBreakMinutes = num(rn.actualBreakMinutes); if (ai.actualBreakMinutes === null) ai.actualBreakMinutes = num(rn.plannedLunchBreakMaintenanceMinutes);
    ai.actualChangeoverInspectionMinutes = num(rn.actualChangeoverInspectionMinutes); if (ai.actualChangeoverInspectionMinutes === null) ai.actualChangeoverInspectionMinutes = num(rn.plannedChangeoverSetupInspectionMinutes);
    ai.actualUnplannedMinutes = num(rn.actualUnplannedMinutes); if (ai.actualUnplannedMinutes === null) ai.actualUnplannedMinutes = num(rn.unplannedDowntimeMinutes);
    ai.totalParts = num(rn.totalParts); if (ai.totalParts === null) ai.totalParts = num(rn.totalPartsRun);
    ai.rejectQuantity = num(rn.rejectQuantity); if (ai.rejectQuantity === null) ai.rejectQuantity = num(rn.rejectedParts);
    // Good Qty is always derived; fall back to any legacy value only if parts/reject are missing.
    ai.firstPassGoodParts = (ai.totalParts !== null && ai.rejectQuantity !== null)
        ? Math.max(0, ai.totalParts - ai.rejectQuantity) : num(rn.firstPassGoodParts);
    ai.rejectReason = first(rn.rejectReason, rn.reasonRejections, '');
    ai.runNote = first(rn.runNote, rn.runComment, '');
    // Tracking / gap fields.
    var tr = s.tracking || rn.tracking || {};
    out.tracking.gapReason = first(tr.gapReason, rn.gapReasonActive, '');
    out.tracking.correctiveAction = first(tr.correctiveAction, rn.correctiveAction, '');
    return out;
}