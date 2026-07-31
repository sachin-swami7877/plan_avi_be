const mongoose = require('mongoose');

const spinnerRecordSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  outcome: {
    type: String,
    required: true,
    enum: ['thank_you', '20', '50', '70', '100', '120', '170', '200'],
  },
  spinType: {
    type: String,
    enum: ['paid', 'referral'],
    default: 'paid',
  },
  winAmount: {
    type: Number,
    required: true,
    default: 0,
  },
  spinCost: {
    type: Number,
    required: true,
    default: 50,
  },
  balanceAfter: {
    type: Number,
    required: true,
  },
  // Which website the spin came from (mirrors the user's siteType)
  siteType: {
    type: String,
    enum: ['rushkroludo', '101dream'],
    default: 'rushkroludo',
    index: true,
  },
}, {
  timestamps: true,
});

spinnerRecordSchema.index({ userId: 1, createdAt: -1 });
spinnerRecordSchema.index({ createdAt: 1 });

module.exports = mongoose.model('SpinnerRecord', spinnerRecordSchema);
