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
      query.status = 'live';
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

    res.json({ ...match, timeRemainingMinutes: timeRemaining });
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
      .populate('matchId', 'roomCode entryAmount status players gameStartedAt gameExpiryAt creatorName')
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
    if (match.status !== 'live') {
      return res.status(400).json({ message: 'Match is not live' });
    }

    const pool = match.players.reduce((s, p) => s + p.amountPaid, 0);
    const { commission, winnerAmount } = await calcLudoCommission(pool, match.entryAmount);

    const winner = await User.findById(winnerId);
    if (!winner) return res.status(404).json({ message: 'Winner user not found' });
    const balBeforeWin = winner.walletBalance;
    winner.walletBalance += winnerAmount;
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
      // Refund all players
      for (const p of match.players) {
        const u = await User.findById(p.userId);
        if (u) {
          const balBef = u.walletBalance;
          u.walletBalance += p.amountPaid;
          await u.save();
          await recordWalletTx(
            p.userId, 'credit', 'ludo_refund', p.amountPaid,
            `Ludo match admin-cancelled — ₹${p.amountPaid} refunded`,
            balBef, u.walletBalance, match._id
          );
        }
      }
      await match.save();
      const io = req.app.get('io');
      if (io) {
        io.emit('ludo:waiting-updated');
        io.emit('ludo:match-live');
      }
      return res.json({ message: 'Match cancelled. All players refunded.', match });
    }

    if (status === 'completed' && winnerId) {
      const pool = match.players.reduce((s, p) => s + p.amountPaid, 0);
      const { commission, winnerAmount } = await calcLudoCommission(pool, match.entryAmount);
      const winner = await User.findById(winnerId);
      if (!winner) return res.status(404).json({ message: 'Winner user not found' });
      const balBef2 = winner.walletBalance;
      winner.walletBalance += winnerAmount;
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

module.exports = {
  getAllLudoMatches,
  getLudoMatchDetail,
  getLudoResultRequests,
  approveLudoResultRequest,
  rejectLudoResultRequest,
  updateLudoMatchStatus,
};
