const INTERNAL_SERVER_ERROR = 'Internal Server Error';
const SEARCH_RESULT_LIMIT = 5;
const R2_ARTIST_PREFIX = 'artists/';
const DEFAULT_BATCH_MAX = 25;
const DEFAULT_MAX_GUESSES = 6;
const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_TARGET_POOL_SIZE = 200;
const SEARCH_RANGE_END = '\uffff';

function jsonResponse(body, init = {}) {
    return new Response(JSON.stringify(body), {
        ...init,
        headers: {
            'content-type': 'application/json; charset=utf-8',
            ...(init.headers || {}),
        },
    });
}

function textResponse(body, init = {}) {
    return new Response(body, {
        ...init,
        headers: {
            'content-type': 'text/plain; charset=utf-8',
            ...(init.headers || {}),
        },
    });
}

function readPositiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function createConfig(env) {
    return {
        batchMax: readPositiveInteger(env.RELATIONDATA_BATCH_MAX, DEFAULT_BATCH_MAX),
        maxGuesses: readPositiveInteger(env.ARTISTLE_MAX_GUESSES, DEFAULT_MAX_GUESSES),
        maxDepth: readPositiveInteger(env.ARTISTLE_MAX_DEPTH, DEFAULT_MAX_DEPTH),
        targetPoolSize: readPositiveInteger(env.ARTISTLE_TARGET_POOL_SIZE, DEFAULT_TARGET_POOL_SIZE),
    };
}

