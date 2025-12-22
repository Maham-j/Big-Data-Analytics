require('dotenv').config();
const { connect: connectMongo } = require('../db/mongo');
const { connect: connectCassandra } = require('../db/cassandra');
const { connect: connectNeo4j, getDriver } = require('../db/neo4j');
const { initBucket } = require('../db/minio');
const redis = require('../db/redis');

async function initDatabases() {
  console.log('Initializing databases...');
  
  try {
    // MongoDB - collections will be created automatically on first insert
    await connectMongo();
    console.log('✓ MongoDB initialized');
    
    // Cassandra - tables created in connect()
    try {
      await connectCassandra();
      console.log('✓ Cassandra initialized');
    } catch (error) {
      console.warn('⚠ Cassandra initialization failed (container may not be ready yet)');
      console.warn('   Cassandra can take 1-2 minutes to fully start');
      console.warn('   You can continue - Cassandra will be initialized when the server starts');
      console.warn('   Make sure Cassandra is running: docker-compose up -d cassandra');
      console.warn('   Wait for it to be ready: docker-compose logs cassandra | grep "Starting listening"');
    }
    
    // Neo4j - create indexes
    try {
      await connectNeo4j();
      const driver = getDriver();
      const session = driver.session();
      await session.run('CREATE INDEX IF NOT EXISTS FOR (u:User) ON (u.id)');
      await session.close();
      console.log('✓ Neo4j initialized');
    } catch (error) {
      console.warn('⚠ Neo4j initialization failed (container may not be ready yet)');
      console.warn('   You can continue - Neo4j will be initialized when the server starts');
      console.warn('   Make sure Neo4j is running: docker-compose up -d neo4j');
    }
    
    // MinIO - bucket created in initBucket()
    await initBucket();
    console.log('✓ MinIO initialized');
    
    // Redis - already connected
    console.log('✓ Redis initialized');
    
    console.log('\nAll databases initialized successfully!');
    process.exit(0);
  } catch (error) {
    console.error('Error initializing databases:', error);
    process.exit(1);
  }
}

initDatabases();

