const mongoose = require('mongoose');
const { routedModel } = require('../config/db');

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

module.exports = routedModel('GlobalStats', globalStatsSchema);
