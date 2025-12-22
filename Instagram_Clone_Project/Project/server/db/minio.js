const AWS = require('aws-sdk');

const s3 = new AWS.S3({
  endpoint: `http://${process.env.MINIO_ENDPOINT || 'localhost'}:${process.env.MINIO_PORT || 9000}`,
  accessKeyId: process.env.MINIO_ACCESS_KEY || 'admin',
  secretAccessKey: process.env.MINIO_SECRET_KEY || 'admin12345',
  s3ForcePathStyle: true,
  signatureVersion: 'v4',
});

const BUCKET = process.env.MINIO_BUCKET || 'reels-media';

async function initBucket() {
  try {
    // Check if bucket exists
    try {
      await s3.headBucket({ Bucket: BUCKET }).promise();
      console.log(`MinIO bucket '${BUCKET}' exists`);
    } catch (error) {
      if (error.statusCode === 404) {
        // Create bucket if it doesn't exist
        await s3.createBucket({ Bucket: BUCKET }).promise();
        console.log(`MinIO bucket '${BUCKET}' created`);
      } else {
        throw error;
      }
    }
  } catch (error) {
    console.error('MinIO initialization error:', error);
    throw error;
  }
}

module.exports = { s3, BUCKET, initBucket };

