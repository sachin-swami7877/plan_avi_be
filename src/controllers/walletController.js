const sharp = require('sharp');
const WalletRequest = require('../models/WalletRequest');
const WalletTransaction = require('../models/WalletTransaction');
const User = require('../models/User');
const Notification = require('../models/Notification');
const AdminSettings = require('../models/AdminSettings');
const { uploadFromBuffer } = require('../config/cloudinary');
const { recordWalletTx } = require('../utils/recordWalletTx');

// @desc    Get payment info for deposits (dynamic from AdminSettings)
// @route   GET /api/wallet/payment-info
const getPaymentInfo = async (req, res) => {
  try {
    let settings = await AdminSettings.findOne({ key: 'main' });
    if (!settings) {
      settings = await AdminSettings.create({ key: 'main' });
    }
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
    res.json({ balance: user.walletBalance });
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
        const compressedBuffer = await sharp(req.file.buffer)
          .resize({ width: 1200, withoutEnlargement: true })
          .jpeg({ quality: 50 })
          .toBuffer();
        screenshotUrl = await uploadFromBuffer(
          compressedBuffer,
          'lean_aviator/deposits',
          'image/jpeg'
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
    // Check if withdrawals are enabled
    const AdminSettings = require('../models/AdminSettings');
    const adminSettings = await AdminSettings.findOne({ key: 'main' });
    if (adminSettings && adminSettings.withdrawalsEnabled === false) {
      const reason = adminSettings.withdrawalDisableReason || 'Withdrawals are currently disabled.';
      return res.status(403).json({ message: reason });
    }

    const { amount } = req.body;

    if (!amount || amount < 100) {
      return res.status(400).json({ message: 'Minimum withdrawal amount is Rs. 100' });
    }

    const user = await User.findById(req.user._id);

    // Users can only withdraw earnings (balance minus total deposited)
    const earnings = Math.max(0, user.walletBalance - (user.totalDeposited || 0));
    if (amount > earnings) {
      return res.status(400).json({ message: `You can only withdraw your earnings. Withdrawable: ₹${earnings.toFixed(2)}` });
    }
    if (user.walletBalance < amount) {
      return res.status(400).json({ message: 'Insufficient balance' });
    }

    // Check daily limit: max 2 withdrawals per day
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayWithdrawals = await WalletRequest.countDocuments({
      userId: req.user._id,
      type: 'withdrawal',
      createdAt: { $gte: todayStart },
    });
    if (todayWithdrawals >= 2) {
      return res.status(400).json({ message: 'You can only request 2 withdrawals per day.' });
    }

    // Deduct balance immediately
    const balBefore = user.walletBalance;
    user.walletBalance -= amount;
    await user.save();

    const walletRequest = await WalletRequest.create({
      userId: req.user._id,
      amount: Number(amount),
      type: 'withdrawal',
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
    const user = await User.findById(req.user._id).select('walletBalance totalDeposited');
    const totalDeposited = user.totalDeposited || 0;
    const earnings = Math.max(0, user.walletBalance - totalDeposited);

    // Check if withdrawals are enabled
    const AdminSettings = require('../models/AdminSettings');
    const adminSettings = await AdminSettings.findOne({ key: 'main' });
    const withdrawalsEnabled = adminSettings?.withdrawalsEnabled ?? true;
    const withdrawalDisableReason = adminSettings?.withdrawalDisableReason || '';

    res.json({ walletBalance: user.walletBalance, totalDeposited, earnings, withdrawalsEnabled, withdrawalDisableReason });
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

module.exports = {
  getPaymentInfo,
  getBalance,
  createDepositRequest,
  createWithdrawalRequest,
  getWithdrawalInfo,
  getWalletHistory,
  getWalletTransactions,
};
