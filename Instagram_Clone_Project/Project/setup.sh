#!/bin/bash

echo "🚀 Setting up Instagram Clone..."
echo ""

# Step 1: Start databases
echo "📦 Step 1: Starting database services..."
docker-compose up -d

echo "⏳ Waiting for databases to be ready (this may take 30-60 seconds)..."
sleep 10

# Wait for Cassandra specifically
echo "⏳ Waiting for Cassandra to be ready..."
until docker-compose logs cassandra | grep -q "Starting listening for CQL clients"; do
  sleep 2
done
echo "✅ Cassandra is ready!"

# Step 2: Install dependencies
echo ""
echo "📦 Step 2: Installing Node.js dependencies..."
npm install

# Step 3: Initialize databases
echo ""
echo "🗄️  Step 3: Initializing database schemas..."
npm run init-db

# Step 4: Seed data
echo ""
echo "🌱 Step 4: Seeding sample data..."
npm run seed

echo ""
echo "✅ Setup complete!"
echo ""
echo "🎉 To start the server, run:"
echo "   npm start"
echo ""
echo "🌐 Then open your browser to:"
echo "   http://localhost:3000"
echo ""

