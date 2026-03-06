const mongoose = require('mongoose');

const ludoMatchSchema = new mongoose.Schema({
  roomCode: {
    type: String,
    default: '',
    trim: true,
    uppercase: true,
    maxlength: 10,
  },
  entryAmount: {
    type: Number,
    required: true,
    min: 50,
  },
  creatorId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  creatorName: {
    type: String,
    default: null,
  },
  status: {
    type: String,
    enum: ['waiting', 'live', 'cancel_requested', 'completed', 'cancelled'],
    default: 'waiting',
  },
  // Max 2 players per game: creator + 1 joiner
  players: [
    {
      userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
      userName: { type: String },
      amountPaid: { type: Number },
      paidFromDeposit: { type: Number, default: 0 },
      paidFromEarnings: { type: Number, default: 0 },
      joinedAt: { type: Date, default: Date.now },
    },
  ],
  joinExpiryAt: {
    type: Date,
    default: null,
  },
  gameStartedAt: {
    type: Date,
    default: null,
  },
  gameExpiryAt: {
    type: Date,
    default: null,
  },
  winnerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  cancelledAt: {
    type: Date,
    default: null,
  },
  cancelReason: {
    type: String,
    default: null,
  },
  // Cancel dispute fields — set when a player clicks "Cancel" after game has started
  cancelRequestedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  cancelRequestedAt: {
    type: Date,
    default: null,
  },
  cancelReasonCode: {
    type: String,
    default: null,
  },
  cancelReasonCustom: {
    type: String,
    default: null,
  },
  // 4-minute deadline for creator to submit room code after opponent joins
  roomCodeExpiryAt: {
    type: Date,
    default: null,
  },
  // When the opponent confirmed they entered the room code in Ludo King
  opponentConfirmedAt: {
    type: Date,
    default: null,
  },
  // 20 seconds after opponentConfirmedAt — "I Won" button appears after this
  gameActualStartAt: {
    type: Date,
    default: null,
  },
  // 60 seconds after creator submits room code — if opponent hasn't confirmed by then, auto-start
  confirmCodeExpiryAt: {
    type: Date,
    default: null,
  },
}, {
  timestamps: true,
});

ludoMatchSchema.index({ status: 1, createdAt: -1 });
ludoMatchSchema.index({ creatorId: 1, status: 1 });
ludoMatchSchema.index({ 'players.userId': 1, status: 1 });

module.exports = mongoose.model('LudoMatch', ludoMatchSchema);
