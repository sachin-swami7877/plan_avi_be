const Bet = require('../models/Bet');
const GameRound = require('../models/GameRound');

const MAX_AGE_DAYS = 31;
const CRON_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/**
 * Delete bets older than 31 days and game rounds that have no remaining bets.
 */
async function runCleanupOldBets() {
  try {
    const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000);

    // Delete old bets
    const result = await Bet.deleteMany({ createdAt: { $lt: cutoff } });
    if (result.deletedCount > 0) {
      console.log(`[Cleanup] Removed ${result.deletedCount} bets older than ${MAX_AGE_DAYS} days`);
    }

    // Remove game rounds older than 31 days that have no remaining bets
    const oldRounds = await GameRound.find({ createdAt: { $lt: cutoff } }).select('_id');
    if (oldRounds.length > 0) {
      const oldIds = oldRounds.map((r) => r._id);
      const roundsWithBets = await Bet.distinct('gameRoundId', { gameRoundId: { $in: oldIds } });
      const roundsToDelete = oldIds.filter((id) => !roundsWithBets.some((bid) => bid.equals(id)));
      if (roundsToDelete.length > 0) {
        await GameRound.deleteMany({ _id: { $in: roundsToDelete } });
        console.log(`[Cleanup] Removed ${roundsToDelete.length} empty game rounds older than ${MAX_AGE_DAYS} days`);
      }
    }
  } catch (err) {
    console.error('[Cleanup] Error cleaning old bets:', err);
  }
}

function startOldBetsCron() {
  // Run immediately on server start
  runCleanupOldBets();
  // Then repeat every 24 hours
  setInterval(runCleanupOldBets, CRON_INTERVAL_MS);
  console.log(`[Cleanup] Cron started: every 24 hours (delete bets older than ${MAX_AGE_DAYS} days)`);
}

module.exports = { runCleanupOldBets, startOldBetsCron };
