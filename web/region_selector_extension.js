// BoxBox Extension - Modern ComfyUI v1.0 / v0.12.2+
import { app } from "../../scripts/app.js";
import { api } from "../../scripts/api.js";

console.log("[BoxBox] Loading extension (Modern API)...");

/**
 * While the Region+Mask dialog is open, steal plain M/B/Delete from ComfyUI.
 * Comfy binds M → Model Library; Delete → delete selected nodes (when focus leaks).
 * Capture-phase + stopImmediatePropagation wins over Comfy's bubble keybindHandler.
 * Range/color/number inputs are NOT treated as text fields (that was blocking M).
 */
const boxBoxHotkeys = {
    active: false,
    onMask: null,
    onBox: null,
    onDelete: null,
};

function isEditableTextTarget(el) {
    if (!el || el === document.body || el === document.documentElement) return false;
    if (el.isContentEditable) return true;
    const tag = (el.tagName || "").toUpperCase();
    if (tag === "TEXTAREA" || tag === "SELECT") return true;
    if (tag !== "INPUT") return false;
    const type = (el.type || "text").toLowerCase();
    return ["text", "search", "email", "url", "password", ""].includes(type);
}

function boxBoxStealComfyHotkeys(e) {
    if (!boxBoxHotkeys.active) return;
    if (e.ctrlKey || e.metaKey || e.altKey) return;

    const code = e.code || "";
    const key = (e.key || "").toLowerCase();
    const path0 = (typeof e.composedPath === "function" ? e.composedPath()[0] : null) || e.target;
    const typing = isEditableTextTarget(path0) || isEditableTextTarget(document.activeElement);

    const isM = code === "KeyM" || key === "m";
    const isB = code === "KeyB" || key === "b";
    const isDelete = e.key === "Delete" || code === "Delete" || e.key === "Backspace" || code === "Backspace";

    if (isM || isB) {
        // Real text typing: let the character through; Comfy also skips text inputs.
        if (typing) return;
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        if (isM) {
            console.log("[BoxBox] Hotkey M → Mask (Comfy Model Library blocked)");
            boxBoxHotkeys.onMask?.();
        } else {
            console.log("[BoxBox] Hotkey B → Box");
            boxBoxHotkeys.onBox?.();
        }
        return;
    }

    if (isDelete && !typing) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
        console.log("[BoxBox] Hotkey Delete/Backspace");
        boxBoxHotkeys.onDelete?.();
    }
}

window.addEventListener("keydown", boxBoxStealComfyHotkeys, true);

/**
 * Canvas Selector - Complete rectangle selection functionality
 * Based on canva_html code
 */

