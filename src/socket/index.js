const jwt = require('jsonwebtoken');
const User = require('../models/User');
const initSocket = (io) => {
  // Track active authenticated users: userId -> Set of socketIds
  const activeUsers = new Map();
  io._activeUsers = activeUsers;

  const broadcastActiveCount = () => {
    io.emit('app:active-users', { count: activeUsers.size });
    io.to('admins').emit('app:active-user-ids', { ids: Array.from(activeUsers.keys()) });
  };

  // Authentication middleware for socket
  io.use(async (socket, next) => {
    try {
      const token = socket.handshake.auth.token;

      if (!token) {
        // Allow connection without auth for game state viewing
        socket.user = null;
        return next();
      }

      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      const user = await User.findById(decoded.id).select('-otp -otpExpiry');

      if (!user) {
        return next(new Error('User not found'));
      }

      socket.user = user;
      next();
    } catch (error) {
      // Allow connection but without auth
      socket.user = null;
      next();
    }
  });

  io.on('connection', (socket) => {
    console.log(`🔌 Socket connected: ${socket.id}`);

    // Join user-specific room if authenticated
    if (socket.user) {
      socket.join(`user_${socket.user._id}`);
      console.log(`👤 User ${socket.user.name} joined room user_${socket.user._id}`);

      // Track active user
      const userId = socket.user._id.toString();
      if (!activeUsers.has(userId)) {
        activeUsers.set(userId, new Set());
      }
      activeUsers.get(userId).add(socket.id);
      broadcastActiveCount();

      // Join admin room if admin or subAdmin
      if (socket.user.isAdmin || socket.user.isSubAdmin) {
        socket.join('admins');
        console.log(`👑 Admin ${socket.user.name} joined admin room`);
      }
    }

    // Handle game events — send current state immediately so late-joiners don't miss it
    socket.on('game:subscribe', () => {
      socket.join('game');
      console.log(`🎮 Socket ${socket.id} subscribed to game`);

      // Send current game state to the newly subscribed client
      try {
        const gameEngine = io._gameEngine;
        if (gameEngine) {
          const state = gameEngine.getCurrentState();
          const status = state.status || 'idle';
          if (status === 'waiting') {
            socket.emit('game:waiting', { roundId: state.round?.roundId });
          } else if (status === 'running') {
            socket.emit('game:start', { roundId: state.round?.roundId });
            socket.emit('game:tick', { multiplier: state.multiplier });
          }
        }
      } catch (e) {
        // silent — non-critical
      }
    });

    socket.on('game:unsubscribe', () => {
      socket.leave('game');
    });

    // Handle disconnect
    socket.on('disconnect', () => {
      console.log(`🔌 Socket disconnected: ${socket.id}`);

      if (socket.user) {
        const userId = socket.user._id.toString();
        const sockets = activeUsers.get(userId);
        if (sockets) {
          sockets.delete(socket.id);
          if (sockets.size === 0) {
            activeUsers.delete(userId);
          }
        }
        broadcastActiveCount();
      }
    });
  });

  console.log('🔌 Socket.io initialized');
};

module.exports = { initSocket };
