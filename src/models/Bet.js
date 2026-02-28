const mongoose = require('mongoose');

const betSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  gameRoundId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'GameRound',
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 10
  },
  cashOutMultiplier: {
    type: Number,
    default: null
  },
  profit: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'won', 'lost'],
    default: 'active'
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('Bet', betSchema);
