const { MongoClient } = require('mongodb');

// Use authentication if credentials are provided
const mongoUser = process.env.MONGO_USERNAME || 'admin';
const mongoPass = process.env.MONGO_PASSWORD || 'admin12345';
const mongoHost = process.env.MONGO_HOST || 'localhost';
const mongoPort = process.env.MONGO_PORT || '27017';
const mongoDb = process.env.MONGO_DB || 'instagram';

// Build connection URI - use auth if credentials are set
const uri = process.env.MONGO_URI || 
  `mongodb://${mongoUser}:${mongoPass}@${mongoHost}:${mongoPort}/${mongoDb}?authSource=admin`;

const client = new MongoClient(uri);

let db;

async function connect() {
  try {
    await client.connect();
    db = client.db('instagram');
    console.log('MongoDB connected');
    return db;
  } catch (error) {
    console.error('MongoDB connection error:', error);
    throw error;
  }
}

function getDb() {
  if (!db) {
    throw new Error('MongoDB not connected. Call connect() first.');
  }
  return db;
}

module.exports = { connect, getDb, client };

