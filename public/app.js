// 役職名→画像パスのマッピング
const ROLE_IMAGE_MAP = {
    '村人': '/images/villager.png',
    '人狼': '/images/werewolf.png',
    '占い師': '/images/fortune.png',
    '霊能者': '/images/medium.png',
    '狩人': '/images/hunter.png',
    '狂人': '/images/madman.png',
};

// 役職名→スラグ（CSSクラス用）
const ROLE_SLUG = {
    '村人': 'villager',
    '人狼': 'werewolf',
    '占い師': 'fortune',
    '霊能者': 'medium',
    '狩人': 'hunter',
    '狂人': 'madman',
};

// 中央演出用のDOM取得
const roleShowcase = document.getElementById('roleShowcase');

// DOM要素の取得
const startBtn = document.getElementById('startBtn');
const stopBtn = document.getElementById('stopBtn');
const skipBtn = document.getElementById('skipBtn');
const gameLog = document.getElementById('gameLog');
const playerList = document.getElementById('playerList');
const playerInfoSection = document.querySelector('.player-info-section');
const dayInfo = document.getElementById('dayInfo');
const phaseInfo = document.getElementById('phaseInfo');
const timerDisplay = document.getElementById('timerDisplay');
const returnToTitleBtn = document.getElementById('returnToTitleBtn');
const scrollToBottomBtn = document.getElementById('scrollToBottomBtn');
const scrollIndicator = document.getElementById('scrollIndicator');
const userTextInput = document.getElementById('userTextInput');
const userInputArea = document.getElementById('userInputArea');
const commandPanel = document.getElementById('commandPanel');
const playerControls = document.querySelector('.player-controls');
const leftColumn = document.querySelector('.left-column');
const timerSection = document.querySelector('.timer-section');

// While conversation/log output is actively updating, keep command panel inactive.
// We implement this as a debounced lock: each new message extends the lock window.
let commandPanelDesiredActive = false;
let commandPanelSpeechLock = false;
let commandPanelSpeechLockTimerId = null;

// First-time command panel hint (arrow)
const COMMAND_PANEL_HINT_STORAGE_KEY = 'ww_command_panel_hint_seen_v1';
let commandPanelHintEl = null;
let commandPanelHintHideTimerId = null;
let commandPanelHintHasShownThisSession = false;
let lastCommandPanelEffectiveActive = false;
let commandPanelHintShowRetryTimerId = null;
let commandPanelHintShowRetryCount = 0;

function hasSeenCommandPanelHint() {
    try {
        return window.localStorage && window.localStorage.getItem(COMMAND_PANEL_HINT_STORAGE_KEY) === '1';
    } catch (e) {
        return false;
    }
}

function markSeenCommandPanelHint() {
    try {
        if (window.localStorage) window.localStorage.setItem(COMMAND_PANEL_HINT_STORAGE_KEY, '1');
    } catch (e) {}
}

function ensureCommandPanelHintEl() {
    try {
        if (commandPanelHintEl) return commandPanelHintEl;
        const el = document.createElement('div');
        el.id = 'commandPanelHint';
        el.className = 'command-panel-hint';
        el.setAttribute('aria-hidden', 'true');
        el.style.display = 'none';
        el.innerHTML = `
          <div class="command-panel-hint-inner">
            <div class="command-panel-hint-text">ここから操作できます</div>
            <div class="command-panel-hint-arrow" aria-hidden="true">➜</div>
          </div>
        `;
        document.body.appendChild(el);
        commandPanelHintEl = el;
        return el;
    } catch (e) {
        return null;
    }
}

function positionCommandPanelHint() {
    try {
        if (!commandPanel || !commandPanelHintEl) return;
        const rect = commandPanel.getBoundingClientRect();
        // If not visible yet, skip positioning
        if (!rect || rect.width <= 2 || rect.height <= 2) return;

        // Show the bubble to the left of the command panel, pointing right.
        const hintRect = commandPanelHintEl.getBoundingClientRect();
        const hintW = hintRect.width || 280;
        const hintH = hintRect.height || 80;
        const gap = 14;
        let left = rect.left - hintW - gap;
        let top = rect.top + Math.min(64, Math.max(16, rect.height * 0.2));

        // Clamp within viewport
        const pad = 10;
        left = Math.max(pad, Math.min(left, window.innerWidth - hintW - pad));
        top = Math.max(pad, Math.min(top, window.innerHeight - hintH - pad));

        commandPanelHintEl.style.left = `${left}px`;
        commandPanelHintEl.style.top = `${top}px`;
    } catch (e) {}
}

function hideCommandPanelHint() {
    try {
        if (commandPanelHintHideTimerId) {
            clearTimeout(commandPanelHintHideTimerId);
            commandPanelHintHideTimerId = null;
        }
    } catch (e) {}
    try {
        if (!commandPanelHintEl) return;
        commandPanelHintEl.classList.remove('is-visible');
        commandPanelHintEl.style.display = 'none';
    } catch (e) {}
}

function showCommandPanelHintOnce() {
    try {
        if (commandPanelHintHasShownThisSession) return;
        if (hasSeenCommandPanelHint()) return;
        if (!commandPanel) return;
        // only when the panel is actually visible
        const rect = commandPanel.getBoundingClientRect();
        if (!rect || rect.width <= 2 || rect.height <= 2) return false;

        // Only show when command panel is truly interactive
        if (!commandPanelDesiredActive || commandPanelSpeechLock) return false;

        const el = ensureCommandPanelHintEl();
        if (!el) return false;
        commandPanelHintHasShownThisSession = true;
        markSeenCommandPanelHint();

        el.style.display = 'block';
        el.classList.add('is-visible');
        // Position after layout
        try { requestAnimationFrame(() => { try { positionCommandPanelHint(); } catch (e) {} }); } catch (e) {}

        // Auto-hide after a few seconds
        commandPanelHintHideTimerId = setTimeout(() => {
            try { hideCommandPanelHint(); } catch (e) {}
        }, 6500);

        // Hide as soon as the user interacts with the command panel
        try {
            const onInteract = () => { try { hideCommandPanelHint(); } catch (e) {} };
            commandPanel.addEventListener('pointerdown', onInteract, { once: true, capture: true });
            commandPanel.addEventListener('keydown', onInteract, { once: true, capture: true });
        } catch (e) {}

        // Keep the hint anchored if the window changes
        try {
            const onMove = () => { try { if (el.style.display !== 'none') positionCommandPanelHint(); } catch (e) {} };
            window.addEventListener('resize', onMove, { passive: true });
            window.addEventListener('scroll', onMove, { passive: true });
            // auto-clean listeners not critical; hint is one-time
        } catch (e) {}
        return true;
    } catch (e) {
        return false;
    }
}

function requestShowCommandPanelHint() {
    try {
        if (commandPanelHintHasShownThisSession) return;
        if (hasSeenCommandPanelHint()) return;
        if (!commandPanelDesiredActive || commandPanelSpeechLock) return;

        // retry a bit because commandPanel may become visible slightly later
        try {
            if (commandPanelHintShowRetryTimerId) {
                clearTimeout(commandPanelHintShowRetryTimerId);
                commandPanelHintShowRetryTimerId = null;
            }
        } catch (e) {}

        commandPanelHintShowRetryCount = 0;
        const tick = () => {
            commandPanelHintShowRetryCount++;
            const shown = showCommandPanelHintOnce();
            if (shown) {
                commandPanelHintShowRetryTimerId = null;
                return;
            }
            // stop if panel is no longer eligible
            if (!commandPanelDesiredActive || commandPanelSpeechLock) {
                commandPanelHintShowRetryTimerId = null;
                return;
            }
            if (commandPanelHintShowRetryCount >= 18) {
                commandPanelHintShowRetryTimerId = null;
                return;
            }
            commandPanelHintShowRetryTimerId = setTimeout(tick, 140);
        };

        commandPanelHintShowRetryTimerId = setTimeout(tick, 60);
    } catch (e) {}
}

function applyCommandPanelActiveEffective() {
    if (!commandPanel) return;
    const effectiveActive = !!commandPanelDesiredActive && !commandPanelSpeechLock;
    // Re-use the existing implementation by directly toggling the UI state.
    // NOTE: This function intentionally does not modify `commandPanelDesiredActive`.
    try { console.log('applyCommandPanelActiveEffective desired=', commandPanelDesiredActive, 'speechLock=', commandPanelSpeechLock, '=> effective=', effectiveActive); } catch (e) {}

    if (effectiveActive) {
        commandPanel.classList.remove('none-active');
        try { commandPanel.style.pointerEvents = 'auto'; } catch (e) {}
        try {
            const buttons = commandPanel.querySelectorAll('button');
            buttons.forEach(b => { try { b.disabled = false; b.classList.remove('disabled'); b.setAttribute('aria-disabled', 'false'); } catch(e){} });
        } catch (e) {}
        // Re-apply specific button disabled states that are driven by counters
        try { updateAskIndividualButtonState(); } catch (e) {}
        try { updateAskSuspiciousButtonState(); } catch (e) {}
    } else {
        commandPanel.classList.add('none-active');
        try { commandPanel.style.pointerEvents = 'auto'; } catch (e) {}
        try {
            const buttons = commandPanel.querySelectorAll('button');
            buttons.forEach(b => { try { b.disabled = true; b.classList.add('disabled'); b.setAttribute('aria-disabled', 'true'); } catch(e){} });
        } catch (e) {}
    }

    // Show a big animated arrow once, when the command panel becomes active for the first time.
    try {
        if (effectiveActive && !lastCommandPanelEffectiveActive) {
            try { requestShowCommandPanelHint(); } catch (e) {}
        }
        if (!effectiveActive && lastCommandPanelEffectiveActive) {
            try { hideCommandPanelHint(); } catch (e) {}
            try {
                if (commandPanelHintShowRetryTimerId) {
                    clearTimeout(commandPanelHintShowRetryTimerId);
                    commandPanelHintShowRetryTimerId = null;
                }
            } catch (e) {}
        }
        lastCommandPanelEffectiveActive = effectiveActive;
    } catch (e) {}
}

function touchConversationActivity(lockMs = 1400) {
    // Any chat/system log update counts as "speaking".
    // Lock the command panel and auto-unlock after a quiet period.
    try { commandPanelSpeechLock = true; } catch (e) {}
    try {
        if (commandPanelSpeechLockTimerId) clearTimeout(commandPanelSpeechLockTimerId);
    } catch (e) {}
    commandPanelSpeechLockTimerId = setTimeout(() => {
        try { commandPanelSpeechLock = false; } catch (e) {}
        try { applyCommandPanelActiveEffective(); } catch (e) {}
    }, lockMs);
    try { applyCommandPanelActiveEffective(); } catch (e) {}
}
const btnForceCO = document.getElementById('btnForceCO');
const btnDesignate = document.getElementById('btnDesignate');
const designateSummaryPanel = document.getElementById('designateSummaryPanel');
const designateSummaryVote = document.getElementById('designateSummaryVote');
const designateSummaryDivination = document.getElementById('designateSummaryDivination');
const designateSummaryGuard = document.getElementById('designateSummaryGuard');
const btnDesignateGoOptions = document.getElementById('btnDesignateGoOptions');
const btnAskIndividual = document.getElementById('btnAskIndividual');
const btnAskSuspicious = document.getElementById('btnAskSuspicious');
const btnProceedVote = document.getElementById('btnProceedVote');
const coOptions = document.getElementById('coOptions');
const designateOptions = document.getElementById('designateOptions');
const designateTargetList = document.getElementById('designateTargetList');
const questionPanel = document.getElementById('questionPanel');
const questionTargetList = document.getElementById('questionTargetList');
const questionOptions = document.getElementById('questionOptions');
const votingArea = document.getElementById('votingArea');
const voteButtonsNew = document.getElementById('voteButtonsNew');
const nightActionArea = document.getElementById('nightActionArea');
const nightActionButtons = document.getElementById('nightActionButtons');
const spectatorBanner = document.getElementById('spectatorBanner');
const restartPanel = document.getElementById('restartPanel');
const playAgainBtn = document.getElementById('playAgainBtn');
const endReturnToTitleBtn = document.getElementById('endReturnToTitleBtn');
const endEffectOverlay = document.getElementById('endEffectOverlay');
const endEffectTitle = document.getElementById('endEffectTitle');
const endEffectSub = document.getElementById('endEffectSub');
const endEffectParticles = document.getElementById('endEffectParticles');
const startScreen = document.getElementById('startScreen');
const startScreenStartBtn = document.getElementById('startScreenStartBtn');
const startScreenSettingsBtn = document.getElementById('startScreenSettingsBtn');
const userHeaderInfo = document.getElementById('userHeaderInfo');
const userHeaderIcon = document.getElementById('userHeaderIcon');
const userHeaderName = document.getElementById('userHeaderName');
const logFilterBtn = document.getElementById('logFilterBtn');
const filterPanel = document.getElementById('filterPanel');
const clearFilterBtn = document.getElementById('clearFilterBtn');
const activeFilterLabel = document.getElementById('activeFilterLabel');
const btnShowPlayers = document.getElementById('btnShowPlayers');
const btnShowResults = document.getElementById('btnShowResults');
const resultsSection = document.getElementById('resultsSection');
const resultsContainer = document.getElementById('resultsContainer');
const btnResultsBack = document.getElementById('btnResultsBack');

// Mobile: show side panels (players/results) above the chat log.
const MOBILE_SIDE_PANEL_BP_PX = 900;
let mobileSidePanelOpen = false;
let mobileSidePanelView = null; // 'players' | 'results'
let playerInfoPlaceholder = null;
let resultsPlaceholder = null;
let mobileOverlayEl = null;
let mobileOverlayInnerEl = null;

function isMobileLayout() {
    try {
        return window.matchMedia && window.matchMedia(`(max-width: ${MOBILE_SIDE_PANEL_BP_PX}px)`).matches;
    } catch (e) {
        return false;
    }
}

function ensureSidePanelPlaceholders() {
    try {
        if (!playerInfoPlaceholder && playerInfoSection && playerInfoSection.parentNode) {
            playerInfoPlaceholder = document.createComment('player-info-section-placeholder');
            playerInfoSection.parentNode.insertBefore(playerInfoPlaceholder, playerInfoSection);
        }
        if (!resultsPlaceholder && resultsSection && resultsSection.parentNode) {
            resultsPlaceholder = document.createComment('results-section-placeholder');
            resultsSection.parentNode.insertBefore(resultsPlaceholder, resultsSection);
        }
    } catch (e) {}
}

function ensureMobileOverlay() {
    try {
        if (mobileOverlayEl && mobileOverlayInnerEl) return;
        if (!leftColumn) return;

        const overlay = document.createElement('div');
        overlay.id = 'mobileSidePanelOverlay';
        overlay.className = 'mobile-sidepanel-overlay';
        overlay.setAttribute('aria-hidden', 'true');

        const inner = document.createElement('div');
        inner.className = 'mobile-sidepanel-overlay-inner';
        overlay.appendChild(inner);

        // Click outside closes.
        overlay.addEventListener('click', (ev) => {
            try {
                if (ev && ev.target === overlay) closeMobileSidePanel();
            } catch (e) {}
        });
        inner.addEventListener('click', (ev) => {
            try { ev.stopPropagation(); } catch (e) {}
        });

        leftColumn.appendChild(overlay);
        mobileOverlayEl = overlay;
        mobileOverlayInnerEl = inner;
        updateMobileOverlayLayout();
    } catch (e) {}
}

function updateMobileOverlayLayout() {
    try {
        if (!mobileOverlayEl) return;
        if (!leftColumn || !timerSection) return;
        const h = timerSection.offsetHeight || 0;
        mobileOverlayEl.style.top = `${h}px`;
    } catch (e) {}
}

function restoreSidePanelsToOriginalPlace() {
    try {
        if (playerInfoSection) playerInfoSection.classList.remove('mobile-sidepanel-panel');
        if (resultsSection) resultsSection.classList.remove('mobile-sidepanel-panel');
    } catch (e) {}
    try {
        if (playerInfoSection && playerInfoPlaceholder && playerInfoPlaceholder.parentNode) {
            playerInfoPlaceholder.parentNode.insertBefore(playerInfoSection, playerInfoPlaceholder.nextSibling);
        }
        if (resultsSection && resultsPlaceholder && resultsPlaceholder.parentNode) {
            resultsPlaceholder.parentNode.insertBefore(resultsSection, resultsPlaceholder.nextSibling);
        }
    } catch (e) {}
}

function moveSidePanelIntoOverlay(view) {
    try {
        ensureMobileOverlay();
        if (!mobileOverlayInnerEl) return;
        ensureSidePanelPlaceholders();
        restoreSidePanelsToOriginalPlace();

        const target = (view === 'results') ? resultsSection : playerInfoSection;
        if (!target) return;
        try { target.classList.add('mobile-sidepanel-overlay-panel'); } catch (e) {}
        mobileOverlayInnerEl.innerHTML = '';
        mobileOverlayInnerEl.appendChild(target);
    } catch (e) {}
}

function closeMobileSidePanel() {
    mobileSidePanelOpen = false;
    mobileSidePanelView = null;
    try {
        if (mobileOverlayEl) {
            mobileOverlayEl.classList.remove('is-open');
            mobileOverlayEl.setAttribute('aria-hidden', 'true');
        }
    } catch (e) {}
    try { restoreSidePanelsToOriginalPlace(); } catch (e) {}
    applySidePanelView();
}

function openMobileSidePanel(view) {
    mobileSidePanelOpen = true;
    mobileSidePanelView = (view === 'results') ? 'results' : 'players';
    moveSidePanelIntoOverlay(mobileSidePanelView);
    try {
        if (mobileOverlayEl) {
            updateMobileOverlayLayout();
            mobileOverlayEl.classList.add('is-open');
            mobileOverlayEl.setAttribute('aria-hidden', 'false');
        }
    } catch (e) {}
    applySidePanelView();
}

// Side panel view state: keep user's selection across day changes
let sidePanelView = 'players'; // 'players' | 'results'

