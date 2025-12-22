const express = require('express');
const router = express.Router();
const multer = require('multer');
const { getDb } = require('../db/mongo');
const { s3, BUCKET } = require('../db/minio');
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
 * POST /api/stories
 * Upload a story
 * 
 * Architecture:
 * - Store story metadata in MongoDB (with expiration TTL)
 * - Store media in MinIO
 * - Stories expire after 24 hours
 */
router.post('/', upload.single('media'), async (req, res) => {
  try {
    const { userId } = req.body;
    
    if (!userId || !req.file) {
      return res.status(400).json({ error: 'userId and media file are required' });
    }
    
    const mongo = getDb();
    
    // Upload media to MinIO
    const fileId = uuidv4();
    const ext = path.extname(req.file.originalname);
    const key = `stories/${fileId}${ext}`;
    
    await s3.putObject({
      Bucket: BUCKET,
      Key: key,
      Body: req.file.buffer,
      ContentType: req.file.mimetype,
    }).promise();
    
    // Generate URL
    const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.SERVER_PORT || 3000}`;
    const mediaUrl = `${baseUrl}/api/media/${encodeURIComponent(key)}`;
    
    // Store story in MongoDB (expires after 24 hours)
    const expiresAt = new Date();
    expiresAt.setHours(expiresAt.getHours() + 24);
    
    const story = {
      id: uuidv4(),
      userId,
      mediaUrl,
      createdAt: new Date(),
      expiresAt,
    };
    
    await mongo.collection('stories').insertOne(story);
    
    res.json({
      id: story.id,
      mediaUrl,
      createdAt: story.createdAt,
      expiresAt: story.expiresAt,
    });
  } catch (error) {
    console.error('Error uploading story:', error);
    res.status(500).json({ error: 'Failed to upload story', details: error.message });
  }
});

/**
 * GET /api/stories
 * Get stories from users you follow
 */
router.get('/', async (req, res) => {
  try {
    const { userId } = req.query;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const mongo = getDb();
    
    // Get users you follow
    const follows = await mongo.collection('follows').find({ followerId: userId }).toArray();
    const followingIds = follows.map(f => f.followedId);
    
    // Include your own stories
    followingIds.push(userId);
    
    // Get active stories (not expired)
    const now = new Date();
    const stories = await mongo.collection('stories')
      .find({
        userId: { $in: followingIds },
        expiresAt: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .toArray();
    
    // Group stories by user
    const storiesByUser = {};
    for (const story of stories) {
      if (!storiesByUser[story.userId]) {
        storiesByUser[story.userId] = [];
      }
      storiesByUser[story.userId].push(story);
    }
    
    // Get user info for each story author
    const userIds = Object.keys(storiesByUser);
    const users = await mongo.collection('users')
      .find({ id: { $in: userIds } })
      .toArray();
    
    const userMap = {};
    users.forEach(u => {
      userMap[u.id] = {
        id: u.id,
        username: u.username,
        avatar: u.avatar,
      };
    });
    
    // Format response
    const result = userIds.map(userId => ({
      user: userMap[userId] || { id: userId, username: 'unknown' },
      stories: storiesByUser[userId],
    }));
    
    res.json({ stories: result });
  } catch (error) {
    console.error('Error fetching stories:', error);
    res.status(500).json({ error: 'Failed to fetch stories', details: error.message });
  }
});

/**
 * GET /api/stories/user/:userId
 * Get stories for a specific user
 */
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const mongo = getDb();
    const now = new Date();
    
    const stories = await mongo.collection('stories')
      .find({
        userId,
        expiresAt: { $gt: now },
      })
      .sort({ createdAt: -1 })
      .toArray();
    
    res.json({ stories });
  } catch (error) {
    console.error('Error fetching user stories:', error);
    res.status(500).json({ error: 'Failed to fetch user stories', details: error.message });
  }
});

module.exports = router;

