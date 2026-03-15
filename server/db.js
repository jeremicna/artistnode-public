const rocksdb = require('rocksdb');

const SEARCH_KEY_PREFIX = 'search:';
const SEARCH_KEY_RANGE_END = '\xFF';
const RELATION_DATA_PREFIX = 'relation-data';

function createDatabase(databaseDirectory, openOptions) {
    const db = rocksdb(databaseDirectory);

    db.open(openOptions, (error) => {
        if (error) {
            console.error('Failed to open database:', error);
            process.exit(1);
        }

        console.log('Database opened successfully in read-only mode');
    });

    return db;
}

function registerDatabaseShutdown(db) {
    process.on('SIGINT', () => {
        console.log('Closing database...');
        db.close(() => {
            console.log('Database closed');
            process.exit(0);
        });
    });
}

function getRelationDataKey(artistId) {
    return `${RELATION_DATA_PREFIX}:${artistId}`;
}

function isNotFoundError(error) {
    return Boolean(
        error
        && (
            error.notFound === true
            || error.message === 'NotFound: '
            || String(error.message).startsWith('NotFound:')
        )
    );
}

function createSearchRange(prefix = '') {
    return {
        gte: `${SEARCH_KEY_PREFIX}${prefix}`,
        lt: `${SEARCH_KEY_PREFIX}${prefix}${SEARCH_KEY_RANGE_END}`,
    };
}

function parseJsonBuffer(data) {
    return JSON.parse(data.toString());
}

function readDbBuffer(db, key) {
    return new Promise((resolve, reject) => {
        db.get(key, (error, data) => {
            if (error) {
                reject(error);
                return;
            }

            resolve(data);
        });
    });
}

async function readDbJsonOrNull(db, key) {
    try {
        const data = await readDbBuffer(db, key);
        return parseJsonBuffer(data);
    } catch {
        return null;
    }
}

function finishIterator(iterator, callback) {
    iterator.end(() => {
        callback();
    });
}

function scheduleNextIteratorStep(processNext, count, yieldEvery) {
    if (count % yieldEvery === 0) {
        setImmediate(processNext);
        return;
    }

    processNext();
}

module.exports = {
    createDatabase,
    createSearchRange,
    finishIterator,
    getRelationDataKey,
    isNotFoundError,
    parseJsonBuffer,
    readDbBuffer,
    readDbJsonOrNull,
    registerDatabaseShutdown,
    scheduleNextIteratorStep,
};
