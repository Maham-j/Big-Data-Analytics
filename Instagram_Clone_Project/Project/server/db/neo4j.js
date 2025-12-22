const neo4j = require('neo4j-driver');

// Neo4j 4.0+ changed default encryption - need to explicitly configure
// For Neo4j 5.x, use encrypted: 'ENCRYPTION_OFF' or disable TLS in docker-compose
const driver = neo4j.driver(
  process.env.NEO4J_URI || 'bolt://localhost:7687',
  neo4j.auth.basic(
    process.env.NEO4J_USERNAME || 'neo4j',
    process.env.NEO4J_PASSWORD || 'admin12345'
  ),
  {
    encrypted: 'ENCRYPTION_OFF', // Disable encryption for local development
  }
);

let isConnected = false;

async function connect() {
  try {
    // Verify connectivity with a timeout
    const session = driver.session();
    const result = await Promise.race([
      session.run('RETURN 1 as test'),
      new Promise((_, reject) => 
        setTimeout(() => reject(new Error('Neo4j connection timeout')), 10000)
      )
    ]);
    await session.close();
    isConnected = true;
    console.log('Neo4j connected');
  } catch (error) {
    isConnected = false;
    if (error.message.includes('ECONNREFUSED')) {
      console.error('Neo4j connection error: Neo4j container may not be running.');
      console.error('Please ensure Neo4j is started with: docker-compose up -d neo4j');
      console.error('And wait for it to be ready (check logs: docker-compose logs neo4j)');
    } else {
      console.error('Neo4j connection error:', error.message);
    }
    throw error;
  }
}

function getDriver() {
  if (!isConnected) {
    return null;
  }
  return driver;
}

function isNeo4jConnected() {
  return isConnected;
}

module.exports = { connect, getDriver, isNeo4jConnected };

