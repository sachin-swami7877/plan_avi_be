require('dotenv').config();
const express = require('express');
const cors = require('cors');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const connectDB = require('./config/db');
const authRoutes = require('./routes/auth');
const walletRoutes = require('./routes/wallet');
const adminRoutes = require('./routes/admin');
const gameRoutes = require('./routes/game');
const spinnerRoutes = require('./routes/spinner');
const notificationRoutes = require('./routes/notification');
const bonusRoutes = require('./routes/bonus');
const settingsRoutes = require('./routes/settings');
const ludoRoutes = require('./routes/ludo');
const { initSocket } = require('./socket');
const { GameEngine } = require('./services/gameEngine');
const { startCleanupCron } = require('./services/cleanupEmptyRounds');
const { startLudoCron } = require('./services/ludoCron');
const { startNotificationCron } = require('./services/notificationCron');
const { startOldBetsCron } = require('./services/cleanupOldBets');

const app = express();
const server = http.createServer(app);

// Allowed origins from env (comma-separated) + local defaults
const allowedOrigins = [
  'http://localhost:5173', 'http://localhost:5174', 'http://localhost:5175',
  'http://localhost:5176', 'http://localhost:5177', 'http://localhost:3000',
  ...(process.env.ALLOWED_ORIGINS ? process.env.ALLOWED_ORIGINS.split(',').map(o => o.trim()) : []),
];

const corsOptions = {
  origin: allowedOrigins,
  methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  credentials: true,
};

// Socket.io setup
const io = new Server(server, { cors: corsOptions });

// Connect to database
connectDB();

// Middleware
app.use(cors(corsOptions));
app.use(express.json());
app.use('/uploads', express.static(path.join(__dirname, '../uploads')));

// Make io accessible to routes
app.set('io', io);

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/wallet', walletRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/game', gameRoutes);
app.use('/api/spinner', spinnerRoutes);
app.use('/api/notifications', notificationRoutes);
app.use('/api/bonus', bonusRoutes);
app.use('/api/settings', settingsRoutes);
app.use('/api/ludo', ludoRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', message: 'Aviator API is running' });
});

// Initialize socket handlers
initSocket(io);

// Initialize game engine
const gameEngine = new GameEngine(io);
gameEngine.start();

// Make game engine accessible to routes and socket handlers
app.set('gameEngine', gameEngine);
io._gameEngine = gameEngine;

// Cron: every 2 hours, keep only latest 15 empty rounds, delete older empty rounds
startCleanupCron();
// Cron: every 1 min, expire waiting + live Ludo matches and refund
startLudoCron(io);
// Cron: every 6 hours, delete read notifications older than 10 days
startNotificationCron();
// Cron: every 24 hours, delete bets older than 31 days
startOldBetsCron();

const PORT = process.env.PORT || 5050;

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});
