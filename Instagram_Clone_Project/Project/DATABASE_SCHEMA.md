# Database Schema & Data Storage Guide

This document explains what data is stored in each database and why.

## Overview

| Database | Purpose | Data Stored | Why This Database? |
|----------|---------|-------------|-------------------|
| **Cassandra** | Reels Feed | Reels metadata, timelines, user reels | Time-series, high write throughput, partitioned by user |
| **MongoDB** | User Profiles & Comments | User profiles, comments, likes (durability) | Flexible schema, easy queries, nested documents |
| **Neo4j** | Social Graph | Users, follow relationships | Graph queries, relationship traversals |
| **Redis** | Like Counters | Like counts, like status | Sub-millisecond reads, high write throughput |
| **MinIO** | Media Storage | Video/images files | S3-compatible, scalable object storage |

---

## 1. Cassandra - Reels Feed Data

### Tables

#### `reels` table
**Purpose**: Store reel metadata
```cql
CREATE TABLE reels (
    reel_id UUID PRIMARY KEY,
    user_id TEXT,
    caption TEXT,
    media_url TEXT,
    created_at TIMESTAMP
);
```

**Data Stored**:
- `reel_id`: Unique identifier for each reel
- `user_id`: Who created the reel
- `caption`: Text description
- `media_url`: URL to media file in MinIO
- `created_at`: When reel was created

**Why Cassandra?**
- Optimized for time-series data
- High write throughput (millions of reels)
- Efficient range queries by time

---

#### `user_reels` table
**Purpose**: User's own reels (for profile view)
```cql
CREATE TABLE user_reels (
    user_id TEXT,
    reel_id UUID,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, created_at, reel_id)
) WITH CLUSTERING ORDER BY (created_at DESC);
```

**Data Stored**:
- `user_id`: Partition key (all reels for a user)
- `reel_id`: The reel
- `created_at`: Clustering key (sorted by time, newest first)

**Why This Structure?**
- Partitioned by `user_id` for fast profile queries
- Sorted by `created_at DESC` for chronological order
- Efficient: "Get all reels by user X, newest first"

---

#### `timeline` table
**Purpose**: Home feed (reels from followed users)
```cql
CREATE TABLE timeline (
    user_id TEXT,
    reel_id UUID,
    author_id TEXT,
    created_at TIMESTAMP,
    PRIMARY KEY (user_id, created_at, reel_id)
) WITH CLUSTERING ORDER BY (created_at DESC);
```

**Data Stored**:
- `user_id`: Who's feed this is (partition key)
- `reel_id`: The reel to show
- `author_id`: Who created the reel
- `created_at`: When to show it (sorted newest first)

**Why This Structure?**
- Each user's feed is a partition
- When user follows someone, their reels are added to user's timeline
- Fast query: "Get my feed" = single partition read

**When Data is Written**:
- When user A follows user B → B's recent reels added to A's timeline
- When user B posts new reel → added to all followers' timelines

---

## 2. MongoDB - User Profiles & Comments

### Collections

#### `users` collection
**Purpose**: User profile information
```javascript
{
  _id: ObjectId,
  id: "user1",              // Unique user ID
  username: "alice",        // Display name
  email: "alice@example.com",
  avatar: "https://...",    // Profile picture URL
  bio: "Photography enthusiast",
  createdAt: ISODate,
  updatedAt: ISODate
}
```

**Data Stored**:
- User profile information
- Display preferences
- Metadata

**Why MongoDB?**
- Flexible schema (easy to add fields)
- Easy to update profiles
- Good for document-based data

---

#### `comments` collection
**Purpose**: Comments on reels
```javascript
{
  _id: ObjectId,
  reelId: "uuid-string",    // Which reel
  userId: "user1",          // Who commented
  username: "alice",        // Display name
  text: "Amazing! 😍",       // Comment text
  createdAt: ISODate        // When commented
}
```

**Data Stored**:
- Comment text
- Author information
- Timestamp
- Reference to reel

**Why MongoDB?**
- Easy to query: "Get all comments for reel X"
- Can add nested replies later
- Flexible for rich text, mentions, hashtags

**Indexes** (should create):
- `{ reelId: 1, createdAt: -1 }` - Fast comment retrieval
- `{ userId: 1 }` - User's comment history

---

#### `likes` collection (optional, for durability)
**Purpose**: Persistent record of likes (backup to Redis)
```javascript
{
  _id: ObjectId,
  reelId: "uuid-string",
  userId: "user1",
  createdAt: ISODate
}
```

**Why Store Here?**
- Redis is fast but volatile
- MongoDB provides durability
- Can rebuild Redis cache if needed
- Analytics: "Which reels are most liked?"

