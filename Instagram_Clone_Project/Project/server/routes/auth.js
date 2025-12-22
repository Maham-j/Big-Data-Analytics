const express = require('express');
const router = express.Router();
const { getDb } = require('../db/mongo');
const { getDriver, isNeo4jConnected } = require('../db/neo4j');
const { v4: uuidv4 } = require('uuid');
const crypto = require('crypto');

// Simple password hashing (in production, use bcrypt)
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

/**
 * POST /api/auth/signup
 * Create a new user account
 */
router.post('/signup', async (req, res) => {
  try {
    const { email, fullname, username, password } = req.body;
    
    if (!email || !username || !password) {
      return res.status(400).json({ error: 'Email, username, and password are required' });
    }
    
    const mongo = getDb();
    const userId = uuidv4();
    
    // Check if username or email already exists
    const existingUser = await mongo.collection('users').findOne({
      $or: [{ username }, { email }]
    });
    
    if (existingUser) {
      return res.status(400).json({ error: 'Username or email already exists' });
    }
    
    // Create user in MongoDB
    const hashedPassword = hashPassword(password);
    await mongo.collection('users').insertOne({
      id: userId,
      username,
      email,
      fullname: fullname || username,
      password: hashedPassword,
      bio: '',
      avatar: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    });
    
    // Create user in Neo4j (if available)
    const neo4j = isNeo4jConnected() ? getDriver() : null;
    if (neo4j) {
      const session = neo4j.session();
      try {
        await session.run(
          'MERGE (u:User {id: $id}) SET u.username = $username, u.email = $email',
          { id: userId, username, email }
        );
      } catch (error) {
        console.warn('Failed to create user in Neo4j:', error.message);
      } finally {
        await session.close();
      }
    }
    
    // Generate simple token (in production, use JWT)
    const token = `token-${userId}-${Date.now()}`;
    
    res.json({
      user: {
        id: userId,
        username,
        email,
        fullname: fullname || username,
      },
      token,
    });
  } catch (error) {
    console.error('Error signing up:', error);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

/**
 * POST /api/auth/login
 * Authenticate user and return user info
 */
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    
    const mongo = getDb();
    const hashedPassword = hashPassword(password);
    
    // Find user by username or email
    const user = await mongo.collection('users').findOne({
      $or: [{ username }, { email: username }],
      password: hashedPassword,
    });
    
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }
    
    // Generate simple token (in production, use JWT)
    const token = `token-${user.id}-${Date.now()}`;
    
    res.json({
      user: {
        id: user.id,
        username: user.username,
        email: user.email,
        fullname: user.fullname,
        avatar: user.avatar,
        bio: user.bio,
      },
      token,
    });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(500).json({ error: 'Failed to login' });
  }
});

module.exports = router;

