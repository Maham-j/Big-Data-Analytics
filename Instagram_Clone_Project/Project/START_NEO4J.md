# How to Start Neo4j

Neo4j is required for the full social graph features (follow/unfollow). Here's how to start it:

## Quick Start

```bash
# Start Neo4j container
docker-compose up -d neo4j

# Wait for Neo4j to be ready (takes about 30-60 seconds)
# Check logs to see when it's ready:
docker-compose logs -f neo4j

# Look for: "Started" or "Bolt enabled on 0.0.0.0:7687"
# Press Ctrl+C to exit logs

# Restart your server to connect to Neo4j
# Stop the server (Ctrl+C) and run:
npm start
```

## Verify Neo4j is Running

```bash
# Check container status
docker-compose ps neo4j

# Should show "Up" status
```

## Access Neo4j Browser

Once Neo4j is running, you can access the web interface:

- **URL**: http://localhost:7474
- **Username**: admin
- **Password**: admin12345

## Troubleshooting

### Neo4j won't start

1. Check if port 7474 or 7687 is already in use:
   ```bash
   netstat -tuln | grep -E '7474|7687'
   ```

2. Check Neo4j logs:
   ```bash
   docker-compose logs neo4j
   ```

3. Restart Neo4j:
   ```bash
   docker-compose restart neo4j
   ```

### Connection timeout

Neo4j takes 30-60 seconds to fully start. Wait for the logs to show "Started" before trying to use it.

## Fallback Mode

**Good news!** The app now works without Neo4j:
- Follow relationships are stored in MongoDB as a fallback
- You can still follow users and see their posts
- Some advanced features (like mutual follows) require Neo4j

To enable full Neo4j features, just start the container as shown above.


