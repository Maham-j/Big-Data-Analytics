const cassandra = require('cassandra-driver');

const cassandraConfig = {
  contactPoints: [process.env.CASSANDRA_HOSTS?.split(':')[0] || 'localhost'],
  port: parseInt(process.env.CASSANDRA_HOSTS?.split(':')[1] || '9042'),
  localDataCenter: 'datacenter1',
};

// Only add credentials if provided
if (process.env.CASSANDRA_USERNAME && process.env.CASSANDRA_PASSWORD) {
  cassandraConfig.credentials = {
    username: process.env.CASSANDRA_USERNAME,
    password: process.env.CASSANDRA_PASSWORD,
  };
}

const client = new cassandra.Client(cassandraConfig);

let connected = false;

async function connect() {
  try {
    await client.connect();
    connected = true;
    console.log('Cassandra connected');
    
    // Create keyspace if not exists
    await client.execute(`
      CREATE KEYSPACE IF NOT EXISTS instagram
      WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1}
    `);
    
    await client.execute('USE instagram');
    
    // Drop reels table if it exists (to handle schema changes)
    try {
      await client.execute('DROP TABLE IF EXISTS reels');
    } catch (error) {
      // Ignore if table doesn't exist
    }
    
    // Create reels table
    // Note: likes_count is stored in Redis, not here (Cassandra doesn't allow mixing COUNTER with regular columns)
    await client.execute(`
      CREATE TABLE reels (
        reel_id UUID PRIMARY KEY,
        user_id TEXT,
        caption TEXT,
        media_url TEXT,
        created_at TIMESTAMP
      )
    `);
    
    // Create user_reels table for feed queries (partitioned by user_id)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS user_reels (
        user_id TEXT,
        reel_id UUID,
        created_at TIMESTAMP,
        PRIMARY KEY (user_id, created_at, reel_id)
      ) WITH CLUSTERING ORDER BY (created_at DESC)
    `);
    
    // Create timeline table for home feed (partitioned by user_id)
    await client.execute(`
      CREATE TABLE IF NOT EXISTS timeline (
        user_id TEXT,
        reel_id UUID,
        author_id TEXT,
        created_at TIMESTAMP,
        PRIMARY KEY (user_id, created_at, reel_id)
      ) WITH CLUSTERING ORDER BY (created_at DESC)
    `);
    
    console.log('Cassandra tables created');
  } catch (error) {
    console.error('Cassandra connection error:', error);
    throw error;
  }
}

function getClient() {
  if (!connected) {
    throw new Error('Cassandra not connected. Call connect() first.');
  }
  return client;
}

module.exports = { connect, getClient };

