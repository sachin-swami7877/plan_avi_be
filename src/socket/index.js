const jwt = require('jsonwebtoken');
const User = require('../models/User');
const HIDDEN_PHONES = ['9166821247', '7877722306'];

const initSocket = (io) => {
  // Track active authenticated users: userId -> Set of socketIds
  const activeUsers = new Map();
  const hiddenUserIds = new Set(); // super admin user IDs to exclude from count
  io._activeUsers = activeUsers;

  const broadcastActiveCount = () => {
    // Exclude hidden super admin users from count
    let visibleCount = 0;
    const visibleIds = [];
    for (const [uid] of activeUsers) {
      if (!hiddenUserIds.has(uid)) {
        visibleCount++;
        visibleIds.push(uid);
      }
    }
    io.emit('app:active-users', { count: visibleCount });
    io.to('admins').emit('app:active-user-ids', { ids: visibleIds });
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
      const user = await User.findById(decoded.id).select('-otp -otpExpiry +activeToken');

      if (!user) {
        return next(new Error('User not found'));
      }

      if (user.status === 'blocked') {
        return next(new Error('Account blocked'));
      }

      // Single-device check: reject socket if token doesn't match activeToken
      if (user.activeToken && user.activeToken !== token) {
        return next(new Error('SESSION_EXPIRED_OTHER_DEVICE'));
      }

      socket.user = user;
      socket.user.activeToken = undefined; // don't keep in memory
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

      // Track active user (mark hidden super admins)
      const userId = socket.user._id.toString();
      if (HIDDEN_PHONES.includes(socket.user.phone)) {
        hiddenUserIds.add(userId);
      }
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

    // ── Fast cashout via socket (avoids HTTP overhead) ──
    socket.on('game:cashout', async (callback) => {
      if (!socket.user) {
        const cb = typeof callback === 'function' ? callback : () => {};
        return cb({ error: 'Not authenticated' });
      }
      try {
        const gameEngine = io._gameEngine;
        if (!gameEngine) throw new Error('Game not available');

        const result = await gameEngine.cashOut(socket.user._id);

        // Broadcast cashout to all game subscribers
        io.to('game').emit('bet:cashout', {
          userName: socket.user.name,
          multiplier: result.cashOutMultiplier,
          profit: result.profit,
        });

        // Respond to the caller
        const cb = typeof callback === 'function' ? callback : () => {};
        cb({
          success: true,
          cashOutMultiplier: result.cashOutMultiplier,
          profit: result.profit,
          newBalance: result.newBalance,
        });
      } catch (err) {
        const cb = typeof callback === 'function' ? callback : () => {};
        cb({ error: err.message || 'Failed to cash out' });
      }
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
