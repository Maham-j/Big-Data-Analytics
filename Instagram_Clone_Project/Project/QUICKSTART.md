# Quick Start Commands

## Complete Setup & Run

```bash
# 1. Start all database services
docker-compose up -d

# 2. Wait for services to be ready (especially Cassandra - takes ~30-60 seconds)
# Check logs to see when ready:
docker-compose logs -f cassandra
# Press Ctrl+C when you see "Starting listening for CQL clients"

# 3. Install Node.js dependencies
npm install

# 4. Initialize database schemas
npm run init-db

# 5. Seed sample data (users, reels, comments, follows)
npm run seed

# 6. Start the server
npm start

# 7. Open browser to:
# http://localhost:3000
```

## Individual Commands

### Start Databases
```bash
docker-compose up -d
```

### Check Database Status
```bash
docker-compose ps
```

### View Database Logs
```bash
docker-compose logs -f [service-name]
# e.g., docker-compose logs -f cassandra
```

### Stop Databases
```bash
docker-compose down
```

### Stop and Remove All Data
```bash
docker-compose down -v
```

### Initialize Databases (create schemas)
```bash
npm run init-db
```

### Seed Sample Data
```bash
npm run seed
```


### Start Server
```bash
npm start
```

## Verify Everything Works

1. **Check server health:**
   ```bash
   curl http://localhost:3000/health
   ```

2. **Check feed endpoint:**
   ```bash
   curl "http://localhost:3000/api/reels/feed?userId=user1&page=1&limit=5"
   ```

3. **Open frontend:**
   - Navigate to: http://localhost:3000
   - Select a user from dropdown
   - You should see reels feed

## Troubleshooting

### If databases won't connect:

1. Make sure containers are running:
   ```bash
   docker-compose ps
   ```

2. Wait longer for Cassandra (it takes time to start):
   ```bash
   docker-compose logs cassandra | grep "Starting listening"
   ```

3. Check if ports are available:
   ```bash
   # Check if ports are in use
   netstat -tuln | grep -E '6379|27017|9042|7474|7687|9000'
   ```

### Reset Everything

```bash
# Stop and remove everything
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