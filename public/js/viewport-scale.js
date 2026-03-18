const VIEWPORT_WIDTH_THRESHOLD = 640;
const VIEWPORT_HEIGHT_THRESHOLD = 1180;
const HEIGHT_SCALING_MAX_WIDTH = 900;
const MIN_VIEWPORT_SCALE = 0.5;
const VIEWPORT_WIDTH_CHANGE_EPSILON = 1;

let cachedViewportSize = null;

function getRawViewportSize() {
    const layoutViewport = document.documentElement;

    return {
        width: layoutViewport?.clientWidth || window.innerWidth,
        height: layoutViewport?.clientHeight || window.innerHeight,
    };
}

function getStableViewportSize(forceRefresh = false) {
    if (!cachedViewportSize || forceRefresh) {
        cachedViewportSize = getRawViewportSize();
    }

    return cachedViewportSize;
}

export function refreshViewportMetricsIfNeeded(options = {}) {
    const { forceRefresh = false } = options;
    const nextViewportSize = getRawViewportSize();

    if (!cachedViewportSize || forceRefresh) {
        cachedViewportSize = nextViewportSize;
        return true;
    }

    const widthChanged = Math.abs(nextViewportSize.width - cachedViewportSize.width) > VIEWPORT_WIDTH_CHANGE_EPSILON;

    if (widthChanged) {
        cachedViewportSize = nextViewportSize;
        return true;
    }

    return false;
}

export function getViewportMetrics(options = {}) {
    const { forceRefresh = false } = options;
    const { width, height } = getStableViewportSize(forceRefresh);
    const shouldScaleForWidth = width < VIEWPORT_WIDTH_THRESHOLD;
    const shouldScaleForHeight = width < HEIGHT_SCALING_MAX_WIDTH && height < VIEWPORT_HEIGHT_THRESHOLD;
    const shouldScale = shouldScaleForWidth || shouldScaleForHeight;
    const scale = shouldScale
        ? Math.max(
            MIN_VIEWPORT_SCALE,
            Math.min(width / VIEWPORT_WIDTH_THRESHOLD, height / VIEWPORT_HEIGHT_THRESHOLD, 1)
        )
        : 1;

    return {
        scale,
        width,
        height,
        logicalWidth: width / scale,
        logicalHeight: height / scale,
    };
}

export function toLogicalPoint(clientX, clientY) {
    const { scale } = getViewportMetrics();

    return {
        x: clientX / scale,
        y: clientY / scale,
    };
}

export function setupViewportScale(rootElement = document.getElementById('viewportScaleRoot')) {
    if (!rootElement) {
        return () => {};
    }

    const applyViewportScale = (forceRefresh = false) => {
        const { scale, logicalWidth, logicalHeight } = getViewportMetrics({ forceRefresh });

        rootElement.style.setProperty('--viewport-scale', String(scale));
        rootElement.style.setProperty('--viewport-logical-width', `${logicalWidth}px`);
        rootElement.style.setProperty('--viewport-logical-height', `${logicalHeight}px`);
    };

    applyViewportScale(true);
    window.addEventListener('orientationchange', () => {
        window.setTimeout(() => {
            if (refreshViewportMetricsIfNeeded({ forceRefresh: true })) {
                applyViewportScale();
            }
        }, 150);
    });

    return applyViewportScale;
}
