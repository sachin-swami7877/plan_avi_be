const mongoose = require('mongoose');

const notificationSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  title: {
    type: String,
    required: true
  },
  message: {
    type: String,
    required: true
  },
  type: {
    type: String,
    enum: ['wallet', 'game', 'system', 'admin', 'ludo', 'kyc', 'broadcast'],
    default: 'system'
  },
  imageUrl: {
    type: String,
    default: null
  },
  link: {
    type: String,
    default: null
  },
  websiteUrl: {
    type: String,
    default: null
  },
  read: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Notification', notificationSchema);
