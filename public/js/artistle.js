import { ArtistNetworkGraph, displayArtistResults } from './graph.js';
import { setupViewportScale } from './viewport-scale.js';

const DEFAULT_MAX_GUESSES = 6;
const DEFAULT_MAX_DEPTH = 8;
const SEARCH_DEBOUNCE_MS = 250;
const SEARCH_RESULT_ITEM_CLASS = 'px-[14px] py-[10px] text-[0.9rem] text-neutral-300/85 cursor-pointer transition-colors hover:bg-neutral-400/15 hover:text-slate-50';

const STATUS_BASE_CLASS = 'text-neutral-300/85';
const STATUS_SUCCESS_CLASS = 'text-emerald-300';
const STATUS_ERROR_CLASS = 'text-rose-300';
const TILE_BASE_CLASS = 'w-6 h-6 max-[640px]:w-5 max-[640px]:h-5 border-2 rounded bg-neutral-900/85 text-slate-50 text-[0.75rem] font-bold flex items-center justify-center';

const FEEDBACK_TONE_CLASS_MAP = {
    closer: 'bg-[#6aaa64] border-[#6aaa64]',
    steady: 'bg-[#c9b458] border-[#c9b458]',
    farther: 'bg-[#787c7e] border-[#787c7e]',
    unknown: 'border-neutral-400/45 text-neutral-300',
    empty: 'border-neutral-400/45',
};

const state = createInitialState();

function createInitialState() {
    return {
        rootId: null,
        rootName: null,
        rootGenre: null,
        targetId: null,
        targetName: null,
        targetGenre: null,
        maxGuesses: DEFAULT_MAX_GUESSES,
        maxDepth: DEFAULT_MAX_DEPTH,
        guesses: [],
        guessedIds: new Set(),
        progressHistory: [],
        currentDistance: null,
        winningPath: null,
        active: false,
        finished: false,
    };
}

function getPageElements() {
    return {
        container: document.getElementById('container'),
        overlay: document.getElementById('overlay'),
        winOverlay: document.getElementById('winOverlay'),
        winMessage: document.getElementById('winMessage'),
        winPathSummary: document.getElementById('winPathSummary'),
        winPathSummaryText: document.getElementById('winPathSummaryText'),
        winOverlayButton: document.getElementById('winOverlayButton'),
        searchInput: document.getElementById('searchInput'),
        searchResults: document.getElementById('searchResults'),
        board: document.getElementById('board'),
        status: document.getElementById('status'),
        targetName: document.getElementById('targetName'),
        targetGenre: document.getElementById('targetGenre'),
        rootName: document.getElementById('rootName'),
        rootGenre: document.getElementById('rootGenre'),
        guessesRemaining: document.getElementById('guessesRemaining'),
        puzzleDate: document.getElementById('puzzleDate'),
    };
}

function revealContainer(container) {
    if (!container) {
        return;
    }

    container.classList.remove('opacity-0', 'translate-y-8');
}

function resetGameState() {
    Object.assign(state, createInitialState());
}

function setStatus(statusElement, message, tone) {
    if (!statusElement) {
        return;
    }

    statusElement.textContent = message || '';
    statusElement.classList.remove(STATUS_BASE_CLASS, STATUS_SUCCESS_CLASS, STATUS_ERROR_CLASS);

    if (tone === 'success') {
        statusElement.classList.add(STATUS_SUCCESS_CLASS);
        return;
    }

    if (tone === 'error') {
        statusElement.classList.add(STATUS_ERROR_CLASS);
        return;
    }

    statusElement.classList.add(STATUS_BASE_CLASS);
}

function hideWinOverlay(winOverlay) {
    if (!winOverlay) {
        return;
    }

    winOverlay.classList.add('hidden');
    winOverlay.classList.remove('flex');
}

function setWinPathSummary(winPathSummary, winPathSummaryText, path) {
    if (!winPathSummary || !winPathSummaryText) {
        return;
    }

    if (!Array.isArray(path) || path.length === 0) {
        winPathSummary.classList.add('hidden');
        winPathSummaryText.textContent = '';
        return;
    }

    winPathSummaryText.textContent = path.map((node) => node.name).join(' -> ');
    winPathSummary.classList.remove('hidden');
}

