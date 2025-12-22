# Big Data Principles Implementation

This document shows where each Big Data principle is implemented in the codebase with specific code blocks.

---

## 1. Distributed Storage (Cassandra, MongoDB)

### Implementation: Cassandra - Distributed Keyspace with Replication

**File**: `server/db/cassandra.js`

```javascript
// Create keyspace with replication strategy
await client.execute(`
  CREATE KEYSPACE IF NOT EXISTS instagram
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 2}
`);

// Partitioned tables for distributed storage
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

**Why**: 
- `replication_factor` enables data replication across nodes
- Partitioned by `user_id` for distributed storage
- Clustering by `created_at` for efficient time-series queries

---

### Implementation: MongoDB - Distributed Document Storage

**File**: `server/db/mongo.js`

```javascript
// MongoDB connection with replica set support
const uri = process.env.MONGO_URI || 
  `mongodb://${mongoUser}:${mongoPass}@${mongoHost}:${mongoPort}/${mongoDb}?authSource=admin`;

const client = new MongoClient(uri);

// Collections are automatically distributed across shards in production
await client.connect();
db = client.db('instagram');
```

**Why**:
- MongoDB supports replica sets and sharding for horizontal distribution
- Collections (`users`, `comments`, `follows`) are stored across multiple nodes
- Automatic data distribution based on shard key

---

## 2. High Throughput (Redis, Cassandra)

### Implementation: Redis - High Throughput Like Operations

**File**: `server/routes/likes.js`

```javascript
router.post('/:reelId', async (req, res) => {
  const { reelId } = req.params;
  const { userId } = req.body;
  
  const key = `likes:${reelId}`;
  const userLikeKey = `like:${reelId}:${userId}`;
  
  // Atomic increment operation - handles millions of likes per second
  const newCount = await redis.incr(key);
  await redis.set(userLikeKey, '1', { EX: 86400 * 30 });
  
  // Async write to MongoDB for durability (non-blocking)
  mongo.collection('likes').insertOne({
    reelId,
    userId,
    createdAt: new Date(),
  }).catch(err => console.error('Error persisting like:', err));
  
  res.json({ likesCount: newCount, liked: true });
});
```

**Why**:
- `redis.incr()` is atomic and sub-millisecond latency
- Can handle millions of operations per second
- Non-blocking async writes to MongoDB

---

### Implementation: Cassandra - High Throughput Reel Creation

**File**: `server/routes/reels.js`

```javascript
router.post('/', async (req, res) => {
  const { userId, caption, mediaUrl } = req.body;
  const cassandra = getClient();
  const reelId = Uuid.random();
  const now = new Date();
  
  // High-throughput writes - optimized for millions of reels
  await cassandra.execute(
    'INSERT INTO reels (reel_id, user_id, caption, media_url, created_at) VALUES (?, ?, ?, ?, ?)',
    [reelId, userId, caption || '', mediaUrl, now],
    { prepare: true }
  );
  
  // Insert into user_reels (partitioned by user_id)
  await cassandra.execute(
    'INSERT INTO user_reels (user_id, reel_id, created_at) VALUES (?, ?, ?)',
    [userId, reelId, now],
    { prepare: true }
  );
  
  // Batch insert into followers' timelines
  for (const followerId of followers) {
    await cassandra.execute(
      'INSERT INTO timeline (user_id, reel_id, author_id, created_at) VALUES (?, ?, ?, ?)',
      [followerId, reelId, userId, now],
      { prepare: true }
    );
  }
});
```

**Why**:
- Cassandra handles high write throughput (millions of writes/second)
- Partitioned tables distribute load across nodes
- Prepared statements optimize performance

---

## 3. Eventual Consistency (Redis + MongoDB)

### Implementation: Eventual Consistency Pattern for Likes

**File**: `server/routes/likes.js`

```javascript
/**
 * Architecture:
 * - Fast increment in Redis (optimistic UI update)
 * - Async write to MongoDB for durability and analytics
 * 
 * Why Redis for likes:
 * - Sub-millisecond latency for counter operations
 * - Handles high write throughput
 * 
 * Why MongoDB for durability:
 * - Flexible schema for like metadata (user, timestamp, etc.)
 * - Queryable for analytics and user-specific queries
 */
