const Notification = require('../models/Notification');
const User = require('../models/User');
const path = require('path');
const fs = require('fs');
const { sendPushNotification } = require('../config/firebase');

// @desc    Get user notifications (last 7 days only)
// @route   GET /api/notifications?page=1&limit=25
const getNotifications = async (req, res) => {
  try {
    const { page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const filter = {
      userId: req.user._id,
      createdAt: { $gte: sevenDaysAgo },
    };

    const [notifications, totalCount] = await Promise.all([
      Notification.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Notification.countDocuments(filter),
    ]);

    res.json({
      records: notifications,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Mark notification as read
// @route   PUT /api/notifications/:id/read
const markAsRead = async (req, res) => {
  try {
    const notification = await Notification.findOneAndUpdate(
      { _id: req.params.id, userId: req.user._id },
      { read: true },
      { new: true }
    );

    if (!notification) {
      return res.status(404).json({ message: 'Notification not found' });
    }

    res.json(notification);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Mark all notifications as read
// @route   PUT /api/notifications/read-all
const markAllAsRead = async (req, res) => {
  try {
    await Notification.updateMany(
      { userId: req.user._id, read: false },
      { read: true }
    );

    res.json({ message: 'All notifications marked as read' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get unread count (last 7 days only)
// @route   GET /api/notifications/unread-count
const getUnreadCount = async (req, res) => {
  try {
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const count = await Notification.countDocuments({
      userId: req.user._id,
      read: false,
      createdAt: { $gte: sevenDaysAgo },
    });

    res.json({ count });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Max FCM tokens to keep per user (oldest get trimmed beyond this)
const MAX_TOKENS_PER_USER = 5;

// @desc    Save FCM push token for current user
// @route   POST /api/notifications/fcm-token
const saveFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token is required' });

    // Step 1: ensure token is in the array (no duplicate). Mongo's $addToSet handles dedup.
    // Step 2: cap the array size — keep most recent MAX_TOKENS_PER_USER (drop oldest from the front).
    // Note: $addToSet appends to the END, so we $slice from the END to keep newest.
    await User.findByIdAndUpdate(req.user._id, {
      $push: {
        fcmTokens: {
          $each: [token],
          $slice: -MAX_TOKENS_PER_USER, // keep last N entries
        },
      },
    });

    // Defensively dedup: $push doesn't dedup. If token already exists, we'd have a duplicate.
    // Pull all instances first via $pull-then-$push pattern is racy; instead, use a clean two-step.
    // Simpler: re-set the array to unique values truncated to MAX.
    const userDoc = await User.findById(req.user._id).select('fcmTokens').lean();
    if (userDoc?.fcmTokens?.length) {
      // Preserve order: latest occurrence of each token wins
      const seen = new Set();
      const deduped = [];
      // Iterate from end so we keep the most recent occurrence
      for (let i = userDoc.fcmTokens.length - 1; i >= 0; i--) {
        const t = userDoc.fcmTokens[i];
        if (!seen.has(t)) {
          seen.add(t);
          deduped.unshift(t); // prepend to maintain rough chronological order
        }
      }
      const finalTokens = deduped.slice(-MAX_TOKENS_PER_USER);
      if (finalTokens.length !== userDoc.fcmTokens.length) {
        await User.updateOne({ _id: req.user._id }, { $set: { fcmTokens: finalTokens } });
      }
    }

    // Also: this token might already be registered to ANOTHER user (e.g., shared device,
    // or user logged out + new user logged in on the same browser). Remove it from others.
    await User.updateMany(
      { _id: { $ne: req.user._id }, fcmTokens: token },
      { $pull: { fcmTokens: token } }
    );

    res.json({ message: 'Token saved' });
  } catch (error) {
    console.error('saveFcmToken error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Remove FCM push token (on logout)
// @route   DELETE /api/notifications/fcm-token
const removeFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token is required' });

    await User.findByIdAndUpdate(req.user._id, {
      $pull: { fcmTokens: token },
    });
    res.json({ message: 'Token removed' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Send push notification to all users (Admin only)
// @route   POST /api/admin/notifications/send
const sendAdminNotification = async (req, res) => {
  try {
    const { title, message, link, websiteUrl } = req.body;
    if (!message) {
      return res.status(400).json({ message: 'Notification message is required' });
    }

    // Broadcast only to the admin's own site — rushkroludo and 101dream users
    // share this backend but must never see each other's notifications
    const siteType = req.user.siteType || 'rushkroludo';

    // Get all active users with FCM tokens
    const users = await User.find({
      status: 'active',
      siteType,
      fcmTokens: { $exists: true, $ne: [] }
    }).select('_id fcmTokens').lean();

    if (users.length === 0) {
      return res.status(400).json({ message: 'No users with push tokens found' });
    }

    let imageUrl = null;

    // Handle image upload if provided
    if (req.file) {
      // Save to the same dir that index.js serves at /uploads
      const uploadDir = path.join(__dirname, '../../uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      // Sanitize filename — keep only alphanumeric, dot, dash, underscore
      const safeName = String(req.file.originalname || 'image').replace(/[^a-zA-Z0-9._-]/g, '_');
      const filename = `notification-${Date.now()}-${safeName}`;
      const filepath = path.join(uploadDir, filename);
      fs.writeFileSync(filepath, req.file.buffer);
      const baseUrl = process.env.API_URL || `${req.protocol}://${req.get('host')}`;
      imageUrl = `${baseUrl}/uploads/${filename}`;
    }

    const defaultTitle = siteType === '101dream' ? '101Dream' : 'RushkroLudo';

    // Create notifications for all users (for database/history)
    const notificationDocs = users.map(user => ({
      userId: user._id,
      title: title || defaultTitle,
      message,
      type: 'broadcast',
      imageUrl,
      link: link || null,
      websiteUrl: websiteUrl || null,
      read: false
    }));

    const result = await Notification.insertMany(notificationDocs);

    // Send actual FCM push notifications to all users
    const allTokens = users.flatMap(user => user.fcmTokens).filter(Boolean);
    const notifTitle = title || defaultTitle;

    let pushResult = { successCount: 0, failureCount: 0 };
    if (allTokens.length > 0) {
      pushResult = await sendPushNotification(null, allTokens, notifTitle, message, {
        type: 'broadcast',
        imageUrl: imageUrl || '',
        websiteUrl: websiteUrl || '',
        link: link || ''
      });
    }

    // Also emit Socket.io event for real-time in-app notifications
    const io = req.app.get('io');
    if (io) {
      const notificationData = {
        _id: result[0]?._id,
        title: notifTitle,
        message,
        imageUrl,
        websiteUrl: websiteUrl || null,
        type: 'broadcast',
        createdAt: new Date()
      };
      // Room-scoped: only sockets of this site's users receive it
      io.to(`site_${siteType}`).emit('notification:broadcast', notificationData);
    }

    res.json({
      message: `Push: ${pushResult.successCount} delivered, ${pushResult.failureCount} failed (${users.length} users, ${allTokens.length} devices)`,
      userCount: users.length,
      tokenCount: allTokens.length,
      successCount: pushResult.successCount,
      failureCount: pushResult.failureCount,
      notificationId: result[0]?._id
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ message: 'Failed to send notification' });
  }
};

// @desc    Push notification reach stats — how many users can receive pushes
// @route   GET /api/admin/notifications/reach
const getNotificationReach = async (req, res) => {
  try {
    // Scope stats to the admin's own site (rushkroludo vs 101dream)
    const siteType = req.user.siteType || 'rushkroludo';
    const [totalActive, withTokens, totalTokens] = await Promise.all([
      User.countDocuments({ status: 'active', siteType }),
      User.countDocuments({
        status: 'active',
        siteType,
        fcmTokens: { $exists: true, $ne: [] },
      }),
      User.aggregate([
        { $match: { status: 'active', siteType, fcmTokens: { $exists: true, $ne: [] } } },
        { $project: { tokenCount: { $size: '$fcmTokens' } } },
        { $group: { _id: null, total: { $sum: '$tokenCount' } } },
      ]),
    ]);

    res.json({
      totalActiveUsers: totalActive,
      usersWithPushEnabled: withTokens,
      usersWithoutPushEnabled: totalActive - withTokens,
      totalDevicesReachable: totalTokens[0]?.total || 0,
      reachPercent: totalActive > 0 ? Math.round((withTokens / totalActive) * 100) : 0,
    });
  } catch (error) {
    console.error('getNotificationReach error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  saveFcmToken,
  removeFcmToken,
  sendAdminNotification,
  getNotificationReach,
};