function showWinOverlay(elements, message, path) {
    const { winOverlay, winMessage, winPathSummary, winPathSummaryText } = elements;

    if (!winOverlay || !winMessage) {
        return;
    }

    winMessage.textContent = message;
    setWinPathSummary(winPathSummary, winPathSummaryText, path);
    winOverlay.classList.remove('hidden');
    winOverlay.classList.add('flex');
}

function updateRemainingGuesses(remainingElement) {
    if (!remainingElement) {
        return;
    }

    const remaining = state.maxGuesses - state.guesses.length;
    remainingElement.textContent = `${remaining} expansions left`;
}

function setGenreText(genreElement, genre, fallbackText = 'Genre: ---') {
    if (!genreElement) {
        return;
    }

    genreElement.textContent = genre ? `Genre: ${genre}` : fallbackText;
}

function clearTiles(boardElement) {
    if (!boardElement) {
        return;
    }

    boardElement.innerHTML = '';
}

function createTile(tone, options = {}) {
    const { isLoading = false } = options;
    const tile = document.createElement('div');
    const loadingClass = isLoading ? ' animate-pulse' : '';

    tile.className = `${TILE_BASE_CLASS} ${FEEDBACK_TONE_CLASS_MAP[tone]}${loadingClass}`;

    if (tone === 'unknown') {
        tile.textContent = '?';
    }

    return tile;
}

function setBoardTitle(boardElement, result = {}) {
    if (!boardElement) {
        return;
    }

    if (result.tone) {
        boardElement.title = formatProgressMessage(result.tone, result.distance, result.maxDepth);
        return;
    }

    boardElement.title = 'Expansion progress';
}

function renderTiles(boardElement, progressHistory, maxGuesses, result = {}) {
    clearTiles(boardElement);

    for (let index = 0; index < maxGuesses; index += 1) {
        const tone = progressHistory[index] || 'empty';
        boardElement.appendChild(createTile(tone));
    }

    setBoardTitle(boardElement, result);
}

function renderLoadingTiles(boardElement, progressHistory, maxGuesses) {
    clearTiles(boardElement);

    for (let index = 0; index < maxGuesses; index += 1) {
        const tone = progressHistory[index] || 'empty';
        const isLoading = index === progressHistory.length;

        boardElement.appendChild(createTile(tone, { isLoading }));
    }

    setBoardTitle(boardElement);
}

function isKnownDistance(distance) {
    return distance !== null && distance !== undefined;
}

function getFeedbackTone(previousDistance, nextDistance) {
    if (!isKnownDistance(previousDistance) && !isKnownDistance(nextDistance)) {
        return 'steady';
    }

    if (!isKnownDistance(previousDistance) && isKnownDistance(nextDistance)) {
        return 'closer';
    }

    if (isKnownDistance(previousDistance) && !isKnownDistance(nextDistance)) {
        return 'farther';
    }

    if (nextDistance < previousDistance) {
        return 'closer';
    }

    if (nextDistance > previousDistance) {
        return 'farther';
    }

    return 'steady';
}

function formatDistanceMessage(distance, maxDepth) {
    if (!isKnownDistance(distance)) {
        return `More than ${maxDepth} links away.`;
    }

    if (distance === 0) {
        return 'Target reached.';
    }

    return `${distance} ${distance === 1 ? 'link' : 'links'} away.`;
}

function formatProgressMessage(tone, distance, maxDepth) {
    if (tone === 'unknown') {
        return 'Distance unavailable for this expansion.';
    }

    const prefix = tone === 'closer'
        ? 'Closer.'
        : tone === 'farther'
            ? 'Farther.'
            : 'No change.';

    return `${prefix} ${formatDistanceMessage(distance, maxDepth)}`;
}

async function fetchJson(url, errorLabel) {
    const response = await fetch(url);

    if (!response.ok) {
        throw new Error(`${errorLabel} failed with status ${response.status}`);
    }

    return await response.json();
}

function fetchTarget(rootId) {
    return fetchJson(`/api/artistle/target?root=${encodeURIComponent(rootId)}`, 'Target fetch');
}

function fetchDistance(fromId, toId) {
    return fetchJson(
        `/api/artistle/distance?from=${encodeURIComponent(fromId)}&to=${encodeURIComponent(toId)}`,
        'Distance fetch'
    );
}

