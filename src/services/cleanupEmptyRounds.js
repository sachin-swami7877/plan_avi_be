const GameRound = require('../models/GameRound');
const Bet = require('../models/Bet');

const KEEP_EMPTY_ROUNDS = 15;
const CRON_INTERVAL_MS = 2 * 60 * 60 * 1000; // 2 hours

/**
 * Rounds where no user placed any bet = "empty" rounds.
 * Keep only the latest 15 empty rounds; delete all older empty rounds.
 * Rounds where ANY user placed a bet (e.g. 10 INR) are NEVER deleted — only empty rounds can be removed.
 */
async function runCleanupEmptyRounds() {
  try {
    const roundIdsWithBets = await Bet.distinct('gameRoundId');
    const setWithBets = new Set(roundIdsWithBets.map((id) => id.toString()));

    const allRounds = await GameRound.find().sort({ createdAt: -1 }).lean();
    const emptyRounds = allRounds.filter((r) => !setWithBets.has(r._id.toString()));

    const toDelete = emptyRounds.slice(KEEP_EMPTY_ROUNDS);
    if (toDelete.length === 0) {
      return;
    }

    const idsToDelete = toDelete.map((r) => r._id);
    const result = await GameRound.deleteMany({ _id: { $in: idsToDelete } });
    console.log(`[Cleanup] Removed ${result.deletedCount} old empty round(s). Kept latest ${KEEP_EMPTY_ROUNDS} empty rounds.`);
  } catch (err) {
    console.error('[Cleanup] Error cleaning empty rounds:', err);
  }
}

function startCleanupCron() {
  runCleanupEmptyRounds();
  setInterval(runCleanupEmptyRounds, CRON_INTERVAL_MS);
  console.log(`[Cleanup] Cron started: every 2 hours (keep latest ${KEEP_EMPTY_ROUNDS} empty rounds).`);
}

module.exports = { runCleanupEmptyRounds, startCleanupCron };