function applySidePanelView() {
    try {
        const view = sidePanelView;
        if (isMobileLayout()) {
            // On mobile, keep these panels hidden unless explicitly opened.
            if (!mobileSidePanelOpen) {
                if (playerInfoSection) playerInfoSection.style.display = 'none';
                if (resultsSection) resultsSection.style.display = 'none';
                try {
                    if (mobileOverlayEl) {
                        mobileOverlayEl.classList.remove('is-open');
                        mobileOverlayEl.setAttribute('aria-hidden', 'true');
                    }
                } catch (e) {}
                return;
            }
            const openView = mobileSidePanelView || view;
            try {
                if (mobileOverlayEl) {
                    updateMobileOverlayLayout();
                    mobileOverlayEl.classList.add('is-open');
                    mobileOverlayEl.setAttribute('aria-hidden', 'false');
                }
            } catch (e) {}
            if (openView === 'results') {
                if (playerInfoSection) playerInfoSection.style.display = 'none';
                if (resultsSection) resultsSection.style.display = '';
                try { renderResultsTable(); } catch (e) {}
            } else {
                if (resultsSection) resultsSection.style.display = 'none';
                if (playerInfoSection) playerInfoSection.style.display = '';
            }
            return;
        }

        // Desktop/tablet layout: keep showing in the right column.
        try { if (mobileSidePanelOpen) closeMobileSidePanel(); } catch (e) {}
        if (view === 'results') {
            if (playerInfoSection) playerInfoSection.style.display = 'none';
            if (resultsSection) resultsSection.style.display = '';
            try { renderResultsTable(); } catch (e) {}
        } else {
            if (resultsSection) resultsSection.style.display = 'none';
            if (playerInfoSection) playerInfoSection.style.display = '';
        }
    } catch (e) {}
}

function setSidePanelView(view) {
    try {
        sidePanelView = (view === 'results') ? 'results' : 'players';
    } catch (e) {
        sidePanelView = 'players';
    }
    if (isMobileLayout()) {
        // Tap again to close on mobile.
        if (mobileSidePanelOpen && mobileSidePanelView === sidePanelView) {
            closeMobileSidePanel();
            return;
        }
        openMobileSidePanel(sidePanelView);
        return;
    }
    applySidePanelView();
}

// Keep DOM consistent on resize (e.g. rotate phone)
try {
    window.addEventListener('resize', () => {
        try {
            if (!isMobileLayout() && mobileSidePanelOpen) {
                closeMobileSidePanel();
            } else {
                updateMobileOverlayLayout();
                applySidePanelView();
            }
        } catch (e) {}
    });
} catch (e) {}

// 状態管理
let eventSource = null;
let players = new Map();
let currentDay = 0;
// Track the last day when mayor-use counters were reset
let lastResetDay = 0;

// Endgame effect overlay state
let endEffectHideTimerId = null;
let endEffectActive = false;
const endEffectLogBuffer = [];
const END_EFFECT_BUFFER_LIMIT = 300;

function enqueueEndEffectLog(item) {
    try {
        endEffectLogBuffer.push(item);
        // keep buffer bounded (should only be a few seconds)
        if (endEffectLogBuffer.length > END_EFFECT_BUFFER_LIMIT) {
            endEffectLogBuffer.splice(0, endEffectLogBuffer.length - END_EFFECT_BUFFER_LIMIT);
        }
    } catch (e) {}
}

function clearEndEffectLogBuffer() {
    try { endEffectLogBuffer.length = 0; } catch (e) {}
}

function flushEndEffectLogBuffer() {
    try {
        if (endEffectActive) return;
        if (!endEffectLogBuffer.length) return;
        const items = endEffectLogBuffer.splice(0, endEffectLogBuffer.length);
        for (const it of items) {
            try {
                if (!it || !it.kind) continue;
                if (it.kind === 'chat') {
                    addChatMessage(it.player, it.content);
                } else if (it.kind === 'system') {
                    addSystemLog(it.message, it.className || '');
                } else if (it.kind === 'gm') {
                    addGMMessage(it.message);
                }
            } catch (e2) {}
        }
    } catch (e) {}
}

function clearEndEffectParticles() {
    try {
        if (!endEffectParticles) return;
        endEffectParticles.innerHTML = '';
    } catch (e) {}
}

function hideEndEffectOverlay(immediate = false) {
    try {
        if (endEffectHideTimerId) {
            clearTimeout(endEffectHideTimerId);
            endEffectHideTimerId = null;
        }
    } catch (e) {}
    try {
        if (!endEffectOverlay) return;
        endEffectOverlay.classList.remove('is-visible', 'is-victory', 'is-defeat');
        endEffectOverlay.setAttribute('aria-hidden', 'true');
        if (immediate) {
            // Reset flow: drop any buffered logs and ensure overlay is cleared.
            endEffectActive = false;
            clearEndEffectLogBuffer();
            endEffectOverlay.style.display = 'none';
            clearEndEffectParticles();
        } else {
            // allow CSS fade-in to finish; then clean up
            setTimeout(() => {
                try { if (endEffectOverlay) endEffectOverlay.style.display = 'none'; } catch (e2) {}
                try { clearEndEffectParticles(); } catch (e2) {}
                // End effect window ends after overlay is gone; now flush queued logs.
                try {
                    endEffectActive = false;
                    flushEndEffectLogBuffer();
                } catch (e3) {}
            }, 260);
        }
    } catch (e) {}
}

function showEndEffectOverlay(payload) {
    try {
        if (!endEffectOverlay || !endEffectTitle || !endEffectSub) return;

        // Start buffering logs during the overlay.
        endEffectActive = true;
        clearEndEffectLogBuffer();

        const winner = (payload && payload.winner) ? payload.winner : payload;
        const isVillagerWin = String(winner) === 'VILLAGER';
        const isVictory = isVillagerWin;

        // Reset state
        try {
            if (endEffectHideTimerId) {
                clearTimeout(endEffectHideTimerId);
                endEffectHideTimerId = null;
            }
        } catch (e) {}

        // Text
        endEffectTitle.textContent = isVictory ? 'VICTORY' : 'DEFEAT';
        endEffectSub.textContent = isVictory ? '村人陣営の勝利' : '人狼陣営の勝利';

        // Classes
        endEffectOverlay.classList.remove('is-victory', 'is-defeat');
        endEffectOverlay.classList.add(isVictory ? 'is-victory' : 'is-defeat');
        endEffectOverlay.classList.add('is-visible');
        endEffectOverlay.setAttribute('aria-hidden', 'false');
        endEffectOverlay.style.display = 'flex';

        // Particles
        clearEndEffectParticles();
        if (endEffectParticles) {
            // No confetti during defeat.
            endEffectParticles.style.display = isVictory ? 'block' : 'none';

            if (!isVictory) {
                // ensure empty
                clearEndEffectParticles();
            }

            const count = 72;
            for (let i = 0; i < count; i++) {
                const el = document.createElement('span');
                el.className = 'end-effect-particle';

                const x = Math.random() * 100;
                const drift = (Math.random() * 240 - 120).toFixed(0);
                const delay = Math.floor(Math.random() * 600);
                const dur = Math.floor(1700 + Math.random() * 1600);
                const rot = Math.floor(Math.random() * 360);
                const w = Math.floor(6 + Math.random() * 8);
                const h = Math.floor(10 + Math.random() * 16);

                el.style.setProperty('--x', x.toFixed(2) + 'vw');
                el.style.setProperty('--drift', drift + 'px');
                el.style.setProperty('--delay', delay + 'ms');
                el.style.setProperty('--dur', dur + 'ms');
                el.style.setProperty('--r', rot + 'deg');
                el.style.width = w + 'px';
                el.style.height = h + 'px';

                const colors = ['#ffe36a', '#00d9ff', '#9d7bff', '#ff7bd5', '#6aff95'];
                el.style.background = colors[Math.floor(Math.random() * colors.length)];

                if (isVictory) endEffectParticles.appendChild(el);
            }
        }

        // Auto-hide after a few seconds (duration can be provided by server)
        const durationMs = (payload && typeof payload.durationMs === 'number' && isFinite(payload.durationMs))
            ? Math.max(400, payload.durationMs)
            : 4400;
        endEffectHideTimerId = setTimeout(() => {
            hideEndEffectOverlay(false);
        }, durationMs);
    } catch (e) { console.error('showEndEffectOverlay error', e); }
}

function resetCommandPanelUI() {
    try { hideCommandSubpanel(); } catch (e) {}
    try { if (coOptions) coOptions.style.display = 'none'; } catch (e) {}
    try { if (designateOptions) designateOptions.style.display = 'none'; } catch (e) {}
    try { if (designateSummaryPanel) designateSummaryPanel.style.display = 'none'; } catch (e) {}
    try { if (questionPanel) questionPanel.style.display = 'none'; } catch (e) {}
    try { if (designateTargetList) designateTargetList.style.display = 'none'; } catch (e) {}
    try { setCommandPanelActive(false); } catch (e) {}
}

function showPlayAgainUI() {
    try {
        // hide interactive panels
        if (votingArea) votingArea.style.display = 'none';
        if (nightActionArea) nightActionArea.style.display = 'none';
        if (userInputArea) userInputArea.style.display = 'none';
        resetCommandPanelUI();
        if (commandPanel) commandPanel.style.display = 'none';
        // show play-again panel
        if (restartPanel) restartPanel.style.display = 'block';
        if (playAgainBtn) {
            playAgainBtn.disabled = false;
            playAgainBtn.textContent = 'もう一度プレイする';
        }
    } catch (e) { console.error('showPlayAgainUI error', e); }
}

function hidePlayAgainUI() {
    try { if (restartPanel) restartPanel.style.display = 'none'; } catch (e) {}
}

function showStartScreen() {
    try {
        if (!startScreen) return;
        startScreen.style.display = 'flex';
        // ロゴ演出を毎回再生するため、active をトグル
        try { startScreen.classList.remove('active'); } catch (e) {}
        try { void startScreen.offsetWidth; } catch (e) {}
        try { startScreen.classList.add('active'); } catch (e) {}
    } catch (e) {}
}

function hideStartScreen() {
    try {
        if (!startScreen) return;
        startScreen.style.display = 'none';
        try { startScreen.classList.remove('active'); } catch (e) {}
    } catch (e) {}
}

// Track current designation summary (for the "現在の指定先" panel)
const currentDesignations = {
    vote: null,
    // Map<seerId:number, targetDisplay:string>
    divination: new Map(),
    guard: null,
};

function resetDesignationsSummary() {
    currentDesignations.vote = null;
    try { if (currentDesignations.divination && currentDesignations.divination.clear) currentDesignations.divination.clear(); } catch (e) {}
    currentDesignations.guard = null;
    try { renderDesignationsSummary(); } catch (e) {}
}

