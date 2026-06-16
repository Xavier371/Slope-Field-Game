// --- Supabase setup ---
const SUPABASE_URL = 'https://searruwutinbfqhqxdjo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InNlYXJydXd1dGluYmZxaHF4ZGpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODE1NTYzOTIsImV4cCI6MjA5NzEzMjM5Mn0.61vmX4DtKSKVRtCfGJUNmHcbgZIFJUSX3sgxEhjSgeY';

let _supabaseClient = null;
function getSupabase() {
    if (!_supabaseClient) {
        try { _supabaseClient = window.supabase.createClient(SUPABASE_URL, SUPABASE_KEY); }
        catch (_) {}
    }
    return _supabaseClient;
}

function getUsername() {
    let name = localStorage.getItem('sfg_username');
    if (!name) {
        name = prompt('Enter your username to track your times:') || 'anonymous';
        localStorage.setItem('sfg_username', name.trim() || 'anonymous');
    }
    return localStorage.getItem('sfg_username');
}

async function submitTime(levelId, elapsedMs) {
    const db = getSupabase();
    if (!db) return;
    const username = getUsername();
    await db.from('slope_completions').insert({ username, level_id: levelId, elapsed_ms: elapsedMs });
}

document.addEventListener('DOMContentLoaded', () => {
    const canvas = document.getElementById('vector-field-canvas');
    const ctx = canvas.getContext('2d');
    
    // --- Get all input elements ---
    const inputs = {
        equation: document.getElementById('equation')
    };

    // --- Control buttons ---
    const buttons = {
        reset: document.getElementById('reset'),
        help: document.getElementById('help'),
        closeHelp: null
    };

    // --- World coordinates state (window) ---
    const defaultWorld = { xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
    let world = { ...defaultWorld };

    // CSS pixel size of the canvas (updated by ensureCanvasSize; used for all drawing coords)
    let _cssPx = 480;

    // --- Convert canvas client coordinates to world coordinates ---
    function canvasClientToWorld(clientX, clientY) {
        const rect = canvas.getBoundingClientRect();
        const fracX = (clientX - rect.left) / rect.width;
        const fracY = (clientY - rect.top) / rect.height;
        return {
            x: world.xMin + fracX * (world.xMax - world.xMin),
            y: world.yMax - fracY * (world.yMax - world.yMin)
        };
    }

    function clampToWorld(pos) {
        return {
            x: Math.min(Math.max(pos.x, world.xMin), world.xMax),
            y: Math.min(Math.max(pos.y, world.yMin), world.yMax)
        };
    }

    // --- Post-game drag state ---
    let isDraggingPoint = false;

    // --- Preprocess equation to support implicit multiplication like "xy" -> "x*y", "2x" -> "2*x", etc. ---
    function preprocessEquation(equation) {
        let s = (equation || '').toLowerCase().trim();
        const fn = '(?:sin|cos|tan|sec|csc|cot|asin|acos|atan|sinh|cosh|tanh|asinh|acosh|atanh|exp|log|ln|sqrt)';
        // Insert * between:
        // number and variable: 2x -> 2*x
        s = s.replace(/(\d)\s*([xy])/gi, '$1*$2');
        // variable and number: x2 -> x*2
        s = s.replace(/([xy])\s*(\d)/gi, '$1*$2');
        // variable and variable: xy -> x*y
        s = s.replace(/([xy])\s*([xy])/gi, '$1*$2');
        // number/variable/closing paren before opening paren: 2(, x(, y(, )( -> multiply
        s = s.replace(/([0-9xy\)])\s*\(/gi, '$1*(');
        // closing parenthesis and number/variable/function: )x, )2, )sin -> )*x, )*2, )*sin
        s = s.replace(new RegExp(`\\)\\s*(?=(?:[0-9xy]|${fn})\\b)`, 'gi'), ')*');
        // number/variable/closing paren immediately before a function name: 2sin, xcos, )exp -> insert *
        s = s.replace(new RegExp(`([0-9xy\)])\s*(?=${fn}\\b)`, 'gi'), '$1*');
        // Function name followed by bare variable: sin x -> sin(x)
        s = s.replace(new RegExp(`\\b(${fn})\\s*([xy])`, 'gi'), '$1($2)');
        // Map ln(x) -> log(x) (natural log). Keep log(x) as natural log; allow log(x, base) unchanged.
        s = s.replace(/\bln\s*\(/gi, 'log(');
        // closing and opening parenthesis: )( -> )*(
        s = s.replace(/\)\s*\(/g, ')*(');
        return s;
    }

    // --- Immediate static path rendering in both directions ---
    function renderStaticTrace() {
        if (!startPoint) return;

        // Use compiled field if available; otherwise compile from input
        let f = currentField;
        if (typeof f !== 'function') {
            try {
                const preprocessed = preprocessEquation((inputs.equation.value || '0').trim() || '0');
                const node = math.parse(preprocessed);
                const compiled = node.compile();
                f = (x, y) => compiled.evaluate({ x, y });
            } catch (_) {
                const msg = document.getElementById('error-message');
                if (msg) { msg.textContent = 'Try another function: invalid or unsupported expression.'; msg.style.display = 'block'; }
                return;
            }
        }

        // Step size controls smoothness
        const isPhone = window.innerWidth <= 520;
        const step = (world.xMax - world.xMin) / (isPhone ? 140 : 220);

        // If starting on a non-finite slope, gently nudge
        const finiteAt = (x, y) => {
            try { return toFinite(f(x, y)) != null; } catch (_) { return false; }
        };
        if (!finiteAt(startPoint.x, startPoint.y)) {
            const span = Math.max(world.xMax - world.xMin, world.yMax - world.yMin);
            const eps = span * 1e-3;
            const offsets = [[eps,0],[-eps,0],[0,eps],[0,-eps],[eps,eps],[-eps,eps],[eps,-eps],[-eps,-eps]];
            for (const [dx, dy] of offsets) {
                const nx = Math.min(Math.max(startPoint.x + dx, world.xMin), world.xMax);
                const ny = Math.min(Math.max(startPoint.y + dy, world.yMin), world.yMax);
                if (finiteAt(nx, ny)) { startPoint = { x: nx, y: ny }; break; }
            }
        }

        const viewW = _cssPx || 480;
        const viewH = _cssPx || viewW;
        const toPx = (x, y) => ([
            (x - world.xMin) * (viewW / (world.xMax - world.xMin)),
            viewH - (y - world.yMin) * (viewH / (world.yMax - world.yMin))
        ]);

        function classifyExitAtWall(x, y) {
            const span = Math.max(world.xMax - world.xMin, world.yMax - world.yMin);
            const tol = span * 1e-6;
            const midX = (world.xMin + world.xMax) / 2;
            const midY = (world.yMin + world.yMax) / 2;
            if (Math.abs(y - world.yMax) <= tol) return x <= midX ? 0 : 1;
            if (Math.abs(y - world.yMin) <= tol) return x <= midX ? 2 : 3;
            if (Math.abs(x - world.xMin) <= tol) return y >= midY ? 4 : 5;
            if (Math.abs(x - world.xMax) <= tol) return y >= midY ? 6 : 7;
            return -1;
        }

        function trace(dir) {
            let x = startPoint.x;
            let y = startPoint.y;
            let [px, py] = toPx(x, y);
            let seg = -1;
            let steps = 0;
            const maxSteps = 8000;

            ctx.beginPath();
            ctx.moveTo(px, py);
            while (steps < maxSteps) {
                steps++;
                let rawSlope = null;
                try { rawSlope = f(x, y); } catch (_) { rawSlope = null; }
                if (rawSlope === Infinity || rawSlope === -Infinity) { seg = classifyExitAtWall(x, y); break; }
                let slope = toFinite(rawSlope);
                if (slope == null) {
                    const span = Math.max(world.xMax - world.xMin, world.yMax - world.yMin);
                    const eps = span * 1e-3;
                    const offsets = [[eps,0],[-eps,0],[0,eps],[0,-eps],[eps,eps],[-eps,eps],[eps,-eps],[-eps,-eps]];
                    let recovered = false;
                    for (const [dx, dy] of offsets) {
                        try {
                            const rs = f(x + dx, y + dy);
                            if (rs === Infinity || rs === -Infinity) { slope = null; break; }
                            const num = toFinite(rs);
                            if (num != null) { slope = num; recovered = true; break; }
                        } catch (_) {}
                    }
                    if (!recovered || slope == null) { seg = classifyExitAtWall(x, y); break; }
                }

                let vx = dir;
                let vy = dir * slope;
                const len = Math.hypot(vx, vy) || 1;
                const ux = vx / len;
                const uy = vy / len;

                let tHit = step + 1;
                if (ux > 0) tHit = Math.min(tHit, (world.xMax - x) / ux);
                if (ux < 0) tHit = Math.min(tHit, (world.xMin - x) / ux);
                if (uy > 0) tHit = Math.min(tHit, (world.yMax - y) / uy);
                if (uy < 0) tHit = Math.min(tHit, (world.yMin - y) / uy);

                let nx, ny;
                if (tHit <= step && tHit >= 0) { nx = x + ux * tHit; ny = y + uy * tHit; }
                else { nx = x + ux * step; ny = y + uy * step; }

                nx = Math.min(Math.max(nx, world.xMin), world.xMax);
                ny = Math.min(Math.max(ny, world.yMin), world.yMax);

                const [cx, cy] = toPx(nx, ny);
                ctx.lineTo(cx, cy);

                x = nx; y = ny;
                if (tHit <= step && tHit >= 0) { seg = classifyExitAtWall(x, y); break; }
                if (x <= world.xMin || x >= world.xMax || y <= world.yMin || y >= world.yMax) { seg = classifyExitAtWall(x, y); break; }
            }
            ctx.stroke();
            return seg;
        }

        // Clear messages before rendering and set stroke style
        const msg = document.getElementById('error-message');
        const ok = document.getElementById('success-message');
        const note = document.getElementById('notice-message');
        if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
        if (ok && !awaitingUserAction) { ok.style.display = 'none'; ok.textContent = ''; }
        if (note) { note.style.display = 'none'; note.textContent = ''; }

        ctx.save();
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        const segF = trace(1);
        const segB = trace(-1);

        ctx.restore();

        // Evaluate win/lose
        const exits = [segF, segB].sort();
        const targets = [highlightedSegment, highlightedSegmentB].sort();
        const isWin = exits.length === 2 && exits[0] === targets[0] && exits[1] === targets[1];
        if (isWin && !awaitingUserAction) {
            onPuzzleSolved();
        } else if (!isWin && !awaitingUserAction) {
            if (note) { note.style.display = 'block'; note.textContent = 'Try another function.'; }
        }

        // Keep start dot and highlights on top
        drawHighlightAndStart();
    }

    // Ensure canvas is square and crisp on all screens (handles devicePixelRatio)
    function ensureCanvasSize() {
        const dpr = window.devicePixelRatio || 1;
        const parent = canvas.parentElement;
        const isLandscapeMobile = window.innerWidth > window.innerHeight && window.innerHeight <= 620;
        let cssTarget;
        if (isLandscapeMobile) {
            // Canvas height = viewport height minus top/bottom padding
            cssTarget = Math.max(150, window.innerHeight - 24);
        } else {
            const parentW = (parent && parent.clientWidth > 0) ? parent.clientWidth
                          : Math.min(window.innerWidth - 48, 480);
            const isPhone = window.innerWidth <= 520;
            cssTarget = Math.max(240, Math.min(parentW, isPhone ? 360 : 480));
        }
        _cssPx = cssTarget;
        const phyTarget = Math.round(cssTarget * dpr);
        if (canvas.width !== phyTarget || canvas.height !== phyTarget) {
            canvas.width  = phyTarget;
            canvas.height = phyTarget;
            canvas.style.width  = cssTarget + 'px';
            canvas.style.height = cssTarget + 'px';
        }
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        return { pxWidth: cssTarget, pxHeight: cssTarget };
    }

    const plotVectorField = () => {
        // --- 1. Get user inputs and clear errors ---
        const rawEq = (inputs.equation.value || '').trim();
        // Treat empty input as 0 internally, but do NOT change the visible input value
        const equationStr = rawEq || '0';
        const xMin = world.xMin;
        const xMax = world.xMax;
        const yMin = world.yMin;
        const yMax = world.yMax;
        const gridDensity = 20;

        const errorDiv = document.getElementById('error-message');
        if (errorDiv) { errorDiv.style.display = 'none'; errorDiv.textContent = ''; }
        const okDiv = document.getElementById('success-message');
        const noteDiv = document.getElementById('notice-message');
        if (okDiv && !awaitingUserAction) { okDiv.style.display = 'none'; okDiv.textContent = ''; }
        if (noteDiv) { noteDiv.style.display = 'none'; noteDiv.textContent = ''; }

        // --- 2a. Reject undefined/invalid characters upfront (allow comma for log(x, base)) ---
        const invalidChar = /[^0-9a-zA-Z_,\+\-\*\/\^\(\)\.\s]/.test(equationStr);
        if (invalidChar) {
            // Do NOT change dot or highlight; just show error and leave current frame as-is
            if (errorDiv) {
                errorDiv.textContent = 'Try another function: invalid or unsupported expression.';
                errorDiv.style.display = 'block';
            }
            return;
        }

        // --- 2. Parse equation ---
        let f;
        try {
            const preprocessed = preprocessEquation(equationStr);
            const node = math.parse(preprocessed);
            const compiled = node.compile();
            f = (x, y) => compiled.evaluate({ x, y });
        } catch (err) {
            // Do NOT change dot or highlight; just show error
            if (errorDiv) {
                errorDiv.textContent = 'Try another function: invalid or unsupported expression.';
                errorDiv.style.display = 'block';
            }
            return;
        }

        // --- 3. Setup canvas and coordinate transformation ---
        const { pxWidth, pxHeight } = ensureCanvasSize();
        const width = pxWidth;
        const height = pxHeight;
        ctx.clearRect(0, 0, width, height);

        const xRange = xMax - xMin;
        const yRange = yMax - yMin;
        const xPixelScale = width / xRange;
        const yPixelScale = height / yRange;

        // --- Coordinate transformation functions ---
        const toCanvasX = (x) => (x - xMin) * xPixelScale;
        const toCanvasY = (y) => height - (y - yMin) * yPixelScale;

        const toFiniteNumber = toFinite;

        // --- 4. Draw grid and axes ---
        drawAxes(toCanvasX, toCanvasY, width, height);
        
        // --- 5. Draw the direction field ---
        const arrowLength = 0.4; // In world coordinates
        const stepX = xRange / gridDensity;
        const stepY = yRange / gridDensity;

        // Helper to get a usable slope for arrows: use same predicate as tracing
        const neighborSlope = (x, y) => {
            try {
                const raw = f(x, y);
                if (raw === Infinity || raw === -Infinity) return { s: null, infinite: true };
                const num = toFinite(raw);
                if (num != null) return { s: num, infinite: false };
            } catch (_) {}
            const span = Math.max(xRange, yRange);
            const eps = span * 1e-3;
            const offsets = [[eps,0],[-eps,0],[0,eps],[0,-eps],[eps,eps],[-eps,eps],[eps,-eps],[-eps,-eps]];
            for (const [dx, dy] of offsets) {
                const nx = x + dx;
                const ny = y + dy;
                try {
                    const raw = f(nx, ny);
                    if (raw === Infinity || raw === -Infinity) return { s: null, infinite: true };
                    const num = toFinite(raw);
                    if (num != null) return { s: num, infinite: false };
                } catch (_) {}
            }
            return { s: null, infinite: false };
        };

        for (let x = xMin; x <= xMax; x += stepX) {
            for (let y = yMin; y <= yMax; y += stepY) {
                try {
                    const { s: slope, infinite } = neighborSlope(x, y);
                    const cx = toCanvasX(x);
                    const cy = toCanvasY(y);
                    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
                    if (infinite || slope == null) continue;
                    const angle = Math.abs(slope) > 1e6 ? (Math.sign(slope) >= 0 ? Math.PI/2 : -Math.PI/2) : Math.atan(slope);
                    drawArrow(cx, cy, angle, arrowLength * xPixelScale);
                } catch (_) {
                    // Skip cells that error
                }
            }
        }

        // Draw highlight and start point overlay on top of field
        drawHighlightAndStart();
        // If not initialized yet, force-init once and return early
        // (randomizeGame handles all drawing internally)
        if (!startPoint || highlightedSegment < 0) {
            randomizeGame();
            return;
        }
        // store field function for rendering
        currentField = f;
        // Render trace unless we are mid-reset (prevents game starting won)
        if (startPoint && !isResetting) {
            renderStaticTrace();
        }
    };

    function plotSolutionCurve(f, x0, y0, xMin, xMax, yMin, yMax, toCanvasX, toCanvasY) {
        const f_ode = (x, y) => [f(x, y[0])];

        const points = [];

        function safeSolve(start, end, xsCount, ode, mapX) {
            try {
                const solver = numeric.dopri(start, end, [y0], ode);
                const xs = numeric.linspace(start, end, xsCount);
                const ys = solver.at(xs);
                const seg = [];
                for (let i = 0; i < xs.length; i++) {
                    const xx = mapX ? mapX(xs[i]) : xs[i];
                    const yVal = Array.isArray(ys[i]) ? ys[i][0] : ys[i];
                    if (Number.isFinite(xx) && Number.isFinite(yVal)) seg.push([xx, yVal]);
                }
                return seg;
            } catch (_) {
                return [];
            }
        }

        // forward from x0 to xMax
        if (xMax > x0) {
            points.push(...safeSolve(x0, xMax, 600, f_ode));
        }
        // backward from x0 to xMin
        if (xMin < x0) {
            const sMax = x0 - xMin;
        const f_ode_neg = (s, y) => [-f(x0 - s, y[0])];
            points.unshift(...safeSolve(0, sMax, 600, f_ode_neg, (s) => x0 - s));
        }

        // Fallback: if solver produced too few points, use RK4 sampling
        if (points.length < 5) {
            const rkPoints = [];
            const N = 800;
            const stepFwd = (xMax - x0) / N;
            let yF = y0;
            for (let i = 0; i <= N; i++) {
                const x = x0 + i * stepFwd;
                if (x < xMin || x > xMax) continue;
                rkPoints.push([x, yF]);
                const k1 = f(x, yF);
                const k2 = f(x + stepFwd / 2, yF + (stepFwd / 2) * k1);
                const k3 = f(x + stepFwd / 2, yF + (stepFwd / 2) * k2);
                const k4 = f(x + stepFwd, yF + stepFwd * k3);
                yF = yF + (stepFwd / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
            }

            const stepBwd = (x0 - xMin) / N;
            let yB = y0;
            const rkNeg = [];
            for (let i = 0; i <= N; i++) {
                const x = x0 - i * stepBwd;
                if (x < xMin || x > xMax) continue;
                rkNeg.push([x, yB]);
                const h = -stepBwd;
                const k1 = f(x, yB);
                const k2 = f(x + h / 2, yB + (h / 2) * k1);
                const k3 = f(x + h / 2, yB + (h / 2) * k2);
                const k4 = f(x + h, yB + h * k3);
                yB = yB + (h / 6) * (k1 + 2 * k2 + 2 * k3 + k4);
            }

            rkNeg.reverse();
            points.length = 0;
            points.push(...rkNeg, ...rkPoints);
        }

        if (points.length === 0) return;

        // Draw in two segments to ensure we don't connect across gaps
        ctx.beginPath();
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        let started = false;
        let lastX = null;
        let lastY = null;
        const xRange = xMax - xMin;
        const yRange = yMax - yMin;
        for (const [x, y] of points) {
            // Skip/outside world bounds create a break in the path
            if (!Number.isFinite(x) || !Number.isFinite(y) || x < xMin || x > xMax || y < yMin || y > yMax) {
                started = false;
                lastX = lastY = null;
                continue;
            }
            // Break segments on large jumps (discontinuities or solver blow-ups)
            if (lastX !== null && (Math.abs(x - lastX) > 0.25 * xRange || Math.abs(y - lastY) > 0.25 * yRange)) {
                started = false;
            }
            const cx = toCanvasX(x);
            const cy = toCanvasY(y);
            if (!Number.isFinite(cx) || !Number.isFinite(cy)) { started = false; lastX = lastY = null; continue; }
            if (!started) { ctx.moveTo(cx, cy); started = true; }
            else { ctx.lineTo(cx, cy); }
            lastX = x; lastY = y;
        }
        ctx.stroke();
    }

    function drawAxes(toCanvasX, toCanvasY, width, height) {
        // --- Nice tick step ---
        function niceStep(range) {
            const rough = range / 8;
            const mag = Math.pow(10, Math.floor(Math.log10(rough)));
            const norm = rough / mag;
            if (norm <= 1.5) return mag;
            if (norm <= 3.5) return 2 * mag;
            if (norm <= 7.5) return 5 * mag;
            return 10 * mag;
        }
        function fmtLabel(val, step) {
            const dec = Math.max(0, -Math.floor(Math.log10(step)));
            return val.toFixed(dec);
        }

        const xStep = niceStep(world.xMax - world.xMin);
        const yStep = niceStep(world.yMax - world.yMin);
        const xStart = Math.ceil(world.xMin / xStep) * xStep;
        const yStart = Math.ceil(world.yMin / yStep) * yStep;

        // --- Grid lines ---
        ctx.save();
        ctx.strokeStyle = '#edf0f8';
        ctx.lineWidth = 1;
        for (let x = xStart; x <= world.xMax + xStep * 0.01; x += xStep) {
            const cx = toCanvasX(x);
            if (!Number.isFinite(cx)) continue;
            ctx.beginPath(); ctx.moveTo(cx, 0); ctx.lineTo(cx, height); ctx.stroke();
        }
        for (let y = yStart; y <= world.yMax + yStep * 0.01; y += yStep) {
            const cy = toCanvasY(y);
            if (!Number.isFinite(cy)) continue;
            ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(width, cy); ctx.stroke();
        }
        ctx.restore();

        // --- Axes ---
        ctx.save();
        ctx.strokeStyle = '#9098b8';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        if (world.yMin <= 0 && 0 <= world.yMax) {
            ctx.moveTo(0, toCanvasY(0)); ctx.lineTo(width, toCanvasY(0));
        }
        if (world.xMin <= 0 && 0 <= world.xMax) {
            ctx.moveTo(toCanvasX(0), 0); ctx.lineTo(toCanvasX(0), height);
        }
        ctx.stroke();
        ctx.restore();

        // --- Tick labels ---
        const axisPixY = (world.yMin <= 0 && 0 <= world.yMax) ? toCanvasY(0) : height;
        const axisPixX = (world.xMin <= 0 && 0 <= world.xMax) ? toCanvasX(0) : 0;
        const labelY = Math.min(Math.max(axisPixY, 0), height - 14);
        const labelX = Math.min(Math.max(axisPixX, 30), width);

        ctx.save();
        ctx.fillStyle = '#9098b8';
        ctx.font = '10px "Segoe UI", system-ui, sans-serif';

        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        for (let x = xStart; x <= world.xMax + xStep * 0.01; x += xStep) {
            if (Math.abs(x) < xStep * 0.01) continue;
            const cx = toCanvasX(x);
            if (!Number.isFinite(cx) || cx < 16 || cx > width - 16) continue;
            ctx.fillText(fmtLabel(x, xStep), cx, labelY + 3);
        }

        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';
        for (let y = yStart; y <= world.yMax + yStep * 0.01; y += yStep) {
            if (Math.abs(y) < yStep * 0.01) continue;
            const cy = toCanvasY(y);
            if (!Number.isFinite(cy) || cy < 10 || cy > height - 10) continue;
            ctx.fillText(fmtLabel(y, yStep), labelX - 4, cy);
        }

        // Axis letter labels
        ctx.fillStyle = '#555570';
        ctx.font = 'bold 12px "Segoe UI", system-ui, sans-serif';
        ctx.textAlign = 'center'; ctx.textBaseline = 'top';
        ctx.fillText('x', width - 8, Math.min(labelY + 3, height - 14));
        ctx.textAlign = 'left'; ctx.textBaseline = 'top';
        ctx.fillText('y', Math.min(labelX + 4, width - 10), 4);
        ctx.restore();
    }
    
    function drawArrow(x_px, y_px, angle, length) {
        ctx.beginPath();
        ctx.strokeStyle = 'dodgerblue';
        ctx.lineWidth = 1;

        // Correct for inverted canvas y-axis in angle
        const correctedAngle = -angle;

        const startX = x_px - (length / 2) * Math.cos(correctedAngle);
        const startY = y_px - (length / 2) * Math.sin(correctedAngle);
        const endX = x_px + (length / 2) * Math.cos(correctedAngle);
        const endY = y_px + (length / 2) * Math.sin(correctedAngle);

        ctx.moveTo(startX, startY);
        ctx.lineTo(endX, endY);
        
        // Arrowhead
        const headLength = 5;
        const headAngle = Math.PI / 6;
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - headLength * Math.cos(correctedAngle - headAngle), endY - headLength * Math.sin(correctedAngle - headAngle));
        ctx.moveTo(endX, endY);
        ctx.lineTo(endX - headLength * Math.cos(correctedAngle + headAngle), endY - headLength * Math.sin(correctedAngle + headAngle));

        ctx.stroke();
    }

    // --- Game state (random start + highlighted edge segment) ---
    let highlightedSegment = -1; // primary target 0..7
    let highlightedSegmentB = -1; // secondary target 0..7, distinct
    let startPoint = null; // {x, y} in world units
    let currentLevelId = null; // e.g. "2_-3_0_5"
    let currentField = null;
    let isResetting = false;
    let introLevelIndex = 0; // first 3 games are always the same fixed levels
    let awaitingUserAction = false; // block re-triggering win while auto-advancing

    // --- Timer state ---
    let timerStart = null;
    let timerInterval = null;

    function formatTime(ms) {
        const secs = Math.max(0, Math.floor(ms / 1000));
        const mins = Math.floor(secs / 60);
        const s    = secs % 60;
        return `${mins}:${String(s).padStart(2, '0')}`;
    }

    function updateTimerDisplay() {
        const el = document.getElementById('timer-display');
        if (!el || timerStart === null) return;
        el.textContent = formatTime(Date.now() - timerStart);
    }

    function startTimer() {
        timerStart = Date.now();
        if (timerInterval) clearInterval(timerInterval);
        timerInterval = setInterval(updateTimerDisplay, 1000);
        updateTimerDisplay();
    }

    function stopTimer() {
        if (timerInterval) { clearInterval(timerInterval); timerInterval = null; }
    }

    // --- Fetch and display the global average time for a level ---
    async function fetchAndShowAvg(levelId) {
        const el = document.getElementById('avg-display');
        if (!el) return;
        el.textContent = '…';
        const db = getSupabase();
        if (!db || !levelId) { el.textContent = '—'; return; }
        const { data } = await db.from('slope_completions').select('elapsed_ms').eq('level_id', levelId);
        if (data && data.length > 0) {
            const avg = Math.round(data.reduce((sum, r) => sum + r.elapsed_ms, 0) / data.length);
            el.textContent = formatTime(avg);
        } else {
            el.textContent = formatTime(0);
        }
    }

    // --- Update canvas cursor based on game state ---
    function updateCursor() {
        canvas.style.cursor = awaitingUserAction ? 'grab' : 'default';
    }

    // --- On puzzle solved: freeze game until Reset ---
    function onPuzzleSolved() {
        awaitingUserAction = true;
        const elapsed = timerStart !== null ? Date.now() - timerStart : 0;
        stopTimer();
        const ok = document.getElementById('success-message');
        if (ok) { ok.style.display = 'block'; ok.textContent = `Solved! Time: ${formatTime(elapsed)} — drag the point to explore, or press \u21BA Reset.`; }
        updateCursor();
        if (currentLevelId) submitTime(currentLevelId, elapsed).then(() => fetchAndShowAvg(currentLevelId));
    }

    // --- Advance targets only (keep start point, world, and equation) ---
    function advancePuzzleTargets() {
        const isUnwinnablePair = (a, b) => {
            const s = [a, b].sort().join(',');
            return s === '4,5' || s === '6,7';
        };
        highlightedSegment = Math.floor(Math.random() * 8);
        do {
            highlightedSegmentB = Math.floor(Math.random() * 8);
        } while (highlightedSegmentB === highlightedSegment || isUnwinnablePair(highlightedSegment, highlightedSegmentB));
        plotVectorField();
    }

    // --- Simulate a single trace direction without drawing; returns exit segment or -1 ---
    function simulateExit(f, sx, sy, dir) {
        const step = (world.xMax - world.xMin) / 220;
        let x = sx, y = sy;
        const maxSteps = 4000;
        const span = Math.max(world.xMax - world.xMin, world.yMax - world.yMin);
        const tol = span * 1e-6;
        const midX = (world.xMin + world.xMax) / 2;
        const midY = (world.yMin + world.yMax) / 2;

        function classifyExit(ex, ey) {
            if (Math.abs(ey - world.yMax) <= tol) return ex <= midX ? 0 : 1;
            if (Math.abs(ey - world.yMin) <= tol) return ex <= midX ? 2 : 3;
            if (Math.abs(ex - world.xMin) <= tol) return ey >= midY ? 4 : 5;
            if (Math.abs(ex - world.xMax) <= tol) return ey >= midY ? 6 : 7;
            return -1;
        }

        for (let i = 0; i < maxSteps; i++) {
            let rawSlope = null;
            try { rawSlope = f(x, y); } catch (_) { return -1; }
            if (rawSlope === Infinity || rawSlope === -Infinity) return classifyExit(x, y);
            const slope = toFinite(rawSlope);
            if (slope == null) return -1;

            const vx = dir, vy = dir * slope;
            const len = Math.hypot(vx, vy) || 1;
            const ux = vx / len, uy = vy / len;

            let tHit = step + 1;
            if (ux > 0) tHit = Math.min(tHit, (world.xMax - x) / ux);
            if (ux < 0) tHit = Math.min(tHit, (world.xMin - x) / ux);
            if (uy > 0) tHit = Math.min(tHit, (world.yMax - y) / uy);
            if (uy < 0) tHit = Math.min(tHit, (world.yMin - y) / uy);

            let nx, ny;
            if (tHit <= step && tHit >= 0) { nx = x + ux * tHit; ny = y + uy * tHit; }
            else { nx = x + ux * step; ny = y + uy * step; }

            nx = Math.min(Math.max(nx, world.xMin), world.xMax);
            ny = Math.min(Math.max(ny, world.yMin), world.yMax);
            x = nx; y = ny;

            if (tHit <= step && tHit >= 0) return classifyExit(x, y);
            if (x <= world.xMin || x >= world.xMax || y <= world.yMin || y >= world.yMax) return classifyExit(x, y);
        }
        return -1;
    }

    // --- Candidate library shared by solver and puzzle generator ---
    const CANDIDATES = [
                '0', '1', '-1', '2', '-2', '3', '-3', '0.5', '-0.5',
                'x', '-x', '2*x', '-2*x', 'x/2', '-x/2', '3*x', '-3*x',
                'y', '-y', '2*y', '-2*y', 'y/2', '-y/2', '3*y', '-3*y',
                'x+y', 'x-y', '-x+y', '-x-y',
                'x+2*y', '2*x+y', '-x+2*y', '-2*x+y', 'x-2*y', '2*x-y',
                'x/2+y', 'x+y/2', '-x/2+y', 'x-y/2', 'x/2-y', '-x+y/2',
                'x^2', '-x^2', 'x^2-1', '1-x^2',
                'y^2', '-y^2', 'x^2-y', 'y-x^2', 'x^2+y',
                'x*y', '-x*y', 'x*y+1', '-x*y+1',
                'sin(x)', '-sin(x)', 'cos(x)', '-cos(x)',
                'sin(y)', '-sin(y)', 'cos(y)', '-cos(y)',
                'sin(x)+y', 'cos(x)-y', 'x+sin(y)', 'x-cos(y)',
                'x^3', '-x^3', 'x^3-y', 'y-x^3',
                'x^2+y^2', '-(x^2+y^2)', 'x^2-y^2', 'y^2-x^2',
                '2*x+2*y', '-2*x-2*y', '2*x-2*y', '-2*x+2*y',
                'x/3', '-x/3', 'y/3', '-y/3',
                '(x+y)/2', '(x-y)/2', '(-x+y)/2',
            ];

    // --- Check if any candidate solves a given start + target pair ---
    function findSolution(sx, sy, segA, segB, skipEq) {
        const targets = [segA, segB].sort();
        const shuffled = CANDIDATES.slice().sort(() => Math.random() - 0.5);
        for (const cand of shuffled) {
            if (skipEq !== undefined && preprocessEquation(cand) === skipEq) continue;
            try {
                const compiled = math.parse(preprocessEquation(cand)).compile();
                const f = (x, y) => compiled.evaluate({ x, y });
                const exits = [simulateExit(f, sx, sy, 1), simulateExit(f, sx, sy, -1)].sort();
                if (exits[0] === targets[0] && exits[1] === targets[1]) return cand;
            } catch (_) {}
        }
        return null;
    }

    // --- Solve button ---
    function solveGame() {
        if (!startPoint) return;
        stopTimer();
        const solveBtn = document.getElementById('solve');
        const note = document.getElementById('notice-message');
        if (solveBtn) { solveBtn.disabled = true; solveBtn.textContent = 'Solving…'; }
        if (note) { note.style.display = 'none'; note.textContent = ''; }

        setTimeout(() => {
            const currentEq = preprocessEquation((inputs.equation.value || '').trim());
            const found = findSolution(startPoint.x, startPoint.y, highlightedSegment, highlightedSegmentB, currentEq);

            if (solveBtn) { solveBtn.disabled = false; solveBtn.innerHTML = 'Solve'; }

            if (found) {
                inputs.equation.value = found;
                showOverlay();
                awaitingUserAction = true;
                plotVectorField();
                updateCursor();
            } else {
                if (note) { note.style.display = 'block'; note.textContent = 'No simple solution found — try Reset for a new puzzle.'; }
            }
        }, 30);
    }

    // Helper: coerce math.js outputs to a finite JS number; otherwise return null
    function toFinite(val) {
        if (typeof val === 'number') return Number.isFinite(val) ? val : null;
        if (val == null) return null;
        if (typeof val === 'object') {
            // Complex numbers are invalid for slope
            if (typeof val.re === 'number' && typeof val.im === 'number') return null;
            try {
                if (math && typeof math.number === 'function') {
                    const n = math.number(val);
                    return Number.isFinite(n) ? n : null;
                }
            } catch (_) {
                return null;
            }
        }
        const n = Number(val);
        return Number.isFinite(n) ? n : null;
    }

    function toLatex(expr) {
        let s = (expr || '').trim() || '0';
        // Inverse trig first (must come before sin/cos/tan)
        s = s.replace(/\basin\b/g, '\\arcsin');
        s = s.replace(/\bacos\b/g, '\\arccos');
        s = s.replace(/\batan\b/g, '\\arctan');
        s = s.replace(/\basinh\b/g, '\\operatorname{arcsinh}');
        s = s.replace(/\bacosh\b/g, '\\operatorname{arccosh}');
        s = s.replace(/\batanh\b/g, '\\operatorname{arctanh}');
        // Trig & hyperbolic
        s = s.replace(/\bsin\b/g, '\\sin');
        s = s.replace(/\bcos\b/g, '\\cos');
        s = s.replace(/\btan\b/g, '\\tan');
        s = s.replace(/\bsec\b/g, '\\sec');
        s = s.replace(/\bcsc\b/g, '\\csc');
        s = s.replace(/\bcot\b/g, '\\cot');
        s = s.replace(/\bsinh\b/g, '\\sinh');
        s = s.replace(/\bcosh\b/g, '\\cosh');
        s = s.replace(/\btanh\b/g, '\\tanh');
        // Other functions
        s = s.replace(/\bexp\b/g, '\\exp');
        s = s.replace(/\bln\b/g, '\\ln');
        s = s.replace(/\blog\b/g, '\\log');
        s = s.replace(/\bsqrt\b/g, '\\sqrt');
        // Multiplication dot
        s = s.replace(/\*/g, ' \\cdot ');
        return s;
    }

    const eqOverlay = document.getElementById('eq-overlay');

    function updateEqOverlay() {
        if (!eqOverlay) return;
        const val = (inputs.equation.value || '').trim() || '0';
        if (typeof katex !== 'undefined') {
            try {
                katex.render(toLatex(val), eqOverlay, { throwOnError: false, displayMode: false });
            } catch (_) {
                eqOverlay.textContent = val;
            }
        } else {
            eqOverlay.textContent = val;
        }
    }

    function showOverlay() {
        updateEqOverlay();
        eqOverlay.style.display = 'flex';
        inputs.equation.style.color = 'transparent';
        inputs.equation.style.caretColor = 'transparent';
    }

    function hideOverlay() {
        eqOverlay.style.display = 'none';
        inputs.equation.style.color = '';
        inputs.equation.style.caretColor = '';
    }

    inputs.equation.addEventListener('focus', hideOverlay);
    inputs.equation.addEventListener('blur', showOverlay);

    function drawHighlightAndStart() {
        if (!startPoint && highlightedSegment < 0) return;
        const width = _cssPx;
        const height = _cssPx;

        // Highlight chosen edge half-segment
        const targets = [highlightedSegment, highlightedSegmentB].filter(v => v >= 0);
        if (targets.length > 0) {
            const midX = width / 2;
            const midY = height / 2;
            const band = 14; // px
            for (const seg of targets) {
                ctx.save();
                // Soft highlighter band
                ctx.fillStyle = 'rgba(255, 235, 59, 0.28)';
                ctx.strokeStyle = 'rgba(255, 235, 59, 0.9)';
                ctx.lineWidth = 4;
                ctx.lineCap = 'round';
                switch (seg) {
                    case 0: ctx.fillRect(0, 0, midX, band); ctx.beginPath(); ctx.moveTo(6, band/2); ctx.lineTo(midX - 6, band/2); ctx.stroke(); break;
                    case 1: ctx.fillRect(midX, 0, width - midX, band); ctx.beginPath(); ctx.moveTo(midX + 6, band/2); ctx.lineTo(width - 6, band/2); ctx.stroke(); break;
                    case 2: ctx.fillRect(0, height - band, midX, band); ctx.beginPath(); ctx.moveTo(6, height - band/2); ctx.lineTo(midX - 6, height - band/2); ctx.stroke(); break;
                    case 3: ctx.fillRect(midX, height - band, width - midX, band); ctx.beginPath(); ctx.moveTo(midX + 6, height - band/2); ctx.lineTo(width - 6, height - band/2); ctx.stroke(); break;
                    case 4: ctx.fillRect(0, 0, band, midY); ctx.beginPath(); ctx.moveTo(band/2, 6); ctx.lineTo(band/2, midY - 6); ctx.stroke(); break;
                    case 5: ctx.fillRect(0, midY, band, height - midY); ctx.beginPath(); ctx.moveTo(band/2, midY + 6); ctx.lineTo(band/2, height - 6); ctx.stroke(); break;
                    case 6: ctx.fillRect(width - band, 0, band, midY); ctx.beginPath(); ctx.moveTo(width - band/2, 6); ctx.lineTo(width - band/2, midY - 6); ctx.stroke(); break;
                    case 7: ctx.fillRect(width - band, midY, band, height - midY); ctx.beginPath(); ctx.moveTo(width - band/2, midY + 6); ctx.lineTo(width - band/2, height - 6); ctx.stroke(); break;
                }
                ctx.restore();
            }
        }

        // Draw starting point
        if (startPoint) {
            const sx = (startPoint.x - world.xMin) * (_cssPx / (world.xMax - world.xMin));
            const sy = _cssPx - (startPoint.y - world.yMin) * (_cssPx / (world.yMax - world.yMin));
            ctx.beginPath();
            ctx.fillStyle = 'crimson';
            ctx.arc(sx, sy, 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    // Integer grid points for start positions: [-4, 4] x [-4, 4]
    const GRID_COORDS = [-4, -3, -2, -1, 0, 1, 2, 3, 4];

    // Fixed intro levels — identical for every player on every page load
    // (0,0) with simple solutions: y'=-1, y'=1, y'=0
    const INTRO_LEVELS = [
        { x: 0, y: 0, segA: 0, segB: 3 },
        { x: 0, y: 0, segA: 1, segB: 2 },
        { x: 0, y: 0, segA: 4, segB: 6 },
    ];

    function randomizeGame() {
        // Keep awaitingUserAction = true during setup so renderStaticTrace
        // (called inside plotVectorField) cannot fire a win mid-reset.
        awaitingUserAction = true;
        currentLevelId = null;

        // Clear all messages manually since awaitingUserAction blocks plotVectorField from doing it
        ['success-message', 'error-message', 'notice-message'].forEach(id => {
            const el = document.getElementById(id);
            if (el) { el.style.display = 'none'; el.textContent = ''; }
        });

        // Use fixed intro levels for the first 3 games, then go random
        let usedIntro = false;
        if (introLevelIndex < INTRO_LEVELS.length) {
            const intro = INTRO_LEVELS[introLevelIndex];
            if (findSolution(intro.x, intro.y, intro.segA, intro.segB) !== null) {
                startPoint = { x: intro.x, y: intro.y };
                highlightedSegment  = intro.segA;
                highlightedSegmentB = intro.segB;
                const [lo, hi] = [Math.min(intro.segA, intro.segB), Math.max(intro.segA, intro.segB)];
                currentLevelId = `${intro.x}_${intro.y}_${lo}_${hi}`;
                introLevelIndex++;
                usedIntro = true;
            }
        }

        if (!usedIntro) {
            const isUnwinnablePair = (a, b) => { const s = [a, b].sort().join(','); return s === '4,5' || s === '6,7'; };
            let attempts = 0;
            while (attempts < 200) {
                attempts++;
                const rx = GRID_COORDS[Math.floor(Math.random() * GRID_COORDS.length)];
                const ry = GRID_COORDS[Math.floor(Math.random() * GRID_COORDS.length)];
                const segA = Math.floor(Math.random() * 8);
                let segB;
                do { segB = Math.floor(Math.random() * 8); }
                while (segB === segA || isUnwinnablePair(segA, segB));

                if (findSolution(rx, ry, segA, segB) !== null) {
                    startPoint = { x: rx, y: ry };
                    highlightedSegment  = segA;
                    highlightedSegmentB = segB;
                    const [lo, hi] = [Math.min(segA, segB), Math.max(segA, segB)];
                    currentLevelId = `${rx}_${ry}_${lo}_${hi}`;
                    break;
                }
            }
        }

        // Always reset equation to a random pick from {-1, 0, 1}
        const startEqs = ['-1', '0', '1'];
        inputs.equation.value = startEqs[Math.floor(Math.random() * startEqs.length)];

        // Draw field without trace first (win check blocked by isResetting)
        isResetting = true;
        plotVectorField();
        drawHighlightAndStart();
        isResetting = false;

        // Draw trace now — awaitingUserAction is still true so win check cannot fire
        renderStaticTrace();

        fetchAndShowAvg(currentLevelId);
        awaitingUserAction = false;
        updateCursor();
        startTimer();
    }

    function segmentForExit(x, y) {
        const midX = (world.xMin + world.xMax) / 2;
        const midY = (world.yMin + world.yMax) / 2;
        if (y > world.yMax) return x <= midX ? 1 : 0; // top halves reversed in pixel coords
        if (y < world.yMin) return x <= midX ? 2 : 3; // bottom halves
        if (x < world.xMin) return y >= midY ? 4 : 5; // left halves (top then bottom)
        if (x > world.xMax) return y >= midY ? 6 : 7; // right halves
        return -1;
    }

    function goAlongField() {
        if (!startPoint) return;
        // Deprecated animated mode; call static renderer instead
        return renderStaticTrace();

        // Use the last compiled field function from the plot
        let f = currentField;
        if (typeof f !== 'function') {
            // re-parse on demand
            try {
                const preprocessed = preprocessEquation((inputs.equation.value || '0').trim() || '0');
                const node = math.parse(preprocessed);
                const compiled = node.compile();
                f = (x, y) => compiled.evaluate({ x, y });
            } catch (_) {
                const msg = document.getElementById('error-message');
                if (msg) { msg.textContent = 'Try another function: invalid or unsupported expression.'; msg.style.display = 'block'; }
                return;
            }
        }

        // Step size (kept for compatibility but unused in static caller)
        const isPhone = window.innerWidth <= 520;
        const step = (world.xMax - world.xMin) / (isPhone ? 120 : 200);

        // Ensure start is in a finite-slope region; if not, nudge slightly
        const finiteAt = (x, y) => {
            try { return toFiniteNumber(f(x, y)) != null; } catch (_) { return false; }
        };
        if (!finiteAt(startPoint.x, startPoint.y)) {
            const span = Math.max(world.xMax - world.xMin, world.yMax - world.yMin);
            const eps = span * 1e-3;
            const offsets = [[eps,0],[-eps,0],[0,eps],[0,-eps],[eps,eps],[-eps,eps],[eps,-eps],[-eps,-eps]];
            for (const [dx, dy] of offsets) {
                const nx = Math.min(Math.max(startPoint.x + dx, world.xMin), world.xMax);
                const ny = Math.min(Math.max(startPoint.y + dy, world.yMin), world.yMax);
                if (finiteAt(nx, ny)) { startPoint = { x: nx, y: ny }; break; }
            }
        }

        // Clear messages
        const msg = document.getElementById('error-message');
        const ok = document.getElementById('success-message');
        const note = document.getElementById('notice-message');
        if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
        if (ok) { ok.style.display = 'none'; ok.textContent = ''; }
        if (note) { note.style.display = 'none'; note.textContent = ''; }

        // Two states: forward (+1) and backward (-1)
        const stateF = { x: startPoint.x, y: startPoint.y, dir: 1, done: false, seg: -1 };
        const stateB = { x: startPoint.x, y: startPoint.y, dir: -1, done: false, seg: -1 };

        // Last drawn pixel for each
        const viewW = _cssPx || 480;
        const viewH = _cssPx || viewW;
        let lastFx = (stateF.x - world.xMin) * (viewW / (world.xMax - world.xMin));
        let lastFy = viewH - (stateF.y - world.yMin) * (viewH / (world.yMax - world.yMin));
        let lastBx = lastFx;
        let lastBy = lastFy;

        ctx.save();
        ctx.strokeStyle = 'red';
        const strokeWidth = 2;
        ctx.lineWidth = strokeWidth;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        function classifyExitAtWall(x, y) {
            const tol = 1e-9;
            const midX = (world.xMin + world.xMax) / 2;
            const midY = (world.yMin + world.yMax) / 2;
            // top boundary: 0 = top-left, 1 = top-right
            if (Math.abs(y - world.yMax) <= tol) return x <= midX ? 0 : 1;
            if (Math.abs(y - world.yMin) <= tol) return x <= midX ? 2 : 3; // bottom halves
            if (Math.abs(x - world.xMin) <= tol) return y >= midY ? 4 : 5; // left halves
            if (Math.abs(x - world.xMax) <= tol) return y >= midY ? 6 : 7; // right halves
            return -1;
        }

        function stepState(st) {
            if (st.done) return;
            // Vector along field: v = (dir, dir*f(x,y)) normalized
            let rawSlope = null;
            try { rawSlope = f(st.x, st.y); } catch (_) { rawSlope = null; }
            if (rawSlope === Infinity || rawSlope === -Infinity) { st.done = true; return; }
            let slope = toFinite(rawSlope);
            if (slope == null) {
                // Try nearby samples to recover (cases like 0/0 that resolve nearby)
                const span = Math.max(world.xMax - world.xMin, world.yMax - world.yMin);
                const eps = span * 1e-3;
                const offsets = [[eps,0],[-eps,0],[0,eps],[0,-eps],[eps,eps],[-eps,eps],[eps,-eps],[-eps,-eps]];
                for (const [dx, dy] of offsets) {
                    try {
                        const rs = f(st.x + dx, st.y + dy);
                        if (rs === Infinity || rs === -Infinity) { slope = null; break; }
                        const num = toFinite(rs);
                        if (num != null) { slope = num; break; }
                    } catch (_) {}
                }
                if (slope == null) { st.done = true; return; }
            }
            let vx = st.dir;
            let vy = st.dir * slope;
            const len = Math.hypot(vx, vy) || 1;
            const ux = vx / len;
            const uy = vy / len;

            // Compute hit this frame
            let tHit = step + 1;
            if (ux > 0) tHit = Math.min(tHit, (world.xMax - st.x) / ux);
            if (ux < 0) tHit = Math.min(tHit, (world.xMin - st.x) / ux);
            if (uy > 0) tHit = Math.min(tHit, (world.yMax - st.y) / uy);
            if (uy < 0) tHit = Math.min(tHit, (world.yMin - st.y) / uy);

            let nx, ny;
            if (tHit <= step && tHit >= 0) { nx = st.x + ux * tHit; ny = st.y + uy * tHit; st.done = true; }
            else { nx = st.x + ux * step; ny = st.y + uy * step; }

            nx = Math.min(Math.max(nx, world.xMin), world.xMax);
            ny = Math.min(Math.max(ny, world.yMin), world.yMax);

            const cx = (nx - world.xMin) * (viewW / (world.xMax - world.xMin));
            const cy = viewH - (ny - world.yMin) * (viewH / (world.yMax - world.yMin));

            // Draw segment
            ctx.beginPath();
            if (st.dir === 1) { ctx.moveTo(lastFx, lastFy); ctx.lineTo(cx, cy); lastFx = cx; lastFy = cy; }
            else { ctx.moveTo(lastBx, lastBy); ctx.lineTo(cx, cy); lastBx = cx; lastBy = cy; }
            ctx.stroke();

            st.x = nx; st.y = ny;
            if (st.done) {
                st.seg = classifyExitAtWall(st.x, st.y);
            }
        }

        function frame() {
            stepState(stateF);
            stepState(stateB);

            // Draw moving dots on both paths with same radius as stroke to avoid perceived thickness mismatch
            ctx.beginPath();
            ctx.fillStyle = 'crimson';
            let cx = (stateF.x - world.xMin) * (viewW / (world.xMax - world.xMin));
            let cy = viewH - (stateF.y - world.yMin) * (viewH / (world.yMax - world.yMin));
            ctx.arc(cx, cy, strokeWidth, 0, Math.PI * 2);
            ctx.fill();
            ctx.beginPath();
            cx = (stateB.x - world.xMin) * (viewW / (world.xMax - world.xMin));
            cy = viewH - (stateB.y - world.yMin) * (viewH / (world.yMax - world.yMin));
            ctx.arc(cx, cy, strokeWidth, 0, Math.PI * 2);
            ctx.fill();

            if (stateF.done && stateB.done) {
                isAnimating = false;
                ctx.restore();
                const ok = document.getElementById('success-message');
                const note = document.getElementById('notice-message');
                // Determine win: exits must match both highlighted targets (order-agnostic)
                const exits = [stateF.seg, stateB.seg].sort();
                const targets = [highlightedSegment, highlightedSegmentB].sort();
                const isWin = exits.length === 2 && exits[0] === targets[0] && exits[1] === targets[1];
                if (ok) { ok.style.display = 'none'; ok.textContent = ''; }
                if (note) { note.style.display = 'none'; note.textContent = ''; }
                if (isWin) {
                    if (ok) { ok.style.display = 'block'; ok.textContent = 'You Win!'; }
                } else {
                    if (note) { note.style.display = 'block'; note.textContent = 'Try another function.'; }
                }
                return;
            }
            // no-op in static mode
        }
        // no-op in static mode
    }

    // --- Add event listeners for automatic updates ---
    for (const key in inputs) {
        inputs[key].addEventListener('input', () => {
            // Auto-lowercase the equation input for function names and variables
            if (key === 'equation') {
                const cur = inputs.equation.value;
                const lowered = cur.toLowerCase();
                if (cur !== lowered) inputs.equation.value = lowered;
            }
            updateEqOverlay(); // keep overlay content fresh; it shows on blur
            plotVectorField(); // calls renderStaticTrace internally
        });
    }

    // Solve button
    document.getElementById('solve')?.addEventListener('click', solveGame);

    // Reset button
    buttons.reset?.addEventListener('click', () => {
        world = { ...defaultWorld };
        isDraggingPoint = false;
        randomizeGame();
        updateCursor();
        showOverlay();
    });

    // Help modal wiring
    const helpOverlay = document.getElementById('help-overlay');
    const closeHelpBtn = document.getElementById('close-help');
    buttons.closeHelp = closeHelpBtn;
    const openHelp = () => {
        if (helpOverlay) helpOverlay.setAttribute('aria-hidden', 'false');
    };
    const closeHelp = () => {
        if (helpOverlay) helpOverlay.setAttribute('aria-hidden', 'true');
    };
    buttons.help?.addEventListener('click', openHelp);
    closeHelpBtn?.addEventListener('click', closeHelp);
    helpOverlay?.addEventListener('click', (e) => { if (e.target === helpOverlay) closeHelp(); });

    // Redraw on resize/rotation
    window.addEventListener('resize', () => {
        plotVectorField();
        drawHighlightAndStart();
        renderStaticTrace();
    });

    // --- Touch: post-game drag ---
    canvas.addEventListener('touchstart', (e) => {
        if (!awaitingUserAction || e.touches.length !== 1) return;
        e.preventDefault();
        isDraggingPoint = true;
        const pos = canvasClientToWorld(e.touches[0].clientX, e.touches[0].clientY);
        startPoint = clampToWorld(pos);
        plotVectorField();
    }, { passive: false });

    canvas.addEventListener('touchmove', (e) => {
        if (!isDraggingPoint || e.touches.length !== 1) return;
        e.preventDefault();
        const pos = canvasClientToWorld(e.touches[0].clientX, e.touches[0].clientY);
        startPoint = clampToWorld(pos);
        plotVectorField();
    }, { passive: false });

    canvas.addEventListener('touchend', () => {
        isDraggingPoint = false;
    });

    // --- Mouse: post-game drag (desktop) ---
    canvas.addEventListener('mousedown', (e) => {
        if (!awaitingUserAction) return;
        isDraggingPoint = true;
        canvas.style.cursor = 'grabbing';
        const pos = canvasClientToWorld(e.clientX, e.clientY);
        startPoint = clampToWorld(pos);
        plotVectorField();
    });

    window.addEventListener('mousemove', (e) => {
        if (!isDraggingPoint) return;
        const pos = canvasClientToWorld(e.clientX, e.clientY);
        startPoint = clampToWorld(pos);
        plotVectorField();
    });

    window.addEventListener('mouseup', () => {
        if (isDraggingPoint) {
            isDraggingPoint = false;
            updateCursor();
        }
    });

    plotVectorField(); // Initial plot (randomize will be forced if needed)
    if (startPoint) renderStaticTrace();
    showOverlay();
});