function initializeCanvasSelector(container, imageUrl, previousMetadata = null, hooks = null) {
    console.log("[CanvasSelector] Initializing with image:", imageUrl);
    console.log("[CanvasSelector] Previous metadata:", previousMetadata);
    const onCancelRequest = hooks && typeof hooks.onCancelRequest === 'function'
        ? hooks.onCancelRequest
        : null;

    // DOM element references (searched within container)
    const canvasContainer = container.querySelector('#canvas-container');
    const backgroundImage = container.querySelector('#background-image');
    const baseCoordinates = container.querySelector('#base-coordinates');
    const dimensionsInfo = container.querySelector('#dimensions-info');
    const currentDimensions = container.querySelector('#current-dimensions');
    const zoomInBtn = container.querySelector('#zoom-in-btn');
    const zoomOutBtn = container.querySelector('#zoom-out-btn');
    const zoomValue = container.querySelector('#zoom-value');
    const borderSlider = container.querySelector('#border-slider');
    const borderValue = container.querySelector('#border-value');
    const borderPositionRadios = container.querySelectorAll('input[name="border-position"]');
    const imageUpload = container.querySelector('#image-upload');
    const uploadBtn = container.querySelector('#upload-btn');

    if (!canvasContainer || !backgroundImage) {
        console.error("[CanvasSelector] Missing #canvas-container or #background-image in dialog DOM", {
            container, canvasContainer, backgroundImage, html: container?.innerHTML?.slice?.(0, 200)
        });
        throw new Error("BoxSelector dialog DOM incomplete (canvas/image missing)");
    }

    // Show the preview immediately; optional /region_selector/scale may replace it later
    if (imageUrl) {
        backgroundImage.src = imageUrl;
        backgroundImage.dataset.scaleFactor = backgroundImage.dataset.scaleFactor || "1";
    }

    // State variables
    let isDrawing = false;
    let isResizing = false;
    let isDragging = false;
    let resizingEdge = null;
    let startX = 0;
    let startY = 0;
    let rectStartX = 0;
    let rectStartY = 0;
    let rectStartWidth = 0;
    let rectStartHeight = 0;
    let dragOffsetX = 0;
    let dragOffsetY = 0;
    let currentRectangle = null;
    let currentBorderWidth = 0;
    let borderPosition = 'inside';
    let rectangleExists = false;

    // Base dimensions
    let baseWidth = 0;
    let baseHeight = 0;
    let baseX = 0;
    let baseY = 0;

    // Aspect Ratio Mode — default 1:1; overridden by localStorage if present
    let aspectRatioMode = "1:1";
    let aspectRatioValue = 1;

    // Fix Image Size - state tracking
    let displayScaleFactor = 1.0;  // Scale factor applied to preview
    let isImageFixed = false;       // True when image has been "fixed"

    // ========================================================
    // BOX LIMITS: stay inside the image + snap size to N pixels
    // ========================================================
    function getSnapStep() {
        let v = 1;
        try {
            if (hooks && typeof hooks.getSnap === 'function') v = parseInt(hooks.getSnap(), 10);
        } catch (e) { v = 1; }
        return Number.isFinite(v) && v > 1 ? v : 1;
    }

    // Display pixels per real image pixel, for each axis.
    // The preview can be drawn with a different scale in x and y,
    // so x and y are converted separately.
    function getAxisScales() {
        const serverScale = parseFloat(backgroundImage.dataset.scaleFactor || "1");
        const natW = backgroundImage.naturalWidth || backgroundImage.offsetWidth || 1;
        const natH = backgroundImage.naturalHeight || backgroundImage.offsetHeight || 1;
        let sx = serverScale * (backgroundImage.offsetWidth / natW);
        let sy = serverScale * (backgroundImage.offsetHeight / natH);
        if (!(Number.isFinite(sx) && sx > 0)) sx = 1;
        if (!(Number.isFinite(sy) && sy > 0)) sy = sx;
        return { sx, sy };
    }
    function getTotalScale() { return getAxisScales().sx; }

    // Snap a display length so the real length is a multiple of `snap`
    function snapDisplayLength(len, maxLen, scale, snap) {
        if (snap <= 1) return Math.min(len, maxLen);
        const maxMult = Math.floor(maxLen / scale / snap + 0.01) * snap;
        if (maxMult < snap) return maxLen; // image side smaller than one step
        let real = Math.round(len / scale / snap) * snap;
        real = Math.max(snap, Math.min(real, maxMult));
        return real * scale;
    }

    // anchorX: 'left' | 'right' — the side that must not move
    // anchorY: 'top'  | 'bottom'
    function enforceBoxConstraints(anchorX = 'left', anchorY = 'top') {
        if (!currentRectangle) return;
        const W = backgroundImage.offsetWidth;
        const H = backgroundImage.offsetHeight;
        if (!(W > 0 && H > 0)) return;

        const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));
        let x = parseFloat(currentRectangle.style.left) || 0;
        let y = parseFloat(currentRectangle.style.top) || 0;
        let w = Math.max(0, parseFloat(currentRectangle.style.width) || 0);
        let h = Math.max(0, parseFloat(currentRectangle.style.height) || 0);

        let right = x + w;
        let bottom = y + h;
        if (anchorX === 'left') x = clamp(x, 0, W); else right = clamp(right, 0, W);
        if (anchorY === 'top') y = clamp(y, 0, H); else bottom = clamp(bottom, 0, H);
        const maxW = anchorX === 'left' ? W - x : right;
        const maxH = anchorY === 'top' ? H - y : bottom;

        w = Math.min(w, maxW);
        h = Math.min(h, maxH);
        if (aspectRatioValue) {
            h = w / aspectRatioValue;
            if (h > maxH) { h = maxH; w = h * aspectRatioValue; }
        }

        const snap = getSnapStep();
        if (snap > 1 && w > 0 && h > 0) {
            const { sx, sy } = getAxisScales();
            w = snapDisplayLength(w, maxW, sx, snap);
            h = snapDisplayLength(aspectRatioValue ? w / aspectRatioValue : h, maxH, sy, snap);
        }

        if (anchorX === 'right') x = right - w;
        if (anchorY === 'bottom') y = bottom - h;

        currentRectangle.style.left = x + 'px';
        currentRectangle.style.top = y + 'px';
        currentRectangle.style.width = w + 'px';
        currentRectangle.style.height = h + 'px';
        baseX = x; baseY = y; baseWidth = w; baseHeight = h;
    }

    // Zoom and Pan State
    let mZoom = 1.0;
    let mPanX = 0;
    let mPanY = 0;

    function updateCanvasTransform() {
        canvasContainer.style.transformOrigin = '0 0';
        canvasContainer.style.transform = `translate(${mPanX}px, ${mPanY}px) scale(${mZoom})`;
        // Keep vector shape preview aligned after pan/zoom
        if (typeof updateShapePreviewSvg === 'function') updateShapePreviewSvg();
    }

    function resetView() {
        mZoom = 1.0;
        mPanX = 0;
        mPanY = 0;
        updateCanvasTransform();
    }

    function zoomAtPointer(clientX, clientY, factor) {
        const rect = canvasContainer.getBoundingClientRect();
        const ox = clientX - rect.left;
        const oy = clientY - rect.top;
        const oldZoom = mZoom;
        const next = Math.max(0.4, Math.min(15.0, oldZoom * factor));
        if (next === oldZoom) return;
        const ratio = next / oldZoom;
        // Keep the point under the cursor fixed (requires transform-origin: 0 0)
        mPanX = mPanX - ox * (ratio - 1);
        mPanY = mPanY - oy * (ratio - 1);
        mZoom = next;
        updateCanvasTransform();
    }

    const defaultBorderWidth = 3;

    // ========================================================
    // Backend image scaling for images > 1024px
    // ========================================================
    if (imageUrl) {
        // Parse URL parameters
        try {
            // Create a dummy base URL to handle relative URLs comfortably
            const checkUrl = new URL(imageUrl, document.baseURI);
            const params = new URLSearchParams(checkUrl.search);

            const filename = params.get("filename");
            const type = params.get("type") || "input";
            const subfolder = params.get("subfolder") || "";

            if (filename) {
                console.log(`[BoxBox] Requesting scale for: ${filename} (type: ${type}, subfolder: ${subfolder})`);

                // Use direct fetch with robust configuration
                fetch("/region_selector/scale", {
                    method: "POST",
                    headers: {
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    },
                    body: JSON.stringify({
                        filename: String(filename),
                        type: String(type),
                        subfolder: String(subfolder)
                    })
                })
                    .then(async res => {
                        if (!res.ok) {
                            const errText = await res.text();
                            throw new Error(`Server returned ${res.status}: ${errText}`);
                        }
                        return res.json();
                    })
                    .then(data => {
                        if (!backgroundImage) return;
                        if (data.path) {
                            let scaledPath = data.path;
                            // Ensure path is correctly converted for ComfyUI API
                            if (window.comfyAPI && window.comfyAPI.api) {
                                try {
                                    scaledPath = window.comfyAPI.api.api.apiURL(data.path);
                                } catch (e) { }
                            }

                            backgroundImage.src = scaledPath;
                            backgroundImage.dataset.scaleFactor = data.scale || 1;
                            backgroundImage.dataset.scaled = data.scaled || false;
                            console.log(`[BoxBox] Image loaded - Scale: ${data.scale || 1}`);
                        } else if (data.error) {
                            console.warn(`[BoxBox] Scale error: ${data.error}, using original`);
                        }
                    })
                    .catch(e => {
                        console.error("[BoxBox] Error in scale fetch:", e);
                    });
            } else {
                // Fallback for when filename param is missing
                console.log("[RegionSelectorExt] No filename param, using imageUrl directly");
                backgroundImage.src = imageUrl;
            }
        } catch (e) {
            console.error("[RegionSelectorExt] URL parsing error:", e);
            backgroundImage.src = imageUrl;
        }
    }

    // Disable image drag
    backgroundImage.addEventListener('dragstart', (e) => e.preventDefault());
    backgroundImage.style.userSelect = 'none';
    canvasContainer.style.cursor = 'crosshair';

    // Border slider - removed from UI, using default values
    // currentBorderWidth = defaultBorderWidth (already set to 3)

    // Border position - removed from UI, using default 'inside'
    // borderPosition = 'inside' (already set)

    // Aspect Ratio Mode Selector
    const aspectRatioSelect = container.querySelector('#aspect-ratio-select');
    const aspectRatioHint = container.querySelector('#aspect-ratio-hint');
    const aspectCustomRow = container.querySelector('#aspect-ratio-custom');
    const aspectCustomW = container.querySelector('#aspect-custom-w');
    const aspectCustomH = container.querySelector('#aspect-custom-h');

    const PRESET_RATIO_MAP = {
        free: null,
        "1:1": 1 / 1,
        "4:5": 4 / 5,
        "3:4": 3 / 4,
        "9:16": 9 / 16,
        "9:21": 9 / 21,
        "5:4": 5 / 4,
        "4:3": 4 / 3,
        "3:2": 3 / 2,
        "16:9": 16 / 9,
        "21:9": 21 / 9,
        custom: null, // resolved from inputs
    };

    function readCustomAspectParts() {
        let w = parseFloat(aspectCustomW?.value);
        let h = parseFloat(aspectCustomH?.value);
        if (!Number.isFinite(w) || w <= 0) w = 1;
        if (!Number.isFinite(h) || h <= 0) h = 1;
        return { w, h };
    }

    function getCustomAspectLabel() {
        const { w, h } = readCustomAspectParts();
        const fmt = (n) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000));
        return `${fmt(w)}:${fmt(h)}`;
    }

    function resolveAspectRatioValue(mode) {
        if (mode === "custom") {
            const { w, h } = readCustomAspectParts();
            return w / h;
        }
        return Object.prototype.hasOwnProperty.call(PRESET_RATIO_MAP, mode)
            ? PRESET_RATIO_MAP[mode]
            : 1;
    }

    function updateAspectHint() {
        if (!aspectRatioHint) return;
        if (aspectRatioMode === "free") {
            aspectRatioHint.textContent = "Free draw — ratio calculated after";
            aspectRatioHint.style.color = "#555";
            aspectRatioHint.style.fontWeight = "normal";
        } else if (aspectRatioMode === "custom") {
            aspectRatioHint.textContent = `Constrained to ${getCustomAspectLabel()}`;
            aspectRatioHint.style.color = "#7ab0ff";
            aspectRatioHint.style.fontWeight = "600";
        } else {
            aspectRatioHint.textContent = `Constrained to ${aspectRatioMode}`;
            aspectRatioHint.style.color = "#7ab0ff";
            aspectRatioHint.style.fontWeight = "600";
        }
    }

    function setCustomRowVisible(on) {
        if (!aspectCustomRow) return;
        aspectCustomRow.classList.toggle('is-open', !!on);
        aspectCustomRow.style.display = on ? 'flex' : 'none';
    }

    function applyAspectRatioMode(mode, { adjustBox = true, save = true } = {}) {
        // Migrate removed presets
        if (mode === "5:8") mode = "4:5";
        if (!Object.prototype.hasOwnProperty.call(PRESET_RATIO_MAP, mode) && mode !== "custom") {
            mode = "1:1";
        }

        aspectRatioMode = mode;
        if (aspectRatioSelect && aspectRatioSelect.value !== mode) {
            aspectRatioSelect.value = mode;
        }
        setCustomRowVisible(mode === "custom");
        aspectRatioValue = resolveAspectRatioValue(mode);
        updateAspectHint();

        if (save) {
            localStorage.setItem('boxSelector_aspectRatio', aspectRatioMode);
            if (aspectRatioMode === "custom") {
                const { w, h } = readCustomAspectParts();
                localStorage.setItem('boxSelector_aspectCustomW', String(w));
                localStorage.setItem('boxSelector_aspectCustomH', String(h));
            }
        }

        if (adjustBox && rectangleExists && aspectRatioValue !== null) {
            adjustRectangleToAspectRatio();
            saveHistoryState();
        }
    }

    // Restore custom inputs
    const savedCustomW = localStorage.getItem('boxSelector_aspectCustomW');
    const savedCustomH = localStorage.getItem('boxSelector_aspectCustomH');
    if (aspectCustomW && savedCustomW) aspectCustomW.value = savedCustomW;
    if (aspectCustomH && savedCustomH) aspectCustomH.value = savedCustomH;

    let savedAspectRatio = localStorage.getItem('boxSelector_aspectRatio') || '1:1';
    if (savedAspectRatio === '5:8') savedAspectRatio = '4:5';

    if (aspectRatioSelect) {
        applyAspectRatioMode(savedAspectRatio, { adjustBox: false, save: false });
        console.log(`[RegionSelectorExt] Loaded aspect ratio: ${aspectRatioMode}`);

        aspectRatioSelect.addEventListener('change', (e) => {
            applyAspectRatioMode(e.target.value, { adjustBox: true, save: true });
            console.log(`[AspectRatio] Mode: ${aspectRatioMode}, Value: ${aspectRatioValue}`);
        });
    }

    function onCustomAspectInput() {
        if (aspectRatioMode !== "custom") return;
        aspectRatioValue = resolveAspectRatioValue("custom");
        updateAspectHint();
        const { w, h } = readCustomAspectParts();
        localStorage.setItem('boxSelector_aspectCustomW', String(w));
        localStorage.setItem('boxSelector_aspectCustomH', String(h));
        if (rectangleExists && aspectRatioValue !== null) {
            adjustRectangleToAspectRatio();
            saveHistoryState();
        }
    }

    if (aspectCustomW) {
        aspectCustomW.addEventListener('change', onCustomAspectInput);
        aspectCustomW.addEventListener('input', () => {
            if (aspectRatioMode !== "custom") return;
            aspectRatioValue = resolveAspectRatioValue("custom");
            updateAspectHint();
        });
    }
    if (aspectCustomH) {
        aspectCustomH.addEventListener('change', onCustomAspectInput);
        aspectCustomH.addEventListener('input', () => {
            if (aspectRatioMode !== "custom") return;
            aspectRatioValue = resolveAspectRatioValue("custom");
            updateAspectHint();
        });
    }

    // ========================================================
    // FIX IMAGE SIZE - DYNAMIC BUTTON
    // ========================================================
    function createFixImageButton() {
        // Button removed - scale is applied automatically
        // Nothing to do here
        console.log('[FixImage] Scale auto-applied, no button needed');
    }

    function fixImageScale() {
        const naturalW = backgroundImage.naturalWidth;
        const naturalH = backgroundImage.naturalHeight;
        const maxDim = 1024;

        const maxCurrent = Math.max(naturalW, naturalH);
        if (!(naturalW > 0 && naturalH > 0)) return;

        // Fit inside the visible canvas area with ONE scale for both axes,
        // so the preview is never squashed and never cut off.
        const area = container.querySelector('.bs-canvas-area');
        const availW = area ? area.clientWidth * 0.95 : naturalW;
        const availH = area ? area.clientHeight * 0.95 : naturalH;
        displayScaleFactor = Math.min(1, maxDim / maxCurrent,
            availW > 0 ? availW / naturalW : 1,
            availH > 0 ? availH / naturalH : 1);
        backgroundImage.style.flexShrink = '0';
        const newW = Math.round(naturalW * displayScaleFactor);
        const newH = Math.round(naturalH * displayScaleFactor);

        console.log(`[FixImage] Scaling ${naturalW}x${naturalH} → ${newW}x${newH}`);

        backgroundImage.style.width = `${newW}px`;
        backgroundImage.style.height = `${newH}px`;
        backgroundImage.style.maxWidth = 'none';
        backgroundImage.style.maxHeight = 'none';

        isImageFixed = true;
        const fixImageBtn = container.querySelector('#fix-image-btn');
        if (fixImageBtn) {
            fixImageBtn.textContent = "🔄 Reset Scale";
            fixImageBtn.classList.remove('btn-primary');
            fixImageBtn.classList.add('btn-warning');
        }

        const scaleInfo = container.querySelector('#scale-info');
        if (scaleInfo) {
            const scalePercent = (displayScaleFactor * 100).toFixed(1);
            scaleInfo.innerHTML = `
                <p><strong>📊 Preview Scale:</strong> ${scalePercent}%</p>
                <p><strong>🖼️ Display Size:</strong> ${newW} × ${newH} px</p>
                <p><strong>📐 Original Size:</strong> ${naturalW} × ${naturalH} px</p>
                <p style="color: #16a34a; font-weight: 600; margin-top: 8px;">✓ Selezione fluida attiva</p>
            `;
            scaleInfo.style.display = 'block';
        }
    }

    function resetImageScale() {
        displayScaleFactor = 1.0;
        console.log("[FixImage] Resetting to original scale");

        backgroundImage.style.width = 'auto';
        backgroundImage.style.height = 'auto';
        backgroundImage.style.maxWidth = '100%';
        backgroundImage.style.maxHeight = '100%';

        isImageFixed = false;
        const fixImageBtn = container.querySelector('#fix-image-btn');
        if (fixImageBtn) {
            fixImageBtn.textContent = "⚡ Fix Image Size";
            fixImageBtn.classList.remove('btn-warning');
            fixImageBtn.classList.add('btn-primary');
        }

        const scaleInfo = container.querySelector('#scale-info');
        if (scaleInfo) {
            scaleInfo.style.display = 'none';
        }
    }

    // Auto-fix image if large (> 1024px)
    setTimeout(() => {
        const naturalW = backgroundImage.naturalWidth;
        const naturalH = backgroundImage.naturalHeight;
        const maxDim = Math.max(naturalW, naturalH);

        console.log(`[FixImage] Image size: ${naturalW}x${naturalH}, max: ${maxDim}`);

        // Always fit the preview (keeps the correct shape for every size)
        if (maxDim > 1024) createFixImageButton();
        setTimeout(() => {
            fixImageScale();
        }, 100);
    }, 500);

    // Restore previous selection if metadata exists
    if (previousMetadata) {
        setTimeout(() => {
            try {
                const metadata = JSON.parse(previousMetadata);
                const scaleFactor = parseFloat(backgroundImage.dataset.scaleFactor || "1");

                // Check if we have valid coordinates
                if (metadata.x1 !== undefined && metadata.y1 !== undefined &&
                    metadata.x2 !== undefined && metadata.y2 !== undefined &&
                    metadata.selected) {

                    console.log("[CanvasSelector] Restoring previous selection:", metadata);

                    // Coordinates in metadata are in display space, use them directly
                    const x1 = metadata.x1;
                    const y1 = metadata.y1;
                    const x2 = metadata.x2;
                    const y2 = metadata.y2;

                    // Calculate base position and size
                    baseX = Math.min(x1, x2);
                    baseY = Math.min(y1, y2);
                    baseWidth = Math.abs(x2 - x1);
                    baseHeight = Math.abs(y2 - y1);

                    // Create the rectangle
                    currentRectangle = document.createElement('div');
                    currentRectangle.className = 'rectangle complete';

                    if (borderPosition === 'outside') {
                        currentRectangle.classList.add('border-outside');
                        currentRectangle.style.outlineWidth = currentBorderWidth + 'px';
                        currentRectangle.style.outlineStyle = 'solid';
                        currentRectangle.style.borderWidth = '0px';
                    } else {
                        currentRectangle.classList.add('border-inside');
                        currentRectangle.style.borderWidth = currentBorderWidth + 'px';
                    }

                    currentRectangle.style.left = baseX + 'px';
                    currentRectangle.style.top = baseY + 'px';
                    currentRectangle.style.width = baseWidth + 'px';
                    currentRectangle.style.height = baseHeight + 'px';

                    canvasContainer.appendChild(currentRectangle);
                    enforceBoxConstraints('left', 'top');
                    rectangleExists = true;
                    canvasContainer.classList.add('drawing-disabled');
                    canvasContainer.style.cursor = 'default';
                    if (dimensionsInfo) dimensionsInfo.style.display = 'block';

                    addResizeHandles();
                    updateAllDimensions();
                    seedHistory();
                    if (mode === 'paint') {
                        setBoxFrameInteractive(false);
                        ensureMaskCanvasOnTop();
                        canvasContainer.classList.add('bs-mask-mode');
                    }

                    console.log("[CanvasSelector] Previous selection restored successfully");
                }
            } catch (e) {
                console.warn("[CanvasSelector] Failed to restore previous selection:", e);
            }
        }, 600); // Wait a bit longer than the auto-fix to ensure everything is ready
    }

    // Mouse down - start drawing or dragging
    canvasContainer.addEventListener('mousedown', (e) => {
        if (mode === 'paint') return;

        // If rectangle exists and clicked on it (not a handle), start drag
        if (rectangleExists && e.target === currentRectangle) {
            isDragging = true;
            const rect = canvasContainer.getBoundingClientRect();
            const mouseX = (e.clientX - rect.left) / mZoom;
            const mouseY = (e.clientY - rect.top) / mZoom;
            dragOffsetX = mouseX - parseFloat(currentRectangle.style.left);
            dragOffsetY = mouseY - parseFloat(currentRectangle.style.top);
            canvasContainer.style.cursor = 'grab';
            return;
        }

        if (rectangleExists) return;
        if (e.target.classList.contains('resize-handle')) return;

        const rect = canvasContainer.getBoundingClientRect();
        startX = (e.clientX - rect.left) / mZoom;
        startY = (e.clientY - rect.top) / mZoom;

        isDrawing = true;

        currentRectangle = document.createElement('div');
        currentRectangle.className = 'rectangle';

        // Keep the aspect ratio locked if it was set
        // (removed auto-reset to 'free' mode so it remembers user preference)


        if (borderPosition === 'outside') {
            currentRectangle.classList.add('border-outside');
            currentRectangle.style.outlineWidth = currentBorderWidth + 'px';
            currentRectangle.style.outlineStyle = 'solid';
            currentRectangle.style.borderWidth = '0px';
        } else {
            currentRectangle.classList.add('border-inside');
            currentRectangle.style.borderWidth = currentBorderWidth + 'px';
        }

        currentRectangle.style.left = startX + 'px';
        currentRectangle.style.top = startY + 'px';
        currentRectangle.style.width = '0px';
        currentRectangle.style.height = '0px';

        if (currentBorderWidth > defaultBorderWidth) {
            currentRectangle.classList.add('thick-border');
        }

        canvasContainer.appendChild(currentRectangle);
    });

    // Mouse move
    document.addEventListener('mousemove', (e) => {
        if (mode === 'paint') return; // Mask mode — never drag/resize the box
        // Rectangle drag
        if (isDragging && currentRectangle) {
            const rect = canvasContainer.getBoundingClientRect();
            const mouseX = (e.clientX - rect.left) / mZoom;
            const mouseY = (e.clientY - rect.top) / mZoom;

            let newLeft = mouseX - dragOffsetX;
            let newTop = mouseY - dragOffsetY;

            // Constrain rectangle within the image
            const maxLeft = Math.max(0, backgroundImage.offsetWidth - parseFloat(currentRectangle.style.width));
            const maxTop = Math.max(0, backgroundImage.offsetHeight - parseFloat(currentRectangle.style.height));

            newLeft = Math.max(0, Math.min(newLeft, maxLeft));
            newTop = Math.max(0, Math.min(newTop, maxTop));

            currentRectangle.style.left = newLeft + 'px';
            currentRectangle.style.top = newTop + 'px';

            baseX = newLeft;
            baseY = newTop;

            updateAllDimensions();
            canvasContainer.style.cursor = 'grabbing';
            return;
        }

        if (isDrawing) {
            const rect = canvasContainer.getBoundingClientRect();
            const currentX = (e.clientX - rect.left) / mZoom;
            const currentY = (e.clientY - rect.top) / mZoom;

            let width = currentX - startX;
            let height = currentY - startY;

            // ⚙️ APPLICA VINCOLO SE NECESSARIO
            if (aspectRatioValue !== null) {
                // Constrained mode: force aspect ratio
                if (Math.abs(width) / aspectRatioValue > Math.abs(height)) {
                    height = (Math.abs(width) / aspectRatioValue) * (height < 0 ? -1 : 1);
                } else {
                    width = (Math.abs(height) * aspectRatioValue) * (width < 0 ? -1 : 1);
                }
            }

            baseWidth = Math.abs(width);
            baseHeight = Math.abs(height);

            if (width < 0) {
                currentRectangle.style.left = (currentX + width) + 'px';
                currentRectangle.style.width = Math.abs(width) + 'px';
            } else {
                currentRectangle.style.width = width + 'px';
            }

            if (height < 0) {
                currentRectangle.style.top = (currentY + height) + 'px';
                currentRectangle.style.height = Math.abs(height) + 'px';
            } else {
                currentRectangle.style.height = height + 'px';
            }

            // Fix: with a locked ratio the moving corner is not the mouse point,
            // so place the box from the start point.
            if (width < 0) currentRectangle.style.left = (startX - Math.abs(width)) + 'px';
            else currentRectangle.style.left = startX + 'px';
            if (height < 0) currentRectangle.style.top = (startY - Math.abs(height)) + 'px';
            else currentRectangle.style.top = startY + 'px';

            enforceBoxConstraints(width < 0 ? 'right' : 'left', height < 0 ? 'bottom' : 'top');
            updateAllDimensions();
        }

        if (isResizing && currentRectangle) {
            const deltaX = (e.clientX - startX) / mZoom;
            const deltaY = (e.clientY - startY) / mZoom;

            switch (resizingEdge) {
                case 'bottom-right':
                    let brNewWidth = rectStartWidth + deltaX;
                    let brNewHeight = rectStartHeight + deltaY;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        if (brNewWidth / aspectRatioValue > brNewHeight) {
                            brNewHeight = brNewWidth / aspectRatioValue;
                        } else {
                            brNewWidth = brNewHeight * aspectRatioValue;
                        }
                    }

                    if (brNewHeight > 0 && brNewWidth > 0) {
                        currentRectangle.style.width = brNewWidth + 'px';
                        currentRectangle.style.height = brNewHeight + 'px';
                        baseWidth = brNewWidth;
                        baseHeight = brNewHeight;
                    }
                    break;

                case 'bottom-left':
                    let blNewLeft = rectStartX + deltaX;
                    let blNewHeight = rectStartHeight + deltaY;
                    let blNewWidth = rectStartWidth - deltaX;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        if (blNewWidth / aspectRatioValue > blNewHeight) {
                            blNewHeight = blNewWidth / aspectRatioValue;
                        } else {
                            blNewWidth = blNewHeight * aspectRatioValue;
                            blNewLeft = rectStartX + (rectStartWidth - blNewWidth);
                        }
                    }

                    if (blNewHeight > 0 && blNewWidth > 0) {
                        currentRectangle.style.left = blNewLeft + 'px';
                        currentRectangle.style.height = blNewHeight + 'px';
                        currentRectangle.style.width = blNewWidth + 'px';
                        baseX = blNewLeft;
                        baseWidth = blNewWidth;
                        baseHeight = blNewHeight;
                    }
                    break;

                case 'top-right':
                    let trNewTop = rectStartY + deltaY;
                    let trNewHeight = rectStartHeight - deltaY;
                    let trNewWidth = rectStartWidth + deltaX;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        if (trNewWidth / aspectRatioValue > trNewHeight) {
                            trNewHeight = trNewWidth / aspectRatioValue;
                            trNewTop = rectStartY + (rectStartHeight - trNewHeight);
                        } else {
                            trNewWidth = trNewHeight * aspectRatioValue;
                        }
                    }

                    if (trNewHeight > 0 && trNewWidth > 0) {
                        currentRectangle.style.top = trNewTop + 'px';
                        currentRectangle.style.height = trNewHeight + 'px';
                        currentRectangle.style.width = trNewWidth + 'px';
                        baseY = trNewTop;
                        baseWidth = trNewWidth;
                        baseHeight = trNewHeight;
                    }
                    break;

                case 'top-left':
                    let tlNewTop = rectStartY + deltaY;
                    let tlNewLeft = rectStartX + deltaX;
                    let tlNewHeight = rectStartHeight - deltaY;
                    let tlNewWidth = rectStartWidth - deltaX;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        if (tlNewWidth / aspectRatioValue > tlNewHeight) {
                            tlNewHeight = tlNewWidth / aspectRatioValue;
                            tlNewTop = rectStartY + (rectStartHeight - tlNewHeight);
                        } else {
                            tlNewWidth = tlNewHeight * aspectRatioValue;
                            tlNewLeft = rectStartX + (rectStartWidth - tlNewWidth);
                        }
                    }

                    if (tlNewHeight > 0 && tlNewWidth > 0) {
                        currentRectangle.style.top = tlNewTop + 'px';
                        currentRectangle.style.left = tlNewLeft + 'px';
                        currentRectangle.style.height = tlNewHeight + 'px';
                        currentRectangle.style.width = tlNewWidth + 'px';
                        baseX = tlNewLeft;
                        baseY = tlNewTop;
                        baseWidth = tlNewWidth;
                        baseHeight = tlNewHeight;
                    }
                    break;

                case 'right':
                    let rightWidth = rectStartWidth + deltaX;
                    let rightHeight = rightWidth / aspectRatioValue || rectStartHeight;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        rightHeight = rightWidth / aspectRatioValue;
                    }

                    if (rightWidth > 0) {
                        currentRectangle.style.width = rightWidth + 'px';
                        if (aspectRatioValue !== null && rightHeight > 0) {
                            currentRectangle.style.height = rightHeight + 'px';
                            baseWidth = rightWidth;
                            baseHeight = rightHeight;
                        }
                    }
                    break;

                case 'left':
                    let newLeft = rectStartX + deltaX;
                    let newWidth = rectStartWidth - deltaX;
                    let newHeight = newWidth / aspectRatioValue || rectStartHeight;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        newHeight = newWidth / aspectRatioValue;
                    }

                    if (newWidth > 0) {
                        currentRectangle.style.left = newLeft + 'px';
                        currentRectangle.style.width = newWidth + 'px';
                        if (aspectRatioValue !== null && newHeight > 0) {
                            currentRectangle.style.height = newHeight + 'px';
                            baseX = newLeft;
                            baseWidth = newWidth;
                            baseHeight = newHeight;
                        }
                    }
                    break;

                case 'bottom':
                    let bottomHeight = rectStartHeight + deltaY;
                    let bottomWidth = bottomHeight * aspectRatioValue || rectStartWidth;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        bottomWidth = bottomHeight * aspectRatioValue;
                    }

                    if (bottomHeight > 0) {
                        currentRectangle.style.height = bottomHeight + 'px';
                        if (aspectRatioValue !== null && bottomWidth > 0) {
                            currentRectangle.style.width = bottomWidth + 'px';
                            baseWidth = bottomWidth;
                            baseHeight = bottomHeight;
                        }
                    }
                    break;

                case 'top':
                    let newTop = rectStartY + deltaY;
                    let topNewHeight = rectStartHeight - deltaY;
                    let topNewWidth = topNewHeight * aspectRatioValue || rectStartWidth;

                    // ⚙️ APPLICA VINCOLO SE NECESSARIO
                    if (aspectRatioValue !== null) {
                        topNewWidth = topNewHeight * aspectRatioValue;
                    }

                    if (topNewHeight > 0) {
                        currentRectangle.style.top = newTop + 'px';
                        currentRectangle.style.height = topNewHeight + 'px';
                        if (aspectRatioValue !== null && topNewWidth > 0) {
                            currentRectangle.style.width = topNewWidth + 'px';
                            baseY = newTop;
                            baseWidth = topNewWidth;
                            baseHeight = topNewHeight;
                        }
                    }
                    break;
            }

            enforceBoxConstraints(
                resizingEdge.includes('left') ? 'right' : 'left',
                resizingEdge.includes('top') ? 'bottom' : 'top'
            );

            baseX = parseFloat(currentRectangle.style.left);
            baseY = parseFloat(currentRectangle.style.top);
            baseWidth = parseFloat(currentRectangle.style.width);
            baseHeight = parseFloat(currentRectangle.style.height);

            updateAllDimensions();
        }
    });

    // Mouse up
    document.addEventListener('mouseup', (e) => {
        let boxChanged = false;

        if (isDrawing) {
            // Read the box as drawn (ratio, image borders and snap already applied)
            baseX = parseFloat(currentRectangle.style.left) || 0;
            baseY = parseFloat(currentRectangle.style.top) || 0;
            baseWidth = parseFloat(currentRectangle.style.width) || 0;
            baseHeight = parseFloat(currentRectangle.style.height) || 0;

            rectangleExists = true;
            currentRectangle.classList.add('complete');

            canvasContainer.classList.add('drawing-disabled');
            canvasContainer.style.cursor = 'default';

            dimensionsInfo.style.display = 'block';

            addResizeHandles();
            updateAllDimensions();

            isDrawing = false;
            boxChanged = true;
        }

        if (isResizing) {
            isResizing = false;
            resizingEdge = null;
            canvasContainer.style.cursor = 'default';
            boxChanged = true;
        }

        if (isDragging) {
            isDragging = false;
            canvasContainer.style.cursor = 'default';
            boxChanged = true;
        }

        if (boxChanged) saveHistoryState();
    });

    function resetRectangle() {
        if (currentRectangle) {
            currentRectangle.remove();
        }
        currentRectangle = null;
        rectangleExists = false;
        canvasContainer.classList.remove('drawing-disabled');
        canvasContainer.style.cursor = 'crosshair';
        if (dimensionsInfo) dimensionsInfo.style.display = 'none';
        if (baseCoordinates) {
            baseCoordinates.innerHTML = '<span class="bs-info-muted">Click and drag to select</span>';
        }
        saveHistoryState();
    }

    function adjustRectangleToAspectRatio() {
        if (!aspectRatioValue || !rectangleExists || !currentRectangle) return;

        // Keep width, adjust height to ratio
        baseHeight = baseWidth / aspectRatioValue;

        // Update display
        currentRectangle.style.width = baseWidth + 'px';
        currentRectangle.style.height = baseHeight + 'px';
        enforceBoxConstraints('left', 'top');

        updateAllDimensions();

        console.log(`[AspectRatio] Adjusted to ${aspectRatioMode}: ${Math.round(baseWidth)}x${Math.round(baseHeight)}`);
    }

    function addResizeHandles() {
        const handles = ['top', 'bottom', 'left', 'right', 'top-left', 'top-right', 'bottom-left', 'bottom-right'];
        handles.forEach(position => {
            const handle = document.createElement('div');
            handle.className = `resize-handle ${position}`;
            handle.dataset.edge = position;
            currentRectangle.appendChild(handle);

            handle.addEventListener('mousedown', (e) => {
                if (mode === 'paint') return; // Mask mode — box is locked
                e.stopPropagation();
                isResizing = true;
                resizingEdge = position;
                startX = e.clientX;
                startY = e.clientY;

                rectStartX = parseFloat(currentRectangle.style.left);
                rectStartY = parseFloat(currentRectangle.style.top);
                rectStartWidth = parseFloat(currentRectangle.style.width);
                rectStartHeight = parseFloat(currentRectangle.style.height);

                canvasContainer.style.cursor = getComputedStyle(handle).cursor;
            });
        });
    }

    function updateAllDimensions() {
        if (!currentRectangle) return;

        const baseX1 = baseX;
        const baseY1 = baseY;
        const baseX2 = baseX + baseWidth;
        const baseY2 = baseY + baseHeight;

        const { sx: pxScaleX, sy: pxScaleY } = getAxisScales();
        const w = Math.round(baseWidth / pxScaleX);
        const h = Math.round(baseHeight / pxScaleY);
        const ratio = w / h;
        const snapStep = getSnapStep();

        // 🎯 CUSTOM MODE: Calculate approximation
        let aspectRatioDisplay;

        if (aspectRatioMode === "free") {
            // Standard aspect ratio list
            const standardRatios = [
                { value: 21 / 9, label: "21:9 Landscape", display: "21:9" },
                { value: 16 / 9, label: "16:9 Landscape", display: "16:9" },
                { value: 3 / 2, label: "3:2 Landscape", display: "3:2" },
                { value: 4 / 3, label: "4:3 Landscape", display: "4:3" },
                { value: 5 / 4, label: "5:4 Landscape", display: "5:4" },
                { value: 1 / 1, label: "1:1 Square", display: "1:1" },
                { value: 4 / 5, label: "4:5 Portrait", display: "4:5" },
                { value: 3 / 4, label: "3:4 Portrait", display: "3:4" },
                { value: 9 / 16, label: "9:16 Portrait", display: "9:16" },
                { value: 9 / 21, label: "9:21 Portrait", display: "9:21" },
            ];

            // Find the closest
            let closestRatio = standardRatios[0];
            let minDiff = Math.abs(ratio - standardRatios[0].value);

            for (const r of standardRatios) {
                const diff = Math.abs(ratio - r.value);
                if (diff < minDiff) {
                    minDiff = diff;
                    closestRatio = r;
                }
            }

            const diffPercent = (minDiff / ratio) * 100;

            // Display format based on proximity
            if (diffPercent < 3) {
                // Very close - show as exact
                aspectRatioDisplay = `<span class="bs-ratio bs-ratio-exact">✓ ${closestRatio.label}</span>`;
            } else if (diffPercent < 8) {
                // Reasonably close - show approximate
                aspectRatioDisplay = `<span class="bs-ratio bs-ratio-near">~ ${closestRatio.label}</span> <span class="bs-info-meta">(${ratio.toFixed(2)}:1)</span>`;
            } else {
                // Too different - show custom + nearest
                aspectRatioDisplay = `<span class="bs-ratio bs-ratio-custom">${ratio.toFixed(2)}:1</span> <span class="bs-info-meta">(≈ ${closestRatio.display})</span>`;
            }
        } else {
            // 🔒 CONSTRAINED MODE: Show active constraint
            const lockLabel = aspectRatioMode === "custom" ? getCustomAspectLabel() : aspectRatioMode;
            aspectRatioDisplay = `<span class="bs-ratio bs-ratio-exact">🔒 ${lockLabel}</span> <span class="bs-info-meta">(${ratio.toFixed(2)}:1)</span>`;
        }

        baseCoordinates.innerHTML = `
            <div class="bs-info-k">Coords</div>
            ${Math.round(baseX1 / pxScaleX)},${Math.round(baseY1 / pxScaleY)} → ${Math.round(baseX2 / pxScaleX)},${Math.round(baseY2 / pxScaleY)}
            <div class="bs-info-k" style="margin-top:5px;">Size</div>
            ${w} × ${h} px${snapStep > 1 ? ` <span class="bs-info-meta">(snap ${snapStep})</span>` : ''}
            <div style="margin-top:5px;">${aspectRatioDisplay}</div>
        `;
    }

    // ========================================================
    // Mask Painting Functionality
    // ========================================================
    const maskCanvas = document.createElement('canvas');
    maskCanvas.id = 'mask-canvas';
    maskCanvas.style.cssText = `
        position: absolute;
        left: 0;
        top: 0;
        width: 100%;
        height: 100%;
        pointer-events: none;
        z-index: 5;
        touch-action: none;
    `;
    canvasContainer.appendChild(maskCanvas);

    // State variables
    let mMaskOps = [];
    let mMaskInverted = false;
    let mMaskColor = '#22cc44';
    let mMaskAlpha = 50;
    let mBrushRadius = 30;
    let mBrushMode = 'add'; // 'add' or 'sub'
    let mBrushShape = 'circle'; // 'circle' or 'square'
    let mBrushDrawing = false;
    let mBrushPts = [];
    let mBrushCursorPos = null;
    let mode = 'box'; // 'box' or 'paint'
    let mMaskTool = 'brush'; // 'brush' | 'lasso' | 'polygon' | 'rect'
    let mLassoPts = [];
    let mLassoDrawing = false;
    let mRectStart = null;
    let mRectCurrent = null;

    // Declared here (not next to their helpers) because the first redraw runs
    // during init — a later `let` would throw a TDZ ReferenceError and abort setup.
    let _maskOffscreen = null;
    let shapePreviewSvg = null;

    // Robust State History for Undo / Redo
    let mHistory = [];
    let mHistoryIndex = -1;
    let historyLocked = false;

    function getBoxSnapshot() {
        return {
            exists: !!rectangleExists,
            x: baseX,
            y: baseY,
            w: baseWidth,
            h: baseHeight,
        };
    }

    function applyBoxState(box) {
        if (!box || !box.exists) {
            if (currentRectangle) currentRectangle.remove();
            currentRectangle = null;
            rectangleExists = false;
            baseX = 0;
            baseY = 0;
            baseWidth = 0;
            baseHeight = 0;
            canvasContainer.classList.remove('drawing-disabled');
            if (mode === 'box') canvasContainer.style.cursor = 'crosshair';
            if (dimensionsInfo) dimensionsInfo.style.display = 'none';
            if (baseCoordinates) {
                baseCoordinates.innerHTML = '<span class="bs-info-muted">Click and drag to select</span>';
            }
            return;
        }

        baseX = box.x;
        baseY = box.y;
        baseWidth = box.w;
        baseHeight = box.h;
        rectangleExists = true;

        if (!currentRectangle) {
            currentRectangle = document.createElement('div');
            currentRectangle.className = 'rectangle complete';
            if (borderPosition === 'outside') {
                currentRectangle.classList.add('border-outside');
                currentRectangle.style.outlineWidth = currentBorderWidth + 'px';
                currentRectangle.style.outlineStyle = 'solid';
                currentRectangle.style.borderWidth = '0px';
            } else {
                currentRectangle.classList.add('border-inside');
                currentRectangle.style.borderWidth = currentBorderWidth + 'px';
            }
            canvasContainer.appendChild(currentRectangle);
            addResizeHandles();
        }

        currentRectangle.style.left = baseX + 'px';
        currentRectangle.style.top = baseY + 'px';
        currentRectangle.style.width = baseWidth + 'px';
        currentRectangle.style.height = baseHeight + 'px';
        canvasContainer.classList.add('drawing-disabled');
        if (mode === 'box') canvasContainer.style.cursor = 'default';
        if (dimensionsInfo) dimensionsInfo.style.display = 'block';
        updateAllDimensions();
        if (mode === 'paint') setBoxFrameInteractive(false);
    }

    function saveHistoryState() {
        if (historyLocked) return;
        mHistory = mHistory.slice(0, mHistoryIndex + 1);
        mHistory.push({
            ops: JSON.parse(JSON.stringify(mMaskOps)),
            inverted: mMaskInverted,
            box: getBoxSnapshot(),
        });
        mHistoryIndex = mHistory.length - 1;
        updateUndoRedoButtons();
    }

    function applyHistoryState(state) {
        if (!state) return;
        historyLocked = true;
        mMaskOps = JSON.parse(JSON.stringify(state.ops || []));
        mMaskInverted = !!state.inverted;
        applyBoxState(state.box);
        historyLocked = false;
        updateUndoRedoButtons();
        redrawMaskWithActiveStroke();
    }

    function seedHistory() {
        mHistory = [{
            ops: JSON.parse(JSON.stringify(mMaskOps)),
            inverted: mMaskInverted,
            box: getBoxSnapshot(),
        }];
        mHistoryIndex = 0;
        updateUndoRedoButtons();
    }

    // Query DOM Elements
    const modeBoxBtn = container.querySelector('#mode-box-btn');
    const modePaintBtn = container.querySelector('#mode-paint-btn');
    const maskControls = container.querySelector('#mask-controls');
    const brushSizeSlider = container.querySelector('#brush-size-slider');
    const brushSizeVal = container.querySelector('#brush-size-val');
    const brushShapeCircleBtn = container.querySelector('#brush-shape-circle-btn');
    const brushShapeSquareBtn = container.querySelector('#brush-shape-square-btn');
    const maskOpacitySlider = container.querySelector('#mask-opacity-slider');
    const maskOpacityVal = container.querySelector('#mask-opacity-val');
    const maskColorPicker = container.querySelector('#mask-color-picker');
    const maskInvertBtn = container.querySelector('#mask-invert-btn');
    const maskClearBtn = container.querySelector('#mask-clear-btn');
    const maskUndoBtn = container.querySelector('#bs-undo-btn');
    const maskRedoBtn = container.querySelector('#bs-redo-btn');
    const brushOpts = container.querySelector('#brush-opts');
    const maskToolHint = container.querySelector('#mask-tool-hint');
    const maskToolBtns = {
        brush: container.querySelector('#mask-tool-brush'),
        lasso: container.querySelector('#mask-tool-lasso'),
        polygon: container.querySelector('#mask-tool-polygon'),
        rect: container.querySelector('#mask-tool-rect'),
    };

    // Restore previous metadata if exists
    if (previousMetadata) {
        try {
            const metadata = JSON.parse(previousMetadata);
            if (metadata.maskOps) mMaskOps = metadata.maskOps;
            if (metadata.maskInverted !== undefined) mMaskInverted = metadata.maskInverted;
            if (metadata.maskColor) mMaskColor = metadata.maskColor;
            if (metadata.maskAlpha !== undefined) mMaskAlpha = metadata.maskAlpha;

            // Update UI values
            if (maskColorPicker) maskColorPicker.value = mMaskColor;
            if (maskOpacitySlider) {
                maskOpacitySlider.value = mMaskAlpha;
                maskOpacityVal.textContent = mMaskAlpha + '%';
            }
        } catch (e) {
            console.warn("[CanvasSelector] Failed to parse previous mask metadata:", e);
        }
    }

    // Set canvas dimensions — keep listening for scale-replacement loads
    const onImageLoad = () => {
        const w = Math.max(1, backgroundImage.naturalWidth || backgroundImage.width || 1);
        const h = Math.max(1, backgroundImage.naturalHeight || backgroundImage.height || 1);
        if (maskCanvas.width !== w || maskCanvas.height !== h) {
            maskCanvas.width = w;
            maskCanvas.height = h;
        }
        if (mHistory.length === 0) seedHistory();
        redrawMaskWithActiveStroke();
    };

    backgroundImage.addEventListener('load', onImageLoad);
    if (backgroundImage.complete && backgroundImage.naturalWidth) {
        onImageLoad();
    }

    function getMaskModeFromEvent(e) {
        if (e.altKey) return 'sub';
        if (e.shiftKey) return 'add';
        if (e.button === 2) return 'sub';
        return 'add';
    }

    function setBtnActive(btn, on, boxStyle) {
        if (!btn) return;
        btn.classList.remove('active', 'active-box');
        if (on) btn.classList.add(boxStyle ? 'active-box' : 'active');
    }

    /** Lock/unlock the box frame so it cannot steal pointer events from the mask canvas. */
    function setBoxFrameInteractive(enabled) {
        if (!currentRectangle) return;
        // pointer-events is NOT inherited — children (handles) stay clickable unless disabled too
        currentRectangle.style.pointerEvents = enabled ? 'auto' : 'none';
        currentRectangle.style.cursor = enabled ? 'move' : 'default';
        currentRectangle.querySelectorAll('.resize-handle').forEach((h) => {
            h.style.pointerEvents = enabled ? 'auto' : 'none';
            h.style.display = enabled ? '' : 'none';
        });
        // Always abort in-progress box edits when locking
        isDragging = false;
        isResizing = false;
        isDrawing = false;
        resizingEdge = null;
    }

    function ensureMaskCanvasOnTop() {
        // Keep mask above the box frame for hit-testing (handles use z-index 20)
        const paint = mode === 'paint';
        maskCanvas.style.zIndex = paint ? '50' : '5';
        maskCanvas.style.pointerEvents = paint ? 'auto' : 'none';
        maskCanvas.style.touchAction = 'none';
        maskCanvas.style.cursor = paint ? 'crosshair' : 'default';
        canvasContainer.style.touchAction = paint ? 'none' : '';
        if (paint && maskCanvas.parentElement === canvasContainer) {
            canvasContainer.appendChild(maskCanvas); // re-append → top of stacking
        }
        if (maskCanvas.width < 2 || maskCanvas.height < 2) {
            onImageLoad();
        }
    }

    function updateMaskToolHint() {
        if (!maskToolHint) return;
        const hints = {
            brush: '<span class="add">Shift</span> — add · <span class="sub">Alt</span> — subtract<br>LMB paint · RMB erase · Ctrl+Wheel size',
            lasso: 'Drag freehand · <span class="add">Shift</span> add · <span class="sub">Alt</span> subtract',
            polygon: 'Click vertices · close near start / dblclick · Esc cancel<br><span class="add">Shift</span> add · <span class="sub">Alt</span> subtract',
            rect: 'Drag rectangle · <span class="add">Shift</span> add · <span class="sub">Alt</span> subtract',
        };
        maskToolHint.innerHTML = hints[mMaskTool] || hints.brush;
    }

    function selectMaskTool(tool, { persist = true } = {}) {
        const allowed = ['brush', 'lasso', 'polygon', 'rect'];
        if (!allowed.includes(tool)) tool = 'brush';
        mMaskTool = tool;
        Object.entries(maskToolBtns).forEach(([k, b]) => setBtnActive(b, k === tool, false));
        if (brushOpts) brushOpts.style.display = tool === 'brush' ? 'block' : 'none';
        mLassoPts = [];
        mLassoDrawing = false;
        mRectStart = null;
        mRectCurrent = null;
        mBrushDrawing = false;
        updateMaskToolHint();
        if (mode === 'paint') ensureMaskCanvasOnTop();
        redrawMaskWithActiveStroke();
        if (persist) saveMaskToolPrefs();
    }

    function setBrushShape(shape, { persist = true } = {}) {
        mBrushShape = shape === 'square' ? 'square' : 'circle';
        if (brushShapeCircleBtn && brushShapeSquareBtn) {
            setBtnActive(brushShapeCircleBtn, mBrushShape === 'circle', false);
            setBtnActive(brushShapeSquareBtn, mBrushShape === 'square', false);
        }
        redrawMaskWithActiveStroke();
        if (persist) saveMaskToolPrefs();
    }

    function saveMaskToolPrefs() {
        try {
            localStorage.setItem('boxSelector_maskTool', mMaskTool);
            localStorage.setItem('boxSelector_brushShape', mBrushShape);
            localStorage.setItem('boxSelector_brushSize', String(mBrushRadius));
            localStorage.setItem('boxSelector_maskAlpha', String(mMaskAlpha));
            localStorage.setItem('boxSelector_maskColor', mMaskColor);
            localStorage.setItem('boxSelector_panelMode', mode);
        } catch (_) { /* ignore quota / private mode */ }
    }

    function loadMaskToolPrefs() {
        try {
            const tool = localStorage.getItem('boxSelector_maskTool');
            const shape = localStorage.getItem('boxSelector_brushShape');
            const size = parseInt(localStorage.getItem('boxSelector_brushSize'), 10);
            const alpha = parseInt(localStorage.getItem('boxSelector_maskAlpha'), 10);
            const color = localStorage.getItem('boxSelector_maskColor');

            if (shape === 'circle' || shape === 'square') {
                setBrushShape(shape, { persist: false });
            } else {
                setBrushShape('circle', { persist: false });
            }

            if (Number.isFinite(size) && size >= 1 && size <= 100) {
                mBrushRadius = size;
                if (brushSizeSlider) brushSizeSlider.value = String(size);
                if (brushSizeVal) brushSizeVal.textContent = size + 'px';
            }

            if (Number.isFinite(alpha) && alpha >= 10 && alpha <= 100) {
                mMaskAlpha = alpha;
                if (maskOpacitySlider) maskOpacitySlider.value = String(alpha);
                if (maskOpacityVal) maskOpacityVal.textContent = alpha + '%';
            }

            if (color && /^#[0-9a-fA-F]{6}$/.test(color)) {
                mMaskColor = color;
                if (maskColorPicker) maskColorPicker.value = color;
            }

            selectMaskTool(tool || 'brush', { persist: false });
        } catch (_) {
            selectMaskTool('brush', { persist: false });
            setBrushShape('circle', { persist: false });
        }
    }

    function cancelLassoInProgress() {
        mLassoPts = [];
        mLassoDrawing = false;
        mRectStart = null;
        mRectCurrent = null;
        redrawMaskWithActiveStroke();
    }

    // Mode Switching — vertex hover tip (shown near the handle, not the button)
    function setBoxSelectTip(visible, clientX = 0, clientY = 0) {
        let tip = container.querySelector('#bs-vertex-tip');
        if (!tip) {
            tip = document.createElement('div');
            tip.id = 'bs-vertex-tip';
            tip.className = 'bs-vertex-tip';
            tip.textContent = 'Select Box';
            tip.setAttribute('aria-hidden', 'true');
            container.appendChild(tip);
        }
        if (!visible) {
            tip.classList.remove('is-open');
            return;
        }
        const crect = container.getBoundingClientRect();
        tip.style.left = `${clientX - crect.left}px`;
        tip.style.top = `${clientY - crect.top}px`;
        tip.classList.add('is-open');
    }

    function getNearBoxVertex(clientX, clientY, thresholdPx = 14) {
        if (!rectangleExists || !currentRectangle) return null;
        const corners = currentRectangle.querySelectorAll(
            '.resize-handle.top-left, .resize-handle.top-right, .resize-handle.bottom-left, .resize-handle.bottom-right'
        );
        let best = null;
        let bestDist = thresholdPx;
        for (const h of corners) {
            const r = h.getBoundingClientRect();
            const cx = r.left + r.width / 2;
            const cy = r.top + r.height / 2;
            const d = Math.hypot(clientX - cx, clientY - cy);
            if (d <= bestDist) {
                bestDist = d;
                best = { cx, cy };
            }
        }
        return best;
    }

    function updateBoxSelectTipFromPointer(clientX, clientY) {
        if (mode !== 'paint' || !rectangleExists) {
            setBoxSelectTip(false);
            return false;
        }
        const hit = getNearBoxVertex(clientX, clientY);
        if (!hit) {
            setBoxSelectTip(false);
            return false;
        }
        setBoxSelectTip(true, hit.cx, hit.cy);
        return true;
    }

    // Zoom / pan flags — declared early so setModeMask can clear a stuck Space-pan
    let isSpacePressed = false;
    let isPanning = false;
    let canvasArea = null;

    function setModeBox() {
        mode = 'box';
        const boxBtn = container.querySelector('#mode-box-btn');
        const paintBtn = container.querySelector('#mode-paint-btn');
        const controls = container.querySelector('#mask-controls');
        setBoxSelectTip(false);
        if (boxBtn && paintBtn) {
            setBtnActive(boxBtn, true, true);
            setBtnActive(paintBtn, false, false);
        }
        if (controls) controls.style.display = 'none';
        canvasContainer.classList.remove('bs-mask-mode');
        setBoxFrameInteractive(true);
        ensureMaskCanvasOnTop();
        canvasContainer.classList.remove('drawing-disabled');
        if (rectangleExists) canvasContainer.classList.add('drawing-disabled');
        cancelLassoInProgress();
        isSpacePressed = false;
        isPanning = false;
        if (canvasArea) canvasArea.style.cursor = 'default';
        saveMaskToolPrefs();
        if (container._boxBoxApi) container._boxBoxApi.mode = mode;
        console.log('[BoxBox] Box mode on');
    }

    function setModeMask() {
        // Always flip internal mode first — never leave UI-only "fake" mask state
        mode = 'paint';
        isDragging = false;
        isResizing = false;
        isDrawing = false;
        resizingEdge = null;
        isSpacePressed = false;
        isPanning = false;
        if (canvasArea) canvasArea.style.cursor = 'default';

        const boxBtn = container.querySelector('#mode-box-btn');
        const paintBtn = container.querySelector('#mode-paint-btn');
        const controls = container.querySelector('#mask-controls');
        setBoxSelectTip(false);
        if (paintBtn && boxBtn) {
            setBtnActive(paintBtn, true, false);
            setBtnActive(boxBtn, false, false);
        }
        if (controls) controls.style.display = 'flex';
        canvasContainer.classList.add('bs-mask-mode');
        setBoxFrameInteractive(false);
        ensureMaskCanvasOnTop();
        canvasContainer.classList.add('drawing-disabled');
        try {
            selectMaskTool(mMaskTool || 'brush', { persist: true });
        } catch (err) {
            console.error('[BoxBox] selectMaskTool failed:', err);
        }
        saveMaskToolPrefs();
        if (container._boxBoxApi) container._boxBoxApi.mode = mode;
        console.log('[BoxBox] Mask mode on — canvas', maskCanvas.width, 'x', maskCanvas.height, 'tool', mMaskTool, 'pe', maskCanvas.style.pointerEvents);
    }

    // Expose API as soon as mode switchers exist (before anything else can throw)
    container._boxBoxApi = {
        setModeBox,
        setModeMask,
        getMode: () => mode,
        clearMask: () => { /* assigned below after clearMask exists */ },
        cancelLassoInProgress: () => { /* assigned below */ },
        hasShapeInProgress: () => false,
    };

    // Do NOT capture-preventDefault here — that cancels pointer gestures / capture
    // and makes brush/lasso appear dead. Box is locked via CSS pointer-events + mode checks.

    // Direct button handlers — more reliable than delegated container clicks
    if (modePaintBtn) {
        modePaintBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[BoxBox] Mask button clicked');
            setModeMask();
        };
    }
    if (modeBoxBtn) {
        modeBoxBtn.onclick = (e) => {
            e.preventDefault();
            e.stopPropagation();
            console.log('[BoxBox] Box button clicked');
            setModeBox();
        };
    }

    Object.entries(maskToolBtns).forEach(([tool, btn]) => {
        if (btn) btn.onclick = () => selectMaskTool(tool);
    });

    // Sliders & Picker
    if (brushSizeSlider && brushSizeVal) {
        brushSizeSlider.oninput = () => {
            mBrushRadius = parseInt(brushSizeSlider.value);
            brushSizeVal.textContent = mBrushRadius + 'px';
            redrawMaskWithActiveStroke();
            saveMaskToolPrefs();
        };
    }

    // Brush Shape Selection
    if (brushShapeCircleBtn && brushShapeSquareBtn) {
        brushShapeCircleBtn.onclick = () => setBrushShape('circle');
        brushShapeSquareBtn.onclick = () => setBrushShape('square');
    }

    if (maskOpacitySlider && maskOpacityVal) {
        maskOpacitySlider.oninput = () => {
            mMaskAlpha = parseInt(maskOpacitySlider.value);
            maskOpacityVal.textContent = mMaskAlpha + '%';
            redrawMask();
            saveMaskToolPrefs();
        };
    }

    if (maskColorPicker) {
        maskColorPicker.oninput = () => {
            mMaskColor = maskColorPicker.value;
            redrawMask();
            saveMaskToolPrefs();
        };
    }

    // Restore last tool + options (tool/shape/size/overlay/color)
    loadMaskToolPrefs();

    // Actions
    if (maskInvertBtn) {
        maskInvertBtn.onclick = () => {
            mMaskInverted = !mMaskInverted;
            saveHistoryState();
            redrawMask();
        };
    }

    function clearMask() {
        cancelLassoInProgress();
        mMaskOps = [];
        mMaskInverted = false;
        saveHistoryState();
        redrawMaskWithActiveStroke();
    }

    // Finish publishing API methods that were stubbed earlier
    if (container._boxBoxApi) {
        container._boxBoxApi.clearMask = clearMask;
        container._boxBoxApi.cancelLassoInProgress = cancelLassoInProgress;
        container._boxBoxApi.hasShapeInProgress = () =>
            !!(mLassoDrawing || mRectStart || (mMaskTool === 'polygon' && mLassoPts.length > 0));
        container._boxBoxApi.resetRectangle = () => {
            if (typeof resetRectangle === 'function') resetRectangle();
        };
    }

    if (maskClearBtn) {
        maskClearBtn.onclick = () => clearMask();
    }

    // Undo / Redo
    function updateUndoRedoButtons() {
        if (maskUndoBtn) {
            const canUndo = mHistoryIndex > 0;
            maskUndoBtn.disabled = !canUndo;
            maskUndoBtn.style.opacity = canUndo ? '1' : '0.5';
            maskUndoBtn.style.cursor = canUndo ? 'pointer' : 'default';
        }
        if (maskRedoBtn) {
            const canRedo = mHistoryIndex < mHistory.length - 1;
            maskRedoBtn.disabled = !canRedo;
            maskRedoBtn.style.opacity = canRedo ? '1' : '0.5';
            maskRedoBtn.style.cursor = canRedo ? 'pointer' : 'default';
        }
    }

    function undoHistory() {
        if (mHistoryIndex > 0) {
            mHistoryIndex--;
            applyHistoryState(mHistory[mHistoryIndex]);
        }
    }

    function redoHistory() {
        if (mHistoryIndex < mHistory.length - 1) {
            mHistoryIndex++;
            applyHistoryState(mHistory[mHistoryIndex]);
        }
    }

    if (maskUndoBtn) {
        maskUndoBtn.onclick = () => undoHistory();
    }

    if (maskRedoBtn) {
        maskRedoBtn.onclick = () => redoHistory();
    }

    // Prevent default context menu on maskCanvas to allow right-click erasing
    maskCanvas.addEventListener('contextmenu', (e) => {
        e.preventDefault();
    });

    // Ctrl + Wheel → brush size (paint/brush only)
    maskCanvas.addEventListener('wheel', (e) => {
        if (mode !== 'paint' || mMaskTool !== 'brush') return;
        if (!e.ctrlKey) return;
        e.preventDefault();
        const delta = e.deltaY < 0 ? 2 : -2;
        mBrushRadius = Math.max(1, Math.min(100, mBrushRadius + delta));
        if (brushSizeSlider && brushSizeVal) {
            brushSizeSlider.value = mBrushRadius;
            brushSizeVal.textContent = mBrushRadius + 'px';
        }
        redrawMaskWithActiveStroke();
        saveMaskToolPrefs();
    }, { passive: false });

    // Zoom, Pan and Reset functionality on the Canvas Area
    canvasArea = container.querySelector('.bs-canvas-area');
    let panStartX = 0;
    let panStartY = 0;

    function stopKeyEvent(e) {
        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();
    }

    const onKeyDown = (e) => {
        const tag = (document.activeElement && document.activeElement.tagName) || '';
        const typing = tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA';

        // Ctrl+Z undo · Ctrl+Shift+Z / Ctrl+Y redo
        if ((e.ctrlKey || e.metaKey) && !typing) {
            const key = (e.key || '').toLowerCase();
            if (key === 'z' && e.shiftKey) {
                stopKeyEvent(e);
                redoHistory();
                return;
            }
            if (key === 'z') {
                stopKeyEvent(e);
                undoHistory();
                return;
            }
            if (key === 'y') {
                stopKeyEvent(e);
                redoHistory();
                return;
            }
        }

        if (e.code === 'Space' && !typing) {
            stopKeyEvent(e);
            isSpacePressed = true;
            if (canvasArea) canvasArea.style.cursor = 'grab';
            return;
        }

        // Esc while drawing a shape — cancel stroke (dialog-level Esc handles close)
        if (e.key === 'Escape' && (mLassoDrawing || mRectStart || (mMaskTool === 'polygon' && mLassoPts.length > 0))) {
            stopKeyEvent(e);
            cancelLassoInProgress();
        }
    };

    const onKeyUp = (e) => {
        if (e.code === 'Space') {
            isSpacePressed = false;
            if (canvasArea) canvasArea.style.cursor = 'default';
        }
    };

    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('keyup', onKeyUp, true);

    if (canvasArea) {
        let panMoved = false;
        let lastMiddleClickTime = 0;

        canvasArea.addEventListener('wheel', (e) => {
            if (mode === 'paint' && e.ctrlKey) return;
            e.preventDefault();
            const zoomFactor = e.deltaY < 0 ? 1.15 : 1 / 1.15;
            zoomAtPointer(e.clientX, e.clientY, zoomFactor);
        }, { passive: false });

        // Prevent middle-click autoscroll
        canvasArea.addEventListener('auxclick', (e) => {
            if (e.button === 1) e.preventDefault();
        });

        canvasArea.addEventListener('mousedown', (e) => {
            const isMiddleClick = e.button === 1;
            const isLeftSpaceClick = e.button === 0 && isSpacePressed;
            if (isMiddleClick || isLeftSpaceClick) {
                isPanning = true;
                panMoved = false;
                panStartX = e.clientX - mPanX;
                panStartY = e.clientY - mPanY;
                canvasArea.style.cursor = 'grabbing';
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

        document.addEventListener('mousemove', (e) => {
            if (isPanning) {
                const nx = e.clientX - panStartX;
                const ny = e.clientY - panStartY;
                if (Math.hypot(nx - mPanX, ny - mPanY) > 3) panMoved = true;
                mPanX = nx;
                mPanY = ny;
                updateCanvasTransform();
                e.preventDefault();
                e.stopPropagation();
            }
        }, true);

        document.addEventListener('mouseup', (e) => {
            if (!isPanning) return;
            isPanning = false;
            canvasArea.style.cursor = isSpacePressed ? 'grab' : 'default';

            // Middle double-click (no drag) → reset view
            if (e.button === 1 && !panMoved) {
                const now = performance.now();
                if (now - lastMiddleClickTime < 350) {
                    resetView();
                    lastMiddleClickTime = 0;
                } else {
                    lastMiddleClickTime = now;
                }
            } else if (e.button === 1) {
                lastMiddleClickTime = 0;
            }

            e.preventDefault();
            e.stopPropagation();
        }, true);

        canvasArea.addEventListener('dblclick', (e) => {
            // Left double-click only closes polygon; view reset is middle-button
            if (mode === 'paint' && mMaskTool === 'polygon' && mLassoPts.length >= 3) {
                e.preventDefault();
                commitShape(mLassoPts, getMaskModeFromEvent(e), 'polygon');
            }
        });
    }

    function normFromEvent(e) {
        const rect = maskCanvas.getBoundingClientRect();
        return {
            x: Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width)),
            y: Math.max(0, Math.min(1, (e.clientY - rect.top) / rect.height)),
            rect
        };
    }

    function commitShape(pts, opMode, type) {
        if (!pts || pts.length < 3) {
            mLassoPts = [];
            mLassoDrawing = false;
            mRectStart = null;
            mRectCurrent = null;
            redrawMaskWithActiveStroke();
            return;
        }
        mMaskOps.push({
            type,
            mode: opMode,
            pts: pts.map(p => ({ x: p.x, y: p.y }))
        });
        mLassoPts = [];
        mLassoDrawing = false;
        mRectStart = null;
        mRectCurrent = null;
        saveHistoryState();
        redrawMask();
    }

    function nearFirstPoint(nx, ny, thresholdPx = 10) {
        if (mLassoPts.length < 3) return false;
        const rect = maskCanvas.getBoundingClientRect();
        const dx = (nx - mLassoPts[0].x) * rect.width;
        const dy = (ny - mLassoPts[0].y) * rect.height;
        return Math.hypot(dx, dy) < thresholdPx;
    }

    function isPaintPointerEvent(e) {
        if (mode !== 'paint') return false;
        if (isSpacePressed || e.button === 1) return false;
        const t = e.target;
        if (t === maskCanvas || t === canvasContainer) return true;
        if (canvasContainer.contains(t)) return true;
        return false;
    }

    function onPaintPointerDown(e) {
        if (!isPaintPointerEvent(e)) return;

        if (maskCanvas.width < 2 || maskCanvas.height < 2) onImageLoad();

        e.preventDefault();
        e.stopPropagation();

        const { x, y } = normFromEvent(e);
        const opMode = getMaskModeFromEvent(e);

        try { maskCanvas.setPointerCapture(e.pointerId); } catch (_) {}

        if (mMaskTool === 'brush') {
            mBrushDrawing = true;
            mBrushMode = opMode;
            mBrushPts = [{ x, y }];
            mBrushCursorPos = { x, y };
            redrawMaskWithActiveStroke();
            return;
        }

        if (mMaskTool === 'lasso') {
            if (e.button !== 0 && !e.altKey && !e.shiftKey) return;
            mLassoDrawing = true;
            mBrushMode = opMode;
            mLassoPts = [{ x, y }];
            redrawMaskWithActiveStroke();
            return;
        }

        if (mMaskTool === 'rect') {
            if (e.button !== 0 && !e.altKey && !e.shiftKey) return;
            mBrushMode = opMode;
            mRectStart = { x, y };
            mRectCurrent = { x, y };
            redrawMaskWithActiveStroke();
            return;
        }

        if (mMaskTool === 'polygon') {
            if (e.button !== 0) return;
            mBrushMode = opMode;
            if (nearFirstPoint(x, y)) {
                commitShape(mLassoPts, opMode, 'polygon');
                return;
            }
            mLassoPts.push({ x, y });
            redrawMaskWithActiveStroke();
        }
    }

    function onPaintPointerMove(e) {
        if (mode !== 'paint' && !mBrushDrawing && !mLassoDrawing && !mRectStart) return;

        const { x, y } = normFromEvent(e);
        mBrushCursorPos = { x, y };

        if (mode !== 'paint') {
            setBoxSelectTip(false);
            return;
        }

        if (!mBrushDrawing && !mLassoDrawing && !mRectStart) {
            updateBoxSelectTipFromPointer(e.clientX, e.clientY);
        } else {
            setBoxSelectTip(false);
        }

        if (mMaskTool === 'brush') {
            if (!mBrushDrawing) {
                redrawMaskWithActiveStroke();
                return;
            }
            mBrushPts.push({ x, y });
            redrawMaskWithActiveStroke();
            return;
        }

        if (mMaskTool === 'lasso' && mLassoDrawing) {
            mLassoPts.push({ x, y });
            redrawMaskWithActiveStroke();
            return;
        }

        if (mMaskTool === 'rect' && mRectStart) {
            mRectCurrent = { x, y };
            redrawMaskWithActiveStroke();
            return;
        }

        if (mMaskTool === 'polygon' && mLassoPts.length > 0) {
            mRectCurrent = { x, y };
            redrawMaskWithActiveStroke();
        }
    }

    function onPaintPointerUp(e) {
        if (mode !== 'paint' && !mBrushDrawing && !mLassoDrawing && !mRectStart) return;

        try { maskCanvas.releasePointerCapture(e.pointerId); } catch (_) {}

        if (mMaskTool === 'brush') {
            if (!mBrushDrawing) return;
            mBrushDrawing = false;
            const { x, y, rect } = normFromEvent(e);
            mBrushPts.push({ x, y });
            const denom = Math.max(1, rect.width / Math.max(0.01, mZoom));
            mMaskOps.push({
                type: 'brush',
                mode: mBrushMode,
                pts: mBrushPts,
                r: mBrushRadius / denom,
                shape: mBrushShape
            });
            saveHistoryState();
            redrawMask();
            return;
        }

        if (mMaskTool === 'lasso' && mLassoDrawing) {
            mLassoDrawing = false;
            commitShape(mLassoPts, mBrushMode, 'lasso');
            return;
        }

        if (mMaskTool === 'rect' && mRectStart && mRectCurrent) {
            const x1 = mRectStart.x, y1 = mRectStart.y;
            const x2 = mRectCurrent.x, y2 = mRectCurrent.y;
            const pts = [
                { x: x1, y: y1 },
                { x: x2, y: y1 },
                { x: x2, y: y2 },
                { x: x1, y: y2 },
            ];
            const opMode = mBrushMode;
            mRectStart = null;
            mRectCurrent = null;
            commitShape(pts, opMode, 'rect');
        }
    }

    function onPaintPointerCancel(e) {
        mBrushCursorPos = null;
        try { maskCanvas.releasePointerCapture(e.pointerId); } catch (_) {}
        if (mBrushDrawing) {
            if (mBrushPts.length > 0) {
                const rect = maskCanvas.getBoundingClientRect();
                const denom = Math.max(1, rect.width / Math.max(0.01, mZoom));
                mMaskOps.push({
                    type: 'brush',
                    mode: mBrushMode,
                    pts: mBrushPts.slice(),
                    r: mBrushRadius / denom,
                    shape: mBrushShape
                });
                saveHistoryState();
            }
            mBrushDrawing = false;
            redrawMask();
            return;
        }
        if (mLassoDrawing || mRectStart) cancelLassoInProgress();
        else redrawMask();
    }

    // Paint on the whole canvas container so strokes work even if the hit
    // lands on the image or the locked box under the mask canvas.
    canvasContainer.addEventListener('pointerdown', onPaintPointerDown);
    canvasContainer.addEventListener('pointermove', onPaintPointerMove);
    window.addEventListener('pointerup', onPaintPointerUp);
    window.addEventListener('pointercancel', onPaintPointerCancel);
    canvasContainer.addEventListener('contextmenu', (e) => {
        if (mode === 'paint') e.preventDefault();
    });

    // Offscreen buffer — paint mask solid, then blit with preview opacity
    function getMaskOffscreen() {
        if (!_maskOffscreen ||
            _maskOffscreen.width !== maskCanvas.width ||
            _maskOffscreen.height !== maskCanvas.height) {
            _maskOffscreen = document.createElement('canvas');
            _maskOffscreen.width = maskCanvas.width || 1;
            _maskOffscreen.height = maskCanvas.height || 1;
        }
        return _maskOffscreen;
    }

    function drawBrushStroke(ctx, pts, r, shape, scaleX, scaleY) {
        if (pts.length === 0) return;
        const step = Math.max(1, r * 0.35);

        const stamp = (px, py) => {
            if (shape === 'square') {
                ctx.fillRect(px - r, py - r, r * 2, r * 2);
            } else {
                ctx.beginPath();
                ctx.arc(px, py, r, 0, Math.PI * 2);
                ctx.fill();
            }
        };

        for (let i = 0; i < pts.length; i++) {
            const px = pts[i].x * scaleX;
            const py = pts[i].y * scaleY;
            stamp(px, py);
            if (i < pts.length - 1) {
                const nx = pts[i + 1].x * scaleX;
                const ny = pts[i + 1].y * scaleY;
                const dx = nx - px, dy = ny - py;
                const dist = Math.hypot(dx, dy);
                const steps = Math.ceil(dist / step);
                for (let j = 1; j < steps; j++) {
                    const t = j / steps;
                    stamp(px + dx * t, py + dy * t);
                }
            }
        }
    }

    function drawFilledShape(ctx, pts, scaleX, scaleY) {
        if (!pts || pts.length < 3) return;
        ctx.beginPath();
        ctx.moveTo(pts[0].x * scaleX, pts[0].y * scaleY);
        for (let i = 1; i < pts.length; i++) {
            ctx.lineTo(pts[i].x * scaleX, pts[i].y * scaleY);
        }
        ctx.closePath();
        ctx.fill();
    }

    function applyOpComposite(ctx, opMode) {
        if (mMaskInverted) {
            if (opMode === 'add') {
                ctx.globalCompositeOperation = 'destination-out';
            } else {
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = mMaskColor;
                ctx.strokeStyle = mMaskColor;
            }
        } else {
            if (opMode === 'add') {
                ctx.globalCompositeOperation = 'source-over';
                ctx.fillStyle = mMaskColor;
                ctx.strokeStyle = mMaskColor;
            } else {
                ctx.globalCompositeOperation = 'destination-out';
            }
        }
    }

    /** Paint all committed ops (+ optional live brush) at full opacity onto offscreen. */
    function renderMaskSolid(includeActiveBrush) {
        const off = getMaskOffscreen();
        const ctx = off.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, off.width, off.height);

        const hasOps = mMaskOps.length > 0 || mMaskInverted ||
            (includeActiveBrush && mBrushDrawing && mBrushPts.length > 0);
        if (!hasOps) return off;

        if (mMaskInverted) {
            ctx.fillStyle = mMaskColor;
            ctx.fillRect(0, 0, off.width, off.height);
        }

        const scaleX = off.width;
        const scaleY = off.height;

        for (const op of mMaskOps) {
            const opMode = op.mode || 'add';
            applyOpComposite(ctx, opMode);
            ctx.globalAlpha = 1;

            if (op.type === 'brush') {
                const pts = op.pts || [];
                if (pts.length === 0) continue;
                drawBrushStroke(ctx, pts, op.r * scaleX, op.shape || 'circle', scaleX, scaleY);
            } else if (op.type === 'lasso' || op.type === 'polygon' || op.type === 'rect') {
                drawFilledShape(ctx, op.pts || [], scaleX, scaleY);
            }
        }

        if (includeActiveBrush && mBrushDrawing && mBrushPts.length > 0) {
            applyOpComposite(ctx, mBrushMode);
            ctx.globalAlpha = 1;
            if (mBrushMode === 'sub') {
                ctx.fillStyle = 'rgba(0,0,0,1)';
                ctx.strokeStyle = 'rgba(0,0,0,1)';
            }
            const r = (mBrushRadius / Math.max(1, maskCanvas.offsetWidth)) * maskCanvas.width;
            drawBrushStroke(ctx, mBrushPts, r, mBrushShape, scaleX, scaleY);
        }

        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        return off;
    }

    function redrawMask() {
        const ctx = maskCanvas.getContext('2d');
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCanvas.style.opacity = '1';

        if (mMaskOps.length > 0 || mMaskInverted) {
            const off = renderMaskSolid(false);
            const previewA = (mMaskAlpha !== undefined ? mMaskAlpha : 50) / 100;
            ctx.save();
            ctx.globalAlpha = previewA;
            ctx.drawImage(off, 0, 0);
            ctx.restore();
        }
        updateShapePreviewSvg();
    }

    // Screen-space SVG overlay for lasso/poly/rect — constant thin stroke, independent of zoom
    function ensureShapePreviewSvg() {
        if (shapePreviewSvg && shapePreviewSvg.isConnected) return shapePreviewSvg;
        const area = container.querySelector('.bs-canvas-area');
        if (!area) return null;
        shapePreviewSvg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        shapePreviewSvg.setAttribute('class', 'bs-shape-preview');
        shapePreviewSvg.setAttribute('aria-hidden', 'true');
        shapePreviewSvg.style.cssText = [
            'position:absolute',
            'inset:0',
            'width:100%',
            'height:100%',
            'pointer-events:none',
            'z-index:25',
            'overflow:visible',
        ].join(';');
        area.appendChild(shapePreviewSvg);
        return shapePreviewSvg;
    }

    function getShapePreviewPts() {
        let previewPts = null;
        let closePreview = false;
        if (mMaskTool === 'lasso' && mLassoPts.length > 1) {
            previewPts = mLassoPts;
            closePreview = true;
        } else if (mMaskTool === 'polygon' && mLassoPts.length > 0) {
            previewPts = mLassoPts.slice();
            if (mRectCurrent) previewPts.push(mRectCurrent);
            closePreview = false;
        } else if (mMaskTool === 'rect' && mRectStart && mRectCurrent) {
            previewPts = [
                mRectStart,
                { x: mRectCurrent.x, y: mRectStart.y },
                mRectCurrent,
                { x: mRectStart.x, y: mRectCurrent.y },
            ];
            closePreview = true;
        }
        return { previewPts, closePreview };
    }

    function updateShapePreviewSvg() {
        const svg = ensureShapePreviewSvg();
        if (!svg) return;
        while (svg.firstChild) svg.removeChild(svg.firstChild);

        const { previewPts, closePreview } = getShapePreviewPts();
        if (!previewPts || previewPts.length === 0) return;

        const area = container.querySelector('.bs-canvas-area');
        if (!area) return;
        const areaRect = area.getBoundingClientRect();
        const maskRect = maskCanvas.getBoundingClientRect();
        if (maskRect.width < 1 || maskRect.height < 1) return;

        const toLocal = (p) => ({
            x: maskRect.left + p.x * maskRect.width - areaRect.left,
            y: maskRect.top + p.y * maskRect.height - areaRect.top,
        });
        const locals = previewPts.map(toLocal);
        let d = `M${locals[0].x.toFixed(2)} ${locals[0].y.toFixed(2)}`;
        for (let i = 1; i < locals.length; i++) {
            d += ` L${locals[i].x.toFixed(2)} ${locals[i].y.toFixed(2)}`;
        }
        if (closePreview) d += ' Z';

        const NS = 'http://www.w3.org/2000/svg';
        const addPath = (stroke, width, dash) => {
            const path = document.createElementNS(NS, 'path');
            path.setAttribute('d', d);
            path.setAttribute('fill', 'none');
            path.setAttribute('stroke', stroke);
            path.setAttribute('stroke-width', String(width));
            path.setAttribute('stroke-linejoin', 'round');
            path.setAttribute('stroke-linecap', 'round');
            path.setAttribute('vector-effect', 'non-scaling-stroke');
            if (dash) path.setAttribute('stroke-dasharray', dash);
            svg.appendChild(path);
        };

        // Hairline dual stroke in screen pixels
        addPath('rgba(0,0,0,0.75)', 2.25, null);
        addPath('#ffffff', 1, '4 3');

        if (mMaskTool === 'polygon' && mLassoPts.length > 0) {
            const start = toLocal(mLassoPts[0]);
            const near = mRectCurrent && nearFirstPoint(mRectCurrent.x, mRectCurrent.y);
            const ring = document.createElementNS(NS, 'circle');
            ring.setAttribute('cx', start.x.toFixed(2));
            ring.setAttribute('cy', start.y.toFixed(2));
            ring.setAttribute('r', near ? '5' : '3.5');
            ring.setAttribute('fill', 'none');
            ring.setAttribute('stroke', near ? '#44ff44' : '#7ab0ff');
            ring.setAttribute('stroke-width', '1');
            ring.setAttribute('vector-effect', 'non-scaling-stroke');
            svg.appendChild(ring);
        }
    }

    function drawShapePreviewOnCanvas(ctx, scaleX, scaleY, strokeW) {
        const { previewPts, closePreview } = getShapePreviewPts();
        if (!previewPts || previewPts.length === 0) return;

        ctx.save();
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.lineWidth = strokeW;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        ctx.setLineDash([]);
        ctx.beginPath();
        ctx.moveTo(previewPts[0].x * scaleX, previewPts[0].y * scaleY);
        for (let i = 1; i < previewPts.length; i++) {
            ctx.lineTo(previewPts[i].x * scaleX, previewPts[i].y * scaleY);
        }
        if (closePreview && previewPts.length > 2) ctx.closePath();

        ctx.strokeStyle = 'rgba(0,0,0,0.85)';
        ctx.stroke();
        ctx.strokeStyle = '#ffffff';
        ctx.setLineDash([Math.max(2, 4 * strokeW), Math.max(2, 3 * strokeW)]);
        ctx.stroke();
        ctx.setLineDash([]);

        if (mMaskTool === 'polygon' && mLassoPts.length > 0) {
            const start = mLassoPts[0];
            const near = mRectCurrent && nearFirstPoint(mRectCurrent.x, mRectCurrent.y);
            const pr = (near ? 5 : 3.5) * (strokeW / 1.25);
            ctx.beginPath();
            ctx.arc(start.x * scaleX, start.y * scaleY, pr, 0, Math.PI * 2);
            ctx.strokeStyle = near ? '#44ff44' : '#7ab0ff';
            ctx.lineWidth = strokeW;
            ctx.stroke();
        }
        ctx.restore();
    }

    function redrawMaskWithActiveStroke() {
        const ctx = maskCanvas.getContext('2d');
        const scaleX = maskCanvas.width;
        const scaleY = maskCanvas.height;
        // Screen-constant stroke for brush cursor / shape preview (compensate CSS zoom)
        const px = Math.max(1, maskCanvas.width / Math.max(1, maskCanvas.offsetWidth));
        const strokeW = (1.25 * px) / Math.max(0.01, mZoom);
        const previewA = (mMaskAlpha !== undefined ? mMaskAlpha : 50) / 100;

        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.globalAlpha = 1;
        ctx.globalCompositeOperation = 'source-over';
        ctx.clearRect(0, 0, maskCanvas.width, maskCanvas.height);
        maskCanvas.style.opacity = '1';

        const hasContent = mMaskOps.length > 0 || mMaskInverted ||
            (mBrushDrawing && mBrushPts.length > 0);
        if (hasContent) {
            const off = renderMaskSolid(true);
            ctx.save();
            ctx.globalAlpha = previewA;
            ctx.drawImage(off, 0, 0);
            ctx.restore();
        }

        // Live outline on canvas (reliable) + SVG overlay (screen-constant)
        drawShapePreviewOnCanvas(ctx, scaleX, scaleY, strokeW);
        updateShapePreviewSvg();

        // Brush cursor (thickness compensated for zoom)
        if (mBrushCursorPos && mMaskTool === 'brush') {
            ctx.save();
            ctx.globalAlpha = 1;
            ctx.globalCompositeOperation = 'source-over';
            ctx.lineWidth = strokeW;
            ctx.shadowColor = 'rgba(0,0,0,0.8)';
            ctx.shadowBlur = 2 * px / Math.max(0.01, mZoom);
            const r = (mBrushRadius / maskCanvas.offsetWidth) * maskCanvas.width;
            ctx.beginPath();
            if (mBrushShape === 'square') {
                ctx.rect(mBrushCursorPos.x * scaleX - r, mBrushCursorPos.y * scaleY - r, r * 2, r * 2);
            } else {
                ctx.arc(mBrushCursorPos.x * scaleX, mBrushCursorPos.y * scaleY, r, 0, Math.PI * 2);
            }
            ctx.strokeStyle = 'rgba(0,0,0,0.85)';
            ctx.stroke();
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
            ctx.restore();
        }
    }



    console.log("[CanvasSelector] Init complete — mode buttons and hotkeys ready");

    const onWindowBlur = () => {
        isSpacePressed = false;
        isPanning = false;
    };
    window.addEventListener('blur', onWindowBlur);

    const selectorPublicApi = {
        getCoordinates: () => {
            // Calcola il fattore di scala combinato (Backend + Browser CSS)
            const serverScale = parseFloat(backgroundImage.dataset.scaleFactor || "1");
            const browserScale = backgroundImage.offsetWidth / (backgroundImage.naturalWidth || backgroundImage.offsetWidth);
            const totalScale = serverScale * browserScale;

            console.log(`[BoxBox] Getting coordinates - ServerScale: ${serverScale}, BrowserScale: ${browserScale.toFixed(3)}, Total: ${totalScale.toFixed(3)}`);

            const baseX1 = baseX;
            const baseY1 = baseY;
            const baseX2 = baseX + baseWidth;
            const baseY2 = baseY + baseHeight;

            let effectiveX1 = baseX1;
            let effectiveY1 = baseY1;
            let effectiveX2 = baseX2;
            let effectiveY2 = baseY2;

            if (borderPosition === 'outside') {
                effectiveX1 = Math.max(0, baseX1 - currentBorderWidth);
                effectiveY1 = Math.max(0, baseY1 - currentBorderWidth);
                effectiveX2 = baseX2 + currentBorderWidth;
                effectiveY2 = baseY2 + currentBorderWidth;
            } else {
                effectiveX1 = baseX1 + currentBorderWidth;
                effectiveY1 = baseY1 + currentBorderWidth;
                effectiveX2 = Math.max(effectiveX1 + 1, baseX2 - currentBorderWidth);
                effectiveY2 = Math.max(effectiveY1 + 1, baseY2 - currentBorderWidth);
            }

            // Round to integers using width/height (not independent corners) so
            // locked ratios like 1:1 never become 1024x1023 after Math.round().
            const snapStep = getSnapStep();
            let rx1, ry1, rw, rh;
            if (snapStep > 1) {
                // Keep sub-pixel display values; the Python node converts them
                // to real pixels and snaps them exactly.
                const r3 = (v) => Math.round(v * 1000) / 1000;
                rx1 = r3(effectiveX1);
                ry1 = r3(effectiveY1);
                rw = r3(Math.abs(effectiveX2 - effectiveX1));
                rh = r3(Math.abs(effectiveY2 - effectiveY1));
            } else {
                rx1 = Math.round(effectiveX1);
                ry1 = Math.round(effectiveY1);
                rw = Math.max(1, Math.round(Math.abs(effectiveX2 - effectiveX1)));
                rh = Math.max(1, Math.round(Math.abs(effectiveY2 - effectiveY1)));

                if (aspectRatioValue !== null && aspectRatioValue > 0) {
                    rh = Math.max(1, Math.round(rw / aspectRatioValue));
                }
            }

            const rx2 = rx1 + rw;
            const ry2 = ry1 + rh;

            console.log(`[BoxBox] Final coordinates: (${rx1}, ${ry1}) to (${rx2}, ${ry2}) [${rw}x${rh}]`);

            return {
                x1: rx1,
                y1: ry1,
                x2: rx2,
                y2: ry2,
                borderWidth: currentBorderWidth,
                borderPosition: borderPosition,
                displayScaleFactor: totalScale,
                displayScaleX: getAxisScales().sx,
                displayScaleY: getAxisScales().sy,
                snapTo: snapStep,
                aspectRatio: aspectRatioMode === "custom" ? getCustomAspectLabel() : aspectRatioMode,
                maskOps: mMaskOps,
                maskInverted: mMaskInverted,
                maskColor: mMaskColor,
                maskAlpha: mMaskAlpha
            };
        },
        getState: () => ({
            exists: rectangleExists,
            baseX, baseY, baseWidth, baseHeight,
            borderWidth: currentBorderWidth,
            borderPosition
        }),
        cleanup: () => {
            window.removeEventListener('keydown', onKeyDown, true);
            window.removeEventListener('keyup', onKeyUp, true);
            window.removeEventListener('blur', onWindowBlur);
            window.removeEventListener('pointerup', onPaintPointerUp);
            window.removeEventListener('pointercancel', onPaintPointerCancel);
        },
        setModeBox,
        setModeMask,
        clearMask,
        cancelLassoInProgress,
        resetRectangle: () => {
            if (typeof resetRectangle === 'function') resetRectangle();
        },
        getMode: () => mode,
        hasShapeInProgress: () => !!(mLassoDrawing || mRectStart || (mMaskTool === 'polygon' && mLassoPts.length > 0)),
    };

    container._boxBoxApi = Object.assign(container._boxBoxApi || {}, selectorPublicApi);
    return selectorPublicApi;
}