function prepareNewGame(entry, elements) {
    resetGameState();

    hideWinOverlay(elements.winOverlay);
    setWinPathSummary(elements.winPathSummary, elements.winPathSummaryText, null);

    state.rootId = entry.id;
    state.rootName = entry.name;

    elements.rootName.textContent = entry.name;
    setGenreText(elements.rootGenre, null, 'Genre hint loading...');
    elements.targetName.textContent = '...';
    setGenreText(elements.targetGenre, null, 'Genre hint loading...');
    elements.puzzleDate.textContent = 'Loading puzzle...';
    renderTiles(elements.board, state.progressHistory, state.maxGuesses);

    elements.overlay.classList.add('hidden');
    history.pushState({}, '', '/artistle');
}

function applyTargetDetails(target, elements) {
    state.rootGenre = target.rootGenre || null;
    state.targetId = target.targetId;
    state.targetGenre = target.targetGenre || null;
    state.targetName = target.targetName;
    state.maxGuesses = target.maxGuesses || DEFAULT_MAX_GUESSES;
    state.maxDepth = target.maxDepth || DEFAULT_MAX_DEPTH;
    state.currentDistance = null;
    state.active = true;

    setGenreText(elements.rootGenre, state.rootGenre);
    elements.targetName.textContent = target.targetName;
    setGenreText(elements.targetGenre, state.targetGenre);
    elements.puzzleDate.textContent = `Puzzle for ${target.date}`;
    updateRemainingGuesses(elements.guessesRemaining);
    renderTiles(elements.board, state.progressHistory, state.maxGuesses);
}

async function loadStartingDistance(rootId) {
    const baselineResult = await fetchDistance(rootId, state.targetId);
    state.currentDistance = baselineResult.distance;
    state.maxDepth = baselineResult.maxDepth || state.maxDepth;
}

function getImmediateWinMessage(entry) {
    if (entry.id === state.targetId) {
        return `You started on ${state.targetName}, so this puzzle is already solved.`;
    }

    return `${state.targetName} is already visible from ${entry.name}, so this start solves the puzzle immediately.`;
}

function showImmediateWin(entry, graph, elements) {
    state.active = false;
    state.finished = true;
    state.winningPath = graph.getShortestPath(state.rootId, state.targetId);

    const message = getImmediateWinMessage(entry);

    showWinOverlay(elements, message, state.winningPath);
    setStatus(elements.status, message, 'success');
    graph.setInteractionLocked(true);
}

function finishOutOfGuesses(graph, statusElement) {
    state.finished = true;
    setStatus(statusElement, `Out of expansions. The target was ${state.targetName}.`, 'error');
    graph.setInteractionLocked(true);
}

function finishSolvedGuess(graph, elements) {
    state.finished = true;
    state.winningPath = graph.getShortestPath(state.rootId, state.targetId);

    showWinOverlay(
        elements,
        `Great Job! You reached ${state.targetName} in ${state.guesses.length} ${state.guesses.length === 1 ? 'expansion' : 'expansions'}.`,
        state.winningPath
    );
    setStatus(elements.status, `You reached ${state.targetName} in ${state.guesses.length} expansions.`, 'success');
    graph.setInteractionLocked(true);
}

function recordGuess(node, remainingElement) {
    state.guessedIds.add(node.id);
    state.guesses.push(node.id);
    updateRemainingGuesses(remainingElement);
}

function showGuessLoadingState(elements, graph) {
    renderLoadingTiles(elements.board, state.progressHistory, state.maxGuesses);
    setStatus(elements.status, 'Checking link distance...', null);
    graph.setInteractionLocked(true);
}

function showDistanceError(boardElement, graph, statusElement) {
    state.progressHistory.push('unknown');
    renderTiles(boardElement, state.progressHistory, state.maxGuesses, {
        tone: 'unknown',
        distance: null,
        maxDepth: state.maxDepth,
    });
    setStatus(statusElement, 'Unable to compute distance right now.', 'error');
    graph.setInteractionLocked(false);
}

function canHandleGuess(node, graph, statusElement) {
    if (!state.active || state.finished) {
        return false;
    }

    if (state.guessedIds.has(node.id)) {
        return false;
    }

    if (state.guesses.length >= state.maxGuesses) {
        finishOutOfGuesses(graph, statusElement);
        return false;
    }

    return true;
}