function escapeHtml(str) {
    const s = (str === null || str === undefined) ? '' : String(str);
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function setDivinationDesignationForSeer(seerId, targetDisplay) {
    try {
        if (!currentDesignations.divination || !currentDesignations.divination.set) {
            currentDesignations.divination = new Map();
        }
        currentDesignations.divination.set(seerId, targetDisplay);
        renderDesignationsSummary();
    } catch (e) {}
}

function setDivinationDesignationForAll(seerCandidates, targetDisplay) {
    try {
        if (!currentDesignations.divination || !currentDesignations.divination.set) {
            currentDesignations.divination = new Map();
        }
        (seerCandidates || []).forEach(s => {
            if (s && typeof s.id === 'number') currentDesignations.divination.set(s.id, targetDisplay);
        });
        renderDesignationsSummary();
    } catch (e) {}
}

function getPlayerDisplayNameById(id) {
    try {
        const p = players && players.get ? players.get(id) : null;
        if (p && p.name) return p.name;
    } catch (e) {}
    return (typeof id === 'number' && Number.isFinite(id)) ? `ID:${id}` : '（不明）';
}

function renderDesignationsSummary() {
    if (designateSummaryVote) designateSummaryVote.textContent = `投票先:${currentDesignations.vote || '未指定'}`;
    if (designateSummaryDivination) {
        try {
            const entries = (currentDesignations.divination && currentDesignations.divination.entries)
                ? Array.from(currentDesignations.divination.entries())
                : [];
            if (!entries || entries.length === 0) {
                designateSummaryDivination.textContent = '占い先:未指定';
            } else {
                const parts = entries.map(([seerId, targetDisplay]) => {
                    const seerName = getPlayerDisplayNameById(seerId);
                    return `<span class="role-color-fortune">${escapeHtml(seerName)}</span>→${escapeHtml(targetDisplay)}`;
                });
                designateSummaryDivination.innerHTML = `占い先<br>${parts.join('<br>')}`;
            }
        } catch (e) {
            try { designateSummaryDivination.textContent = '占い先:未指定'; } catch (_e) {}
        }
    }
    if (designateSummaryGuard) designateSummaryGuard.textContent = `護衛先:${currentDesignations.guard || '未指定'}`;
}
let userId = 0;
let userRole = null;
let isSpectator = false;
let currentPhase = null;
let autoScroll = true;
let isPaused = false;

let userName = '';
let userIcon = '/images/userIcon_boy.png';

// 役職説明（サーバ側の getRoleDescriptionJa と合わせる）
const ROLE_DESCRIPTIONS = {
    '村人': '村人は特殊な能力を持ちません。議論と投票で人狼を見つけましょう。',
    '占い師': '占い師は毎晩一人を占い、人狼かどうかを知ることができます。',
    '霊能者': '霊能者は前日に処刑された人物が人狼だったかを知ることができます。',
    '狩人': '狩人は毎晩一人を護衛し、人狼の襲撃から守ることができます。',
    '人狼': '人狼は仲間と協力して村人を襲撃します。昼は村人を欺きましょう。',
    '狂人': '狂人は人狼陣営を支援する村人です。正体は人狼にも明かされません。'
};

// 占い結果のクライアント保持マップ (playerId -> 'HUMAN'|'WEREWOLF')
const divinationResults = new Map();
// 占い/霊能COリストと結果保持
let seerCOs = []; // ordered list of playerId
let mediumCOs = [];
// resultsMap: playerId -> { day -> { targetName, result: 'white'|'black' }}
let resultsMap = new Map();
// last announce mapping: speakerId -> { day -> targetName }
let lastAnnounce = new Map();
// 「まもなく1日目が始まります。」の表示管理
let daySoonAnnounced = false;
// 村長操作の利用回数制限
let individualQuestionCount = 0;
let askSuspiciousCount = 0;

// Ask-suspicious UX: disable command panel until all alive AI have responded.
let askSuspiciousAwait = null; // { pending:Set<number>, total:number, day:number, timeoutId:number|null }

// Prevent double-submission of mayor operations (e.g. force CO)
let coOperationInFlight = false;

// 表示フィルター: null か playerId
let currentChatFilter = null;

// ゲーム実行フラグ（trueの時はユーザー情報の編集を禁止）
let gameRunning = false;

// ログフィルター時のスクロール位置を保持 (playerId -> scrollTop)
let lastFilterScroll = new Map();
// 直近に適用したフィルターの playerId
let lastAppliedFilterId = null;

// Command panel subpanel helpers: show a single subpanel in-place
// panel stack for nested subpanels (to support 'back')
const commandPanelStack = [];

function setSubpanelDisplay(panel, visible) {
    if (!panel) return;
    try {
        if (!visible) {
            panel.style.display = 'none';
            return;
        }
        // IMPORTANT: Some subpanels (e.g. #designateTargetList) rely on flex
        // layout via CSS (.panel-buttons). Do not overwrite them with 'block'.
        const isFlexPanel = panel.classList && panel.classList.contains('panel-buttons');
        panel.style.display = isFlexPanel ? 'flex' : 'block';
    } catch (e) {}
}

function showCommandSubpanel(panel) {
    if (!commandPanel) return;
    // ensure main command panel visible
    commandPanel.style.display = 'block';
    try {
        console.log('showCommandSubpanel called, panel:', panel && panel.id);
        console.log('commandPanel computedStyle:', window.getComputedStyle(commandPanel));
        if (panel) console.log('panel computedStyle before append:', window.getComputedStyle(panel));
    } catch (e) {}

    // hide all known subpanels inside commandPanel except the one we want to show
    [coOptions, designateSummaryPanel, designateOptions, questionPanel, designateTargetList].forEach(p => {
        try { if (p && p !== panel) setSubpanelDisplay(p, false); } catch (e) {}
    });

    // hide main command buttons while a subpanel is shown
    try {
        const mainBtns = document.querySelector('.command-buttons');
        if (mainBtns) mainBtns.style.display = panel ? 'none' : 'flex';
    } catch (e) {}

    if (!panel) return;

    // push to stack if new
    try {
        const top = commandPanelStack.length > 0 ? commandPanelStack[commandPanelStack.length - 1] : null;
        if (top !== panel) commandPanelStack.push(panel);
    } catch (e) {}

    // make sure the panel is a child of commandPanel
    if (!commandPanel.contains(panel)) commandPanel.appendChild(panel);

    // ensure panel is positioned for back button
    try { panel.style.position = panel.style.position || 'relative'; } catch (e) {}

    // insert back button if not present
    try {
        // Only treat the direct child back button as the panel-level back.
        // (Some panels contain nested sub-views that also have a back button.)
        let existingPanelBack = panel.querySelector(':scope > .subpanel-back-btn[data-panel-back="1"]');
        if (!existingPanelBack) {
            // upgrade legacy direct-child back button (before data attr existed)
            const legacy = panel.querySelector(':scope > .subpanel-back-btn');
            if (legacy) {
                legacy.dataset.panelBack = '1';
                existingPanelBack = legacy;
            }
        }
        if (!existingPanelBack) {
            const back = document.createElement('button');
            back.className = 'subpanel-back-btn';
            back.dataset.panelBack = '1';
            back.textContent = '戻る';
            back.addEventListener('click', (ev) => {
                ev.stopPropagation();
                // pop current
                try {
                    commandPanelStack.pop();
                    const prev = commandPanelStack.length > 0 ? commandPanelStack[commandPanelStack.length - 1] : null;
                    // hide this panel
                    try { setSubpanelDisplay(panel, false); } catch (e) {}
                    if (prev) {
                        // show previous panel
                        try { setSubpanelDisplay(prev, true); } catch (e) {}
                        // ensure the shown previous panel has a visible panel-level back button
                        try { ensurePanelBackExists(prev); } catch (e) {}
                    } else {
                        // nothing left: restore main buttons
                        hideCommandSubpanel();
                    }
                } catch (e) { console.error('back button handler error', e); }
            });
            // style in CSS will position this button
            panel.appendChild(back);
        }
    } catch (e) {}

    setSubpanelDisplay(panel, true);
    // Ensure panel has a visible back button so nested toggles don't leave it hidden
    try { ensurePanelBackExists(panel); } catch (e) {}
    // If this panel is nested inside another panel that was hidden above,
    // ensure its ancestor chain up to commandPanel is visible so the
    // panel actually appears. This fixes cases where we show a nested
    // subpanel (e.g. `designateTargetList`) while its parent (`designateOptions`)
    // was hidden by the earlier hide loop.
    try {
        let anc = panel.parentElement;
        while (anc && anc !== commandPanel) {
            try { anc.style.display = 'block'; } catch (e) {}
            anc = anc.parentElement;
        }
    } catch (e) {}
    try { console.log('panel displayed, offsetHeight:', panel.offsetHeight, 'offsetParent?', panel.offsetParent); } catch (e) {}
}

// Ensure the given panel has a visible panel-level back button.
function ensurePanelBackExists(panel) {
    try {
        if (!panel) return;
        // Important: only select the panel-level back button (direct child).
        // Nested subviews may also have a .subpanel-back-btn.
        let pb = panel.querySelector(':scope > .subpanel-back-btn[data-panel-back="1"]');
        if (!pb) {
            // upgrade legacy direct-child back button
            const legacy = panel.querySelector(':scope > .subpanel-back-btn');
            if (legacy) {
                legacy.dataset.panelBack = '1';
                pb = legacy;
            }
        }
        if (!pb) {
            pb = document.createElement('button');
            pb.className = 'subpanel-back-btn';
            pb.dataset.panelBack = '1';
            pb.textContent = '戻る';
            pb.addEventListener('click', (ev) => {
                ev.stopPropagation();
                try {
                    // pop current
                    commandPanelStack.pop();
                    const prev = commandPanelStack.length > 0 ? commandPanelStack[commandPanelStack.length - 1] : null;
                    try { setSubpanelDisplay(panel, false); } catch (e) {}
                    if (prev) {
                        try { setSubpanelDisplay(prev, true); } catch (e) {}
                        // ensure prev has a visible back button
                        try { ensurePanelBackExists(prev); } catch (e) {}
                    } else {
                        hideCommandSubpanel();
                    }
                } catch (e) { console.error('ensurePanelBackExists back handler error', e); }
            });
            panel.appendChild(pb);
        }
        try { pb.style.display = ''; } catch (e) {}
    } catch (e) { console.error('ensurePanelBackExists error', e); }
}

function hideCommandSubpanel() {
    if (!commandPanel) return;
    try { console.log('hideCommandSubpanel called'); } catch (e) {}
    // hide all known subpanels and clear stack
    [coOptions, designateSummaryPanel, designateOptions, questionPanel, designateTargetList].forEach(p => { try { if (p) p.style.display = 'none'; } catch (e) {} });
    try { commandPanelStack.length = 0; } catch (e) {}
    // restore main command buttons
    try {
        const mainBtns = document.querySelector('.command-buttons');
        if (mainBtns) mainBtns.style.display = 'flex';
    } catch (e) {}
}

// Processing panel helpers: show a temporary panel in place of main buttons
function showProcessingPanel(message) {
    try {
        let p = document.getElementById('processingPanel');
        if (!p && commandPanel) {
            p = document.createElement('div');
            p.id = 'processingPanel';
            p.className = 'panel';
            p.style.display = 'none';
            p.style.marginTop = '8px';
            if (commandPanel) commandPanel.appendChild(p);
        }
        if (!p) return;
        p.textContent = message || '処理中…';
        p.style.display = 'block';
        // Instead of hiding main buttons, keep the panel visible and disable its buttons
        try { setCommandPanelActive(false); } catch (e) {}
    } catch (e) { console.error('showProcessingPanel error', e); }
}

function hideProcessingPanel(restoreMain = true) {
    try {
        const p = document.getElementById('processingPanel');
        if (p) p.style.display = 'none';
        if (restoreMain) {
            try { setCommandPanelActive(true); } catch (e) {}
        }
    } catch (e) { console.error('hideProcessingPanel error', e); }
}

function setHeaderEditingEnabled(enable) {
    if (!userHeaderInfo) return;
    if (enable) {
        userHeaderInfo.classList.remove('disabled');
        userHeaderInfo.setAttribute('tabindex', '0');
        userHeaderInfo.setAttribute('role', 'button');
        userHeaderInfo.setAttribute('aria-disabled', 'false');
        userHeaderInfo.dataset.editable = 'true';
    } else {
        userHeaderInfo.classList.add('disabled');
        userHeaderInfo.setAttribute('tabindex', '-1');
        userHeaderInfo.setAttribute('aria-disabled', 'true');
        userHeaderInfo.dataset.editable = 'false';
    }
}

// Enable or disable the command panel UI for player operations
function setCommandPanelActive(active) {
    if (!commandPanel) return;
    try { console.log('setCommandPanelActive called ->', active, 'existing classes:', commandPanel.className); } catch (e) {}
    commandPanelDesiredActive = !!active;
    try { applyCommandPanelActiveEffective(); } catch (e) {}
    try { console.log('setCommandPanelActive result classes:', commandPanel.className, 'computed pointerEvents:', window.getComputedStyle(commandPanel).pointerEvents); } catch (e) {}
}

function beginAskSuspiciousAwait() {
    try {
        const aliveAiIds = Array.from(players.values())
            .filter(p => p && p.isAlive && !p.isUser)
            .map(p => Number(p.id))
            .filter(id => Number.isFinite(id));

        askSuspiciousAwait = {
            pending: new Set(aliveAiIds),
            total: aliveAiIds.length,
            day: currentDay || 0,
            timeoutId: null
        };

        const remaining = askSuspiciousAwait.pending.size;
        showProcessingPanel(`皆の怪しい人を聞いています…（残り:${remaining}人）`);

        // If there is nobody to wait for, immediately restore UI.
        if (remaining === 0) {
            askSuspiciousAwait = null;
            try { hideProcessingPanel(true); } catch (e) {}
            return;
        }

        try {
            if (askSuspiciousAwait.timeoutId) clearTimeout(askSuspiciousAwait.timeoutId);
        } catch (e) {}
        askSuspiciousAwait.timeoutId = setTimeout(() => {
            try {
                addSystemLog('回答待ちが長いため、操作を再開します。');
            } catch (e) {}
            try { askSuspiciousAwait = null; } catch (e) {}
            try { hideProcessingPanel(true); } catch (e) {}
        }, 45000);
    } catch (e) {
        console.error('beginAskSuspiciousAwait error', e);
        try { askSuspiciousAwait = null; } catch (e2) {}
        try { hideProcessingPanel(true); } catch (e2) {}
    }
}

function noteAskSuspiciousResponse(playerId) {
    try {
        if (!askSuspiciousAwait || !askSuspiciousAwait.pending) return;
        const pid = Number(playerId);
        if (!Number.isFinite(pid)) return;
        if (askSuspiciousAwait.pending.has(pid)) {
            askSuspiciousAwait.pending.delete(pid);
            const remaining = askSuspiciousAwait.pending.size;
            try {
                const p = document.getElementById('processingPanel');
                if (p) p.textContent = `皆の怪しい人を聞いています…（残り:${remaining}人）`;
            } catch (e) {}
            if (remaining <= 0) {
                try {
                    if (askSuspiciousAwait.timeoutId) clearTimeout(askSuspiciousAwait.timeoutId);
                } catch (e) {}
                askSuspiciousAwait = null;
                try { hideProcessingPanel(true); } catch (e) {}
            }
        }
    } catch (e) { console.error('noteAskSuspiciousResponse error', e); }
}

/**
 * アイコンHTML生成関数
 * 画像パスの場合はimgタグ、絵文字の場合はそのまま表示
 */
function getIconHtml(icon) {
    if (!icon) {
        return '👤';
    }
    // 画像パス（/images/で始まる）の場合
    if (icon.startsWith('/images/') || icon.includes('.png') || icon.includes('.jpg') || icon.includes('.jpeg')) {
        return `<img src="${icon}" alt="icon" class="player-icon-img" />`;
    }
    // 絵文字の場合
    return icon;
}

console.log('app.js loaded successfully');
console.log('DOM elements check:', {
    startBtn: !!startBtn,
    gameLog: !!gameLog,
    timerDisplay: !!timerDisplay
});

// Debug: report presence of command buttons
console.log('command button presence:', {
    btnForceCO: !!btnForceCO,
    btnDesignate: !!btnDesignate,
    btnAskIndividual: !!btnAskIndividual,
    commandPanel: !!commandPanel
});

// Debug: global click listener to detect clicks on command buttons (fallback)
document.addEventListener('click', (e) => {
    try {
        const t = e.target;
        const id = (t && t.id) || '';
        if (id === 'btnForceCO' || id === 'btnDesignate' || id === 'btnAskIndividual') {
            console.log('DEBUG_CLICK_DETECTED', id, 'visible?', t && t.offsetParent !== null);
        }
    } catch (err) { console.error('click debug error', err); }
});

/**
 * ページ読み込み時のリセット
 */
window.addEventListener('load', async () => {
    // localStorageからユーザー名・アイコンを復元
    const savedName = localStorage.getItem('userName');
    const savedIcon = localStorage.getItem('userIcon');
    if (savedName) userName = savedName;
    if (savedIcon) userIcon = savedIcon;
    updateUserHeader();

    // サーバー側のゲーム状態もリセット
    try {
        await fetch('/api/reset', { method: 'POST' });
    } catch (error) {
        console.error('リセットエラー:', error);
    }
    resetGameUI();
    // リセット後は編集可能にしておく
    gameRunning = false;
    setHeaderEditingEnabled(true);
    // default: command panel not active until server signals player operation phase
    try { setCommandPanelActive(false); } catch (e) {}
    // スタート画面を表示（ユーザーが「ゲーム開始」を押してから開始）
    try { showStartScreen(); } catch (e) {}
    try { updateAskIndividualButtonState(); } catch (e) {}
    try { updateAskSuspiciousButtonState(); } catch (e) {}
});

if (returnToTitleBtn) {
    returnToTitleBtn.addEventListener('click', async () => {
        // Avoid the button looking "stuck" in :active while a blocking dialog is open.
        try { returnToTitleBtn.blur(); } catch (e) {}
        const ok = await new Promise((resolve) => {
            try {
                requestAnimationFrame(() => {
                    resolve(confirm('タイトル画面に戻りますか？\n進行中のゲームはリセットされます。'));
                });
            } catch (e) {
                resolve(confirm('タイトル画面に戻りますか？\n進行中のゲームはリセットされます。'));
            }
        });
        if (!ok) return;
        // First, hard-stop client-side streams/UI so late events can't leak into the next run.
        try { resetGameUI(); } catch (e) { console.error('returnToTitle resetGameUI error', e); }
        // Then reset server-side state.
        try {
            await fetch('/api/reset', { method: 'POST' });
        } catch (e) {
            console.error('returnToTitle reset error', e);
        }
        try {
            gameRunning = false;
            setHeaderEditingEnabled(true);
        } catch (e) {}
        try { setCommandPanelActive(false); } catch (e) {}
        try { showStartScreen(); } catch (e) { console.error('returnToTitle showStartScreen error', e); }
    });
}

/**
 * Command panel button handlers
 */
if (btnForceCO) {
    btnForceCO.addEventListener('click', () => {
        try {
            console.log('HANDLER_INVOKED btnForceCO');
            if (!coOptions) { console.log('HANDLER btnForceCO: no coOptions'); return; }
            showCommandSubpanel(coOptions);
        } catch (e) { console.error('HANDLER_ERROR btnForceCO', e); }
    });
}

// CO role buttons
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('co-role-btn')) {
        if (coOperationInFlight) {
            addSystemLog('処理中です…少し待ってください');
            return;
        }
        const text = t.textContent.trim();
        let roleKey = undefined;
        if (text.includes('占い')) roleKey = 'SEER';
        if (text.includes('霊能')) roleKey = 'MEDIUM';
        if (text.includes('狩人')) roleKey = 'KNIGHT';
        if (!roleKey) return;
        // If role already COed, only show a system log and do nothing
        if (roleKey === 'SEER' && seerCOs && seerCOs.length > 0) {
            addSystemLog('占い師はすでにCOしています。');
            hideCommandSubpanel();
            return;
        }
        // If no CO yet, but no alive (real or fake) seer exists, show dead message
        if (roleKey === 'SEER' && (!seerCOs || seerCOs.length === 0)) {
            const anyAliveSeer = Array.from(players.values()).some(p => p.isAlive && (p.role === 'SEER' || p.claimedRole === 'SEER'));
            if (!anyAliveSeer) {
                addSystemLog('呼びかけに誰も応じない…どうやら占い師はすでに死亡しているようだ…');
                hideCommandSubpanel();
                return;
            }
        }
        if (roleKey === 'MEDIUM' && mediumCOs && mediumCOs.length > 0) {
            addSystemLog('霊能者はすでにCOしています。');
            hideCommandSubpanel();
            return;
        }
        if (roleKey === 'MEDIUM' && (!mediumCOs || mediumCOs.length === 0)) {
            const anyAliveMedium = Array.from(players.values()).some(p => p.isAlive && (p.role === 'MEDIUM' || p.claimedRole === 'MEDIUM'));
            if (!anyAliveMedium) {
                addSystemLog('呼びかけに誰も応じない…どうやら霊能者はすでに死亡しているようだ…');
                hideCommandSubpanel();
                return;
            }
        }
        if (roleKey === 'KNIGHT') {
            // detect any claimed knight in players map
            const anyKnight = Array.from(players.values()).some(p => p.claimedRole === 'KNIGHT');
            if (anyKnight) {
                addSystemLog('狩人はすでにCOしています。');
                hideCommandSubpanel();
                return;
            }
            // if no claimed knight and no alive knight role, show dead message
            const anyAliveKnight = Array.from(players.values()).some(p => p.isAlive && (p.role === 'KNIGHT' || p.claimedRole === 'KNIGHT'));
            if (!anyAliveKnight) {
                addSystemLog('呼びかけに誰も応じない…どうやら狩人はすでに死亡しているようだ…');
                hideCommandSubpanel();
                return;
            }
        }
        // Request server-side CO flow (server will also emit the mayor's order_* statement)
        (async () => {
            coOperationInFlight = true;
            try {
                const rsp = await fetch('/api/operation/co', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ role: roleKey })
                });
                let j = null;
                try { j = await rsp.json(); } catch (e) { j = null; }
                if (!rsp.ok) {
                    addSystemLog((j && j.error) ? j.error : 'COに失敗しました');
                }
            } catch (e) {
                console.error('CO error', e);
                addSystemLog('CO送信中にエラー');
            } finally {
                coOperationInFlight = false;
            }
            // hide subpanel regardless
            hideCommandSubpanel();
        })();
    }
});

if (btnDesignate) {
    btnDesignate.addEventListener('click', () => {
        try {
            console.log('HANDLER_INVOKED btnDesignate');
            if (!designateSummaryPanel) { console.log('HANDLER btnDesignate: no designateSummaryPanel'); return; }
            try { renderDesignationsSummary(); } catch (e) {}
            showCommandSubpanel(designateSummaryPanel);
            // hide target list initially
            if (designateTargetList) designateTargetList.style.display = 'none';
        } catch (e) { console.error('HANDLER_ERROR btnDesignate', e); }
    });
}

if (btnDesignateGoOptions) {
    btnDesignateGoOptions.addEventListener('click', () => {
        try {
            if (!designateOptions) return;
            showCommandSubpanel(designateOptions);
            if (designateTargetList) designateTargetList.style.display = 'none';
        } catch (e) { console.error('btnDesignateGoOptions error', e); }
    });
}

