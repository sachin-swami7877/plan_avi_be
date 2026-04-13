const express = require('express');
const router = express.Router();
const { getMyReferral, redeemCommission } = require('../controllers/referralController');
const { protect } = require('../middleware/auth');

router.get('/my', protect, getMyReferral);
router.post('/redeem', protect, redeemCommission);

module.exports = router;
