require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { connect: connectMongo, getDb } = require('../db/mongo');
const { connect: connectCassandra, getClient } = require('../db/cassandra');
const { connect: connectNeo4j, getDriver } = require('../db/neo4j');
const redis = require('../db/redis');
const { s3, BUCKET, initBucket } = require('../db/minio');
const { v4: uuidv4 } = require('uuid');
const { Uuid } = require('cassandra-driver').types;

// Password hashing
const crypto = require('crypto');
function hashPassword(password) {
  return crypto.createHash('sha256').update(password).digest('hex');
}

// Random selection helper
function randomChoice(array) {
  return array[Math.floor(Math.random() * array.length)];
}

// Random number between min and max (inclusive)
function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Shuffle array
function shuffle(array) {
  const arr = [...array];
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function clearAllDatabases() {
  console.log('Clearing all databases...');
  
  const mongo = getDb();
  const cassandra = getClient();
  const neo4j = getDriver();
  
  try {
    // Clear MongoDB
    console.log('  Clearing MongoDB...');
    await mongo.collection('users').deleteMany({});
    await mongo.collection('comments').deleteMany({});
    await mongo.collection('likes').deleteMany({});
    await mongo.collection('stories').deleteMany({});
    await mongo.collection('follows').deleteMany({});
    console.log('  ✓ MongoDB cleared');
  } catch (error) {
    console.error('  ✗ Error clearing MongoDB:', error.message);
  }
  
  try {
    // Clear Cassandra
    console.log('  Clearing Cassandra...');
    await cassandra.execute('TRUNCATE reels');
    await cassandra.execute('TRUNCATE user_reels');
    await cassandra.execute('TRUNCATE timeline');
    console.log('  ✓ Cassandra cleared');
  } catch (error) {
    console.error('  ✗ Error clearing Cassandra:', error.message);
  }
  
  try {
    // Clear Neo4j
    console.log('  Clearing Neo4j...');
    const session = neo4j.session();
    await session.run('MATCH (n) DETACH DELETE n');
    await session.close();
    console.log('  ✓ Neo4j cleared');
  } catch (error) {
    console.warn('  ⚠ Neo4j not available or already empty');
  }
  
  try {
    // Clear Redis
    console.log('  Clearing Redis...');
    const keys = await redis.keys('*');
    if (keys.length > 0) {
      await redis.del(...keys);
    }
    console.log('  ✓ Redis cleared');
  } catch (error) {
    console.error('  ✗ Error clearing Redis:', error.message);
  }
  
  try {
    // Clear MinIO
    console.log('  Clearing MinIO...');
    await initBucket();
    const listResult = await s3.listObjectsV2({ Bucket: BUCKET }).promise();
    if (listResult.Contents && listResult.Contents.length > 0) {
      const objects = listResult.Contents.map(obj => ({ Key: obj.Key }));
      await s3.deleteObjects({
        Bucket: BUCKET,
        Delete: { Objects: objects }
      }).promise();
    }
    console.log('  ✓ MinIO cleared');
  } catch (error) {
    console.error('  ✗ Error clearing MinIO:', error.message);
  }
  
  console.log('✓ All databases cleared\n');
}

async function seed() {
  console.log('Starting custom seed...\n');
  
  let neo4jConnected = false;
  let neo4j = null;
  
  try {
    // Connect to all databases
    await connectMongo();
    await connectCassandra();
    await initBucket();
    await new Promise(resolve => setTimeout(resolve, 500)); // Wait for Redis
    
    // Try to connect to Neo4j
    try {
      await connectNeo4j();
      neo4j = getDriver();
      neo4jConnected = true;
      console.log('✓ Neo4j connected');
    } catch (error) {
      console.warn('⚠ Neo4j not available - continuing without social graph features');
    }
    
    const mongo = getDb();
    const cassandra = getClient();
    
    // Clear all databases first
    await clearAllDatabases();
    
    // Define users
    const usernames = ['eman', 'maham', 'musqan', 'ayesha', 'zainab', 'areeba', 'laraib', 'adan', 'fatima', 'abeer'];
    const users = usernames.map((username, index) => ({
      id: `user${index + 1}`,
      username: username,
      email: `${username}@example.com`,
      fullname: username.charAt(0).toUpperCase() + username.slice(1),
      bio: `Hello! I'm ${username.charAt(0).toUpperCase() + username.slice(1)}`,
      password: '123',
    }));
    
    console.log('Creating users...');
    for (const user of users) {
      // MongoDB
      await mongo.collection('users').insertOne({
        id: user.id,
        username: user.username,
        email: user.email,
        fullname: user.fullname,
        bio: user.bio,
        password: hashPassword(user.password),
        avatar: null,
        createdAt: new Date(),
        updatedAt: new Date(),
      });
      
      // Neo4j
      if (neo4jConnected && neo4j) {
        try {
          const session = neo4j.session();
          await session.run(
            'MERGE (u:User {id: $id}) SET u.username = $username, u.email = $email, u.bio = $bio',
            { id: user.id, username: user.username, email: user.email, bio: user.bio }
          );
          await session.close();
        } catch (error) {
          console.warn(`  Warning: Failed to create user ${user.id} in Neo4j`);
        }
      }
    }
    console.log(`✓ Created ${users.length} users\n`);
    
    // Get images from images folder
    const imagesDir = path.join(__dirname, '../../..', 'images');
    let imageFiles = [];
    
    try {
      if (fs.existsSync(imagesDir)) {
        imageFiles = fs.readdirSync(imagesDir)
          .filter(file => /\.(jpg|jpeg|png|gif)$/i.test(file))
          .map(file => path.join(imagesDir, file));
        console.log(`Found ${imageFiles.length} images in images folder`);
      } else {
        console.warn(`⚠ Images folder not found at ${imagesDir}`);
        console.warn('  Using placeholder images instead');
      }
    } catch (error) {
      console.warn('⚠ Error reading images folder:', error.message);
      console.warn('  Using placeholder images instead');
    }
    
    // Upload images to MinIO and create posts
    console.log('Creating posts with images...');
    const reels = [];
    const captions = [
      'Beautiful day! ☀️',
      'Amazing view! 🌄',
      'Love this! ❤️',
      'So beautiful! 😍',
      'Great shot! 📸',
      'Wonderful! ✨',
      'Amazing! 🌟',
      'Perfect! 💯',
      'Stunning! 🔥',
      'Incredible! 🎉',
    ];
    
    // Distribute images randomly among users
    const shuffledUsers = shuffle(users);
    const shuffledImages = imageFiles.length > 0 ? shuffle(imageFiles) : [];
    
    // Create 2-4 posts per user
    let imageIndex = 0;
    for (let i = 0; i < users.length; i++) {
      const user = shuffledUsers[i];
      const numPosts = randomInt(2, 4);
      
      for (let j = 0; j < numPosts; j++) {
        const reelId = uuidv4();
        const reelUuid = Uuid.fromString(reelId);
        const caption = randomChoice(captions);
        let mediaUrl;
        let mediaKey;
        
        // Upload image to MinIO if available
        if (shuffledImages.length > 0) {
          // Cycle through images, reusing if needed
          const imagePath = shuffledImages[imageIndex % shuffledImages.length];
          imageIndex++;
          
          const imageBuffer = fs.readFileSync(imagePath);
          const ext = path.extname(imagePath).toLowerCase();
          mediaKey = `reels/${reelId}${ext}`;
          
          // Determine content type
          let contentType = 'image/jpeg';
          if (ext === '.png') contentType = 'image/png';
          else if (ext === '.gif') contentType = 'image/gif';
          else if (ext === '.jpg' || ext === '.jpeg') contentType = 'image/jpeg';
          
          try {
            await s3.putObject({
              Bucket: BUCKET,
              Key: mediaKey,
              Body: imageBuffer,
              ContentType: contentType,
            }).promise();
            
            const baseUrl = process.env.SERVER_URL || `http://localhost:${process.env.SERVER_PORT || 3000}`;
            mediaUrl = `${baseUrl}/api/media/${encodeURIComponent(mediaKey)}`;
          } catch (error) {
            console.warn(`  Warning: Failed to upload image ${imagePath}, using placeholder`);
            mediaUrl = `https://picsum.photos/400/600?random=${reelId}`;
          }
        } else {
          // Use placeholder if no images
          mediaUrl = `https://picsum.photos/400/600?random=${reelId}`;
        }
        
        const createdAt = new Date(Date.now() - randomInt(0, 7) * 24 * 60 * 60 * 1000); // Random time in last 7 days
        
        // Store in Cassandra
        await cassandra.execute(
          'INSERT INTO reels (reel_id, user_id, caption, media_url, created_at) VALUES (?, ?, ?, ?, ?)',
          [reelUuid, user.id, caption, mediaUrl, createdAt],
          { prepare: true }
        );
        
        await cassandra.execute(
          'INSERT INTO user_reels (user_id, reel_id, created_at) VALUES (?, ?, ?)',
          [user.id, reelUuid, createdAt],
          { prepare: true }
        );
        
        reels.push({
          reelId: reelId,
          reelUuid: reelUuid,
          userId: user.id,
          caption: caption,
          mediaUrl: mediaUrl,
          createdAt: createdAt,
        });
      }
    }
    
    console.log(`✓ Created ${reels.length} posts\n`);
    
    // Create random follow relationships (not fully connected)
    console.log('Creating follow relationships...');
    const followPairs = [];
    
    // Each user follows 2-5 random other users
    for (const user of users) {
      const numFollows = randomInt(2, 5);
      const otherUsers = users.filter(u => u.id !== user.id);
      const shuffledOthers = shuffle(otherUsers);
      const toFollow = shuffledOthers.slice(0, numFollows);
      
      for (const followed of toFollow) {
        // Avoid duplicates
        if (!followPairs.some(p => p.follower === user.id && p.followed === followed.id)) {
          followPairs.push({
            follower: user.id,
            followed: followed.id,
          });
          
          // MongoDB
          await mongo.collection('follows').insertOne({
            followerId: user.id,
            followedId: followed.id,
            createdAt: new Date(),
          });
          
          // Neo4j
          if (neo4jConnected && neo4j) {
            try {
              const session = neo4j.session();
              await session.run(
                'MATCH (follower:User {id: $followerId}), (followed:User {id: $followedId}) MERGE (follower)-[:FOLLOWS]->(followed)',
                { followerId: user.id, followedId: followed.id }
              );
              await session.close();
            } catch (error) {
              console.warn(`  Warning: Failed to create follow relationship in Neo4j`);
            }
          }
          
          // Add followed user's reels to follower's timeline
          const followedReels = reels.filter(r => r.userId === followed.id);
          for (const reel of followedReels) {
            try {
              await cassandra.execute(
                'INSERT INTO timeline (user_id, reel_id, author_id, created_at) VALUES (?, ?, ?, ?)',
                [user.id, reel.reelUuid, followed.id, reel.createdAt],
                { prepare: true }
              );
            } catch (err) {
              // Ignore duplicate errors
            }
          }
        }
      }
    }
    
    console.log(`✓ Created ${followPairs.length} follow relationships\n`);
    
    // Initialize like counts in Redis
    console.log('Initializing like counts...');
    for (const reel of reels) {
      const likeCount = randomInt(0, 50);
      await redis.set(`likes:${reel.reelId}`, likeCount.toString());
    }
    console.log(`✓ Initialized like counts for ${reels.length} posts\n`);
    
    // Add random comments
    console.log('Adding random comments...');
    const commentTexts = ['wow', 'great', 'nice', 'amazing', 'beautiful', 'love it', 'awesome', 'perfect', 'stunning', 'incredible'];
    
    // Each reel gets 0-5 random comments
    for (const reel of reels) {
      const numComments = randomInt(0, 5);
      const shuffledUsers = shuffle(users);
      
      for (let i = 0; i < numComments && i < users.length; i++) {
        const commenter = shuffledUsers[i];
        const commentText = randomChoice(commentTexts);
        
        await mongo.collection('comments').insertOne({
          reelId: reel.reelId.toString(),
          userId: commenter.id,
          username: commenter.username,
          text: commentText,
          parentCommentId: null,
          createdAt: new Date(reel.createdAt.getTime() + randomInt(1, 24) * 60 * 60 * 1000), // Random time after post
        });
      }
    }
    
    const totalComments = await mongo.collection('comments').countDocuments();
    console.log(`✓ Added ${totalComments} comments\n`);
    
    console.log('✓ Seed completed successfully!\n');
    console.log('Summary:');
    console.log(`- ${users.length} users created (all with password: 123)`);
    console.log(`  Users: ${usernames.join(', ')}`);
    console.log(`- ${reels.length} posts created`);
    console.log(`- ${followPairs.length} follow relationships created`);
    console.log(`- ${totalComments} comments added`);
    console.log(`- Like counts initialized in Redis`);
    
    if (!neo4jConnected) {
      console.log('\n⚠ Note: Neo4j not available - follow relationships stored in MongoDB only');
      console.log('   To enable full functionality: docker-compose up -d neo4j');
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Error seeding:', error);
    process.exit(1);
  }
}

seed();