window.CanvasSelector = { initializeCanvasSelector };

console.log("[BoxBox] Preparing to register extension...");

app.registerExtension({
    name: "BoxBox.BoxSelectorExtension",

    async setup(app) {
        console.log("[BoxBox] Setup extension called");
    },

    async beforeRegisterNodeDef(nodeType, nodeData, app) {
        // Log every node to see what's happening
        if (nodeData.name && nodeData.name.includes("Box")) {
            console.log(`[BoxBox] Checking node: ${nodeData.name}`);
        }

        if (nodeData.name !== "BoxSelector") return;

        nodeType.canvasOnly = true; // Force classic canvas rendering for compatibility with Nodes 2.0
        console.log("[BoxBox] Found BoxSelector node! Adding button...");

        const onNodeCreated = nodeType.prototype.onNodeCreated;
        nodeType.prototype.onNodeCreated = function () {
            const r = onNodeCreated?.apply(this, arguments);
            const node = this;

            console.log("[BoxBox] Node instance created, attaching button widgets...");

            // Button 1: Image Cache — executes only the BoxSelector subgraph
            const cacheBtn = this.addWidget("button", "🖼️ Image Cache", null, async () => {
                console.log("[BoxBox] Image Cache clicked, auto-executing subgraph...");
                const success = await autoExecuteForPreview(node, app);
                if (!success) {
                    alert("⚠️ Could not generate preview.\n\nMake sure an image source is connected.");
                }
            });

            // Button 2: Select Box — opens the region selector dialog
            const selectBtn = this.addWidget("button", "📦 Select Box", null, () => {
                console.log("[BoxBox] Select Box clicked!");
                openRegionDialog(node, app);
            });

            // Hide box_metadata from the user — it stores selection/mask JSON internally
            // but must not appear as a visible text field on the node.
            const metadataWidget = this.widgets.find(w => w.name === "box_metadata");
            if (metadataWidget) {
                if (metadataWidget.value === null || metadataWidget.value === undefined) {
                    metadataWidget.value = "{}";
                }
                metadataWidget.type = "hidden";
                metadataWidget.computeSize = () => [0, -4];
                metadataWidget.draw = () => {};
            }

            // Shrink node height after hiding the metadata field
            requestAnimationFrame(() => {
                if (typeof this.computeSize === "function") {
                    this.setSize?.(this.computeSize());
                }
                this.setDirtyCanvas?.(true, true);
            });

            return r;
        };
    },
});

