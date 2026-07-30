const sharp = require('sharp');
const WalletRequest = require('../models/WalletRequest');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const LudoMatch = require('../models/LudoMatch');
const Notification = require('../models/Notification');
const AdminSettings = require('../models/AdminSettings');
const { uploadFromBuffer } = require('../config/cloudinary');
const { recordWalletTx } = require('../utils/recordWalletTx');
const { sendPushToAdmins } = require('../config/firebase');
const { getTodayISTStart } = require('../utils/istDate');

// @desc    Get payment info for deposits (dynamic from AdminSettings)
// @route   GET /api/wallet/payment-info
const getPaymentInfo = async (req, res) => {
  try {
    const { getSiteSettings } = require('../utils/siteSettings');
    const settings = await getSiteSettings(req.user?.siteType);
    res.json({
      qrCodeUrl: settings.qrCodeUrl || null,
      upiId: settings.upiId || null,
      upiNumber: settings.upiNumber || null,
      accountName: 'Aviator Gaming',
      note: 'Send minimum Rs. 100',
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get wallet balance
// @route   GET /api/wallet/balance
const getBalance = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    res.json({
      balance: user.walletBalance,
      depositBalance: user.depositBalance || 0,
      earningsBalance: user.earningsBalance || 0,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Create deposit request
// @route   POST /api/wallet/deposit
const createDepositRequest = async (req, res) => {
  try {
    const { amount, utrNumber } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ message: 'Minimum deposit amount is Rs. 100' });
    }
    if (!utrNumber) {
      return res.status(400).json({ message: 'UTR number is required' });
    }
    // Check for duplicate UTR number across all requests
    const existingUtr = await WalletRequest.findOne({ utrNumber });
    if (existingUtr) {
      return res.status(400).json({ message: 'This UTR number has already been used. Please check your transaction.' });
    }

    // Check if this is user's first deposit
    const prevDeposits = await WalletRequest.countDocuments({
      userId: req.user._id,
      type: 'deposit',
    });
    const isFirstDeposit = prevDeposits === 0;

    // Compress and upload screenshot to Cloudinary (optional)
    let screenshotUrl = null;
    if (req.file && req.file.buffer) {
      try {
        let bufferToUpload;
        let mime = 'image/jpeg';
        try {
          bufferToUpload = await sharp(req.file.buffer, { failOn: 'none' })
            .rotate()
            .resize({ width: 1200, withoutEnlargement: true, fit: 'inside' })
            .jpeg({ quality: 50 })
            .toBuffer();
        } catch (sharpErr) {
          console.error('Sharp processing failed, uploading raw:', sharpErr.message);
          bufferToUpload = req.file.buffer;
          mime = req.file.mimetype || 'image/jpeg';
        }
        screenshotUrl = await uploadFromBuffer(
          bufferToUpload,
          'lean_aviator/deposits',
          mime
        );
      } catch (uploadErr) {
        console.error('Cloudinary upload error:', uploadErr);
        return res.status(500).json({ message: 'Failed to upload screenshot' });
      }
    }

    const walletRequest = await WalletRequest.create({
      userId: req.user._id,
      amount: Number(amount),
      type: 'deposit',
      utrNumber,
      screenshotUrl,
      siteType: req.user.siteType || 'rushkroludo',
    });

    // Notify admins via socket
    const io = req.app.get('io');
    io.to('admins').emit('admin:wallet-request', {
      request: walletRequest,
      userName: req.user.name,
      userPhone: req.user.phone,
    });

    // Notify user via socket
    const notification = await Notification.create({
      userId: req.user._id,
      title: 'Deposit Request Submitted',
      message: `Your deposit request of ₹${amount} has been submitted and is pending approval.`,
      type: 'wallet',
    });
    io.to(`user_${req.user._id}`).emit('notification:new', notification);

    console.log(`\n💰 NEW DEPOSIT REQUEST — User: ${req.user.name}, Amount: ₹${amount}, UTR: ${utrNumber}\n`);

    // Push notification to admins
    sendPushToAdmins(
      'New Deposit Request',
      `${req.user.name} ne Rs.${amount} deposit request bheji hai`,
      { type: 'deposit_request' }
    );

    res.status(201).json({
      message: 'Deposit request submitted successfully',
      request: walletRequest,
      isFirstDeposit,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Create withdrawal request (max 2/day, cannot exceed balance)
// @route   POST /api/wallet/withdraw
const createWithdrawalRequest = async (req, res) => {
  try {
    // Check if withdrawals are enabled (per-site setting)
    const { getSiteSettings } = require('../utils/siteSettings');
    const adminSettings = await getSiteSettings(req.user?.siteType);
    if (adminSettings && adminSettings.withdrawalsEnabled === false) {
      const reason = adminSettings.withdrawalDisableReason || 'Withdrawals are currently disabled.';
      return res.status(403).json({ message: reason });
    }

    // KYC check
    if (req.user.kycStatus !== 'approved') {
      return res.status(403).json({ message: 'KYC verification required before withdrawal. Please complete KYC on your Profile page.', kycRequired: true });
    }

    const amount = Number(req.body?.amount);

    if (!amount || amount < 100) {
      return res.status(400).json({ message: 'Minimum withdrawal amount is Rs. 100' });
    }
    if (!Number.isInteger(amount) || amount % 50 !== 0) {
      return res.status(400).json({ message: 'Amount must be in multiples of 50 (e.g. 100, 150, 200, 250, 500)' });
    }

    // Quick pre-check (non-atomic) for readable error messages
    const userCheck = await User.findById(req.user._id).select('walletBalance earningsBalance');
    const earnings = userCheck?.earningsBalance || 0;
    if (amount > earnings) {
      return res.status(400).json({ message: `You can only withdraw your earnings. Withdrawable: ₹${earnings.toFixed(2)}` });
    }
    if ((userCheck?.walletBalance || 0) < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Block withdrawal if user has a waiting Ludo match (balance not yet deducted)
    const waitingMatch = await LudoMatch.findOne({ creatorId: req.user._id, status: 'waiting' });
    if (waitingMatch) {
      return res.status(400).json({ message: `Cancel your waiting Ludo match (₹${waitingMatch.entryAmount}) before withdrawing.` });
    }

    // Check daily limit: max 2 withdrawals per day (IST day boundary)
    const todayWithdrawals = await WalletRequest.countDocuments({
      userId: req.user._id,
      type: 'withdrawal',
      createdAt: { $gte: getTodayISTStart() },
    });
    if (todayWithdrawals >= 2) {
      return res.status(400).json({ message: 'You can only request 2 withdrawals per day.' });
    }

    // Atomic deduction — prevents race condition (double-tap / concurrent requests).
    // Since we already verified earningsBalance >= amount above, withdrawal always
    // comes from earnings. One atomic op: only ONE concurrent request can win.
    const balBefore = userCheck.walletBalance;
    const user = await User.findOneAndUpdate(
      {
        _id: req.user._id,
        earningsBalance: { $gte: amount },
        walletBalance: { $gte: amount },
      },
      { $inc: { earningsBalance: -amount, walletBalance: -amount } },
      { new: true, runValidators: false }
    );
    if (!user) {
      return res.status(400).json({ message: 'Insufficient balance. Please refresh and try again.' });
    }

    const walletRequest = await WalletRequest.create({
      userId: req.user._id,
      amount: Number(amount),
      type: 'withdrawal',
      siteType: req.user.siteType || 'rushkroludo',
    });

    await recordWalletTx(
      req.user._id, 'debit', 'withdrawal', Number(amount),
      `Withdrawal request of ₹${amount}`,
      balBefore, user.walletBalance, walletRequest._id
    );

    // Notify admins via socket
    const io = req.app.get('io');
    io.to('admins').emit('admin:withdrawal-request', {
      request: walletRequest,
      userName: req.user.name,
      userPhone: req.user.phone,
    });

    // Notify user via socket
    const notification = await Notification.create({
      userId: req.user._id,
      title: 'Withdrawal Request Submitted',
      message: `Your withdrawal request of ₹${amount} has been submitted.`,
      type: 'wallet',
    });
    io.to(`user_${req.user._id}`).emit('notification:new', notification);

    console.log(`\n💸 NEW WITHDRAWAL REQUEST — User: ${req.user.name}, Amount: ₹${amount}\n`);

    // Push notification to admins
    sendPushToAdmins(
      'New Withdrawal Request',
      `${req.user.name} ne Rs.${amount} withdrawal request bheji hai`,
      { type: 'withdrawal_request' }
    );

    res.status(201).json({
      message: 'Withdrawal request submitted successfully',
      request: walletRequest,
      newBalance: user.walletBalance,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get withdrawal info (balance, earnings, totalDeposited)
// @route   GET /api/wallet/withdrawal-info
const getWithdrawalInfo = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('walletBalance depositBalance earningsBalance totalDeposited');
    const totalDeposited = user.totalDeposited || 0;
    const earnings = user.earningsBalance || 0;

    // Check if withdrawals are enabled (per-site setting)
    const { getSiteSettings } = require('../utils/siteSettings');
    const adminSettings = await getSiteSettings(req.user?.siteType);
    const withdrawalsEnabled = adminSettings?.withdrawalsEnabled ?? true;
    const withdrawalDisableReason = adminSettings?.withdrawalDisableReason || '';

    res.json({
      walletBalance: user.walletBalance,
      depositBalance: user.depositBalance || 0,
      earningsBalance: user.earningsBalance || 0,
      totalDeposited,
      earnings,
      withdrawalsEnabled,
      withdrawalDisableReason,
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get user's wallet requests history
// @route   GET /api/wallet/history?page=1&limit=25
const getWalletHistory = async (req, res) => {
  try {
    const { page = 1, limit = 25 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { userId: req.user._id };
    const [requests, totalCount] = await Promise.all([
      WalletRequest.find(filter).sort({ createdAt: -1 }).skip(skip).limit(limitNum),
      WalletRequest.countDocuments(filter),
    ]);

    res.json({
      data: requests,
      totalCount,
      page: pageNum,
      totalPages: Math.ceil(totalCount / limitNum),
    });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get user's full wallet transaction history (all credit/debit events)
// @route   GET /api/wallet/transactions?page=1&limit=30
const getWalletTransactions = async (req, res) => {
  try {
    const { page = 1, limit = 30 } = req.query;
    const pageNum = Math.max(1, parseInt(page));
    const limitNum = Math.min(100, Math.max(1, parseInt(limit)));
    const skip = (pageNum - 1) * limitNum;

    const filter = { userId: req.user._id };
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

// @desc    Cancel a pending wallet request (user-initiated)
// @route   POST /api/wallet/cancel/:id
const cancelWalletRequest = async (req, res) => {
  try {
    const request = await WalletRequest.findById(req.params.id);
    if (!request) return res.status(404).json({ message: 'Request not found' });
    if (request.userId.toString() !== req.user._id.toString()) {
      return res.status(403).json({ message: 'Not your request' });
    }
    if (request.status !== 'pending') {
      return res.status(400).json({ message: 'Only pending requests can be cancelled' });
    }

    request.status = 'rejected';
    request.processedAt = new Date();
    await request.save();

    // If withdrawal, refund the amount back to user
    if (request.type === 'withdrawal') {
      const user = await User.findById(req.user._id);
      const balBefore = user.walletBalance;
      user.creditEarnings(request.amount);
      await user.save();
      const newBalance = user.walletBalance;

      await recordWalletTx(
        user._id, 'credit', 'withdrawal_cancelled', request.amount,
        `Withdrawal of ₹${request.amount} cancelled by user — refunded`,
        balBefore, newBalance, request._id
      );

      // Notify admin
      const io = req.app.get('io');
      if (io) io.to('admins').emit('admin:wallet-request', { type: 'cancelled' });

      return res.json({ message: 'Withdrawal cancelled. Amount refunded.', newBalance });
    }

    // Deposit cancel — no refund needed (money not credited yet)
    const io = req.app.get('io');
    if (io) io.to('admins').emit('admin:wallet-request', { type: 'cancelled' });

    res.json({ message: 'Deposit request cancelled.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = {
  getPaymentInfo,
  getBalance,
  createDepositRequest,
  createWithdrawalRequest,
  getWithdrawalInfo,
  getWalletHistory,
  getWalletTransactions,
  cancelWalletRequest,
};
