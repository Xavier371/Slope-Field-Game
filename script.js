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
        go: document.getElementById('go')
    };

    // --- World coordinates state (window) ---
    const defaultWorld = { xMin: -5, xMax: 5, yMin: -5, yMax: 5 };
    let world = { ...defaultWorld };

    // --- Preprocess equation to support implicit multiplication like "xy" -> "x*y", "2x" -> "2*x", etc. ---
    function preprocessEquation(equation) {
        let s = equation.trim();
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
        s = s.replace(/\)\s*(?=(?:[0-9xy]|${fn})\b)/gi, ')*');
        // number/variable/closing paren immediately before a function name: 2sin, xcos, )exp -> insert *
        s = s.replace(new RegExp(`([0-9xy\)])\s*(?=${fn}\\b)`, 'gi'), '$1*');
        // Function name followed by bare variable: sin x -> sin(x)
        s = s.replace(new RegExp(`\\b(${fn})\\s*([xy])`, 'gi'), '$1($2)');
        // closing and opening parenthesis: )( -> )*(
        s = s.replace(/\)\s*\(/g, ')*(');
        return s;
    }

    // Ensure canvas is square and scaled for device pixel ratio
    function ensureCanvasSize() {
        const dpr = window.devicePixelRatio || 1;
        // Force square CSS box if aspect-ratio unsupported
        const cssW = canvas.clientWidth || canvas.width;
        canvas.style.height = cssW + 'px';
        const cssH = canvas.clientHeight || canvas.height;
        const needW = Math.floor(cssW * dpr);
        const needH = Math.floor(cssH * dpr);
        if (canvas.width !== needW || canvas.height !== needH) {
            canvas.width = needW;
            canvas.height = needH;
        }
        // Reset transform and scale drawing to CSS pixels
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.scale(dpr, dpr);
        return { cssWidth: cssW, cssHeight: cssH };
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
        if (okDiv) { okDiv.style.display = 'none'; okDiv.textContent = ''; }
        if (noteDiv) { noteDiv.style.display = 'none'; noteDiv.textContent = ''; }

        // --- 2a. Reject undefined/invalid characters upfront ---
        const invalidChar = /[^0-9a-zA-Z_\+\-\*\/\^\(\)\.\s]/.test(equationStr);
        if (invalidChar) {
            // Blank the screen and show error
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            // Disable overlay state so nothing draws
            highlightedSegment = -1;
            startPoint = null;
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
            // Blank the screen and show error
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            highlightedSegment = -1;
            startPoint = null;
            if (errorDiv) {
                errorDiv.textContent = 'Try another function: invalid or unsupported expression.';
                errorDiv.style.display = 'block';
            }
            return;
        }

        // --- 3. Setup canvas and coordinate transformation ---
        const { cssWidth, cssHeight } = ensureCanvasSize();
        const width = cssWidth;
        const height = cssHeight;
        ctx.clearRect(0, 0, width, height);

        const xRange = xMax - xMin;
        const yRange = yMax - yMin;
        const xPixelScale = width / xRange;
        const yPixelScale = height / yRange;

        // --- Coordinate transformation functions ---
        const toCanvasX = (x) => (x - xMin) * xPixelScale;
        const toCanvasY = (y) => height - (y - yMin) * yPixelScale;

        // --- 4. Draw grid and axes ---
        drawAxes(toCanvasX, toCanvasY);
        
        // --- 5. Draw the direction field ---
        const arrowLength = 0.4; // In world coordinates
        const stepX = xRange / gridDensity;
        const stepY = yRange / gridDensity;

        for (let x = xMin; x <= xMax; x += stepX) {
            for (let y = yMin; y <= yMax; y += stepY) {
                try {
                    let slope = f(x, y);
                    const cx = toCanvasX(x);
                    const cy = toCanvasY(y);
                    if (!Number.isFinite(cx) || !Number.isFinite(cy)) continue;
                    let angle;
                    if (!Number.isFinite(slope)) {
                        // represent undefined/vertical slopes as vertical arrows
                        angle = Math.PI / 2; // up; signless since direction field is unoriented
                    } else if (Math.abs(slope) > 1e6) {
                        angle = Math.sign(slope) >= 0 ? Math.PI / 2 : -Math.PI / 2;
                    } else {
                        angle = Math.atan(slope);
                    }
                    drawArrow(cx, cy, angle, arrowLength * xPixelScale);
                } catch (_) {
                    // Skip cells that error
                }
            }
        }

        // Draw highlight and start point overlay on top of field
        drawHighlightAndStart();
        // If not initialized yet, force-init once
        if (!startPoint || highlightedSegment < 0) {
            randomizeGame();
            // Re-draw overlay (field already drawn)
            drawHighlightAndStart();
        }
        // store field function for Go
        currentField = f;
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

    function drawAxes(toCanvasX, toCanvasY) {
        ctx.beginPath();
        ctx.strokeStyle = '#aaa';
        ctx.lineWidth = 1;
        // X-Axis
        ctx.moveTo(0, toCanvasY(0));
        ctx.lineTo(canvas.width, toCanvasY(0));
        // Y-Axis
        ctx.moveTo(toCanvasX(0), 0);
        ctx.lineTo(toCanvasX(0), canvas.height);
        ctx.stroke();

        // Axis labels
        ctx.fillStyle = '#555';
        ctx.font = '12px Arial';
        ctx.fillText('x', canvas.width - 15, toCanvasY(0) - 10);
        ctx.fillText('y', toCanvasX(0) + 10, 15);
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
    let highlightedSegment = -1; // 0..7
    let startPoint = null; // {x, y} in world units
    let animFrame = null;
    let currentField = null;
    let isAnimating = false;

    function drawHighlightAndStart() {
        if (!startPoint && highlightedSegment < 0) return;
        const width = canvas.width;
        const height = canvas.height;

        // Highlight chosen edge half-segment
        if (highlightedSegment >= 0) {
            const midX = width / 2;
            const midY = height / 2;
            ctx.save();
            // Highlighter-style filled rectangle (thicker, no stroke glow)
            const band = Math.floor(Math.min(width, height) * 0.12); // 12% thickness of canvas
            ctx.fillStyle = 'rgba(255, 235, 59, 0.35)';
            switch (highlightedSegment) {
                case 0: ctx.fillRect(0, 0, midX, band); break; // top-left half (across top)
                case 1: ctx.fillRect(midX, 0, width - midX, band); break; // top-right half
                case 2: ctx.fillRect(0, height - band, midX, band); break; // bottom-left half
                case 3: ctx.fillRect(midX, height - band, width - midX, band); break; // bottom-right half
                case 4: ctx.fillRect(0, 0, band, midY); break; // left-top half
                case 5: ctx.fillRect(0, midY, band, height - midY); break; // left-bottom half
                case 6: ctx.fillRect(width - band, 0, band, midY); break; // right-top half
                case 7: ctx.fillRect(width - band, midY, band, height - midY); break; // right-bottom half
            }
            ctx.restore();
        }

        // Draw starting point
        if (startPoint) {
            const sx = (startPoint.x - world.xMin) * (canvas.width / (world.xMax - world.xMin));
            const sy = canvas.height - (startPoint.y - world.yMin) * (canvas.height / (world.yMax - world.yMin));
            ctx.beginPath();
            ctx.fillStyle = 'crimson';
            ctx.arc(sx, sy, 6, 0, Math.PI * 2);
            ctx.fill();
        }
    }

    function randomizeGame() {
        // Random start strictly inside the box
        const margin = 0.1;
        const rx = world.xMin + margin * (world.xMax - world.xMin) + Math.random() * (1 - 2 * margin) * (world.xMax - world.xMin);
        const ry = world.yMin + margin * (world.yMax - world.yMin) + Math.random() * (1 - 2 * margin) * (world.yMax - world.yMin);
        startPoint = { x: rx, y: ry };
        highlightedSegment = Math.floor(Math.random() * 8);
        plotVectorField();
        drawHighlightAndStart();
        const msg = document.getElementById('error-message');
        if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
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
        if (isAnimating && animFrame) cancelAnimationFrame(animFrame);
        isAnimating = true;

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

        let px = startPoint.x;
        let py = startPoint.y;
        const step = (world.xMax - world.xMin) / 420; // small world step for smooth motion

        ctx.save();
        ctx.strokeStyle = 'red';
        ctx.lineWidth = 2;
        ctx.beginPath();
        let cx0 = (px - world.xMin) * (canvas.width / (world.xMax - world.xMin));
        let cy0 = canvas.height - (py - world.yMin) * (canvas.height / (world.yMax - world.yMin));
        ctx.moveTo(cx0, cy0);

        const msg = document.getElementById('error-message');
        if (msg) { msg.style.display = 'none'; msg.textContent = ''; }

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

        function frame() {
            // Vector along field: v = (1, f(x,y)) normalized
            let slope;
            try { slope = f(px, py); } catch (_) { slope = NaN; }
            let vx, vy;
            if (Number.isFinite(slope)) {
                vx = 1; vy = slope;
            } else if (slope === Infinity || slope === -Infinity) {
                vx = 0; vy = Math.sign(slope) || 1;
            } else {
                // try small perturbation
                const eps = Math.max((world.yMax - world.yMin) * 1e-6, 1e-6);
                const s1 = f(px, py + eps);
                const s2 = f(px, py - eps);
                const s = Number.isFinite(s1) ? s1 : (Number.isFinite(s2) ? s2 : 0);
                vx = 1; vy = s;
            }
            const len = Math.hypot(vx, vy) || 1;
            const ux = (vx / len);
            const uy = (vy / len);

            // Compute exact intersection with box during this step
            let tHit = step + 1; // larger than step means no hit this frame
            if (ux > 0) tHit = Math.min(tHit, (world.xMax - px) / ux);
            if (ux < 0) tHit = Math.min(tHit, (world.xMin - px) / ux);
            if (uy > 0) tHit = Math.min(tHit, (world.yMax - py) / uy);
            if (uy < 0) tHit = Math.min(tHit, (world.yMin - py) / uy);

            if (tHit <= step && tHit >= 0) {
                // Clamp exactly to the wall
                px = px + ux * tHit;
                py = py + uy * tHit;
            } else {
                // Regular step
                px = px + ux * step;
                py = py + uy * step;
            }

            // Clamp numeric drift inside the box
            px = Math.min(Math.max(px, world.xMin), world.xMax);
            py = Math.min(Math.max(py, world.yMin), world.yMax);

            const seg = (tHit <= step && tHit >= 0) ? classifyExitAtWall(px, py) : segmentForExit(px, py);
            const cx = (px - world.xMin) * (canvas.width / (world.xMax - world.xMin));
            const cy = canvas.height - (py - world.yMin) * (canvas.height / (world.yMax - world.yMin));
            ctx.lineTo(cx, cy);
            ctx.stroke();
            // Moving red dot
            ctx.beginPath();
            ctx.fillStyle = 'crimson';
            ctx.arc(cx, cy, 4, 0, Math.PI * 2);
            ctx.fill();

            if (seg >= 0) {
                isAnimating = false;
                ctx.restore();
                const win = seg === highlightedSegment;
                const ok = document.getElementById('success-message');
                const note = document.getElementById('notice-message');
                // Clear all messages first
                if (msg) { msg.style.display = 'none'; msg.textContent = ''; }
                if (ok) { ok.style.display = 'none'; ok.textContent = ''; }
                if (note) { note.style.display = 'none'; note.textContent = ''; }

                if (win) {
                    if (ok) { ok.style.display = 'block'; ok.textContent = 'You Win!'; }
                } else {
                    if (note) { note.style.display = 'block'; note.textContent = 'Try another function.'; }
                }
                if (!win) {
                    // Reset view and overlay back to starting state
                    plotVectorField();
                    drawHighlightAndStart();
                }
                return;
            }
            animFrame = requestAnimationFrame(frame);
        }
        animFrame = requestAnimationFrame(frame);
    }

    // --- Add event listeners for automatic updates ---
    for (const key in inputs) {
        inputs[key].addEventListener('input', () => {
            // Stop animation and reset to original start on function change
            if (isAnimating && animFrame) cancelAnimationFrame(animFrame);
            isAnimating = false;
            if (startPoint) {
                // Redraw field and overlay from original start
                plotVectorField();
                drawHighlightAndStart();
            } else {
                plotVectorField();
            }
        });
    }

    // --- Pan (drag) interactions (disabled) ---
    // Grid dragging disabled per request
    function getScales() {
        const width = canvas.width;
        const height = canvas.height;
        const xRange = world.xMax - world.xMin;
        const yRange = world.yMax - world.yMin;
        return {
            xPixelScale: width / xRange,
            yPixelScale: height / yRange
        };
    }
    // ensure default cursor (not grab)
    canvas.style.cursor = 'default';

    // Reset and Go buttons
    buttons.reset?.addEventListener('click', () => {
        if (isAnimating && animFrame) cancelAnimationFrame(animFrame);
        isAnimating = false;
        world = { ...defaultWorld };
        startPoint = null;
        highlightedSegment = -1;
        plotVectorField();
        randomizeGame();
    });

    function handleGo() {
        if (isAnimating && animFrame) cancelAnimationFrame(animFrame);
        isAnimating = false;
        if (!startPoint || highlightedSegment < 0) {
            randomizeGame();
        }
        // Always redraw field and overlay, then animate
        plotVectorField();
        goAlongField();
    }
    buttons.go?.addEventListener('click', handleGo);
    // Touch support for Go
    buttons.go?.addEventListener('touchend', (e) => { e.preventDefault(); handleGo(); });

    // Redraw on resize/rotation
    const onResize = () => {
        // keep current start/highlight; just re-render
        plotVectorField();
        drawHighlightAndStart();
    };
    if (typeof ResizeObserver !== 'undefined') {
        const ro = new ResizeObserver(() => onResize());
        ro.observe(canvas);
        window.addEventListener('orientationchange', onResize);
    } else {
        window.addEventListener('resize', onResize);
    }

    // Initial cursor style for panning
    canvas.style.cursor = 'grab';

    plotVectorField(); // Initial plot (randomize will be forced if needed)
});
