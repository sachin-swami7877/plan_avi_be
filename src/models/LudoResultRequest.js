const mongoose = require('mongoose');

// One request per match. Multiple claims (win/loss/dispute) from both players.
const claimSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, default: null },
  type: { type: String, enum: ['win', 'loss', 'win_dispute'], required: true },
  screenshotUrl: { type: String, default: null },
  winReasonCode: { type: String, default: null },
  winReasonCustom: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

// Refund decision per player set by admin when resolving cancel dispute
const refundDecisionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  userName: { type: String, default: null },
  refundType: { type: String, enum: ['full', 'percent30', 'zero', 'custom', 'refund_win_percent', 'custom_percent'], default: 'full' },
  winPercent: { type: Number, default: null }, // used when refundType = 'refund_win_percent'
  customPercent: { type: Number, default: null }, // used when refundType = 'custom_percent'
  amount: { type: Number, default: 0 },
}, { _id: false });

const ludoResultRequestSchema = new mongoose.Schema({
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LudoMatch',
    required: true,
    unique: true,
  },
  // 'normal' = regular win/loss; 'cancel_dispute' = one player cancelled, other claims win; 'cancel_accepted' = both agreed to cancel, admin decides refunds
  disputeType: {
    type: String,
    enum: ['normal', 'cancel_dispute', 'cancel_accepted'],
    default: 'normal',
  },
  claims: [claimSchema],
  winnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  // Set by admin when resolving cancel dispute — refund amounts for each player
  refundDecisions: [refundDecisionSchema],
  status: {
    type: String,
    enum: ['pending', 'resolved'],
    default: 'pending',
  },
  reviewedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  reviewedAt: {
    type: Date,
    default: null,
  },
  adminNote: {
    type: String,
    default: null,
  },
}, {
  timestamps: true,
});

ludoResultRequestSchema.index({ status: 1 });
ludoResultRequestSchema.index({ matchId: 1 });

module.exports = mongoose.model('LudoResultRequest', ludoResultRequestSchema);