// designate type selection
document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('designate-type-btn')) {
        const type = t.getAttribute('data-type');
        if (!designateTargetList) return;
        designateTargetList.innerHTML = '';

        // Header text for vote designate
        if (type === 'vote') {
            const header = document.createElement('div');
            header.className = 'panel-title';
            header.textContent = '投票先を指定してください。';
            designateTargetList.appendChild(header);
        }

        // Build ordered name list: roles first will be separate buttons, then preferred player order
        const preferredNames = ['マユミ', 'シンジョー', 'エリザ'];

        // Role quick-buttons (only for vote type)
        if (type === 'vote') {
            const roleWrapper = document.createElement('div');
            roleWrapper.style.display = 'flex';
            roleWrapper.style.flexDirection = 'column';
            roleWrapper.style.gap = '6px';
            roleWrapper.style.width = '100%';
            roleWrapper.style.alignItems = 'center';
            const roles = [ { label: '占い師', roleKey: 'SEER' }, { label: '霊能者', roleKey: 'MEDIUM' } ];
            roles.forEach(r => {
                const rb = document.createElement('button');
                rb.className = 'btn designate-role-btn';
                rb.textContent = r.label;
                rb.dataset.role = r.roleKey;
                rb.addEventListener('click', () => {
                    (async () => {
                        try {
                            const orderText = `投票は${r.label}にしてくれ。`;
                            if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                        } catch (e) { console.error('mayor order statement failed', e); }
                        try {
                            console.log('CLICK designate-role-btn (vote)', r.roleKey);
                            console.log('FETCH: /api/operation/designate_role', { role: r.roleKey });
                            // Immediately request server to pick a random alive player with this role and set as designate
                            const rsp = await fetch('/api/operation/designate_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: r.roleKey }) });
                            const obj = await rsp.json();
                            if (!rsp.ok) addSystemLog(obj.error || '指定に失敗しました');
                            else {
                                try {
                                    // For role designations, keep role label in the summary (do not resolve to a specific player name)
                                    currentDesignations.vote = r.label;
                                    renderDesignationsSummary();
                                } catch (e) {}
                            }
                            designateTargetList.style.display = 'none';
                            hideCommandSubpanel();
                        } catch (e) { console.error('designate_role error', e); addSystemLog('指定に失敗しました'); }
                    })();
                });
                roleWrapper.appendChild(rb);
            });
            designateTargetList.appendChild(roleWrapper);
        }

        // If selecting divination targets: first choose which seer to instruct
        if (type === 'divination') {
            designateTargetList.innerHTML = '';
            const alive = Array.from(players.values()).filter(p => p.isAlive && !p.isUser);
            // gather seer candidates from seerCOs and claimedRole
            const seerCandidatesMap = new Map();
            (seerCOs || []).forEach(id => {
                const p = players.get(id);
                if (p && p.isAlive && !p.isUser) seerCandidatesMap.set(p.id, p);
            });
            alive.forEach(p => {
                if ((p.claimedRole && p.claimedRole === 'SEER') || (p.roleName && p.roleName.includes('占'))) {
                    seerCandidatesMap.set(p.id, p);
                }
            });
            const seerCandidates = Array.from(seerCandidatesMap.values());
            if (seerCandidates.length === 0) {
                addSystemLog('占い師がCOしていない為、占い先を指定できません');
                designateTargetList.style.display = 'none';
                return;
            }
            const header = document.createElement('div');
            header.className = 'panel-title';
            header.textContent = 'どの占い師に指示しますか？';
            designateTargetList.appendChild(header);
            seerCandidates.forEach(s => {
                const b = document.createElement('button');
                b.className = 'btn';
                b.textContent = s.name;
                b.addEventListener('click', () => {
                    // show target selection for this seer
                    showDivinationTargetSelection(s);
                });
                designateTargetList.appendChild(b);
            });

            // Add "all seers" option at the bottom
            const allSeersBtn = document.createElement('button');
            allSeersBtn.className = 'btn';
            allSeersBtn.textContent = '占い師全員';
            allSeersBtn.addEventListener('click', () => {
                showDivinationTargetSelectionForAll(seerCandidates);
            });
            designateTargetList.appendChild(allSeersBtn);

            // ensure target list is a direct child of commandPanel so hiding parent won't hide it
            try { if (commandPanel && designateTargetList && designateTargetList.parentElement !== commandPanel) commandPanel.appendChild(designateTargetList); } catch (e) {}
            // show list: hide parent and directly show the target list panel
            showCommandSubpanel(designateTargetList);
            return;
        }

        // helper: show second-step target selection for a chosen seer
        function showDivinationTargetSelection(seer) {
            if (!designateTargetList) return;
            designateTargetList.innerHTML = '';
            const title = document.createElement('div');
            title.className = 'panel-title';
            title.textContent = `${seer.name}の占い先を指定してください。`;
            designateTargetList.appendChild(title);

            // role buttons first
            const roleWrapper2 = document.createElement('div');
            roleWrapper2.style.display = 'flex';
            roleWrapper2.style.flexDirection = 'column';
            roleWrapper2.style.gap = '6px';
            roleWrapper2.style.width = '100%';
            roleWrapper2.style.alignItems = 'center';
            const roles2 = [ { label: '占い師', roleKey: 'SEER' }, { label: '霊能者', roleKey: 'MEDIUM' } ];
            roles2.forEach(r => {
                const rb = document.createElement('button');
                rb.className = 'btn';
                rb.textContent = r.label;
                rb.addEventListener('click', async () => {
                    // First, post mayor's order statement so the user bubble appears
                    try {
                        const orderText = `${seer.name}は${r.label}を占ってくれ。`;
                        if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                    } catch (e) { console.error('mayor order statement failed', e); }
                    // Request server to resolve a random player of the role for this seer
                    try {
                        const rsp = await fetch('/api/operation/designate_divination_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id, role: r.roleKey }) });
                        const body = await rsp.json().catch(() => ({}));
                        if (!rsp.ok) addSystemLog(body.error || '占い先の指定に失敗しました');
                        else {
                            try {
                                // For role designations, keep role label in the summary (do not resolve to a specific player name)
                                setDivinationDesignationForSeer(seer.id, r.label);
                            } catch (e) {}
                        }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    } catch (e) { console.error('designate_divination_role error', e); addSystemLog('占い先の指定に失敗しました'); }
                });
                roleWrapper2.appendChild(rb);
            });
            designateTargetList.appendChild(roleWrapper2);

            // Then preferred-named players in order
            const alivePlayers2 = Array.from(players.values()).filter(p => p.isAlive && !p.isUser && Number(p.id) !== Number(seer.id));
            const preferredNames2 = ['マユミ', 'シンジョー', 'エリザ'];
            const added2 = new Set();
            for (const name of preferredNames2) {
                const p = alivePlayers2.find(x => x.name === name);
                if (p) {
                    const btn = document.createElement('button');
                    btn.className = 'btn';
                    btn.textContent = p.name;
                    btn.addEventListener('click', async () => {
                        try {
                            const orderText = `${seer.name}は${p.name}を占ってくれ。`;
                            if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                        } catch (e) { console.error('mayor order statement failed', e); }
                        try {
                            console.log('CLICK designate-divination-target', seer.id, p.id);
                            console.log('FETCH: /api/operation/designate_divination', { seerId: seer.id, targetId: p.id });
                            const rsp = await fetch('/api/operation/designate_divination', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id, targetId: p.id }) });
                            const body = await rsp.json().catch(() => ({}));
                            if (!rsp.ok) addSystemLog((body && body.error) ? body.error : '占い先の指定に失敗しました');
                            else {
                                try { setDivinationDesignationForSeer(seer.id, p.name); } catch (e) {}
                            }
                            designateTargetList.style.display = 'none';
                            hideCommandSubpanel();
                        } catch (e) { console.error('designate_divination error', e); addSystemLog('占い先の指定に失敗しました'); }
                    });
                    designateTargetList.appendChild(btn);
                    added2.add(p.id);
                }
            }

            // remaining players
            alivePlayers2.forEach(p => {
                if (added2.has(p.id)) return;
                const btn = document.createElement('button');
                btn.className = 'btn';
                btn.textContent = p.name;
                btn.addEventListener('click', async () => {
                    try {
                        const orderText = `${seer.name}は${p.name}を占ってくれ。`;
                        if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                    } catch (e) { console.error('mayor order statement failed', e); }
                    try {
                        console.log('CLICK designate-divination-target', seer.id, p.id);
                        console.log('FETCH: /api/operation/designate_divination', { seerId: seer.id, targetId: p.id });
                        const rsp = await fetch('/api/operation/designate_divination', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id, targetId: p.id }) });
                        const j = await rsp.json().catch(() => ({}));
                        if (!rsp.ok) addSystemLog(j.error || '占い先の指定に失敗しました');
                        else {
                            try { setDivinationDesignationForSeer(seer.id, p.name); } catch (e) {}
                        }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    } catch (e) { console.error('designate_divination error', e); addSystemLog('占い先の指定に失敗しました'); }
                });
                designateTargetList.appendChild(btn);
            });

            // none
            const noneBtn2 = document.createElement('button');
            noneBtn2.className = 'btn';
            noneBtn2.textContent = '指定しない';
            noneBtn2.addEventListener('click', async () => {
                try {
                    const orderText = `${seer.name}の占い先は本人に任せる。`;
                    if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                } catch (e) { console.error('mayor order statement failed', e); }
                try {
                    // default -> server-side random for this seer
                    const rsp = await fetch('/api/operation/designate_divination_random', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id }) });
                    const obj = await rsp.json().catch(() => ({}));
                    if (!rsp.ok) addSystemLog(obj.error || '占い先の指定に失敗しました');
                    if (rsp.ok) {
                        try { setDivinationDesignationForSeer(seer.id, '指定しない'); } catch (e) {}
                    }
                    designateTargetList.style.display = 'none';
                    hideCommandSubpanel();
                } catch (e) { console.error('designate_divination_random error', e); addSystemLog('占い先の指定に失敗しました'); }
            });
            designateTargetList.appendChild(noneBtn2);
            try { if (commandPanel && designateTargetList && designateTargetList.parentElement !== commandPanel) commandPanel.appendChild(designateTargetList); } catch (e) {}
            // show target list panel directly (hides parent by design)
            showCommandSubpanel(designateTargetList);
        }

        // helper: show second-step target selection for all seer candidates
        function showDivinationTargetSelectionForAll(seers) {
            if (!designateTargetList) return;
            const targetSeers = (seers || []).filter(s => s && s.isAlive && !s.isUser);
            if (targetSeers.length === 0) {
                addSystemLog('占い師がCOしていない為、占い先を指定できません');
                designateTargetList.style.display = 'none';
                return;
            }

            // Avoid presenting targets that would cause any seer to divine themselves.
            const targetSeerIds = new Set((targetSeers || []).map(s => Number(s.id)));

            async function applyToAllSeers(requestFn) {
                const results = await Promise.allSettled(targetSeers.map(s => requestFn(s)));
                const rejected = results.find(r => r.status === 'rejected');
                if (rejected) {
                    addSystemLog('占い先の指定に失敗しました');
                    return false;
                }
                const anyError = results
                    .filter(r => r.status === 'fulfilled')
                    .map(r => r.value)
                    .find(v => v && v.ok === false);
                if (anyError) {
                    addSystemLog(anyError.error || '占い先の指定に失敗しました');
                    return false;
                }

                return true;
            }

            designateTargetList.innerHTML = '';
            const title = document.createElement('div');
            title.className = 'panel-title';
            title.textContent = '占い師全員の占い先を指定してください。';
            designateTargetList.appendChild(title);

            // role buttons first
            const roleWrapper2 = document.createElement('div');
            roleWrapper2.style.display = 'flex';
            roleWrapper2.style.flexDirection = 'column';
            roleWrapper2.style.gap = '6px';
            roleWrapper2.style.width = '100%';
            roleWrapper2.style.alignItems = 'center';
            const roles2 = [ { label: '占い師', roleKey: 'SEER' }, { label: '霊能者', roleKey: 'MEDIUM' } ];
            roles2.forEach(r => {
                const rb = document.createElement('button');
                rb.className = 'btn';
                rb.textContent = r.label;
                rb.addEventListener('click', async () => {
                    try {
                        const orderText = `占い師全員は${r.label}を占ってくれ。`;
                        if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                    } catch (e) { console.error('mayor order statement failed', e); }
                    try {
                        const ok = await applyToAllSeers(async (seer) => {
                            const rsp = await fetch('/api/operation/designate_divination_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id, role: r.roleKey }) });
                            const body = await rsp.json().catch(() => ({}));
                            return { ok: rsp.ok, error: body && body.error };
                        });
                        if (ok) {
                            try { setDivinationDesignationForAll(targetSeers, r.label); } catch (e) {}
                        }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    } catch (e) { console.error('designate_divination_role(all) error', e); addSystemLog('占い先の指定に失敗しました'); }
                });
                roleWrapper2.appendChild(rb);
            });
            designateTargetList.appendChild(roleWrapper2);

            // Then preferred-named players in order
            const alivePlayers2 = Array.from(players.values()).filter(p => p.isAlive && !p.isUser && !targetSeerIds.has(Number(p.id)));
            const preferredNames2 = ['マユミ', 'シンジョー', 'エリザ'];
            const added2 = new Set();
            for (const name of preferredNames2) {
                const p = alivePlayers2.find(x => x.name === name);
                if (p) {
                    const btn = document.createElement('button');
                    btn.className = 'btn';
                    btn.textContent = p.name;
                    btn.addEventListener('click', async () => {
                        try {
                            const orderText = `占い師全員は${p.name}を占ってくれ。`;
                            if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                        } catch (e) { console.error('mayor order statement failed', e); }
                        try {
                            const ok = await applyToAllSeers(async (seer) => {
                                const rsp = await fetch('/api/operation/designate_divination', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id, targetId: p.id }) });
                                const body = await rsp.json().catch(() => ({}));
                                return { ok: rsp.ok, error: body && body.error };
                            });
                            if (ok) {
                                try { setDivinationDesignationForAll(targetSeers, p.name); } catch (e) {}
                            }
                            designateTargetList.style.display = 'none';
                            hideCommandSubpanel();
                        } catch (e) { console.error('designate_divination(all) error', e); addSystemLog('占い先の指定に失敗しました'); }
                    });
                    designateTargetList.appendChild(btn);
                    added2.add(p.id);
                }
            }

            // remaining players
            alivePlayers2.forEach(p => {
                if (added2.has(p.id)) return;
                const btn = document.createElement('button');
                btn.className = 'btn';
                btn.textContent = p.name;
                btn.addEventListener('click', async () => {
                    try {
                        const orderText = `占い師全員は${p.name}を占ってくれ。`;
                        if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                    } catch (e) { console.error('mayor order statement failed', e); }
                    try {
                        const ok = await applyToAllSeers(async (seer) => {
                            const rsp = await fetch('/api/operation/designate_divination', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id, targetId: p.id }) });
                            const body = await rsp.json().catch(() => ({}));
                            return { ok: rsp.ok, error: body && body.error };
                        });
                        if (ok) {
                            try { setDivinationDesignationForAll(targetSeers, p.name); } catch (e) {}
                        }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    } catch (e) { console.error('designate_divination(all) error', e); addSystemLog('占い先の指定に失敗しました'); }
                });
                designateTargetList.appendChild(btn);
            });

            // none
            const noneBtn2 = document.createElement('button');
            noneBtn2.className = 'btn';
            noneBtn2.textContent = '指定しない';
            noneBtn2.addEventListener('click', async () => {
                try {
                    const orderText = '占い師全員の占い先は本人に任せる。';
                    if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                } catch (e) { console.error('mayor order statement failed', e); }
                try {
                    const ok = await applyToAllSeers(async (seer) => {
                        const rsp = await fetch('/api/operation/designate_divination_random', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seerId: seer.id }) });
                        const body = await rsp.json().catch(() => ({}));
                        return { ok: rsp.ok, error: body && body.error };
                    });
                    if (ok) {
                        try { setDivinationDesignationForAll(targetSeers, '指定しない'); } catch (e) {}
                    }
                    designateTargetList.style.display = 'none';
                    hideCommandSubpanel();
                } catch (e) { console.error('designate_divination_random(all) error', e); addSystemLog('占い先の指定に失敗しました'); }
            });
            designateTargetList.appendChild(noneBtn2);

            try { if (commandPanel && designateTargetList && designateTargetList.parentElement !== commandPanel) commandPanel.appendChild(designateTargetList); } catch (e) {}
            showCommandSubpanel(designateTargetList);
        }

        // Then preferred-named players in order
        const alivePlayers = Array.from(players.values()).filter(p => p.isAlive && !p.isUser);
        const addedIds = new Set();
        for (const name of preferredNames) {
            const p = alivePlayers.find(x => x.name === name);
            if (p) {
                const btn = document.createElement('button');
                btn.className = 'btn';
                btn.textContent = p.name;
                btn.addEventListener('click', () => {
                    (async () => {
                        try {
                            const orderText = `投票は${p.name}にしてくれ。`;
                            if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                        } catch (e) { console.error('mayor order statement failed', e); }
                        try {
                            const rsp = await fetch('/api/operation/designate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, targetId: p.id }) });
                            const j = await rsp.json();
                            if (!rsp.ok) addSystemLog(j.error || '指定に失敗しました');
                            else {
                                try { if (type === 'vote') currentDesignations.vote = p.name; } catch (e) {}
                                try { renderDesignationsSummary(); } catch (e) {}
                            }
                            designateTargetList.style.display = 'none';
                            hideCommandSubpanel();
                        } catch (e) { console.error('designate error', e); addSystemLog('指定に失敗しました'); }
                    })();
                });
                designateTargetList.appendChild(btn);
                addedIds.add(p.id);
            }
        }

        // Then remaining alive players in original CHARACTERS order
        // Use players map order fallback
        alivePlayers.forEach(p => {
            if (addedIds.has(p.id)) return;
            const btn = document.createElement('button');
            btn.className = 'btn';
            btn.textContent = p.name;
                btn.addEventListener('click', () => {
                (async () => {
                    try {
                        const orderText = `投票は${p.name}にしてくれ。`;
                        if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                    } catch (e) { console.error('mayor order statement failed', e); }
                    try {
                        console.log('CLICK designate-target', type, p.id);
                        console.log('FETCH: /api/operation/designate', { type, targetId: p.id });
                        const rsp = await fetch('/api/operation/designate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, targetId: p.id }) });
                        const j = await rsp.json();
                        if (!rsp.ok) addSystemLog(j.error || '指定に失敗しました');
                        else {
                            try { if (type === 'vote') currentDesignations.vote = p.name; } catch (e) {}
                            try { renderDesignationsSummary(); } catch (e) {}
                        }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    } catch (e) { console.error('designate error', e); addSystemLog('指定に失敗しました'); }
                })();
            });
            designateTargetList.appendChild(btn);
        });

        // Finally add a "指定しない" option
        const noneBtn = document.createElement('button');
        noneBtn.className = 'btn';
        noneBtn.textContent = '指定しない';
        noneBtn.addEventListener('click', () => {
            (async () => {
                try {
                    // Choose appropriate free-order template based on designate type
                    let orderText = '指定しない。';
                    if (type === 'vote') orderText = '投票はみんなに任せる。';
                    else if (type === 'guard') orderText = '護衛先は狩人に任せる。';
                    else if (type === 'divination') orderText = '占い師の占い先は本人に任せる。';
                    if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                } catch (e) { console.error('mayor order statement failed', e); }
                try {
                    console.log('CLICK designate-none vote -> random');
                    // default -> server-side random for vote
                    console.log('FETCH: /api/operation/designate_random', { type });
                    const rsp = await fetch('/api/operation/designate_random', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type }) });
                    const obj = await rsp.json();
                    if (!rsp.ok) addSystemLog(obj.error || '投票先の指定に失敗しました');
                    else {
                        try {
                            if (obj && typeof obj.targetId === 'number') currentDesignations.vote = getPlayerDisplayNameById(obj.targetId);
                            else currentDesignations.vote = 'ランダム';
                            renderDesignationsSummary();
                        } catch (e) {}
                    }
                    designateTargetList.style.display = 'none';
                    hideCommandSubpanel();
                } catch (e) { console.error('designate_random error', e); addSystemLog('投票先の指定に失敗しました'); }
            })();
        });
        designateTargetList.appendChild(noneBtn);

        try { if (commandPanel && designateTargetList && designateTargetList.parentElement !== commandPanel) commandPanel.appendChild(designateTargetList); } catch (e) {}
        // show the target list panel directly (hide parent options)
        showCommandSubpanel(designateTargetList);
        // If selecting guard targets: show role buttons first then preferred names then rest
        if (type === 'guard') {
            designateTargetList.innerHTML = '';
            const header = document.createElement('div');
            header.className = 'panel-title';
            header.textContent = '狩人の護衛先を指定してください。';
            designateTargetList.appendChild(header);

            // role buttons
            const roleBox = document.createElement('div');
            roleBox.style.display = 'flex';
            roleBox.style.flexDirection = 'column';
            roleBox.style.gap = '6px';
            roleBox.style.width = '100%';
            roleBox.style.alignItems = 'center';
            const roles = [{ label: '占い師', roleKey: 'SEER' }, { label: '霊能者', roleKey: 'MEDIUM' }];
            roles.forEach(r => {
                const b = document.createElement('button');
                b.className = 'btn';
                b.textContent = r.label;
                b.addEventListener('click', () => {
                    // First, send mayor order statement, then ask server to pick a random alive player of the role and set as guard target
                    (async () => {
                        try {
                            const orderText = `護衛先は${r.label}にしてくれ。`;
                            if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                        } catch (e) { console.error('mayor order statement failed', e); }
                        try {
                            const rsp = await fetch('/api/operation/designate_role', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ role: r.roleKey, type: 'guard' }) });
                            const j = await rsp.json();
                            if (!rsp.ok) addSystemLog(j.error || '護衛先の指定に失敗しました');
                            else {
                                try {
                                    // For role designations, keep role label in the summary (do not resolve to a specific player name)
                                    currentDesignations.guard = r.label;
                                    renderDesignationsSummary();
                                } catch (e) {}
                            }
                        } catch (e) { console.error('designate_role guard error', e); addSystemLog('護衛先の指定に失敗しました'); }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    })();
                });
                roleBox.appendChild(b);
            });
            designateTargetList.appendChild(roleBox);

            // preferred names
            const alivePlayersG = Array.from(players.values()).filter(p => p.isAlive && !p.isUser);
            const preferredNamesG = ['マユミ', 'シンジョー', 'エリザ'];
            const addedG = new Set();
            for (const name of preferredNamesG) {
                const p = alivePlayersG.find(x => x.name === name);
                if (p) {
                    const btn = document.createElement('button');
                    btn.className = 'btn';
                    btn.textContent = p.name;
                    btn.addEventListener('click', () => {
                        (async () => {
                            try {
                                const orderText = `護衛先は${p.name}にしてくれ。`;
                                if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                            } catch (e) { console.error('mayor order statement failed', e); }
                            try {
                                const rsp = await fetch('/api/operation/designate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, targetId: p.id }) });
                                const j = await rsp.json();
                                if (!rsp.ok) addSystemLog(j.error || '護衛先の指定に失敗しました');
                                else {
                                    try { currentDesignations.guard = p.name; renderDesignationsSummary(); } catch (e) {}
                                }
                            } catch (e) { console.error('designate error', e); addSystemLog('護衛先の指定に失敗しました'); }
                            designateTargetList.style.display = 'none';
                            hideCommandSubpanel();
                        })();
                    });
                    designateTargetList.appendChild(btn);
                    addedG.add(p.id);
                }
            }

            // remaining
            alivePlayersG.forEach(p => {
                if (addedG.has(p.id)) return;
                const btn = document.createElement('button');
                btn.className = 'btn';
                btn.textContent = p.name;
                btn.addEventListener('click', () => {
                    (async () => {
                        try {
                            const orderText = `護衛先は${p.name}にしてくれ。`;
                            if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                        } catch (e) { console.error('mayor order statement failed', e); }
                        try {
                            const rsp = await fetch('/api/operation/designate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type, targetId: p.id }) });
                            const j = await rsp.json();
                            if (!rsp.ok) addSystemLog(j.error || '護衛先の指定に失敗しました');
                            else {
                                try { currentDesignations.guard = p.name; renderDesignationsSummary(); } catch (e) {}
                            }
                        } catch (e) { console.error('designate error', e); addSystemLog('護衛先の指定に失敗しました'); }
                        designateTargetList.style.display = 'none';
                        hideCommandSubpanel();
                    })();
                });
                designateTargetList.appendChild(btn);
            });

            const none = document.createElement('button');
            none.className = 'btn';
            none.textContent = '指定しない';
            none.addEventListener('click', async () => {
                try {
                    const orderText = '護衛先は狩人に任せる。';
                    if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
                } catch (e) { console.error('mayor order statement failed', e); }
                try {
                    console.log('CLICK designate-none guard -> random');
                    console.log('FETCH: /api/operation/designate_random', { type: 'guard' });
                    const rsp = await fetch('/api/operation/designate_random', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ type: 'guard' }) });
                    const obj = await rsp.json().catch(() => ({}));
                    if (!rsp.ok) addSystemLog(obj.error || '護衛先の指定に失敗しました');
                    else {
                        try {
                            if (obj && typeof obj.targetId === 'number') currentDesignations.guard = getPlayerDisplayNameById(obj.targetId);
                            else currentDesignations.guard = 'ランダム';
                            renderDesignationsSummary();
                        } catch (e) {}
                    }
                    designateTargetList.style.display = 'none';
                    hideCommandSubpanel();
                } catch (e) { console.error('designate_random guard error', e); addSystemLog('護衛先の指定に失敗しました'); }
            });
            designateTargetList.appendChild(none);
            try { if (commandPanel && designateTargetList && designateTargetList.parentElement !== commandPanel) commandPanel.appendChild(designateTargetList); } catch (e) {}
            // show the target list panel directly (hide parent options)
            showCommandSubpanel(designateTargetList);
            return;
        }
    }
});

