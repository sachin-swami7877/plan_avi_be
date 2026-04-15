const User = require('../models/User');
const ReferralCommission = require('../models/ReferralCommission');
const { istStartOfDay, istEndOfDay } = require('../utils/istDate');
const { recordWalletTx } = require('../utils/recordWalletTx');

// ── USER: Get own referral page data ──────────────────────────────────────────
// @route GET /api/referral/my
const getMyReferral = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('referralCode');
    if (!user) return res.status(404).json({ message: 'User not found' });

    // All commissions earned by this user
    const commissions = await ReferralCommission.find({ referrerId: req.user._id })
      .populate('referredUserId', 'name phone')
      .sort({ createdAt: -1 })
      .lean();

    // Group by referredUserId
    const groupMap = {};
    for (const c of commissions) {
      const uid = c.referredUserId?._id?.toString() || c.referredUserId?.toString();
      if (!groupMap[uid]) {
        groupMap[uid] = { user: c.referredUserId, commissions: [], totalEarned: 0 };
      }
      groupMap[uid].commissions.push(c);
      groupMap[uid].totalEarned = Math.round((groupMap[uid].totalEarned + c.commissionAmount) * 100) / 100;
    }

    const totalEarned = commissions.reduce((s, c) => s + c.commissionAmount, 0);
    // Treat missing/null status as 'pending' (backcompat with records created before status field)
    const pendingAmount = commissions
      .filter(c => !c.status || c.status === 'pending')
      .reduce((s, c) => s + c.commissionAmount, 0);
    const redeemedAmount = commissions
      .filter(c => c.status === 'redeemed')
      .reduce((s, c) => s + c.commissionAmount, 0);
    // Fetch ALL referred users (even those who haven't played yet)
    const allReferredUsers = await User.find({ referredBy: req.user._id })
      .select('name phone createdAt')
      .lean();
    const referredCount = allReferredUsers.length;

    // Merge commission data into each referred user
    const referredUsers = allReferredUsers.map(u => {
      const uid = u._id.toString();
      return groupMap[uid] || { user: u, commissions: [], totalEarned: 0 };
    });

    res.json({
      referralCode: user.referralCode,
      totalEarned: Math.round(totalEarned * 100) / 100,
      pendingAmount: Math.round(pendingAmount * 100) / 100,
      redeemedAmount: Math.round(redeemedAmount * 100) / 100,
      referredCount,
      referredUsers,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── USER: Redeem all pending commissions ──────────────────────────────────────
// @route POST /api/referral/redeem
const redeemCommission = async (req, res) => {
  try {
    // Include old records with no status field (backcompat)
    const pendingRecords = await ReferralCommission.find({
      referrerId: req.user._id,
      $or: [{ status: 'pending' }, { status: { $exists: false } }, { status: null }],
    });

    if (pendingRecords.length === 0) {
      return res.status(400).json({ message: 'No pending commission to redeem.' });
    }

    const totalAmount = Math.round(
      pendingRecords.reduce((s, r) => s + r.commissionAmount, 0) * 100
    ) / 100;

    if (totalAmount <= 0) {
      return res.status(400).json({ message: 'Nothing to redeem.' });
    }

    // Credit to depositBalance only (play-only, NOT withdrawable)
    const user = await User.findById(req.user._id);
    const balBefore = user.walletBalance;
    user.creditDeposit(totalAmount);
    await user.save();

    // Mark all pending as redeemed
    const now = new Date();
    await ReferralCommission.updateMany(
      { _id: { $in: pendingRecords.map(r => r._id) } },
      { $set: { status: 'redeemed', redeemedAt: now } }
    );

    // Record wallet transaction
    await recordWalletTx(
      user._id, 'credit', 'referral_redemption', totalAmount,
      `Referral commission redeemed — ₹${totalAmount} (play balance, non-withdrawable)`,
      balBefore, user.walletBalance
    );

    const io = req.app.get('io');
    if (io) {
      io.to(`user_${user._id}`).emit('wallet:balance-updated', {
        walletBalance: user.walletBalance,
        depositBalance: user.depositBalance,
        earningsBalance: user.earningsBalance,
      });
    }

    res.json({
      message: `₹${totalAmount} redeemed successfully! Added to your play balance.`,
      redeemedAmount: totalAmount,
      walletBalance: user.walletBalance,
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── ADMIN: Get referral commissions ───────────────────────────────────────────
// @route GET /api/admin/referrals
const getAdminReferrals = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 50, status, view } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(200, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = istStartOfDay(startDate);
      if (endDate) filter.createdAt.$lte = istEndOfDay(endDate);
    }
    if (status && status !== 'all') filter.status = status;

    // Top earners view — aggregate by referrerId
    if (view === 'top') {
      const agg = await ReferralCommission.aggregate([
        { $match: filter },
        { $group: {
          _id: '$referrerId',
          totalEarned: { $sum: '$commissionAmount' },
          pendingAmount: { $sum: { $cond: [{ $eq: ['$status', 'pending'] }, '$commissionAmount', 0] } },
          redeemedAmount: { $sum: { $cond: [{ $eq: ['$status', 'redeemed'] }, '$commissionAmount', 0] } },
          count: { $sum: 1 },
        }},
        { $sort: { totalEarned: -1 } },
        { $skip: skip },
        { $limit: limitNum },
        { $lookup: { from: 'users', localField: '_id', foreignField: '_id', as: 'referrer' } },
        { $unwind: { path: '$referrer', preserveNullAndEmptyArrays: true } },
      ]);
      const totalCount = await ReferralCommission.aggregate([
        { $match: filter },
        { $group: { _id: '$referrerId' } },
        { $count: 'n' },
      ]);
      return res.json({
        topEarners: agg,
        totalCount: totalCount[0]?.n || 0,
        page: pageNum,
        totalPages: Math.ceil((totalCount[0]?.n || 0) / limitNum),
      });
    }

    const [rows, totalCount] = await Promise.all([
      ReferralCommission.find(filter)
        .populate('referrerId', 'name phone referralCode')
        .populate('referredUserId', 'name phone')
        .populate('matchId', 'entryAmount')
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limitNum)
        .lean(),
      ReferralCommission.countDocuments(filter),
    ]);

    // Group by referrerId
    const groupMap = {};
    for (const r of rows) {
      const uid = r.referrerId?._id?.toString();
      if (!groupMap[uid]) {
        groupMap[uid] = { referrer: r.referrerId, commissions: [], totalEarned: 0, pendingAmount: 0, redeemedAmount: 0 };
      }
      groupMap[uid].commissions.push(r);
      groupMap[uid].totalEarned = Math.round((groupMap[uid].totalEarned + r.commissionAmount) * 100) / 100;
      // Treat missing/null status as 'pending' (backcompat)
      if (!r.status || r.status === 'pending') groupMap[uid].pendingAmount = Math.round((groupMap[uid].pendingAmount + r.commissionAmount) * 100) / 100;
      if (r.status === 'redeemed') groupMap[uid].redeemedAmount = Math.round((groupMap[uid].redeemedAmount + r.commissionAmount) * 100) / 100;
    }

    // Summary stats (all time for status counts)
    const [pendingTotal, redeemedTotal] = await Promise.all([
      ReferralCommission.aggregate([
        { $match: { ...filter, $or: [{ status: 'pending' }, { status: { $exists: false } }, { status: null }] } },
        { $group: { _id: null, total: { $sum: '$commissionAmount' }, count: { $sum: 1 } } },
      ]),
      ReferralCommission.aggregate([
        { $match: { ...filter, status: 'redeemed' } },
        { $group: { _id: null, total: { $sum: '$commissionAmount' }, count: { $sum: 1 } } },
      ]),
    ]);

    const totalCommission = rows.reduce((s, r) => s + r.commissionAmount, 0);

    res.json({
      rows,
      groups: Object.values(groupMap),
      totalCount,
      totalCommission: Math.round(totalCommission * 100) / 100,
      pendingStats: { total: Math.round((pendingTotal[0]?.total || 0) * 100) / 100, count: pendingTotal[0]?.count || 0 },
      redeemedStats: { total: Math.round((redeemedTotal[0]?.total || 0) * 100) / 100, count: redeemedTotal[0]?.count || 0 },
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── ADMIN: Adjust a pending commission amount (super admin only) ───────────────
// @route PUT /api/admin/referrals/:id/adjust
const adjustCommission = async (req, res) => {
  try {
    if (req.user.role !== 'superadmin') {
      return res.status(403).json({ message: 'Super admin only.' });
    }
    const { id } = req.params;
    const { commissionAmount, note } = req.body;
    const newAmount = Number(commissionAmount);
    if (isNaN(newAmount) || newAmount < 0) {
      return res.status(400).json({ message: 'Invalid amount.' });
    }

    const record = await ReferralCommission.findById(id).populate('referrerId', 'name');
    if (!record) return res.status(404).json({ message: 'Commission record not found.' });
    if (record.status === 'redeemed') {
      return res.status(400).json({ message: 'Cannot adjust an already-redeemed commission.' });
    }

    const oldAmount = record.commissionAmount;
    record.commissionAmount = newAmount;
    await record.save();

    // Log adjustment in wallet history (no balance change — just a record)
    const referrer = await User.findById(record.referrerId);
    if (referrer) {
      await recordWalletTx(
        referrer._id, 'credit', 'referral_adjust', newAmount,
        `Admin adjusted referral commission: ₹${oldAmount} → ₹${newAmount}${note ? ` (${note})` : ''}`,
        referrer.walletBalance, referrer.walletBalance, id, req.user._id
      );
    }

    res.json({ message: 'Commission adjusted.', record });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── ADMIN: All referred users grouped by referrer (even zero-commission) ────────
// @route GET /api/admin/referrals/all-referred
const getAdminAllReferredUsers = async (req, res) => {
  try {
    const { page = 1, limit = 50, search = '' } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    // Today range in IST
    const now = new Date();
    const istNow = new Date(now.getTime() + 5.5 * 60 * 60 * 1000);
    const todayStr = istNow.toISOString().slice(0, 10);
    const todayStart = istStartOfDay(todayStr);
    const todayEnd = istEndOfDay(todayStr);

    // All users who were referred (have referredBy set)
    const referredUsers = await User.find(
      { referredBy: { $exists: true, $ne: null } }
    ).select('name phone referredBy createdAt').lean();

    // Group by referredBy (referrerId string)
    const referrerMap = {};
    for (const u of referredUsers) {
      const rid = u.referredBy.toString();
      if (!referrerMap[rid]) referrerMap[rid] = [];
      referrerMap[rid].push(u);
    }
    const referrerIds = Object.keys(referrerMap);

    // Search / paginate referrers
    const searchFilter = { _id: { $in: referrerIds } };
    if (search && search.trim()) {
      const regex = new RegExp(search.trim(), 'i');
      searchFilter.$or = [{ name: regex }, { phone: regex }, { referralCode: regex }];
    }

    const [totalCount, referrers] = await Promise.all([
      User.countDocuments(searchFilter),
      User.find(searchFilter).select('name phone referralCode').skip(skip).limit(limitNum).lean(),
    ]);

    // Fetch commissions for these referrers only
    const referrerObjectIds = referrers.map(r => r._id);
    const commissions = await ReferralCommission.find({
      referrerId: { $in: referrerObjectIds },
    }).select('referrerId referredUserId commissionAmount status createdAt').lean();

    // Build commission map: referrerId -> referredUserId -> stats
    const commissionMap = {};
    for (const c of commissions) {
      const rid = c.referrerId.toString();
      const uid = c.referredUserId.toString();
      if (!commissionMap[rid]) commissionMap[rid] = {};
      if (!commissionMap[rid][uid]) commissionMap[rid][uid] = { total: 0, today: 0, redeemed: 0, pending: 0 };
      commissionMap[rid][uid].total += c.commissionAmount;
      if (c.createdAt >= todayStart && c.createdAt <= todayEnd) {
        commissionMap[rid][uid].today += c.commissionAmount;
      }
      if (c.status === 'redeemed') commissionMap[rid][uid].redeemed += c.commissionAmount;
      else commissionMap[rid][uid].pending += c.commissionAmount;
    }

    const round = (n) => Math.round(n * 100) / 100;

    const result = referrers.map(r => {
      const rid = r._id.toString();
      const referred = referrerMap[rid] || [];
      const rCommMap = commissionMap[rid] || {};

      let totalCommission = 0, todayCommission = 0, totalRedeemed = 0, totalPending = 0;

      const referredWithStats = referred.map(u => {
        const uid = u._id.toString();
        const s = rCommMap[uid] || { total: 0, today: 0, redeemed: 0, pending: 0 };
        totalCommission += s.total;
        todayCommission += s.today;
        totalRedeemed += s.redeemed;
        totalPending += s.pending;
        return {
          user: u,
          totalCommission: round(s.total),
          todayCommission: round(s.today),
          redeemed: round(s.redeemed),
          pending: round(s.pending),
        };
      });

      return {
        referrer: r,
        referredUsers: referredWithStats,
        totalReferredCount: referred.length,
        totalCommission: round(totalCommission),
        todayCommission: round(todayCommission),
        redeemed: round(totalRedeemed),
        pending: round(totalPending),
      };
    });

    res.json({ referrers: result, totalCount, page: pageNum, totalPages: Math.ceil(totalCount / limitNum) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { getMyReferral, redeemCommission, getAdminReferrals, adjustCommission, getAdminAllReferredUsers };
