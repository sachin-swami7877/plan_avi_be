const express = require('express');
const router = express.Router();
const { getMyReferral } = require('../controllers/referralController');
const { protect } = require('../middleware/auth');

router.get('/my', protect, getMyReferral);

module.exports = router;