if (btnAskIndividual) {
    btnAskIndividual.addEventListener('click', () => {
        try {
            console.log('HANDLER_INVOKED btnAskIndividual');
            if (!questionPanel) { console.log('HANDLER btnAskIndividual: no questionPanel'); return; }
            // Always reset the panel view when reopening (previous run may have hidden the title/back)
            try { resetAskIndividualPanelView(); } catch (e) {}
            // show the question subpanel in-place and hide main buttons
            showCommandSubpanel(questionPanel);
            // populate target list
            if (!questionTargetList) { console.log('HANDLER btnAskIndividual: no questionTargetList'); return; }

            questionTargetList.innerHTML = '';
            // Note: panel-level back button supplied by showCommandSubpanel
            Array.from(players.values())
                .filter(p => p.isAlive && !p.isUser)
                .sort((a, b) => (Number(a.id) || 0) - (Number(b.id) || 0))
                .forEach(p => {
                    const b = document.createElement('button');
                    b.className = 'btn';
                    b.textContent = p.name;
                    b.title = p.name;
                    b.setAttribute('data-player-id', String(p.id));
                    b.addEventListener('click', () => {
                        console.log('CLICK question-target', p.id);
                        if (!questionOptions || !questionTargetList) return;

                        // target-first flow: choose target then show question options
                        try { questionOptions.dataset.targetId = String(p.id); } catch (e) {}
                        try {
                            const titleElem = questionOptions.querySelector('.panel-title');
                            if (titleElem) titleElem.textContent = `${p.name}へ何を質問しますか？`;
                        } catch (e) {}
                        try { questionTargetList.style.display = 'none'; } catch (e) {}

                        // hide panel-level title/back while selecting the question
                        try {
                            let topTitle = questionPanel.querySelector(':scope > .panel-title');
                            if (!topTitle) {
                                const candidates = questionPanel.querySelectorAll('.panel-title');
                                topTitle = Array.from(candidates).find(el => !questionOptions || !questionOptions.contains(el));
                            }
                            if (topTitle) topTitle.style.display = 'none';
                        } catch (e) {}
                        try {
                            const panelBack = questionPanel.querySelector(':scope > .btn-back') || questionPanel.querySelector('.btn-back');
                            if (panelBack) panelBack.style.display = 'none';
                        } catch (e) {}

                        questionOptions.style.display = 'block';
                    });
                    questionTargetList.appendChild(b);
                });

            // Default view is target selection first
            try { questionTargetList.style.display = ''; } catch (e) {}
            // ensure the panel-level back button exists and is visible
            try { ensurePanelBackExists(questionPanel); } catch (e) {}
            try { if (questionOptions) questionOptions.style.display = 'none'; } catch (e) {}
        } catch (e) { console.error('HANDLER_ERROR btnAskIndividual', e); }
    });
}

// Utility: enable/disable Ask Individual button based on local counter
function updateAskIndividualButtonState() {
    try {
        if (!btnAskIndividual) return;
        const remaining = Math.max(0, 3 - individualQuestionCount);
            if (remaining === 0) {
            btnAskIndividual.disabled = true;
            btnAskIndividual.classList.add('disabled');
        } else {
            btnAskIndividual.disabled = false;
            btnAskIndividual.classList.remove('disabled');
        }

        // Label includes remaining count inside the button
        try { btnAskIndividual.textContent = `個別に質問(残り${remaining}回)`; } catch (e) {}
        try {
            const el = document.getElementById('askIndividualRemaining');
            if (el) {
                el.textContent = `残り:${remaining}回`;
                if (remaining === 0) {
                    el.style.color = 'red';
                    el.style.fontWeight = '700';
                } else {
                    el.style.color = '';
                    el.style.fontWeight = '';
                }
            }
        } catch (e) {}
    } catch (e) { console.error('updateAskIndividualButtonState error', e); }
}

// Utility: enable/disable Ask Suspicious button based on local counter
function updateAskSuspiciousButtonState() {
    try {
        if (!btnAskSuspicious) return;
        const remaining = Math.max(0, 1 - askSuspiciousCount);
        if (askSuspiciousCount >= 1) {
            btnAskSuspicious.disabled = true;
            btnAskSuspicious.classList.add('disabled');
        } else {
            btnAskSuspicious.disabled = false;
            btnAskSuspicious.classList.remove('disabled');
        }

        // Label includes remaining count inside the button
        try { btnAskSuspicious.textContent = `皆の怪しい人を聞く(残り${remaining}回)`; } catch (e) {}
        try {
            const el = document.getElementById('askSuspiciousRemaining');
            if (el) {
                el.textContent = `残り:${remaining}回`;
                if (remaining === 0) {
                    el.style.color = 'red';
                    el.style.fontWeight = '700';
                } else {
                    el.style.color = '';
                    el.style.fontWeight = '';
                }
            }
        } catch (e) {}
    } catch (e) { console.error('updateAskSuspiciousButtonState error', e); }
}

// question option selection
const INDIVIDUAL_QUESTION_LABELS = {
    'ask_if_ok_to_be_divined': '自分が占われても構わない？',
    'ask_if_ok_to_be_sacrificed': '自分が犠牲でも厭わない？',
    'ask_if_have_role': '何か役職持っている？',
    'ask_who_will_be_attacked': '明日誰が襲われると思う？',
};

function sendIndividualQuestion(targetId, q, questionText) {
    if (!targetId || !q) return;
    if (individualQuestionCount >= 3) { alert('個別質問は1日3回までです'); updateAskIndividualButtonState(); return; }

    // First, post the user's statement so the user's bubble/icon appears via server broadcast
    (async () => {
        try {
            if (userId !== null && userId !== undefined) {
                await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: questionText }) });
            }
        } catch (e) { console.error('post statement error', e); }
        // then send the mayor individual question operation
        try {
            const resp = await fetch('/api/operation/question', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetId, questionKey: q }) });
            await resp.json().catch(() => ({}));
            individualQuestionCount++;
            updateAskIndividualButtonState();
            hideCommandSubpanel();
            try { resetAskIndividualPanelView(); } catch (e) {}
        } catch (e) { console.error('question error', e); }
    })();
}

document.addEventListener('click', (e) => {
    const t = e.target;
    if (t && t.classList && t.classList.contains('question-btn')) {
        const q = t.getAttribute('data-q');
        const targetId = questionOptions ? Number(questionOptions.dataset.targetId) : null;

        if (!targetId || !q) return;

        const targetPlayer = players.has(targetId) ? players.get(targetId) : null;
        const questionText = (INDIVIDUAL_QUESTION_LABELS[q] || q).replace(/〇〇/g, targetPlayer ? targetPlayer.name : '誰か');
        sendIndividualQuestion(targetId, q, questionText);
    }
});

// Reset the "Ask Individual" panel to the initial (target select) view.
function resetAskIndividualPanelView() {
    try {
        if (!questionPanel) return;
        try {
            const topTitle = questionPanel.querySelector(':scope > .panel-title') || questionPanel.querySelector('.panel-title');
            if (topTitle) {
                topTitle.style.display = '';
                topTitle.textContent = '誰を質問しますか？';
            }
        } catch (e) {}
        // restore panel-level back button
        try { ensurePanelBackExists(questionPanel); } catch (e) {}
        try {
            const panelBack = questionPanel.querySelector(':scope > .btn-back') || questionPanel.querySelector('.btn-back');
            if (panelBack) panelBack.style.display = '';
        } catch (e) {}
        // default: target list visible, question options hidden
        try { if (questionTargetList) questionTargetList.style.display = ''; } catch (e) {}
        try { if (questionOptions) questionOptions.style.display = 'none'; } catch (e) {}
        try {
            if (questionOptions) {
                questionOptions.dataset.targetId = '';
            }
        } catch (e) {}
        // reset options title
        try {
            if (questionOptions) {
                const titleElem = questionOptions.querySelector('.panel-title');
                if (titleElem) titleElem.textContent = '何を質問しますか？';
            }
        } catch (e) {}

    } catch (e) { console.error('resetAskIndividualPanelView error', e); }
}

if (btnAskSuspicious) {
    btnAskSuspicious.addEventListener('click', () => {
        if (askSuspiciousCount >= 1) { alert('「皆の怪しい人を聞く」は1日1回までです'); return; }
        // send mayor order statement first so the user's utterance appears in the log
        (async () => {
            try {
                const orderText = '皆の怪しいと思う人を教えてくれ。';
                if (userId !== null && userId !== undefined) await fetch('/api/statement', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ playerId: userId, content: orderText }) });
            } catch (e) { console.error('mayor statement error for ask_suspicious', e); }
            try {
                showProcessingPanel('皆の怪しい人を聞いています…');
                const r = await fetch('/api/operation/ask_suspicious', { method: 'POST' });
                const j = await r.json().catch(() => ({}));
                askSuspiciousCount++;
                updateAskSuspiciousButtonState();
                // remove processing panel and restore main buttons (keep command panel visible)
                hideProcessingPanel(true);
            } catch (e) {
                console.error('ask suspicious error', e);
                hideProcessingPanel(true);
            }
        })();
    });
}

if (btnProceedVote) {
    btnProceedVote.addEventListener('click', () => {
        // 投票処理を開始するときは「投票中…」と表示する
        showProcessingPanel('投票中…');
        fetch('/api/proceed_to_voting', { method: 'POST' })
            .then(r => r.json()).then(j => {
                // クライアント側の自動ログ表示を抑制：サーバー側イベントでUIを制御
                // leave main buttons hidden; server will emit proceed_to_voting which hides command panel
                hideProcessingPanel(false);
            }).catch(e => { console.error('proceed to voting error', e); hideProcessingPanel(true); });
    });
}

function resetGameUI() {
    console.log('🔄 Resetting game UI');
    gameLog.innerHTML = '<div class="log-placeholder">「ゲーム開始」ボタンを押してゲームを開始してください</div>';
    playerList.innerHTML = '<div class="empty-state">ゲーム開始後に表示</div>';
    dayInfo.textContent = '待機中';
    phaseInfo.textContent = '-';
    timerDisplay.textContent = '--';
    if (userInputArea) userInputArea.style.display = 'none';
    if (commandPanel) commandPanel.style.display = 'none';
    if (restartPanel) restartPanel.style.display = 'none';
    try { hideEndEffectOverlay(true); } catch (e) {}
    votingArea.style.display = 'none';
    nightActionArea.style.display = 'none';
    spectatorBanner.style.display = 'none';
    scrollIndicator.style.display = 'none';
    startBtn.disabled = false;
    startBtn.textContent = 'ゲーム開始';
    stopBtn.textContent = 'ストップ';
    isPaused = false;

    // スタート画面側の開始ボタンも初期化（「開始中…」の取り残し対策）
    try {
        if (startScreenStartBtn) {
            startScreenStartBtn.disabled = false;
            startScreenStartBtn.textContent = 'ゲーム開始';
            try { startScreenStartBtn.classList.remove('is-loading'); } catch (e) {}
            try { startScreenStartBtn.removeAttribute('aria-busy'); } catch (e) {}
        }
    } catch (e) {}
    // プレイヤー情報欄を非表示
    if (playerInfoSection) playerInfoSection.style.display = 'none';
    // ビュー切替ボタンも初期は非表示（1日目開始後に表示）
    try { if (playerControls) playerControls.classList.remove('is-visible'); } catch (e) {}

    // EventSourceを完全にクローズ
    if (eventSource) {
        console.log('Closing existing EventSource');
        eventSource.close();
        eventSource = null;
    }
    
    players.clear();
    try { resetDesignationsSummary(); } catch (e) {}
    currentDay = 0;
    isSpectator = false;
    userRole = null;
    currentPhase = null;
    seerDescriptionShown = false;
    daySoonAnnounced = false;
    daySoonBuffered = false;
    gmMessageBuffer = [];
    autoScroll = true;
    userId = 0;
    // フィルター解除
    currentChatFilter = null;
    if (activeFilterLabel) activeFilterLabel.style.display = 'none';
    if (clearFilterBtn) clearFilterBtn.style.display = 'none';
    // ログフィルターボタンは初期状態で非表示（初日の昼開始後に表示）
    if (logFilterBtn) logFilterBtn.style.display = 'none';
    // レイアウト診断
    console.log('📐 Layout check:', {
        gameLogHeight: gameLog.offsetHeight,
        gameLogScrollHeight: gameLog.scrollHeight,
        gameMainHeight: document.querySelector('.game-main')?.offsetHeight,
        leftColumnHeight: document.querySelector('.left-column')?.offsetHeight
    });
}

function updateUserHeader() {
    userHeaderIcon.innerHTML = getIconHtml(userIcon);
    userHeaderName.textContent = userName || 'あなた';
}

function waitForEventSourceOpen(timeoutMs = 1200) {
    try {
        if (eventSource && eventSource.readyState === 1) return Promise.resolve(true);
        if (!eventSource) return Promise.resolve(false);
        return new Promise((resolve) => {
            let done = false;
            const finish = (v) => {
                if (done) return;
                done = true;
                resolve(v);
            };
            try {
                eventSource.addEventListener('open', () => finish(true), { once: true });
            } catch (e) {
                // ignore
            }
            setTimeout(() => finish(false), timeoutMs);
        });
    } catch (e) {
        return Promise.resolve(false);
    }
}