/**
 * Recursively searches for image metadata by traversing the node chain backwards
 * @returns {Object|null} - Image metadata {filename, type, subfolder} if found, null otherwise
 */
function findImageInChain(node, app, depth = 0, maxDepth = 20) {
    if (depth > maxDepth) return null;

    console.log(`[RegionSelectorExt] Searching at depth ${depth}, node type: ${node.type} (${node.comfyClass})`);

    // 1. Check if the node has preview images (standard ComfyUI way)
    if (node.imgs && node.imgs.length > 0) {
        const img = node.imgs[0];
        // Ensure it's a real image and not just a placeholder from some nodes
        if (img.filename && !img.filename.startsWith("$")) {
            console.log(`[RegionSelectorExt] ✅ Found image in node.imgs at depth ${depth}:`, img);
            return {
                filename: img.filename,
                type: img.type || "temp",
                subfolder: img.subfolder || ""
            };
        }
    }

    // 2. Check for common widgets that hold image names
    if (node.widgets) {
        // Look for any widget that might contain a filename
        const imageWidget = node.widgets.find(w => w.name === "image" || w.name === "image_name");
        if (imageWidget && imageWidget.value && typeof imageWidget.value === "string") {
            // Check if it looks like a real filename (has extension) or a special ID
            if (imageWidget.value.includes(".") || imageWidget.value.startsWith("$")) {
                console.log(`[RegionSelectorExt] ✅ Found image widget at depth ${depth}:`, imageWidget.name, "=", imageWidget.value);
                return {
                    filename: imageWidget.value,
                    type: "input", // Fallback, will be corrected for $ IDs later
                    subfolder: ""
                };
            }
        }
    }

    // 3. Traverse backwards through IMAGE inputs
    if (node.inputs && node.inputs.length > 0) {
        for (const input of node.inputs) {
            if (input.type === "IMAGE" && input.link !== undefined && input.link !== null) {
                const link = app.graph.links[input.link];
                if (link) {
                    const sourceNode = app.graph._nodes_by_id[link.origin_id];
                    if (sourceNode) {
                        const result = findImageInChain(sourceNode, app, depth + 1, maxDepth);
                        if (result) return result;
                    }
                }
            }
        }
    }

    return null;
}

