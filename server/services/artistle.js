const { heapPushSelect } = require('../../utils/heap');
const {
    createSearchRange,
    finishIterator,
    getRelationDataKey,
    parseJsonBuffer,
    readDbJsonOrNull,
    scheduleNextIteratorStep,
} = require('../db');

function createArtistleService({ db, config }) {
    const state = {
        candidates: [],
        candidatesReady: null,
        relationCache: new Map(),
        neighborCache: new Map(),
        targets: new Map(),
    };

    async function getRelationData(artistId) {
        if (state.relationCache.has(artistId)) {
            return state.relationCache.get(artistId);
        }

        const data = await readDbJsonOrNull(db, getRelationDataKey(artistId));

        if (data) {
            state.relationCache.set(artistId, data);
        }

        return data;
    }

    async function getNeighbors(artistId) {
        if (state.neighborCache.has(artistId)) {
            return state.neighborCache.get(artistId);
        }

        const relationData = await getRelationData(artistId);
        const neighbors = relationData?.data?.[0]?.views?.['similar-artists']?.data?.map((artist) => artist.id) || [];

        state.neighborCache.set(artistId, neighbors);
        return neighbors;
    }

    function parseArtistleCandidate(key, value) {
        const keyString = String(key);
        const lastColon = keyString.lastIndexOf(':');
        const index = Number(keyString.slice(lastColon + 1));

        if (!Number.isFinite(index)) {
            return null;
        }

        const artistInfo = parseJsonBuffer(value);

        if (!artistInfo?.id) {
            return null;
        }

        return {
            id: artistInfo.id,
            name: artistInfo.name,
            index,
        };
    }

    function finalizeArtistleCandidates(heap) {
        heap.sort((a, b) => a.index - b.index);
        state.candidates = heap;
    }

    function buildCandidates() {
        if (state.candidatesReady) {
            return state.candidatesReady;
        }

        state.candidatesReady = new Promise((resolve, reject) => {
            const iterator = db.iterator(createSearchRange());
            const heap = [];
            let count = 0;

            function processNext() {
                iterator.next((error, key, value) => {
                    if (error) {
                        finishIterator(iterator, () => reject(error));
                        return;
                    }

                    if (key === undefined) {
                        finishIterator(iterator, () => {
                            finalizeArtistleCandidates(heap);
                            resolve(heap);
                        });
                        return;
                    }

                    try {
                        const candidate = parseArtistleCandidate(key, value);

                        if (!candidate) {
                            processNext();
                            return;
                        }

                        heapPushSelect(heap, candidate, config.targetPoolSize);
                    } catch {
                        processNext();
                        return;
                    }

                    count += 1;
                    scheduleNextIteratorStep(processNext, count, 1000);
                });
            }

            processNext();
        });

        return state.candidatesReady;
    }

    function hashSeed(value) {
        let hash = 2166136261;

        for (let index = 0; index < value.length; index += 1) {
            hash ^= value.charCodeAt(index);
            hash = Math.imul(hash, 16777619);
        }

        return hash >>> 0;
    }

    function createSeededRandom(seed) {
        let current = seed >>> 0;

        return () => {
            current += 0x6d2b79f5;
            let result = Math.imul(current ^ (current >>> 15), current | 1);
            result ^= result + Math.imul(result ^ (result >>> 7), result | 61);
            return ((result ^ (result >>> 14)) >>> 0) / 4294967296;
        };
    }

    function getTodayCacheKey() {
        return new Date().toISOString().slice(0, 10);
    }

    async function selectTarget(rootId) {
        if (!rootId) {
            return null;
        }

        const cacheKey = getTodayCacheKey();

        if (state.targets.has(cacheKey)) {
            return {
                candidate: state.targets.get(cacheKey),
                date: cacheKey,
            };
        }

        const candidates = await buildCandidates();

        if (candidates.length === 0) {
            return null;
        }

        const random = createSeededRandom(hashSeed(cacheKey));
        const chosen = candidates[Math.floor(random() * candidates.length)];

        state.targets.set(cacheKey, chosen);

        return {
            candidate: chosen,
            date: cacheKey,
        };
    }

    async function computeDistance(startId, targetId) {
        if (!startId || !targetId) {
            return null;
        }

        if (startId === targetId) {
            return 0;
        }

        const visited = new Set([startId]);
        let frontier = [startId];
        let depth = 0;

        while (
            frontier.length > 0
            && depth < config.maxDepth
            && visited.size < config.maxVisited
        ) {
            depth += 1;

            const neighborLists = await Promise.all(frontier.map((id) => getNeighbors(id)));
            const nextFrontier = [];

            for (const neighbors of neighborLists) {
                for (const neighbor of neighbors) {
                    if (neighbor === targetId) {
                        return depth;
                    }

                    if (!visited.has(neighbor)) {
                        visited.add(neighbor);
                        nextFrontier.push(neighbor);
                    }
                }
            }

            frontier = nextFrontier;
        }

        return null;
    }

    return {
        computeDistance,
        selectTarget,
    };
}

module.exports = {
    createArtistleService,
};
