const express = require('express');
const router = express.Router();
const { getClient } = require('../db/cassandra');
const { getDb } = require('../db/mongo');
const { getDriver, isNeo4jConnected } = require('../db/neo4j');
const { s3, BUCKET } = require('../db/minio');
const { v4: uuidv4 } = require('uuid');
const TimeUuid = require('cassandra-driver').types.TimeUuid;

/**
 * GET /api/reels/feed?userId=xxx&page=1&limit=10
 * 
 * Architecture:
 * - Pull reel IDs from Cassandra timeline table (partitioned by user_id, sorted by time)
 * - Enrich with user info from Neo4j (author details)
 * - Get like counts from Redis
 * - Get latest comments from MongoDB
 * 
 * Why Cassandra for feed:
 * - Time-series data optimized for range queries
 * - High write throughput for new reels
 * - Partitioned by user_id for efficient feed queries
 */
router.get('/feed', async (req, res) => {
  try {
    const { userId, page = 1, limit = 10 } = req.query;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    if (!userId) {
      return res.status(400).json({ error: 'userId is required' });
    }
    
    const cassandra = getClient();
    const mongo = getDb();
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    const redis = require('../db/redis');
    
    console.log(`Fetching feed for user: ${userId}`);
    
    // Get reel IDs from timeline (following feed)
    const timelineQuery = `
      SELECT reel_id, author_id, created_at
      FROM timeline
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `;
    
    const timelineResult = await cassandra.execute(timelineQuery, [userId, parseInt(limit)], {
      prepare: true,
      fetchSize: parseInt(limit),
    });
    
    // If no timeline, try to build it from MongoDB follows (if Neo4j not available)
    let reelIds = [];
    if (timelineResult.rows.length === 0) {
      // Check if user has follows in MongoDB (fallback when Neo4j not available)
      const follows = await mongo.collection('follows').find({ followerId: userId }).toArray();
      
      if (follows.length > 0) {
        // User follows people - get their reels and add to timeline
        console.log(`Building timeline from ${follows.length} MongoDB follows for user ${userId}`);
        const followedUserIds = follows.map(f => f.followedId);
        
        // Get reels from all followed users
        for (const followedUserId of followedUserIds) {
          const userReelsQuery = `
            SELECT reel_id, created_at
            FROM user_reels
            WHERE user_id = ?
            ORDER BY created_at DESC
            LIMIT 20
          `;
          const userReelsResult = await cassandra.execute(userReelsQuery, [followedUserId], {
            prepare: true,
          });
          
          // Add to timeline
          for (const row of userReelsResult.rows) {
            try {
              await cassandra.execute(
                'INSERT INTO timeline (user_id, reel_id, author_id, created_at) VALUES (?, ?, ?, ?)',
                [userId, row.reel_id, followedUserId, row.created_at || new Date()],
                { prepare: true }
              );
            } catch (err) {
              // Ignore duplicates
            }
          }
        }
        
        // Now query timeline again
        const newTimelineResult = await cassandra.execute(timelineQuery, [userId, parseInt(limit)], {
          prepare: true,
        });
        
        reelIds = newTimelineResult.rows.map(row => ({
          reelId: row.reel_id,
          reelIdString: row.reel_id ? row.reel_id.toString() : null,
          authorId: row.author_id,
          createdAt: row.created_at,
        })).filter(r => r.reelId);
      } else {
        // No follows - show user's own reels
        const userReelsQuery = `
          SELECT reel_id, created_at
          FROM user_reels
          WHERE user_id = ?
          ORDER BY created_at DESC
          LIMIT ?
        `;
        const userReelsResult = await cassandra.execute(userReelsQuery, [userId, parseInt(limit)], {
          prepare: true,
        });
        reelIds = userReelsResult.rows.map(row => ({
          reelId: row.reel_id,
          reelIdString: row.reel_id ? row.reel_id.toString() : null,
          authorId: userId,
          createdAt: row.created_at,
        })).filter(r => r.reelId);
      }
    } else {
      reelIds = timelineResult.rows.map(row => ({
        reelId: row.reel_id,
        reelIdString: row.reel_id ? row.reel_id.toString() : null,
        authorId: row.author_id,
        createdAt: row.created_at,
      })).filter(r => r.reelId);
    }
    
    if (reelIds.length === 0) {
      return res.json({
        reels: [],
        page: parseInt(page),
        limit: parseInt(limit),
        message: 'No reels found. Follow some users or create your first reel!'
      });
    }
    
    // Enrich with reel details, user info, likes, and comments
    const enrichedReels = await Promise.all(
      reelIds.map(async ({ reelId, reelIdString, authorId, createdAt }) => {
        try {
          // reelId is already a UUID object from Cassandra, use it directly
          const reelUuid = reelId;
          const reelIdStr = reelIdString || reelId.toString();
          
          // Get reel details from Cassandra
          const reelQuery = 'SELECT * FROM reels WHERE reel_id = ?';
          const reelResult = await cassandra.execute(reelQuery, [reelUuid], { prepare: true });
          const reel = reelResult.rows[0];
          
          if (!reel) {
            console.warn(`Reel not found: ${reelIdStr}`);
            return null;
          }
        
        // Get user info from MongoDB (source of truth)
        let user = { id: authorId, username: 'unknown' };
        try {
          const mongoUser = await mongo.collection('users').findOne({ id: authorId });
          if (mongoUser) {
            user = { 
              id: mongoUser.id, 
              username: mongoUser.username || 'unknown', 
              avatar: mongoUser.avatar 
            };
          } else {
            console.warn(`User not found in MongoDB: ${authorId}`);
          }
        } catch (error) {
          console.error(`Error fetching user ${authorId} from MongoDB:`, error);
        }
        
          // Get like count from Redis
          let likeCount = await redis.get(`likes:${reelIdStr}`);
          if (likeCount === null || likeCount === undefined) {
            likeCount = '0';
          }
          // Ensure it's a string for parseInt
          if (typeof likeCount !== 'string') {
            likeCount = String(likeCount);
          }
          // Ensure it's a string for parseInt
          if (typeof likeCount !== 'string') {
            likeCount = String(likeCount);
          }
          
                  // Get latest top-level comments from MongoDB (no replies for preview)
                  const comments = await mongo.collection('comments')
                    .find({ reelId: reelIdStr, parentCommentId: null })
                    .sort({ createdAt: -1 })
                    .limit(3)
                    .toArray();
          
          // Convert MinIO direct URLs to proxy URLs if needed
          let mediaUrl = reel.media_url;
          if (mediaUrl) {
            // Check if it's a direct MinIO URL that needs conversion
            if (mediaUrl.includes('localhost:9000') || mediaUrl.includes(':9000/')) {
              // Extract key from MinIO URL format: http://localhost:9000/reels-media/reels/...
              const keyMatch = mediaUrl.match(/\/(reels-media\/.+)$/);
              if (keyMatch) {
                const key = keyMatch[1];
                const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.SERVER_PORT || 3000}`;
                mediaUrl = `${baseUrl}/api/media/${encodeURIComponent(key)}`;
              }
            }
          }
          
          return {
            id: reelIdStr,
            mediaUrl: mediaUrl || '',
            caption: reel.caption || '',
            author: {
              id: user.id,
              username: user.username || 'unknown',
              avatar: user.avatar || null,
            },
            likesCount: (() => {
              const parsed = parseInt(likeCount);
              return isNaN(parsed) ? 0 : parsed;
            })(),
            comments: comments.map(c => ({
              id: c._id.toString(),
              text: c.text,
              author: {
                id: c.userId,
                username: c.username || 'unknown',
              },
              createdAt: c.createdAt,
            })),
            createdAt: reel.created_at || createdAt,
          };
        } catch (error) {
          console.error(`Error enriching reel ${reelId}:`, error);
          return null;
        }
      })
    );
    
    const validReels = enrichedReels.filter(Boolean);
    
    console.log(`Found ${validReels.length} reels for user ${userId}`);
    
    res.json({
      reels: validReels,
      page: parseInt(page),
      limit: parseInt(limit),
    });
  } catch (error) {
    console.error('Error fetching feed:', error);
    res.status(500).json({ error: 'Failed to fetch feed', details: error.message });
  }
});

/**
 * POST /api/reels
 * Create a new reel
 * 
 * Architecture:
 * - Store reel metadata in Cassandra (reels table)
 * - Add to user_reels table for user's profile
 * - Add to timeline of all followers in Neo4j
 * - Media already uploaded to MinIO, URL passed in request
 */
router.post('/', async (req, res) => {
  try {
    const { userId, caption, mediaUrl } = req.body;
    
    if (!userId || !mediaUrl) {
      return res.status(400).json({ error: 'userId and mediaUrl are required' });
    }
    
    const cassandra = getClient();
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    const { Uuid } = require('cassandra-driver').types;
    
    // Generate UUID for reel
    const reelId = Uuid.random();
    const reelIdString = reelId.toString();
    const now = new Date();
    
    console.log(`Creating reel ${reelIdString} for user ${userId}`);
    
    // Insert into reels table
    await cassandra.execute(
      'INSERT INTO reels (reel_id, user_id, caption, media_url, created_at) VALUES (?, ?, ?, ?, ?)',
      [reelId, userId, caption || '', mediaUrl, now],
      { prepare: true }
    );
    
    // Insert into user_reels for profile view
    await cassandra.execute(
      'INSERT INTO user_reels (user_id, reel_id, created_at) VALUES (?, ?, ?)',
      [userId, reelId, now],
      { prepare: true }
    );
    
    console.log(`Added reel ${reelIdString} to user_reels for ${userId}`);
    
    // Get followers from Neo4j (or MongoDB fallback) and add to their timelines
    const mongo = getDb();
    let followers = [];
    
    if (neo4j) {
      // Use read session for read operations
      const neo4jDriver = require('neo4j-driver');
      const session = neo4j.session({ defaultAccessMode: neo4jDriver.session.READ });
      try {
        const followersResult = await session.run(
          'MATCH (u:User {id: $userId})<-[:FOLLOWS]-(follower:User) RETURN follower.id as followerId',
          { userId }
        );
        followers = followersResult.records.map(r => r.get('followerId'));
      } catch (error) {
        console.warn('Failed to get followers from Neo4j:', error.message);
        // Fall through to MongoDB
      } finally {
        await session.close();
      }
    }
    
    // Fallback to MongoDB if Neo4j not available or returned no results
    if (followers.length === 0) {
      try {
        const follows = await mongo.collection('follows').find({ followedId: userId }).toArray();
        followers = follows.map(f => f.followerId);
        console.log(`Found ${followers.length} followers from MongoDB for user ${userId}`);
      } catch (error) {
        console.warn('Failed to get followers from MongoDB:', error.message);
      }
    }
    
    // Add to each follower's timeline
    if (followers.length > 0) {
      console.log(`Adding reel ${reelIdString} to ${followers.length} followers' timelines`);
      for (const followerId of followers) {
        try {
          await cassandra.execute(
            'INSERT INTO timeline (user_id, reel_id, author_id, created_at) VALUES (?, ?, ?, ?)',
            [followerId, reelId, userId, now],
            { prepare: true }
          );
        } catch (err) {
          // Ignore duplicate key errors
          if (!err.message.includes('duplicate')) {
            console.error(`Error adding reel to ${followerId}'s timeline:`, err);
          }
        }
      }
    } else {
      console.log(`No followers found for user ${userId} - reel will only appear in their profile`);
    }
    
    // Initialize like count in Redis
    const redis = require('../db/redis');
    await redis.set(`likes:${reelIdString}`, '0');
    
    console.log(`Reel ${reelIdString} created successfully`);
    
    res.json({
      id: reelIdString,
      message: 'Reel created successfully',
    });
  } catch (error) {
    console.error('Error creating reel:', error);
    res.status(500).json({ error: 'Failed to create reel', details: error.message });
  }
});

/**
 * GET /api/reels/user/:userId
 * Get all reels by a specific user (for profile page)
 */
router.get('/user/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 50 } = req.query;
    
    const cassandra = getClient();
    const mongo = getDb();
    const redis = require('../db/redis');
    
    console.log(`Fetching reels for user: ${userId}`);
    
    // Get user's reels from Cassandra
    const userReelsQuery = `
      SELECT reel_id, created_at
      FROM user_reels
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT ?
    `;
    
    let reelsResult;
    try {
      reelsResult = await cassandra.execute(userReelsQuery, [userId, parseInt(limit)], {
        prepare: true,
      });
      console.log(`Found ${reelsResult.rows.length} reels in user_reels for ${userId}`);
    } catch (error) {
      console.error('Error querying user_reels:', error);
      return res.status(500).json({ error: 'Failed to fetch user reels', details: error.message });
    }
    
    // Enrich with reel details, likes, and comment counts
    const enrichedReels = await Promise.all(
      reelsResult.rows.map(async (row) => {
        try {
          const reelId = row.reel_id; // Keep as UUID object
          const reelIdString = reelId.toString();
          
          // Get reel details
          const reelQuery = 'SELECT * FROM reels WHERE reel_id = ?';
          const reelResult = await cassandra.execute(reelQuery, [reelId], { prepare: true });
          const reel = reelResult.rows[0];
          
          if (!reel) {
            console.warn(`Reel ${reelIdString} not found in reels table`);
            return null;
          }
          
          // Get like count from Redis
          let likeCount = await redis.get(`likes:${reelIdString}`);
          if (likeCount === null || likeCount === undefined) {
            likeCount = '0';
          }
          // Ensure it's a string for parseInt
          if (typeof likeCount !== 'string') {
            likeCount = String(likeCount);
          }
          
          // Get comment count from MongoDB
          const commentCount = await mongo.collection('comments').countDocuments({ reelId: reelIdString });
          
          // Convert MinIO direct URLs to proxy URLs if needed
          let mediaUrl = reel.media_url;
          if (mediaUrl) {
            // Check if it's a direct MinIO URL that needs conversion
            if (mediaUrl.includes('localhost:9000') || mediaUrl.includes(':9000/')) {
              // Extract key from MinIO URL format: http://localhost:9000/reels-media/reels/...
              const keyMatch = mediaUrl.match(/\/(reels-media\/.+)$/);
              if (keyMatch) {
                const key = keyMatch[1];
                const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.SERVER_PORT || 3000}`;
                mediaUrl = `${baseUrl}/api/media/${encodeURIComponent(key)}`;
              }
            }
          }
          
          return {
            id: reelIdString,
            mediaUrl: mediaUrl || '',
            caption: reel.caption || '',
            likesCount: (() => {
              const parsed = parseInt(likeCount);
              return isNaN(parsed) ? 0 : parsed;
            })(),
            commentsCount: commentCount,
            createdAt: reel.created_at || row.created_at,
          };
        } catch (error) {
          console.error(`Error enriching reel ${row.reel_id}:`, error);
          return null;
        }
      })
    );
    
    const validReels = enrichedReels.filter(Boolean);
    console.log(`Returning ${validReels.length} valid reels for user ${userId}`);
    
    res.json({
      reels: validReels,
    });
  } catch (error) {
    console.error('Error fetching user reels:', error);
    res.status(500).json({ error: 'Failed to fetch user reels', details: error.message });
  }
});

/**
 * GET /api/reels/:reelId
 * Get a single reel by ID with full details
 */
router.get('/:reelId', async (req, res) => {
  try {
    let { reelId } = req.params;
    
    // Decode URL-encoded reelId
    try {
      reelId = decodeURIComponent(reelId);
    } catch (e) {
      // If decoding fails, use original
      console.warn('Failed to decode reelId, using original:', reelId);
    }
    
    console.log('Fetching reel with ID:', reelId);
    
    const cassandra = getClient();
    const mongo = getDb();
    const redis = require('../db/redis');
    const { Uuid } = require('cassandra-driver').types;
    
    // Convert string ID to UUID
    let reelUuid;
    try {
      // Remove any URL encoding or whitespace
      const cleanReelId = reelId.trim();
      reelUuid = Uuid.fromString(cleanReelId);
      console.log('Converted reelId to UUID:', cleanReelId, '->', reelUuid.toString());
    } catch (error) {
      console.error('Invalid UUID format:', reelId, error.message);
      return res.status(400).json({ 
        error: `Invalid reel ID format: ${reelId}`,
        details: error.message 
      });
    }
    
    // Get reel details from Cassandra
    const reelQuery = 'SELECT * FROM reels WHERE reel_id = ?';
    const reelResult = await cassandra.execute(reelQuery, [reelUuid], { prepare: true });
    const reel = reelResult.rows[0];
    
    if (!reel) {
      console.error('Reel not found in Cassandra:', reelUuid.toString());
      return res.status(404).json({ error: 'Reel not found', reelId: reelId });
    }
    
    console.log('Found reel in Cassandra:', reelUuid.toString());
    
    // Get user info from MongoDB
    let user = { id: reel.user_id, username: 'unknown' };
    try {
      const mongoUser = await mongo.collection('users').findOne({ id: reel.user_id });
      if (mongoUser) {
        user = { 
          id: mongoUser.id, 
          username: mongoUser.username || 'unknown', 
          avatar: mongoUser.avatar 
        };
      }
    } catch (error) {
      console.error(`Error fetching user ${reel.user_id} from MongoDB:`, error);
    }
    
    // Get like count from Redis
    let likeCount = await redis.get(`likes:${reelId}`);
    if (likeCount === null || likeCount === undefined) {
      likeCount = '0';
    }
    // Ensure it's a string for parseInt
    if (typeof likeCount !== 'string') {
      likeCount = String(likeCount);
    }
    
    // Get comments from MongoDB
    const comments = await mongo.collection('comments')
      .find({ reelId: reelId.toString(), parentCommentId: null })
      .sort({ createdAt: -1 })
      .limit(20)
      .toArray();
    
    // Convert MinIO direct URLs to proxy URLs if needed
    let mediaUrl = reel.media_url;
    if (mediaUrl) {
      if (mediaUrl.includes('localhost:9000') || mediaUrl.includes(':9000/')) {
        const keyMatch = mediaUrl.match(/\/(reels-media\/.+)$/);
        if (keyMatch) {
          const key = keyMatch[1];
          const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.SERVER_PORT || 3000}`;
          mediaUrl = `${baseUrl}/api/media/${encodeURIComponent(key)}`;
        }
      }
    }
    
    res.json({
      id: reelId,
      mediaUrl: mediaUrl || '',
      caption: reel.caption || '',
      author: {
        id: user.id,
        username: user.username,
        avatar: user.avatar || null,
      },
      likesCount: (() => {
        const parsed = parseInt(likeCount);
        return isNaN(parsed) ? 0 : parsed;
      })(),
      comments: comments.map(c => ({
        id: c._id.toString(),
        text: c.text,
        author: {
          id: c.userId,
          username: c.username || 'unknown',
        },
        createdAt: c.createdAt,
      })),
      createdAt: reel.created_at,
    });
  } catch (error) {
    console.error('Error fetching reel:', error);
    res.status(500).json({ error: 'Failed to fetch reel', details: error.message });
  }
});

module.exports = router;

