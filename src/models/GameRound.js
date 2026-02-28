const mongoose = require('mongoose');

const gameRoundSchema = new mongoose.Schema({
  roundId: {
    type: String,
    required: true,
    unique: true
  },
  crashMultiplier: {
    type: Number,
    required: true
  },
  status: {
    type: String,
    enum: ['waiting', 'running', 'crashed'],
    default: 'waiting'
  },
  totalBetAmount: {
    type: Number,
    default: 0
  },
  totalWinAmount: {
    type: Number,
    default: 0
  },
  startedAt: {
    type: Date,
    default: null
  },
  crashedAt: {
    type: Date,
    default: null
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('GameRound', gameRoundSchema);