---

## 3. Neo4j - Social Graph

### Nodes

#### `User` node
**Purpose**: Represent users in the graph
```cypher
(:User {
  id: "user1",
  username: "alice",
  avatar: "https://...",
  bio: "Photography enthusiast"
})
```

**Data Stored**:
- User identity
- Basic profile info (synced from MongoDB)

---

### Relationships

#### `FOLLOWS` relationship
**Purpose**: Represent who follows whom
```cypher
(user1:User)-[:FOLLOWS]->(user2:User)
```

**Data Stored**:
- Source user (follower)
- Target user (followed)
- Implicit timestamp (can add properties if needed)

**Why Neo4j?**
- Natural graph structure
- Fast queries: "Who does user X follow?"
- Efficient: "Get followers of user Y"
- Can traverse: "Friends of friends" recommendations

**Example Queries**:
```cypher
// Get all followers of user1
MATCH (u:User {id: "user1"})<-[:FOLLOWS]-(follower:User)
RETURN follower

// Get mutual follows
MATCH (u1:User {id: "user1"})-[:FOLLOWS]->(mutual:User)<-[:FOLLOWS]-(u2:User {id: "user2"})
RETURN mutual
```

---

## 4. Redis - Like Counters

### Keys

#### `likes:{reelId}`
**Purpose**: Like count for a reel
```
Key: "likes:abc-123-def"
Value: "42"
Type: String (number)
```

**Data Stored**:
- Reel ID
- Current like count

**Operations**:
- `INCR likes:abc-123-def` - Increment (like)
- `DECR likes:abc-123-def` - Decrement (unlike)
- `GET likes:abc-123-def` - Get count

---

#### `like:{reelId}:{userId}`
**Purpose**: Track if user liked a reel
```
Key: "like:abc-123-def:user1"
Value: "1"
TTL: 30 days
```

**Data Stored**:
- Reel ID + User ID
- Like status (1 = liked, missing = not liked)

**Why This?**
- Fast check: "Did user X like reel Y?"
- Optimistic UI updates
- TTL prevents Redis from growing too large

---

## 5. MinIO - Media Storage

### Bucket Structure

#### `reels-media` bucket
**Purpose**: Store video/image files

**Structure**:
```
reels-media/
  ├── reels/
  │   ├── {uuid1}.mp4
  │   ├── {uuid2}.jpg
  │   └── {uuid3}.mp4
```

**Data Stored**:
- Video files (MP4, MOV, etc.)
- Image files (JPG, PNG, etc.)
- Metadata (content-type, size)

**File Naming**:
- `reels/{fileId}.{ext}`
- Example: `reels/550e8400-e29b-41d4-a716-446655440000.mp4`

**Why MinIO?**
- S3-compatible API
- Scalable (can use S3 in production)
- Can serve via CDN
- Handles large files efficiently

---

## Data Flow Examples

### 1. User Posts a Reel

1. **Upload media** → MinIO
   - File stored in `reels-media/reels/{uuid}.mp4`
   - Returns URL: `http://minio:9000/reels-media/reels/{uuid}.mp4`

2. **Create reel record** → Cassandra
   - Insert into `reels` table
   - Insert into `user_reels` table

3. **Add to followers' timelines** → Cassandra
   - Query Neo4j: "Who follows this user?"
   - For each follower: Insert into `timeline` table

4. **Initialize like count** → Redis
   - `SET likes:{reelId} 0`

---

### 2. User Likes a Reel

1. **Fast update** → Redis
   - `INCR likes:{reelId}`
   - `SET like:{reelId}:{userId} 1`

2. **Durable write** → MongoDB (async, background)
   - Insert into `likes` collection
   - For analytics and recovery

---

### 3. User Comments on Reel

1. **Store comment** → MongoDB
   - Insert into `comments` collection
   - Indexed by `reelId` for fast retrieval

---

### 4. User Follows Another User

1. **Create relationship** → Neo4j
   - `MERGE (follower)-[:FOLLOWS]->(followed)`

2. **Update timelines** → Cassandra
   - Get followed user's recent reels
   - Add to follower's `timeline` table

---

## Summary: What Goes Where

| Data Type | Database | Reason |
|-----------|----------|--------|
| Reel metadata | Cassandra | Time-series, high write |
| User profiles | MongoDB | Flexible schema |
| Comments | MongoDB | Easy queries, nested data |
| Follow relationships | Neo4j | Graph structure |
| Like counts | Redis | Fast reads/writes |
| Like status | Redis | Fast lookups |
| Media files | MinIO | Object storage |
| Timeline feeds | Cassandra | Partitioned by user |

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