async function startGameFlow(triggerBtn) {
    try {
        if (triggerBtn) {
            try { triggerBtn.disabled = true; } catch (e) {}
            try { triggerBtn.textContent = '開始中...'; } catch (e) {}
            try { triggerBtn.classList.add('is-loading'); } catch (e) {}
            try { triggerBtn.setAttribute('aria-busy', 'true'); } catch (e) {}
        }
        // hide endgame restart UI if visible
        try { hidePlayAgainUI(); } catch (e) {}

        // If an end-effect overlay is still active, clear it now so logs won't be buffered
        // into the previous endgame buffer when starting a new run.
        try { hideEndEffectOverlay(true); } catch (e) {}

        // Stop any previous game instance on the server (best-effort) to avoid late events.
        try { await fetch('/api/reset', { method: 'POST' }); } catch (e) {}

        // Keep EventSource alive across restarts to avoid missing early init events.
        // Ensure it's connected BEFORE /api/start.
        try {
            if (!eventSource || eventSource.readyState === 2) {
                connectEventSource();
            }
            await waitForEventSourceOpen(1200);
        } catch (e) {}

        // ユーザー名・アイコンを送信
        const payload = { userName, userIcon };
        console.log('Fetching /api/start... payload:', payload);
        const response = await fetch('/api/start', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        const data = await response.json();
        console.log('Start response:', data);

        if (response.ok) {
            // スタート画面を閉じる
            try { hideStartScreen(); } catch (e) {}
            // UIをリセット
            gameLog.innerHTML = '';
            playerList.innerHTML = '<div class="empty-state">ゲーム開始後に表示</div>';
            players.clear();
            try { resetDesignationsSummary(); } catch (e) {}
            currentDay = 0;
            isSpectator = false;
            userRole = null;
            currentPhase = null;
            // EventSource is already connected (or being reused)

            // ゲーム中は開始ボタンを無効化
            startBtn.textContent = 'ゲーム進行中';
            startBtn.disabled = true;
            // 編集を無効化
            gameRunning = true;
            setHeaderEditingEnabled(false);

            // コマンドパネルはサーバ通知まで非アクティブ
            try { setCommandPanelActive(false); } catch (e) {}
        } else {
            try { if (questionTargetList) questionTargetList.style.display = ''; } catch (e) {}
            try { if (questionOptions) questionOptions.style.display = 'none'; } catch (e) {}
            try { if (questionTargetList) questionTargetList.innerHTML = ''; } catch (e) {}
            startBtn.disabled = false;
            startBtn.textContent = 'ゲーム開始';
            if (triggerBtn && triggerBtn !== startBtn) {
                try { triggerBtn.disabled = false; } catch (e) {}
                try { triggerBtn.textContent = (triggerBtn === playAgainBtn) ? 'もう一度プレイする' : 'ゲーム開始'; } catch (e) {}
                try { triggerBtn.classList.remove('is-loading'); } catch (e) {}
                try { triggerBtn.removeAttribute('aria-busy'); } catch (e) {}
            }
            try { showStartScreen(); } catch (e) {}
        }
    } catch (error) {
        console.error('エラー:', error);
        alert('ゲームの開始に失敗しました');
        try {
            startBtn.disabled = false;
            startBtn.textContent = 'ゲーム開始';
        } catch (e) {}
        if (triggerBtn && triggerBtn !== startBtn) {
            try { triggerBtn.disabled = false; } catch (e) {}
            try { triggerBtn.textContent = (triggerBtn === playAgainBtn) ? 'もう一度プレイする' : 'ゲーム開始'; } catch (e) {}
            try { triggerBtn.classList.remove('is-loading'); } catch (e) {}
            try { triggerBtn.removeAttribute('aria-busy'); } catch (e) {}
        }
        try { showStartScreen(); } catch (e) {}
    }
}

/**
 * ゲーム開始
 */
startBtn.addEventListener('click', async () => {
    console.log('🎮 Game start button clicked');
    await startGameFlow(startBtn);
});

if (startScreenStartBtn) {
    startScreenStartBtn.addEventListener('click', async () => {
        console.log('🎬 Start screen start button clicked');
        await startGameFlow(startScreenStartBtn);
    });
}

if (startScreenSettingsBtn) {
    startScreenSettingsBtn.addEventListener('click', async (e) => {
        try { if (e && e.preventDefault) e.preventDefault(); } catch (_e) {}
        try { if (e && e.stopPropagation) e.stopPropagation(); } catch (_e) {}
        try {
            openUserEditDialog();
        } catch (e) {
            try { console.error('openUserEditDialog failed', e); } catch (_e) {}
            try { alert('設定画面を開けませんでした'); } catch (_e2) {}
        }
    });
}

if (playAgainBtn) {
    playAgainBtn.addEventListener('click', async () => {
        console.log('🔁 Play again button clicked');
        await startGameFlow(playAgainBtn);
    });
}

if (endReturnToTitleBtn) {
    endReturnToTitleBtn.addEventListener('click', async () => {
        // Avoid the button looking "stuck" in :active while a blocking dialog is open.
        try { endReturnToTitleBtn.blur(); } catch (e) {}
        const ok = await new Promise((resolve) => {
            try {
                requestAnimationFrame(() => {
                    resolve(confirm('タイトル画面に戻りますか？\n進行中のゲームはリセットされます。'));
                });
            } catch (e) {
                resolve(confirm('タイトル画面に戻りますか？\n進行中のゲームはリセットされます。'));
            }
        });
        if (!ok) return;

        // First, hard-stop client-side streams/UI so late events can't leak into the next run.
        try { resetGameUI(); } catch (e) { console.error('endReturnToTitle resetGameUI error', e); }
        // Then reset server-side state.
        try {
            await fetch('/api/reset', { method: 'POST' });
        } catch (e) {
            console.error('endReturnToTitle reset error', e);
        }
        try {
            gameRunning = false;
            setHeaderEditingEnabled(true);
        } catch (e) {}
        try { setCommandPanelActive(false); } catch (e) {}
        try { showStartScreen(); } catch (e) { console.error('endReturnToTitle showStartScreen error', e); }
    });
}

/**
 * ストップボタン（議論とAI会話を停止）
 */
stopBtn.addEventListener('click', async () => {
    try {
        if (!isPaused) {
            const response = await fetch('/api/stop', { method: 'POST' });
            if (response.ok) {
                console.log('ゲームを停止しました');
                // サーバー側からpausedイベントも来るが、即時反映しておく
                isPaused = true;
                stopBtn.textContent = '再開';
            }
        } else {
            const response = await fetch('/api/resume', { method: 'POST' });
            if (response.ok) {
                console.log('ゲームを再開しました');
                isPaused = false;
                stopBtn.textContent = 'ストップ';
            }
        }
    } catch (error) {
        console.error('ストップエラー:', error);
    }
});

/**
 * スキップボタン
 */
skipBtn.addEventListener('click', async () => {
    try {
        const response = await fetch('/api/skip', { method: 'POST' });
        if (!response.ok) {
            const data = await response.json();
            console.error('スキップエラー:', data.error);
        }
    } catch (error) {
        console.error('エラー:', error);
    }
});

/**
 * スクロール制御
 */
gameLog.addEventListener('scroll', () => {
    const isAtBottom = gameLog.scrollHeight - gameLog.scrollTop <= gameLog.clientHeight + 50;
    
    if (isAtBottom) {
        autoScroll = true;
        scrollIndicator.style.display = 'none';
    } else {
        autoScroll = false;
        scrollIndicator.style.display = 'block';
    }
});

scrollToBottomBtn.addEventListener('click', () => {
    gameLog.scrollTop = gameLog.scrollHeight;
    autoScroll = true;
    scrollIndicator.style.display = 'none';
});

function scrollToBottom() {
    if (autoScroll) {
        gameLog.scrollTop = gameLog.scrollHeight;
    }
}

/**
 * ユーザー発言を処理
 */
if (userTextInput) {
    userTextInput.addEventListener('keypress', async (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            const content = userTextInput.value.trim();
            
            if (!content) return;

            try {
                const response = await fetch('/api/statement', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ playerId: userId, content: content }),
                });

                if (response.ok) {
                    userTextInput.value = '';
                } else {
                    const data = await response.json();
                    console.error('発言エラー:', data.error);
                }
            } catch (error) {
                console.error('❌ エラー:', error);
            }
        }
    });
}

/**
 * 投票処理
 */
function handleVote(targetId, targetName) {
    if (confirm(`${targetName}に投票しますか？`)) {
        // 投票ボタンを押したら処理中表示
        showProcessingPanel('投票中…');
        fetch('/api/vote', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerId: userId, targetId: targetId }),
        })
        .then(response => response.json())
        .then(data => {
            if (!data.error) {
                votingArea.style.display = 'none';
                addSystemLog('投票しました');
            }
            hideProcessingPanel(true);
        })
        .catch(error => { console.error('投票エラー:', error); hideProcessingPanel(true); });
    }
}

/**
 * 夜行動（占い先選択）
 */
function handleNightAction(targetId, targetName) {
    // seer cannot divine themselves
    if (userId !== null && userId !== undefined && Number(targetId) === Number(userId)) {
        try { addSystemLog('自分自身は占えません'); } catch (e) {}
        return;
    }
    if (confirm(`${targetName}を占いますか？`)) {
        fetch('/api/night-action', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ playerId: userId, targetId: targetId }),
        })
        .then(response => response.json())
        .then(data => {
            if (!data.error) {
                nightActionArea.style.display = 'none';
                addSystemLog('占い先を選択しました');
            }
        })
        .catch(error => console.error('夜行動エラー:', error));
    }
}

/**
 * EventSource接続
 */