router.post('/:reelId', async (req, res) => {
  // Step 1: Fast write to Redis (immediate response)
  const newCount = await redis.incr(key);
  await redis.set(userLikeKey, '1', { EX: 86400 * 30 });
  
  // Step 2: Async write to MongoDB (eventual consistency)
  // Don't wait - MongoDB will catch up eventually
  const mongo = getDb();
  mongo.collection('likes').insertOne({
    reelId,
    userId,
    createdAt: new Date(),
  }).catch(err => console.error('Error persisting like:', err));
  
  // Return immediately with Redis value
  res.json({ likesCount: newCount, liked: true });
});
```

**Why**:
- Redis provides immediate response (strong consistency for reads)
- MongoDB provides durability (eventual consistency for persistence)
- If Redis fails, can rebuild from MongoDB
- If MongoDB is slow, Redis still serves reads

---

### Implementation: Eventual Consistency for Follow Relationships

**File**: `server/routes/users.js`

```javascript
router.post('/:userId/follow', async (req, res) => {
  const neo4j = isNeo4jConnected() ? getDriver() : null;
  const mongo = getDb();
  
  // Write to Neo4j (if available) - primary source
  if (neo4j) {
    const session = neo4j.session();
    await session.run(
      'MATCH (follower:User {id: $followerId}), (followed:User {id: $userId}) MERGE (follower)-[r:FOLLOWS]->(followed)',
      { followerId, userId }
    );
    await session.close();
  }
  
  // Always store in MongoDB (backup/fallback) - eventual consistency
  await mongo.collection('follows').updateOne(
    { followerId, followedId: userId },
    { $set: { followerId, followedId: userId, createdAt: new Date() } },
    { upsert: true }
  );
  
  // Both systems will eventually have the same data
});
```

**Why**:
- Neo4j is primary for graph queries (fast)
- MongoDB is backup/fallback (durable)
- If Neo4j fails, MongoDB serves as source of truth
- Data eventually consistent between both systems

---

## 4. Horizontal Scaling (All Components)

### Implementation: Docker Compose - Scalable Architecture

**File**: `docker-compose.yml`

```yaml
services:
  redis:
    image: redis:7-alpine
    # Can scale: docker-compose up -d --scale redis=3
    # Use Redis Cluster for horizontal scaling
    
  mongo:
    image: mongo:7
    # Supports replica sets and sharding
    # Scale: Add more nodes to replica set
    
  cassandra:
    image: cassandra:4.1
    # Native horizontal scaling - add more nodes
    # replication_factor can be increased for more replicas
    
  neo4j:
    image: neo4j:5
    # Supports cluster mode for horizontal scaling
    
  minio:
    image: minio/minio
    # Supports distributed MinIO cluster
```

**Why**:
- Each service can be scaled independently
- Cassandra and MongoDB support native clustering
- Redis supports Redis Cluster mode
- MinIO supports distributed mode

---

### Implementation: Cassandra Connection Pooling for Scaling

**File**: `server/db/cassandra.js`

```javascript
const cassandraConfig = {
  contactPoints: [process.env.CASSANDRA_HOSTS?.split(':')[0] || 'localhost'],
  port: parseInt(process.env.CASSANDRA_HOSTS?.split(':')[1] || '9042'),
  localDataCenter: 'datacenter1',
  // Connection pooling for horizontal scaling
  // Can connect to multiple nodes
};

const client = new cassandra.Client(cassandraConfig);

// Keyspace with replication for horizontal scaling
await client.execute(`
  CREATE KEYSPACE IF NOT EXISTS instagram
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
`);
```

**Why**:
- `contactPoints` can list multiple nodes
- Replication factor enables data distribution
- Client automatically load balances across nodes

---

### Implementation: MongoDB Connection String for Scaling

**File**: `server/db/mongo.js`

```javascript
// Connection string supports replica sets and sharding
const uri = process.env.MONGO_URI || 
  `mongodb://${mongoUser}:${mongoPass}@${mongoHost}:${mongoPort}/${mongoDb}?authSource=admin`;

// For replica sets:
// mongodb://host1:27017,host2:27017,host3:27017/instagram?replicaSet=rs0

// For sharding:
// mongodb://mongos1:27017,mongos2:27017/instagram

const client = new MongoClient(uri);
```

**Why**:
- Connection string can include multiple hosts
- Automatic failover and load balancing
- Supports replica sets and sharded clusters

---

## 5. Fault Tolerance (Replication Everywhere)

### Implementation: Neo4j Fallback to MongoDB

**File**: `server/routes/reels.js`

```javascript
// Get followers from Neo4j (or MongoDB fallback)
let followers = [];

