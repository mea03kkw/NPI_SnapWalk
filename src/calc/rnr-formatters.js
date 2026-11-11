        /* ============================================================
           R@R FORMATTING UTILITIES — display formatters for UI and gap table
           Pure functions: value in → string out. No DOM, no state.
           ============================================================ */
function rnrFmt(v, dec) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    dec = (dec === undefined ? 0 : dec);
    return Number(v.toFixed(dec)).toLocaleString();
}
function rnrFmtRate(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return (v * 100 % 1 === 0 ? (v * 100).toFixed(0) : (v * 100).toFixed(1)) + '%';
}
/* Compact, mobile-friendly formatters for the Gap Analysis table.
   Trailing ".0" is trimmed (63.0% -> 63%, +204.0% -> +204%, -37.0pt -> -37pt)
   and no thousands separators are used, to keep the table inside the viewport. */
function rnrCompact(v, dec) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    dec = (dec === undefined ? 0 : dec);
    return String(Number(v.toFixed(dec)));
}
function rnrCompactPct(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return rnrCompact(v * 100, 1) + '%';
}
function rnrCompactSignedPct(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var pct = v * 100;
    return (pct > 0 ? '+' : '') + rnrCompact(pct, 1) + '%';
}
function rnrCompactSigned(v, dec, suffix) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return (v > 0 ? '+' : '') + rnrCompact(v, dec) + (suffix || '');
}
function rnrCompactPoints(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var pts = v * 100;
    return (pts > 0 ? '+' : '') + rnrCompact(pts, 0) + 'pt';
}
/* Colour-code the Gap column so the table itself communicates performance.
   Direction-aware: a positive gap is good for supply/OEE rows but bad for CT
   (slower cycle time). Rules — green = better than Machine, grey = aligned (±1%),
   amber = minor gap (1-5%), red = significant gap (>5%). */
function rnrGapCls(kind, gap, ref) {
    if (gap === null || gap === undefined || !isFinite(gap)) return '';
    if (ref === null || ref === undefined || !isFinite(ref) || ref <= 0) return '';
    var rel = gap / ref;
    if (kind === 'ct') rel = -rel;
    if (rel >= 0.01) return 'gap-ok';
    if (rel <= -0.05) return 'gap-sig';
    if (rel <= -0.01) return 'gap-minor';
    return 'gap-neu';
}
function rnrGapAttr(kind, gap, ref) {
    var c = rnrGapCls(kind, gap, ref);
    return c ? ' class="' + c + '"' : '';
}
function rnrVal(id) {
    var el = document.getElementById(id);
    if (!el) return null;
    if (el.getAttribute && el.getAttribute('type') === 'number') {
        var v = parseFloat(el.value);
        return isFinite(v) ? v : null;
    }
    return el.value != null ? el.value : '';
}

/* Format a gap that is a decimal ratio (e.g. Availability gap) as +/- points. */
function rnrFmtPoints(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var pts = v * 100;
    return (pts > 0 ? '+' : '') + (pts % 1 === 0 ? pts.toFixed(0) : pts.toFixed(1)) + ' pt';
}