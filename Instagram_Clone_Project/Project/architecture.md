# High-Level Database Architecture

## Overview

This Instagram-like clone uses a **multi-database architecture** where each database is optimized for specific use cases. This design follows the principle of "right tool for the right job" and enables independent scaling of different components.

```
┌─────────────────────────────────────────────────────────────┐
│                    Instagram Clone System                    │
├─────────────────────────────────────────────────────────────┤
│                                                              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │  Redis   │  │ MongoDB  │  │Cassandra │  │  Neo4j   │  │
│  │          │  │          │  │          │  │          │  │
│  │ Likes    │  │ Profiles │  │  Reels   │  │  Graph   │  │
│  │ Counters │  │ Comments │  │  Feed    │  │Relations │  │
│  └──────────┘  └──────────┘  └──────────┘  └──────────┘  │
│                                                              │
│  ┌──────────────────────────────────────────────────────┐   │
│  │                    MinIO                             │   │
│  │              Media Storage (S3)                        │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                              │
└─────────────────────────────────────────────────────────────┘
```

---

## Database Purposes & Justifications

### 1. **Redis** - Like Counters & Status

**Purpose**: Fast like operations and real-time counters

**What it stores:**
- `likes:{reelId}` - Total like count per reel
- `like:{reelId}:{userId}` - User like status (1 = liked)

**Why Redis:**
- Sub-millisecond read/write latency
- Atomic increment/decrement operations
- Supports optimistic UI updates
- High write throughput (millions of likes per second)

**Data Flow:**
```
User clicks like → Redis INCR (instant) → UI updates immediately
                → MongoDB write (async, for durability)
```

---

### 2. **MongoDB** - User Profiles, Comments & Durable Data

**Purpose**: Flexible document storage for user data and comments

**What it stores:**
- `users` collection - User profiles (username, bio, avatar, fullname)
- `comments` collection - Comments with nested replies (`parentCommentId`)
- `likes` collection - Durable like records (backup to Redis)
- `stories` collection - Story metadata with 24-hour expiration
- `follows` collection - Follow relationships (fallback if Neo4j unavailable)

**Why MongoDB:**
- Flexible schema for varying user data
- Easy nested document structures (comment threads)
- Simple queries and sorting
- Rich metadata support

**Data Flow:**
```
User posts comment → MongoDB insert → Return to frontend
User updates profile → MongoDB update → Return updated profile
```

---

### 3. **Cassandra** - Reels Feed & Time-Series Data

**Purpose**: High-throughput feed storage optimized for time-series queries

**What it stores:**
- `reels` table - Reel metadata (id, user_id, caption, media_url, created_at)
- `user_reels` table - User's own reels (partitioned by user_id, sorted by time)
- `timeline` table - Personalized feed (partitioned by user_id, contains reels from followed users)

**Why Cassandra:**
- Optimized for time-series data
- High write throughput (millions of reels)
- Efficient range queries by time
- Partitioned by `user_id` for fast feed queries
- Clustering by `created_at DESC` for chronological order

**Data Flow:**
```
User posts reel → Cassandra: Insert into `reels` and `user_reels`
                → Query Neo4j: Get followers
                → Cassandra: Insert into each follower's `timeline`
                
User views feed → Cassandra: Query `timeline` table (partitioned by user_id)
                → Enrich with user info from MongoDB/Neo4j
                → Get like counts from Redis
                → Get comments from MongoDB
```

---

### 4. **Neo4j** - Social Graph (Follow Relationships)

**Purpose**: Graph database for social relationships

**What it stores:**
- `User` nodes - User entities with properties (id, username, avatar, bio)
- `FOLLOWS` relationships - Directional edges between users

**Why Neo4j:**
- Natural fit for graph structures
- Efficient graph traversals
- Easy queries like "who follows whom"
- Supports recommendations (e.g., "friends of friends")
- Graph algorithms (shortest path, centrality, etc.)

**Data Flow:**
```
User follows another → Neo4j: CREATE (follower)-[:FOLLOWS]->(followed)
                    → MongoDB: Insert into `follows` (fallback)
                    → Cassandra: Update follower's timeline with followed user's reels
```

---

### 5. **MinIO** - Media Storage (S3-Compatible)

**Purpose**: Object storage for video and image files

**What it stores:**
- `reels-media` bucket:
  - `reels/{fileId}.{ext}` - Reel media files
  - `stories/{fileId}.{ext}` - Story media files

**Why MinIO:**
- S3-compatible API (can switch to AWS S3 in production)
- Scalable object storage
- Handles large files efficiently
- Can serve via CDN
- Industry-standard approach

**Data Flow:**
```
User uploads media → MinIO: Store file in bucket
                  → Return URL: /api/media/{key}
                  → URL stored in Cassandra/MongoDB
```

---

## Data Flow Examples

### Example 1: User Posts a Reel

```
1. Upload media → MinIO
   └─> File: reels-media/reels/{uuid}.mp4
   └─> Returns: URL

2. Create reel → Cassandra
   ├─> Insert into `reels` table
   └─> Insert into `user_reels` table

3. Update followers' timelines → Cassandra
   ├─> Query Neo4j: "Who follows this user?"
   └─> For each follower: Insert into `timeline` table

4. Initialize like count → Redis
   └─> SET likes:{reelId} 0
```

### Example 2: User Views Feed

