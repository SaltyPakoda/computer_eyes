import { DotLottie } from './vendor/dotlottie-web.js';

// DOM Elements
const canvas = document.getElementById('lottie-canvas');
const loadingOverlay = document.getElementById('loading');
const currentStateDisplay = document.getElementById('current-state');
const stateRadios = document.querySelectorAll('input[name="state"]');
const stage = document.querySelector('.stage');
const lottieContainer = document.querySelector('.lottie-container');
const layout = document.querySelector('.layout');
const leftCol = document.querySelector('.left');
const topEl = document.querySelector('.top');
const footer = document.querySelector('.footer');
const debugEl = document.getElementById('debug');
const bgModeRadios = document.querySelectorAll('input[name="bg-mode"]');
const bgColorInput = document.getElementById('bg-color');
const bgColorPill = document.querySelector('.bg-color-pill');

let dotLottie = null;
let pendingState = null;
let bgMode = 'solid';
let bgColor = '#eee5ff';
let uiHighlightLock = null; // { state: 'Base' | 'Boot' | 'Peek' | 'Think' | 'Reply' | 'Wink' | 'Error', expiresAt: number, reachedAt: number | null, mode: 'stable' | 'leave' | 'reach' }
let lastObservedUiState = 'Base';
let pendingAfterTransientState = null; // string state value to re-apply after Boot/Wink returns to Base
let scheduledStateRetry = null; // timeout id
let scheduledStateRetryFor = null; // string
let lastRequestedState = null;
let lastWasmRecoveryAt = 0;

function getMachineStateName(machineState) {
    if (typeof machineState === 'string') return machineState;
    if (machineState && typeof machineState === 'object') {
        // Common event payload shapes across runtimes:
        // { name: 'Load_Loop_Out' }, { id: 'Think_Loop' }, etc.
        if (typeof machineState.name === 'string') return machineState.name;
        if (typeof machineState.id === 'string') return machineState.id;
        if (typeof machineState.state === 'string') return machineState.state;
    }
    return String(machineState || '');
}

function normalizeUiStateFromMachineState(machineState) {
    const s = getMachineStateName(machineState);
    const u = s.toLowerCase();

    // Map common prefixes/variants to the UI's states.
    // Examples:
    // - Peek, Peek_Loop_In, Peek_Loop, Peek_Loop_Out → Peek
    // - Think_*, Reply_* → Think / Reply
    // - Loading_Loop_* / Load_* (machine internal) → Think
    // - Eyes_Base, Base_* → Base
    if (u.includes('boot')) return 'Boot';
    if (u.includes('peek')) return 'Peek';
    // In this file, "Loading_Loop" / "Load_*" internal states are part of the Think flow.
    if (u.includes('loading')) return 'Think';
    if (u.includes('load_loop') || u.includes('loadloop') || u.includes('load')) return 'Think';
    if (u.includes('think')) return 'Think';
    if (u.includes('reply')) return 'Reply';
    if (u.includes('wink')) return 'Wink';
    if (u.includes('error')) return 'Error';

    // Default bucket (covers Base, Eyes_Base, idle, etc.)
    return 'Base';
}

