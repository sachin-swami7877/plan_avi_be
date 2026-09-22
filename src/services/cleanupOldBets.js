const Bet = require('../models/Bet');
const { runWithSite, distinctDbSites } = require('../config/db');
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

// Runs once per database, and never on top of itself: a slow sweep must not
// have a second copy started by the next tick while it is still going.
let running = false;
async function runAllDatabases() {
  if (running) {
    console.log('[Cleanup] previous run still in progress — skipping this tick');
    return;
  }
  running = true;
  try {
    for (const site of distinctDbSites()) {
      await runWithSite(site, runCleanupOldBets);
    }
  } finally {
    running = false;
  }
}

function startOldBetsCron() {
  // Run immediately on server start
  runAllDatabases();
  // Then repeat every 24 hours
  setInterval(runAllDatabases, CRON_INTERVAL_MS);
  console.log(`[Cleanup] Cron started: every 24 hours (delete bets older than ${MAX_AGE_DAYS} days)`);
}

module.exports = { runCleanupOldBets, startOldBetsCron };
