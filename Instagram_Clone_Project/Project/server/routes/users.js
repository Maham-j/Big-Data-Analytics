const express = require('express');
const router = express.Router();
const { getDb } = require('../db/mongo');
const { getDriver, isNeo4jConnected } = require('../db/neo4j');
const { getClient } = require('../db/cassandra');

/**
 * POST /api/users
 * Create or update user profile
 * 
 * Architecture:
 * - Store user profile in MongoDB (flexible schema for bio, avatar, etc.)
 * - Create user node in Neo4j for social graph
 * 
 * Why MongoDB for profiles:
 * - Flexible schema for varying user data
 * - Easy to update and query
 * 
 * Why Neo4j for social graph:
 * - Natural fit for relationships (follows, blocks, etc.)
 * - Efficient graph traversals for recommendations
 */
router.post('/', async (req, res) => {
  try {
    const { id, username, email, avatar, bio, fullname } = req.body;
    
    if (!id || !username) {
      return res.status(400).json({ error: 'id and username are required' });
    }
    
    const mongo = getDb();
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    
    // Get existing user to preserve email if not provided
    const existingUser = await mongo.collection('users').findOne({ id });
    
    // Check if username is already taken by another user
    const usernameTaken = await mongo.collection('users').findOne({ 
      username: username.trim().toLowerCase(),
      id: { $ne: id } // Exclude current user
    });
    
    if (usernameTaken) {
      return res.status(400).json({ error: 'Username is already taken. Please choose a different username.' });
    }
    
    // Store in MongoDB
    await mongo.collection('users').updateOne(
      { id },
      {
        $set: {
          id,
          username: username.trim(),
          email: email || existingUser?.email || null,
          fullname: fullname || username.trim(),
          avatar: avatar || existingUser?.avatar || null,
          bio: bio || null,
          updatedAt: new Date(),
        },
      },
      { upsert: true }
    );
    
    // Create/update in Neo4j (if available)
    if (neo4j) {
      const session = neo4j.session();
      try {
        await session.run(
          'MERGE (u:User {id: $id}) SET u.username = $username, u.avatar = $avatar, u.bio = $bio',
          { id, username: username.trim(), avatar: avatar || null, bio: bio || null }
        );
      } catch (error) {
        console.warn('Failed to update user in Neo4j:', error.message);
      } finally {
        await session.close();
      }
    }
    
    res.json({
      id,
      username: username.trim(),
      fullname: fullname || username.trim(),
      bio: bio || null,
      message: 'User created/updated successfully',
    });
  } catch (error) {
    console.error('Error creating user:', error);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

/**
 * GET /api/users
 * Get all users (for discovery)
 */
router.get('/', async (req, res) => {
  try {
    const mongo = getDb();
    const users = await mongo.collection('users')
      .find({})
      .project({ password: 0 }) // Don't return passwords
      .toArray();
    
    res.json(users.map(u => ({
      id: u.id,
      username: u.username,
      email: u.email,
      avatar: u.avatar,
      bio: u.bio,
    })));
  } catch (error) {
    console.error('Error fetching users:', error);
    res.status(500).json({ error: 'Failed to fetch users' });
  }
});

/**
 * GET /api/users/:userId
 * Get user profile
 */
router.get('/:userId', async (req, res) => {
  try {
    const { userId } = req.params;
    
    const mongo = getDb();
    const user = await mongo.collection('users').findOne({ id: userId });
    
    if (!user) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    // Get follower/following counts from MongoDB (source of truth)
    // We always store in MongoDB, so we use it directly to avoid Neo4j transaction issues
    let followersCount = 0;
    let followingCount = 0;
    
    try {
      followersCount = await mongo.collection('follows').countDocuments({ followedId: userId });
      followingCount = await mongo.collection('follows').countDocuments({ followerId: userId });
    } catch (error) {
      console.warn('Failed to get follower counts from MongoDB:', error.message);
    }
    
    res.json({
      id: user.id,
      username: user.username,
      email: user.email,
      fullname: user.fullname || user.username,
      avatar: user.avatar,
      bio: user.bio,
      followersCount,
      followingCount,
    });
  } catch (error) {
    console.error('Error fetching user:', error);
    res.status(500).json({ error: 'Failed to fetch user' });
  }
});

/**
 * POST /api/users/:userId/follow
 * Follow a user
 * 
 * Architecture:
 * - Create FOLLOWS relationship in Neo4j
 * - Add followed user's reels to follower's timeline in Cassandra
 */
router.post('/:userId/follow', async (req, res) => {
  try {
    const { userId } = req.params;
    const { followerId } = req.body;
    
    if (!followerId) {
      return res.status(400).json({ error: 'followerId is required' });
    }
    
    if (userId === followerId) {
      return res.status(400).json({ error: 'Cannot follow yourself' });
    }
    
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    const cassandra = getClient();
    const mongo = getDb();
    
    // Create follow relationship in Neo4j (if available) AND MongoDB (always store as backup)
    if (neo4j) {
      const session = neo4j.session();
      try {
        await session.run(
          'MATCH (follower:User {id: $followerId}), (followed:User {id: $userId}) MERGE (follower)-[r:FOLLOWS]->(followed) RETURN r',
          { followerId, userId }
        );
        console.log(`Follow relationship created in Neo4j: ${followerId} -> ${userId}`);
      } catch (error) {
        console.error('Error creating follow relationship in Neo4j:', error);
        // Continue to MongoDB fallback
      } finally {
        await session.close();
      }
    }
    
    // Always store in MongoDB (as backup and for fallback when Neo4j unavailable)
    try {
      await mongo.collection('follows').updateOne(
        { followerId, followedId: userId },
        { $set: { followerId, followedId: userId, createdAt: new Date() } },
        { upsert: true }
      );
      console.log(`Follow relationship stored in MongoDB: ${followerId} -> ${userId}`);
    } catch (error) {
      console.error('Error storing follow in MongoDB:', error);
      return res.status(500).json({ error: 'Failed to create follow relationship' });
    }
    
    // Add followed user's recent reels to follower's timeline
    const reelsQuery = `
      SELECT reel_id, created_at
      FROM user_reels
      WHERE user_id = ?
      ORDER BY created_at DESC
      LIMIT 50
    `;
    const reelsResult = await cassandra.execute(reelsQuery, [userId], { prepare: true });
    
    console.log(`Adding ${reelsResult.rows.length} reels to ${followerId}'s timeline from ${userId}`);
    
    for (const row of reelsResult.rows) {
      try {
        await cassandra.execute(
          'INSERT INTO timeline (user_id, reel_id, author_id, created_at) VALUES (?, ?, ?, ?)',
          [followerId, row.reel_id, userId, row.created_at || new Date()],
          { prepare: true }
        );
      } catch (err) {
        // Ignore duplicate key errors
        if (!err.message.includes('duplicate')) {
          console.error('Error adding reel to timeline:', err);
        }
      }
    }
    
    res.json({
      message: 'Followed successfully',
      following: true,
    });
  } catch (error) {
    console.error('Error following user:', error);
    res.status(500).json({ error: 'Failed to follow user' });
  }
});

/**
 * DELETE /api/users/:userId/follow
 * Unfollow a user
 */
router.delete('/:userId/follow', async (req, res) => {
  try {
    const { userId } = req.params;
    const { followerId } = req.body;
    
    if (!followerId) {
      return res.status(400).json({ error: 'followerId is required' });
    }
    
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    const mongo = getDb();
    
    // Remove follow relationship from Neo4j (if available)
    if (neo4j) {
      const session = neo4j.session();
      try {
        await session.run(
          'MATCH (follower:User {id: $followerId})-[r:FOLLOWS]->(followed:User {id: $userId}) DELETE r',
          { followerId, userId }
        );
        console.log(`Follow relationship removed from Neo4j: ${followerId} -> ${userId}`);
      } catch (error) {
        console.error('Error removing follow relationship from Neo4j:', error);
        // Continue to MongoDB removal
      } finally {
        await session.close();
      }
    }
    
    // Always remove from MongoDB (backup and fallback)
    try {
      await mongo.collection('follows').deleteOne({ followerId, followedId: userId });
      console.log(`Follow relationship removed from MongoDB: ${followerId} -> ${userId}`);
    } catch (error) {
      console.error('Error removing follow from MongoDB:', error);
      return res.status(500).json({ error: 'Failed to remove follow relationship' });
    }
    
    // Note: In production, you'd also remove from timeline, but for simplicity we'll leave it
    // (timeline will naturally age out or you can run a cleanup job)
    
    res.json({
      message: 'Unfollowed successfully',
      following: false,
    });
  } catch (error) {
    console.error('Error unfollowing user:', error);
    res.status(500).json({ error: 'Failed to unfollow user' });
  }
});

/**
 * GET /api/users/:userId/followers
 * Get list of followers for a user
 */
router.get('/:userId/followers', async (req, res) => {
  try {
    const { userId } = req.params;
    const mongo = getDb();
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    
    // Get followers from MongoDB (source of truth)
    let followers = [];
    try {
      const follows = await mongo.collection('follows').find({ followedId: userId }).toArray();
      const followerIds = follows.map(f => f.followerId);
      if (followerIds.length > 0) {
        const users = await mongo.collection('users').find({ id: { $in: followerIds } }).toArray();
        followers = users.map(u => ({ id: u.id, username: u.username || 'unknown' }));
      }
    } catch (error) {
      console.error('Failed to get followers from MongoDB:', error.message);
    }
    
    res.json({ followers });
  } catch (error) {
    console.error('Error fetching followers:', error);
    res.status(500).json({ error: 'Failed to fetch followers' });
  }
});

/**
 * GET /api/users/:userId/following
 * Get list of users that a user is following
 */
router.get('/:userId/following', async (req, res) => {
  try {
    const { userId } = req.params;
    const mongo = getDb();
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    
    // Get following from MongoDB (source of truth)
    let following = [];
    try {
      const follows = await mongo.collection('follows').find({ followerId: userId }).toArray();
      const followedIds = follows.map(f => f.followedId);
      if (followedIds.length > 0) {
        const users = await mongo.collection('users').find({ id: { $in: followedIds } }).toArray();
        following = users.map(u => ({ id: u.id, username: u.username || 'unknown' }));
      }
    } catch (error) {
      console.error('Failed to get following from MongoDB:', error.message);
    }
    
    res.json({ following });
  } catch (error) {
    console.error('Error fetching following:', error);
    res.status(500).json({ error: 'Failed to fetch following' });
  }
});

/**
 * GET /api/users/:userId/suggestions
 * Get friend suggestions (friends of friends)
 * 
 * Architecture:
 * - Uses Neo4j graph traversal to find users who are followed by people you follow
 * - Falls back to MongoDB if Neo4j is unavailable
 * - Returns users sorted by mutual connections count
 */
router.get('/:userId/suggestions', async (req, res) => {
  try {
    const { userId } = req.params;
    const { limit = 10 } = req.query;
    
    const mongo = getDb();
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    
    let suggestions = [];
    
    // Try Neo4j first (optimal for graph traversals)
    if (neo4j) {
      try {
        const session = neo4j.session();
        try {
          // Find users who are followed by people you follow (friends of friends)
          // Exclude users you already follow and yourself
          const result = await session.run(
            `MATCH (me:User {id: $userId})-[:FOLLOWS]->(friend:User)-[:FOLLOWS]->(suggestion:User)
             WHERE NOT (me)-[:FOLLOWS]->(suggestion) AND suggestion.id <> $userId
             WITH suggestion, count(friend) as mutualConnections
             RETURN suggestion.id as id, suggestion.username as username, mutualConnections
             ORDER BY mutualConnections DESC
             LIMIT $limit`,
            { userId, limit: parseInt(limit) }
          );
          
          suggestions = result.records.map(record => ({
            id: record.get('id'),
            username: record.get('username') || 'unknown',
            mutualConnections: record.get('mutualConnections').toNumber(),
          }));
          
          console.log(`Found ${suggestions.length} suggestions from Neo4j for user ${userId}`);
        } finally {
          await session.close();
        }
      } catch (error) {
        console.error('Error getting suggestions from Neo4j:', error);
        // Fall through to MongoDB fallback
      }
    }
    
    // MongoDB fallback (if Neo4j unavailable or returned no results)
    if (suggestions.length === 0) {
      try {
        // Get users you follow
        const myFollows = await mongo.collection('follows').find({ followerId: userId }).toArray();
        const followingIds = myFollows.map(f => f.followedId);
        
        if (followingIds.length > 0) {
          // Get users that your friends follow
          const friendsFollows = await mongo.collection('follows')
            .find({ followerId: { $in: followingIds } })
            .toArray();
          
          // Count mutual connections for each suggested user
          const suggestionCounts = {};
          friendsFollows.forEach(follow => {
            const suggestedId = follow.followedId;
            // Exclude yourself and users you already follow
            if (suggestedId !== userId && !followingIds.includes(suggestedId)) {
              suggestionCounts[suggestedId] = (suggestionCounts[suggestedId] || 0) + 1;
            }
          });
          
          // Sort by mutual connections count and get top suggestions
          const sortedSuggestions = Object.entries(suggestionCounts)
            .sort((a, b) => b[1] - a[1])
            .slice(0, parseInt(limit))
            .map(([id, count]) => ({ id, mutualConnections: count }));
          
          // Get user details
          if (sortedSuggestions.length > 0) {
            const suggestedIds = sortedSuggestions.map(s => s.id);
            const users = await mongo.collection('users')
              .find({ id: { $in: suggestedIds } })
              .toArray();
            
            const userMap = {};
            users.forEach(u => {
              userMap[u.id] = u.username || 'unknown';
            });
            
            suggestions = sortedSuggestions.map(s => ({
              id: s.id,
              username: userMap[s.id] || 'unknown',
              mutualConnections: s.mutualConnections,
            }));
          }
          
          console.log(`Found ${suggestions.length} suggestions from MongoDB for user ${userId}`);
        }
      } catch (error) {
        console.error('Error getting suggestions from MongoDB:', error);
      }
    }
    
    // Enrich with user profile data (avatar, bio, etc.)
    if (suggestions.length > 0) {
      const userIds = suggestions.map(s => s.id);
      const users = await mongo.collection('users')
        .find({ id: { $in: userIds } })
        .toArray();
      
      const userMap = {};
      users.forEach(u => {
        userMap[u.id] = {
          id: u.id,
          username: u.username || 'unknown',
          avatar: u.avatar,
          bio: u.bio,
          fullname: u.fullname || u.username,
        };
      });
      
      suggestions = suggestions.map(s => ({
        ...userMap[s.id],
        mutualConnections: s.mutualConnections,
      }));
    }
    
    res.json({ suggestions });
  } catch (error) {
    console.error('Error fetching suggestions:', error);
    res.status(500).json({ error: 'Failed to fetch suggestions', details: error.message });
  }
});

module.exports = router;

