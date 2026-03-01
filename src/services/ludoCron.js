const LudoMatch = require('../models/LudoMatch');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { recordWalletTx } = require('../utils/recordWalletTx');

const RUN_INTERVAL_MS = 15 * 1000; // every 15 seconds — fast expiry detection

async function expireWaitingMatches(io) {
  const now = new Date();
  const expired = await LudoMatch.find({
    status: 'waiting',
    joinExpiryAt: { $lt: now },
  });

  for (const match of expired) {
    const creator = await User.findById(match.creatorId);
    if (creator) {
      const balBef = creator.walletBalance;
      creator.walletBalance += match.entryAmount;
      await creator.save();
      await recordWalletTx(
        creator._id, 'credit', 'ludo_refund', match.entryAmount,
        `Ludo match expired (no opponent) — ₹${match.entryAmount} refunded`,
        balBef, creator.walletBalance, match._id
      );
    }
    match.status = 'cancelled';
    match.cancelledAt = now;
    match.cancelReason = 'Join time expired';
    await match.save();

    // Notify creator about expiry + refund
    await Notification.create({
      userId: match.creatorId,
      type: 'ludo',
      title: 'Ludo Match Expired',
      message: `No opponent joined your ₹${match.entryAmount} match. ₹${match.entryAmount} refunded to your wallet.`,
    });

    console.log(`[Ludo Cron] Expired waiting match ${match._id}, refunded creator`);

    // Targeted emit so creator's detail page auto-reloads immediately
    if (io) {
      io.to(`user_${match.creatorId}`).emit('ludo:match-cancelled', { matchId: match._id.toString() });
    }
  }

  if (expired.length > 0 && io) {
    io.emit('ludo:waiting-updated');
  }
}

// Expire live matches where room code was not submitted within roomCodeExpiryAt
// Full refund to BOTH players — no penalty before game starts
async function expireRoomCodeMatches(io) {
  const now = new Date();
  const expired = await LudoMatch.find({
    status: 'live',
    roomCodeExpiryAt: { $lt: now },
    $or: [{ roomCode: { $exists: false } }, { roomCode: '' }, { roomCode: null }],
  });

  for (const match of expired) {
    // Refund both players
    for (const player of match.players) {
      const u = await User.findById(player.userId);
      if (u) {
        const balBef = u.walletBalance;
        u.walletBalance += player.amountPaid;
        await u.save();
        await recordWalletTx(
          u._id, 'credit', 'ludo_refund', player.amountPaid,
          `Room code not shared in time — ₹${player.amountPaid} refunded`,
          balBef, u.walletBalance, match._id
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

    match.status = 'cancelled';
    match.cancelledAt = now;
    match.cancelReason = 'Room code not shared in time';
    await match.save();
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
