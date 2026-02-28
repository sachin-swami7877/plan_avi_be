const mongoose = require('mongoose');

const bonusRecordSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  bonusAmount: {
    type: Number,
    required: true,
  },
  thresholdAmount: {
    type: Number,
    required: true,
  },
  totalBetsAtClaim: {
    type: Number,
    required: true,
  },
}, {
  timestamps: true,
});

bonusRecordSchema.index({ userId: 1, createdAt: -1 });

module.exports = mongoose.model('BonusRecord', bonusRecordSchema);
