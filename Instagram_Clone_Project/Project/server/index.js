require('dotenv').config();
const express = require('express');
const cors = require('cors');
const path = require('path');
const authRoutes = require('./routes/auth');
const reelsRoutes = require('./routes/reels');
const likesRoutes = require('./routes/likes');
const commentsRoutes = require('./routes/comments');
const usersRoutes = require('./routes/users');
const mediaRoutes = require('./routes/media');
const storiesRoutes = require('./routes/stories');

// Initialize database connections
const { connect: connectMongo } = require('./db/mongo');
const { connect: connectCassandra } = require('./db/cassandra');
const { connect: connectNeo4j } = require('./db/neo4j');
const { initBucket } = require('./db/minio');
const redis = require('./db/redis');

const app = express();
const PORT = process.env.SERVER_PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static files from frontend
app.use(express.static(path.join(__dirname, '../frontend')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/reels', reelsRoutes);
app.use('/api/likes', likesRoutes);
app.use('/api/comments', commentsRoutes);
app.use('/api/users', usersRoutes);
app.use('/api/media', mediaRoutes);
app.use('/api/stories', storiesRoutes);

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Initialize databases and start server
async function start() {
  try {
    console.log('Connecting to databases...');
    await connectMongo();
    await connectCassandra();
    // Redis client auto-connects on import; avoid double connect errors.
    await initBucket();
    
    // Try to connect to Neo4j, but don't fail if it's not available
    try {
      await connectNeo4j();
      console.log('✓ Neo4j connected');
    } catch (error) {
      console.warn('⚠ Neo4j not available - server will continue without social graph features');
      console.warn('   To enable Neo4j: docker-compose up -d neo4j');
      console.warn('   Wait for it to start, then restart the server');
    }
    
    console.log('All databases connected!');
    
    app.listen(PORT, () => {
      console.log(`Server running on http://localhost:${PORT}`);
      console.log(`Frontend available at http://localhost:${PORT}`);
    });
  } catch (error) {
    console.error('Failed to start server:', error);
    process.exit(1);
  }
}

start();

