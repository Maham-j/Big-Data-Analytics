const express = require('express');
const router = express.Router();
const { getDb } = require('../db/mongo');
const { ObjectId } = require('mongodb');

/**
 * POST /api/comments
 * Post a comment on a reel
 * 
 * Architecture:
 * - Store in MongoDB for flexible schema and queryability
 * - Can easily query by reel, user, date range, etc.
 * 
 * Why MongoDB for comments:
 * - Nested document structure fits comment threads
 * - Easy to query and sort
 * - Can store rich metadata (mentions, hashtags, etc.)
 */
router.post('/', async (req, res) => {
  try {
    const { reelId, userId, text, username, parentCommentId } = req.body;
    
    console.log('Comment request:', { reelId, userId, text, username, parentCommentId });
    
    if (!reelId || !userId || !text) {
      return res.status(400).json({ error: 'reelId, userId, and text are required' });
    }
    
    const mongo = getDb();
    
    // Get username from user if not provided
    let finalUsername = username;
    if (!finalUsername) {
      const user = await mongo.collection('users').findOne({ id: userId });
      finalUsername = user ? user.username : 'user';
    }
    
    const comment = {
      reelId: reelId.toString(),
      userId,
      username: finalUsername,
      text: text.trim(),
      parentCommentId: parentCommentId || null, // null for top-level comments
      createdAt: new Date(),
    };
    
    const result = await mongo.collection('comments').insertOne(comment);
    
    console.log('Comment created:', result.insertedId);
    
    res.json({
      id: result.insertedId.toString(),
      reelId: comment.reelId,
      userId: comment.userId,
      username: comment.username,
      text: comment.text,
      parentCommentId: comment.parentCommentId,
      createdAt: comment.createdAt,
    });
  } catch (error) {
    console.error('Error posting comment:', error);
    res.status(500).json({ error: 'Failed to post comment', details: error.message });
  }
});

/**
 * GET /api/comments/:reelId
 * Get comments for a reel
 */
router.get('/:reelId', async (req, res) => {
  try {
    const { reelId } = req.params;
    const { limit = 20, offset = 0 } = req.query;
    
    const mongo = getDb();
    
    // Get all comments for this reel
    const allComments = await mongo.collection('comments')
      .find({ reelId })
      .sort({ createdAt: -1 })
      .toArray();
    
    // Separate top-level comments and replies
    const topLevelComments = allComments.filter(c => !c.parentCommentId);
    const replies = allComments.filter(c => c.parentCommentId);
    
    // Build comment tree
    const commentMap = new Map();
    topLevelComments.forEach(c => {
      commentMap.set(c._id.toString(), {
        id: c._id.toString(),
        text: c.text,
        author: {
          id: c.userId,
          username: c.username,
        },
        createdAt: c.createdAt,
        replies: [],
      });
    });
    
    // Add replies to their parent comments
    replies.forEach(reply => {
      const parentId = reply.parentCommentId?.toString();
      if (commentMap.has(parentId)) {
        commentMap.get(parentId).replies.push({
          id: reply._id.toString(),
          text: reply.text,
          author: {
            id: reply.userId,
            username: reply.username,
          },
          createdAt: reply.createdAt,
          parentCommentId: parentId,
        });
      }
    });
    
    // Convert map to array and apply limit/offset
    const comments = Array.from(commentMap.values())
      .slice(parseInt(offset), parseInt(offset) + parseInt(limit));
    
    res.json({
      comments,
    });
  } catch (error) {
    console.error('Error fetching comments:', error);
    res.status(500).json({ error: 'Failed to fetch comments' });
  }
});

module.exports = router;