function syncStateUI(state) {
    if (!state) return;

    // Keep the radio highlight stable by mapping multiple internal states to one UI state.
    const uiState = normalizeUiStateFromMachineState(state);
    lastObservedUiState = uiState;

    // Keep highlight pinned to the user-selected UI state while the state machine
    // runs transient states (ex: previousState_Loop_Out) during transitions.
    const now = Date.now();
    if (uiHighlightLock && now > uiHighlightLock.expiresAt) {
        uiHighlightLock = null;
    }

    // When the user selects a new state, keep the highlight pinned to that requested
    // UI bucket while the machine runs transient states (ex: previousState_Loop_Out).
    //
    // Mode:
    // - stable: unlock only after the machine has stayed in the requested bucket for
    //   STABLE_MS continuously (prevents "bounce back" highlighting the old state).
    // - leave: once the requested bucket is reached, unlock as soon as we *leave* it
    //   (useful for transient states like Boot/Wink that auto-return to Base).
    // - reach: unlock immediately once the requested bucket is reached at least once.
    const STABLE_MS = 650;
    if (uiHighlightLock) {
        if (uiState === uiHighlightLock.state) {
            if (uiHighlightLock.reachedAt == null) uiHighlightLock.reachedAt = now;
            if (uiHighlightLock.mode === 'reach') {
                uiHighlightLock = null;
            } else if (uiHighlightLock.mode === 'stable' && now - uiHighlightLock.reachedAt >= STABLE_MS) {
                uiHighlightLock = null;
            }
        } else {
            // If we haven't reached the requested bucket yet, keep waiting.
            // If we *did* reach it but left before the stable window, keep the lock
            // so old-state loop_out transitions can't steal highlight.
            if (uiHighlightLock.mode === 'stable') {
                uiHighlightLock.reachedAt = null;
            }

            // For transient states, once we've reached the requested bucket, unlock
            // immediately upon leaving it so the UI can reflect the next real state.
            if (uiHighlightLock && uiHighlightLock.mode === 'leave' && uiHighlightLock.reachedAt != null) {
                uiHighlightLock = null;
            }
        }
    }

    // Update radio highlight without re-triggering state changes.
    // While locked, always highlight the requested UI state (not the transient machine state).
    const targetUiState = uiHighlightLock ? uiHighlightLock.state : uiState;
    for (const radio of stateRadios) {
        radio.checked = radio.value === targetUiState;
    }

    // Update the visible "Current" label
    // Show the actual internal state name for debugging/clarity.
    if (currentStateDisplay) currentStateDisplay.textContent = getMachineStateName(state);

    // If the user clicked a different state while a transient state (Boot/Wink) was running,
    // the machine may force the "State" input back to Base at the end of the animation.
    // Re-apply the user's selection once we observe the machine back in the Base bucket.
    if (pendingAfterTransientState && uiState === 'Base') {
        const next = pendingAfterTransientState;
        pendingAfterTransientState = null;
        setStateMachineInput(next);
    }
}

function applyBackground(mode, color) {
    bgMode = mode;
    bgColor = color;

    if (stage) {
        stage.dataset.bg = mode;
        if (mode === 'solid') stage.style.setProperty('--solid-bg', color);
        else stage.style.removeProperty('--solid-bg');
    }

    if (bgColorInput) {
        bgColorInput.disabled = mode !== 'solid';
        if (bgColorInput.value !== color) bgColorInput.value = color;
    }

    if (bgColorPill) {
        bgColorPill.style.setProperty('--bgpill', mode === 'solid' ? color : 'rgba(111, 71, 255, 0.10)');
        bgColorPill.classList.toggle('is-disabled', mode !== 'solid');
    }

    try {
        localStorage.setItem('lottieViewer.bgMode', mode);
        localStorage.setItem('lottieViewer.bgColor', color);
    } catch {
        // ignore
    }

    // If the renderer supports it, also set the player background color (helps when animation uses transparency).
    try {
        if (dotLottie && typeof dotLottie.setBackgroundColor === 'function') {
            dotLottie.setBackgroundColor(mode === 'solid' ? color : '#00000000');
        }
    } catch {
        // ignore
    }
}

function showDebug(message) {
    if (!debugEl) return;
    debugEl.hidden = false;
    debugEl.textContent = message;
}

function clearDebug() {
    if (!debugEl) return;
    debugEl.hidden = true;
    debugEl.textContent = '';
}

function formatUnknownError(err) {
    try {
        // dotlottie-web often emits an event object like { type: 'loadError', error: Error(...) }
        const underlying = err && typeof err === 'object' && 'error' in err ? err.error : err;

        if (underlying instanceof Error) {
            return underlying.stack || underlying.message || String(underlying);
        }

        if (typeof underlying === 'string') return underlying;

        if (underlying && typeof underlying === 'object') {
            try {
                return JSON.stringify(underlying, null, 2);
            } catch {
                // fallback for circular structures
                return Object.prototype.toString.call(underlying);
            }
        }

        return String(underlying);
    } catch (e) {
        return `Unknown error (failed to format): ${String(e)}`;
    }
}

function looksLikeZipDotLottie(arrayBuffer) {
    try {
        const u8 = new Uint8Array(arrayBuffer, 0, 4);
        // ZIP local file header: PK\x03\x04
        return u8[0] === 0x50 && u8[1] === 0x4b && u8[2] === 0x03 && u8[3] === 0x04;
    } catch {
        return false;
    }
}

function resizeCanvasToDisplaySize() {
    const dpr = Math.max(1, window.devicePixelRatio || 1);
    const rect = canvas.getBoundingClientRect();
    const width = Math.max(1, Math.round(rect.width * dpr));
    const height = Math.max(1, Math.round(rect.height * dpr));
    if (canvas.width !== width || canvas.height !== height) {
        canvas.width = width;
        canvas.height = height;
    }
}

