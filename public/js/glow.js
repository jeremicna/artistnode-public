import { getViewportMetrics, refreshViewportMetricsIfNeeded, toLogicalPoint } from './viewport-scale.js';

const glowElements = {
    page: document.getElementById('glow-bg'),
    overlay: document.getElementById('overlay-glow-bg'),
};

const viewportMetrics = getViewportMetrics();
const cursorPosition = {
    x: viewportMetrics.logicalWidth / 2,
    y: viewportMetrics.logicalHeight / 2,
};

const pageGlow = {
    element: glowElements.page,
    x: cursorPosition.x,
    y: cursorPosition.y,
    easing: 0.12,
};

const overlayGlow = {
    element: glowElements.overlay,
    x: cursorPosition.x,
    y: cursorPosition.y,
    easing: 0.08,
};

function recenterGlow(options = {}) {
    const viewportChanged = refreshViewportMetricsIfNeeded(options);

    if (!viewportChanged) {
        return;
    }

    const viewportMetrics = getViewportMetrics();

    cursorPosition.x = viewportMetrics.logicalWidth / 2;
    cursorPosition.y = viewportMetrics.logicalHeight / 2;
}

function updateCursorPosition(event) {
    const logicalPoint = toLogicalPoint(event.clientX, event.clientY);

    cursorPosition.x = logicalPoint.x;
    cursorPosition.y = logicalPoint.y;
}

function moveGlowTowardCursor(glow) {
    glow.x += (cursorPosition.x - glow.x) * glow.easing;
    glow.y += (cursorPosition.y - glow.y) * glow.easing;
}

function renderGlow(glow) {
    if (!glow.element) {
        return;
    }

    glow.element.style.background = `radial-gradient(800px at ${glow.x}px ${glow.y}px, rgba(29,78,216,0.15), transparent 80%)`;
}

function animateGlow() {
    moveGlowTowardCursor(pageGlow);
    moveGlowTowardCursor(overlayGlow);

    renderGlow(pageGlow);
    renderGlow(overlayGlow);

    requestAnimationFrame(animateGlow);
}

document.addEventListener('mousemove', updateCursorPosition);
window.addEventListener('orientationchange', () => {
    window.setTimeout(() => recenterGlow({ forceRefresh: true }), 150);
});

animateGlow();
