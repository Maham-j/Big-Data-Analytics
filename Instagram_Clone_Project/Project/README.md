# Instagram Clone - Multi-Database Architecture

A minimal but working Instagram-like clone demonstrating how Reels are loaded, how likes and comments are presented, and how user info is stored using multiple databases optimized for different use cases.

## Architecture Overview

### Database Selection & Justification

- **Neo4j**: Social graph (follows/followers relationships)
  - Natural fit for graph traversals
  - Efficient queries for "who follows whom" and recommendations
  
- **Cassandra**: Reels feed (time-series data)
  - Optimized for high write throughput
  - Partitioned by user_id for efficient feed queries
  - Time-ordered clustering for chronological feeds
  
- **MongoDB**: Comments and user profiles
  - Flexible schema for nested comment structures
  - Easy to query and sort comments by reel
  
- **Redis**: Like counters (fast reads/writes)
  - Sub-millisecond latency for counter operations
  - Handles high write throughput
  - Used for optimistic UI updates
  
- **MinIO**: Media storage (S3-compatible)
  - Scalable object storage
  - Industry-standard S3 API
  - Can serve files directly or via CDN

## Prerequisites

- Docker and Docker Compose
- Node.js 16+ (or Python 3.8+ if using Python backend)
- npm or yarn

## Quick Start

### 1. Start Database Services

```bash
# Start all databases
docker-compose up -d

# Wait for services to be ready (about 30-60 seconds)
# Check status
docker-compose ps
```

### 2. Install Dependencies

```bash
# Install Node.js dependencies
npm install
```

### 3. Initialize Databases

```bash
# Create schemas and indexes
npm run init-db
```

### 4. Seed Sample Data

```bash
# Create sample users, reels, comments, and relationships
npm run seed
```

### 5. Start the Server

```bash
# Start the Express server
npm start
```

The server will start on `http://localhost:3000`

### 6. Open the Frontend

Open your browser and navigate to:
```
http://localhost:3000
```

## Complete Command Sequence

```bash
# 1. Start databases
docker-compose up -d

# 2. Wait for databases to be ready (check logs)
docker-compose logs -f

# 3. Install dependencies
npm install

# 4. Initialize database schemas
npm run init-db

# 5. Seed sample data
npm run seed

# 6. Start the server
npm start

# 7. Open browser
# Navigate to http://localhost:3000
```

## Database Credentials

All databases use:
- **Username**: `admin`
- **Password**: `admin12345`

**Exception**: Redis uses password `admin12345` (no username)

## API Endpoints

### Reels
- `GET /api/reels/feed?userId=xxx&page=1&limit=10` - Get feed
- `POST /api/reels` - Create new reel

### Likes
- `POST /api/likes/:reelId` - Like a reel
- `DELETE /api/likes/:reelId` - Unlike a reel
- `GET /api/likes/:reelId?userId=xxx` - Get like count and status

### Comments
- `POST /api/comments` - Post a comment
- `GET /api/comments/:reelId` - Get comments for a reel

### Users
- `POST /api/users` - Create/update user
- `GET /api/users/:userId` - Get user profile
- `POST /api/users/:userId/follow` - Follow a user
- `DELETE /api/users/:userId/follow` - Unfollow a user

### Media
- `POST /api/media/upload` - Upload media file
- `GET /api/media/:key` - Get media file

## Database Schemas

### Cassandra

**Keyspace**: `instagram`

**Tables**:
```cql
CREATE TABLE reels (
    reel_id UUID PRIMARY KEY,
    user_id TEXT,
    caption TEXT,
    media_url TEXT,
    created_at TIMESTAMP
);

CREATE TABLE user_reels (
    user_id TEXT,
    reel_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, created_at, reel_id)
) WITH CLUSTERING ORDER BY (created_at DESC);

CREATE TABLE timeline (
    user_id TEXT,
    reel_id UUID,
    author_id TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, created_at, reel_id)
) WITH CLUSTERING ORDER BY (created_at DESC);
```

### MongoDB

**Database**: `instagram`

**Collections**:
- `users`: User profiles
- `comments`: Comments on reels
- `likes`: Like records (for durability)

### Neo4j

**Nodes**: `User` with properties: `id`, `username`, `avatar`, `bio`

**Relationships**: `FOLLOWS` (User)-[:FOLLOWS]->(User)

### Redis

**Keys**:
- `likes:{reelId}` - Like count
- `like:{reelId}:{userId}` - User like status

### MinIO

**Bucket**: `reels-media`

**Structure**: `reels/{fileId}.{ext}`

## Sample Queries

### Get user's feed (Cassandra)
```cql
SELECT reel_id, author_id, created_at
FROM timeline
WHERE user_id = 'user1'
ORDER BY created_at DESC
LIMIT 10;
```

### Get followers (Neo4j)
```cypher
MATCH (u:User {id: 'user1'})<-[:FOLLOWS]-(follower:User)
RETURN follower.id, follower.username
```

### Get comments for a reel (MongoDB)
```javascript
db.comments.find({ reelId: 'reel-id' }).sort({ createdAt: -1 })
```

### Get like count (Redis)
```bash
GET likes:reel-id
```

## Frontend Features

- ✅ Infinite scroll / pagination for reels feed
- ✅ Like/unlike with optimistic UI updates
- ✅ Post comments
- ✅ View user profiles
- ✅ Switch between users to see different feeds

## Troubleshooting

### Databases not connecting

1. Check if containers are running:
   ```bash
   docker-compose ps
   ```

2. Check logs:
   ```bash
   docker-compose logs redis
   docker-compose logs mongo
   docker-compose logs cassandra
   docker-compose logs neo4j
   docker-compose logs minio
   ```

3. Wait for Cassandra to be fully ready (can take 1-2 minutes):
   ```bash
   docker-compose logs -f cassandra
   # Wait for "Starting listening for CQL clients"
   ```

### Port conflicts

If ports are already in use, modify `docker-compose.yml` to use different ports.

### Reset everything

```bash
# Stop and remove containers
docker-compose down -v

# Remove node_modules
rm -rf node_modules

# Start fresh
docker-compose up -d
npm install
npm run init-db
npm run seed
npm start
```

## Scalability Notes

### Why Multi-DB Design?

1. **Right tool for the job**: Each database excels at its specific use case
2. **Independent scaling**: Scale each database based on its workload
3. **Performance**: Optimized data models for each access pattern
4. **Resilience**: Failure in one database doesn't affect others

### Production Considerations

- Add connection pooling
- Implement caching layers (Redis for frequently accessed data)
- Use CDN for media files
- Add database replication for high availability
- Implement proper error handling and retries
- Add monitoring and logging
- Use message queues for async operations
- Implement rate limiting
- Add authentication and authorization

## Project Structure

```
big-data/
├── docker-compose.yml       # Database services
├── package.json            # Node.js dependencies
├── requirements.txt        # Python dependencies (alternative)
├── server/
│   ├── index.js           # Express server entry point
│   ├── db/                # Database connection modules
│   │   ├── cassandra.js
│   │   ├── mongo.js
│   │   ├── neo4j.js
│   │   ├── redis.js
│   │   └── minio.js
│   ├── routes/            # API route handlers
│   │   ├── reels.js
│   │   ├── likes.js
│   │   ├── comments.js
│   │   ├── users.js
│   │   └── media.js
│   └── scripts/           # Utility scripts
│       ├── init-databases.js
│       └── seed.js
└── frontend/
    └── index.html         # Single-page frontend
```

## License

MIT