function recomputeStageSize() {
    if (!layout || !leftCol || !stage) return;

    const leftRect = leftCol.getBoundingClientRect();
    const stageMaxByLeftHeight = leftRect.height;

    // Available height is the `.top` region (already excludes footer)
    const availableH = Math.max(240, (topEl ? topEl.getBoundingClientRect().height : window.innerHeight));

    // Available width for stage in the layout
    const layoutRect = layout.getBoundingClientRect();
    const availableW = Math.max(240, layoutRect.width - leftRect.width - 80); // 80 ~= gap + slack

    const next = Math.floor(Math.max(240, Math.min(stageMaxByLeftHeight, availableH, availableW)));
    layout.style.setProperty('--stage-size', `${next}px`);
}

// Initialize DotLottie
async function initLottie({ src, data, fileName } = {}) {
    clearDebug();

    // Ask the runtime (if supported) to load WASM from our local copy.
    // Some builds request `DotLottiePlayer.wasm` by name, so we ship that file too.
    try {
        if (typeof DotLottie.setWasmUrl === 'function') {
            DotLottie.setWasmUrl(new URL('./vendor/DotLottiePlayer.wasm', import.meta.url).toString());
        }
    } catch {
        // ignore
    }

    // Clean up existing instance
    if (dotLottie) {
        dotLottie.destroy();
    }

    resizeCanvasToDisplaySize();
    showLoading(true);

    try {
        dotLottie = new DotLottie({
            canvas: canvas,
            ...(src ? { src } : {}),
            ...(data ? { data } : {}),
            autoplay: true,
            loop: true,
            ...(bgMode === 'solid' ? { backgroundColor: bgColor } : {}),
            // Some versions support passing a wasm url via config; harmless if ignored.
            wasmUrl: 'vendor/DotLottiePlayer.wasm',
        });

        dotLottie.addEventListener('ready', () => {
            // `ready` means the WASM engine is initialized (not that the animation is loaded).
            console.log('DotLottie engine ready');
        });

        dotLottie.addEventListener('load', () => {
            showLoading(false);
            console.log('Animation loaded successfully');

            // Apply background again after load (some versions reset internal background state)
            applyBackground(bgMode, bgColor);

            // Try to load + start the first state machine from the manifest (if present).
            try {
                const manifest = dotLottie.manifest;
                const candidateId = manifest?.stateMachines?.[0]?.id;
                if (candidateId && typeof dotLottie.stateMachineLoad === 'function') {
                    dotLottie.stateMachineLoad(candidateId);
                }
                if (typeof dotLottie.stateMachineStart === 'function') {
                    dotLottie.stateMachineStart();
                }
            } catch (e) {
                console.warn('State machine auto-start failed:', e);
            }

            // Apply any state selection made before load finished.
            const desired =
                pendingState ||
                document.querySelector('input[name="state"]:checked')?.value ||
                null;
            pendingState = null;
            if (desired) {
                setStateMachineInput(desired);
            }
        });

        // Keep the UI selection in sync with actual state machine state.
        // This is critical for Wink-like states that auto-transition back to Base.
        dotLottie.addEventListener('stateMachineStateEntered', (evt) => {
            if (evt?.state) {
                syncStateUI(evt.state);
            }
        });
        dotLottie.addEventListener('stateMachineTransition', (evt) => {
            if (evt?.toState) {
                syncStateUI(evt.toState);
            }
        });
        dotLottie.addEventListener('stateMachineStringInputValueChange', (evt) => {
            // If the machine updates the "State" input internally, reflect it too.
            if (evt?.inputName === 'State' && typeof evt?.newValue === 'string') {
                syncStateUI(evt.newValue);
            }
        });

        dotLottie.addEventListener('loadError', (evt) => {
            console.error('Error loading Lottie:', evt);
            const hint = fileName ? `\n\nFile: ${fileName}` : '';
            showDebug(`Load error:\n${formatUnknownError(evt)}${hint}`);
            showLoading(false);
        });

        dotLottie.addEventListener('stateMachineError', (evt) => {
            console.error('State machine error:', evt);
            showDebug(`State machine error:\n${formatUnknownError(evt)}`);
        });

    } catch (error) {
        console.error('Failed to initialize Lottie:', error);
        showDebug(`Init error:\n${formatUnknownError(error)}`);
        showLoading(false);
    }
}

