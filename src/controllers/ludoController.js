const sharp = require('sharp');
const User = require('../models/User');
const LudoMatch = require('../models/LudoMatch');
const LudoResultRequest = require('../models/LudoResultRequest');
const Notification = require('../models/Notification');
const AdminSettings = require('../models/AdminSettings');
const { uploadFromBuffer } = require('../config/cloudinary');
const { calcLudoCommission, getCommissionTiers } = require('../utils/ludoCommission');
const { recordWalletTx } = require('../utils/recordWalletTx');
const { sendPushToAdmins } = require('../config/firebase');

const ENTRY_MIN = 50;
const WAITING_EXPIRY_MINUTES = 10;
const MAX_PLAYERS = 2;
const ROOM_CODE_EXPIRY_MINUTES = 4;

// @desc    Create Ludo match (entry amount only; room code added later after opponent joins)
// @route   POST /api/ludo/create
const createMatch = async (req, res) => {
  try {
    // Check if Ludo is enabled
    const adminSettings = await AdminSettings.findOne({ key: 'main' });
    if (adminSettings && adminSettings.ludoEnabled === false) {
      const reason = adminSettings.ludoDisableReason || 'Ludo games are currently disabled.';
      return res.status(403).json({ message: reason });
    }

    const { entryAmount } = req.body;
    const amount = Number(entryAmount);

    if (!amount || amount < ENTRY_MIN) {
      return res.status(400).json({ message: `Minimum entry is Rs. ${ENTRY_MIN}` });
    }

    const user = await User.findById(req.user._id);
    if (user.walletBalance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const joinExpiryAt = new Date(Date.now() + WAITING_EXPIRY_MINUTES * 60 * 1000);

    const balBeforeCreate = user.walletBalance;
    const { fromDeposit, fromEarnings } = user.smartDeduct(amount);
    await user.save();

    const match = await LudoMatch.create({
      entryAmount: amount,
      creatorId: req.user._id,
      creatorName: user.name,
      status: 'waiting',
      players: [{ userId: req.user._id, userName: user.name, amountPaid: amount, paidFromDeposit: fromDeposit, paidFromEarnings: fromEarnings, joinedAt: new Date() }],
      joinExpiryAt,
    });

    await recordWalletTx(
      user._id, 'debit', 'ludo_entry', amount,
      `Ludo match created — entry fee ₹${amount}`,
      balBeforeCreate, user.walletBalance, match._id
    );

    const io = req.app.get('io');
    io.emit('ludo:waiting-updated');

    res.status(201).json({
      message: 'Match created. Wait for someone to join.',
      match: {
        _id: match._id,
        entryAmount: match.entryAmount,
        status: match.status,
        joinExpiryAt: match.joinExpiryAt,
      },
      newBalance: user.walletBalance,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Submit Ludo King room code (creator only) — game starts immediately
// @route   POST /api/ludo/submit-room-code
const submitRoomCode = async (req, res) => {
  try {
    const { matchId, roomCode } = req.body;
    if (!matchId || !roomCode || typeof roomCode !== 'string') {
      return res.status(400).json({ message: 'Match ID and room code are required' });
    }

    const code = String(roomCode).trim().toUpperCase().slice(0, 10);
    if (!code) return res.status(400).json({ message: 'Invalid room code' });

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.creatorId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Only the creator can submit the room code' });
    }
    if (match.status !== 'waiting' && match.status !== 'live') {
      return res.status(400).json({ message: 'Cannot set room code for this match' });
    }

    const now = new Date();
    match.roomCode = code;
    // Game starts immediately — no confirm step, no countdown
    match.gameActualStartAt = now;
    match.gameStartedAt = now;
    await match.save();

    // Notify both players via socket that game has started
    const io = req.app.get('io');
    if (io) {
      for (const player of match.players) {
        io.to(`user_${player.userId}`).emit('ludo:game-started', {
          matchId: match._id.toString(),
          roomCode: code,
          gameActualStartAt: match.gameActualStartAt,
          gameStartedAt: match.gameStartedAt,
        });
      }
    }

    res.json({
      message: 'Room code saved. Game started!',
      match: {
        _id: match._id,
        roomCode: match.roomCode,
        entryAmount: match.entryAmount,
        status: match.status,
        gameActualStartAt: match.gameActualStartAt,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Join match by matchId (Confirm and Start). Check status is still waiting.
// @route   POST /api/ludo/join
const joinMatch = async (req, res) => {
  try {
    // Check if Ludo is enabled
    const adminSettings = await AdminSettings.findOne({ key: 'main' });
    if (adminSettings && adminSettings.ludoEnabled === false) {
      const reason = adminSettings.ludoDisableReason || 'Ludo games are currently disabled.';
      return res.status(403).json({ message: reason });
    }

    const { matchId } = req.body;
    if (!matchId) {
      return res.status(400).json({ message: 'Match ID is required' });
    }

    const match = await LudoMatch.findById(matchId);
    if (!match) {
      return res.status(404).json({ message: 'Match not found' });
    }
    if (match.status !== 'waiting') {
      return res.status(400).json({ message: 'This game has been taken by another person.' });
    }

    if (match.creatorId.toString() === req.user._id.toString()) {
      return res.status(400).json({ message: 'You cannot join your own match' });
    }
    if (match.joinExpiryAt && new Date() > match.joinExpiryAt) {
      return res.status(400).json({ message: 'This match has expired' });
    }
    if (match.players.length >= MAX_PLAYERS) {
      return res.status(400).json({ message: 'This game has been taken by another person.' });
    }

    const user = await User.findById(req.user._id);
    if (user.walletBalance < match.entryAmount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    const balBeforeJoin = user.walletBalance;
    const { fromDeposit, fromEarnings } = user.smartDeduct(match.entryAmount);
    await user.save();

    await recordWalletTx(
      user._id, 'debit', 'ludo_entry', match.entryAmount,
      `Ludo match joined — entry fee ₹${match.entryAmount}`,
      balBeforeJoin, user.walletBalance, match._id
    );

    match.players.push({
      userId: req.user._id,
      userName: user.name,
      amountPaid: match.entryAmount,
      paidFromDeposit: fromDeposit,
      paidFromEarnings: fromEarnings,
      joinedAt: new Date(),
    });
    match.status = 'live';
    match.gameStartedAt = new Date();
    match.roomCodeExpiryAt = new Date(Date.now() + ROOM_CODE_EXPIRY_MINUTES * 60 * 1000);
    await match.save();

    const io = req.app.get('io');
    io.emit('ludo:match-live', { matchId: match._id, match: match.toObject ? match.toObject() : match });
    io.emit('ludo:waiting-updated');
    io.to('admins').emit('admin:ludo-match-live', { matchId: match._id });

    // Notify creator that opponent joined
    const creatorNotif = await Notification.create({
      userId: match.creatorId,
      title: 'Opponent Joined!',
      message: `${user.name || 'A player'} joined your Ludo match (₹${match.entryAmount}). Open Ludo King and start playing!`,
      type: 'game',
    });
    io.to(`user_${match.creatorId}`).emit('notification:new', creatorNotif);

    res.json({
      message: 'You joined the match. Open Ludo King app and paste the room code.',
      match: {
        _id: match._id,
        roomCode: match.roomCode,
        entryAmount: match.entryAmount,
        status: match.status,
        gameStartedAt: match.gameStartedAt,
        players: match.players,
      },
      newBalance: user.walletBalance,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// Cancel reason labels (for display)
const CANCEL_REASON_LABELS = {
  connection_issue: 'Internet / Connection में Problem',
  game_not_loaded: 'Game Load नहीं हुआ',
  wrong_room_code: 'Room Code गलत था',
  opponent_left: 'Opponent ने Game छोड़ दिया',
  other: 'अन्य कारण',
};

// Win dispute reason labels
const WIN_REASON_LABELS = {
  i_clearly_won: 'मैंने Clearly Game जीता है',
  opponent_left_mid_game: 'Opponent ने बीच में Game छोड़ दिया',
  have_proof: 'मेरे पास Screenshot Proof है',
  unfair_cancel: 'Cancel Request अनुचित था',
  other: 'अन्य कारण',
};

// @desc    Request cancel after game has started — saves reason, notifies opponent
// @route   POST /api/ludo/request-cancel
const requestCancel = async (req, res) => {
  try {
    const { matchId, reasonCode, customReason } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Match ID is required' });
    if (!reasonCode) return res.status(400).json({ message: 'Cancel reason is required' });

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isPlayer) return res.status(403).json({ message: 'You are not in this match' });

    if (match.status !== 'live') {
      return res.status(400).json({ message: 'Cancel request can only be made for live matches' });
    }
    if (!match.roomCode || !match.roomCode.trim()) {
      return res.status(400).json({ message: 'Game has not started yet. Use regular cancel instead.' });
    }

    // Check no result request already exists
    const hasRequest = await LudoResultRequest.findOne({ matchId: match._id });
    if (hasRequest) {
      return res.status(400).json({ message: 'A result request already exists for this match.' });
    }

    const reasonLabel = CANCEL_REASON_LABELS[reasonCode] || reasonCode;
    const displayReason = reasonCode === 'other' ? (customReason || 'अन्य कारण') : reasonLabel;

    match.status = 'cancel_requested';
    match.cancelRequestedBy = req.user._id;
    match.cancelRequestedAt = new Date();
    match.cancelReasonCode = reasonCode;
    match.cancelReasonCustom = reasonCode === 'other' ? customReason : null;
    await match.save();

    const io = req.app.get('io');
    const otherPlayer = match.players.find((p) => p.userId.toString() !== userId);

    if (otherPlayer) {
      const notif = await Notification.create({
        userId: otherPlayer.userId,
        title: 'Cancel Request मिली',
        message: `${req.user.name} ने game cancel करने की request दी है। कारण: "${displayReason}"`,
        type: 'game',
      });
      if (io) {
        io.to(`user_${otherPlayer.userId}`).emit('notification:new', notif);
        io.to(`user_${otherPlayer.userId}`).emit('ludo:cancel-requested', {
          matchId: match._id.toString(),
          cancellerName: req.user.name,
          reasonCode,
          displayReason,
        });
      }
    }

    // Notify canceller too
    if (io) {
      io.to(`user_${userId}`).emit('ludo:cancel-request-sent', { matchId: match._id.toString() });
    }

    res.json({ message: 'Cancel request submitted. Opponent has been notified.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Accept opponent's cancel request — sends to admin for refund review
// @route   POST /api/ludo/accept-cancel
const acceptCancel = async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Match ID is required' });

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isPlayer) return res.status(403).json({ message: 'You are not in this match' });

    if (match.status !== 'cancel_requested') {
      return res.status(400).json({ message: 'No pending cancel request for this match' });
    }
    // Only the OTHER player (not the one who requested) can accept
    if (match.cancelRequestedBy.toString() === userId) {
      return res.status(400).json({ message: 'You cannot accept your own cancel request' });
    }

    // Check no result request already exists
    const hasRequest = await LudoResultRequest.findOne({ matchId: match._id });
    if (hasRequest) {
      return res.status(400).json({ message: 'A result request already exists for this match.' });
    }

    // Create cancel_accepted result request — admin will decide refunds
    const request = await LudoResultRequest.create({
      matchId: match._id,
      disputeType: 'cancel_accepted',
      claims: [],
      status: 'pending',
    });

    const io = req.app.get('io');

    // Notify admin
    if (io) {
      io.to('admins').emit('admin:ludo-result-request', {
        requestId: request._id,
        matchId: match._id,
        userName: req.user.name,
        disputeType: 'cancel_accepted',
      });
    }

    // Notify both players that admin will now decide
    for (const player of match.players) {
      const notif = await Notification.create({
        userId: player.userId,
        title: 'Cancel Accept — Admin Review',
        message: `Cancel accept हो गया। Admin refund तय करेगा और जल्द ही पैसा वापस होगा।`,
        type: 'game',
      });
      if (io) {
        io.to(`user_${player.userId}`).emit('notification:new', notif);
        io.to(`user_${player.userId}`).emit('ludo:cancel-accepted', { matchId: match._id.toString() });
      }
    }

    res.json({ message: 'Cancel accepted. Admin will decide the refund amounts.', requestId: request._id });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Submit win claim after opponent's cancel request (dispute)
// @route   POST /api/ludo/submit-win-dispute (multipart: screenshot)
const submitWinDispute = async (req, res) => {
  try {
    const { matchId, winReasonCode, winReasonCustom } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Match ID is required' });
    if (!winReasonCode) return res.status(400).json({ message: 'Win reason is required' });
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Screenshot is required' });
    }

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isPlayer) return res.status(403).json({ message: 'You are not in this match' });

    if (match.status !== 'cancel_requested') {
      return res.status(400).json({ message: 'No pending cancel request for this match' });
    }
    // Only the OTHER player (not the canceller) can submit win dispute
    if (match.cancelRequestedBy.toString() === userId) {
      return res.status(400).json({ message: 'You cannot submit a win claim on your own cancel request' });
    }

    let request = await LudoResultRequest.findOne({ matchId: match._id });
    if (request) {
      return res.status(400).json({ message: 'A result request already exists for this match.' });
    }

    let screenshotUrl;
    try {
      const compressedBuffer = await sharp(req.file.buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      screenshotUrl = await uploadFromBuffer(compressedBuffer, 'lean_aviator/ludo_results', 'image/jpeg');
    } catch (uploadErr) {
      console.error(uploadErr);
      return res.status(500).json({ message: 'Failed to upload screenshot' });
    }

    const winReasonLabel = WIN_REASON_LABELS[winReasonCode] || winReasonCode;
    const displayWinReason = winReasonCode === 'other' ? (winReasonCustom || 'अन्य') : winReasonLabel;

    request = await LudoResultRequest.create({
      matchId: match._id,
      disputeType: 'cancel_dispute',
      claims: [{
        userId: req.user._id,
        userName: req.user.name,
        type: 'win_dispute',
        screenshotUrl,
        winReasonCode,
        winReasonCustom: winReasonCode === 'other' ? winReasonCustom : null,
        createdAt: new Date(),
      }],
      status: 'pending',
    });

    const io = req.app.get('io');
    io.to('admins').emit('admin:ludo-result-request', {
      requestId: request._id,
      matchId: match._id,
      userName: req.user.name,
      disputeType: 'cancel_dispute',
    });

    await Notification.create({
      userId: req.user._id,
      title: 'Win Dispute Submitted',
      message: `आपका win claim submit हो गया (कारण: "${displayWinReason}")। Admin verify करेगा।`,
      type: 'game',
    });

    // Notify the canceller that opponent disputed
    const cancellerPlayer = match.players.find((p) => p.userId.toString() === match.cancelRequestedBy.toString());
    if (cancellerPlayer) {
      const notif = await Notification.create({
        userId: cancellerPlayer.userId,
        title: 'Opponent ने Win Claim किया',
        message: `${req.user.name} ने आपकी cancel request को dispute किया है। Admin decide करेगा।`,
        type: 'game',
      });
      if (io) {
        io.to(`user_${cancellerPlayer.userId}`).emit('notification:new', notif);
        // Trigger UI refresh on canceller's screen
        io.to(`user_${cancellerPlayer.userId}`).emit('ludo:win-dispute-submitted', { matchId: match._id.toString() });
      }
    }

    // Push notification to admins
    sendPushToAdmins(
      'Ludo Win Dispute',
      `${req.user.name} ne win dispute submit kiya - Rs.${match.entryAmount} match`,
      { type: 'ludo_dispute' }
    );

    res.status(201).json({ message: 'Win dispute submitted. Admin will review and decide.', request: { _id: request._id } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Cancel match — 3 cases: waiting (creator only), live+no room code (either player), live+room code (reject)
// @route   POST /api/ludo/cancel
const cancelMatch = async (req, res) => {
  try {
    const { matchId } = req.body;
    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isCreator = match.creatorId.toString() === userId;
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);

    // Case 1: Waiting — only creator can cancel
    if (match.status === 'waiting') {
      if (!isCreator) {
        return res.status(403).json({ message: 'Only the creator can cancel' });
      }

      const user = await User.findById(req.user._id);
      const creatorPlayer = match.players.find(p => p.userId.toString() === user._id.toString());
      const balBeforeCancel = user.walletBalance;
      user.smartRefund(match.entryAmount, creatorPlayer?.paidFromDeposit, creatorPlayer?.paidFromEarnings);
      await user.save();

      await recordWalletTx(
        user._id, 'credit', 'ludo_refund', match.entryAmount,
        `Ludo match cancelled by creator — ₹${match.entryAmount} refunded`,
        balBeforeCancel, user.walletBalance, match._id
      );

      match.status = 'cancelled';
      match.cancelledAt = new Date();
      match.cancelReason = 'Creator cancelled';
      await match.save();

      const io = req.app.get('io');
      io.emit('ludo:waiting-updated');

      return res.json({
        message: 'Match cancelled. Entry fee refunded.',
        newBalance: user.walletBalance,
      });
    }

    // Case 2: Live + no room code — either player can cancel, full refund to both
    if (match.status === 'live') {
      if (!isPlayer) {
        return res.status(403).json({ message: 'You are not in this match' });
      }

      const hasRoomCode = match.roomCode && match.roomCode.trim() !== '';
      if (hasRoomCode) {
        return res.status(400).json({ message: 'Game has started. Use "Cancel as loss" instead.' });
      }

      // Full refund to both players
      const io = req.app.get('io');
      for (const player of match.players) {
        const pUser = await User.findById(player.userId);
        if (pUser) {
          const balBef = pUser.walletBalance;
          pUser.smartRefund(player.amountPaid, player.paidFromDeposit, player.paidFromEarnings);
          await pUser.save();
          await recordWalletTx(
            pUser._id, 'credit', 'ludo_refund', player.amountPaid,
            `Ludo match cancelled before room code — ₹${player.amountPaid} refunded`,
            balBef, pUser.walletBalance, match._id
          );

          if (io) {
            io.to(`user_${player.userId}`).emit('wallet:balance-updated', { walletBalance: pUser.walletBalance });
            io.to(`user_${player.userId}`).emit('ludo:match-cancelled', { matchId: match._id.toString() });
          }
        }
      }

      match.status = 'cancelled';
      match.cancelledAt = new Date();
      match.cancelReason = 'Cancelled before room code (full refund)';
      await match.save();

      if (io) {
        io.emit('ludo:match-live');
        io.emit('ludo:waiting-updated');
      }

      const updatedUser = await User.findById(req.user._id);
      return res.json({
        message: 'Match cancelled. Full refund to both players.',
        newBalance: updatedUser.walletBalance,
      });
    }

    return res.status(400).json({ message: 'Match cannot be cancelled in its current state.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get single match for join flow (check if still waiting; no auth for viewing list, but join requires auth)
// @route   GET /api/ludo/match/:id/check
const checkMatchWaiting = async (req, res) => {
  try {
    const match = await LudoMatch.findById(req.params.id)
      .select('_id entryAmount creatorName status joinExpiryAt roomCode')
      .lean();
    if (!match) return res.status(404).json({ message: 'Match not found' });
    if (match.status !== 'waiting') {
      return res.json({ ok: false, message: 'This game has been taken by another person.' });
    }
    if (match.joinExpiryAt && new Date() > match.joinExpiryAt) {
      return res.json({ ok: false, message: 'This match has expired.' });
    }
    res.json({ ok: true, match: { _id: match._id, entryAmount: match.entryAmount, creatorName: match.creatorName, joinExpiryAt: match.joinExpiryAt } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get my matches (waiting / live / history)
// @route   GET /api/ludo/my-matches?status=waiting|live|history&page=1&limit=25
const getMyMatches = async (req, res) => {
  try {
    const { status, page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;
    const userId = req.user._id;

    const query = {
      $or: [{ creatorId: userId }, { 'players.userId': userId }],
    };

    if (status === 'waiting') {
      query.status = 'waiting';
    } else if (status === 'live') {
      // Include both live and cancel_requested (so both players can see and respond)
      query.status = { $in: ['live', 'cancel_requested'] };
      // Exclude matches that already have a result request (pending admin review)
      const matchIdsWithResult = await LudoResultRequest.find({}).distinct('matchId');
      if (matchIdsWithResult.length > 0) {
        query._id = { $nin: matchIdsWithResult };
      }
    } else if (status === 'requested') {
      // Matches with a result request (pending admin review) — includes cancel disputes
      query.status = { $in: ['live', 'cancel_requested'] };
      const matchIdsWithResult = await LudoResultRequest.find({}).distinct('matchId');
      if (matchIdsWithResult.length > 0) {
        query._id = { $in: matchIdsWithResult };
      } else {
        return res.json({ records: [], totalCount: 0, page: 1, totalPages: 0 });
      }
    } else if (status === 'history') {
      query.status = { $in: ['completed', 'cancelled'] };
    }

    const [matches, totalCount] = await Promise.all([
      LudoMatch.find(query)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      LudoMatch.countDocuments(query),
    ]);

    res.json({
      records: matches,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get single match detail (participant only) + result request if any
// @route   GET /api/ludo/match/:id
const getMatchDetail = async (req, res) => {
  try {
    const match = await LudoMatch.findById(req.params.id).lean();
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isCreator = match.creatorId.toString() === userId;
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isCreator && !isPlayer) {
      return res.status(403).json({ message: 'You are not in this match' });
    }

    const resultRequest = await LudoResultRequest.findOne({ matchId: match._id }).lean();
    const response = { ...match, resultRequest: resultRequest || null };
    res.json(response);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Submit result (screenshot) - claim win. One request per match; add claim.
// @route   POST /api/ludo/submit-result (multipart: screenshot)
const submitResult = async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Match ID is required' });
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Screenshot is required' });
    }

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isPlayer) return res.status(403).json({ message: 'You are not in this match' });
    if (match.status !== 'live') {
      return res.status(400).json({ message: 'Result can only be submitted for live matches' });
    }

    let request = await LudoResultRequest.findOne({ matchId: match._id });
    if (request && request.claims.some((c) => c.userId.toString() === userId)) {
      return res.status(400).json({ message: 'You have already submitted a claim for this match.' });
    }
    if (request && request.status === 'resolved') {
      return res.status(400).json({ message: 'This match result is already resolved.' });
    }

    let screenshotUrl;
    try {
      const compressedBuffer = await sharp(req.file.buffer)
        .resize({ width: 1200, withoutEnlargement: true })
        .jpeg({ quality: 70 })
        .toBuffer();
      screenshotUrl = await uploadFromBuffer(
        compressedBuffer,
        'lean_aviator/ludo_results',
        'image/jpeg'
      );
    } catch (uploadErr) {
      console.error(uploadErr);
      return res.status(500).json({ message: 'Failed to upload screenshot' });
    }

    const { winReasonCode, winReasonCustom } = req.body;
    const claim = {
      userId: req.user._id,
      userName: req.user.name,
      type: 'win',
      screenshotUrl,
      winReasonCode: winReasonCode || null,
      winReasonCustom: winReasonCode === 'other' ? (winReasonCustom || null) : null,
      createdAt: new Date(),
    };

    if (!request) {
      request = await LudoResultRequest.create({
        matchId: match._id,
        claims: [claim],
        status: 'pending',
      });
    } else {
      request.claims.push(claim);
      await request.save();
    }

    const io = req.app.get('io');
    io.to('admins').emit('admin:ludo-result-request', {
      requestId: request._id,
      matchId: match._id,
      userName: req.user.name,
    });

    await Notification.create({
      userId: req.user._id,
      title: 'Result Submitted',
      message: 'Your Ludo match result has been submitted for admin approval.',
      type: 'game',
    });

    // Push notification to admins
    sendPushToAdmins(
      'Ludo Result Submitted',
      `${req.user.name} ne Rs.${match.entryAmount} match ka result submit kiya`,
      { type: 'ludo_result' }
    );

    res.status(201).json({
      message: 'Result submitted. Admin will verify and approve.',
      request: { _id: request._id, status: request.status },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Submit "I lost" - add loss claim to same request (no screenshot)
// @route   POST /api/ludo/submit-loss
const submitLoss = async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Match ID is required' });

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isPlayer) return res.status(403).json({ message: 'You are not in this match' });
    if (match.status !== 'live') {
      return res.status(400).json({ message: 'Match is not live' });
    }

    let request = await LudoResultRequest.findOne({ matchId: match._id });
    if (request && request.claims.some((c) => c.userId.toString() === userId)) {
      return res.status(400).json({ message: 'You have already submitted a claim for this match.' });
    }
    if (request && request.status === 'resolved') {
      return res.status(400).json({ message: 'This match result is already resolved.' });
    }

    const claim = {
      userId: req.user._id,
      userName: req.user.name,
      type: 'loss',
      screenshotUrl: null,
      createdAt: new Date(),
    };

    if (!request) {
      request = await LudoResultRequest.create({
        matchId: match._id,
        claims: [claim],
        status: 'pending',
      });
    } else {
      request.claims.push(claim);
      await request.save();
    }

    const io = req.app.get('io');
    io.to('admins').emit('admin:ludo-result-request', { requestId: request._id, matchId: match._id, userName: req.user.name });

    // Notify the OTHER player that this user submitted loss
    const otherPlayer = match.players.find((p) => p.userId.toString() !== userId);
    if (otherPlayer && io) {
      io.to(`user_${otherPlayer.userId}`).emit('ludo:loss-submitted', {
        matchId: match._id.toString(),
        loserName: req.user.name,
        winnerName: otherPlayer.userName,
      });
    }

    res.json({ message: 'Loss submitted. Admin will decide winner.', request: { _id: request._id } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Cancel as "I lost" (forfeit) - only after room code. 0% refund to canceller, 100% to other.
// @route   POST /api/ludo/cancel-as-loss
const cancelAsLoss = async (req, res) => {
  try {
    const { matchId } = req.body;
    if (!matchId) return res.status(400).json({ message: 'Match ID is required' });

    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    const userId = req.user._id.toString();
    const isPlayer = match.players.some((p) => p.userId.toString() === userId);
    if (!isPlayer) return res.status(403).json({ message: 'You are not in this match' });
    if (match.status !== 'live') {
      return res.status(400).json({ message: 'Match is not live' });
    }

    // Guard: only allowed after room code has been set (game started)
    if (!match.roomCode || !match.roomCode.trim()) {
      return res.status(400).json({ message: 'Game has not started yet. Use regular cancel instead.' });
    }

    const hasRequest = await LudoResultRequest.findOne({ matchId: match._id });
    if (hasRequest && hasRequest.claims && hasRequest.claims.length > 0) {
      return res.status(400).json({ message: 'A result request already exists. You cannot cancel.' });
    }

    const entryAmount = match.entryAmount;
    // Canceller gets 0% — full penalty for cancelling after game has started
    // Other player gets 100% refund of their own bet only
    const cancellerRefund = 0;
    const otherRefund = entryAmount;

    const canceller = await User.findById(req.user._id);
    const otherPlayer = match.players.find((p) => p.userId.toString() !== userId);
    if (!otherPlayer) return res.status(400).json({ message: 'Invalid match' });

    // Canceller gets nothing — no wallet update
    const cancellerPlayer = match.players.find((p) => p.userId.toString() === userId);
    if (cancellerRefund > 0) canceller.smartRefund(cancellerRefund, cancellerPlayer?.paidFromDeposit, cancellerPlayer?.paidFromEarnings);
    await canceller.save();

    const otherUser = await User.findById(otherPlayer.userId);
    if (otherUser) {
      const balBeforeOther = otherUser.walletBalance;
      otherUser.smartRefund(otherRefund, otherPlayer.paidFromDeposit, otherPlayer.paidFromEarnings);
      await otherUser.save();
      await recordWalletTx(
        otherUser._id, 'credit', 'ludo_refund', otherRefund,
        `Ludo match — opponent forfeited, ₹${otherRefund} refunded`,
        balBeforeOther, otherUser.walletBalance, match._id
      );
    }

    match.status = 'cancelled';
    match.cancelledAt = new Date();
    match.cancelReason = 'User forfeit (I lost)';
    match.winnerId = otherPlayer.userId;
    await match.save();

    const io = req.app.get('io');
    io.emit('ludo:match-live');
    io.emit('ludo:waiting-updated');

    res.json({
      message: 'You cancelled. No refund. Other player received their entry back.',
      newBalance: canceller.walletBalance,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get Ludo settings (e.g. game duration for display)
// @route   GET /api/ludo/settings
const getLudoSettings = async (req, res) => {
  try {
    const settings = await AdminSettings.findOne({ key: 'main' }).select('ludoDummyRunningBattles ludoCommTier1Max ludoCommTier1Pct ludoCommTier2Max ludoCommTier2Pct ludoCommTier3Pct ludoEnabled ludoDisableReason ludoWarning').lean();
    res.json({
      ludoDummyRunningBattles: settings?.ludoDummyRunningBattles ?? 15,
      ludoCommTier1Max: settings?.ludoCommTier1Max ?? 250,
      ludoCommTier1Pct: settings?.ludoCommTier1Pct ?? 10,
      ludoCommTier2Max: settings?.ludoCommTier2Max ?? 600,
      ludoCommTier2Pct: settings?.ludoCommTier2Pct ?? 8,
      ludoCommTier3Pct: settings?.ludoCommTier3Pct ?? 5,
      ludoEnabled: settings?.ludoEnabled ?? true,
      ludoDisableReason: settings?.ludoDisableReason || '',
      ludoWarning: settings?.ludoWarning || '',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get list of waiting matches (others' matches only; for "Join" - click to Confirm and Start)
// @route   GET /api/ludo/waiting-list
const getWaitingList = async (req, res) => {
  try {
    const list = await LudoMatch.find({
      status: 'waiting',
      joinExpiryAt: { $gt: new Date() },
      creatorId: { $ne: req.user._id },
    })
      .select('_id entryAmount creatorName createdAt joinExpiryAt')
      .sort({ createdAt: -1 })
      .limit(50)
      .lean();

    res.json(list);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get all running (live) battles for display - same single entry/prize per match; users only see list
// @route   GET /api/ludo/running-battles
const getRunningBattles = async (req, res) => {
  try {
    // Exclude matches that have result requests (game is over, pending admin review)
    const matchIdsWithResult = await LudoResultRequest.find({}).distinct('matchId');
    const liveQuery = { status: 'live' };
    if (matchIdsWithResult.length > 0) {
      liveQuery._id = { $nin: matchIdsWithResult };
    }

    const [list, tiers] = await Promise.all([
      LudoMatch.find(liveQuery)
        .select('_id entryAmount players gameExpiryAt')
        .sort({ gameStartedAt: -1 })
        .limit(50)
        .lean(),
      getCommissionTiers(),
    ]);

    const battles = await Promise.all(list.map(async (m) => {
      const pool = (m.players || []).reduce((s, p) => s + (p.amountPaid || 0), 0) || m.entryAmount * 2;
      const { winnerAmount: prize } = await calcLudoCommission(pool, m.entryAmount, tiers);
      return {
        _id: m._id,
        entryAmount: m.entryAmount,
        playingFor: m.entryAmount,
        prize,
        players: (m.players || []).map((p) => ({ userName: p.userName })),
        gameExpiryAt: m.gameExpiryAt,
      };
    }));

    res.json(battles);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Check & expire match if room code timer is up (called by frontend when countdown hits 0)
// @route   POST /api/ludo/check-expiry
const checkExpiry = async (req, res) => {
  try {
    const { matchId } = req.body;
    const match = await LudoMatch.findById(matchId);
    if (!match) return res.status(404).json({ message: 'Match not found' });

    // Only act on live matches with no room code and expired timer
    if (match.status !== 'live') return res.json({ expired: false, status: match.status });
    if (match.roomCode && match.roomCode.trim() !== '') return res.json({ expired: false, status: 'live' });
    if (!match.roomCodeExpiryAt || new Date() < new Date(match.roomCodeExpiryAt)) {
      return res.json({ expired: false, status: 'live' });
    }

    // Timer is up — expire and refund both players
    const io = req.app.get('io');
    for (const player of match.players) {
      const u = await User.findById(player.userId);
      if (u) {
        const balBef = u.walletBalance;
        u.smartRefund(player.amountPaid, player.paidFromDeposit, player.paidFromEarnings);
        await u.save();
        await recordWalletTx(
          u._id, 'credit', 'ludo_refund', player.amountPaid,
          `Room code not shared in time — ₹${player.amountPaid} refunded`,
          balBef, u.walletBalance, match._id
        );
      }

      await Notification.create({
        userId: player.userId,
        type: 'game',
        title: 'Ludo Match Expired',
        message: `Room code नहीं डाला गया। ₹${player.amountPaid} आपके wallet में वापस कर दिया गया।`,
      });

      if (io) {
        io.to(`user_${player.userId}`).emit('ludo:match-cancelled', { matchId: match._id.toString() });
        io.to(`user_${player.userId}`).emit('wallet:balance-updated');
      }
    }

    match.status = 'cancelled';
    match.cancelledAt = new Date();
    match.cancelReason = 'Room code not shared in time';
    await match.save();

    console.log(`[Ludo] Room code expired for match ${match._id} (triggered by client), refunded both`);

    if (io) io.emit('ludo:waiting-updated');

    res.json({ expired: true, status: 'cancelled' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  createMatch,
  submitRoomCode,
  joinMatch,
  cancelMatch,
  requestCancel,
  acceptCancel,
  submitWinDispute,
  checkMatchWaiting,
  checkExpiry,
  getMyMatches,
  getMatchDetail,
  submitResult,
  submitLoss,
  cancelAsLoss,
  getLudoSettings,
  getWaitingList,
  getRunningBattles,
};
