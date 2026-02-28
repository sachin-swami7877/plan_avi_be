const express = require('express');
const router = express.Router();
const {
  getPaymentInfo,
  getBalance,
  createDepositRequest,
  createWithdrawalRequest,
  getWalletHistory,
  getWalletTransactions,
} = require('../controllers/walletController');
const { protect } = require('../middleware/auth');
const upload = require('../middleware/upload');

router.get('/payment-info', getPaymentInfo);
router.get('/balance', protect, getBalance);
router.post('/deposit', protect, upload.single('screenshot'), createDepositRequest);
router.post('/withdraw', protect, createWithdrawalRequest);
router.get('/history', protect, getWalletHistory);
router.get('/transactions', protect, getWalletTransactions);

module.exports = router;
