const sharp = require('sharp');
const User = require('../models/User');
const WalletRequest = require('../models/WalletRequest');
const WalletTransaction = require('../models/WalletTransaction');
const Bet = require('../models/Bet');
const Notification = require('../models/Notification');
const GlobalStats = require('../models/GlobalStats');
const SpinnerRecord = require('../models/SpinnerRecord');
const AdminSettings = require('../models/AdminSettings');
const BonusRecord = require('../models/BonusRecord');
const LudoMatch = require('../models/LudoMatch');
const LudoResultRequest = require('../models/LudoResultRequest');
const { uploadFromBuffer } = require('../config/cloudinary');
const { recordWalletTx } = require('../utils/recordWalletTx');

// ──────────────────────── HELPERS ────────────────────────
async function getOrCreateSettings() {
  let s = await AdminSettings.findOne({ key: 'main' });
  if (!s) s = await AdminSettings.create({ key: 'main' });
  return s;
}

// ──────────────────────── DASHBOARD ────────────────────────

const getDashboardStats = async (req, res) => {
  try {
    const { period, from: fromStr, to: toStr } = req.query;

    // Build date filter for period-based stats
    let dateFilter = {};
    if (fromStr && toStr) {
      // Custom date range
      const fromDate = new Date(fromStr);
      const toDate = new Date(toStr);
      toDate.setHours(23, 59, 59, 999);
      dateFilter = { createdAt: { $gte: fromDate, $lte: toDate } };
    } else if (period && period !== 'all') {
      const now = new Date();
      let from;
      if (period === 'today') {
        from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      } else if (period === '7days') {
        from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      } else if (period === '30days') {
        from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      }
      if (from) dateFilter = { createdAt: { $gte: from } };
    }

    const hasPeriodFilter = !!dateFilter.createdAt;

    // These always show current counts (no date filter for pending)
    const [totalUsers, pendingDeposits, pendingWithdrawals] = await Promise.all([
      User.countDocuments(hasPeriodFilter ? dateFilter : {}),
      WalletRequest.countDocuments({ type: 'deposit', status: 'pending' }),
      WalletRequest.countDocuments({ type: 'withdrawal', status: 'pending' }),
    ]);

    // Bet stats use date filter
    const betFilter = hasPeriodFilter ? dateFilter : {};

    // Aviator bets: field is 'amount' (bet) and 'profit' (net win for won bets)
    const [totalBets, totalWins, betAgg] = await Promise.all([
      Bet.countDocuments(betFilter),
      Bet.countDocuments({ status: 'won', ...betFilter }),
      Bet.aggregate([
        { $match: betFilter },
        { $group: { _id: null, totalBetAmount: { $sum: '$amount' }, totalWinAmount: { $sum: '$profit' } } },
      ]),
    ]);

    // Spinner: spinCost = bet, winAmount = win
    const spinnerAgg = await SpinnerRecord.aggregate([
      { $match: betFilter },
      { $group: { _id: null, totalSpinCost: { $sum: '$spinCost' }, totalSpinWin: { $sum: '$winAmount' } } },
    ]);

    // Ludo: completed matches — pool = sum of players' amountPaid (bet), winnerAmount = pool - commission (calculated on-the-fly)
    const ludoAgg = await LudoMatch.aggregate([
      { $match: { status: 'completed', ...betFilter } },
      { $unwind: '$players' },
      { $group: { _id: null, totalLudoBet: { $sum: '$players.amountPaid' } } },
    ]);

    // Ludo win = total amount credited to winners (we track via WalletTransaction for accuracy)
    const ludoWinAgg = await WalletTransaction.aggregate([
      { $match: { category: 'ludo_win', ...betFilter } },
      { $group: { _id: null, totalLudoWin: { $sum: '$amount' } } },
    ]);

    const aviatorBet = betAgg[0]?.totalBetAmount || 0;
    const aviatorWin = betAgg[0]?.totalWinAmount || 0;
    const spinBet = spinnerAgg[0]?.totalSpinCost || 0;
    const spinWin = spinnerAgg[0]?.totalSpinWin || 0;
    const ludoBet = ludoAgg[0]?.totalLudoBet || 0;
    const ludoWin = ludoWinAgg[0]?.totalLudoWin || 0;

    // Combined totals across all game types
    let totalBetAmount = aviatorBet + spinBet + ludoBet;
    let totalWinAmount = aviatorWin + spinWin + ludoWin;

    // If no period filter, also include global stats as fallback for aviator
    if (!hasPeriodFilter) {
      const globalStats = await GlobalStats.findOne({ key: 'main' });
      if (globalStats) {
        // GlobalStats tracks aviator only — replace aviator portion if global is larger
        const globalBet = globalStats.totalBetAmount || 0;
        const globalWin = globalStats.totalWinAmount || 0;
        if (globalBet > aviatorBet) {
          totalBetAmount = globalBet + spinBet + ludoBet;
        }
        if (globalWin > aviatorWin) {
          totalWinAmount = globalWin + spinWin + ludoWin;
        }
      }
    }

    res.json({
      totalUsers,
      pendingDeposits,
      pendingWithdrawals,
      totalBets,
      totalWins,
      totalBetAmount,
      totalWinAmount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── USERS ────────────────────────

const getUsers = async (req, res) => {
  try {
    const { period, search, from: fromStr, to: toStr } = req.query;
    let filter = {};
    if (fromStr && toStr) {
      const fromDate = new Date(fromStr);
      const toDate = new Date(toStr);
      toDate.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: fromDate, $lte: toDate };
    } else if (period && period !== 'all') {
      const now = new Date();
      let from;
      if (period === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === '7days') from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      else if (period === '30days') from = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
      if (from) filter.createdAt = { $gte: from };
    }
    if (search && search.trim()) {
      const escaped = search.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      const regex = new RegExp(escaped, 'i');
      filter.$or = [
        { name: regex },
        { email: regex },
        { phone: regex },
      ];
    }
    const users = await User.find(filter).select('-otp -otpExpiry').sort({ createdAt: -1 });
    res.json(users);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const createUser = async (req, res) => {
  try {
    const { email, name, walletBalance, phone, role } = req.body;
    if (!name) return res.status(400).json({ message: 'Name is required' });

    if (!email && !phone) return res.status(400).json({ message: 'Email or phone is required' });

    if (email) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(email)) return res.status(400).json({ message: 'Invalid email format' });
      const existing = await User.findOne({ email: email.toLowerCase() });
      if (existing) return res.status(400).json({ message: 'User with this email already exists' });
    }
    if (phone) {
      const existing = await User.findOne({ phone: phone.trim() });
      if (existing) return res.status(400).json({ message: 'User with this phone already exists' });
    }

    const validRoles = ['user', 'admin', 'manager'];
    const userRole = validRoles.includes(role) ? role : 'user';

    const user = await User.create({
      email: email ? email.toLowerCase() : null,
      name,
      phone: phone || null,
      walletBalance: walletBalance || 0,
      role: userRole,
    });

    res.status(201).json({ _id: user._id, name: user.name, email: user.email, phone: user.phone, walletBalance: user.walletBalance, role: user.role });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const updateUser = async (req, res) => {
  try {
    const { id } = req.params;
    const { name, role } = req.body;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    if (name !== undefined) user.name = String(name).trim() || user.name;
    if (role !== undefined) {
      const validRoles = ['user', 'admin', 'manager'];
      if (!validRoles.includes(role)) return res.status(400).json({ message: 'Invalid role' });
      user.role = role;
    }

    await user.save();
    res.json({ _id: user._id, name: user.name, role: user.role, isAdmin: user.isAdmin });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const updateUserBalance = async (req, res) => {
  try {
    const { id } = req.params;
    const { amount, operation } = req.body;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const balBefore = user.walletBalance;
    let newBalance;
    if (operation === 'add') newBalance = user.walletBalance + Number(amount);
    else if (operation === 'subtract') newBalance = Math.max(0, user.walletBalance - Number(amount));
    else newBalance = Number(amount);

    // Use findByIdAndUpdate to avoid full-document validation
    // Admin credit counts as deposit (non-withdrawable) for earnings tracking
    const updateOps = { walletBalance: newBalance };
    if (operation === 'add') {
      updateOps.$inc = { totalDeposited: Number(amount) };
    }
    const updated = updateOps.$inc
      ? await User.findByIdAndUpdate(id, { walletBalance: newBalance, $inc: { totalDeposited: Number(amount) } }, { new: true, runValidators: false })
      : await User.findByIdAndUpdate(id, { walletBalance: newBalance }, { new: true, runValidators: false });

    const txType = newBalance >= balBefore ? 'credit' : 'debit';
    const txAmt = Math.abs(newBalance - balBefore);
    await recordWalletTx(
      id, txType, txType === 'credit' ? 'admin_credit' : 'admin_debit', txAmt,
      `Admin ${operation === 'add' ? 'added' : operation === 'subtract' ? 'subtracted' : 'set'} ₹${amount}`,
      balBefore, newBalance
    );

    const io = req.app.get('io');
    if (io) io.to(`user_${id}`).emit('wallet:balance-updated', { walletBalance: newBalance });

    res.json({ message: 'Balance updated successfully', user: { _id: updated._id, name: updated.name, walletBalance: updated.walletBalance } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update user's withdrawable earnings (adjusts totalDeposited)
// @route   PUT /api/admin/users/:id/earnings
const updateUserEarnings = async (req, res) => {
  try {
    const { id } = req.params;
    const { earnings } = req.body;

    if (earnings == null || isNaN(Number(earnings)) || Number(earnings) < 0) {
      return res.status(400).json({ message: 'Earnings must be a non-negative number' });
    }

    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const desiredEarnings = Number(earnings);
    if (desiredEarnings > user.walletBalance) {
      return res.status(400).json({ message: `Earnings cannot exceed wallet balance (₹${user.walletBalance.toFixed(2)})` });
    }

    const newTotalDeposited = Math.max(0, user.walletBalance - desiredEarnings);
    const oldEarnings = Math.max(0, user.walletBalance - (user.totalDeposited || 0));

    await User.findByIdAndUpdate(id, { totalDeposited: newTotalDeposited }, { runValidators: false });

    console.log(`📝 EARNINGS EDIT — User: ${user.name} (${id}), Earnings: ₹${oldEarnings.toFixed(2)} → ₹${desiredEarnings.toFixed(2)}, totalDeposited: ${user.totalDeposited || 0} → ${newTotalDeposited}`);

    res.json({
      message: 'Earnings updated successfully',
      user: {
        _id: user._id,
        name: user.name,
        walletBalance: user.walletBalance,
        totalDeposited: newTotalDeposited,
        earnings: desiredEarnings,
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update user status (active / inactive / blocked)
// @route   PUT /api/admin/users/:id/status
const updateUserStatus = async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;
    if (!['active', 'inactive', 'blocked'].includes(status)) {
      return res.status(400).json({ message: 'Invalid status. Must be active, inactive, or blocked.' });
    }
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isAdmin) return res.status(400).json({ message: 'Cannot change admin status' });

    // Use findByIdAndUpdate to avoid full-document validation
    // (some old users may have missing fields like email)
    const updated = await User.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: false }
    );

    res.json({ message: `User ${status} successfully`, user: { _id: updated._id, name: updated.name, status: updated.status } });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Delete user and all associated data
// @route   DELETE /api/admin/users/:id
const deleteUser = async (req, res) => {
  try {
    const { id } = req.params;
    const user = await User.findById(id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.isAdmin) return res.status(400).json({ message: 'Cannot delete an admin account' });

    // Find all ludo matches this user was part of
    const ludoMatches = await LudoMatch.find({
      $or: [{ creatorId: id }, { 'players.userId': id }],
    }).select('_id');
    const ludoMatchIds = ludoMatches.map((m) => m._id);

    // Delete everything in parallel
    await Promise.all([
      WalletRequest.deleteMany({ userId: id }),
      WalletTransaction.deleteMany({ userId: id }),
      Bet.deleteMany({ userId: id }),
      Notification.deleteMany({ userId: id }),
      SpinnerRecord.deleteMany({ userId: id }),
      BonusRecord.deleteMany({ userId: id }),
      LudoMatch.deleteMany({ _id: { $in: ludoMatchIds } }),
      LudoResultRequest.deleteMany({ matchId: { $in: ludoMatchIds } }),
      User.findByIdAndDelete(id),
    ]);

    console.log(`🗑️ Deleted user ${user.name} (${id}) and all associated data`);
    res.json({ message: `User "${user.name}" and all associated data deleted successfully` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── WALLET REQUESTS ────────────────────────

const getWalletRequests = async (req, res) => {
  try {
    const { status, type, page = 1, limit = 25 } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [requests, totalCount] = await Promise.all([
      WalletRequest.find(filter)
        .populate('userId', 'name email phone walletBalance upiId upiNumber')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      WalletRequest.countDocuments(filter),
    ]);

    res.json({ data: requests, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const processWalletRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, editedAmount } = req.body;

    const walletRequest = await WalletRequest.findById(id);
    if (!walletRequest) return res.status(404).json({ message: 'Request not found' });
    if (walletRequest.status !== 'pending') return res.status(400).json({ message: 'Request already processed' });

    // Allow admin to edit the deposit amount before processing
    if (editedAmount !== undefined && editedAmount !== null && walletRequest.type === 'deposit') {
      const newAmt = Number(editedAmount);
      if (isNaN(newAmt) || newAmt < 1) return res.status(400).json({ message: 'Edited amount must be at least ₹1' });
      walletRequest.amount = newAmt;
    }

    const user = await User.findById(walletRequest.userId);

    const balBefore = user.walletBalance;
    let newBalance = user.walletBalance;

    if (action === 'approve') {
      if (walletRequest.type === 'deposit') {
        newBalance = user.walletBalance + walletRequest.amount;
      }
      walletRequest.status = 'approved';
    } else if (action === 'reject') {
      if (walletRequest.type === 'withdrawal') {
        newBalance = user.walletBalance + walletRequest.amount;
      }
      walletRequest.status = 'rejected';
    } else {
      return res.status(400).json({ message: 'Invalid action' });
    }

    // Use findByIdAndUpdate to avoid full-document validation failures on users with null email/phone
    const updateFields = { walletBalance: newBalance };
    // Track deposit amount for earnings calculation (withdrawal limited to earnings only)
    if (action === 'approve' && walletRequest.type === 'deposit') {
      updateFields.$inc = { totalDeposited: walletRequest.amount };
    }
    if (updateFields.$inc) {
      await User.findByIdAndUpdate(user._id, { walletBalance: newBalance, $inc: { totalDeposited: walletRequest.amount } }, { runValidators: false });
    } else {
      await User.findByIdAndUpdate(user._id, { walletBalance: newBalance }, { runValidators: false });
    }

    // Record transaction if balance changed
    if (newBalance !== balBefore) {
      if (action === 'approve' && walletRequest.type === 'deposit') {
        await recordWalletTx(
          user._id, 'credit', 'deposit', walletRequest.amount,
          `Deposit of ₹${walletRequest.amount} approved`,
          balBefore, newBalance, walletRequest._id
        );
      } else if (action === 'reject' && walletRequest.type === 'withdrawal') {
        await recordWalletTx(
          user._id, 'credit', 'withdrawal_refund', walletRequest.amount,
          `Withdrawal of ₹${walletRequest.amount} rejected — refunded`,
          balBefore, newBalance, walletRequest._id
        );
      }
    }

    walletRequest.processedBy = req.user._id;
    walletRequest.processedAt = new Date();
    await walletRequest.save();

    // Notify user
    const notification = await Notification.create({
      userId: walletRequest.userId,
      title: walletRequest.type === 'deposit' ? 'Deposit Request' : 'Withdrawal Request',
      message: `Your ${walletRequest.type} request of Rs. ${walletRequest.amount} has been ${walletRequest.status}`,
      type: 'wallet',
    });

    const io = req.app.get('io');
    io.to(`user_${walletRequest.userId}`).emit('notification:new', notification);
    io.to(`user_${walletRequest.userId}`).emit('wallet:balance-updated', { walletBalance: newBalance });

    res.json({ message: `Request ${action}d successfully`, request: walletRequest, userNewBalance: newBalance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── BETS ────────────────────────

const getAllBets = async (req, res) => {
  try {
    const { status, page = 1, limit = 25, period, from: fromStr, to: toStr, search } = req.query;
    const filter = {};
    if (status) {
      filter.status = status;
    } else {
      // Default: only show settled bets (won/lost) in history, not active ones
      filter.status = { $in: ['won', 'lost'] };
    }

    // Search by user name or phone
    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      const matchingUsers = await User.find({
        $or: [{ name: regex }, { phone: regex }],
      }).select('_id');
      filter.userId = { $in: matchingUsers.map((u) => u._id) };
    }

    // Date filtering
    if (fromStr && toStr) {
      const fromDate = new Date(fromStr);
      const toDate = new Date(toStr);
      toDate.setHours(23, 59, 59, 999);
      filter.createdAt = { $gte: fromDate, $lte: toDate };
    } else if (period && period !== 'all') {
      const now = new Date();
      let from;
      if (period === 'today') from = new Date(now.getFullYear(), now.getMonth(), now.getDate());
      else if (period === '7days') from = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      if (from) filter.createdAt = { $gte: from };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [bets, totalCount] = await Promise.all([
      Bet.find(filter)
        .populate('userId', 'name email phone')
        .populate('gameRoundId', 'roundId crashMultiplier')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Bet.countDocuments(filter),
    ]);

    res.json({ data: bets, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const deleteBets = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!ids || !Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'Provide an array of bet IDs' });
    }
    const result = await Bet.deleteMany({ _id: { $in: ids } });
    res.json({ message: `Deleted ${result.deletedCount} bets`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getWinningBets = async (req, res) => {
  try {
    const { page = 1, limit = 20, startDate, endDate, userId, minAmount, maxAmount } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { status: 'won' };

    // Date range filter
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) {
        const s = new Date(startDate);
        if (!isNaN(s.getTime())) { s.setUTCHours(0, 0, 0, 0); filter.createdAt.$gte = s; }
      }
      if (endDate) {
        const e = new Date(endDate);
        if (!isNaN(e.getTime())) { e.setUTCHours(23, 59, 59, 999); filter.createdAt.$lte = e; }
      }
      if (Object.keys(filter.createdAt).length === 0) delete filter.createdAt;
    }

    // User filter
    if (userId) filter.userId = userId;

    // Amount range filter
    if (minAmount || maxAmount) {
      filter.amount = {};
      if (minAmount) filter.amount.$gte = Number(minAmount);
      if (maxAmount) filter.amount.$lte = Number(maxAmount);
      if (Object.keys(filter.amount).length === 0) delete filter.amount;
    }

    const [bets, totalCount, aggregation] = await Promise.all([
      Bet.find(filter)
        .populate('userId', 'name email phone')
        .populate('gameRoundId', 'roundId crashMultiplier')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      Bet.countDocuments(filter),
      Bet.aggregate([
        { $match: filter },
        { $group: { _id: null, totalProfit: { $sum: '$profit' }, totalAmount: { $sum: '$amount' } } },
      ]),
    ]);

    const stats = aggregation[0] || { totalProfit: 0, totalAmount: 0 };

    res.json({
      data: bets,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
      totalWinnings: stats.totalProfit,
      totalBetAmount: stats.totalAmount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getAdminNotifications = async (req, res) => {
  try {
    const [walletRequests, ludoRequests] = await Promise.all([
      WalletRequest.find({ status: 'pending' })
        .populate('userId', 'name phone')
        .sort({ createdAt: -1 })
        .limit(50),
      LudoResultRequest.find({ status: 'pending' })
        .sort({ createdAt: -1 })
        .limit(50),
    ]);

    // Transform ludo requests into notification-compatible format
    const ludoNotifs = ludoRequests.map((r) => ({
      _id: r._id,
      type: 'ludo_result',
      matchId: r.matchId,
      claims: r.claims,
      userName: r.claims?.[0]?.userName || 'Player',
      createdAt: r.createdAt,
    }));

    // Merge and sort by createdAt descending
    const all = [...walletRequests.map((r) => r.toObject()), ...ludoNotifs]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json(all);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getLiveBets = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    const state = gameEngine.getCurrentState();
    if (!state.round) return res.json([]);

    const bets = await Bet.find({ gameRoundId: state.round._id, status: 'active' }).populate('userId', 'name phone');
    res.json(bets);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getCurrentRoundWithBets = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    const state = gameEngine.getCurrentState();
    if (!state.round) return res.json({ round: null, state, bets: [] });

    const bets = await Bet.find({ gameRoundId: state.round._id })
      .populate('userId', 'name phone walletBalance')
      .sort({ createdAt: 1 });

    res.json({
      round: state.round,
      state: { status: state.status, multiplier: state.multiplier, isRunning: state.isRunning, adminNextCrash: state.adminNextCrash, bulkCrash: state.bulkCrash, sequentialCrashes: state.sequentialCrashes },
      bets,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const forceCrashRound = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    await gameEngine.forceCrashRound();
    res.json({ message: 'Round crashed successfully' });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

const forceCrashBet = async (req, res) => {
  try {
    const { id } = req.params;
    const gameEngine = req.app.get('gameEngine');
    const bet = await gameEngine.forceCrashBet(id);
    res.json({ message: 'Bet force crashed successfully', bet });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Set crash multiplier for the NEXT round
// @route   POST /api/admin/game/set-next-crash
const setNextCrash = async (req, res) => {
  try {
    const { crashAt } = req.body;
    if (typeof crashAt !== 'number' || crashAt < 1) {
      return res.status(400).json({ message: 'crashAt must be a number >= 1' });
    }
    const gameEngine = req.app.get('gameEngine');
    gameEngine.setNextCrash(crashAt);
    res.json({ message: `Next round will crash at ${crashAt}x`, adminNextCrash: crashAt });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Clear the admin-set next crash override
// @route   POST /api/admin/game/clear-next-crash
const clearNextCrash = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    gameEngine.clearNextCrash();
    res.json({ message: 'Next round crash override cleared' });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Set bulk crash: 3 modes - exact, range, auto
// @route   POST /api/admin/game/set-bulk-crash
const setBulkCrash = async (req, res) => {
  try {
    const { count, mode = 'exact', crashAt, min, max } = req.body;
    if (typeof count !== 'number' || count < 1 || count > 100) {
      return res.status(400).json({ message: 'count must be between 1 and 100' });
    }
    if (mode === 'exact') {
      if (typeof crashAt !== 'number' || crashAt < 1) {
        return res.status(400).json({ message: 'crashAt must be a number >= 1' });
      }
    } else if (mode === 'range') {
      if (typeof min !== 'number' || min < 1) {
        return res.status(400).json({ message: 'min must be a number >= 1' });
      }
      if (typeof max !== 'number' || max < min) {
        return res.status(400).json({ message: 'max must be >= min' });
      }
    }
    const gameEngine = req.app.get('gameEngine');
    gameEngine.setBulkCrash(count, { mode, crashAt, min, max });
    const label = mode === 'exact' ? `at ${crashAt}x` : mode === 'range' ? `random ${min}x–${max}x` : 'auto random';
    res.json({ message: `Next ${count} rounds: ${label}`, bulkCrash: gameEngine.adminBulkCrash });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Clear bulk crash
// @route   POST /api/admin/game/clear-bulk-crash
const clearBulkCrash = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    gameEngine.clearBulkCrash();
    res.json({ message: 'Bulk crash cleared' });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Set sequential crashes: specific values for each round
// @route   POST /api/admin/game/set-sequential-crashes
const setSequentialCrashes = async (req, res) => {
  try {
    const { values } = req.body;
    if (!Array.isArray(values) || values.length === 0) {
      return res.status(400).json({ message: 'Provide an array of crash values' });
    }
    for (const v of values) {
      if (typeof v !== 'number' || v < 1) {
        return res.status(400).json({ message: 'All values must be numbers >= 1' });
      }
    }
    const gameEngine = req.app.get('gameEngine');
    gameEngine.setSequentialCrashes(values);
    res.json({ message: `Set ${values.length} sequential crash values`, sequentialCrashes: values });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Clear sequential crashes
// @route   POST /api/admin/game/clear-sequential-crashes
const clearSequentialCrashes = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    gameEngine.clearSequentialCrashes();
    res.json({ message: 'Sequential crashes cleared' });
  } catch (error) {
    console.error(error);
    res.status(400).json({ message: error.message });
  }
};

// @desc    Get current crash queue state
// @route   GET /api/admin/game/crash-queue
const getCrashQueue = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    res.json(gameEngine.getCrashQueueState());
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── SPINNER ────────────────────────

const getSpinnerRecords = async (req, res) => {
  try {
    const { startDate, endDate, date, username, page = 1, limit = 25, all } = req.query;
    const filter = {};

    if (!all && (startDate || endDate || date)) {
      const sDate = startDate || date;
      const eDate = endDate || date;
      if (sDate) {
        const start = new Date(sDate);
        if (isNaN(start.getTime())) return res.status(400).json({ message: 'Invalid start date' });
        start.setUTCHours(0, 0, 0, 0);
        filter.createdAt = { $gte: start };
      }
      if (eDate) {
        const end = new Date(eDate);
        if (isNaN(end.getTime())) return res.status(400).json({ message: 'Invalid end date' });
        end.setUTCHours(23, 59, 59, 999);
        filter.createdAt = { ...filter.createdAt, $lte: end };
      }
    }

    if (username && String(username).trim()) {
      const users = await User.find({ name: { $regex: String(username).trim(), $options: 'i' } }).select('_id');
      const userIds = users.map((u) => u._id);
      if (userIds.length === 0) return res.json({ records: [], profit: 0, totalSpins: 0, totalCost: 0, totalPayout: 0, totalCount: 0, page: 1, totalPages: 0 });
      filter.userId = { $in: userIds };
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const allRecords = await SpinnerRecord.find(filter).select('spinCost winAmount').lean();
    let totalCost = 0;
    let totalPayout = 0;
    allRecords.forEach((r) => { totalCost += r.spinCost || 50; totalPayout += r.winAmount || 0; });
    const profit = totalCost - totalPayout;
    const totalCount = allRecords.length;

    const records = await SpinnerRecord.find(filter)
      .populate('userId', 'name email phone')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limitNum)
      .lean();

    res.json({ records, profit, totalSpins: totalCount, totalCost, totalPayout, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── SETTINGS ────────────────────────

const getSettings = async (req, res) => {
  try {
    const gameEngine = req.app.get('gameEngine');
    const settings = await getOrCreateSettings();
    // Always read betsEnabled from DB (authoritative) — not game engine memory
    // which may be stale after a server restart before DB load completes
    const dbBetsEnabled = settings.betsEnabled ?? true;
    // Silently sync game engine memory if it doesn't match DB (no socket emit)
    if (gameEngine.getBetsEnabled() !== dbBetsEnabled) {
      gameEngine.betsEnabled = dbBetsEnabled;
      console.log(`⚙️  Synced game engine betsEnabled to DB value: ${dbBetsEnabled}`);
    }
    res.json({
      betsEnabled: dbBetsEnabled,
      qrCodeUrl: settings.qrCodeUrl,
      upiId: settings.upiId,
      upiNumber: settings.upiNumber,
      supportPhone: settings.supportPhone,
      supportWhatsApp: settings.supportWhatsApp,
      bonusMinBet: settings.bonusMinBet,
      bonusCashback: settings.bonusCashback,
      termsDeposit: settings.termsDeposit,
      termsWithdrawal: settings.termsWithdrawal,
      termsGeneral: settings.termsGeneral,
      dummyUserCount: settings.dummyUserCount || 10,
      layout: settings.layout || false,
      userWarning: settings.userWarning || '',
      ludoGameDurationMinutes: settings.ludoGameDurationMinutes ?? 30,
      ludoDummyRunningBattles: settings.ludoDummyRunningBattles ?? 15,
      ludoEnabled: settings.ludoEnabled ?? true,
      ludoDisableReason: settings.ludoDisableReason || '',
      ludoWarning: settings.ludoWarning || '',
      ludoCommTier1Max: settings.ludoCommTier1Max ?? 250,
      ludoCommTier1Pct: settings.ludoCommTier1Pct ?? 10,
      ludoCommTier2Max: settings.ludoCommTier2Max ?? 600,
      ludoCommTier2Pct: settings.ludoCommTier2Pct ?? 8,
      ludoCommTier3Pct: settings.ludoCommTier3Pct ?? 5,
      withdrawalsEnabled: settings.withdrawalsEnabled ?? true,
      withdrawalDisableReason: settings.withdrawalDisableReason || '',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const updateSettings = async (req, res) => {
  try {
    const {
      betsEnabled,
      upiId, upiNumber,
      supportPhone, supportWhatsApp,
      bonusMinBet,       bonusCashback,
      termsDeposit, termsWithdrawal, termsGeneral,
      dummyUserCount,
      layout,
      ludoGameDurationMinutes,
      ludoDummyRunningBattles,
      userWarning,
      ludoCommTier1Max, ludoCommTier1Pct,
      ludoCommTier2Max, ludoCommTier2Pct,
      ludoCommTier3Pct,
      withdrawalsEnabled,
      withdrawalDisableReason,
      ludoEnabled,
      ludoDisableReason,
      ludoWarning,
    } = req.body;

    // Handle betsEnabled toggle (game engine + persist to DB)
    if (typeof betsEnabled === 'boolean') {
      const gameEngine = req.app.get('gameEngine');
      gameEngine.setBetsEnabled(betsEnabled);
    }

    // Persist all settings to AdminSettings
    const settings = await getOrCreateSettings();
    if (upiId !== undefined) settings.upiId = upiId;
    if (upiNumber !== undefined) settings.upiNumber = upiNumber;
    if (supportPhone !== undefined) settings.supportPhone = supportPhone;
    if (supportWhatsApp !== undefined) settings.supportWhatsApp = supportWhatsApp;
    if (bonusMinBet !== undefined) settings.bonusMinBet = Number(bonusMinBet);
    if (bonusCashback !== undefined) settings.bonusCashback = Number(bonusCashback);
    if (termsDeposit !== undefined) settings.termsDeposit = termsDeposit;
    if (termsWithdrawal !== undefined) settings.termsWithdrawal = termsWithdrawal;
    if (termsGeneral !== undefined) settings.termsGeneral = termsGeneral;
    if (dummyUserCount !== undefined) settings.dummyUserCount = Number(dummyUserCount);
    if (layout !== undefined) settings.layout = Boolean(layout);
    if (ludoGameDurationMinutes !== undefined) {
      const n = Number(ludoGameDurationMinutes);
      if (n >= 5 && n <= 120) settings.ludoGameDurationMinutes = n;
    }
    if (ludoDummyRunningBattles !== undefined) {
      const n = Number(ludoDummyRunningBattles);
      if (n >= 0 && n <= 50) settings.ludoDummyRunningBattles = n;
    }
    if (userWarning !== undefined) settings.userWarning = userWarning;
    if (ludoCommTier1Max !== undefined) settings.ludoCommTier1Max = Number(ludoCommTier1Max);
    if (ludoCommTier1Pct !== undefined) settings.ludoCommTier1Pct = Number(ludoCommTier1Pct);
    if (ludoCommTier2Max !== undefined) settings.ludoCommTier2Max = Number(ludoCommTier2Max);
    if (ludoCommTier2Pct !== undefined) settings.ludoCommTier2Pct = Number(ludoCommTier2Pct);
    if (ludoCommTier3Pct !== undefined) settings.ludoCommTier3Pct = Number(ludoCommTier3Pct);
    if (typeof betsEnabled === 'boolean') settings.betsEnabled = betsEnabled;
    if (typeof withdrawalsEnabled === 'boolean') settings.withdrawalsEnabled = withdrawalsEnabled;
    if (withdrawalDisableReason !== undefined) settings.withdrawalDisableReason = withdrawalDisableReason;
    if (typeof ludoEnabled === 'boolean') settings.ludoEnabled = ludoEnabled;
    if (ludoDisableReason !== undefined) settings.ludoDisableReason = ludoDisableReason;
    if (ludoWarning !== undefined) settings.ludoWarning = ludoWarning;
    await settings.save();

    res.json({ message: 'Settings updated', betsEnabled: typeof betsEnabled === 'boolean' ? betsEnabled : undefined });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Upload QR code image
// @route   POST /api/admin/settings/qr
const uploadQrCode = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'QR code image is required' });
    }

    const compressedBuffer = await sharp(req.file.buffer)
      .resize({ width: 800, withoutEnlargement: true })
      .png({ quality: 80 })
      .toBuffer();

    const url = await uploadFromBuffer(compressedBuffer, 'lean_aviator/qr', 'image/png');

    const settings = await getOrCreateSettings();
    settings.qrCodeUrl = url;
    await settings.save();

    res.json({ message: 'QR code uploaded', qrCodeUrl: url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── BONUS ────────────────────────

// @desc    Get all bonus records (admin)
// @route   GET /api/admin/bonus-records
const getBonusRecords = async (req, res) => {
  try {
    const { page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const [records, totalCount] = await Promise.all([
      BonusRecord.find({})
        .populate('userId', 'name email phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      BonusRecord.countDocuments({}),
    ]);

    res.json({ data: records, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── PUBLIC (no auth) ────────────────────────

// @desc    Get support info (public)
// @route   GET /api/settings/support
const getPublicSupport = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({ 
      supportPhone: s.supportPhone, 
      supportWhatsApp: s.supportWhatsApp,
      dummyUserCount: s.dummyUserCount || 10 
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get terms (public)
// @route   GET /api/settings/terms
const getPublicTerms = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({ termsDeposit: s.termsDeposit, termsWithdrawal: s.termsWithdrawal, termsGeneral: s.termsGeneral });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get layout setting (public)
// @route   GET /api/settings/layout
const getPublicLayout = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({ layout: s.layout || false });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get user warning (public)
// @route   GET /api/settings/user-warning
const getPublicUserWarning = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({ userWarning: s.userWarning || '' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── USER DETAIL ────────────────────────

const getUserDetail = async (req, res) => {
  try {
    const { id } = req.params;
    const [user, walletRequests, aviatorBets, ludoMatches, spinnerRecords] = await Promise.all([
      User.findById(id).select('-otp -otpExpiry'),
      WalletRequest.find({ userId: id }).sort({ createdAt: -1 }).limit(100),
      Bet.find({ userId: id }).sort({ createdAt: -1 }).limit(100),
      LudoMatch.find({ $or: [{ creatorId: id }, { 'players.userId': id }] }).sort({ createdAt: -1 }).limit(100),
      SpinnerRecord.find({ userId: id }).sort({ createdAt: -1 }).limit(100),
    ]);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user, walletRequests, aviatorBets, ludoMatches, spinnerRecords });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get wallet transactions for a specific user (admin)
// @route   GET /api/admin/users/:id/transactions?page=1&limit=30
const getUserTransactions = async (req, res) => {
  try {
    const { id } = req.params;
    const { page = 1, limit = 30 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { userId: id };
    const [transactions, totalCount] = await Promise.all([
      WalletTransaction.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      WalletTransaction.countDocuments(filter),
    ]);

    res.json({
      data: transactions,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getDashboardStats,
  getUsers,
  createUser,
  updateUser,
  updateUserBalance,
  updateUserEarnings,
  updateUserStatus,
  deleteUser,
  getWalletRequests,
  processWalletRequest,
  getAllBets,
  deleteBets,
  getWinningBets,
  getAdminNotifications,
  forceCrashBet,
  getLiveBets,
  getCurrentRoundWithBets,
  forceCrashRound,
  setNextCrash,
  clearNextCrash,
  setBulkCrash,
  clearBulkCrash,
  setSequentialCrashes,
  clearSequentialCrashes,
  getCrashQueue,
  getSpinnerRecords,
  getSettings,
  updateSettings,
  uploadQrCode,
  getBonusRecords,
  getUserDetail,
  getUserTransactions,
  getPublicSupport,
  getPublicTerms,
  getPublicLayout,
  getPublicUserWarning,
};
