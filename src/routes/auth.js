const express = require('express');
const router = express.Router();
const {
  sendOTP, verifyOTP, setUsername, updateProfile, getMe, findEmailByPhone,
  adminSendOTP, adminVerifyOTP, adminPasswordLogin,
  adminForgotPasswordSendOTP, adminForgotPasswordVerifyOTP, adminResetPassword,
} = require('../controllers/authController');
const { protect } = require('../middleware/auth');

// User auth routes
router.post('/send-otp', sendOTP);
router.post('/verify-otp', verifyOTP);
router.post('/find-email', findEmailByPhone);
router.put('/set-username', protect, setUsername);
router.put('/profile', protect, updateProfile);
router.get('/me', protect, getMe);

// Admin auth routes (no protect — these are login/reset endpoints)
router.post('/admin/send-otp', adminSendOTP);
router.post('/admin/verify-otp', adminVerifyOTP);
router.post('/admin/password-login', adminPasswordLogin);
router.post('/admin/forgot-password/send-otp', adminForgotPasswordSendOTP);
router.post('/admin/forgot-password/verify-otp', adminForgotPasswordVerifyOTP);
router.post('/admin/reset-password', adminResetPassword);

module.exports = router;
