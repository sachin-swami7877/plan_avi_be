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
} = require('../controllers/adminController');
const {
  getAllLudoMatches,
  getLudoMatchDetail,
  getLudoResultRequests,
  approveLudoResultRequest,
  rejectLudoResultRequest,
  updateLudoMatchStatus,
  bulkDeleteLudoMatches,
} = require('../controllers/adminLudoController');
const { protect, adminOnly, fullAdminOnly } = require('../middleware/auth');
const upload = require('../middleware/upload');

// All admin routes require authentication and admin role
router.use(protect);
router.use(adminOnly);

router.get('/dashboard', getDashboardStats);
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
router.get('/bonus-records', getBonusRecords);

// Ludo (separate section)
router.get('/ludo/matches', getAllLudoMatches);
router.post('/ludo/matches/bulk-delete', fullAdminOnly, bulkDeleteLudoMatches);
router.get('/ludo/matches/:id', getLudoMatchDetail);
router.put('/ludo/matches/:id/status', updateLudoMatchStatus);
router.get('/ludo/result-requests', getLudoResultRequests);
router.put('/ludo/result-requests/:id/approve', approveLudoResultRequest);
router.put('/ludo/result-requests/:id/reject', rejectLudoResultRequest);

module.exports = router;