if (neo4j) {
  try {
    const session = neo4j.session({ defaultAccessMode: neo4jDriver.session.READ });
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

// Fallback to MongoDB if Neo4j not available
if (followers.length === 0) {
  try {
    const follows = await mongo.collection('follows').find({ followedId: userId }).toArray();
    followers = follows.map(f => f.followerId);
    console.log(`Found ${followers.length} followers from MongoDB for user ${userId}`);
  } catch (error) {
    console.warn('Failed to get followers from MongoDB:', error.message);
  }
}
```

**Why**:
- If Neo4j fails, MongoDB serves as backup
- System continues to function
- Data replicated in both systems

---

### Implementation: Redis + MongoDB Dual Write for Fault Tolerance

**File**: `server/routes/likes.js`

```javascript
// Fast write to Redis
const newCount = await redis.incr(key);
await redis.set(userLikeKey, '1', { EX: 86400 * 30 });

// Async write to MongoDB for fault tolerance
// If Redis fails, can rebuild from MongoDB
const mongo = getDb();
mongo.collection('likes').insertOne({
  reelId,
  userId,
  createdAt: new Date(),
}).catch(err => console.error('Error persisting like:', err));
```

**Why**:
- Redis provides fast access (primary)
- MongoDB provides durability (backup)
- If Redis fails, can rebuild cache from MongoDB
- If MongoDB fails, Redis still serves reads

---

### Implementation: Follow Relationship Replication

**File**: `server/routes/users.js`

```javascript
router.post('/:userId/follow', async (req, res) => {
  // Write to Neo4j (primary)
  if (neo4j) {
    const session = neo4j.session();
    try {
      await session.run(
        'MATCH (follower:User {id: $followerId}), (followed:User {id: $userId}) MERGE (follower)-[r:FOLLOWS]->(followed)',
        { followerId, userId }
      );
    } catch (error) {
      console.error('Error creating follow relationship in Neo4j:', error);
      // Continue to MongoDB fallback
    } finally {
      await session.close();
    }
  }
  
  // Always store in MongoDB (replication for fault tolerance)
  await mongo.collection('follows').updateOne(
    { followerId, followedId: userId },
    { $set: { followerId, followedId: userId, createdAt: new Date() } },
    { upsert: true }
  );
});
```

**Why**:
- Data replicated in both Neo4j and MongoDB
- If one system fails, other continues
- MongoDB serves as source of truth for counts

---

### Implementation: Cassandra Replication Configuration

**File**: `server/db/cassandra.js`

```javascript
// Keyspace with replication for fault tolerance
await client.execute(`
  CREATE KEYSPACE IF NOT EXISTS instagram
  WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 2}
`);
```

**Production Configuration** (for fault tolerance):
```cql
CREATE KEYSPACE instagram
WITH replication = {
  'class': 'NetworkTopologyStrategy',
  'datacenter1': 3,  -- 3 replicas in datacenter1
  'datacenter2': 2   -- 2 replicas in datacenter2
};
```

**Why**:
- `replication_factor` determines number of replicas
- Data automatically replicated across nodes
- If one node fails, data available on other nodes
- Can survive multiple node failures with higher replication factor

---

## Summary Table

| Principle | Implementation | Code Location | Key Features |
|-----------|---------------|---------------|--------------|
| **Distributed Storage** | Cassandra keyspace with replication | `server/db/cassandra.js` | Partitioned tables, replication factor |
| **Distributed Storage** | MongoDB collections | `server/db/mongo.js` | Replica sets, sharding support |
| **High Throughput** | Redis atomic operations | `server/routes/likes.js` | `redis.incr()`, async writes |
| **High Throughput** | Cassandra batch inserts | `server/routes/reels.js` | Prepared statements, partitioned writes |
| **Eventual Consistency** | Redis + MongoDB dual write | `server/routes/likes.js` | Fast Redis, async MongoDB |
| **Eventual Consistency** | Neo4j + MongoDB fallback | `server/routes/users.js` | Primary Neo4j, backup MongoDB |
| **Horizontal Scaling** | Docker Compose services | `docker-compose.yml` | Independent scaling per service |
| **Horizontal Scaling** | Multi-node connections | `server/db/cassandra.js`, `server/db/mongo.js` | Multiple contact points |
| **Fault Tolerance** | Neo4j → MongoDB fallback | `server/routes/reels.js` | Automatic fallback on failure |
| **Fault Tolerance** | Redis + MongoDB replication | `server/routes/likes.js` | Dual write, rebuild capability |
| **Fault Tolerance** | Cassandra replication | `server/db/cassandra.js` | Replication factor, multi-datacenter |

---

## Production Recommendations

### For Distributed Storage:
- Increase Cassandra `replication_factor` to 3+ for production
- Configure MongoDB replica sets with 3+ nodes
- Use NetworkTopologyStrategy for multi-datacenter Cassandra

### For High Throughput:
- Use Redis Cluster for horizontal scaling
- Increase Cassandra nodes for write throughput
- Use connection pooling and prepared statements

### For Eventual Consistency:
- Monitor sync lag between Redis and MongoDB
- Implement background jobs to sync data
- Use MongoDB change streams for real-time sync

### For Horizontal Scaling:
- Deploy Cassandra cluster with 3+ nodes
- Configure MongoDB sharded cluster
- Use Redis Cluster mode
- Load balance across multiple application servers

### For Fault Tolerance:
- Set Cassandra replication_factor to 3+
- Configure MongoDB replica sets with automatic failover
- Use Redis Sentinel or Cluster for high availability
- Implement health checks and automatic failover