function connectEventSource() {
    if (eventSource) eventSource.close();
    
    console.log('Connecting to EventSource...');
    eventSource = new EventSource('/events');

    // 起動時フリーズ対策:
    // 受信したSSEの生データを毎回 console.log すると、メッセージ量によってブラウザが固まることがある。
    // 必要なときだけ `?debugSse=1` を付けた場合に限定して出力する。
    try {
        const enableRaw = (typeof location !== 'undefined') && /(?:\?|&)debugSse=1(?:&|$)/.test(location.search);
        if (enableRaw) {
            let rawCount = 0;
            eventSource.onmessage = (e) => {
                try {
                    rawCount++;
                    // 無制限に出すと再び固まるので上限を設ける
                    if (rawCount <= 50) console.log('SSE onmessage raw:', e.data);
                } catch (err) { console.error('SSE raw log error', err); }
            };
        } else {
            eventSource.onmessage = null;
        }
    } catch (e) {
        try { eventSource.onmessage = null; } catch (_e) {}
    }

    eventSource.onopen = () => {
        console.log('EventSource connected successfully');
    };

    eventSource.onerror = (error) => {
        console.error('EventSource error:', error);
    };

    // ログイベント
    eventSource.addEventListener('log', (event) => {
        console.log('Event: log', event.data);
        const data = JSON.parse(event.data);
        handleLogEvent(data);
    });

    // Immediate player result for CO (server emitted when CO happens and player has stored result)
    eventSource.addEventListener('player_result', (event) => {
        try {
            const data = JSON.parse(event.data);
            // data: { speakerId, day, targetId, result:'white'|'black', targetName, type }
            const speakerId = data.speakerId;
            const day = data.day || currentDay || 1;
            if (!speakerId) return;
            if (!resultsMap.has(speakerId)) resultsMap.set(speakerId, {});
            const rec = resultsMap.get(speakerId) || {};
            rec[day] = { targetName: data.targetName || '（不明）', result: data.result === 'black' ? 'black' : 'white' };
            resultsMap.set(speakerId, rec);
            // ensure speaker is in seerCOs/mediumCOs if not already
            try {
                if (data.type === 'seer' && !seerCOs.includes(speakerId)) seerCOs.push(speakerId);
                if (data.type === 'medium' && !mediumCOs.includes(speakerId)) mediumCOs.push(speakerId);
            } catch (e) {}
            renderResultsTable();
        } catch (e) { console.error('player_result parse error', e); }
    });

    // 直接の発言イベント（構造化データ）
    eventSource.addEventListener('statement', (event) => {
        try {
            const data = JSON.parse(event.data);
            // data: { playerId, playerName, content, day }
            const player = players.has(data.playerId) ? players.get(data.playerId) : Array.from(players.values()).find(p => p.name === data.playerName || (`${p.name}さん`) === data.playerName);
            if (player) {
                addChatMessage(player, data.content);
                // While waiting for ask-suspicious responses, keep command panel inactive
                // and count each alive AI's suspect/none_suspect reply.
                try {
                    if (askSuspiciousAwait && (data.key === 'suspect' || data.key === 'none_suspect')) {
                        noteAskSuspiciousResponse(data.playerId);
                    }
                } catch (e) {}
                // If a 'call' like message appears (server 'call' key or content mentioning '村長'/'議論'), enable command panel after 1s
                try {
                    const isCallKey = data.key === 'call' || data.key === 'order_all_hearing' || data.key === 'call';
                    const isCallText = (typeof data.content === 'string') && /議論|村長|今日はどう|どういたします|皆の怪しい|怪しいと思う人/.test(data.content);
                    if (!askSuspiciousAwait && (isCallKey || isCallText) && commandPanel && commandPanel.classList.contains('none-active')) {
                        setTimeout(() => {
                            try { setCommandPanelActive(true); } catch (e) {}
                        }, 1000);
                    }
                } catch (e) {}
                // announce (占った〇〇) を検出して lastAnnounce に記録
                try {
                    const speakerId = data.playerId;
                    const day = data.day || currentDay || 1;
                    const announceRegex = /占っ|占った|占いました|占ったのは|占ったぜ|占ったわ/;
                    if (announceRegex.test(String(data.content)) && speakerId) {
                        let targetName = null;
                        for (const p of players.values()) {
                            const namesToCheck = [];
                            if (p.name) namesToCheck.push(p.name);
                            if (p.name) namesToCheck.push(`${p.name}さん`);
                            if (p.isUser) namesToCheck.push('あなた');
                            let matched = false;
                            for (const disp of namesToCheck) {
                                if (String(data.content).includes(disp)) {
                                    targetName = p.name;
                                    matched = true;
                                    break;
                                }
                            }
                            if (matched) break;
                        }
                        if (targetName) {
                            const existing = lastAnnounce.get(speakerId) || {};
                            existing[day] = targetName;
                            lastAnnounce.set(speakerId, existing);
                            // Also update resultsMap entry for this speaker/day so UI reflects announced target
                            try {
                                if (!resultsMap.has(speakerId)) resultsMap.set(speakerId, {});
                                const recs = resultsMap.get(speakerId) || {};
                                const entry = recs[day] || {};
                                entry.targetName = targetName;
                                recs[day] = entry;
                                resultsMap.set(speakerId, recs);
                                renderResultsTable();
                            } catch (e) {}
                        }
                    }
                } catch (e) {}
                // 結果系の発言が来たら結果表を更新
                try {
                    const key = data.key || '';
                    if (key && (key.startsWith('seer_result') || key.startsWith('medium_result'))) {
                        // detect result color
                        let res = null;
                        if (key.endsWith('_white') || (typeof data.content === 'string' && data.content.includes('白'))) res = 'white';
                        if (key.endsWith('_black') || (typeof data.content === 'string' && data.content.includes('黒'))) res = 'black';
                        // find mentioned player name (prefer direct mention, fallback to last announce)
                        let targetName = null;
                        try {
                            for (const p of players.values()) {
                                const namesToCheck = [];
                                if (p.name) namesToCheck.push(p.name);
                                if (p.name) namesToCheck.push(`${p.name}さん`);
                                if (p.isUser) namesToCheck.push('あなた');
                                let matched = false;
                                for (const disp of namesToCheck) {
                                    if (String(data.content).includes(disp)) {
                                        targetName = p.name;
                                        matched = true;
                                        break;
                                    }
                                }
                                if (matched) break;
                            }
                        } catch (e) {}
                        if (!targetName) {
                            try {
                                const speakerId = data.playerId;
                                const day = data.day || currentDay || 1;
                                const existing = lastAnnounce.get(speakerId) || {};
                                if (existing[day]) targetName = existing[day];
                            } catch (e) {}
                        }
                        if (!targetName) targetName = '（不明）';
                        // record into resultsMap under this speaker (player.id)
                        try {
                            const speakerId = data.playerId;
                            if (!resultsMap.has(speakerId)) resultsMap.set(speakerId, {});
                            const rec = resultsMap.get(speakerId) || {};
                            const day = data.day || currentDay || 1;
                            rec[day] = { targetName, result: res };
                            resultsMap.set(speakerId, rec);
                            renderResultsTable();
                        } catch (e) {}
                    }
                } catch (e) {}
            } else {
                // If the server emits a user/mayor statement without an explicit UserPlayer in players[],
                // render it as a user bubble based on key/name/playerId.
                const isUserStatement = (typeof userId === 'number' && typeof data.playerId === 'number' && data.playerId === userId)
                    || data.playerName === 'あなた';
                const isMayorOrder = (typeof data.key === 'string' && data.key.startsWith('order_'));
                if (isUserStatement || isMayorOrder) {
                    const pseudoUser = {
                        id: (typeof data.playerId === 'number' ? data.playerId : -1),
                        name: 'あなた',
                        icon: userIcon || '👤',
                        isAlive: true,
                        isUser: true
                    };
                    addChatMessage(pseudoUser, data.content);
                } else {
                    // fallback to system log
                    addSystemLog(`${data.playerName}: ${data.content}`);
                }
            }
        } catch (e) {
            console.error('statement event parse error', e);
        }
    });

    // ユーザー役職割り当て
    eventSource.addEventListener('user_role_assignment', (event) => {
        const data = JSON.parse(event.data);
        userId = data.playerId;
        userRole = data.role;
        if (data.playerName) userName = data.playerName;
        if (data.icon) userIcon = data.icon;
        updateUserHeader();
        players.set(data.playerId, {
            id: data.playerId,
            name: userName,
            icon: userIcon,
            role: data.role,
            team: data.team,
            isAlive: true,
            isUser: true
        });
        updatePlayerList();
    });

    // 役職割り当て（AI）
    eventSource.addEventListener('role_assignment', (event) => {
        const data = JSON.parse(event.data);
        data.players.forEach(p => {
            if (p.id !== userId) {
                players.set(p.id, {
                    id: p.id,
                    name: p.name,
                    icon: p.icon || '👤',
                    role: p.role,
                    team: p.team,
                    isAlive: true,
                    isUser: false
                });
            }
        });
        updatePlayerList();
    });

    // 日の開始（サーバ通知）
    eventSource.addEventListener('day_start', (event) => {
        const data = JSON.parse(event.data);
        currentDay = data.day;
        dayInfo.textContent = `${currentDay}日目`;

        // 1日目開始後に「プレイヤー情報/占い＆霊能結果」切替ボタンを表示
        try {
            if (currentDay >= 1 && playerControls) playerControls.classList.add('is-visible');
        } catch (e) {}
        // Reset mayor counters when server advances the game day
        try {
            if (currentDay && currentDay !== lastResetDay) {
                individualQuestionCount = 0; askSuspiciousCount = 0;
                try { updateAskIndividualButtonState(); } catch (e) {}
                try { updateAskSuspiciousButtonState(); } catch (e) {}
                // Reset designations summary when day changes
                try { resetDesignationsSummary(); } catch (e) {}
                lastResetDay = currentDay;
            }
        } catch (e) {}
        // day_start はサーバのタイミングで送られるが、
        // 初日占いシーケンスは昼フェーズ開始（phase_change 'day'）側で扱うためここでは保持のみ。
        // day_start が来て現在が初日の昼ならログフィルタを表示
        try {
            if (currentDay === 1 && currentPhase === 'day') {
                if (logFilterBtn) logFilterBtn.style.display = 'inline-block';
            }
        } catch (e) {}

    });

    // フェーズ変更
    eventSource.addEventListener('phase_change', (event) => {
        console.log('Event: phase_change', event.data);
        const data = JSON.parse(event.data);
        currentPhase = data.phase;
        
        if (data.phase === 'day') {
            phaseInfo.textContent = '昼（議論）';
                if (!isSpectator) {
                    // show command panel for mayor (ユーザーは村長で発言入力は不要)
                    if (commandPanel) {
                        commandPanel.style.display = 'block';
                        // start in none-active state; will be activated by 'call' or player_operation_phase
                        setCommandPanelActive(false);
                    }
                    if (userInputArea) userInputArea.style.display = 'none';
                }
            votingArea.style.display = 'none';
            // 昼フェーズ開始時: 直前の表示（プレイヤー情報/占い&霊能結果）を維持
            applySidePanelView();

                // 初日の昼フェーズ開始時にログフィルタボタンを表示
                try {
                    if ((currentDay === 1) || daySoonAnnounced) {
                        if (logFilterBtn) logFilterBtn.style.display = 'inline-block';
                    }
                } catch (e) { console.error('logFilterBtn show error', e); }
            // （初日占いシーケンスはGMの役職説明受信側で発火するように移動しました）
        } else if (data.phase === 'night') {
            phaseInfo.textContent = '夜';
            if (userInputArea) userInputArea.style.display = 'none';
            votingArea.style.display = 'none';
            // 夜はプレイヤー情報欄を非表示（必要なら）
            // if (playerInfoSection) playerInfoSection.style.display = 'none';
        }
        // keep command panel none-active by default; explicit events (call/player_operation_phase) enable it
    });

    // タイマー更新
    eventSource.addEventListener('day_timer_update', (event) => {
        console.log('Event: day_timer_update', event.data);
        const data = JSON.parse(event.data);
        timerDisplay.textContent = data.timeRemaining;
        
        if (data.timeRemaining === 0) {
            timerDisplay.textContent = '終了';
        }
    });

    // タイマー開始
    eventSource.addEventListener('day_timer_start', (event) => {
        console.log('Event: day_timer_start', event.data);
        const data = JSON.parse(event.data);
        timerDisplay.textContent = data.timeLimit;
    });

    // 占い結果イベント（サーバが初日に送信）
    eventSource.addEventListener('divination', (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data && data.targetId) {
                const val = data.result === 'WEREWOLF' ? 'WEREWOLF' : 'HUMAN';
                divinationResults.set(data.targetId, val);
                updatePlayerList();
            }
        } catch (e) { console.error('divination event parse error', e); }
    });

    // 一時停止（UI切替）
    eventSource.addEventListener('paused', (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Event: paused', data);
        } catch {}
        isPaused = true;
        stopBtn.textContent = '再開';
    });

    // 再開（UI切替）
    eventSource.addEventListener('resumed', (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Event: resumed', data);
        } catch {}
        isPaused = false;
        stopBtn.textContent = 'ストップ';
    });

    // 投票フェーズ開始
    eventSource.addEventListener('voting_phase_start', (event) => {
        console.log('Event: voting_phase_start', event.data);
        const data = JSON.parse(event.data);
        
        // 投票UI表示
            if (!isSpectator) {
            votingArea.style.display = 'block';
            if (userInputArea) userInputArea.style.display = 'none';
            voteButtonsNew.innerHTML = '';
            
            // 生存プレイヤーのボタンを作成
            data.alivePlayers.forEach(player => {
                if (player.id !== userId) {
                    const btn = document.createElement('button');
                    btn.className = 'vote-btn';
                    btn.textContent = player.name;
                    btn.onclick = () => handleVote(player.id, player.name);
                    voteButtonsNew.appendChild(btn);
                }
            });
            
            // タイマー表示
            timerDisplay.textContent = data.timeLimit;
            phaseInfo.textContent = '投票時間';
            // disable player-operation commands during voting
            try { setCommandPanelActive(false); } catch (e) {}
        }
    });

    // Player operation phase: enable command panel for mayor operations
    eventSource.addEventListener('player_operation_phase', (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log('Event: player_operation_phase', data);
            // Keep command panel visible but disabled by default here.
            // Activation (removing none-active) should happen only after an explicit 'call' or
            // other enabling event so the period between day start and call remains inactive.
            try {
                try { setCommandPanelActive(false); } catch (e) {}
                // if client thinks it's spectator but user is actually assigned in players map, show panel
                let shouldShow = !isSpectator;
                const tryIds = [userId, Number(userId), String(userId)];
                for (const id of tryIds) {
                    try {
                        if (id == null) continue;
                        if (players.has(id)) {
                            const me = players.get(id);
                            if (me && (me.isUser || me.isUser === true)) {
                                shouldShow = true;
                                break;
                            }
                        }
                    } catch (e) {}
                }
                if (shouldShow && commandPanel) commandPanel.style.display = 'block';
            } catch (e) { console.error('player_operation_phase show error', e); }
        } catch (e) { console.error('player_operation_phase parse error', e); }
    });

    // Proceed to voting: ensure command panel is disabled
    eventSource.addEventListener('proceed_to_voting', (event) => {
        try { console.log('Event: proceed_to_voting', event.data); setCommandPanelActive(false); } catch (e) {}
    });

    // 投票タイマー更新
    eventSource.addEventListener('voting_timer_update', (event) => {
        console.log('Event: voting_timer_update', event.data);
        const data = JSON.parse(event.data);
        timerDisplay.textContent = data.timeRemaining;
        
        if (data.timeRemaining === 0) {
            timerDisplay.textContent = '集計中';
        }
    });

    // ユーザー死亡
    eventSource.addEventListener('user_death', (event) => {
        isSpectator = true;
        if (userInputArea) userInputArea.style.display = 'none';
        votingArea.style.display = 'none';
        spectatorBanner.style.display = 'flex';
        
        if (players.has(userId)) {
            const player = players.get(userId);
            player.isAlive = false;
            players.set(userId, player);
            updatePlayerList();
        }
    });

    // プレイヤーCO情報更新
    eventSource.addEventListener('player_co', (event) => {
        const data = JSON.parse(event.data);
        if (players.has(data.playerId)) {
            const player = players.get(data.playerId);
            player.claimedRole = data.claimedRole;
            players.set(data.playerId, player);
            updatePlayerList();
            // 同期: 占い/霊能COリストに追加（重複回避）
            if (data.claimedRole === 'SEER') {
                if (!seerCOs.includes(data.playerId)) seerCOs.push(data.playerId);
            } else if (data.claimedRole === 'MEDIUM') {
                if (!mediumCOs.includes(data.playerId)) mediumCOs.push(data.playerId);
            }
            renderResultsTable();
        }
    });

    // 処刑
    eventSource.addEventListener('execution', (event) => {
        const data = JSON.parse(event.data);
        if (players.has(data.playerId)) {
            const player = players.get(data.playerId);
            player.isAlive = false;
            players.set(data.playerId, player);
            updatePlayerList();
        }
    });

    // 襲撃成功
    eventSource.addEventListener('attack_success', (event) => {
        const data = JSON.parse(event.data);
        if (players.has(data.playerId)) {
            const player = players.get(data.playerId);
            player.isAlive = false;
            players.set(data.playerId, player);
            updatePlayerList();
        }
    });

    // GMメッセージ（簡易版）
    eventSource.addEventListener('gm_message', (event) => {
        const data = JSON.parse(event.data);
        const message = data.message;
        try {
            addGMMessage(message);
        } catch (e) {
            console.error('gm_message display error', e);
            addGMMessage(message);
        }
    });

    // endgame: flashy victory/defeat overlay
    eventSource.addEventListener('end_effect', (event) => {
        try {
            const data = JSON.parse(event.data);
            showEndEffectOverlay(data);
        } catch (e) {
            console.error('end_effect handler error', e);
        }
    });

    // 夜行動リクエスト
    eventSource.addEventListener('night_action_request', (event) => {
        console.log('Event: night_action_request', event.data);
        const data = JSON.parse(event.data);
        
        // 占い先選択UI表示（専用UI使用）
            if (!isSpectator) {
            try { setCommandPanelActive(false); } catch (e) {}
            votingArea.style.display = 'none';
            if (userInputArea) userInputArea.style.display = 'none';
            nightActionArea.style.display = 'block';
            nightActionButtons.innerHTML = '';
            
            // 生存プレイヤーのボタンを作成
            (data.alivePlayers || [])
                .filter(player => !(userId !== null && userId !== undefined && Number(player.id) === Number(userId)))
                .forEach(player => {
                const btn = document.createElement('button');
                btn.className = 'vote-btn';
                btn.textContent = player.name;
                btn.onclick = () => handleNightAction(player.id, player.name);
                nightActionButtons.appendChild(btn);
            });
            
            phaseInfo.textContent = '占い先を選択';
        }
    });

    // プレイヤー操作フェーズ（村長操作開始）
    eventSource.addEventListener('player_operation_phase', (event) => {
        console.log('Event: player_operation_phase', event.data);
        const data = JSON.parse(event.data);
        // show command panel: 通常は非観戦者のみ表示するが、
        // クライアントが観戦者判定になっている場合でも実際に userId が割り当てられ
        // 生存プレイヤーとして登録されていれば表示する（Day2 の同期ズレ対策）
        try {
            if (commandPanel) {
                let shouldShow = !isSpectator;
                if (!shouldShow && typeof userId !== 'undefined' && userId !== null && players && players.has && players.has(userId)) {
                    try {
                        const me = players.get(userId);
                        if (me && (me.isAlive === undefined || me.isAlive === true)) shouldShow = true;
                    } catch (e) { /* ignore */ }
                }
                if (shouldShow) commandPanel.style.display = 'block';
            }
        } catch (e) { console.error('player_operation_phase show error', e); }
        // reset per-day counters when day changes
        try {
            if (data.day && data.day !== lastResetDay) {
                individualQuestionCount = 0; askSuspiciousCount = 0;
                try { updateAskIndividualButtonState(); } catch (e) {}
                try { updateAskSuspiciousButtonState(); } catch (e) {}
                lastResetDay = data.day;
            }
        } catch(e){}
        // populate designate target list as needed when user opens that panel
    });

    // proceed_to_voting notification (hide command panel)
    eventSource.addEventListener('proceed_to_voting', (event) => {
        try { setCommandPanelActive(false); } catch (e) {}
    });

    // short voting animation: show simple "投票中…" message for user (no countdown)
    let _votingAnimationTimer = null;
    eventSource.addEventListener('voting_animation', (event) => {
        try {
            const data = JSON.parse(event.data);
            const duration = (data && typeof data.duration === 'number') ? data.duration : 1;
            if (!isSpectator) {
                try { setCommandPanelActive(false); } catch (e) {}
                votingArea.style.display = 'none';
                nightActionArea.style.display = 'none';
                if (userInputArea) userInputArea.style.display = 'none';
                phaseInfo.textContent = '投票中…';
                timerDisplay.textContent = '';
                // 追加: 投票中をシステムログに出す
                try { addSystemLog('投票中…'); } catch (e) { console.error('addSystemLog error', e); }
                // clear any existing timer and set a new one based on duration (in seconds)
                try {
                    if (_votingAnimationTimer) {
                        clearTimeout(_votingAnimationTimer);
                        _votingAnimationTimer = null;
                    }
                    _votingAnimationTimer = setTimeout(() => {
                        try { phaseInfo.textContent = ''; } catch (e) {}
                        _votingAnimationTimer = null;
                    }, Math.max(0, duration || 1) * 1000);
                } catch (e) {}
            }
        } catch (e) { console.error('voting_animation handler error', e); }
    });

    // ゲーム終了
    eventSource.addEventListener('game_end', (event) => {
        const data = JSON.parse(event.data);
        if (userInputArea) userInputArea.style.display = 'none';
        votingArea.style.display = 'none';
        nightActionArea.style.display = 'none';
        // ゲーム終了後にボタンを有効化
        startBtn.disabled = false;
        startBtn.textContent = 'ゲーム開始';
    });

    // endgame: show big restart button and reset command panel
    eventSource.addEventListener('show_play_again', (_event) => {
        try {
            showPlayAgainUI();
        } catch (e) { console.error('show_play_again handler error', e); }
    });
    
    // server-side rejection handling: show log and ensure button disabled when limit exceeded
    eventSource.addEventListener('mayor_action_rejected', (event) => {
        try {
            const data = JSON.parse(event.data);
            if (data && data.type === 'individual_question' && data.reason === 'limit_exceeded') {
                addSystemLog('サーバー: 個別質問は1日3回までです（サーバー制限）。');
                individualQuestionCount = 3;
                try { updateAskIndividualButtonState(); } catch (e) {}
            }
            if (data && data.type === 'ask_suspicious' && data.reason === 'limit_exceeded') {
                addSystemLog('サーバー: 皆の怪しい人を聞くは1日1回までです（サーバー制限）。');
                askSuspiciousCount = 1;
                try { updateAskSuspiciousButtonState(); } catch (e) {}
                // If we were awaiting responses, cancel the wait and re-enable the panel.
                try {
                    if (askSuspiciousAwait) {
                        try { if (askSuspiciousAwait.timeoutId) clearTimeout(askSuspiciousAwait.timeoutId); } catch (e2) {}
                        askSuspiciousAwait = null;
                        hideProcessingPanel(true);
                    }
                } catch (e) {}
            }
        } catch (e) { console.error('mayor_action_rejected handler error', e); }
    });

    // エラー処理
    eventSource.onerror = () => {
        console.error('SSE接続エラー');
    };
}

// (Auto-connect handled in the main load handler above)

/**
 * ログイベント処理
 */
function handleLogEvent(data) {
    const { message, type } = data;
    if (type === 'statement') {
        // structured 'statement' events are handled separately; ignore here to avoid duplicate
        return;
    }

    // シンプルに各種ログを表示（占い師専用の長いシーケンスやバッファは無効化）
    if (type === 'vote') {
        addSystemLog(message);
    } else if (type === 'execution' || type === 'attack' || type === 'guard' || type === 'divination') {
        addSystemLog(message, 'important');
    } else if (type === 'phase' || type === 'day') {
        addSystemLog(message, 'phase');
    } else if (type === 'section' || type === 'separator') {
        addSystemLog(message);
    } else {
        addSystemLog(message);
    }
}

/**
 * チャットメッセージ追加（吹き出し）
 */
function addChatMessage(player, content) {
    try {
        if (endEffectActive) {
            enqueueEndEffectLog({ kind: 'chat', player, content });
            return;
        }
    } catch (e) {}
    try { touchConversationActivity(); } catch (e) {}
    const messageDiv = document.createElement('div');
    messageDiv.className = `message ${player.isUser ? 'user' : 'ai'}`;
    // mark message with player id for filtering
    try { messageDiv.dataset.playerId = player.id; } catch (e) {}
    
    if (player.isUser) {
        // ユーザー発言（右寄せ、アイコンあり）
        messageDiv.innerHTML = `
            <div class="icon">${getIconHtml(player.icon)}</div>
            <div class="bubble">
                <div class="text">${escapeHtml(content)}</div>
            </div>
        `;
    } else {
        // AI発言（左寄せ、アイコンあり）
        messageDiv.innerHTML = `
            <div class="icon">${getIconHtml(player.icon)}</div>
            <div class="bubble">
                <div class="name">${escapeHtml(player.name)}</div>
                <div class="text">${escapeHtml(content)}</div>
            </div>
        `;
    }
    
    gameLog.appendChild(messageDiv);
    // 新規追加のメッセージは現在のフィルターに従って表示制御
    refreshChatFilter();
    // メッセージ追加後のレイアウト確認
    if (gameLog.childElementCount % 10 === 0) {
        console.log('📊 Messages:', gameLog.childElementCount, 'ScrollHeight:', gameLog.scrollHeight, 'ClientHeight:', gameLog.clientHeight);
    }
    scrollToBottom();
}

/**
 * HTMLエスケープ
 */
function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
}

/**
 * システムログ追加
 */
function addSystemLog(message, className = '') {
    try {
        if (endEffectActive) {
            enqueueEndEffectLog({ kind: 'system', message, className });
            return;
        }
    } catch (e) {}
    // コマンド操作の「吹き出しではない成功ログ」は表示しない
    try {
        const msg = String(message || '');
        if (
            msg === '皆の怪しい人を聞きました' ||
            msg === '投票しました' ||
            msg === '占い先を選択しました' ||
            /(^|:\s*)村長が.+に質問/.test(msg)
        ) {
            return;
        }
    } catch (e) {}
    try { touchConversationActivity(); } catch (e) {}
    const logDiv = document.createElement('div');
    logDiv.className = `system-message ${className}`;
    logDiv.textContent = message;
    gameLog.appendChild(logDiv);
    refreshChatFilter();
    scrollToBottom();
}

/**
 * GMメッセージ追加
 */
