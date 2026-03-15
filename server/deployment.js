const { execSync } = require('child_process');
const fs = require('fs');

function runDeploymentSetup({ databaseDirectory, s3BucketName }) {
    if (!process.env.PORT) {
        console.log('PORT not set, skipping shell commands');
        return;
    }

    console.log('PORT set, running shell commands...');

    try {
        createDatabaseDirectory();
        syncDatabaseFromS3(s3BucketName);
        verifyDatabaseDirectory(databaseDirectory);
        console.log(`Database verified at: ${databaseDirectory}`);
    } catch (error) {
        console.error('Error running shell commands:', error.message);
        process.exit(1);
    }
}

function createDatabaseDirectory() {
    console.log('Creating directory...');
    execSync('mkdir -p ./data/db', { stdio: 'inherit' });
}

function syncDatabaseFromS3(s3BucketName) {
    console.log('Syncing from S3...');
    execSync(
        `aws s3 sync s3://${s3BucketName}/data/db ./data/db --delete`,
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
