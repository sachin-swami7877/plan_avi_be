const User = require('../models/User');
const ReferralCommission = require('../models/ReferralCommission');
const { istStartOfDay, istEndOfDay } = require('../utils/istDate');

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
        groupMap[uid] = {
          user: c.referredUserId,
          commissions: [],
          totalEarned: 0,
        };
      }
      groupMap[uid].commissions.push(c);
      groupMap[uid].totalEarned = Math.round((groupMap[uid].totalEarned + c.commissionAmount) * 100) / 100;
    }

    const totalEarned = commissions.reduce((s, c) => s + c.commissionAmount, 0);
    const referredCount = await User.countDocuments({ referredBy: req.user._id });

    res.json({
      referralCode: user.referralCode,
      totalEarned: Math.round(totalEarned * 100) / 100,
      referredCount,
      referredUsers: Object.values(groupMap),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

// ── ADMIN: Get referral commissions with date filters ─────────────────────────
// @route GET /api/admin/referrals?startDate=YYYY-MM-DD&endDate=YYYY-MM-DD&page=1&limit=30
const getAdminReferrals = async (req, res) => {
  try {
    const { startDate, endDate, page = 1, limit = 30 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = {};
    if (startDate || endDate) {
      filter.createdAt = {};
      if (startDate) filter.createdAt.$gte = istStartOfDay(startDate);
      if (endDate) filter.createdAt.$lte = istEndOfDay(endDate);
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

    // Group by referrerId for accordion view
    const groupMap = {};
    for (const r of rows) {
      const uid = r.referrerId?._id?.toString();
      if (!groupMap[uid]) {
        groupMap[uid] = {
          referrer: r.referrerId,
          commissions: [],
          totalEarned: 0,
        };
      }
      groupMap[uid].commissions.push(r);
      groupMap[uid].totalEarned = Math.round((groupMap[uid].totalEarned + r.commissionAmount) * 100) / 100;
    }

    const totalCommission = rows.reduce((s, r) => s + r.commissionAmount, 0);

    res.json({
      rows,
      groups: Object.values(groupMap),
      totalCount,
      totalCommission: Math.round(totalCommission * 100) / 100,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { getMyReferral, getAdminReferrals };
