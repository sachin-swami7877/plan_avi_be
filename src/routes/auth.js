const express = require('express');
const router = express.Router();
const { sendOTP, verifyOTP, setUsername, updateProfile, getMe, findEmailByPhone } = require('../controllers/authController');
const { protect } = require('../middleware/auth');

router.post('/send-otp', sendOTP);
router.post('/verify-otp', verifyOTP);
router.post('/find-email', findEmailByPhone);
router.put('/set-username', protect, setUsername);
router.put('/profile', protect, updateProfile);
router.get('/me', protect, getMe);

module.exports = router;