/**
 * Apre il dialog del selettore di regioni
 */
/**
 * Recursively collects a node and all its input dependencies from the serialized prompt.
 * Used to build a minimal prompt that only executes the BoxSelector subgraph.
 */
function recursiveAddNodes(nodeId, oldOutput, newOutput) {
    const currentId = String(nodeId);
    const currentNode = oldOutput[currentId];
    if (!currentNode || newOutput[currentId] != null) return newOutput;

    newOutput[currentId] = currentNode;
    for (const inputValue of Object.values(currentNode.inputs || {})) {
        if (Array.isArray(inputValue) && inputValue.length >= 2) {
            recursiveAddNodes(inputValue[0], oldOutput, newOutput);
        }
    }
    return newOutput;
}

/**
 * Auto-executes the BoxSelector node and its upstream dependencies,
 * then waits for the execution to complete.
 * Returns true if execution succeeded, false otherwise.
 */
async function autoExecuteForPreview(node, app) {
    console.log("[BoxBox] Auto-executing node", node.id, "to generate preview...");

    return new Promise(async (resolve) => {
        let resolved = false;
        const targetNodeId = String(node.id);

        function cleanup() {
            api.removeEventListener("executed", onExecuted);
            api.removeEventListener("status", onStatus);
            api.removeEventListener("execution_error", onError);
        }

        // Track if our queue has started executing (to avoid false positives from
        // an already-empty queue status event before execution begins)
        let executionStarted = false;
        let ourNodeExecuted = false;

        // Listen for per-node completion — mark that our node has finished
        const onExecuted = (event) => {
            const eventNodeId = String(event.detail?.node ?? "");
            console.log(`[BoxBox] 'executed' event for node ${eventNodeId} (waiting for ${targetNodeId})`);
            executionStarted = true;
            if (eventNodeId === targetNodeId) {
                ourNodeExecuted = true;
                // Resolve immediately — our node is done
                if (!resolved) {
                    resolved = true;
                    cleanup();
                    console.log("[BoxBox] ✅ Node", targetNodeId, "executed (via 'executed' event)");
                    resolve(true);
                }
            }
        };

        // Listen for queue drain — reliable backup signal
        const onStatus = (event) => {
            const queueRemaining = event.detail?.exec_info?.queue_remaining
                ?? event.detail?.status?.exec_info?.queue_remaining;
            if (queueRemaining === 0 && executionStarted && !resolved) {
                resolved = true;
                cleanup();
                console.log("[BoxBox] ✅ Queue drained (via 'status' event), node executed:", ourNodeExecuted);
                resolve(true);
            }
        };

        const onError = (event) => {
            // Only treat it as our error if execution had started
            if (executionStarted && !resolved) {
                resolved = true;
                cleanup();
                console.error("[BoxBox] ❌ Execution error", event.detail);
                resolve(false);
            }
        };

        // Safety timeout (30 seconds)
        setTimeout(() => {
            if (!resolved) {
                resolved = true;
                cleanup();
                console.warn("[BoxBox] ⏱️ Auto-execute timed out after 30s");
                resolve(false);
            }
        }, 30000);

        api.addEventListener("executed", onExecuted);
        api.addEventListener("status", onStatus);
        api.addEventListener("execution_error", onError);

        try {
            // Give LiteGraph a moment to settle if the node was just added/modified
            await new Promise(r => setTimeout(r, 100));

            // Serialize the full graph
            const prompt = await app.graphToPrompt();

            if (!prompt?.output?.[targetNodeId]) {
                console.warn("[BoxBox] Node not found in current prompt, retrying serialization...");
                // Second attempt after a longer delay
                await new Promise(r => setTimeout(r, 300));
                const retryPrompt = await app.graphToPrompt();
                if (!retryPrompt?.output?.[targetNodeId]) {
                    console.error("[BoxBox] Fatal: Node", targetNodeId, "missing from prompt after retry.");
                    resolved = true;
                    cleanup();
                    resolve(false);
                    return;
                }
                prompt.output = retryPrompt.output;
            }

            // Prune prompt to only include BoxSelector and its upstream dependencies
            const prunedOutput = recursiveAddNodes(targetNodeId, prompt.output, {});
            prompt.output = prunedOutput;

            console.log("[BoxBox] Queuing partial execution with", Object.keys(prunedOutput).length, "nodes");

            // Queue the pruned prompt
            await api.queuePrompt(0, prompt);
        } catch (e) {
            console.error("[BoxBox] Failed to queue auto-execute:", e);
            if (!resolved) {
                resolved = true;
                cleanup();
                resolve(false);
            }
        }
    });
}

