        /* ============================================================
           EXCEL SHARED HELPERS — used by both EB and R@R exports
           ============================================================ */
        function wrapH(text, widthChars, lineH) {
            var s = (text === null || text === undefined) ? '' : String(text);
            if (!s) return lineH || 12;
            var w = widthChars || 60;
            var lines = 1, col = 0;
            var words = s.split(/\s+/);
            for (var wi = 0; wi < words.length; wi++) {
                var len = words[wi].length;
                if (len >= w) { lines += Math.floor(len / w); col = len % w; }
                else if (col + (col ? 1 : 0) + len > w) { lines++; col = len; }
                else col += (col ? 1 : 0) + len;
            }
            return lines * (lineH || 12) + 6;
        }
