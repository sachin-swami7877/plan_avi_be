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
const KycRequest = require('../models/KycRequest');
const { uploadFromBuffer } = require('../config/cloudinary');
const { recordWalletTx } = require('../utils/recordWalletTx');
const { sendPushNotification } = require('../config/firebase');
const { getTodayISTStart, istStartOfDay, istEndOfDay } = require('../utils/istDate');

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
      // Custom date range — interpret as IST days
      dateFilter = { createdAt: { $gte: istStartOfDay(fromStr), $lte: istEndOfDay(toStr) } };
    } else if (period && period !== 'all') {
      let from;
      if (period === 'today') {
        from = getTodayISTStart();
      } else if (period === '7days') {
        from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      } else if (period === '30days') {
        from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
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

    // Aviator bets: sum actual payouts for WON bets (amount + profit = winAmount)
    const [totalBets, totalWins, betAgg] = await Promise.all([
      Bet.countDocuments(betFilter),
      Bet.countDocuments({ status: 'won', ...betFilter }),
      Bet.aggregate([
        { $match: betFilter },
        { $group: {
          _id: null,
          totalBetAmount: { $sum: '$amount' },
          totalWinAmount: { $sum: { $cond: [{ $eq: ['$status', 'won'] }, { $add: ['$amount', '$profit'] }, 0] } },
        }},
      ]),
    ]);

    // Spinner profit:
    // - Paid spins: spinCost is real revenue, winAmount is payout
    // - Free/referral spins: user paid nothing (spinCost is just a table-selector stored as 50),
    //   so count spinCost=0 for referral. Only deduct actual winAmount if user won something.
    const spinnerAgg = await SpinnerRecord.aggregate([
      { $match: betFilter },
      { $group: {
        _id: null,
        totalSpinCost: { $sum: { $cond: [{ $eq: ['$spinType', 'referral'] }, 0, '$spinCost'] } },
        totalSpinWin:  { $sum: '$winAmount' },
      }},
    ]);

    // Ludo: completed matches — pool = sum of players' amountPaid (bet)
    const ludoAgg = await LudoMatch.aggregate([
      { $match: { status: 'completed', ...betFilter } },
      { $unwind: '$players' },
      { $group: { _id: null, totalLudoBet: { $sum: '$players.amountPaid' } } },
    ]);

    // Ludo commission: Fetch all completed matches with their pools and entry amounts
    const ludoCommissions = await LudoMatch.aggregate([
      { $match: { status: 'completed', ...betFilter } },
      { $project: {
        pool: { $sum: '$players.amountPaid' },
        entryAmount: 1,
      }},
    ]);

    // Get commission tiers once (not per match)
    const settings = await AdminSettings.findOne({ key: 'main' }).select('ludoCommTier1Max ludoCommTier1Pct ludoCommTier2Max ludoCommTier2Pct ludoCommTier3Pct').lean();
    const tier1Max = settings?.ludoCommTier1Max ?? 250;
    const tier1Pct = settings?.ludoCommTier1Pct ?? 10;
    const tier2Max = settings?.ludoCommTier2Max ?? 600;
    const tier2Pct = settings?.ludoCommTier2Pct ?? 8;
    const tier3Pct = settings?.ludoCommTier3Pct ?? 5;

    // Calculate total win (pool - commission) without extra queries
    let totalLudoWin = 0;
    ludoCommissions.forEach(m => {
      const pool = m.pool;
      let commission;
      if (m.entryAmount <= tier1Max) commission = Math.round((pool * tier1Pct) / 100);
      else if (m.entryAmount <= tier2Max) commission = Math.round((pool * tier2Pct) / 100);
      else commission = Math.round((pool * tier3Pct) / 100);
      totalLudoWin += pool - commission;
    });
    const ludoWinAgg = [{ totalLudoWin }];

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
      // Per-game breakdown for filtered house profit
      games: {
        aviator: { bet: aviatorBet, win: aviatorWin },
        ludo: { bet: ludoBet, win: ludoWin },
        spinner: { bet: spinBet, win: spinWin },
      },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── USERS ────────────────────────

const getUsers = async (req, res) => {
  try {
    const { period, search, from: fromStr, to: toStr, status, page = 1, limit = 50, sortBy, balanceMin, balanceMax, userIds, hasFcmToken } = req.query;
    let filter = {};
    // Filter by specific user IDs (for online users tab)
    if (userIds) {
      const ids = userIds.split(',').filter(Boolean);
      if (ids.length > 0) {
        filter._id = { $in: ids };
      }
    }
    if (fromStr && toStr) {
      filter.createdAt = { $gte: istStartOfDay(fromStr), $lte: istEndOfDay(toStr) };
    } else if (period && period !== 'all') {
      let from;
      if (period === 'today') from = getTodayISTStart();
      else if (period === '7days') from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      else if (period === '30days') from = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      if (from) filter.createdAt = { $gte: from };
    }
    if (status && ['active', 'inactive', 'blocked'].includes(status)) {
      filter.status = status;
    }
    const { role } = req.query;
    if (role && ['user', 'admin', 'manager'].includes(role)) {
      filter.role = role;
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
    // Balance range filter
    if (balanceMin !== undefined || balanceMax !== undefined) {
      filter.walletBalance = {};
      if (balanceMin !== undefined) filter.walletBalance.$gte = Number(balanceMin);
      if (balanceMax !== undefined) filter.walletBalance.$lte = Number(balanceMax);
    }

    // Push notification eligibility filter (has FCM token / no token)
    if (hasFcmToken === 'true' || hasFcmToken === true) {
      filter.fcmTokens = { $exists: true, $ne: [] };
    } else if (hasFcmToken === 'false' || hasFcmToken === false) {
      // "No token" — must combine with existing $or via $and to avoid clobbering search
      const noTokenCond = { $or: [{ fcmTokens: { $exists: false } }, { fcmTokens: { $size: 0 } }] };
      if (filter.$or) {
        filter.$and = [{ $or: filter.$or }, noTokenCond];
        delete filter.$or;
      } else {
        Object.assign(filter, noTokenCond);
      }
    }

    // Hide protected super admin accounts from all user listings
    const HIDDEN_PHONES = ['9166821247', '7877722306'];
    filter.phone = { ...(filter.phone || {}), $nin: HIDDEN_PHONES };

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Sort options
    const sort = (sortBy || '').trim();
    let sortQuery = { createdAt: -1 };
    if (sort === 'topBalance') sortQuery = { walletBalance: -1, _id: 1 };
    else if (sort === 'topEarnings') sortQuery = { earningsBalance: -1, _id: 1 };
    else if (sort === 'topWithdrawable') sortQuery = { earningsBalance: -1, _id: 1 };
    else if (sort === 'topDeposited') sortQuery = { totalDeposited: -1, _id: 1 };

    const [users, totalCount] = await Promise.all([
      User.find(filter).select('-otp -otpExpiry').sort(sortQuery).skip(skip).limit(limitNum).lean(),
      User.countDocuments(filter),
    ]);

    res.json({ users, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
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

    const initBalance = walletBalance || 0;
    const user = await User.create({
      email: email ? email.toLowerCase() : null,
      name,
      phone: phone || null,
      walletBalance: initBalance,
      depositBalance: initBalance,
      earningsBalance: 0,
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
      // Superadmin can assign any role; admin can assign up to 'admin' only
      const callerRole = req.user.role;
      const allowedRoles = callerRole === 'superadmin'
        ? ['user', 'manager', 'admin', 'superadmin']
        : ['user', 'manager', 'admin'];
      if (!allowedRoles.includes(role)) return res.status(400).json({ message: 'Invalid role' });
      // Prevent non-superadmin from changing a superadmin's role
      if (user.role === 'superadmin' && callerRole !== 'superadmin') {
        return res.status(403).json({ message: 'Only super admins can modify super admin users' });
      }
      user.role = role;
    }

    await user.save();
    res.json({ _id: user._id, name: user.name, role: user.role, isAdmin: user.isAdmin, isSuperAdmin: user.isSuperAdmin });
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

    if (operation === 'add') {
      user.creditDeposit(Number(amount));
      user.totalDeposited = (user.totalDeposited || 0) + Number(amount);
    } else if (operation === 'subtract') {
      const subtractAmt = Math.min(Number(amount), user.walletBalance);
      if (subtractAmt > 0) user.smartDeduct(subtractAmt);
    } else {
      // 'set' operation — reset to new value, all as earnings
      const newVal = Number(amount);
      user.walletBalance = newVal;
      user.depositBalance = 0;
      user.earningsBalance = newVal;
    }
    await user.save();

    const newBalance = user.walletBalance;
    const txType = newBalance >= balBefore ? 'credit' : 'debit';
    const txAmt = Math.abs(newBalance - balBefore);
    if (txAmt > 0) {
      await recordWalletTx(
        id, txType, txType === 'credit' ? 'admin_credit' : 'admin_debit', txAmt,
        `Admin ${operation === 'add' ? 'added' : operation === 'subtract' ? 'subtracted' : 'set'} ₹${amount}`,
        balBefore, newBalance, null, req.user._id
      );
    }

    const io = req.app.get('io');
    if (io) io.to(`user_${id}`).emit('wallet:balance-updated', { walletBalance: user.walletBalance, depositBalance: user.depositBalance, earningsBalance: user.earningsBalance });

    res.json({ message: 'Balance updated successfully', user: { _id: user._id, name: user.name, walletBalance: user.walletBalance } });
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

    const oldEarnings = user.earningsBalance || 0;
    user.earningsBalance = desiredEarnings;
    user.depositBalance = Math.max(0, user.walletBalance - desiredEarnings);
    user.totalDeposited = user.depositBalance;
    await user.save();

    console.log(`EARNINGS EDIT — User: ${user.name} (${id}), Earnings: ${oldEarnings.toFixed(2)} -> ${desiredEarnings.toFixed(2)}, depositBalance: ${user.depositBalance}`);

    res.json({
      message: 'Earnings updated successfully',
      user: {
        _id: user._id,
        name: user.name,
        walletBalance: user.walletBalance,
        depositBalance: user.depositBalance,
        earningsBalance: user.earningsBalance,
        totalDeposited: user.totalDeposited,
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
    if (['9166821247', '7877722306'].includes(user.phone)) return res.status(403).json({ message: 'This account is protected and cannot be modified' });

    // Use findByIdAndUpdate to avoid full-document validation
    // (some old users may have missing fields like email)
    const updated = await User.findByIdAndUpdate(
      id,
      { status },
      { new: true, runValidators: false }
    );

    // If blocked, force-logout the user via socket and disconnect their connections
    if (status === 'blocked') {
      const io = req.app.get('io');
      if (io) {
        io.to(`user_${id}`).emit('force-logout', { reason: 'Your account has been blocked' });
        // Disconnect all sockets for this user
        const room = io.sockets.adapter.rooms.get(`user_${id}`);
        if (room) {
          for (const socketId of room) {
            const s = io.sockets.sockets.get(socketId);
            if (s) s.disconnect(true);
          }
        }
        // Remove from active users tracking
        if (io._activeUsers) {
          io._activeUsers.delete(id);
          io.emit('app:active-users', { count: io._activeUsers.size });
          io.to('admins').emit('app:active-user-ids', { ids: Array.from(io._activeUsers.keys()) });
        }
      }
    }

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
    if (['9166821247', '7877722306'].includes(user.phone)) return res.status(403).json({ message: 'This account is protected and cannot be deleted' });

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
    const { status, type, page = 1, limit = 25, from: fromStr, to: toStr, datePreset } = req.query;
    const filter = {};
    if (status) filter.status = status;
    if (type) filter.type = type;

    // Date filtering — all dates interpreted as IST
    if (fromStr && toStr) {
      filter.createdAt = { $gte: istStartOfDay(fromStr), $lte: istEndOfDay(toStr) };
    } else if (datePreset) {
      if (datePreset === 'today') {
        filter.createdAt = { $gte: getTodayISTStart() };
      } else if (datePreset === 'last5') {
        filter.createdAt = { $gte: new Date(Date.now() - 5 * 24 * 60 * 60 * 1000) };
      }
    }

    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Totals match the same filters as the main query (status + type + date)
    const totalsFilter = { ...filter };

    const [requests, totalCount, totalAgg] = await Promise.all([
      WalletRequest.find(filter)
        .populate('userId', 'name email phone walletBalance upiId upiNumber bankAccountNumber bankIfscCode bankAccountHolder')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum),
      WalletRequest.countDocuments(filter),
      WalletRequest.aggregate([
        { $match: totalsFilter },
        { $group: { _id: '$type', totalAmount: { $sum: '$amount' }, count: { $sum: 1 } } },
      ]),
    ]);

    // Build totals map
    const totals = {};
    for (const t of totalAgg) {
      totals[t._id] = { totalAmount: t.totalAmount, count: t.count };
    }

    res.json({
      data: requests,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
      depositTotals: totals.deposit || { totalAmount: 0, count: 0 },
      withdrawalTotals: totals.withdrawal || { totalAmount: 0, count: 0 },
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Bulk delete rejected wallet requests
// @route   POST /api/admin/wallet-requests/bulk-delete
// @body    { ids: [String] }
const bulkDeleteWalletRequests = async (req, res) => {
  try {
    const { ids } = req.body;
    if (!Array.isArray(ids) || ids.length === 0) {
      return res.status(400).json({ message: 'ids array is required' });
    }
    // Only allow deletion of rejected requests for safety
    const result = await WalletRequest.deleteMany({
      _id: { $in: ids },
      status: 'rejected',
    });
    res.json({ message: `${result.deletedCount} rejected request(s) deleted`, deletedCount: result.deletedCount });
  } catch (error) {
    console.error('bulkDeleteWalletRequests error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

const processWalletRequest = async (req, res) => {
  try {
    const { id } = req.params;
    const { action, editedAmount } = req.body;

    if (!['approve', 'reject', 'reject_deduct'].includes(action)) {
      return res.status(400).json({ message: 'Invalid action' });
    }
    if (action === 'reject_deduct') {
      // Pre-check type before atomic claim
      const preCheck = await WalletRequest.findById(id);
      if (preCheck && preCheck.type !== 'withdrawal') {
        return res.status(400).json({ message: 'Reject & Deduct is only for withdrawal requests' });
      }
    }

    // Determine new status based on action
    const newStatus = action === 'approve' ? 'approved' : 'rejected';

    // Build atomic update — also apply editedAmount if provided
    const atomicUpdate = { $set: { status: newStatus, processedAt: new Date() } };
    if (editedAmount !== undefined && editedAmount !== null) {
      const newAmt = Number(editedAmount);
      if (isNaN(newAmt) || newAmt < 1) return res.status(400).json({ message: 'Edited amount must be at least ₹1' });
      atomicUpdate.$set.amount = newAmt;
    }

    // Atomic claim — prevents double-credit if admin double-clicks approve
    const walletRequest = await WalletRequest.findOneAndUpdate(
      { _id: id, status: 'pending' },
      atomicUpdate,
      { new: true }
    );
    if (!walletRequest) return res.status(400).json({ message: 'Request already processed or not found' });

    const user = await User.findById(walletRequest.userId);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const balBefore = user.walletBalance;

    if (action === 'approve') {
      if (walletRequest.type === 'deposit') {
        user.creditDeposit(walletRequest.amount);
        user.totalDeposited = (user.totalDeposited || 0) + walletRequest.amount;
      }
    } else if (action === 'reject') {
      if (walletRequest.type === 'withdrawal') {
        user.creditEarnings(walletRequest.amount);
      }
    }
    // reject_deduct — no wallet change

    await user.save();
    const newBalance = user.walletBalance;

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

    // Record deduction for reject_deduct (balance unchanged but needs audit trail)
    if (action === 'reject_deduct') {
      await recordWalletTx(
        user._id, 'debit', 'withdrawal_deducted', walletRequest.amount,
        `Withdrawal of ₹${walletRequest.amount} rejected — amount deducted (no refund)`,
        balBefore, newBalance, walletRequest._id
      );
    }

    await WalletRequest.updateOne(
      { _id: walletRequest._id },
      { $set: { processedBy: req.user._id } }
    );

    // Notify user
    const notification = await Notification.create({
      userId: walletRequest.userId,
      title: walletRequest.type === 'deposit' ? 'Deposit Request' : 'Withdrawal Request',
      message: `Your ${walletRequest.type} request of Rs. ${walletRequest.amount} has been ${walletRequest.status}`,
      type: 'wallet',
    });

    const io = req.app.get('io');
    io.to(`user_${walletRequest.userId}`).emit('notification:new', notification);
    io.to(`user_${walletRequest.userId}`).emit('wallet:balance-updated', { walletBalance: user.walletBalance, depositBalance: user.depositBalance, earningsBalance: user.earningsBalance });

    // Push notification to user
    if (user.fcmTokens && user.fcmTokens.length > 0) {
      const pushTitle = action === 'approve'
        ? (walletRequest.type === 'deposit' ? 'Deposit Approved' : 'Withdrawal Approved')
        : (walletRequest.type === 'deposit' ? 'Deposit Rejected' : 'Withdrawal Rejected');
      const pushBody = action === 'approve'
        ? `Aapki Rs.${walletRequest.amount} ${walletRequest.type} request approve ho gayi hai!`
        : `Aapki Rs.${walletRequest.amount} ${walletRequest.type} request reject kar di gayi hai.`;
      sendPushNotification(user._id, user.fcmTokens, pushTitle, pushBody, { type: `${walletRequest.type}_${action}` });
    }

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

    // Date filtering — all dates interpreted as IST
    if (fromStr && toStr) {
      filter.createdAt = { $gte: istStartOfDay(fromStr), $lte: istEndOfDay(toStr) };
    } else if (period && period !== 'all') {
      let from;
      if (period === 'today') from = getTodayISTStart();
      else if (period === '7days') from = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
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

const bulkClearBets = async (req, res) => {
  try {
    const { from, to, status } = req.body;
    if (!from || !to) return res.status(400).json({ message: 'Date range (from, to) is required' });

    const fromDate = istStartOfDay(from);
    const toDate = istEndOfDay(to);

    const filter = { createdAt: { $gte: fromDate, $lte: toDate } };
    if (status === 'won') filter.status = 'won';
    else if (status === 'lost') filter.status = 'lost';
    // 'all' means no status filter

    const count = await Bet.countDocuments(filter);
    if (count === 0) return res.json({ message: 'No bets found for the given criteria', deletedCount: 0 });

    const result = await Bet.deleteMany(filter);
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
      if (startDate && !isNaN(new Date(startDate).getTime())) filter.createdAt.$gte = istStartOfDay(startDate);
      if (endDate && !isNaN(new Date(endDate).getTime())) filter.createdAt.$lte = istEndOfDay(endDate);
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
    const KycRequest = require('../models/KycRequest');
    const [walletRequests, ludoRequests, kycRequests] = await Promise.all([
      WalletRequest.find({ status: 'pending' })
        .populate('userId', 'name phone')
        .sort({ createdAt: -1 })
        .limit(50),
      LudoResultRequest.find({ status: 'pending' })
        .sort({ createdAt: -1 })
        .limit(50),
      KycRequest.find({ status: 'pending' })
        .populate('userId', 'name phone')
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

    // Transform KYC requests
    const kycNotifs = kycRequests.map((r) => ({
      _id: r._id,
      type: 'kyc',
      userName: r.userId?.name || 'User',
      userPhone: r.userId?.phone,
      userId: r.userId?._id,
      createdAt: r.createdAt,
    }));

    // Merge and sort by createdAt descending
    const all = [...walletRequests.map((r) => r.toObject()), ...ludoNotifs, ...kycNotifs]
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
    const { startDate, endDate, date, username, page = 1, limit = 25, all, result } = req.query;
    const filter = {};

    // Won / Lost filter
    if (result === 'won') {
      filter.outcome = { $ne: 'thank_you' };
    } else if (result === 'lost') {
      filter.outcome = 'thank_you';
    }

    if (!all && (startDate || endDate || date)) {
      const sDate = startDate || date;
      const eDate = endDate || date;
      if (sDate) {
        if (isNaN(new Date(sDate).getTime())) return res.status(400).json({ message: 'Invalid start date' });
        filter.createdAt = { $gte: istStartOfDay(sDate) };
      }
      if (eDate) {
        if (isNaN(new Date(eDate).getTime())) return res.status(400).json({ message: 'Invalid end date' });
        filter.createdAt = { ...filter.createdAt, $lte: istEndOfDay(eDate) };
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
      logoUrl: settings.logoUrl || null,
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
      landingPlayers: settings.landingPlayers || '1000+',
      landingWonToday: settings.landingWonToday || '₹1K+',
      userWarning: settings.userWarning || '',
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
      aviatorComingSoon: settings.aviatorComingSoon ?? false,
      spinnerComingSoon: settings.spinnerComingSoon ?? false,
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
      landingPlayers,
      landingWonToday,
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
      aviatorComingSoon,
      spinnerComingSoon,
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
    if (landingPlayers !== undefined) settings.landingPlayers = landingPlayers;
    if (landingWonToday !== undefined) settings.landingWonToday = landingWonToday;
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
    if (typeof aviatorComingSoon === 'boolean') settings.aviatorComingSoon = aviatorComingSoon;
    if (typeof spinnerComingSoon === 'boolean') settings.spinnerComingSoon = spinnerComingSoon;
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

const uploadLogo = async (req, res) => {
  try {
    if (!req.file || !req.file.buffer) {
      return res.status(400).json({ message: 'Logo image is required' });
    }

    const compressedBuffer = await sharp(req.file.buffer)
      .resize({ width: 400, withoutEnlargement: true })
      .png({ quality: 85 })
      .toBuffer();

    const url = await uploadFromBuffer(compressedBuffer, 'lean_aviator/logo', 'image/png');

    const settings = await getOrCreateSettings();
    settings.logoUrl = url;
    await settings.save();

    res.json({ message: 'Logo uploaded', logoUrl: url });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get current logo (public)
// @route   GET /api/settings/logo
const getPublicLogo = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({ logoUrl: s.logoUrl || null });
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

// @desc    Get landing page stats (public)
// @route   GET /api/settings/landing-stats
const getPublicLandingStats = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({
      landingPlayers: s.landingPlayers || '1000+',
      landingWonToday: s.landingWonToday || '₹1K+',
    });
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

// @desc    Get game visibility status (public)
// @route   GET /api/settings/aviator-status
const getPublicAviatorStatus = async (req, res) => {
  try {
    const s = await getOrCreateSettings();
    res.json({
      aviatorComingSoon: s.aviatorComingSoon ?? false,
      spinnerComingSoon: s.spinnerComingSoon ?? false,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── USER DETAIL ────────────────────────

const getUserDetail = async (req, res) => {
  try {
    const { id } = req.params;

    // Regular admins cannot see admin_credit/debit done by superadmin
    const adminTxFilter = { userId: id, category: { $in: ['admin_credit', 'admin_debit'] } };
    if (req.user.role !== 'superadmin') {
      const superadminIds = await User.find({ role: 'superadmin' }).select('_id').lean();
      const superadminIdList = superadminIds.map(u => u._id);
      if (superadminIdList.length > 0) adminTxFilter.adminId = { $nin: superadminIdList };
    }

    const [user, walletRequests, aviatorBets, ludoMatches, spinnerRecords, kycRequest, adminTransactions] = await Promise.all([
      User.findById(id).select('-otp -otpExpiry'),
      WalletRequest.find({ userId: id }).sort({ createdAt: -1 }).limit(100),
      Bet.find({ userId: id }).sort({ createdAt: -1 }).limit(100),
      LudoMatch.find({ $or: [{ creatorId: id }, { 'players.userId': id }] }).sort({ createdAt: -1 }).limit(100),
      SpinnerRecord.find({ userId: id }).sort({ createdAt: -1 }).limit(100),
      KycRequest.findOne({ userId: id }).lean(),
      WalletTransaction.find(adminTxFilter)
        .populate('adminId', 'name role')
        .sort({ createdAt: -1 })
        .limit(100)
        .lean(),
    ]);
    if (!user) return res.status(404).json({ message: 'User not found' });
    res.json({ user, walletRequests, aviatorBets, ludoMatches, spinnerRecords, kycRequest: kycRequest || null, adminTransactions });
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

    // Non-superadmin admins cannot see admin_credit/debit done by superadmin
    if (req.user.role !== 'superadmin') {
      const superadminIds = await User.find({ role: 'superadmin' }).select('_id').lean();
      const superadminIdList = superadminIds.map(u => u._id);
      if (superadminIdList.length > 0) {
        filter.$nor = [
          {
            category: { $in: ['admin_credit', 'admin_debit'] },
            adminId: { $in: superadminIdList },
          },
        ];
      }
    }

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

// Lightweight pending counts for admin badge indicators
// Accepts optional query params: sinceMoney, sinceAlerts, sinceLudo, sinceKyc (ISO timestamps)
// Returns total pending counts + unread counts per badge
const getPendingCounts = async (req, res) => {
  try {
    const LudoResultRequest = require('../models/LudoResultRequest');
    const KycRequest = require('../models/KycRequest');

    const parseTs = (ts) => {
      if (!ts) return null;
      const d = new Date(ts);
      return isNaN(d.getTime()) ? null : d;
    };

    const moneyDate  = parseTs(req.query.sinceMoney);
    const alertsDate = parseTs(req.query.sinceAlerts);
    const ludoDate   = parseTs(req.query.sinceLudo);
    const kycDate    = parseTs(req.query.sinceKyc);

    const mF = (d) => d ? { createdAt: { $gt: d } } : null;

    const [
      pendingDeposits, pendingWithdrawals, pendingLudo, pendingKyc,
      unreadDeposits, unreadWithdrawals,
      unreadLudo, unreadKyc,
      unreadAlertsDeposits, unreadAlertsWithdrawals, unreadAlertsLudo, unreadAlertsKyc,
    ] = await Promise.all([
      WalletRequest.countDocuments({ type: 'deposit', status: 'pending' }),
      WalletRequest.countDocuments({ type: 'withdrawal', status: 'pending' }),
      LudoResultRequest.countDocuments({ status: 'pending' }),
      KycRequest.countDocuments({ status: 'pending' }),
      // Money badge unread
      mF(moneyDate) ? WalletRequest.countDocuments({ type: 'deposit',    status: 'pending', ...mF(moneyDate) }) : Promise.resolve(null),
      mF(moneyDate) ? WalletRequest.countDocuments({ type: 'withdrawal', status: 'pending', ...mF(moneyDate) }) : Promise.resolve(null),
      // Ludo badge unread
      mF(ludoDate)  ? LudoResultRequest.countDocuments({ status: 'pending', ...mF(ludoDate) })  : Promise.resolve(null),
      // KYC badge unread
      mF(kycDate)   ? KycRequest.countDocuments({ status: 'pending', ...mF(kycDate) })           : Promise.resolve(null),
      // Alerts badge unread (all 4 categories since sinceAlerts)
      mF(alertsDate) ? WalletRequest.countDocuments({ type: 'deposit',    status: 'pending', ...mF(alertsDate) }) : Promise.resolve(null),
      mF(alertsDate) ? WalletRequest.countDocuments({ type: 'withdrawal', status: 'pending', ...mF(alertsDate) }) : Promise.resolve(null),
      mF(alertsDate) ? LudoResultRequest.countDocuments({ status: 'pending', ...mF(alertsDate) })                 : Promise.resolve(null),
      mF(alertsDate) ? KycRequest.countDocuments({ status: 'pending', ...mF(alertsDate) })                        : Promise.resolve(null),
    ]);

    const unreadAlerts = alertsDate
      ? (unreadAlertsDeposits || 0) + (unreadAlertsWithdrawals || 0) + (unreadAlertsLudo || 0) + (unreadAlertsKyc || 0)
      : pendingDeposits + pendingWithdrawals + pendingLudo + pendingKyc;

    res.json({
      pendingDeposits, pendingWithdrawals, pendingLudo, pendingKyc,
      unreadDeposits:   unreadDeposits   ?? pendingDeposits,
      unreadWithdrawals: unreadWithdrawals ?? pendingWithdrawals,
      unreadLudo:       unreadLudo       ?? pendingLudo,
      unreadKyc:        unreadKyc        ?? pendingKyc,
      unreadAlerts,
    });
  } catch (error) {
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── EXPORT USERS ────────────────────────

const exportUsers = async (req, res) => {
  try {
    const users = await User.find({ role: 'user' })
      .select('name phone email upiId upiNumber bankAccountNumber bankIfscCode bankAccountHolder walletBalance status createdAt')
      .sort({ createdAt: -1 })
      .lean();

    let totalBalance = 0;
    const rows = users.map((u, i) => {
      const bal = u.walletBalance || 0;
      totalBalance += bal;
      return {
        'S.No': i + 1,
        'Name': u.name || '—',
        'Phone': u.phone || '—',
        'Email': u.email || '—',
        'UPI ID': u.upiId || '—',
        'UPI Number': u.upiNumber || '—',
        'Bank Account': u.bankAccountNumber || '—',
        'IFSC': u.bankIfscCode || '—',
        'Account Holder': u.bankAccountHolder || '—',
        'Balance': bal,
        'Status': u.status || 'active',
        'Joined': u.createdAt ? new Date(u.createdAt).toLocaleDateString('en-IN') : '—',
      };
    });

    res.json({ users: rows, total: rows.length, totalBalance });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── PROFIT PAGE ────────────────────────

const getLudoProfit = async (req, res) => {
  try {
    const { page = 1, limit = 50, startDate, endDate } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { status: 'completed', winnerId: { $ne: null } };
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) { const s = new Date(startDate + 'T00:00:00+05:30'); if (!isNaN(s)) filter.createdAt.$gte = s; }
      if (endDate) { const e = new Date(endDate + 'T23:59:59+05:30'); if (!isNaN(e)) filter.createdAt.$lte = e; }
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    const { calcLudoCommission, getCommissionTiers } = require('../utils/ludoCommission');

    // Fetch tiers ONCE (instead of once per match — major performance fix)
    const tiers = await getCommissionTiers();

    const [matches, total, allMatches] = await Promise.all([
      LudoMatch.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      LudoMatch.countDocuments(filter),
      // Fetch ALL matches in filter (only fields needed for commission calc) to compute correct total profit across pages
      LudoMatch.find(filter).select('entryAmount players').lean(),
    ]);

    // Total profit across the ENTIRE filtered range (not just current page)
    let totalProfit = 0;
    for (const m of allMatches) {
      const pool = m.players.reduce((s, p) => s + (p.amountPaid || 0), 0);
      const { commission } = await calcLudoCommission(pool, m.entryAmount, tiers);
      totalProfit += commission;
    }

    // Build rows for current page only
    const rows = await Promise.all(matches.map(async (m) => {
      const pool = m.players.reduce((s, p) => s + (p.amountPaid || 0), 0);
      const { commission, winnerAmount } = await calcLudoCommission(pool, m.entryAmount, tiers);
      const winner = m.players.find(p => p.userId?.toString() === m.winnerId?.toString());
      const loser = m.players.find(p => p.userId?.toString() !== m.winnerId?.toString());
      return {
        _id: m._id,
        entryAmount: m.entryAmount,
        pool,
        prize: winnerAmount,
        commission,
        winnerName: winner?.userName || '—',
        loserName: loser?.userName || '—',
        createdAt: m.createdAt,
      };
    }));

    res.json({ rows, total, totalPages: Math.ceil(total / limitNum), page: pageNum, totalProfit: Math.round(totalProfit * 100) / 100 });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getAviatorProfit = async (req, res) => {
  try {
    const { page = 1, limit = 50, startDate, endDate } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { status: 'crashed', totalBetAmount: { $gt: 0 } };
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) { const s = new Date(startDate + 'T00:00:00+05:30'); if (!isNaN(s)) filter.createdAt.$gte = s; }
      if (endDate) { const e = new Date(endDate + 'T23:59:59+05:30'); if (!isNaN(e)) filter.createdAt.$lte = e; }
      if (!Object.keys(filter.createdAt).length) delete filter.createdAt;
    }

    const GameRound = require('../models/GameRound');
    const [rounds, total, totalsAgg] = await Promise.all([
      GameRound.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum).lean(),
      GameRound.countDocuments(filter),
      // Compute totalProfit across the ENTIRE filtered range, not just current page
      GameRound.aggregate([
        { $match: filter },
        { $group: {
          _id: null,
          totalBet: { $sum: '$totalBetAmount' },
          totalWin: { $sum: '$totalWinAmount' },
        } },
      ]),
    ]);

    const totalProfit = totalsAgg.length
      ? Math.round(((totalsAgg[0].totalBet || 0) - (totalsAgg[0].totalWin || 0)) * 100) / 100
      : 0;

    const rows = rounds.map((r) => {
      const profit = (r.totalBetAmount || 0) - (r.totalWinAmount || 0);
      return {
        _id: r._id,
        roundId: r.roundId,
        crashMultiplier: r.crashMultiplier,
        totalBet: r.totalBetAmount || 0,
        totalWin: r.totalWinAmount || 0,
        profit,
        createdAt: r.createdAt,
      };
    });

    res.json({ rows, total, totalPages: Math.ceil(total / limitNum), page: pageNum, totalProfit });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── DATABASE CLEANUP ────────────────────────

const cleanupPhotos = async (req, res) => {
  try {
    const { startDate, endDate, photoType } = req.body;
    if (!startDate || !endDate) return res.status(400).json({ message: 'Start and end date required' });

    const s = istStartOfDay(startDate);
    const e = istEndOfDay(endDate);

    const { cloudinary } = require('../config/cloudinary');

    // KYC photos only
    if (photoType === 'kyc_photos') {
      const KycRequest = require('../models/KycRequest');
      const kycDocs = await KycRequest.find({ createdAt: { $gte: s, $lte: e }, aadhaarFrontUrl: { $ne: null } }).lean();
      const ids = [];
      for (const doc of kycDocs) {
        if (doc.aadhaarFrontUrl?.includes('cloudinary.com')) {
          const parts = doc.aadhaarFrontUrl.split('/upload/');
          if (parts[1]) {
            const pathParts = parts[1].split('/'); pathParts.shift();
            const publicId = pathParts.join('/').replace(/\.[^.]+$/, '');
            if (publicId) ids.push(publicId);
          }
        }
      }
      for (let i = 0; i < ids.length; i += 100) {
        try { await cloudinary.api.delete_resources(ids.slice(i, i + 100)); } catch (err) { console.error('Cloudinary delete error:', err.message); }
      }
      await KycRequest.updateMany({ createdAt: { $gte: s, $lte: e }, aadhaarFrontUrl: { $ne: null } }, { $set: { aadhaarFrontUrl: null } });
      return res.json({ message: `Deleted ${kycDocs.length} KYC aadhaar photos from Cloudinary` });
    }

    // Deposit photos only
    if (photoType === 'deposit_photos') {
      const walletReqs = await WalletRequest.find({ createdAt: { $gte: s, $lte: e }, screenshotUrl: { $ne: null } }).lean();
      const ids = [];
      for (const wr of walletReqs) {
        if (wr.screenshotUrl?.includes('cloudinary.com')) {
          const parts = wr.screenshotUrl.split('/upload/');
          if (parts[1]) {
            const pathParts = parts[1].split('/'); pathParts.shift();
            const publicId = pathParts.join('/').replace(/\.[^.]+$/, '');
            if (publicId) ids.push(publicId);
          }
        }
      }
      for (let i = 0; i < ids.length; i += 100) {
        try { await cloudinary.api.delete_resources(ids.slice(i, i + 100)); } catch (err) { console.error('Cloudinary delete error:', err.message); }
      }
      await WalletRequest.updateMany({ createdAt: { $gte: s, $lte: e }, screenshotUrl: { $ne: null } }, { $set: { screenshotUrl: null } });
      return res.json({ message: `Deleted ${walletReqs.length} deposit screenshots from Cloudinary` });
    }

    // Ludo result photos only
    if (photoType === 'ludo_photos') {
      const requests = await LudoResultRequest.find({ createdAt: { $gte: s, $lte: e }, 'claims.screenshotUrl': { $ne: null } }).lean();
      const ids = [];
      for (const req of requests) {
        for (const claim of req.claims) {
          if (claim.screenshotUrl?.includes('cloudinary.com')) {
            const parts = claim.screenshotUrl.split('/upload/');
            if (parts[1]) {
              const pathParts = parts[1].split('/'); pathParts.shift();
              const publicId = pathParts.join('/').replace(/\.[^.]+$/, '');
              if (publicId) ids.push(publicId);
            }
          }
        }
      }
      for (let i = 0; i < ids.length; i += 100) {
        try { await cloudinary.api.delete_resources(ids.slice(i, i + 100)); } catch (err) { console.error('Cloudinary delete error:', err.message); }
      }
      await LudoResultRequest.updateMany({ createdAt: { $gte: s, $lte: e }, 'claims.screenshotUrl': { $ne: null } }, { $set: { 'claims.$[].screenshotUrl': null } });
      return res.json({ message: `Deleted ${requests.length} ludo result screenshots from Cloudinary` });
    }

    // Find ludo result requests with screenshots in date range
    const requests = await LudoResultRequest.find({
      createdAt: { $gte: s, $lte: e },
      'claims.screenshotUrl': { $ne: null },
    }).lean();

    let deletedCount = 0;
    const cloudinaryIds = [];

    for (const req of requests) {
      for (const claim of req.claims) {
        if (claim.screenshotUrl && claim.screenshotUrl.includes('cloudinary.com')) {
          // Extract public_id from URL: .../upload/v123/folder/filename.ext
          const parts = claim.screenshotUrl.split('/upload/');
          if (parts[1]) {
            const pathWithVersion = parts[1]; // v123/folder/filename.ext
            const pathParts = pathWithVersion.split('/');
            pathParts.shift(); // remove version
            const publicId = pathParts.join('/').replace(/\.[^.]+$/, ''); // remove extension
            if (publicId) cloudinaryIds.push(publicId);
          }
          deletedCount++;
        }
      }
    }

    // Delete from Cloudinary in batches of 100
    for (let i = 0; i < cloudinaryIds.length; i += 100) {
      const batch = cloudinaryIds.slice(i, i + 100);
      try { await cloudinary.api.delete_resources(batch); } catch (err) { console.error('Cloudinary batch delete error:', err.message); }
    }

    // Clear screenshot URLs from DB
    await LudoResultRequest.updateMany(
      { createdAt: { $gte: s, $lte: e }, 'claims.screenshotUrl': { $ne: null } },
      { $set: { 'claims.$[].screenshotUrl': null } }
    );

    // Also clean wallet request screenshots
    const walletReqs = await WalletRequest.find({
      createdAt: { $gte: s, $lte: e },
      screenshotUrl: { $ne: null },
    }).lean();

    const walletCloudinaryIds = [];
    for (const wr of walletReqs) {
      if (wr.screenshotUrl && wr.screenshotUrl.includes('cloudinary.com')) {
        const parts = wr.screenshotUrl.split('/upload/');
        if (parts[1]) {
          const pathParts = parts[1].split('/');
          pathParts.shift();
          const publicId = pathParts.join('/').replace(/\.[^.]+$/, '');
          if (publicId) walletCloudinaryIds.push(publicId);
        }
        deletedCount++;
      }
    }

    for (let i = 0; i < walletCloudinaryIds.length; i += 100) {
      const batch = walletCloudinaryIds.slice(i, i + 100);
      try { await cloudinary.api.delete_resources(batch); } catch (err) { console.error('Cloudinary batch delete error:', err.message); }
    }

    await WalletRequest.updateMany(
      { createdAt: { $gte: s, $lte: e }, screenshotUrl: { $ne: null } },
      { $set: { screenshotUrl: null } }
    );

    res.json({ message: `Deleted ${deletedCount} photos from Cloudinary and cleared DB references` });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const cleanupLudoMatches = async (req, res) => {
  try {
    const { startDate, endDate } = req.body;
    if (!startDate || !endDate) return res.status(400).json({ message: 'Start and end date required' });

    const s = istStartOfDay(startDate);
    const e = istEndOfDay(endDate);

    const filter = {
      status: { $in: ['cancelled', 'waiting'] },
      createdAt: { $gte: s, $lte: e },
    };

    // For waiting matches, only delete if expired (joinExpiryAt has passed)
    const now = new Date();
    const expiredWaiting = await LudoMatch.countDocuments({
      status: 'waiting',
      createdAt: { $gte: s, $lte: e },
      $or: [{ joinExpiryAt: { $lte: now } }, { joinExpiryAt: null }],
    });
    const cancelledCount = await LudoMatch.countDocuments({
      status: 'cancelled',
      createdAt: { $gte: s, $lte: e },
    });

    // Delete expired waiting + cancelled matches
    await LudoMatch.deleteMany({
      createdAt: { $gte: s, $lte: e },
      $or: [
        { status: 'cancelled' },
        { status: 'waiting', $or: [{ joinExpiryAt: { $lte: now } }, { joinExpiryAt: null }] },
      ],
    });

    // Also delete associated result requests for these deleted matches
    const remainingMatchIds = (await LudoMatch.find({}, '_id').lean()).map(m => m._id);
    await LudoResultRequest.deleteMany({ matchId: { $nin: remainingMatchIds } });

    res.json({
      message: `Deleted ${expiredWaiting} expired waiting + ${cancelledCount} cancelled matches`,
      expiredWaiting,
      cancelledCount,
      total: expiredWaiting + cancelledCount,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

const getCleanupPreview = async (req, res) => {
  try {
    const { type, startDate, endDate } = req.query;
    if (!startDate || !endDate) return res.status(400).json({ message: 'Dates required' });

    const s = istStartOfDay(startDate);
    const e = istEndOfDay(endDate);

    if (type === 'ludo_photos') {
      const sample = await LudoResultRequest.findOne({ createdAt: { $gte: s, $lte: e }, 'claims.screenshotUrl': { $ne: null } }).lean();
      const count = await LudoResultRequest.countDocuments({ createdAt: { $gte: s, $lte: e }, 'claims.screenshotUrl': { $ne: null } });
      const sampleUrl = sample?.claims?.find(c => c.screenshotUrl)?.screenshotUrl || null;
      return res.json({ count, sampleUrl });
    }
    if (type === 'deposit_photos') {
      const sample = await WalletRequest.findOne({ createdAt: { $gte: s, $lte: e }, screenshotUrl: { $ne: null } }).lean();
      const count = await WalletRequest.countDocuments({ createdAt: { $gte: s, $lte: e }, screenshotUrl: { $ne: null } });
      return res.json({ count, sampleUrl: sample?.screenshotUrl || null });
    }
    if (type === 'kyc_photos') {
      const KycRequest = require('../models/KycRequest');
      const sample = await KycRequest.findOne({ createdAt: { $gte: s, $lte: e }, aadhaarFrontUrl: { $ne: null } }).lean();
      const count = await KycRequest.countDocuments({ createdAt: { $gte: s, $lte: e }, aadhaarFrontUrl: { $ne: null } });
      return res.json({ count, sampleUrl: sample?.aadhaarFrontUrl || null });
    }
    if (type === 'photos') {
      const ludoPhotos = await LudoResultRequest.countDocuments({
        createdAt: { $gte: s, $lte: e },
        'claims.screenshotUrl': { $ne: null },
      });
      const walletPhotos = await WalletRequest.countDocuments({
        createdAt: { $gte: s, $lte: e },
        screenshotUrl: { $ne: null },
      });
      return res.json({ count: ludoPhotos + walletPhotos, ludoPhotos, walletPhotos });
    }

    if (type === 'ludo') {
      const now = new Date();
      const expired = await LudoMatch.countDocuments({
        status: 'waiting',
        createdAt: { $gte: s, $lte: e },
        $or: [{ joinExpiryAt: { $lte: now } }, { joinExpiryAt: null }],
      });
      const cancelled = await LudoMatch.countDocuments({
        status: 'cancelled',
        createdAt: { $gte: s, $lte: e },
      });
      return res.json({ count: expired + cancelled, expired, cancelled });
    }

    res.status(400).json({ message: 'Invalid type' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get admin credit/debit log (super admin only)
// @route   GET /api/admin/credit-log
const getAdminCreditLog = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { category: { $in: ['admin_credit', 'admin_debit'] } };

    // Non-superadmin admins can only see records created by non-superadmin admins
    if (req.user.role !== 'superadmin') {
      const superadminIds = await User.find({ role: 'superadmin' }).select('_id').lean();
      const superadminIdList = superadminIds.map(u => u._id);
      if (superadminIdList.length > 0) {
        filter.adminId = { $nin: superadminIdList };
      }
    }

    const [records, totalCount] = await Promise.all([
      WalletTransaction.find(filter)
        .populate('userId', 'name phone')
        .populate('adminId', 'name phone')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      WalletTransaction.countDocuments(filter),
    ]);

    res.json({
      records,
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
  getPendingCounts,
  getUsers,
  createUser,
  updateUser,
  updateUserBalance,
  updateUserEarnings,
  updateUserStatus,
  deleteUser,
  getWalletRequests,
  processWalletRequest,
  bulkDeleteWalletRequests,
  getAllBets,
  deleteBets,
  bulkClearBets,
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
  uploadLogo,
  getBonusRecords,
  getUserDetail,
  getUserTransactions,
  getPublicSupport,
  getPublicTerms,
  getPublicLayout,
  getPublicUserWarning,
  getPublicLandingStats,
  getPublicAviatorStatus,
  getPublicLogo,
  getLudoProfit,
  getAviatorProfit,
  cleanupPhotos,
  cleanupLudoMatches,
  getCleanupPreview,
  exportUsers,
  getAdminCreditLog,
};
