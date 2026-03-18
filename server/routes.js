const path = require('path');
const { heapPushSelect } = require('../utils/heap');
const {
    createSearchRange,
    finishIterator,
    getRelationDataKey,
    isNotFoundError,
    parseJsonBuffer,
    readDbBuffer,
    scheduleNextIteratorStep,
} = require('./db');

function registerRoutes({
    app,
    artistleConfig,
    artistleService,
    db,
    internalServerError,
    limiter,
    publicDirectory,
    searchLimiter,
}) {
    function sendInternalServerError(res) {
        res.status(500).json({ error: internalServerError });
    }

    async function readRelationDataForResponse(artistId) {
        const data = await readDbBuffer(db, getRelationDataKey(artistId));
        return parseJsonBuffer(data);
    }

    function getPrimaryGenre(artistData) {
        return artistData?.data?.[0]?.attributes?.genreNames?.[0] || null;
    }

    async function readArtistGenreOrNull(artistId) {
        try {
            const artistData = await readRelationDataForResponse(artistId);
            return getPrimaryGenre(artistData);
        } catch {
            return null;
        }
    }

    async function readBatchRelationDataEntry(artistId) {
        try {
            const artistData = await readRelationDataForResponse(artistId);
            return {
                artistId,
                result: artistData,
                internalErrorOccurred: false,
            };
        } catch (error) {
            if (isNotFoundError(error)) {
                return {
                    artistId,
                    result: { error: 'Artist not found' },
                    internalErrorOccurred: false,
                };
            }

            if (error instanceof SyntaxError) {
                return {
                    artistId,
                    result: { error: 'Parse error' },
                    internalErrorOccurred: true,
                };
            }

            return {
                artistId,
                result: { error: internalServerError },
                internalErrorOccurred: true,
            };
        }
    }

    async function readBatchRelationData(artistIds) {
        const entries = await Promise.all(artistIds.map((artistId) => readBatchRelationDataEntry(artistId)));
        const results = {};
        let internalErrorOccurred = false;

        for (const entry of entries) {
            results[entry.artistId] = entry.result;

            if (entry.internalErrorOccurred) {
                internalErrorOccurred = true;
            }
        }

        return { results, internalErrorOccurred };
    }

    function parseSearchResultEntry(key, value) {
        const keyString = String(key);
        const firstColon = keyString.indexOf(':');
        const lastColon = keyString.lastIndexOf(':');

        return {
            name: keyString.slice(firstColon + 1, lastColon),
            index: Number(keyString.slice(lastColon + 1)),
            artistInfo: parseJsonBuffer(value),
        };
    }

    function createSearchResultsObject(heap) {
        heap.sort((a, b) => a.index - b.index);

        const results = {};

        for (const item of heap) {
            results[item.name] = item.artistInfo;
        }

        return results;
    }

    function searchArtists(prefix) {
        return new Promise((resolve, reject) => {
            const iterator = db.iterator(createSearchRange(prefix));
            const heap = [];
            let count = 0;

            function processNext() {
                iterator.next((error, key, value) => {
                    if (error) {
                        finishIterator(iterator, () => reject(error));
                        return;
                    }

                    if (key === undefined) {
                        finishIterator(iterator, () => resolve(createSearchResultsObject(heap)));
                        return;
                    }

                    try {
                        const entry = parseSearchResultEntry(key, value);
                        heapPushSelect(heap, entry);
                        count += 1;
                        scheduleNextIteratorStep(processNext, count, 100);
                    } catch (parseError) {
                        console.warn('Failed to parse:', parseError.message);
                        processNext();
                    }
                });
            }

            processNext();
        });
    }

    app.get('/graph', (req, res) => {
        res.redirect('/');
    });

    app.get('/artistle', (req, res) => {
        res.sendFile(path.join(publicDirectory, 'artistle.html'));
    });

    app.get('/api/relationdata/:id', limiter, async (req, res) => {
        try {
            const artistData = await readRelationDataForResponse(req.params.id);
            res.json(artistData);
        } catch (error) {
            if (isNotFoundError(error)) {
                res.status(404).json({ error: 'Artist not found' });
                return;
            }

            sendInternalServerError(res);
        }
    });

    app.post('/api/relationdata/batch', searchLimiter, async (req, res) => {
        const artistIds = req.body.ids;

        if (!Array.isArray(artistIds) || artistIds.length === 0) {
            res.status(400).json({ error: 'Invalid or missing "ids" array in request body' });
            return;
        }

        const { results, internalErrorOccurred } = await readBatchRelationData(artistIds);

        if (internalErrorOccurred) {
            res.status(207).json(results);
            return;
        }

        res.json(results);
    });

    app.get('/api/search/:prefix', searchLimiter, async (req, res) => {
        try {
            const prefix = req.params.prefix.toLowerCase();
            const results = await searchArtists(prefix);
            res.json(results);
        } catch {
            sendInternalServerError(res);
        }
    });

    app.get('/api/artistle/target', limiter, async (req, res) => {
        const rootId = req.query.root;

        if (!rootId) {
            res.status(400).json({ error: 'Missing root id' });
            return;
        }

        try {
            const targetResult = await artistleService.selectTarget(rootId);

            if (!targetResult || !targetResult.candidate) {
                res.status(503).json({ error: 'No artistle target available' });
                return;
            }

            const [rootGenre, targetGenre, pathLength] = await Promise.all([
                readArtistGenreOrNull(rootId),
                readArtistGenreOrNull(targetResult.candidate.id),
                artistleService.computePathLength(rootId, targetResult.candidate.id),
            ]);
            const maxGuesses = Number.isFinite(pathLength)
                ? pathLength + 3
                : artistleConfig.maxGuesses;

            res.json({
                date: targetResult.date,
                rootId,
                rootGenre,
                targetId: targetResult.candidate.id,
                targetGenre,
                targetName: targetResult.candidate.name,
                maxGuesses,
                maxDepth: artistleConfig.maxDepth,
            });
        } catch (error) {
            console.error('Failed to select artistle target:', error);
            sendInternalServerError(res);
        }
    });

    app.get('/api/artistle/distance', limiter, async (req, res) => {
        const fromId = req.query.from;
        const toId = req.query.to;

        if (!fromId || !toId) {
            res.status(400).json({ error: 'Missing from/to ids' });
            return;
        }

        try {
            const distance = await artistleService.computeDistance(fromId, toId);
            res.json({
                distance,
                maxDepth: artistleConfig.maxDepth,
            });
        } catch (error) {
            console.error('Failed to compute artistle distance:', error);
            sendInternalServerError(res);
        }
    });
}

module.exports = {
    registerRoutes,
};
