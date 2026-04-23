const Notification = require('../models/Notification');
const User = require('../models/User');
const path = require('path');
const fs = require('fs');

let Expo = null;
try {
  Expo = require('expo-server-sdk').Expo;
} catch (err) {
  console.warn('expo-server-sdk not installed. Push notifications disabled.');
}

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

// @desc    Save FCM push token for current user
// @route   POST /api/notifications/fcm-token
const saveFcmToken = async (req, res) => {
  try {
    const { token } = req.body;
    if (!token) return res.status(400).json({ message: 'Token is required' });

    await User.findByIdAndUpdate(req.user._id, {
      $addToSet: { fcmTokens: token },
    });
    res.json({ message: 'Token saved' });
  } catch (error) {
    console.error(error);
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

// @desc    Send web notification to all users (Admin only)
// @route   POST /api/admin/notifications/send
const sendAdminNotification = async (req, res) => {
  try {
    const { title, message, link, websiteUrl } = req.body;
    if (!message) {
      return res.status(400).json({ message: 'Notification message is required' });
    }

    // Get all active users
    const users = await User.find({
      status: 'active'
    }).select('_id').lean();

    if (users.length === 0) {
      return res.status(400).json({ message: 'No active users found' });
    }

    let imageUrl = null;

    // Handle image upload if provided
    if (req.file) {
      const uploadDir = path.join(__dirname, '../../public/uploads');
      if (!fs.existsSync(uploadDir)) {
        fs.mkdirSync(uploadDir, { recursive: true });
      }
      const filename = `notification-${Date.now()}-${req.file.originalname}`;
      const filepath = path.join(uploadDir, filename);
      fs.writeFileSync(filepath, req.file.buffer);
      imageUrl = `${process.env.API_URL || 'http://localhost:5000'}/uploads/${filename}`;
    }

    // Create notifications for all users
    const notificationDocs = users.map(user => ({
      userId: user._id,
      title: title || 'RushkroLudo',
      message,
      type: 'broadcast',
      imageUrl,
      link: link || null,
      websiteUrl: websiteUrl || null,
      read: false
    }));

    const result = await Notification.insertMany(notificationDocs);

    res.json({
      message: `Notification sent to ${result.length} users`,
      userCount: users.length,
      sentCount: result.length,
      notificationId: result[0]?._id
    });
  } catch (error) {
    console.error('Send notification error:', error);
    res.status(500).json({ message: 'Failed to send notification' });
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
};
