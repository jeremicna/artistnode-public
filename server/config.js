const path = require('path');
const rateLimit = require('express-rate-limit');

const ROOT_DIRECTORY = path.join(__dirname, '..');
const DATA_DIRECTORY = path.join(ROOT_DIRECTORY, 'data');
const DATABASE_DIRECTORY = path.join(DATA_DIRECTORY, 'db');
const PUBLIC_DIRECTORY = path.join(ROOT_DIRECTORY, 'public');

const INTERNAL_SERVER_ERROR = 'Internal Server Error';

const DB_OPEN_OPTIONS = {
    readOnly: true,
    blockCacheSize: 1024 * 1024 * 1024,
};

function readIntegerEnv(name, fallback) {
    const value = Number.parseInt(process.env[name], 10);
    return value || fallback;
}

function requireIntegerEnv(name) {
    const value = Number.parseInt(process.env[name], 10);

    if (Number.isFinite(value) && value > 0) {
        return value;
    }

    throw new Error(`Missing or invalid integer env var: ${name}`);
}

const ARTISTLE_CONFIG = {
    maxGuesses: readIntegerEnv('ARTISTLE_MAX_GUESSES', 6),
    targetPoolSize: readIntegerEnv('ARTISTLE_TARGET_POOL_SIZE', 200),
    maxDepth: readIntegerEnv('ARTISTLE_MAX_DEPTH', 8),
    maxVisited: readIntegerEnv('ARTISTLE_MAX_VISITED', 25000),
};

function createRateLimiter(maxEnvName) {
    return rateLimit({
        windowMs: requireIntegerEnv('RATE_LIMIT_WINDOW_MS'),
        max: requireIntegerEnv(maxEnvName),
        message: 'Too many requests',
    });
}

module.exports = {
    ARTISTLE_CONFIG,
    DATABASE_DIRECTORY,
    DB_OPEN_OPTIONS,
    INTERNAL_SERVER_ERROR,
    PUBLIC_DIRECTORY,
    createRateLimiter,
    readIntegerEnv,
    requireIntegerEnv,
};
