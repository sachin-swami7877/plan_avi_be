const LudoMatch = require('../models/LudoMatch');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { recordWalletTx } = require('../utils/recordWalletTx');

const RUN_INTERVAL_MS = 15 * 1000; // every 15 seconds — fast expiry detection

async function expireWaitingMatches(io) {
  const now = new Date();
  // Find expired IDs first, then atomically claim each one
  const expiredIds = await LudoMatch.find({
    status: 'waiting',
    joinExpiryAt: { $lt: now },
  }).distinct('_id');

  for (const matchId of expiredIds) {
    // Atomic claim — only one process can win; skip if already cancelled
    const match = await LudoMatch.findOneAndUpdate(
      { _id: matchId, status: 'waiting' },
      { $set: { status: 'cancelled', cancelledAt: now, cancelReason: 'Join time expired' } },
      { new: true }
    );
    if (!match) continue; // Already processed by another path

    const creator = await User.findById(match.creatorId);
    if (creator) {
      const creatorPlayer = match.players.find(p => p.userId.toString() === creator._id.toString());
      const refundAmt = match.entryAmount;
      const paidDep = creatorPlayer?.paidFromDeposit || 0;
      const paidEarn = creatorPlayer?.paidFromEarnings || 0;
      const total = paidDep + paidEarn;
      const refundToDeposit = total > 0 ? Math.round((paidDep / total) * refundAmt * 100) / 100 : refundAmt;
      const refundToEarnings = refundAmt - refundToDeposit;
      const balBef = creator.walletBalance;
      await User.updateOne(
        { _id: creator._id },
        { $inc: { walletBalance: refundAmt, depositBalance: refundToDeposit, earningsBalance: refundToEarnings } }
      );
      await recordWalletTx(
        creator._id, 'credit', 'ludo_refund', refundAmt,
        `Ludo match expired (no opponent) — ₹${refundAmt} refunded`,
        balBef, balBef + refundAmt, match._id
      );
    }

    // Notify creator about expiry + refund
    await Notification.create({
      userId: match.creatorId,
      type: 'ludo',
      title: 'Ludo Match Expired',
      message: `No opponent joined your ₹${match.entryAmount} match. ₹${match.entryAmount} refunded to your wallet.`,
    });

    console.log(`[Ludo Cron] Expired waiting match ${match._id}, refunded creator`);

    if (io) {
      // Tell ALL clients to remove this match from open battles list instantly
      io.emit('ludo:match-expired', { matchId: match._id.toString() });
      // Tell creator their match was cancelled
      io.to(`user_${match.creatorId}`).emit('ludo:match-cancelled', { matchId: match._id.toString() });
    }
  }

  if (expiredIds.length > 0 && io) {
    io.emit('ludo:waiting-updated');
  }
}

// Expire live matches where room code was not submitted within roomCodeExpiryAt
// Full refund to BOTH players — no penalty before game starts
async function expireRoomCodeMatches(io) {
  const now = new Date();
  const expiredIds = await LudoMatch.find({
    status: 'live',
    roomCodeExpiryAt: { $lt: now },
    $or: [{ roomCode: { $exists: false } }, { roomCode: '' }, { roomCode: null }],
  }).distinct('_id');

  for (const matchId of expiredIds) {
    // Atomic claim — prevents double refund with checkExpiry endpoint
    const match = await LudoMatch.findOneAndUpdate(
      { _id: matchId, status: 'live', $or: [{ roomCode: { $exists: false } }, { roomCode: '' }, { roomCode: null }] },
      { $set: { status: 'cancelled', cancelledAt: now, cancelReason: 'Room code not shared in time' } },
      { new: true }
    );
    if (!match) continue; // Already processed

    // Refund both players (atomic $inc to prevent race with concurrent operations)
    for (const player of match.players) {
      const u = await User.findById(player.userId);
      if (u) {
        const refundAmt = player.amountPaid;
        const paidDep = player.paidFromDeposit || 0;
        const paidEarn = player.paidFromEarnings || 0;
        const total = paidDep + paidEarn;
        const refundToDeposit = total > 0 ? Math.round((paidDep / total) * refundAmt * 100) / 100 : refundAmt;
        const refundToEarnings = refundAmt - refundToDeposit;
        const balBef = u.walletBalance;
        await User.updateOne(
          { _id: u._id },
          { $inc: { walletBalance: refundAmt, depositBalance: refundToDeposit, earningsBalance: refundToEarnings } }
        );
        await recordWalletTx(
          u._id, 'credit', 'ludo_refund', refundAmt,
          `Room code not shared in time — ₹${refundAmt} refunded`,
          balBef, balBef + refundAmt, match._id
        );
      }

      await Notification.create({
        userId: player.userId,
        type: 'ludo',
        title: 'Ludo Match Expired',
        message: `Room code नहीं डाला गया। ₹${player.amountPaid} आपके wallet में वापस कर दिया गया।`,
      });

      if (io) {
        io.to(`user_${player.userId}`).emit('ludo:match-cancelled', { matchId: match._id.toString() });
        io.to(`user_${player.userId}`).emit('wallet:balance-updated');
      }
    }

    console.log(`[Ludo Cron] Room code expired for match ${match._id}, refunded both players`);
  }
}

function startLudoCron(io) {
  const runAll = async () => {
    try {
      await expireWaitingMatches(io);
    } catch (err) {
      console.error('[Ludo Cron] expireWaitingMatches error:', err);
    }
    try {
      await expireRoomCodeMatches(io);
    } catch (err) {
      console.error('[Ludo Cron] expireRoomCodeMatches error:', err);
    }
  };

  setInterval(runAll, RUN_INTERVAL_MS);
  runAll();
  console.log('[Ludo Cron] Started (expire waiting + room code matches every 15s)');
}

module.exports = { startLudoCron, expireWaitingMatches };