```
1. Get reel IDs → Cassandra
   └─> Query `timeline` table (partitioned by user_id)
   └─> Returns: List of reel_ids with timestamps

2. Enrich with user info → MongoDB/Neo4j
   └─> For each reel: Get author details (username, avatar)

3. Get like counts → Redis
   └─> For each reel: GET likes:{reelId}

4. Get latest comments → MongoDB
   └─> For each reel: Query `comments` collection
   └─> Return top-level comments and replies

5. Combine and return → Frontend
   └─> Display enriched feed
```

### Example 3: User Likes a Reel

```
1. Fast update → Redis
   ├─> INCR likes:{reelId} (atomic increment)
   └─> SET like:{reelId}:{userId} 1 (cache for 30 days)

2. Durable write → MongoDB (async, background)
   └─> Insert into `likes` collection (for analytics/recovery)

3. Return to frontend → Immediate response
   └─> Optimistic UI update (no waiting for MongoDB)
```

---

## Summary Table

| Database | Primary Purpose | Data Stored | Why This Choice? |
|----------|----------------|-------------|------------------|
| **Redis** | Like counters | Like counts, like status | Sub-millisecond latency, atomic operations |
| **MongoDB** | User data & comments | User profiles, comments, stories, durable likes | Flexible schema, easy queries, nested documents |
| **Cassandra** | Reels feed | Reel metadata, timelines, user reels | Time-series optimized, high write throughput, partitioned queries |
| **Neo4j** | Social graph | User nodes, FOLLOWS relationships | Graph traversals, relationship queries, recommendations |
| **MinIO** | Media storage | Video/image files | S3-compatible, scalable, industry-standard |

---

## Design Principles

1. **Right Tool for the Job** - Each database excels at its specific use case
2. **Independent Scaling** - Scale each database based on its workload
3. **Performance** - Optimized data models for each access pattern
4. **Resilience** - Failure in one database doesn't cascade to others
5. **Eventual Consistency** - Redis (fast) + MongoDB (durable) for likes

---

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
- `comments`: Comments on reels (with `parentCommentId` for replies)
- `likes`: Like records (for durability)
- `stories`: Story metadata with expiration
- `follows`: Follow relationships (backup/fallback)

### Neo4j

**Nodes**: `User` with properties: `id`, `username`, `avatar`, `bio`

**Relationships**: `FOLLOWS` (User)-[:FOLLOWS]->(User)

### Redis

**Keys**:
- `likes:{reelId}` - Like count
- `like:{reelId}:{userId}` - User like status

### MinIO

**Bucket**: `reels-media`

**Structure**: 
- `reels/{fileId}.{ext}`
- `stories/{fileId}.{ext}`

---

## Production Considerations

### Scaling

- **Cassandra**: Add more nodes, increase replication factor
- **MongoDB**: Use replica sets, sharding for large scale
- **Neo4j**: Cluster mode for high availability
- **Redis**: Redis Cluster for horizontal scaling
- **MinIO**: Use S3 or distributed MinIO cluster

### Data Consistency

- **Redis + MongoDB**: Eventual consistency (Redis fast, MongoDB durable)
- **Cassandra**: Eventually consistent (tunable consistency levels)
- **Neo4j**: ACID transactions for graph operations

### Backup Strategy

- **Cassandra**: Snapshot backups
- **MongoDB**: Regular dumps
- **Neo4j**: Database backups
- **Redis**: RDB snapshots or AOF
- **MinIO**: Replicate to S3 or backup storage

---

## API Endpoints by Database

### Redis Operations
- `POST /api/likes/:reelId` - Increment like count
- `DELETE /api/likes/:reelId` - Decrement like count
- `GET /api/likes/:reelId` - Get like count

### MongoDB Operations
- `POST /api/users` - Create/update user profile
- `GET /api/users/:userId` - Get user profile
- `POST /api/comments` - Post comment
- `GET /api/comments/:reelId` - Get comments
- `POST /api/stories` - Upload story
- `GET /api/stories` - Get stories feed

### Cassandra Operations
- `GET /api/reels/feed` - Get personalized feed
- `GET /api/reels/user/:userId` - Get user's reels
- `POST /api/reels` - Create new reel

### Neo4j Operations
- `POST /api/users/:userId/follow` - Follow user
- `DELETE /api/users/:userId/follow` - Unfollow user
- `GET /api/users/:userId/followers` - Get followers
- `GET /api/users/:userId/following` - Get following

### MinIO Operations
- `POST /api/media/upload` - Upload media file
- `GET /api/media/:key` - Get media file (proxy)

---

## Benefits of Multi-Database Architecture

1. **Performance**: Each database is optimized for its specific workload
2. **Scalability**: Scale databases independently based on usage patterns
3. **Flexibility**: Choose the best tool for each data type
4. **Resilience**: Failure in one database doesn't affect others
5. **Cost Optimization**: Use expensive databases only where needed
6. **Technology Diversity**: Leverage strengths of different database technologies

---

## Future Enhancements

- **Caching Layer**: Add Redis caching for frequently accessed MongoDB data
- **CDN Integration**: Serve MinIO media through CDN for global distribution
- **Message Queue**: Use Redis Pub/Sub or RabbitMQ for async operations
- **Search**: Add Elasticsearch for full-text search on posts and users
- **Analytics**: Use time-series database (InfluxDB) for analytics
- **Graph Recommendations**: Leverage Neo4j for advanced friend suggestions

