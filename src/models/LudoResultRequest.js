const mongoose = require('mongoose');

// One request per match. Multiple claims (win/loss) from both players.
const claimSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  userName: { type: String, default: null },
  type: { type: String, enum: ['win', 'loss'], required: true },
  screenshotUrl: { type: String, default: null },
  createdAt: { type: Date, default: Date.now },
}, { _id: true });

const ludoResultRequestSchema = new mongoose.Schema({
  matchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LudoMatch',
    required: true,
    unique: true,
  },
  claims: [claimSchema],
  winnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
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
