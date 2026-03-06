const User = require('../models/User');
const LudoMatch = require('../models/LudoMatch');
const LudoResultRequest = require('../models/LudoResultRequest');
const { calcLudoCommission } = require('../utils/ludoCommission');
const { recordWalletTx } = require('../utils/recordWalletTx');

// @desc    All Ludo matches (with filters); live matches with pending result request get hasPendingRequest: true
// @route   GET /api/admin/ludo/matches?status=waiting|live|completed|cancelled&page=1&limit=20
const getAllLudoMatches = async (req, res) => {
  try {
    const { status, page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const query = {};
    const isRequestedFilter = status === 'requested';
    if (status && !isRequestedFilter) query.status = status;

    const pendingMatchIds = await LudoResultRequest.find({ status: 'pending' }).distinct('matchId');

    if (isRequestedFilter) {
      query.status = { $in: ['live', 'cancel_requested'] };
      if (pendingMatchIds.length > 0) {
        query._id = { $in: pendingMatchIds };
      } else {
        return res.json({ data: [], totalCount: 0, page: pageNum, totalPages: 0 });
      }
    }

    const [matches, totalCount] = await Promise.all([
      LudoMatch.find(query).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      LudoMatch.countDocuments(query),
    ]);

    const now = new Date();
    const data = matches.map((m) => {
      const out = { ...m };
      if (m.status === 'live' && pendingMatchIds.some((id) => id && id.toString() === m._id.toString())) {
        out.hasPendingRequest = true;
      }
      if (m.status === 'live' && m.gameExpiryAt) {
        const ms = m.gameExpiryAt - now;
        out.timeRemainingMs = ms > 0 ? ms : 0;
      }
      if (m.status === 'waiting' && m.joinExpiryAt) {
        const ms = m.joinExpiryAt - now;
        out.timeRemainingMs = ms > 0 ? ms : 0;
      }
      return out;
    });

    res.json({ data, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Single Ludo match detail (admin)
// @route   GET /api/admin/ludo/matches/:id
const getLudoMatchDetail = async (req, res) => {
  try {
    const match = await LudoMatch.findById(req.params.id).lean();
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const now = new Date();
    let timeRemaining = null;
    if (match.status === 'live' && match.gameExpiryAt) {
      const ms = match.gameExpiryAt - now;
      timeRemaining = ms > 0 ? Math.ceil(ms / 60000) : 0; // minutes
    }
    if (match.status === 'waiting' && match.joinExpiryAt) {
      const ms = match.joinExpiryAt - now;
      timeRemaining = ms > 0 ? Math.ceil(ms / 60000) : 0;
    }

    // Also fetch the result request for this match (if any)
    const resultRequest = await LudoResultRequest.findOne({ matchId: match._id }).lean();

    res.json({ ...match, timeRemainingMinutes: timeRemaining, resultRequest: resultRequest || null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Pending result requests (one per match, claims array with both users' win/loss)
// @route   GET /api/admin/ludo/result-requests?status=pending
const getLudoResultRequests = async (req, res) => {
  try {
    const { status = 'pending' } = req.query;
    const requests = await LudoResultRequest.find({ status })
      .populate('matchId', 'roomCode entryAmount status players gameStartedAt gameExpiryAt creatorName cancelRequestedBy cancelReasonCode cancelReasonCustom')
      .sort({ updatedAt: -1 })
      .limit(50)
      .lean();

    res.json(requests);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Approve one user as winner (request has claims[]; body winnerId)
// @route   PUT /api/admin/ludo/result-requests/:id/approve
const approveLudoResultRequest = async (req, res) => {
  try {
    const request = await LudoResultRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    const { winnerId } = req.body;
    if (!winnerId) return res.status(400).json({ message: 'winnerId is required' });

    const match = await LudoMatch.findById(request.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (!['live', 'cancel_requested'].includes(match.status)) {
      return res.status(400).json({ message: 'Match is not in a valid state for approval' });
    }

    const pool = match.players.reduce((s, p) => s + p.amountPaid, 0);
    const { commission, winnerAmount } = await calcLudoCommission(pool, match.entryAmount);

    const winner = await User.findById(winnerId);
    if (!winner) return res.status(404).json({ message: 'Winner user not found' });
    const balBeforeWin = winner.walletBalance;
    winner.creditEarnings(winnerAmount);
    await winner.save();

    await recordWalletTx(
      winnerId, 'credit', 'ludo_win', winnerAmount,
      `Ludo match won — ₹${winnerAmount} prize`,
      balBeforeWin, winner.walletBalance, match._id
    );

    match.status = 'completed';
    match.winnerId = winnerId;
    await match.save();

    request.winnerId = winnerId;
    request.status = 'resolved';
    request.reviewedBy = req.user._id;
    request.reviewedAt = new Date();
    request.adminNote = req.body.note || null;
    await request.save();

    const Notification = require('../models/Notification');
    const io = req.app.get('io');

    // Notify winner
    const winnerNotif = await Notification.create({
      userId: winnerId,
      title: 'You Won!',
      message: `Congratulations! You won Rs. ${winnerAmount} in Ludo match.`,
      type: 'game',
    });
    if (io) {
      io.to(`user_${winnerId}`).emit('notification:new', winnerNotif);
      io.to(`user_${winnerId}`).emit('wallet:balance-updated', { walletBalance: winner.walletBalance });
    }

    // Notify rejected claimants
    const winClaimants = (request.claims || []).filter((c) => c.type === 'win').map((c) => c.userId.toString());
    const rejectedUserIds = winClaimants.filter((id) => id !== winnerId.toString());
    for (const uid of rejectedUserIds) {
      const rejectedNotif = await Notification.create({
        userId: uid,
        title: 'Request Rejected',
        message: 'Your request is rejected by the admin. Contact support.',
        type: 'game',
      });
      if (io) io.to(`user_${uid}`).emit('notification:new', rejectedNotif);
    }

    // Notify loser (opponent who is not the winner)
    const loserPlayer = match.players.find((p) => p.userId.toString() !== winnerId.toString());
    if (loserPlayer) {
      const loserNotif = await Notification.create({
        userId: loserPlayer.userId,
        title: 'Match Result',
        message: `You lost the Ludo match (₹${match.entryAmount}). Better luck next time!`,
        type: 'game',
      });
      if (io) io.to(`user_${loserPlayer.userId}`).emit('notification:new', loserNotif);
    }

    if (io) {
      io.emit('ludo:match-live');
      io.emit('ludo:waiting-updated');
    }

    res.json({
      message: 'Result approved. Winner credited.',
      match,
      winnerAmount,
      commission,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Reject entire result request (no winner)
// @route   PUT /api/admin/ludo/result-requests/:id/reject
const rejectLudoResultRequest = async (req, res) => {
  try {
    const request = await LudoResultRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request already processed' });
    }

    request.status = 'resolved';
    request.reviewedBy = req.user._id;
    request.reviewedAt = new Date();
    request.adminNote = req.body.note || 'Rejected';
    await request.save();

    // Notify all claimant users that their result was rejected
    const Notification = require('../models/Notification');
    const io = req.app.get('io');
    const claimUserIds = (request.claims || []).map((c) => c.userId.toString());
    // Also include legacy single userId if present
    if (request.userId && !claimUserIds.includes(request.userId.toString())) {
      claimUserIds.push(request.userId.toString());
    }
    for (const uid of claimUserIds) {
      const notif = await Notification.create({
        userId: uid,
        title: 'Result Rejected',
        message: 'Your Ludo match result request has been rejected by admin. Please submit again or contact support.',
        type: 'game',
      });
      if (io) io.to(`user_${uid}`).emit('notification:new', notif);
    }

    res.json({ message: 'Result request rejected' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Admin update match status (e.g. force complete / cancel)
// @route   PUT /api/admin/ludo/matches/:id/status
const updateLudoMatchStatus = async (req, res) => {
  try {
    const { status, winnerId, cancelReason } = req.body;
    const match = await LudoMatch.findById(req.params.id);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    if (status === 'cancelled') {
      match.status = 'cancelled';
      match.cancelledAt = new Date();
      match.cancelReason = cancelReason || 'Admin cancelled';
      const shouldRefund = req.body.refund !== false; // default true unless explicitly false
      const Notification = require('../models/Notification');
      const io = req.app.get('io');
      for (const p of match.players) {
        const u = await User.findById(p.userId);
        if (u) {
          if (shouldRefund) {
            const balBef = u.walletBalance;
            u.smartRefund(p.amountPaid, p.paidFromDeposit, p.paidFromEarnings);
            await u.save();
            await recordWalletTx(
              p.userId, 'credit', 'ludo_refund', p.amountPaid,
              `Ludo match admin-cancelled — ₹${p.amountPaid} refunded`,
              balBef, u.walletBalance, match._id
            );
            if (io) io.to(`user_${p.userId}`).emit('wallet:balance-updated', { walletBalance: u.walletBalance });
          }
          const notif = await Notification.create({
            userId: p.userId,
            title: 'Match Admin Cancelled',
            message: shouldRefund
              ? `Admin ने match cancel कर दिया। ₹${p.amountPaid} आपके wallet में वापस कर दिया गया।`
              : `Admin ने match cancel कर दिया। कोई refund नहीं मिलेगा।`,
            type: 'game',
          });
          if (io) io.to(`user_${p.userId}`).emit('notification:new', notif);
        }
      }
      await match.save();
      if (io) {
        io.emit('ludo:waiting-updated');
        io.emit('ludo:match-live');
      }
      return res.json({ message: shouldRefund ? 'Match cancelled. All players refunded.' : 'Match cancelled. No refund given.', match });
    }

    if (status === 'completed' && winnerId) {
      const pool = match.players.reduce((s, p) => s + p.amountPaid, 0);
      const { commission, winnerAmount } = await calcLudoCommission(pool, match.entryAmount);
      const winner = await User.findById(winnerId);
      if (!winner) return res.status(404).json({ message: 'Winner user not found' });
      const balBef2 = winner.walletBalance;
      winner.creditEarnings(winnerAmount);
      await winner.save();
      await recordWalletTx(
        winnerId, 'credit', 'ludo_win', winnerAmount,
        `Ludo match won (admin) — ₹${winnerAmount} prize`,
        balBef2, winner.walletBalance, match._id
      );
      match.status = 'completed';
      match.winnerId = winnerId;
      await match.save();
      return res.json({ message: 'Match completed. Winner credited.', match, winnerAmount, commission });
    }

    if (['waiting', 'live'].includes(status)) {
      match.status = status;
      await match.save();
      return res.json({ message: 'Match status updated.', match });
    }

    res.status(400).json({ message: 'Invalid status or missing winnerId' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Bulk delete cancelled/expired ludo matches
// @route   POST /api/admin/ludo/matches/bulk-delete
const bulkDeleteLudoMatches = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'No match IDs provided' });
    }
    // Only allow deleting cancelled matches
    const result = await LudoMatch.deleteMany({ _id: { $in: ids }, status: 'cancelled' });
    // Also clean up any result requests for these matches
    await LudoResultRequest.deleteMany({ matchId: { $in: ids } });
    res.json({ message: `${result.deletedCount} matches deleted` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Resolve cancel dispute or cancel_accepted — admin sets refund or declares winner
// @route   PUT /api/admin/ludo/result-requests/:id/resolve-dispute
const resolveDispute = async (req, res) => {
  try {
    const request = await LudoResultRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Request already processed' });
    }
    if (!['cancel_dispute', 'cancel_accepted'].includes(request.disputeType)) {
      return res.status(400).json({ message: 'This is not a cancel dispute/accepted request' });
    }

    const { refundDecisions, adminNote, winnerId } = req.body;

    const match = await LudoMatch.findById(request.matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const Notification = require('../models/Notification');
    const io = req.app.get('io');
    const savedDecisions = [];

    if (winnerId) {
      // Winner declared — give full prize via commission calculation
      const winnerPlayer = match.players.find((p) => p.userId.toString() === winnerId.toString());
      if (!winnerPlayer) return res.status(400).json({ message: 'Winner not found in match players' });

      const pool = match.players.reduce((s, p) => s + p.amountPaid, 0);
      const { commission, winnerAmount } = await calcLudoCommission(pool, match.entryAmount);

      const winner = await User.findById(winnerId);
      if (winner) {
        const balBef = winner.walletBalance;
        winner.creditEarnings(winnerAmount);
        await winner.save();
        await recordWalletTx(
          winner._id, 'credit', 'ludo_win', winnerAmount,
          `Ludo cancel dispute resolved — ₹${winnerAmount} prize`,
          balBef, winner.walletBalance, match._id
        );
        if (io) io.to(`user_${winner._id}`).emit('wallet:balance-updated', { walletBalance: winner.walletBalance });
        const winNotif = await Notification.create({
          userId: winner._id,
          title: 'आप जीत गए!',
          message: `Admin ने cancel dispute resolve कर दिया। आपको ₹${winnerAmount} prize मिला!`,
          type: 'game',
        });
        if (io) io.to(`user_${winner._id}`).emit('notification:new', winNotif);
        savedDecisions.push({ userId: winner._id, userName: winner.name || winnerPlayer.userName, refundType: 'full', amount: winnerAmount });
      }

      // Loser (other player) gets 0
      for (const player of match.players) {
        if (player.userId.toString() !== winnerId.toString()) {
          const loserNotif = await Notification.create({
            userId: player.userId,
            title: 'Dispute Resolved',
            message: `Admin ने cancel dispute resolve कर दिया। ${winnerPlayer.userName} को winner declare किया गया। कोई refund नहीं मिलेगा।`,
            type: 'game',
          });
          if (io) io.to(`user_${player.userId}`).emit('notification:new', loserNotif);
          savedDecisions.push({ userId: player.userId, userName: player.userName, refundType: 'zero', amount: 0 });
        }
      }

      match.status = 'completed';
      match.winnerId = winnerId;

    } else {
      // Refund mode — process refund decisions for each player
      if (!Array.isArray(refundDecisions) || refundDecisions.length === 0) {
        return res.status(400).json({ message: 'refundDecisions array is required when no winner' });
      }

      // Calculate the total prize pool for refund_win_percent option
      const pool = match.players.reduce((s, p) => s + (p.amountPaid || 0), 0);
      const { winnerAmount: prizePool } = await calcLudoCommission(pool, match.entryAmount);

      for (const decision of refundDecisions) {
        const player = match.players.find((p) => p.userId.toString() === decision.userId.toString());
        if (!player) continue;

        let refundAmount = 0;
        if (decision.refundType === 'full') {
          refundAmount = player.amountPaid;
        } else if (decision.refundType === 'percent30') {
          refundAmount = Math.round(player.amountPaid * 0.3);
        } else if (decision.refundType === 'zero') {
          refundAmount = 0;
        } else if (decision.refundType === 'custom') {
          refundAmount = Math.max(0, Number(decision.customAmount) || 0);
        } else if (decision.refundType === 'custom_percent') {
          // Custom % of entry amount
          const pct = Math.max(0, Math.min(100, Number(decision.customPercent) || 0));
          refundAmount = Math.round((player.amountPaid || 0) * pct / 100);
        } else if (decision.refundType === 'refund_win_percent') {
          // Entry refund + (X% of one side's entry, after commission deducted proportionally)
          // = amountPaid + round(amountPaid * winPct/100 * prizePool/pool)
          const winPct = Math.max(0, Math.min(100, Number(decision.winPercent) || 0));
          const winPortion = pool > 0 ? Math.round((player.amountPaid || 0) * winPct / 100 * prizePool / pool) : 0;
          refundAmount = (player.amountPaid || 0) + winPortion;
        }

        savedDecisions.push({
          userId: player.userId,
          userName: player.userName,
          refundType: decision.refundType,
          winPercent: decision.refundType === 'refund_win_percent' ? (Number(decision.winPercent) || 0) : null,
          customPercent: decision.refundType === 'custom_percent' ? (Number(decision.customPercent) || 0) : null,
          amount: refundAmount,
        });

        if (refundAmount > 0) {
          const pUser = await User.findById(player.userId);
          if (pUser) {
            const balBef = pUser.walletBalance;
            pUser.smartRefund(refundAmount, player.paidFromDeposit, player.paidFromEarnings);
            await pUser.save();
            await recordWalletTx(
              pUser._id, 'credit', 'ludo_refund', refundAmount,
              `Ludo cancel dispute resolved — ₹${refundAmount} refunded`,
              balBef, pUser.walletBalance, match._id
            );
            if (io) io.to(`user_${player.userId}`).emit('wallet:balance-updated', { walletBalance: pUser.walletBalance });
          }
        }

        const refundMsg = decision.refundType === 'refund_win_percent' && refundAmount > 0
          ? `₹${player.amountPaid || 0} entry refund + ₹${refundAmount - (player.amountPaid || 0)} winning amount (${decision.winPercent || 0}%) — कुल ₹${refundAmount} wallet में मिला।`
          : decision.refundType === 'custom_percent' && refundAmount > 0
          ? `₹${refundAmount} refund (${decision.customPercent || 0}% of entry) आपके wallet में मिला।`
          : refundAmount > 0
            ? `₹${refundAmount} आपके wallet में वापस कर दिया गया।`
            : 'आपको कोई refund नहीं मिलेगा।';

        const notif = await Notification.create({
          userId: player.userId,
          title: 'Dispute Resolved',
          message: `Admin ने dispute resolve कर दिया। ${refundMsg}`,
          type: 'game',
        });
        if (io) io.to(`user_${player.userId}`).emit('notification:new', notif);
      }

      match.status = 'cancelled';
      match.cancelledAt = new Date();
      match.cancelReason = 'Cancel dispute resolved by admin';
    }

    await match.save();

    request.status = 'resolved';
    request.refundDecisions = savedDecisions;
    request.winnerId = winnerId || null;
    request.reviewedBy = req.user._id;
    request.reviewedAt = new Date();
    request.adminNote = adminNote || null;
    await request.save();

    // Emit match-resolved to all players for real-time UI refresh
    if (io) {
      for (const player of match.players) {
        io.to(`user_${player.userId}`).emit('ludo:match-resolved', { matchId: match._id.toString() });
      }
      io.emit('ludo:match-live');
      io.emit('ludo:waiting-updated');
    }

    res.json({ message: 'Dispute resolved. Players notified.', savedDecisions });
  } catch (error) {
    console.error('resolveDispute error:', error?.message, error?.stack || error);
    res.status(500).json({ message: error.message || 'Server error', detail: error?.stack?.split('\n')[0] });
  }
};

module.exports = {
  getAllLudoMatches,
  getLudoMatchDetail,
  getLudoResultRequests,
  approveLudoResultRequest,
  rejectLudoResultRequest,
  resolveDispute,
  updateLudoMatchStatus,
  bulkDeleteLudoMatches,
};