function addGMMessage(message) {
    try {
        if (endEffectActive) {
            enqueueEndEffectLog({ kind: 'gm', message });
            return;
        }
    } catch (e) {}
    try { touchConversationActivity(); } catch (e) {}
    const logDiv = document.createElement('div');
    logDiv.className = 'gm-message';

    // アイコン
    const img = document.createElement('img');
    img.src = '/images/gamemaster.png';
    img.alt = 'GM';
    img.className = 'gm-icon';
    logDiv.appendChild(img);

    // ラベル
    const label = document.createElement('strong');
    label.textContent = 'GM:';
    logDiv.appendChild(label);

    // メッセージ（役職発表の「〇〇です。」は〇〇部分を強調）
    const roleMatch = message.match(/^(.+?)です。$/);
    const roleNames = ['村人', '占い師', '霊能者', '狩人', '人狼', '狂人'];
    const contentSpan = document.createElement('span');

    if (roleMatch && roleNames.includes(roleMatch[1])) {
        const roleSpan = document.createElement('span');
        roleSpan.className = 'gm-role';
        roleSpan.textContent = roleMatch[1];
        // 役職名に役職別カラークラスを付与
        const gmSlug = ROLE_SLUG[roleMatch[1]] || 'villager';
        roleSpan.classList.add(`role-color-${gmSlug}`);
        contentSpan.appendChild(document.createTextNode(' '));
        contentSpan.appendChild(roleSpan);
        contentSpan.appendChild(document.createTextNode('です。'));

        // === 役職画像中央演出 ===
        if (roleShowcase) {
            // 役職名→スラグのマッピング（CSSクラスに使う）
            const ROLE_SLUG = {
                '村人': 'villager',
                '人狼': 'werewolf',
                '占い師': 'fortune',
                '霊能者': 'medium',
                '狩人': 'hunter',
                '狂人': 'madman',
            };

            roleShowcase.innerHTML = '';
            const img = document.createElement('img');
            img.src = ROLE_IMAGE_MAP[roleMatch[1]] || '';
            img.alt = roleMatch[1];
            img.className = 'role-showcase-img';
            const name = document.createElement('div');
            name.className = 'role-showcase-name';
            name.textContent = roleMatch[1];

            // 役職ごとの色クラスを付与（roleShowcaseの名前にも）
            const slug = ROLE_SLUG[roleMatch[1]] || 'villager';
            name.classList.add(`role-color-${slug}`);

            roleShowcase.appendChild(img);
            roleShowcase.appendChild(name);

            // 表示とアニメーション制御（入場アニメ→滞在→退場）
            roleShowcase.classList.remove('hidden');
            roleShowcase.style.display = 'flex';
            // トリガー用クラス
            roleShowcase.classList.remove('enter', 'exit');
            // 強制的に reflow してからクラス追加（アニメの確実な発火）
            // eslint-disable-next-line @typescript-eslint/no-unused-expressions
            roleShowcase.offsetWidth;
            roleShowcase.classList.add('enter');

            // 滞在時間の後に退場アニメ
            setTimeout(() => {
                roleShowcase.classList.remove('enter');
                roleShowcase.classList.add('exit');
                // exit アニメ後に非表示
                setTimeout(() => {
                    roleShowcase.classList.remove('exit');
                    roleShowcase.classList.add('hidden');
                    roleShowcase.style.display = 'none';
                }, 420);
            }, 3500);
        }
    } else {
        // preserve line breaks in GM messages
        const parts = message.split('\n');
        for (let i = 0; i < parts.length; i++) {
            const txt = parts[i];
            // 特別な占い師の初日文を検出して強調表示
            if (/^初日の占い結果[:：、].+(人狼ではありませんでした。|本日は占う対象がおりませんでした。)$/.test(txt.trim())) {
                const seerDiv = document.createElement('div');
                seerDiv.className = 'gm-seer-sentence';
                seerDiv.textContent = txt.trim();
                contentSpan.appendChild(document.createTextNode(' '));
                contentSpan.appendChild(seerDiv);
            } else {
                contentSpan.appendChild(document.createTextNode(' ' + txt));
            }
            if (i < parts.length - 1) contentSpan.appendChild(document.createElement('br'));
        }
    }

    logDiv.appendChild(contentSpan);
    gameLog.appendChild(logDiv);
    // GMメッセージもフィルター対象（フィルター中は非表示）
    refreshChatFilter();
    scrollToBottom();
}

/**
 * `まもなく1日目が始まります。` を表示して、クライアント側で昼フェーズUIを開始する
 * （サーバの phase_change が来る前でも即時にUIを準備するため）。
 */
function announceDaySoonAndStart(text) {
    try {
        addGMMessage(text);
    } catch (e) {
        console.error('announceDaySoonAndStart addGMMessage error', e);
    }
    daySoonAnnounced = true;
    daySoonBuffered = false;

    // クライアント側で昼フェーズのUIを開始
    try {
        currentPhase = 'day';
        phaseInfo.textContent = '昼（議論）';
        if (!isSpectator) {
            if (commandPanel) commandPanel.style.display = 'block';
            if (userInputArea) userInputArea.style.display = 'none';
        }
        votingArea.style.display = 'none';
        // 表示中のビューを維持（勝手にプレイヤー情報を開かない）
        applySidePanelView();
        // 初日の昼開始が近い（クライアント先行）場合はログフィルタを表示
        try { if (logFilterBtn) logFilterBtn.style.display = 'inline-block'; } catch (e) {}
    } catch (e) {
        console.error('announceDaySoonAndStart UI error', e);
    }
}

/**
 * プレイヤーリスト更新
 */
function updatePlayerList() {
    playerList.innerHTML = '';
    // ソート優先度を決める: 小さいほど上位表示
    function priorityOf(p) {
        if (!p.isAlive) return 9; // 死亡は最下位
        if (p.isUser) return 0; // 自分は最優先
        const claimed = p.claimedRole || null;
        switch (claimed) {
            case 'SEER': return 1; // 占い師CO
            case 'MEDIUM': return 2; // 霊能者CO
            case 'KNIGHT': return 3; // 狩人CO
            case 'VILLAGER': return 4; // 村人CO
            case null: return 5; // COなし
            case 'WEREWOLF': return 6; // 人狼CO
            case 'MADMAN': return 7; // 狂人CO
            default: return 8; // その他はその後
        }
    }

    const sorted = Array.from(players.values()).sort((a, b) => {
        const pa = priorityOf(a);
        const pb = priorityOf(b);
        if (pa !== pb) return pa - pb;
        // 同じ優先度は生存順→名前で安定化
        if (a.isAlive !== b.isAlive) return a.isAlive ? -1 : 1;
        const nameA = (a.isUser ? '自分' : a.name || '').toLowerCase();
        const nameB = (b.isUser ? '自分' : b.name || '').toLowerCase();
        if (nameA < nameB) return -1;
        if (nameA > nameB) return 1;
        return a.id - b.id;
    });

    sorted.forEach(player => {
        const itemDiv = document.createElement('div');
        itemDiv.className = `player-item ${player.isUser ? 'user' : ''} ${!player.isAlive ? 'dead' : ''}`;
        const name = player.isUser ? '自分' : player.name;
        let roleName;
        if (player.isUser) {
            roleName = getRoleNameJa(player.role);
        } else {
            roleName = player.claimedRole ? getRoleNameJa(player.claimedRole) + 'CO' : 'COなし';
        }
        const status = player.isAlive ? '生存' : '死亡';
        // 占い結果があれば表示（生存情報の右側）
        let divResultHtml = '';
        if (divinationResults.has(player.id)) {
            const r = divinationResults.get(player.id);
            const resText = r === 'WEREWOLF' ? '人狼' : '人狼ではありません';
            divResultHtml = `　｜占い: ${resText}`;
        }
        // 役職画像（自分の役職のみ表示）
        let roleImgHtml = '';
        const baseRoleForImg = getRoleNameJa(player.role);
        if (player.isUser && ROLE_IMAGE_MAP[baseRoleForImg]) {
            roleImgHtml = `<img src='${ROLE_IMAGE_MAP[baseRoleForImg]}' alt='${baseRoleForImg}' class='role-icon-img' />`;
        }
        // 役職名に色クラスを付与（GMの発表色と一致させる）
        let roleNameHtml = roleName;
        // 決定元の役職日本語名（色決定用）
        let baseRoleNameForColor = null;
        if (player.isUser) {
            baseRoleNameForColor = getRoleNameJa(player.role);
        } else if (player.claimedRole) {
            baseRoleNameForColor = getRoleNameJa(player.claimedRole);
        }
        if (baseRoleNameForColor) {
            const slug = ROLE_SLUG[baseRoleNameForColor] || 'villager';
            roleNameHtml = `<span class="player-role-name role-color-${slug}">${roleName}</span>`;
        }
        itemDiv.innerHTML = `${name}：${roleImgHtml} ${roleNameHtml}　${status}${divResultHtml}`;
        playerList.appendChild(itemDiv);
    });
    // フィルターパネルを更新（プレイヤー一覧の変化に追従）
    try { renderFilterPanel(); } catch (e) {}
    try { renderResultsTable(); } catch (e) {}
}

// --- ログフィルター関連 ---
function renderFilterPanel() {
    if (!filterPanel) return;
    filterPanel.innerHTML = '';
    const list = Array.from(players.values());
    if (list.length === 0) {
        filterPanel.innerHTML = '<div class="filter-item">プレイヤーなし</div>';
        return;
    }
    list.forEach(p => {
        const div = document.createElement('div');
        div.className = 'filter-item';
        div.textContent = p.isUser ? '自分' : p.name || `プレイヤー${p.id}`;
        // allow filtering self as well
        div.onclick = () => { applyChatFilter(p.id); filterPanel.style.display = 'none'; };
        filterPanel.appendChild(div);
    });
}

function applyChatFilter(playerId) {
    try {
        // 記録: このフィルター適用時のスクロール位置を保持
        if (gameLog && typeof gameLog.scrollTop === 'number') lastFilterScroll.set(playerId, gameLog.scrollTop);
        lastAppliedFilterId = playerId;
    } catch (e) {}
    currentChatFilter = playerId;
    const p = players.get(playerId);
    if (clearFilterBtn) clearFilterBtn.style.display = 'inline-block';
    refreshChatFilter();
}

function clearChatFilter() {
    // フィルター解除時、直近で適用したフィルターのスクロール位置を復元
    const prev = lastAppliedFilterId;
    currentChatFilter = null;
    if (clearFilterBtn) clearFilterBtn.style.display = 'none';
    refreshChatFilter();
    try {
        if (prev && lastFilterScroll.has(prev) && gameLog) {
            gameLog.scrollTop = lastFilterScroll.get(prev);
        }
    } catch (e) {}
    lastAppliedFilterId = null;
}

function toggleFilterPanel() {
    if (!filterPanel) return;
    filterPanel.style.display = (filterPanel.style.display === 'none' || !filterPanel.style.display) ? 'block' : 'none';
}

function refreshChatFilter() {
    if (!gameLog) return;
    const children = Array.from(gameLog.children);
    if (!currentChatFilter) {
        children.forEach(c => c.style.display = '');
        return;
    }
    children.forEach(c => {
        const pid = c.dataset ? c.dataset.playerId : undefined;
        if (pid && String(pid) === String(currentChatFilter)) {
            c.style.display = '';
        } else {
            c.style.display = 'none';
        }
    });
}

/**
 * レンダー: 占い & 霊能 結果テーブル
 */
function renderResultsTable() {
    if (!resultsContainer) return;
    // Build combined row order: preserve CO order (seer then medium), avoid duplicates
    const rows = [];
    for (const id of seerCOs) if (!rows.includes(id)) rows.push(id);
    for (const id of mediumCOs) if (!rows.includes(id)) rows.push(id);
    if (rows.length === 0) {
        resultsContainer.innerHTML = '<div class="empty-state">占い師CO・霊能者COがいません</div>';
        return;
    }
    const maxDay = Math.max(1, currentDay || 1);
    let html = '<table class="results-table"><thead><tr><th>役職CO</th>';
    for (let d = 1; d <= maxDay; d++) html += `<th>${d}日目</th>`;
    html += '</tr></thead><tbody>';
    for (const pid of rows) {
        const p = players.get(pid) || { name: `Player${pid}`, claimedRole: null };
        const role = (p.claimedRole === 'SEER') ? 'SEER' : (p.claimedRole === 'MEDIUM' ? 'MEDIUM' : null);
        const nameClass = role === 'SEER' ? 'role-color-fortune' : (role === 'MEDIUM' ? 'role-color-medium' : '');
        html += `<tr><td class="results-player-name"><span class="${nameClass}">${p.isUser ? 'あなた' : (p.name || ('Player'+pid))}</span></td>`;
        const rec = resultsMap.get(pid) || {};
        for (let d = 1; d <= maxDay; d++) {
            const cell = rec[d];
            if (!cell) {
                html += '<td></td>';
            } else {
                // Force Day1 seer CO display to white (fixes UI bug where Day1 showed black)
                let cellResult = cell.result;
                if (role === 'SEER' && d === 1) {
                    cellResult = 'white';
                }
                const cls = cellResult === 'black' ? 'result-black' : (cellResult === 'white' ? 'result-white' : '');
                const label = cellResult === 'black' ? '黒' : (cellResult === 'white' ? '白' : '');
                html += `<td><span class="${cls}">${cell.targetName || '（不明）'} ${label}</span></td>`;
            }
        }
        html += '</tr>';
    }
    html += '</tbody></table>';
    resultsContainer.innerHTML = html;
}

// ビュー切替ボタン
if (btnShowPlayers) btnShowPlayers.addEventListener('click', () => {
    setSidePanelView('players');
});
if (btnShowResults) btnShowResults.addEventListener('click', () => {
    setSidePanelView('results');
});

if (btnResultsBack) btnResultsBack.addEventListener('click', () => {
    setSidePanelView('players');
});

// イベントバインド
if (logFilterBtn) logFilterBtn.addEventListener('click', () => { try { renderFilterPanel(); toggleFilterPanel(); } catch (e) {} });
if (clearFilterBtn) clearFilterBtn.addEventListener('click', clearChatFilter);


/**
 * 投票パネル表示
 */
function showVotingPanel() {
    votingArea.style.display = 'block';
    voteButtonsNew.innerHTML = '';
    
    Array.from(players.values()).forEach(player => {
        if (player.id !== userId && player.isAlive) {
            const btn = document.createElement('button');
            btn.className = 'vote-btn';
            btn.textContent = player.name;
            btn.onclick = () => handleVote(player.id, player.name);
            voteButtonsNew.appendChild(btn);
        }
    });
}

/**
 * 役職名取得
 */
function getRoleNameJa(role) {
    const roleNames = {
        'VILLAGER': '村人',
        'WEREWOLF': '人狼',
        'SEER': '占い師',
            'MEDIUM': '霊能者',
            'KNIGHT': '狩人',
        'MADMAN': '狂人'
    };
    return roleNames[role] || role;
}

// Cache bust: 639019676685025995

function openUserEditDialog() {
    // prevent duplicates
    try {
        const existing = document.querySelector('.user-edit-dialog');
        if (existing) return;
    } catch (e) {}

    const dialog = document.createElement('div');
    dialog.className = 'user-edit-dialog';
    dialog.innerHTML = `
        <div class="user-edit-content">
            <label>名前: <input type="text" id="editUserName" value="${escapeHtml(userName)}" maxlength="12" /></label><br>
            <label>アイコン: <br></label>
            <div class="user-edit-icon-row">
                <div class="user-edit-icon-item">
                    <span class="user-icon-label">男</span>
                    <label class="user-edit-icon-option">
                        <input type="radio" name="editUserIcon" value="/images/userIcon_boy.png" ${userIcon==='/images/userIcon_boy.png'?'checked':''}/>
                        <img src="/images/userIcon_boy.png" class="player-icon-img">
                    </label>
                </div>
                <div class="user-edit-icon-item">
                    <span class="user-icon-label">女</span>
                    <label class="user-edit-icon-option">
                        <input type="radio" name="editUserIcon" value="/images/userIcon_girl.png" ${userIcon==='/images/userIcon_girl.png'?'checked':''}/>
                        <img src="/images/userIcon_girl.png" class="player-icon-img">
                    </label>
                </div>
            </div>
            <button id="saveUserEdit" class="btn btn-blue">保存</button>
            <button id="cancelUserEdit" class="btn btn-gray">キャンセル</button>
        </div>
    `;
    document.body.appendChild(dialog);

    try {
        const input = dialog.querySelector('#editUserName');
        if (input && input.focus) input.focus();
    } catch (e) {}

    const saveBtn = dialog.querySelector('#saveUserEdit');
    const cancelBtn = dialog.querySelector('#cancelUserEdit');

    if (saveBtn) saveBtn.onclick = () => {
        const newName = (dialog.querySelector('#editUserName')?.value || '').trim() || 'あなた';
        const newIcon = dialog.querySelector('input[name="editUserIcon"]:checked')?.value || '/images/userIcon_boy.png';
        userName = newName;
        userIcon = newIcon;
        try { localStorage.setItem('userName', userName); } catch (e) {}
        try { localStorage.setItem('userIcon', userIcon); } catch (e) {}
        try { updateUserHeader(); } catch (e) {}
        try {
            if (players && players.has && players.has(userId)) {
                const player = players.get(userId);
                player.name = userName;
                player.icon = userIcon;
                players.set(userId, player);
                updatePlayerList();
            }
        } catch (e) {}
        dialog.remove();
    };

    if (cancelBtn) cancelBtn.onclick = () => dialog.remove();

    // close on Escape
    const onKeyDown = (e) => {
        try {
            if (e.key === 'Escape') dialog.remove();
        } catch (_e) {}
    };
    document.addEventListener('keydown', onKeyDown, { once: true });
}

// Allow HTML onclick fallback to open settings modal.
try { window.__openSettingsModal = openUserEditDialog; } catch (e) {}

// ユーザー名・アイコン編集ダイアログ
if (userHeaderInfo) {
    userHeaderInfo.setAttribute('title', 'クリックしてプロフィールを編集');

    userHeaderInfo.addEventListener('keydown', (e) => {
        if ((e.key === 'Enter' || e.key === ' ') && userHeaderInfo.dataset.editable === 'true') {
            e.preventDefault();
            userHeaderInfo.click();
        }
    });

    userHeaderInfo.addEventListener('click', () => {
        if (userHeaderInfo.dataset.editable === 'false') return; // ゲーム中は編集不可
        openUserEditDialog();
    });
}