// Set state machine input
function setStateMachineInput(state, options = {}) {
    if (!dotLottie) return;

    try {
        const { retryAttempt = 0, isRetry = false } = options;

        // If the user made a new selection, cancel any pending retries for older values.
        if (!isRetry && scheduledStateRetry) {
            clearTimeout(scheduledStateRetry);
            scheduledStateRetry = null;
            scheduledStateRetryFor = null;
        }

        // Track the last desired state so we can recover gracefully if the WASM engine crashes.
        if (!isRetry) lastRequestedState = state;

        const requestedUiState = normalizeUiStateFromMachineState(state);
        // Pin the UI highlight to the *requested* state until we actually reach it (or timeout).
        // This prevents flicker when the machine briefly enters previousState_*_Loop_Out states.
        const lockMode = (requestedUiState === 'Wink' || requestedUiState === 'Boot') ? 'leave' : 'stable';
        // Transitions can be long (especially Think which uses internal `load_*` states),
        // so keep the lock alive long enough that previous-state `*_Loop_Out` doesn't
        // steal the highlight mid-transition.
        uiHighlightLock = { state: requestedUiState, expiresAt: Date.now() + 8000, reachedAt: null, mode: lockMode };

        // dotlottie-web@0.58.x uses `stateMachineSet*Input` APIs.
        // Your input name is "State" (case-sensitive).
        if (typeof dotLottie.isLoaded === 'boolean' && !dotLottie.isLoaded) {
            pendingState = state;
            throw new Error('Animation not loaded yet. Applying as soon as it finishes loading…');
        }

        if (typeof dotLottie.stateMachineSetStringInput === 'function') {
            // Ensure a state machine is running if the file contains one.
            // If a stateMachineId exists in the manifest, prefer it; otherwise start the default.
            if (typeof dotLottie.stateMachineGetActiveId === 'function' && typeof dotLottie.stateMachineStart === 'function') {
                const isRunning = typeof dotLottie.isStateMachineRunning === 'boolean' ? dotLottie.isStateMachineRunning : false;
                if (!isRunning) {
                    const manifest = dotLottie.manifest;
                    const candidateId = manifest?.stateMachines?.[0]?.id;
                    if (candidateId && typeof dotLottie.stateMachineLoad === 'function') {
                        dotLottie.stateMachineLoad(candidateId);
                    }
                    dotLottie.stateMachineStart();
                }
            }

            const ok = dotLottie.stateMachineSetStringInput('State', state);
            if (ok === false) {
                // Some files/runtime versions temporarily reject inputs during transitions.
                // Instead of failing immediately, retry a few times with backoff.
                const MAX_RETRIES = 8;
                if (retryAttempt < MAX_RETRIES) {
                    const delay = Math.min(900, Math.round(90 * Math.pow(1.55, retryAttempt)));
                    scheduledStateRetryFor = state;
                    scheduledStateRetry = setTimeout(() => {
                        // Only retry if we haven't been superseded by another selection.
                        if (scheduledStateRetryFor === state) {
                            setStateMachineInput(state, { retryAttempt: retryAttempt + 1, isRetry: true });
                        }
                    }, delay);
                    return;
                }

                // Provide a more useful error showing available inputs if possible.
                if (typeof dotLottie.stateMachineGetInputs === 'function') {
                    const inputs = dotLottie.stateMachineGetInputs();
                    const activeId = typeof dotLottie.stateMachineGetActiveId === 'function' ? dotLottie.stateMachineGetActiveId() : '(unknown)';
                    const status = typeof dotLottie.stateMachineGetStatus === 'function' ? dotLottie.stateMachineGetStatus() : '(unknown)';
                    const running = typeof dotLottie.isStateMachineRunning === 'boolean' ? String(dotLottie.isStateMachineRunning) : '(unknown)';
                    throw new Error(
                        `State machine rejected input.\n` +
                        `Active stateMachineId: ${activeId}\n` +
                        `Running: ${running}\n` +
                        `Status: ${status}\n` +
                        `Available inputs: ${JSON.stringify(inputs)}`
                    );
                }
                throw new Error('State machine rejected input (returned false).');
            }
        } else if (typeof dotLottie.stateMachineSetNumericInput === 'function' || typeof dotLottie.stateMachineSetBooleanInput === 'function') {
            throw new Error('State machine API present, but no string-input setter found. Is your "State" input actually numeric/boolean?');
        } else {
            // Legacy fallback attempts (older dotlottie-web versions)
            if (typeof dotLottie.setStateMachineStringInput === 'function') {
                dotLottie.setStateMachineStringInput('State', state);
            } else if (typeof dotLottie.setStateMachineInput === 'function') {
                dotLottie.setStateMachineInput('State', state);
            } else if (typeof dotLottie.setStateMachineInputValue === 'function') {
                dotLottie.setStateMachineInputValue('State', state);
            } else {
                // Dump prototype keys to help debug quickly
                const protoKeys = Object.getOwnPropertyNames(Object.getPrototypeOf(dotLottie)).sort();
                throw new Error(`No known state-machine input setter found. DotLottie methods: ${protoKeys.join(', ')}`);
            }
        }
        syncStateUI(state);
        console.log(`State changed to: ${state}`);
    } catch (error) {
        console.error('Error setting state:', error);
        // dotlottie-web is WASM-backed; occasionally it can crash with a memory OOB error.
        // When that happens, the instance may be corrupted. Stop retries and reload once.
        const msg = String(error?.message || error || '');
        if (/memory access out of bounds/i.test(msg)) {
            if (scheduledStateRetry) {
                clearTimeout(scheduledStateRetry);
                scheduledStateRetry = null;
                scheduledStateRetryFor = null;
            }
            pendingAfterTransientState = null;

            const now = Date.now();
            const COOLDOWN_MS = 10_000;
            if (now - lastWasmRecoveryAt >= COOLDOWN_MS) {
                lastWasmRecoveryAt = now;
                // Re-apply after reload using the existing "pendingState" mechanism.
                pendingState = lastRequestedState || null;
                showDebug(`Renderer crashed (WASM memory OOB). Reloading animation…`);
                try {
                    initLottie({ src: './CSM.lottie', fileName: 'CSM.lottie' });
                    return;
                } catch (e) {
                    console.error('Recovery reload failed:', e);
                }
            }
        }
        showDebug(`State set error: ${error?.message || error}`);
    }
}