function todayUtc() {
    return new Date().toISOString().slice(0, 10);
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

async function readArtistRow(env, artistId) {
    return await env.DB.prepare(
        'SELECT num, id, name, primary_genre, r2_key FROM artists WHERE id = ?'
    ).bind(artistId).first();
}

async function readArtistJson(env, artistId) {
    const row = await readArtistRow(env, artistId);

    if (!row) {
        return null;
    }

    const object = await env.ARTIST_JSON.get(row.r2_key || `${R2_ARTIST_PREFIX}${artistId}.json`);

    if (!object) {
        return null;
    }

    return await object.json();
}

async function readBatchArtistJsonEntry(env, artistId) {
    try {
        const artistData = await readArtistJson(env, artistId);

        if (!artistData) {
            return [artistId, { error: 'Artist not found' }];
        }

        return [artistId, artistData];
    } catch (error) {
        console.error('Failed to read artist relation data:', artistId, error);
        return [artistId, { error: INTERNAL_SERVER_ERROR }];
    }
}

async function handleRelationData(env, artistId) {
    const artistData = await readArtistJson(env, artistId);

    if (!artistData) {
        return jsonResponse({ error: 'Artist not found' }, { status: 404 });
    }

    return jsonResponse(artistData);
}

async function handleBatchRelationData(request, env, config) {
    let body;

    try {
        body = await request.json();
    } catch {
        return jsonResponse({ error: 'Invalid JSON body' }, { status: 400 });
    }

    const artistIds = body?.ids;

    if (!Array.isArray(artistIds) || artistIds.length === 0) {
        return jsonResponse({ error: 'Invalid or missing "ids" array in request body' }, { status: 400 });
    }

    if (artistIds.length > config.batchMax) {
        return jsonResponse({ error: `Batch size exceeds ${config.batchMax}` }, { status: 400 });
    }

    const entries = await Promise.all(
        artistIds.map((artistId) => readBatchArtistJsonEntry(env, String(artistId)))
    );
    const results = Object.fromEntries(entries);
    const internalErrorOccurred = entries.some(([, result]) => result?.error === INTERNAL_SERVER_ERROR);

    return jsonResponse(results, { status: internalErrorOccurred ? 207 : 200 });
}

async function handleSearch(env, prefix) {
    const normalizedPrefix = decodeURIComponent(prefix).trim().toLowerCase();

    if (!normalizedPrefix) {
        return jsonResponse({});
    }

    const { results } = await env.DB.prepare(
        `SELECT artists.id, artists.name, search_index.name_lc
         FROM search_index
         JOIN artists ON artists.num = search_index.artist_num
         WHERE search_index.name_lc >= ? AND search_index.name_lc < ?
         ORDER BY search_index.rank ASC
         LIMIT ?`
    ).bind(
        normalizedPrefix,
        `${normalizedPrefix}${SEARCH_RANGE_END}`,
        SEARCH_RESULT_LIMIT
    ).all();

    const response = {};

    for (const row of results || []) {
        response[row.name_lc] = {
            id: row.id,
            name: row.name,
        };
    }

    return jsonResponse(response);
}

async function readArtistleTargetForDate(env, date, config) {
    const stored = await env.DB.prepare(
        `SELECT artists.num, artists.id, artists.name, artists.primary_genre
         FROM artistle_daily_targets
         JOIN artists ON artists.num = artistle_daily_targets.target_num
         WHERE artistle_daily_targets.date = ?`
    ).bind(date).first();

    if (stored) {
        return stored;
    }

    const countRow = await env.DB.prepare('SELECT COUNT(*) AS count FROM artistle_candidates').first();
    const count = Math.min(Number(countRow?.count) || 0, config.targetPoolSize);

    if (count === 0) {
        return null;
    }

    const random = createSeededRandom(hashSeed(date));
    const offset = Math.floor(random() * count);

    return await env.DB.prepare(
        `SELECT artists.num, artists.id, artists.name, artists.primary_genre
         FROM artistle_candidates
         JOIN artists ON artists.num = artistle_candidates.artist_num
         ORDER BY artistle_candidates.rank ASC
         LIMIT 1 OFFSET ?`
    ).bind(offset).first();
}

async function readDistanceForDate(env, date, artistId) {
    const row = await env.DB.prepare(
        `SELECT artistle_distances.distance
         FROM artistle_distances
         JOIN artists ON artists.num = artistle_distances.artist_num
         WHERE artistle_distances.date = ? AND artists.id = ?`
    ).bind(date, artistId).first();

    return Number.isFinite(row?.distance) ? row.distance : null;
}

async function readDistanceDateForTarget(env, targetId) {
    const row = await env.DB.prepare(
        `SELECT artistle_daily_targets.date
         FROM artistle_daily_targets
         JOIN artists ON artists.num = artistle_daily_targets.target_num
         WHERE artists.id = ?
         ORDER BY artistle_daily_targets.date DESC
         LIMIT 1`
    ).bind(targetId).first();

    return row?.date || null;
}

async function handleArtistleTarget(request, env, config) {
    const url = new URL(request.url);
    const rootId = url.searchParams.get('root');

    if (!rootId) {
        return jsonResponse({ error: 'Missing root id' }, { status: 400 });
    }

    const date = todayUtc();
    const target = await readArtistleTargetForDate(env, date, config);

    if (!target) {
        return jsonResponse({ error: 'No artistle target available' }, { status: 503 });
    }

    const [root, pathLength] = await Promise.all([
        readArtistRow(env, rootId),
        readDistanceForDate(env, date, rootId),
    ]);

    const maxGuesses = Number.isFinite(pathLength)
        ? pathLength + 3
        : config.maxGuesses;

    return jsonResponse({
        date,
        rootId,
        rootGenre: root?.primary_genre || null,
        targetId: target.id,
        targetGenre: target.primary_genre || null,
        targetName: target.name,
        maxGuesses,
        maxDepth: config.maxDepth,
    });
}

async function handleArtistleDistance(request, env, config) {
    const url = new URL(request.url);
    const fromId = url.searchParams.get('from');
    const toId = url.searchParams.get('to');

    if (!fromId || !toId) {
        return jsonResponse({ error: 'Missing from/to ids' }, { status: 400 });
    }

    let date = todayUtc();
    const todayTarget = await readArtistleTargetForDate(env, date, config);

    if (todayTarget?.id !== toId) {
        date = await readDistanceDateForTarget(env, toId);
    }

    const distance = date ? await readDistanceForDate(env, date, fromId) : null;

    return jsonResponse({
        distance,
        maxDepth: config.maxDepth,
    });
}

async function handleApiRequest(request, env, config, pathname) {
    if (request.method === 'GET') {
        const relationDataMatch = pathname.match(/^\/api\/relationdata\/([^/]+)$/);

        if (relationDataMatch) {
            return await handleRelationData(env, decodeURIComponent(relationDataMatch[1]));
        }

        const searchMatch = pathname.match(/^\/api\/search\/(.+)$/);

        if (searchMatch) {
            return await handleSearch(env, searchMatch[1]);
        }

        if (pathname === '/api/artistle/target') {
            return await handleArtistleTarget(request, env, config);
        }

        if (pathname === '/api/artistle/distance') {
            return await handleArtistleDistance(request, env, config);
        }
    }

    if (request.method === 'POST' && pathname === '/api/relationdata/batch') {
        return await handleBatchRelationData(request, env, config);
    }

    return jsonResponse({ error: 'Not found' }, { status: 404 });
}

function rewriteAssetRequest(request, pathname) {
    const url = new URL(request.url);
    url.pathname = pathname;
    return new Request(url, request);
}

async function handleRequest(request, env) {
    const url = new URL(request.url);
    const { pathname } = url;
    const config = createConfig(env);

    try {
        if (pathname.startsWith('/api/')) {
            return await handleApiRequest(request, env, config, pathname);
        }

        if (pathname === '/graph') {
            return Response.redirect(new URL('/', request.url), 302);
        }

        if (pathname === '/artistle') {
            return await env.ASSETS.fetch(rewriteAssetRequest(request, '/artistle.html'));
        }

        if (pathname === '/robots.txt') {
            return textResponse('User-agent: *\nDisallow:');
        }

        return await env.ASSETS.fetch(request);
    } catch (error) {
        console.error('Unhandled request error:', error);
        return jsonResponse({ error: INTERNAL_SERVER_ERROR }, { status: 500 });
    }
}

export default {
    async fetch(request, env) {
        return await handleRequest(request, env);
    },
};