async function startGame({ entry, graph, elements }) {
    prepareNewGame(entry, elements);

    graph.setInteractionLocked(true);
    setStatus(elements.status, 'Selecting a target artist...', null);

    try {
        const [, target] = await Promise.all([
            graph.init(entry.id, { autoExpandRoot: true }),
            fetchTarget(entry.id),
        ]);

        applyTargetDetails(target, elements);

        try {
            await loadStartingDistance(entry.id);
        } catch (error) {
            console.error('Unable to measure starting distance:', error);
        }

        if (graph.nodeMap.has(state.targetId)) {
            showImmediateWin(entry, graph, elements);
            return;
        }

        setStatus(
            elements.status,
            'Click a node to expand the graph and watch the progress tiles fill from left to right.',
            null
        );
        graph.setInteractionLocked(false);
    } catch (error) {
        console.error(error);
        setStatus(elements.status, 'Unable to load a target. Try again.', 'error');
        graph.setInteractionLocked(true);
    }
}

async function handleGuess({ node, graph, elements }) {
    if (!canHandleGuess(node, graph, elements.status)) {
        return;
    }

    recordGuess(node, elements.guessesRemaining);
    showGuessLoadingState(elements, graph);

    try {
        const previousDistance = state.currentDistance;
        const distanceResult = await fetchDistance(node.id, state.targetId);
        const distance = distanceResult.distance;
        const tone = getFeedbackTone(previousDistance, distance);

        state.maxDepth = distanceResult.maxDepth || state.maxDepth;
        state.currentDistance = distance;
        state.progressHistory.push(tone);

        renderTiles(elements.board, state.progressHistory, state.maxGuesses, {
            tone,
            distance,
            maxDepth: state.maxDepth,
        });

        if (graph.nodeMap.has(state.targetId)) {
            finishSolvedGuess(graph, elements);
            return;
        }

        if (state.guesses.length >= state.maxGuesses) {
            finishOutOfGuesses(graph, elements.status);
            return;
        }

        setStatus(elements.status, formatProgressMessage(tone, distance, state.maxDepth), null);
        graph.setInteractionLocked(false);
    } catch (error) {
        console.error(error);
        showDistanceError(elements.board, graph, elements.status);
    }
}

function setupSearch({ input, resultsContainer, onSelect }) {
    if (!input || !resultsContainer) {
        return;
    }

    let debounceTimer;

    input.addEventListener('input', (event) => {
        const query = event.target.value.trim();

        clearTimeout(debounceTimer);

        if (!query) {
            resultsContainer.classList.add('hidden');
            return;
        }

        debounceTimer = setTimeout(() => {
            displayArtistResults({
                query,
                limit: 5,
                inputEl: input,
                resultsEl: resultsContainer,
                itemClassName: SEARCH_RESULT_ITEM_CLASS,
                onSelect,
            });
        }, SEARCH_DEBOUNCE_MS);
    });

    document.addEventListener('click', (event) => {
        if (!resultsContainer.contains(event.target) && event.target !== input) {
            resultsContainer.classList.add('hidden');
        }
    });
}

function setupWinOverlayButton(elements) {
    if (!elements.winOverlayButton) {
        return;
    }

    elements.winOverlayButton.addEventListener('click', () => {
        hideWinOverlay(elements.winOverlay);
        elements.overlay.classList.remove('hidden');
        history.pushState({}, '', '/artistle');
        elements.searchInput.focus();
    });
}

function setupPopStateHandler(elements) {
    window.addEventListener('popstate', () => {
        hideWinOverlay(elements.winOverlay);
        elements.overlay.classList.remove('hidden');
        history.pushState({}, '', '/artistle');
    });
}

async function initialize() {
    const elements = getPageElements();
    setupViewportScale();
    revealContainer(elements.container);

    const graph = new ArtistNetworkGraph('svg', {
        onNodeExpand: (node) => {
            handleGuess({ node, graph, elements });
        },
    });

    setupSearch({
        input: elements.searchInput,
        resultsContainer: elements.searchResults,
        onSelect: (entry) => {
            startGame({ entry, graph, elements });
        },
    });

    setStatus(elements.status, 'Pick a starting artist to begin.', null);

    setupWinOverlayButton(elements);
    setupPopStateHandler(elements);
}

document.addEventListener('DOMContentLoaded', initialize);
