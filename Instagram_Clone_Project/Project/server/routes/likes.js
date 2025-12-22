const express = require('express');
const router = express.Router();
const redis = require('../db/redis');
const { getDb } = require('../db/mongo');

/**
 * POST /api/likes/:reelId
 * Like a reel
 * 
 * Architecture:
 * - Fast increment in Redis (optimistic UI update)
 * - Async write to MongoDB for durability and analytics
 * 
 * Why Redis for likes:
 * - Sub-millisecond latency for counter operations
 * - Handles high write throughput
 * - Can be used for real-time like counts
 * 
 * Why MongoDB for durability:
 * - Flexible schema for like metadata (user, timestamp, etc.)
 * - Queryable for analytics and user-specific queries
 */
router.post('/:reelId', async (req, res) => {
  try {
    const { reelId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const key = `likes:${reelId}`;
    const userLikeKey = `like:${reelId}:${userId}`;
    
    // Check if already liked
    const alreadyLiked = await redis.get(userLikeKey);
    if (alreadyLiked) {
      return res.json({ message: 'Already liked', liked: true });
    }
    
    // Increment counter in Redis (fast)
    const newCount = await redis.incr(key);
    await redis.set(userLikeKey, '1', { EX: 86400 * 30 }); // Cache for 30 days
    
    // Async write to MongoDB for durability (don't wait)
    const mongo = getDb();
    mongo.collection('likes').insertOne({
      reelId,
      userId,
      createdAt: new Date(),
    }).catch(err => console.error('Error persisting like:', err));
    
    // Ensure newCount is a number
    const likesCount = typeof newCount === 'number' ? newCount : parseInt(newCount) || 0;
    
    res.json({
      likesCount: likesCount,
      liked: true,
    });
  } catch (error) {
    console.error('Error liking reel:', error);
    res.status(500).json({ error: 'Failed to like reel' });
  }
});

/**
 * DELETE /api/likes/:reelId
 * Unlike a reel
 */
router.delete('/:reelId', async (req, res) => {
  try {
    const { reelId } = req.params;
    const { userId } = req.body;
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const key = `likes:${reelId}`;
    const userLikeKey = `like:${reelId}:${userId}`;
    
    // Check if liked
    const alreadyLiked = await redis.get(userLikeKey);
    if (!alreadyLiked) {
      return res.json({ message: 'Not liked', liked: false });
    }
    
    // Decrement counter in Redis
    const newCount = await redis.decr(key);
    await redis.del(userLikeKey);
    
    // Async delete from MongoDB
    const mongo = getDb();
    mongo.collection('likes').deleteOne({
      reelId,
      userId,
    }).catch(err => console.error('Error removing like:', err));
    
    // Ensure newCount is a number
    const likesCount = typeof newCount === 'number' ? Math.max(0, newCount) : Math.max(0, parseInt(newCount) || 0);
    
    res.json({
      likesCount: likesCount,
      liked: false,
    });
  } catch (error) {
    console.error('Error unliking reel:', error);
    res.status(500).json({ error: 'Failed to unlike reel' });
  }
});

/**
 * GET /api/likes/:reelId
 * Get like count and status for a user
 */
router.get('/:reelId', async (req, res) => {
  try {
    const { reelId } = req.params;
    const { userId } = req.query;
    
    const key = `likes:${reelId}`;
    const likesCountStr = await redis.get(key);
    const likesCount = likesCountStr ? (typeof likesCountStr === 'number' ? likesCountStr : parseInt(likesCountStr) || 0) : 0;
    
    let liked = false;
    if (userId) {
      const userLikeKey = `like:${reelId}:${userId}`;
      liked = !!(await redis.get(userLikeKey));
    }
    
    res.json({
      likesCount: likesCount,
      liked,
    });
  } catch (error) {
    console.error('Error getting likes:', error);
    res.status(500).json({ error: 'Failed to get likes' });
  }
});

module.exports = router;