// Show/hide loading overlay
function showLoading(show) {
    if (show) {
        loadingOverlay.classList.remove('hidden');
    } else {
        loadingOverlay.classList.add('hidden');
    }
}

// Handle state toggle changes
stateRadios.forEach(radio => {
    radio.addEventListener('change', (e) => {
        if (e.target.checked) {
            const requested = e.target.value;
            const requestedUi = normalizeUiStateFromMachineState(requested);

            // If Boot/Wink is in progress and the machine auto-returns to Base,
            // queue the user's selection so it gets applied after that return.
            if ((lastObservedUiState === 'Boot' || lastObservedUiState === 'Wink') && requestedUi !== lastObservedUiState) {
                pendingAfterTransientState = requested;
            } else {
                pendingAfterTransientState = null;
            }
            setStateMachineInput(requested);
        }
    });
});

// No file picker / drag-drop: this viewer is locked to CSM.lottie.
// Initial state: show loading overlay until the default animation loads.
showLoading(true);

// Keep the canvas resolution in sync with the layout (better reliability)
window.addEventListener('resize', () => {
    try {
        recomputeStageSize();
        resizeCanvasToDisplaySize();
        if (dotLottie && typeof dotLottie.resize === 'function') {
            dotLottie.resize();
        }
    } catch {
        // ignore
    }
});

// Catch unexpected errors and surface them in the UI
window.addEventListener('error', (e) => {
    showDebug(`Runtime error:\n${formatUnknownError(e)}`);
});
window.addEventListener('unhandledrejection', (e) => {
    showDebug(`Unhandled promise rejection:\n${formatUnknownError(e.reason)}`);
});

// Background controls + persistence
try {
    const storedMode = localStorage.getItem('lottieViewer.bgMode');
    const storedColor = localStorage.getItem('lottieViewer.bgColor');
    if (storedMode === 'checker' || storedMode === 'solid') bgMode = storedMode;
    if (typeof storedColor === 'string' && /^#[0-9a-fA-F]{6}$/.test(storedColor)) bgColor = storedColor;
} catch {
    // ignore
}

// Sync UI controls to stored values
bgModeRadios.forEach(r => {
    r.checked = r.value === bgMode;
    r.addEventListener('change', (e) => {
        if (e.target.checked) applyBackground(e.target.value, bgColor);
    });
});
if (bgColorInput) {
    bgColorInput.value = bgColor;
    bgColorInput.addEventListener('input', (e) => {
        applyBackground(bgMode, e.target.value);
    });
}
applyBackground(bgMode, bgColor);

// Auto-load the bundled file by default
initLottie({ src: './CSM.lottie', fileName: 'CSM.lottie' });

// Stage sizing: make the square match the left column height and keep everything centered.
recomputeStageSize();
if (typeof ResizeObserver !== 'undefined' && leftCol) {
    const ro = new ResizeObserver(() => recomputeStageSize());
    ro.observe(leftCol);
}

