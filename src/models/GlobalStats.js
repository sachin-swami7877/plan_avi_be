const mongoose = require('mongoose');

const globalStatsSchema = new mongoose.Schema({
  key: {
    type: String,
    required: true,
    unique: true,
    default: 'main'
  },
  totalBetsPlaced: {
    type: Number,
    default: 0
  },
  totalBetsWon: {
    type: Number,
    default: 0
  },
  totalBetAmount: {
    type: Number,
    default: 0
  },
  totalWinAmount: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

module.exports = mongoose.model('GlobalStats', globalStatsSchema);
