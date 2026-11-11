        /* ============================================================
           RUN @ RATE CREATOR — PURE CALC ENGINE  (V4)
           Pure functions only; no DOM access. Each returns a plain
           object of named, unit-consistent results.
           Percentage user inputs are stored as percentage points and are
           converted to a decimal fraction (percentValue / 100) exactly
           once inside the engine. Returned A/P/Q/OEE, gaps (points) and
           ratios are decimal fractions / ratios.
           ============================================================ */
        var RunRateCalc = (function() {

            var PLAN_PERFORMANCE_REFERENCE = 1.00;

            function numOr(n, dflt) { return (n !== null && isFinite(n)) ? n : (dflt === undefined ? null : dflt); }
            function ratio(a, b) { return (b !== null && b !== 0 && isFinite(b)) ? a / b : null; }
            // Convert percentage points to a decimal fraction once.
            function pctToRatio(points) {
                var n = numOr(points, 0) || 0;
                return n / 100;
            }
            // Apply a plus-percentage (service/flex/seasonal) to a base.
            function applyPlusPercent(base, points) {
                return base * (1 + pctToRatio(points));
            }

            /* ============================================================
               DEMAND (shared)
               distinguish customer calendar (Cust Days/Wk, Cust Wks/Yr) from
               production-line calendar. Demand and DPV use the customer
               calendar only.
               ============================================================ */
            function calcDemand(inp) {
                var source = inp.source || 'annual';
                var annualDemand = numOr(inp.annual, 0);
                var customerWeeksPerYear = numOr(inp.customerWeeksPerYear, 0);
                var enteredWeeklyDemand = numOr(inp.enteredWeeklyDemand, 0);
                var customerDaysPerWeek = numOr(inp.customerDaysPerWeek, 0);

                // Service/flex/seasonal entered as percentage points.
                var servicePercent = numOr(inp.servicePercent, 0) || 0;
                var volumeFlexPercent = numOr(inp.volumeFlexPercent, 0) || 0;
                var seasonalFlexPercent = numOr(inp.seasonalFlexPercent, 0) || 0;

                var baseDemandPerWeek = (source === 'weekly')
                    ? (enteredWeeklyDemand !== null ? enteredWeeklyDemand : null)
                    : (annualDemand > 0 && customerWeeksPerYear > 0)
                        ? annualDemand / customerWeeksPerYear : null;

                var adjustedDemandPerWeek = null;
                if (baseDemandPerWeek !== null) {
                    var v = baseDemandPerWeek;
                    // Apply service %, volume flex %, seasonal flex %.
                    v = applyPlusPercent(v, servicePercent);
                    v = applyPlusPercent(v, volumeFlexPercent);
                    v = applyPlusPercent(v, seasonalFlexPercent);
                    adjustedDemandPerWeek = v;
                }

                var dpv = (adjustedDemandPerWeek !== null && customerDaysPerWeek > 0)
                    ? adjustedDemandPerWeek / customerDaysPerWeek : null;

                return {
                    source: source,
                    baseDemandPerWeek: baseDemandPerWeek,
                    adjustedDemandPerWeek: adjustedDemandPerWeek,
                    dpv: dpv,
                    customerDaysPerWeek: customerDaysPerWeek,
                    customerWeeksPerYear: customerWeeksPerYear,
                    activeSourceText: (source === 'weekly')
                        ? 'Entered Weekly Demand (customer)' : 'Calculated from Annual Demand (customer)'
                };
            }

            /* ============================================================
               OPERATING PATTERN (production-line calendar)
               ============================================================ */
            function calcOperating(inp) {
                var shifts = numOr(inp.shifts, 0);
                var hours = numOr(inp.hours, 0);
                var breakMin = numOr(inp.breakMin, 0) || 0;
                var maintMin = numOr(inp.maintMin, 0) || 0;
                var prodDaysPerWeek = numOr(inp.prodDaysPerWeek, 0);
                var prodWeeksPerYear = numOr(inp.prodWeeksPerYear, 0);

                var netMinutesPerShift = (hours >= 0) ? hours * 60 - breakMin - maintMin : null;
                var netAvailableHoursPerWeek = (netMinutesPerShift !== null && shifts > 0 && prodDaysPerWeek > 0)
                    ? netMinutesPerShift * shifts * prodDaysPerWeek / 60 : null;

                var validationErrors = [];
                if (hours <= 0) validationErrors.push('Hrs/Shift must be > 0.');
                if (shifts <= 0) validationErrors.push('Shifts per Day must be > 0.');
                if (prodDaysPerWeek <= 0) validationErrors.push('Prod Days/Wk must be > 0.');
                if (prodWeeksPerYear <= 0) validationErrors.push('Prod Wks/Yr must be > 0.');
                if (netMinutesPerShift !== null && netMinutesPerShift < 0) validationErrors.push('Break + planned maintenance must be less than total shift minutes.');

                return {
                    netAvailableMinutesPerShift: netMinutesPerShift,
                    netAvailableHoursPerWeek: netAvailableHoursPerWeek,
                    prodDaysPerWeek: prodDaysPerWeek,
                    prodWeeksPerYear: prodWeeksPerYear,
                    shiftsPerDay: shifts,
                    validationErrors: validationErrors
                };
            }

            /* ============================================================
               PRODUCTION MIX
               ============================================================ */
            function calcMix(inp) {
                var totalSku = numOr(inp.totalSku, 0);
                var skuBatch = numOr(inp.skuQty, 0);
                var shiftBatch = numOr(inp.shiftQty, 0);
                var shiftsPerDay = numOr(inp.shiftsPerDay, 0);
                var prodDaysPerWeek = numOr(inp.prodDaysPerWeek, 0);

                var skuPerShift = null, averageShiftsPerSku = null, changeoversPerShift = null;
                var fullSkuCycleShifts = null, fullSkuCycleWeeks = null;
                if (skuBatch > 0 && shiftBatch > 0) {
                    skuPerShift = skuBatch / shiftBatch;
                    averageShiftsPerSku = shiftBatch / skuBatch;
                    changeoversPerShift = Math.max(0, skuPerShift - 1);
                    fullSkuCycleShifts = totalSku * shiftBatch / skuBatch;
                    if (shiftsPerDay > 0 && prodDaysPerWeek > 0) {
                        fullSkuCycleWeeks = fullSkuCycleShifts / (shiftsPerDay * prodDaysPerWeek);
                    }
                }
                return {
                    skuPerShift: skuPerShift,
                    averageShiftsPerSku: averageShiftsPerSku,
                    changeoversPerShift: changeoversPerShift,
                    fullSkuCycleShifts: fullSkuCycleShifts,
                    fullSkuCycleWeeks: fullSkuCycleWeeks
                };
            }

            /* ============================================================
               PLANNED LOSSES + PLANNED AVAILABILITY / QUALITY
               scrapPercent stored as points; converted /100 here.
               ============================================================ */
            function calcLosses(inp, op) {
                var changeoverMin = numOr(inp.changeoverMin, 0) || 0;
                var inspectionMin = numOr(inp.inspectionMinPerShift, 0) || 0;
                var breakdownMin = numOr(inp.breakdownMinPerShift, 0) || 0;
                var scrapPercent = numOr(inp.scrapPercent, 0) || 0;
                // V5: C/O per Shift is entered directly — no mix-derived mode.
                var effectiveChangeoversPerShift = numOr(inp.manualChangeoversPerShift, 0) || 0;

                var shiftsPerDay = numOr(op.shiftsPerDay, 0) || 0;
                var prodDaysPerWeek = numOr(op.prodDaysPerWeek, 0) || 0;

                var changeoverDowntimeHoursPerWeek = changeoverMin * effectiveChangeoversPerShift * shiftsPerDay * prodDaysPerWeek / 60;
                var inspectionDowntimeHoursPerWeek = inspectionMin * shiftsPerDay * prodDaysPerWeek / 60;
                var breakdownDowntimeHoursPerWeek = breakdownMin * shiftsPerDay * prodDaysPerWeek / 60;
                var totalProjectedDowntimeHoursPerWeek = changeoverDowntimeHoursPerWeek + inspectionDowntimeHoursPerWeek + breakdownDowntimeHoursPerWeek;

                var netAvailableHoursPerWeek = numOr(op.netAvailableHoursPerWeek, 0) || 0;
                var plannedAvailability = null;
                if (netAvailableHoursPerWeek > 0) {
                    plannedAvailability = Math.max(0, (netAvailableHoursPerWeek - totalProjectedDowntimeHoursPerWeek) / netAvailableHoursPerWeek);
                }
                var plannedQuality = 1 - pctToRatio(scrapPercent);

                return {
                    effectiveChangeoversPerShift: effectiveChangeoversPerShift,
                    changeoverDowntimeHoursPerWeek: changeoverDowntimeHoursPerWeek,
                    inspectionDowntimeHoursPerWeek: inspectionDowntimeHoursPerWeek,
                    breakdownDowntimeHoursPerWeek: breakdownDowntimeHoursPerWeek,
                    totalProjectedDowntimeHoursPerWeek: totalProjectedDowntimeHoursPerWeek,
                    plannedAvailability: plannedAvailability,
                    plannedQuality: plannedQuality
                };
            }

            /* ============================================================
               PLANNED BASELINE (customer takt, required CT, Machine capacity,
               weekly like-for-like Plan Ratio, margins)
               mcpCycleTimeSeconds is the Machine design cycle time.
               ============================================================ */
            function calcPlannedCapacity(inp, op, losses, demand) {
                var effectiveProductionHoursPerWeek = numOr(op.netAvailableHoursPerWeek, 0) || 0;
                if (effectiveProductionHoursPerWeek > 0 && (losses.totalProjectedDowntimeHoursPerWeek > 0)) {
                    effectiveProductionHoursPerWeek -= losses.totalProjectedDowntimeHoursPerWeek;
                }
                var mcpCycleTimeSeconds = numOr(inp.mcpCycleTimeSeconds, 0);
                var plannedQuality = (losses.plannedQuality !== null) ? losses.plannedQuality : 0;
                var adjustedDemandPerWeek = numOr(demand.adjustedDemandPerWeek, 0);
                var prodDaysPerWeek = numOr(op.prodDaysPerWeek, 0) || 0;

                // Net available production hours per week (before projected downtime).
                var plannedAvailableHoursPerWeek = numOr(op.netAvailableHoursPerWeek, 0) || 0;

                // Customer Takt — net AVAILABLE production hours over customer demand.
                var customerTaktSeconds = null;
                if (plannedAvailableHoursPerWeek > 0 && adjustedDemandPerWeek > 0) {
                    customerTaktSeconds = plannedAvailableHoursPerWeek * 3600 / adjustedDemandPerWeek;
                }

                // Required CT — CT to exactly cover customer demand at planned quality,
                // using EFFECTIVE (post-downtime) production hours.
                var requiredCycleTimeSeconds = null;
                if (effectiveProductionHoursPerWeek > 0 && adjustedDemandPerWeek > 0) {
                    requiredCycleTimeSeconds = effectiveProductionHoursPerWeek * 3600 * plannedQuality / adjustedDemandPerWeek;
                }

                // Planned capacity per week / day (good parts) at Machine CT.
                var plannedCapacityPerWeek = null, plannedCapacityPerDay = null;
                if (mcpCycleTimeSeconds > 0) {
                    plannedCapacityPerWeek = effectiveProductionHoursPerWeek * 3600 / mcpCycleTimeSeconds * plannedQuality;
                    plannedCapacityPerDay = (prodDaysPerWeek > 0) ? plannedCapacityPerWeek / prodDaysPerWeek : null;
                }

                // Governing weekly like-for-like ratio.
                var plannedCapacityRatio = ratio(plannedCapacityPerWeek, adjustedDemandPerWeek);
                var plannedCapacityMarginPerWeek = (plannedCapacityPerWeek !== null && adjustedDemandPerWeek !== null)
                    ? plannedCapacityPerWeek - adjustedDemandPerWeek : null;
                var plannedCapacityMarginPerDay = (plannedCapacityPerDay !== null && demand.dpv !== null)
                    ? plannedCapacityPerDay - demand.dpv : null;

                // Planned P (ref) is the 100% reference basis.
                var plannedPerformance = PLAN_PERFORMANCE_REFERENCE;
                // Only when a ratio can be formed.
                var projectedOee = null;
                if (plannedAvailabilityValid(losses) && plannedQuality !== null) {
                    projectedOee = losses.plannedAvailability * plannedPerformance * plannedQuality;
                }

                return {
                    effectiveProductionHoursPerWeek: effectiveProductionHoursPerWeek,
                    plannedAvailableHoursPerWeek: plannedAvailableHoursPerWeek,
                    customerTaktSeconds: customerTaktSeconds,
                    requiredCycleTimeSeconds: requiredCycleTimeSeconds,
                    mcpCycleTimeSeconds: mcpCycleTimeSeconds,
                    plannedPerformance: plannedPerformance,
                    plannedAvailability: losses.plannedAvailability,
                    plannedQuality: plannedQuality,
                    projectedOee: projectedOee,
                    plannedCapacityPerWeek: plannedCapacityPerWeek,
                    plannedCapacityPerDay: plannedCapacityPerDay,
                    plannedCapacityRatio: plannedCapacityRatio,
                    plannedCapacityMarginPerWeek: plannedCapacityMarginPerWeek,
                    plannedCapacityMarginPerDay: plannedCapacityMarginPerDay
                };
            }
            function plannedAvailabilityValid(losses) {
                return losses.plannedAvailability !== null && isFinite(losses.plannedAvailability);
            }

            /* ============================================================
               ACTUAL RUN (facts) — validation + per-part derived
               ============================================================ */
            function calcActualRun(inp) {
                var totalRunMinutes = numOr(inp.totalRunMinutes, 0) || 0;
                var actualBreakMinutes = numOr(inp.actualBreakMinutes, 0) || 0;
                var actualChangeoverInspectionMinutes = numOr(inp.actualChangeoverInspectionMinutes, 0) || 0;
                var actualUnplannedMinutes = numOr(inp.actualUnplannedMinutes, 0) || 0;
                var totalParts = numOr(inp.totalParts, 0) || 0;
                var rejectQuantity = numOr(inp.rejectQuantity, 0) || 0;
                // Good Qty is always derived: Parts Produced − Reject Qty. It is
                // never a user input, so it can never become inconsistent.
                var firstPassGoodParts = Math.max(0, totalParts - rejectQuantity);

                var totalDowntime = actualBreakMinutes + actualChangeoverInspectionMinutes + actualUnplannedMinutes;
                var netRunningMinutes = (totalRunMinutes > 0) ? Math.max(0, totalRunMinutes - totalDowntime) : 0;

                var validationErrors = [], validationWarnings = [];
                if (totalDowntime > totalRunMinutes && totalRunMinutes > 0) validationErrors.push('Total downtime exceeds total run duration.');
                if (rejectQuantity > totalParts) validationErrors.push('Rejected parts cannot exceed total parts run.');

                var actualCycleTimeSeconds = (netRunningMinutes > 0 && totalParts > 0)
                    ? netRunningMinutes * 60 / totalParts : null;
                var actualAvailability = (netRunningMinutes >= 0 && (totalRunMinutes - actualBreakMinutes) > 0)
                    ? netRunningMinutes / (totalRunMinutes - actualBreakMinutes) : null;
                var actualQuality = (totalParts > 0) ? firstPassGoodParts / totalParts : null;

                return {
                    totalRunMinutes: totalRunMinutes,
                    actualBreakMinutes: actualBreakMinutes,
                    actualChangeoverInspectionMinutes: actualChangeoverInspectionMinutes,
                    actualUnplannedMinutes: actualUnplannedMinutes,
                    totalParts: totalParts,
                    rejectQuantity: rejectQuantity,
                    firstPassGoodParts: firstPassGoodParts,
                    netRunningMinutes: netRunningMinutes,
                    actualCycleTimeSeconds: actualCycleTimeSeconds,
                    actualAvailability: actualAvailability,
                    actualQuality: actualQuality,
                    validationErrors: validationErrors,
                    validationWarnings: validationWarnings
                };
            }

            /* ============================================================
               ACTUAL RESULTS — actual P/OEE, actual Ship/Wk & Ship/Day,
               governing weekly like-for-like Actual Ratio, margins.
               mcpCycleTimeSeconds is the Machine design CT reference for
               actualPerformance.
               ============================================================ */
            function calcActualResults(run, op, demand, mcpCycleTimeSeconds, planRatio) {
                var netRunningMinutes = run.netRunningMinutes;
                var totalParts = run.totalParts;
                var firstPassGoodParts = run.firstPassGoodParts;

                var actualPerformance = null;
                if (netRunningMinutes > 0 && totalParts > 0 && mcpCycleTimeSeconds > 0) {
                    actualPerformance = mcpCycleTimeSeconds * totalParts / (netRunningMinutes * 60);
                }
                var actualOee = null;
                if (run.actualAvailability !== null && actualPerformance !== null && run.actualQuality !== null) {
                    actualOee = run.actualAvailability * actualPerformance * run.actualQuality;
                }

                var actualGoodPartsPerMinute = (netRunningMinutes > 0) ? firstPassGoodParts / netRunningMinutes : null;
                var netAvailableHoursPerWeek = numOr(op.netAvailableHoursPerWeek, 0) || 0;
                var weeklyAvailableProductionMinutes = netAvailableHoursPerWeek * 60;
                var actualShipPerWeek = (actualGoodPartsPerMinute !== null)
                    ? actualGoodPartsPerMinute * weeklyAvailableProductionMinutes : null;
                var prodDaysPerWeek = numOr(op.prodDaysPerWeek, 0) || 0;
                var actualShipPerDay = (actualShipPerWeek !== null && prodDaysPerWeek > 0)
                    ? actualShipPerWeek / prodDaysPerWeek : null;

                var adjustedDemandPerWeek = numOr(demand.adjustedDemandPerWeek, 0);
                var dpv = numOr(demand.dpv, 0);

                // Governing weekly like-for-like actual supply ratio.
                var actualCapacityRatio = ratio(actualShipPerWeek, adjustedDemandPerWeek);
                var actualPercentAboveBelowWeeklyDemand = (actualCapacityRatio !== null) ? actualCapacityRatio - 1 : null;

                var actualCapacityMarginPerWeek = (actualShipPerWeek !== null && adjustedDemandPerWeek !== null)
                    ? actualShipPerWeek - adjustedDemandPerWeek : null;
                var actualCapacityMarginPerDay = (actualShipPerDay !== null && dpv !== null)
                    ? actualShipPerDay - dpv : null;

                // Review flag: never cap actualPerformance at 100%.
                var reviewFlag = (actualPerformance !== null && actualPerformance > 1)
                    ? 'Review Machine CT or run data.' : '';

                return {
                    actualPerformance: actualPerformance,
                    actualOee: actualOee,
                    actualGoodPartsPerMinute: actualGoodPartsPerMinute,
                    weeklyAvailableProductionMinutes: weeklyAvailableProductionMinutes,
                    actualShipPerWeek: actualShipPerWeek,
                    actualShipPerDay: actualShipPerDay,
                    dpv: dpv,
                    adjustedDemandPerWeek: adjustedDemandPerWeek,
                    actualCapacityRatio: actualCapacityRatio,
                    actualPercentAboveBelowWeeklyDemand: actualPercentAboveBelowWeeklyDemand,
                    actualCapacityMarginPerWeek: actualCapacityMarginPerWeek,
                    actualCapacityMarginPerDay: actualCapacityMarginPerDay,
                    reviewFlag: reviewFlag
                };
            }

            /* ============================================================
               PLANNED vs ACTUAL COMPARISON + Machine VERIFICATION CHECKS
               No ground-cause invention — only gap detection.
               ============================================================ */
            function calcComparison(planned, run, actual, demand) {
                // Capacity gaps (weekly & daily).
                var capacityGapPerWeek = (actual.actualShipPerWeek !== null && planned.plannedCapacityPerWeek !== null)
                    ? actual.actualShipPerWeek - planned.plannedCapacityPerWeek : null;
                var capacityGapPercent = (actual.actualShipPerWeek !== null && planned.plannedCapacityPerWeek)
                    ? actual.actualShipPerWeek / planned.plannedCapacityPerWeek - 1 : null;
                var capacityGapPerDay = (actual.actualShipPerDay !== null && planned.plannedCapacityPerDay !== null)
                    ? actual.actualShipPerDay - planned.plannedCapacityPerDay : null;

                // CT gaps.
                var cycleTimeGapSeconds = (run.actualCycleTimeSeconds !== null && planned.mcpCycleTimeSeconds !== null)
                    ? run.actualCycleTimeSeconds - planned.mcpCycleTimeSeconds : null;
                var cycleTimeGapPercent = (run.actualCycleTimeSeconds !== null && planned.mcpCycleTimeSeconds)
                    ? run.actualCycleTimeSeconds / planned.mcpCycleTimeSeconds - 1 : null;

                // A / P / Q / OEE gaps (percentage-points).
                // Availability and quality live on the run record; the actual
                // results object does not carry them.
                var availabilityGapPoints = (run.actualAvailability !== null && planned.plannedAvailability !== null)
                    ? run.actualAvailability - planned.plannedAvailability : null;
                var performanceGapPoints = (actual.actualPerformance !== null && planned.plannedPerformance !== null)
                    ? actual.actualPerformance - planned.plannedPerformance : null;
                var qualityGapPoints = (run.actualQuality !== null && planned.plannedQuality !== null)
                    ? run.actualQuality - planned.plannedQuality : null;
                var oeeGapPoints = (actual.actualOee !== null && planned.projectedOee !== null)
                    ? actual.actualOee - planned.projectedOee : null;

                return {
                    capacityGapPerWeek: capacityGapPerWeek,
                    capacityGapPerDay: capacityGapPerDay,
                    capacityGapPercent: capacityGapPercent,
                    cycleTimeGapSeconds: cycleTimeGapSeconds,
                    cycleTimeGapPercent: cycleTimeGapPercent,
                    availabilityGapPoints: availabilityGapPoints,
                    performanceGapPoints: performanceGapPoints,
                    qualityGapPoints: qualityGapPoints,
                    oeeGapPoints: oeeGapPoints
                };
            }

            return {
                numOr: numOr,
                pctToRatio: pctToRatio,
                PLAN_PERFORMANCE_REFERENCE: PLAN_PERFORMANCE_REFERENCE,
                calcDemand: calcDemand,
                calcOperating: calcOperating,
                calcMix: calcMix,
                calcLosses: calcLosses,
                calcPlannedCapacity: calcPlannedCapacity,
                calcActualRun: calcActualRun,
                calcActualResults: calcActualResults,
                calcComparison: calcComparison
            };
        })();
