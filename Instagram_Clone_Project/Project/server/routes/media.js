const express = require('express');
const router = express.Router();
const multer = require('multer');
const { s3, BUCKET, initBucket } = require('../db/minio');
const { v4: uuidv4 } = require('uuid');
const path = require('path');

// Configure multer for memory storage
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB
  },
});

/**
 * POST /api/media/upload
 * Upload media to MinIO
 * 
 * Architecture:
 * - Store media files in MinIO (S3-compatible)
 * - Return public URL for use in reels
 * 
 * Why MinIO for media:
 * - S3-compatible API (industry standard)
 * - Scalable object storage
 * - Can serve files directly or via CDN
 */
router.post('/upload', upload.single('media'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }
    
    await initBucket();
    
    const fileId = uuidv4();
    const ext = path.extname(req.file.originalname);
    const key = `reels/${fileId}${ext}`;
    
    // Upload to MinIO
    await s3.putObject({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }).promise();
    
    // Return URL using proxy endpoint (more reliable than direct MinIO access)
    // In production, this would be a CDN URL
    const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.SERVER_PORT || 3000}`;
    const url = `${baseUrl}/api/media/${encodeURIComponent(key)}`;
    
    res.json({
      url,
      key,
      fileId,
    });
  } catch (error) {
    console.error('Error uploading media:', error);
    res.status(500).json({ error: 'Failed to upload media' });
  }
});

/**
 * GET /api/media/:key
 * Get media file (proxy through server)
 * Alternative: Configure MinIO for public access and serve directly
 */
router.get('/:key(*)', async (req, res) => {
  try {
    // Handle URL-encoded keys (decode if needed)
    let key = decodeURIComponent(req.params.key);
    
    // Remove leading slash if present
    if (key.startsWith('/')) {
      key = key.substring(1);
    }
    
    console.log(`Fetching media with key: ${key}`);
    
    const object = await s3.getObject({
      Bucket: BUCKET,
      Key: key,
    }).promise();
    
    // Set appropriate content type and cache headers
    res.setHeader('Content-Type', object.ContentType || 'application/octet-stream');
    res.setHeader('Cache-Control', 'public, max-age=31536000'); // Cache for 1 year
    res.send(object.Body);
  } catch (error) {
    console.error('Error fetching media:', error);
    res.status(404).json({ error: 'Media not found', key: req.params.key });
  }
});

module.exports = router;

