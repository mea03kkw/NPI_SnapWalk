        /* ============================================================
           R@R STATE FACTORIES — blank structures for initialization
           ============================================================ */

/* ---------- blank structures ---------- */
function rnrBlankLine() {
    return {
        identity: { processName: '', location: '' },
        /* Stage 1: Machine Planned inputs */
        plannedInputs: {
            operating: { shifts: null, hours: null, breakMin: null, maintMin: null,
                         prodDaysPerWeek: null, prodWeeksPerYear: null },
            mix: { totalSku: null, skuQty: null, shiftQty: null },
            losses: { changeoverMin: null, inspectionMinPerShift: null, breakdownMinPerShift: null,
                      scrapPercent: null, useCalculatedChangeovers: false, manualChangeoversPerShift: null },
            mcpCycleTimeSeconds: null
        },
        /* Stage 2: Actual Run inputs */
        actualInputs: {
            totalRunMinutes: null, actualBreakMinutes: null, actualChangeoverInspectionMinutes: null,
            actualUnplannedMinutes: null, totalParts: null, rejectQuantity: null, firstPassGoodParts: null,
            rejectReason: '', runNote: ''
        },
        /* Stage 3: gap reason / actions (user filled on detected gap) */
        tracking: { gapReason: '', correctiveAction: '' }
    };
}
function rnrBlankInput() {
    return {
        project: { projectName: '', product: '', buildIdentity: '', twelveNc: '', supplier: '',
                   site: '', siteLocation: '', vendorCode: '', productionOrder: '',
                   buildDate: '', visitorName: '', factoryLine: '', specialRemark: '' },
        demand: { source: 'weekly', annual: null, customerWeeksPerYear: null,
                  enteredWeeklyDemand: null, customerDaysPerWeek: null,
                  servicePercent: 0, volumeFlexPercent: 0, seasonalFlexPercent: 0 },
        enabledLineCount: 1,
        activeLineIndex: 0,
        lines: [rnrBlankLine(), rnrBlankLine(), rnrBlankLine(), rnrBlankLine(), rnrBlankLine()],
        conclusion: { reRunRequired: '', summary: '' },
        migrationReview: []
    };
}

function rnrBlankV3Template() {
    var input = rnrBlankInput();
    return {
        version: 4, timestamp: new Date().toISOString(),
        enabledLineCount: 1, activeLineIndex: 0,
        project: input.project, demand: input.demand,
        lines: input.lines, conclusion: input.conclusion, migrationReview: []
    };
}