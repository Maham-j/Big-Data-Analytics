const redis = require('redis');

const redisConfig = {
  socket: {
    host: process.env.REDIS_HOST || 'localhost',
    port: parseInt(process.env.REDIS_PORT || '6379'),
  },
};

// Add password (default to admin12345 if not set, or empty string to disable)
const redisPassword = process.env.REDIS_PASSWORD !== undefined 
  ? process.env.REDIS_PASSWORD 
  : 'admin12345';
  
if (redisPassword) {
  redisConfig.password = redisPassword;
}

const client = redis.createClient(redisConfig);

client.on('error', (err) => console.error('Redis Client Error', err));
client.on('connect', () => console.log('Redis connected'));

// Connect, but don't fail if already connected
client.connect().catch((err) => {
  // Ignore "Socket already opened" errors - means already connected
  if (!err.message.includes('already opened')) {
    console.error('Redis connection error:', err);
  }
});

module.exports = client;

