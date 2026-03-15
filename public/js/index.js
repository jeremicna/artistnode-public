import { initializeGraph, setupSearchListeners, setupPopStateHandler } from './graph.js';
import { setupViewportScale } from './viewport-scale.js';

function getPageElements() {
    return {
        container: document.getElementById('container'),
        overlay: document.getElementById('overlay'),
        searchInput: document.getElementById('searchInput'),
        searchResults: document.getElementById('searchResults'),
        searchEnter: document.getElementById('searchEnter'),
    };
}

function revealContainer(container) {
    if (!container) {
        return;
    }

    container.classList.remove('opacity-0', 'translate-y-8');
}

function handleArtistSelection(entry, graph, overlay) {
    graph.init(entry.id);
    overlay.classList.add('hidden');
    history.pushState({}, '', '/graph');
}

async function initializePage() {
    const elements = getPageElements();
    setupViewportScale();
    revealContainer(elements.container);

    const graph = await initializeGraph('svg');

    setupSearchListeners({
        graph,
        searchInput: elements.searchInput,
        resultsContainer: elements.searchResults,
        enterButton: elements.searchEnter,
        onSelect: (entry) => handleArtistSelection(entry, graph, elements.overlay),
    });

    setupPopStateHandler(elements.overlay);
}

document.addEventListener('DOMContentLoaded', initializePage);
