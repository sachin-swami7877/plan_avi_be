const mongoose = require('mongoose');

const walletRequestSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 100
  },
  type: {
    type: String,
    enum: ['deposit', 'withdrawal'],
    required: true
  },
  utrNumber: {
    type: String,
    default: null
  },
  screenshotUrl: {
    type: String,
    default: null
  },
  status: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  processedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  processedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

// Only index non-null UTR numbers — enforces uniqueness across all deposit requests
walletRequestSchema.index({ utrNumber: 1 }, { unique: true, partialFilterExpression: { utrNumber: { $type: 'string' } } });

module.exports = mongoose.model('WalletRequest', walletRequestSchema);
