const { execFileSync } = require('child_process');
const fs = require('fs');

function runDeploymentSetup({ databaseDirectory, s3BucketName }) {
    if (process.env.SYNC_DATABASE_FROM_S3 !== 'true') {
        return;
    }

    if (!s3BucketName) {
        console.error('SYNC_DATABASE_FROM_S3 is true, but S3_BUCKET_NAME is not set');
        process.exit(1);
    }

    try {
        createDatabaseDirectory(databaseDirectory);
        syncDatabaseFromS3(s3BucketName);
        verifyDatabaseDirectory(databaseDirectory);
        console.log(`Database verified at: ${databaseDirectory}`);
    } catch (error) {
        console.error('Error running shell commands:', error.message);
        process.exit(1);
    }
}

function createDatabaseDirectory(databaseDirectory) {
    fs.mkdirSync(databaseDirectory, { recursive: true });
}

function syncDatabaseFromS3(s3BucketName) {
    console.log('Syncing from S3...');
    execFileSync(
        'aws',
        ['s3', 'sync', `s3://${s3BucketName}/data/db`, './data/db', '--delete'],
        { stdio: 'inherit' }
    );
    console.log('S3 sync completed successfully');
}

function verifyDatabaseDirectory(databaseDirectory) {
    if (!fs.existsSync(databaseDirectory)) {
        throw new Error(`Database directory not found at ${databaseDirectory} after sync`);
    }
}

module.exports = {
    runDeploymentSetup,
};
