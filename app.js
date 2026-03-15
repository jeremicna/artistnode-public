require('dotenv').config();

const express = require('express');
const {
    ARTISTLE_CONFIG,
    DATABASE_DIRECTORY,
    DB_OPEN_OPTIONS,
    INTERNAL_SERVER_ERROR,
    PUBLIC_DIRECTORY,
    createRateLimiter,
} = require('./server/config');
const { runDeploymentSetup } = require('./server/deployment');
const { createDatabase, registerDatabaseShutdown } = require('./server/db');
const { registerRoutes } = require('./server/routes');
const { createArtistleService } = require('./server/services/artistle');

runDeploymentSetup({
    databaseDirectory: DATABASE_DIRECTORY,
    s3BucketName: process.env.S3_BUCKET_NAME,
});

const app = express();
const port = process.env.PORT || 3000;
const db = createDatabase(DATABASE_DIRECTORY, DB_OPEN_OPTIONS);
const artistleService = createArtistleService({
    db,
    config: ARTISTLE_CONFIG,
});

const searchLimiter = createRateLimiter('SEARCH_RATE_LIMIT_MAX');
const limiter = createRateLimiter('GENERAL_RATE_LIMIT_MAX');

app.use(express.json());

registerDatabaseShutdown(db);

registerRoutes({
    app,
    artistleConfig: ARTISTLE_CONFIG,
    artistleService,
    db,
    internalServerError: INTERNAL_SERVER_ERROR,
    limiter,
    publicDirectory: PUBLIC_DIRECTORY,
    searchLimiter,
});

app.use(express.static(PUBLIC_DIRECTORY));

app.get('/robots.txt', (req, res) => {
    res.type('text/plain').send(
`User-agent: *
Disallow:`
    );
});

app.use((req, res) => {
    res.status(404).type('text/plain').send('404 Not Found');
});

app.listen(port, () => {
    console.log(`App listening on port ${port}`);
});
