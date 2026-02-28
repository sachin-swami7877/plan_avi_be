/**
 * One-time script: clear all GameRounds and Bets from the database.
 * Run: node src/scripts/clearGameRounds.js
 */
require('dotenv').config();
const mongoose = require('mongoose');
const GameRound = require('../models/GameRound');
const Bet = require('../models/Bet');

async function clear() {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('MongoDB connected.');

    const deletedBets = await Bet.deleteMany({});
    console.log(`Deleted ${deletedBets.deletedCount} bet(s).`);

    const deletedRounds = await GameRound.deleteMany({});
    console.log(`Deleted ${deletedRounds.deletedCount} game round(s).`);

    console.log('Done. Game rounds and bets cleared.');
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    await mongoose.disconnect();
    process.exit(0);
  }
}

clear();
