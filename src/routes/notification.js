const express = require('express');
const router = express.Router();
const {
  getNotifications,
  markAsRead,
  markAllAsRead,
  getUnreadCount,
  saveFcmToken,
  removeFcmToken,
} = require('../controllers/notificationController');
const { protect } = require('../middleware/auth');

router.use(protect);

router.get('/', getNotifications);
router.get('/unread-count', getUnreadCount);
router.put('/read-all', markAllAsRead);
router.post('/fcm-token', saveFcmToken);
router.delete('/fcm-token', removeFcmToken);
router.put('/:id/read', markAsRead);

module.exports = router;
