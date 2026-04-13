const express = require('express');
const router = express.Router();
const {
  getDashboardStats,
  getUsers,
  createUser,
  updateUser,
  updateUserBalance,
  updateUserEarnings,
  updateUserStatus,
  deleteUser,
  getUserDetail,
  getUserTransactions,
  getWalletRequests,
  processWalletRequest,
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
  getPendingCounts,
  getLudoProfit,
  getAviatorProfit,
  cleanupPhotos,
  cleanupLudoMatches,
  getCleanupPreview,
  exportUsers,
  getAdminCreditLog,
} = require('../controllers/adminController');
const { getAdminReferrals, adjustCommission } = require('../controllers/referralController');
const {
  getAllLudoMatches,
  getLudoMatchDetail,
  getLudoResultRequests,
  approveLudoResultRequest,
  rejectLudoResultRequest,
  resolveDispute,
  updateLudoMatchStatus,
  bulkDeleteLudoMatches,
} = require('../controllers/adminLudoController');
const { protect, adminOnly, fullAdminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');
const { getKycRequests, approveKyc, rejectKyc, deleteKyc } = require('../controllers/kycController');

// All admin routes require authentication and admin role
router.use(protect);
router.use(adminOnly);

router.get('/dashboard', getDashboardStats);
router.get('/pending-counts', getPendingCounts);
router.get('/active-users', (req, res) => {
  const io = req.app.get('io');
  const activeUsers = io?._activeUsers;
  const ids = activeUsers ? Array.from(activeUsers.keys()) : [];
  res.json({ ids, count: ids.length });
});
router.get('/users', getUsers);
router.post('/users', fullAdminOnly, createUser);
router.put('/users/:id', fullAdminOnly, updateUser);
router.get('/users/:id/detail', getUserDetail);
router.get('/users/:id/transactions', getUserTransactions);
router.put('/users/:id/balance', fullAdminOnly, updateUserBalance);
router.put('/users/:id/earnings', fullAdminOnly, updateUserEarnings);
router.put('/users/:id/status', fullAdminOnly, updateUserStatus);
router.delete('/users/:id', fullAdminOnly, deleteUser);
router.get('/wallet-requests', getWalletRequests);
router.put('/wallet-requests/:id', processWalletRequest);
router.get('/bets', getAllBets);
router.post('/bets/delete', fullAdminOnly, deleteBets);
router.post('/bets/bulk-clear', fullAdminOnly, bulkClearBets);
router.get('/bets/live', getLiveBets);
router.post('/bets/:id/force-crash', forceCrashBet);
router.get('/game/current-round', getCurrentRoundWithBets);
router.post('/game/force-crash-round', forceCrashRound);
router.post('/game/set-next-crash', fullAdminOnly, setNextCrash);
router.post('/game/clear-next-crash', fullAdminOnly, clearNextCrash);
router.post('/game/set-bulk-crash', fullAdminOnly, setBulkCrash);
router.post('/game/clear-bulk-crash', fullAdminOnly, clearBulkCrash);
router.post('/game/set-sequential-crashes', fullAdminOnly, setSequentialCrashes);
router.post('/game/clear-sequential-crashes', fullAdminOnly, clearSequentialCrashes);
router.get('/game/crash-queue', getCrashQueue);
router.get('/wins-bets', getWinningBets);
router.get('/notifications', getAdminNotifications);
router.get('/spinner-records', getSpinnerRecords);
router.get('/settings', fullAdminOnly, getSettings);
router.put('/settings', fullAdminOnly, updateSettings);
router.post('/settings/qr', fullAdminOnly, upload.single('qrCode'), uploadQrCode);
router.post('/settings/logo', fullAdminOnly, upload.single('logo'), uploadLogo);
router.get('/bonus-records', getBonusRecords);

// Export
router.get('/export/users', fullAdminOnly, exportUsers);

// Admin Credit/Debit Log (super admin only — fullAdminOnly allows admin+superadmin)
router.get('/credit-log', fullAdminOnly, getAdminCreditLog);

// Referrals
router.get('/referrals', fullAdminOnly, getAdminReferrals);
router.put('/referrals/:id/adjust', fullAdminOnly, adjustCommission);

// Profit
router.get('/profit/ludo', fullAdminOnly, getLudoProfit);
router.get('/profit/aviator', fullAdminOnly, getAviatorProfit);

// Database cleanup
router.get('/cleanup/preview', fullAdminOnly, getCleanupPreview);
router.post('/cleanup/photos', fullAdminOnly, cleanupPhotos);
router.post('/cleanup/ludo-matches', fullAdminOnly, cleanupLudoMatches);

// KYC
router.get('/kyc', getKycRequests);
router.put('/kyc/:id/approve', fullAdminOnly, approveKyc);
router.put('/kyc/:id/reject', fullAdminOnly, rejectKyc);
router.delete('/kyc/:id', fullAdminOnly, deleteKyc);

// Ludo (separate section)
router.get('/ludo/matches', getAllLudoMatches);
router.post('/ludo/matches/bulk-delete', fullAdminOnly, bulkDeleteLudoMatches);
router.get('/ludo/matches/:id', getLudoMatchDetail);
router.put('/ludo/matches/:id/status', updateLudoMatchStatus);
router.get('/ludo/result-requests', getLudoResultRequests);
router.put('/ludo/result-requests/:id/approve', approveLudoResultRequest);
router.put('/ludo/result-requests/:id/reject', rejectLudoResultRequest);
router.put('/ludo/result-requests/:id/resolve-dispute', resolveDispute);

module.exports = router;