async function openRegionDialog(node, app) {
    console.log("[RegionSelectorExt] Opening dialog...");

    let imageInfo = null;
    const nodeId = node.id;

    // === PRIMARY: Try backend preview (set by Image Cache or previous execution) ===
    try {
        const previewRes = await fetch(`/region_selector/preview?node_id=${nodeId}`);
        if (previewRes.ok) {
            const previewData = await previewRes.json();
            if (previewData.found) {
                imageInfo = {
                    filename: previewData.filename,
                    type: previewData.type || "temp",
                    subfolder: previewData.subfolder || ""
                };
                console.log("[RegionSelectorExt] ✅ Got image from backend preview cache:", imageInfo);
            }
        }
    } catch (e) {
        console.warn("[RegionSelectorExt] Backend preview fetch failed:", e);
    }

    // === FALLBACK: Traverse node chain (works for LoadImage, PreviewBridge) ===
    if (!imageInfo) {
        if (node.inputs && node.inputs[0]?.link != null) {
            const link = app.graph.links[node.inputs[0].link];
            if (link) {
                const sourceNode = app.graph._nodes_by_id[link.origin_id];
                imageInfo = findImageInChain(sourceNode, app);
            }
        }
        if (!imageInfo) {
            imageInfo = findImageInChain(node, app);
        }
    }

    if (!imageInfo || !imageInfo.filename) {
        alert("⚠️ No image found!\n\nClick '🖼️ Image Cache' first to generate the preview.");
        return;
    }

    // SPECIAL HANDLING: Impact Pack PreviewBridge IDs ($...)
    if (imageInfo.filename.startsWith("$")) {
        console.log("[RegionSelectorExt] Detected PreviewBridge ID, attempting to resolve:", imageInfo.filename);
        try {
            const response = await fetch(`/impact/get/pb_id_image?id=${encodeURIComponent(imageInfo.filename)}`);
            if (response.ok) {
                const pbInfo = await response.json();
                console.log("[RegionSelectorExt] Resolved PreviewBridge ID:", pbInfo);
                imageInfo = {
                    filename: pbInfo.filename,
                    type: pbInfo.type || "temp",
                    subfolder: pbInfo.subfolder || ""
                };
            } else {
                console.warn("[RegionSelectorExt] Failed to resolve PreviewBridge ID via API");
            }
        } catch (e) {
            console.error("[RegionSelectorExt] Error resolving PreviewBridge ID via API:", e);
        }
    }

    // Construct URL - use direct path /view to avoid /api/view ambiguity
    const params = new URLSearchParams();
    params.append("filename", imageInfo.filename);
    params.append("type", imageInfo.type || "input");
    if (imageInfo.subfolder) params.append("subfolder", imageInfo.subfolder);

    // Use ROOT /view as standard ComfyUI does
    const imageUrl = `/view?${params.toString()}`;
    console.log("[RegionSelectorExt] Final Image URL:", imageUrl);

    // Crea il dialog usando la API moderna o il fallback sicuro
    let dialog;
    try {
        if (window.comfyAPI && window.comfyAPI.ui && window.comfyAPI.ui.ComfyDialog) {
            dialog = new window.comfyAPI.ui.ComfyDialog();
        } else {
            // Fallback for older versions or when bus bridge is active
            const { ComfyDialog } = await import("../../scripts/ui.js");
            dialog = new ComfyDialog();
        }
    } catch (e) {
        console.error("[BoxBox] Failed to create dialog via modern API, trying fallback:", e);
        // Fallback estremo: molti nodi usano app.ui.dialog o simili
        if (app.ui && app.ui.dialog) {
            dialog = app.ui.dialog;
        } else {
            alert("Error: ComfyUI Dialog system not available. Please check console (F12).");
            return;
        }
    }

    dialog.element.style.width = "clamp(700px, 90vw, 1920px)";
    dialog.element.style.height = "clamp(480px, 88vh, 1200px)";
    dialog.element.style.maxWidth = "none";
    dialog.element.style.maxHeight = "none";
    dialog.element.style.borderRadius = "12px";
    dialog.element.style.overflow = "hidden";
    dialog.element.style.border = "1px solid rgba(255,255,255,0.06)";
    dialog.element.style.boxShadow = "0 32px 64px rgba(0,0,0,0.5), 0 0 0 1px rgba(255,255,255,0.04)";

    // Create main container
    const container = document.createElement("div");
    container.style.cssText = `
        width: 100%;
        height: 100%;
        display: flex;
        flex-direction: column;
        background: #0f0f1a;
        font-family: 'Inter', 'Segoe UI', system-ui, -apple-system, sans-serif;
        color: #e0e4ec;
        position: relative;
    `;

    // Inject modern styles
    const styleTag = document.createElement("style");
    styleTag.textContent = `
        @import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap');

        /* ═══ Selection Rectangle ═══ */
        .rectangle {
            position: absolute;
            background-color: rgba(99, 102, 241, 0.08);
            cursor: move;
            transition: none;
            z-index: 10;
        }
        #canvas-container.bs-mask-mode .rectangle,
        #canvas-container.bs-mask-mode .resize-handle {
            pointer-events: none !important;
            cursor: default !important;
        }
        #canvas-container.bs-mask-mode #mask-canvas {
            pointer-events: auto !important;
            z-index: 50 !important;
        }
        #canvas-container.bs-mask-mode .resize-handle {
            display: none !important;
        }
        .rectangle.border-inside {
            border: 2px solid #818cf8;
            box-shadow: 0 0 0 1px rgba(129, 140, 248, 0.15), inset 0 0 20px rgba(99, 102, 241, 0.06);
        }
        .rectangle.border-outside {
            outline: 2px solid #818cf8;
            outline-offset: 0px;
        }
        .rectangle.thick-border {
            box-shadow: 0 0 16px rgba(99, 102, 241, 0.25), 0 0 0 1px rgba(129, 140, 248, 0.2);
        }

        /* ═══ Resize Handles ═══ */
        .resize-handle {
            position: absolute;
            background: #818cf8;
            z-index: 20;
            opacity: 0.85;
            transition: all 0.15s ease;
            border-radius: 2px;
        }
        .resize-handle:hover {
            opacity: 1;
            background: #a5b4fc;
            box-shadow: 0 0 10px rgba(129, 140, 248, 0.7);
            transform: scale(1.2);
        }

        /* Edge handles */
        .resize-handle.top, .resize-handle.bottom {
            width: 100%; height: 6px; cursor: ns-resize;
            border-radius: 0;
            opacity: 0;
        }
        .resize-handle.top:hover, .resize-handle.bottom:hover { opacity: 0.6; transform: scaleY(1.5); }
        .resize-handle.top { top: -3px; left: 0; }
        .resize-handle.bottom { bottom: -3px; left: 0; }

        .resize-handle.left, .resize-handle.right {
            width: 6px; height: 100%; cursor: ew-resize;
            border-radius: 0;
            opacity: 0;
        }
        .resize-handle.left:hover, .resize-handle.right:hover { opacity: 0.6; transform: scaleX(1.5); }
        .resize-handle.left { left: -3px; top: 0; }
        .resize-handle.right { right: -3px; top: 0; }

        /* Corner handles */
        .resize-handle.top-left, .resize-handle.top-right,
        .resize-handle.bottom-left, .resize-handle.bottom-right {
            width: 14px; height: 14px;
            border-radius: 50%;
            border: 2px solid #0f0f1a;
            box-shadow: 0 0 0 1px rgba(129,140,248,0.3);
        }
        .resize-handle.top-left:hover, .resize-handle.top-right:hover,
        .resize-handle.bottom-left:hover, .resize-handle.bottom-right:hover {
            box-shadow: 0 0 12px rgba(129, 140, 248, 0.8), 0 0 0 1px rgba(129,140,248,0.5);
        }
        .resize-handle.top-left, .resize-handle.bottom-right { cursor: nwse-resize; }
        .resize-handle.top-right, .resize-handle.bottom-left { cursor: nesw-resize; }
        .resize-handle.top-left { top: -7px; left: -7px; }
        .resize-handle.top-right { top: -7px; right: -7px; }
        .resize-handle.bottom-left { bottom: -7px; left: -7px; }
        .resize-handle.bottom-right { bottom: -7px; right: -7px; }

        #canvas-container.drawing-disabled { cursor: default !important; }

        /* ═══ MIL-matched type scale (force over ComfyUI button CSS) ═══
           section/hint/label 10 · button 10–11 · title/apply 12
           !important required: ComfyDialog / global button rules win otherwise. */
        .bs-control-panel {
            box-sizing: border-box;
            overflow-x: hidden !important;
            overflow-y: auto;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif !important;
            font-size: 11px !important;
            line-height: 1.35;
            color: #aaa;
        }
        .bs-control-panel *,
        .bs-control-panel *::before,
        .bs-control-panel *::after {
            box-sizing: border-box;
        }
        .bs-control-panel img {
            max-width: 100%;
        }
        .bs-control-panel button {
            font-family: inherit !important;
            font-size: 10px !important;
            font-weight: 400 !important;
            line-height: 1.25 !important;
            letter-spacing: 0 !important;
            text-transform: none !important;
        }
        .bs-control-panel button.bs-action {
            font-size: 12px !important;
            font-weight: 600 !important;
        }
        .bs-control-panel button.bs-action-cancel {
            font-weight: 400 !important;
        }
        .bs-control-panel::-webkit-scrollbar { width: 3px; }
        .bs-control-panel::-webkit-scrollbar-track { background: transparent; }
        .bs-control-panel::-webkit-scrollbar-thumb { background: #333; border-radius: 3px; }
        .bs-control-panel::-webkit-scrollbar-thumb:hover { background: #555; }

        .bs-title {
            font-size: 12px !important;
            font-weight: 600 !important;
            line-height: 1.2 !important;
            color: #ddd !important;
            margin: 0 !important;
        }
        .bs-subtitle {
            font-size: 10px !important;
            font-weight: 400 !important;
            line-height: 1.3 !important;
            color: #555 !important;
            margin: 2px 0 0 0 !important;
        }
        .bs-ar-custom {
            display: none;
            align-items: center;
            gap: 4px;
            width: 100% !important;
            margin: 0 !important;
            min-width: 0;
            align-self: stretch;
            box-sizing: border-box !important;
        }
        .bs-ar-custom.is-open {
            display: flex !important;
        }
        .bs-ar-sep {
            color: #666;
            font-size: 10px !important;
            flex-shrink: 0;
        }
        .bs-ar-input {
            flex: 1 1 0;
            width: 0;
            min-width: 0;
            background: #1e1e1e !important;
            color: #ccc !important;
            border: 1px solid #333 !important;
            border-radius: 5px !important;
            padding: 4px 5px !important;
            font-size: 10px !important;
            font-family: inherit !important;
            font-weight: 400 !important;
            line-height: 1.25 !important;
            text-align: center;
            outline: none;
            -moz-appearance: textfield;
            box-sizing: border-box !important;
        }
        .bs-ar-input::-webkit-outer-spin-button,
        .bs-ar-input::-webkit-inner-spin-button {
            -webkit-appearance: none;
            margin: 0;
        }
        .bs-ar-input:focus {
            border-color: #4a6a8a !important;
        }
        .bs-sec {
            color: #444 !important;
            font-size: 10px !important;
            font-weight: 400 !important;
            letter-spacing: 1px !important;
            text-transform: uppercase !important;
            line-height: 1.2 !important;
            margin-top: 8px !important;
            margin-bottom: 3px !important;
        }
        .bs-label {
            font-size: 10px !important;
            font-weight: 400 !important;
            color: #888 !important;
            line-height: 1.2 !important;
        }
        .bs-ico {
            display: inline-block;
            width: 11px;
            height: 11px;
            flex-shrink: 0;
            vertical-align: -1px;
            margin-right: 4px;
        }
        .bs-ico svg {
            display: block;
            width: 100%;
            height: 100%;
            stroke: currentColor;
            stroke-width: 1.6;
            stroke-linecap: round;
            stroke-linejoin: round;
        }
        .bs-title-row {
            display: flex;
            align-items: flex-start;
            gap: 6px;
            min-width: 0;
            margin-bottom: 2px;
        }
        .bs-title-ico {
            width: 14px;
            height: 14px;
            margin-top: 1px;
            margin-right: 0;
            color: #888;
        }
        .bs-btn {
            display: inline-flex !important;
            align-items: center;
            justify-content: center;
            gap: 0;
            position: relative;
            background: #1e1e1e !important;
            color: #aaa !important;
            border: 1px solid #333 !important;
            border-radius: 5px !important;
            padding: 5px 6px !important;
            font-size: 10px !important;
            font-weight: 400 !important;
            line-height: 1.25 !important;
            cursor: pointer;
            min-width: 0;
            transition: background .12s, border-color .12s, color .12s;
        }
        .bs-vertex-tip {
            display: none;
            position: absolute;
            z-index: 80;
            transform: translate(-50%, calc(-100% - 10px));
            background: #1a1a1a;
            color: #ccc;
            border: 1px solid #3a5a7a;
            border-radius: 4px;
            padding: 3px 7px;
            font-size: 10px !important;
            font-weight: 500 !important;
            line-height: 1.2 !important;
            white-space: nowrap;
            pointer-events: none;
            box-shadow: 0 4px 12px rgba(0,0,0,0.45);
        }
        .bs-vertex-tip.is-open {
            display: block;
        }
        .bs-vertex-tip::after {
            content: "";
            position: absolute;
            top: 100%;
            left: 50%;
            transform: translateX(-50%);
            border: 5px solid transparent;
            border-top-color: #3a5a7a;
        }
        .bs-btn:hover {
            background: #2a2a2a !important;
            color: #ccc !important;
            border-color: #484848 !important;
        }
        .bs-btn.active {
            background: #1e3a1e !important;
            color: #7fff7f !important;
            border-color: #3a6a3a !important;
            font-weight: 400 !important;
        }
        .bs-btn.active-box {
            background: #1e2a3a !important;
            color: #7ab0ff !important;
            border-color: #3a5a7a !important;
            font-weight: 400 !important;
        }
        .bs-btn-danger {
            color: #e07070 !important;
            border-color: #5a3030 !important;
            background: #1e1414 !important;
        }
        .bs-btn-danger:hover {
            color: #ff9090 !important;
            border-color: #7a4040 !important;
            background: #2a1818 !important;
        }
        .bs-hint {
            color: #555 !important;
            font-size: 10px !important;
            font-weight: 400 !important;
            line-height: 1.3 !important;
        }
        .bs-hint .add { color: #7ab0ff; font-weight: 400; }
        .bs-hint .sub { color: #ff8080; font-weight: 400; }
        .bs-select {
            display: block !important;
            width: 100% !important;
            min-width: 0 !important;
            max-width: 100% !important;
            margin: 0 !important;
            padding: 4px 20px 4px 5px !important;
            border-radius: 5px !important;
            font-size: 10px !important;
            font-weight: 400 !important;
            font-family: inherit !important;
            line-height: 1.25 !important;
            cursor: pointer;
            outline: none;
            appearance: none !important;
            -webkit-appearance: none !important;
            -moz-appearance: none !important;
            background-color: #1e1e1e !important;
            color: #aaa !important;
            border: 1px solid #333 !important;
            color-scheme: dark;
            background-image: url('data:image/svg+xml;utf8,<svg xmlns=%22http://www.w3.org/2000/svg%22 width=%2210%22 height=%226%22><path d=%22M1 1l4 4 4-4%22 stroke=%22%23888%22 stroke-width=%221.5%22 fill=%22none%22/></svg>') !important;
            background-repeat: no-repeat !important;
            background-position: right 6px center !important;
            background-size: 10px 6px !important;
            box-sizing: border-box !important;
            align-self: stretch;
        }
        .bs-select option {
            background-color: #1e1e1e;
            color: #ccc;
        }
        .bs-val {
            font-size: 10px !important;
            font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace !important;
            font-weight: 400 !important;
            color: #ccc !important;
            background: #1e1e1e;
            border: 1px solid #333;
            border-radius: 3px;
            padding: 2px 0;
            width: 38px;
            text-align: center;
            line-height: 1.3;
            display: inline-block;
        }
        .bs-info {
            background: #1a1a1a;
            padding: 5px 6px;
            border-radius: 4px;
            font-family: ui-monospace, "Cascadia Mono", "Consolas", monospace !important;
            font-size: 10px !important;
            font-weight: 400 !important;
            line-height: 1.4 !important;
            color: #888 !important;
            border: 1px solid #222;
            overflow: hidden;
            word-break: break-word;
        }
        .bs-info-k {
            color: #7ab0ff !important;
            font-weight: 600 !important;
            font-family: inherit !important;
            font-size: 10px !important;
            letter-spacing: 0 !important;
            margin-bottom: 1px;
        }
        .bs-info-muted {
            color: #555 !important;
            font-family: inherit !important;
            font-size: 10px !important;
        }
        .bs-info-meta {
            font-size: 10px !important;
            font-weight: 400 !important;
            opacity: 0.55;
            font-family: inherit !important;
        }
        .bs-ratio {
            font-weight: 600 !important;
            font-size: 10px !important;
            font-family: inherit !important;
        }
        .bs-ratio-exact { color: #44cc88; }
        .bs-ratio-near { color: #fb923c; }
        .bs-ratio-custom { color: #818cf8; }
        .bs-action {
            flex: 1;
            padding: 7px 0 !important;
            border-radius: 6px !important;
            cursor: pointer;
            font-size: 12px !important;
            font-weight: 600 !important;
            line-height: 1.2 !important;
            min-width: 0;
            transition: background .12s, color .12s, border-color .12s;
        }
        .bs-action-ok {
            background: #1a3a28 !important;
            color: #44cc88 !important;
            border: 1px solid #336644 !important;
        }
        .bs-action-ok:hover {
            background: #225540 !important;
            border-color: #44cc88 !important;
        }
        .bs-action-cancel {
            background: #2a2a2a !important;
            color: #aaa !important;
            border: 1px solid #444 !important;
            font-weight: 400 !important;
        }
        .bs-action-cancel:hover {
            background: #333 !important;
            color: #ccc !important;
            border-color: #555 !important;
        }
        .bs-tool-grid {
            display: grid;
            grid-template-columns: 1fr 1fr;
            gap: 4px;
            width: 100%;
        }
        .bs-row {
            display: flex;
            gap: 4px;
            width: 100% !important;
            min-width: 0;
            margin: 0 !important;
            align-self: stretch;
            box-sizing: border-box !important;
        }
        .bs-row > .bs-btn,
        .bs-row > .bs-action { flex: 1; min-width: 0; }
        .bs-slider {
            width: 100%;
            height: 14px;
            accent-color: #40a0ff;
            cursor: pointer;
            margin: 0;
            padding: 0;
        }
        .bs-field-row {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 2px;
            gap: 6px;
        }
        .bs-discard-ov {
            position: absolute;
            inset: 0;
            z-index: 100;
            background: rgba(0, 0, 0, 0.55);
            display: none;
            align-items: center;
            justify-content: center;
            padding: 16px;
        }
        .bs-discard-ov.is-open {
            display: flex;
        }
        .bs-discard-card {
            width: min(320px, 100%);
            background: #181818;
            border: 1px solid #333;
            border-radius: 10px;
            box-shadow: 0 16px 48px rgba(0,0,0,0.65);
            padding: 16px;
            display: flex;
            flex-direction: column;
            gap: 12px;
        }
        .bs-discard-title {
            margin: 0;
            color: #ddd;
            font-size: 13px !important;
            font-weight: 600 !important;
            line-height: 1.3 !important;
        }
        .bs-discard-msg {
            margin: 0;
            color: #888;
            font-size: 11px !important;
            font-weight: 400 !important;
            line-height: 1.4 !important;
        }
        .bs-discard-actions {
            display: flex;
            gap: 8px;
        }
        .bs-discard-actions .bs-action {
            flex: 1;
        }

        /* ═══ Checkerboard bg ═══ */
        .bs-canvas-area {
            background-color: #0d1117;
            background-image:
                linear-gradient(45deg, #161b22 25%, transparent 25%),
                linear-gradient(-45deg, #161b22 25%, transparent 25%),
                linear-gradient(45deg, transparent 75%, #161b22 75%),
                linear-gradient(-45deg, transparent 75%, #161b22 75%);
            background-size: 20px 20px;
            background-position: 0 0, 0 10px, 10px -10px, -10px 0px;
        }
    `;
    document.head.appendChild(styleTag);

    // Build dialog HTML — MIL-inspired dark sidebar
    const innerHtml = `
        <div style="height: 100%; display: flex; overflow: hidden; background: #0a0a0a; position: relative;">
            <div class="bs-discard-ov" id="bs-discard-ov" role="dialog" aria-modal="true" aria-labelledby="bs-discard-title">
                <div class="bs-discard-card">
                    <h2 id="bs-discard-title" class="bs-discard-title">Close without saving?</h2>
                    <p class="bs-discard-msg">Your box and mask changes will be discarded.</p>
                    <div class="bs-discard-actions">
                        <button type="button" id="bs-discard-keep" class="bs-action bs-action-cancel">Keep editing</button>
                        <button type="button" id="bs-discard-quit" class="bs-action bs-action-ok" style="background:#5a2a2a !important;color:#ff9090 !important;border-color:#7a4040 !important;">Discard</button>
                    </div>
                </div>
            </div>
            <div class="bs-control-panel" style="
                width: 176px; min-width: 176px; max-width: 176px; background: #111;
                overflow-x: hidden; overflow-y: auto;
                padding: 12px 10px 8px; border-right: 1px solid #222;
                display: flex; flex-direction: column; gap: 5px;
            ">
                <div class="bs-title-row">
                    <span class="bs-ico bs-title-ico" aria-hidden="true">
                        <svg viewBox="0 0 16 16"><rect x="3" y="3" width="10" height="10" rx="0.5" fill="none"/><circle cx="3" cy="3" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="3" r="1.3" fill="currentColor" stroke="none"/><circle cx="3" cy="13" r="1.3" fill="currentColor" stroke="none"/><circle cx="13" cy="13" r="1.3" fill="currentColor" stroke="none"/></svg>
                    </span>
                    <div style="min-width: 0;">
                        <h1 class="bs-title">Box Selector</h1>
                        <p class="bs-subtitle">Region + mask editor</p>
                    </div>
                </div>

                <div class="bs-sec">Aspect Ratio</div>
                <select id="aspect-ratio-select" class="bs-select">
                    <option value="free">Free</option>
                    <option value="1:1" selected>1:1 Square</option>
                    <option value="4:5">4:5 Portrait</option>
                    <option value="3:4">3:4 Portrait</option>
                    <option value="9:16">9:16 Portrait</option>
                    <option value="9:21">9:21 Portrait</option>
                    <option value="5:4">5:4 Landscape</option>
                    <option value="4:3">4:3 Landscape</option>
                    <option value="3:2">3:2 Landscape</option>
                    <option value="16:9">16:9 Landscape</option>
                    <option value="21:9">21:9 Landscape</option>
                    <option value="custom">Custom</option>
                </select>
                <div id="aspect-ratio-custom" class="bs-ar-custom" style="display: none;">
                    <input id="aspect-custom-w" class="bs-ar-input" type="number" min="1" step="1" value="2" title="Width">
                    <span class="bs-ar-sep">:</span>
                    <input id="aspect-custom-h" class="bs-ar-input" type="number" min="1" step="1" value="6" title="Height">
                </div>
                <div id="aspect-ratio-hint" class="bs-hint">Constrained to 1:1</div>

                <div class="bs-sec">Mode</div>
                <div class="bs-row">
                    <button id="mode-box-btn" type="button" class="bs-btn active-box"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="0.5" fill="none"/><circle cx="3.5" cy="3.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="3.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="3.5" cy="12.5" r="1.2" fill="currentColor" stroke="none"/><circle cx="12.5" cy="12.5" r="1.2" fill="currentColor" stroke="none"/></svg></span>Box</button>
                    <button id="mode-paint-btn" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M2.5 13.5c1.2-2.6 2.2-3.4 4.2-3.4.7 0 1.3.2 1.8.6" fill="none"/><path d="M9.2 3.2l3.6 3.6-5.4 5.4H3.8V8.6L9.2 3.2z" fill="none"/><path d="M10.1 2.3l3.6 3.6" fill="none"/></svg></span>Mask</button>
                </div>
                <div class="bs-hint">B Box · M Mask · Esc close · Del clear</div>

                <div id="mask-controls" style="display: none; flex-direction: column; gap: 5px; min-width: 0;">
                    <div class="bs-sec">Mask Tools</div>
                    <div class="bs-tool-grid">
                        <button id="mask-tool-brush" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 13.5c1.4-2.8 2.6-3.6 4.6-3.6.8 0 1.5.3 2 .8" fill="none"/><path d="M9.4 2.8l3.8 3.8-5.7 5.7H3.7V8.5L9.4 2.8z" fill="none"/><path d="M10.4 1.9l3.7 3.7" fill="none"/></svg></span>Brush</button>
                        <button id="mask-tool-lasso" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4.5 5.2c.4-1.6 2-2.7 3.8-2.7 2.2 0 4 1.6 4 3.7 0 2.4-1.7 3.6-3.2 4.7-.8.6-1.6 1.2-1.6 2.1" fill="none"/><circle cx="7.5" cy="13.2" r="1.1" fill="currentColor" stroke="none"/></svg></span>Lasso</button>
                        <button id="mask-tool-polygon" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M8 2.5L13.2 6.2 11.4 12.5H4.6L2.8 6.2Z" fill="none"/><circle cx="8" cy="2.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="13.2" cy="6.2" r="1.1" fill="currentColor" stroke="none"/><circle cx="11.4" cy="12.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="4.6" cy="12.5" r="1.1" fill="currentColor" stroke="none"/><circle cx="2.8" cy="6.2" r="1.1" fill="currentColor" stroke="none"/></svg></span>Poly</button>
                        <button id="mask-tool-rect" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="3" y="4" width="10" height="8" rx="0.5" fill="none"/></svg></span>Rect</button>
                    </div>

                    <div id="mask-tool-hint" class="bs-hint">
                        <span class="add">Shift</span> add · <span class="sub">Alt</span> sub<br>
                        LMB paint · RMB erase · Ctrl+Wheel
                    </div>

                    <div id="brush-opts">
                        <div class="bs-sec">Brush</div>
                        <div class="bs-field-row">
                            <span class="bs-label">Size</span>
                            <span id="brush-size-val" class="bs-val">30px</span>
                        </div>
                        <input type="range" id="brush-size-slider" class="bs-slider" min="1" max="100" value="30">
                        <div class="bs-row" style="margin-top: 4px;">
                            <button id="brush-shape-circle-btn" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="4.5" fill="none"/></svg></span>Circle</button>
                            <button id="brush-shape-square-btn" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><rect x="3.5" y="3.5" width="9" height="9" rx="0.5" fill="none"/></svg></span>Square</button>
                        </div>
                    </div>

                    <div class="bs-sec">Appearance</div>
                    <div class="bs-field-row">
                        <span class="bs-label">Overlay</span>
                        <span id="mask-opacity-val" class="bs-val">50%</span>
                    </div>
                    <input type="range" id="mask-opacity-slider" class="bs-slider" min="10" max="100" value="50">
                    <div class="bs-field-row" style="margin-top: 4px;">
                        <span class="bs-label">Color</span>
                        <input type="color" id="mask-color-picker" value="#22cc44" style="border: none; width: 22px; height: 16px; cursor: pointer; background: transparent; padding: 0;">
                    </div>

                    <div class="bs-sec">Mask Action</div>
                    <div class="bs-row">
                        <button id="mask-invert-btn" type="button" class="bs-btn"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3 8a5 5 0 015-5h2.5" fill="none"/><path d="M8.5 1.5L11 3.5 8.5 5.5" fill="none"/><path d="M13 8a5 5 0 01-5 5H5.5" fill="none"/><path d="M7.5 14.5L5 12.5 7.5 10.5" fill="none"/></svg></span>Invert</button>
                        <button id="mask-clear-btn" type="button" class="bs-btn bs-btn-danger"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M3.5 4.5h9" fill="none"/><path d="M6 4.5V3.2h4v1.3" fill="none"/><path d="M5 4.5l.6 8.2h4.8L11 4.5" fill="none"/><path d="M7 7v4M9 7v4" fill="none"/></svg></span>Clear</button>
                    </div>
                </div>

                <div style="flex: 1; min-height: 8px;"></div>

                <div style="display: flex; flex-direction: column; gap: 5px; flex-shrink: 0;">
                    <div class="bs-row">
                        <button id="bs-undo-btn" type="button" class="bs-btn" disabled style="opacity: 0.5;"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M4.5 6.5H11a3 3 0 010 6H8.5" fill="none"/><path d="M7 4L4.5 6.5 7 9" fill="none"/></svg></span>Undo</button>
                        <button id="bs-redo-btn" type="button" class="bs-btn" disabled style="opacity: 0.5;"><span class="bs-ico" aria-hidden="true"><svg viewBox="0 0 16 16"><path d="M11.5 6.5H5a3 3 0 000 6h2.5" fill="none"/><path d="M9 4l2.5 2.5L9 9" fill="none"/></svg></span>Redo</button>
                    </div>

                    <div class="bs-sec" style="margin-top: 2px !important;">Selection Info</div>
                    <div id="coordinates-info" style="min-width: 0;">
                        <div id="base-coordinates" class="bs-info">
                            <span class="bs-info-muted">Click and drag to select</span>
                        </div>
                        <div id="current-dimensions" style="display: none;"></div>
                    </div>
                    <div id="dimensions-info" style="display: none; margin-top: 2px;"></div>
                </div>

                <div class="bs-row" style="padding-top: 6px; border-top: 1px solid #222; flex-shrink: 0;">
                    <button id="bs-confirm-btn" class="bs-action bs-action-ok">Confirm</button>
                    <button id="bs-cancel-btn" class="bs-action bs-action-cancel">Cancel</button>
                </div>
            </div>

            <div class="bs-canvas-area" style="
                flex: 1; display: flex; align-items: center; justify-content: center;
                overflow: hidden; position: relative;
            ">
                <div id="canvas-container" style="
                    position: relative; display: inline-flex; align-items: center; justify-content: center;
                    background: #1a1a2e;
                    border-radius: 6px;
                    box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4), 0 0 0 1px rgba(255,255,255,0.04);
                    overflow: hidden;
                    max-width: 95%;
                    max-height: 95%;
                ">
                    <img src="${imageUrl}" alt="Region Selector" id="background-image" 
                        onerror="console.error('[RegionSelector] Failed to load image:', this.src); this.alt = 'Failed to load image';"
                        style="
                        display: block;
                        max-width: 100%;
                        max-height: 100%;
                        user-select: none;
                    ">
                </div>
            </div>
        </div>
    `;

    container.innerHTML = innerHtml;

    // Wire up sidebar buttons
    const confirmBtn = container.querySelector('#bs-confirm-btn');
    const cancelBtn = container.querySelector('#bs-cancel-btn');
    const discardOv = container.querySelector('#bs-discard-ov');
    const discardKeepBtn = container.querySelector('#bs-discard-keep');
    const discardQuitBtn = container.querySelector('#bs-discard-quit');
    let discardOpen = false;
    let selectorApi = null;

    function openDiscardConfirm() {
        if (!discardOv) return;
        discardOpen = true;
        discardOv.classList.add('is-open');
        discardKeepBtn?.focus();
    }

    function closeDiscardConfirm() {
        if (!discardOv) return;
        discardOpen = false;
        discardOv.classList.remove('is-open');
    }

    function requestCancelWithoutSaving() {
        if (discardOpen) {
            closeDiscardConfirm();
            return;
        }
        openDiscardConfirm();
    }

    function confirmDiscardAndClose() {
        console.log("[RegionSelectorExt] Dialog cancelled (discard confirmed)");
        closeDiscardConfirm();
        dialog.close();
    }

    cancelBtn.onclick = () => requestCancelWithoutSaving();
    discardKeepBtn.onclick = () => closeDiscardConfirm();
    discardQuitBtn.onclick = () => confirmDiscardAndClose();
    discardOv?.addEventListener('click', (e) => {
        if (e.target === discardOv) closeDiscardConfirm();
    });

    // Mode toggle — never use DOM-only fallback (that left mode='box' while UI said Mask)
    let pendingMode = null;

    function callModeApi(which) {
        const api = container._boxBoxApi || selectorApi;
        if (which === 'mask') {
            if (api && typeof api.setModeMask === 'function') {
                pendingMode = null;
                api.setModeMask();
                return;
            }
            pendingMode = 'mask';
            console.warn('[BoxBox] setModeMask not ready yet — queued');
            return;
        }
        if (api && typeof api.setModeBox === 'function') {
            pendingMode = null;
            api.setModeBox();
            return;
        }
        pendingMode = 'box';
        console.warn('[BoxBox] setModeBox not ready yet — queued');
    }

    function runDeleteAction() {
        const api = container._boxBoxApi || selectorApi;
        if (!api) return;
        if (api.getMode?.() === 'paint') {
            if (typeof api.clearMask === 'function') api.clearMask();
            return;
        }
        if (typeof api.resetRectangle === 'function') api.resetRectangle();
    }

    // Wire Mode buttons as soon as DOM exists (replaced again after CanvasSelector init
    // with the real setModeMask/setModeBox via button.onclick inside initializeCanvasSelector).
    function wireModeButtonsEarly() {
        const paint = container.querySelector('#mode-paint-btn');
        const box = container.querySelector('#mode-box-btn');
        if (paint) {
            paint.style.pointerEvents = 'auto';
            paint.style.cursor = 'pointer';
            paint.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[BoxBox] Mask button clicked (dialog wire)');
                callModeApi('mask');
            };
        }
        if (box) {
            box.style.pointerEvents = 'auto';
            box.style.cursor = 'pointer';
            box.onclick = (e) => {
                e.preventDefault();
                e.stopPropagation();
                console.log('[BoxBox] Box button clicked (dialog wire)');
                callModeApi('box');
            };
        }
    }
    wireModeButtonsEarly();

    // Dialog-level Esc only (M/B/Delete handled by boxBoxStealComfyHotkeys)
    const onDialogKeyDown = (e) => {
        if (e.key !== 'Escape') return;
        const path0 = (typeof e.composedPath === 'function' ? e.composedPath()[0] : null) || e.target;
        if (isEditableTextTarget(path0) || isEditableTextTarget(document.activeElement)) return;

        e.preventDefault();
        e.stopPropagation();
        e.stopImmediatePropagation();

        const api = container._boxBoxApi || selectorApi;
        if (api?.hasShapeInProgress?.()) {
            api.cancelLassoInProgress?.();
            return;
        }
        requestCancelWithoutSaving();
    };
    window.addEventListener('keydown', onDialogKeyDown, true);

    // Arm Comfy hotkey steal for M/B/Delete while this dialog is open
    boxBoxHotkeys.onMask = () => callModeApi('mask');
    boxBoxHotkeys.onBox = () => callModeApi('box');
    boxBoxHotkeys.onDelete = () => runDeleteAction();
    boxBoxHotkeys.active = true;

    // Show dialog without ComfyDialog.show(node) — that API either throws on
    // undefined or reparents into .comfy-modal-content and breaks our layout.
    if (!container.parentElement) {
        dialog.element.appendChild(container);
    }
    dialog.element.style.display = 'flex';
    dialog.element.setAttribute('tabindex', '-1');
    try { dialog.element.focus({ preventScroll: true }); } catch (_) { /* ignore */ }

    // Hide default ComfyDialog content column / leftover chrome buttons
    const dialogContent = dialog.element.querySelector('.comfy-modal-content');
    if (dialogContent) {
        dialogContent.style.display = 'none';
    }
    dialog.element.querySelectorAll('button').forEach(btn => {
        if (!container.contains(btn)) btn.style.display = 'none';
    });

    const disarmBoxBoxHotkeys = () => {
        boxBoxHotkeys.active = false;
        boxBoxHotkeys.onMask = null;
        boxBoxHotkeys.onBox = null;
        boxBoxHotkeys.onDelete = null;
        window.removeEventListener('keydown', onDialogKeyDown, true);
    };

    // Always wrap close (even if CanvasSelector init fails)
    const originalClose = dialog.close.bind(dialog);
    dialog.close = function() {
        disarmBoxBoxHotkeys();
        if (selectorApi && selectorApi.cleanup) {
            selectorApi.cleanup();
        }
        selectorApi = null;
        originalClose();
    };

    // Initialize selector after DOM is rendered
    setTimeout(() => {
        let attempts = 0;
        const waitForCanvasSelector = setInterval(() => {
            attempts++;
            if (window.CanvasSelector) {
                clearInterval(waitForCanvasSelector);
                const metadataWidget = node.widgets?.find((w) => w.name === "box_metadata");
                const previousMetadata = metadataWidget?.value || null;

                try {
                    selectorApi = window.CanvasSelector.initializeCanvasSelector(container, imageUrl, previousMetadata, {
                        onCancelRequest: requestCancelWithoutSaving,
                        getSnap: () => node.widgets?.find((w) => w.name === "snap_to")?.value ?? 1,
                    });
                    console.log("[RegionSelectorExt] CanvasSelector initialized successfully");
                    if (pendingMode) {
                        const queued = pendingMode;
                        pendingMode = null;
                        callModeApi(queued);
                    }
                } catch (err) {
                    console.error("[RegionSelectorExt] CanvasSelector init failed:", err);
                    selectorApi = null;
                }

                confirmBtn.onclick = () => {
                    if (!selectorApi || !selectorApi.getCoordinates) {
                        dialog.close();
                        return;
                    }
                    const coords = selectorApi.getCoordinates();
                    let metadataWidget = node.widgets?.find((w) => w.name === "box_metadata");

                    if (metadataWidget) {
                        const metadata = JSON.stringify({
                            ...coords,
                            selected: true
                        });
                        metadataWidget.value = metadata;
                        if (metadataWidget.callback) {
                            metadataWidget.callback(metadata);
                        }
                        console.log("[RegionSelectorExt] Metadata widget updated with:", metadata);
                    } else {
                        console.warn("[RegionSelectorExt] box_metadata widget not found. Available widgets:", node.widgets?.map(w => w.name) || []);
                    }

                    console.log("[RegionSelectorExt] Coordinates saved:", coords);
                    dialog.close();
                };
            } else if (attempts > 50) {
                clearInterval(waitForCanvasSelector);
                console.error("[RegionSelectorExt] CanvasSelector failed to load after 5 seconds");
                alert("Error: Box Selector failed to load. Check browser console for details.");
            }
        }, 100);
    }, 200);
}

/**
 * Executes the source node to get the image
 */
async function executeSourceNode(sourceNode, app) {
    try {
        // If source node is LoadImage, the "image" widget contains the filename
        const imageWidget = sourceNode.widgets?.find(w => w.name === "image");
        if (imageWidget && imageWidget.value) {
            console.log("[RegionSelectorExt] Found image in source node:", imageWidget.value);
            return imageWidget.value;
        }
    } catch (e) {
        console.error("[RegionSelectorExt] Error in executeSourceNode:", e);
    }
}

console.log("[RegionSelectorExt] Extension loaded!");
