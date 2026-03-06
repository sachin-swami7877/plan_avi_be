const jwt = require('jsonwebtoken');
const nodemailer = require('nodemailer');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const { sendOtpSms } = require('../services/smsIndiaHub');
const { sendPushToAdmins } = require('../config/firebase');

// Temporary in-memory store for OTPs of unverified (not yet created) phone users
// Key: 10-digit phone, Value: { otp, otpExpiry }
const pendingPhoneOtps = new Map();

// SMTP transporter configuration
const createTransporter = () => {
  const email = process.env.SMTP_EMAIL || 'sachin.dev@thesukrut.com';
  const password = process.env.SMTP_PASSWORD || 'Sukrut@123#';

  if (email.includes('@gmail.com')) {
    return nodemailer.createTransport({
      service: 'gmail',
      auth: { user: email, pass: password },
    });
  }

  const smtpHost = process.env.SMTP_HOST || 'smtp.gmail.com';
  const smtpPort = parseInt(process.env.SMTP_PORT || '587');
  const smtpSecure = process.env.SMTP_SECURE === 'true' || smtpPort === 465;

  return nodemailer.createTransport({
    host: smtpHost,
    port: smtpPort,
    secure: smtpSecure,
    auth: { user: email, pass: password },
    tls: { rejectUnauthorized: false },
    requireTLS: smtpPort === 587,
    debug: process.env.NODE_ENV === 'development',
    logger: process.env.NODE_ENV === 'development',
  });
};

const generateOTP = () => Math.floor(1000 + Math.random() * 9000).toString();

const generateToken = (id) => {
  return jwt.sign({ id }, process.env.JWT_SECRET, { expiresIn: '90d' });
};

const isValidEmail = (email) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);

// @desc    Send OTP for login (supports email or mobile number)
// @route   POST /api/auth/send-otp
const sendOTP = async (req, res) => {
  try {
    const { loginMode } = req.body;
    const isPhoneLogin = loginMode === 'mobile';

    // ── Phone-based login ──
    if (isPhoneLogin) {
      const rawPhone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
      const cleanPhone = rawPhone.replace(/[^0-9]/g, '');

      if (!cleanPhone || cleanPhone.length < 10) {
        return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number' });
      }

      const last10 = cleanPhone.slice(-10);
      let user = await User.findOne({
        $or: [{ phone: last10 }, { phone: { $regex: last10 + '$' } }],
      });

      const otp = generateOTP();
      const otpExpiry = new Date(Date.now() + 2 * 60 * 1000);

      if (user) {
        if (user.status === 'blocked') {
          return res.status(403).json({ message: 'Your account has been blocked. Please contact support.' });
        }
        if (user.status === 'inactive') {
          return res.status(403).json({ message: 'Your account is inactive. Please contact support.' });
        }
        // Existing user — store OTP on their document
        await User.updateOne({ _id: user._id }, { otp, otpExpiry });
      } else {
        // New user — hold OTP in memory until verified (user created only after OTP confirmation)
        pendingPhoneOtps.set(last10, { otp, otpExpiry });
      }

      try {
        await sendOtpSms(last10, otp);
        console.log(`\n📱 SMS OTP sent to ${last10}: ${otp}\n`);
        return res.json({ message: 'OTP sent successfully to your mobile number' });
      } catch (smsError) {
        console.error('SMS sending error:', smsError);
        // Clean up pending entry if SMS failed for new user
        if (!user) pendingPhoneOtps.delete(last10);
        return res.status(500).json({ message: 'Failed to send SMS. Please try again or login with email.' });
      }
    }

    // ── Email-based login (existing flow) ──
    const rawEmail = req.body.email ?? req.body.phone;
    const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

    if (!email) {
      return res.status(400).json({ message: 'Email is required' });
    }
    if (!isValidEmail(email)) {
      return res.status(400).json({ message: 'Please enter a valid email address' });
    }

    let user = await User.findOne({ email });

    if (user) {
      if (user.status === 'blocked') {
        return res.status(403).json({ message: 'Your account has been blocked. Please contact support.' });
      }
      if (user.status === 'inactive') {
        return res.status(403).json({ message: 'Your account is inactive. Please contact support.' });
      }
    }

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 2 * 60 * 1000);

    if (user) {
      user.otp = otp;
      user.otpExpiry = otpExpiry;
      await user.save();
    } else {
      user = await User.create({ email, name: null, otp, otpExpiry });
    }

    const hasPhone = user && user.phone && String(user.phone).trim();

    // Try SMS via SMSINDIAHUB first if user has a phone number
    if (hasPhone) {
      try {
        await sendOtpSms(user.phone, otp);
        console.log(`\n📱 SMS OTP sent to ${user.phone} for ${email}: ${otp}\n`);
        return res.json({ message: 'OTP sent successfully to your mobile number' });
      } catch (smsError) {
        console.error('SMS sending error:', smsError);
        // fall back to email below
      }
    }

    // Fall back to email OTP
    try {
      const transporter = createTransporter();
      const mailOptions = {
        from: `"RushKaro Ludo" <${process.env.SMTP_EMAIL || 'sachin.dev@thesukrut.com'}>`,
        to: email,
        subject: 'Your RushKaro Ludo OTP',
        html: `
          <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; background-color: #f9f9f9;">
            <div style="background-color: #ffffff; padding: 30px; border-radius: 10px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
              <h2 style="color: #e11d48; margin-top: 0; text-align: center;"> RushKaro Ludo Login</h2>
              <p style="color: #333; font-size: 16px; text-align: center;">Your One-Time Password (OTP) for logging into your account is:</p>
              <div style="background-color: #f3f4f6; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0;">
                <h1 style="color: #e11d48; font-size: 36px; letter-spacing: 8px; margin: 0; font-weight: bold;">${otp}</h1>
              </div>
              <p style="color: #666; font-size: 14px; text-align: center;">This OTP is valid for 2 minutes. Do not share it with anyone.</p>
              <hr style="border: none; border-top: 1px solid #e5e7eb; margin: 20px 0;">
              <p style="color: #999; font-size: 12px; margin: 0; text-align: center;">©RushKaro Ludo - All rights reserved</p>
            </div>
          </div>
        `,
      };

      await transporter.sendMail(mailOptions);
      console.log(`\n📧 OTP sent to ${email}: ${otp}\n`);

      res.json({ message: 'OTP sent successfully to your email' });
    } catch (emailError) {
      console.error('Email sending error:', emailError);
      console.log(`\n📧 [Error] Failed to send OTP to ${email}. OTP was: ${otp}\n`);
      const errorMessage =
        process.env.NODE_ENV === 'development'
          ? `Failed to send email: ${emailError.message || emailError.response || 'Unknown error'}`
          : 'Failed to send email. Please try again later.';
      return res.status(500).json({ message: errorMessage });
    }
  } catch (error) {
    console.error('Send OTP error:', error);
    return res.status(400).json({ message: error.message || 'Failed to send OTP' });
  }
};

// @desc    Verify OTP and login (supports email or mobile number)
// @route   POST /api/auth/verify-otp
const verifyOTP = async (req, res) => {
  try {
    const { loginMode } = req.body;
    const isPhoneLogin = loginMode === 'mobile';
    const otp = typeof req.body.otp === 'string' ? req.body.otp.trim() : '';

    if (!otp) {
      return res.status(400).json({ message: 'OTP is required' });
    }

    let user;

    if (isPhoneLogin) {
      // ── Phone-based verification ──
      const rawPhone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
      const cleanPhone = rawPhone.replace(/[^0-9]/g, '');

      if (!cleanPhone || cleanPhone.length < 10) {
        return res.status(400).json({ message: 'Valid mobile number is required' });
      }

      const last10 = cleanPhone.slice(-10);
      user = await User.findOne({
        $or: [{ phone: last10 }, { phone: { $regex: last10 + '$' } }],
      });

      if (!user) {
        // New user — verify against the pending OTP map
        const pending = pendingPhoneOtps.get(last10);
        if (!pending) return res.status(400).json({ message: 'OTP not found. Please request a new OTP.' });
        if (pending.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
        if (new Date() > pending.otpExpiry) {
          pendingPhoneOtps.delete(last10);
          return res.status(400).json({ message: 'OTP expired' });
        }
        // OTP verified — find existing user (admin-created) or create new
        const existingUser = await User.findOne({ phone: last10 });
        const isNewUser = !existingUser;
        user = existingUser || await User.create({ phone: last10, name: null });
        pendingPhoneOtps.delete(last10);

        // Notify admins about new user registration
        if (isNewUser) {
          const io = req.app.get('io');
          if (io) io.to('admins').emit('admin:new-user', { phone: last10, userId: user._id });
          sendPushToAdmins(
            'New User Registered',
            `New user registered with phone ${last10}`,
            { type: 'new_user' }
          );
        }

        const token = generateToken(user._id);
        return res.json({
          _id: user._id, name: user.name, email: user.email, phone: user.phone,
          upiId: user.upiId, upiNumber: user.upiNumber, walletBalance: user.walletBalance,
          isAdmin: user.isAdmin, status: user.status,
          totalBetAmount: user.totalBetAmount, bonusClaimed: user.bonusClaimed,
          token, needsUsername: true, needsPhone: false, needsProfile: true,
        });
      }
    } else {
      // ── Email-based verification ──
      const rawEmail = req.body.email ?? req.body.phone;
      const email = typeof rawEmail === 'string' ? rawEmail.trim().toLowerCase() : '';

      if (!email) {
        return res.status(400).json({ message: 'Email is required' });
      }

      user = await User.findOne({ email });
    }

    if (!user) return res.status(404).json({ message: 'User not found' });

    if (user.status === 'blocked') {
      return res.status(403).json({ message: 'Your account has been blocked. Please contact support.' });
    }
    if (user.status === 'inactive') {
      return res.status(403).json({ message: 'Your account is inactive. Please contact support.' });
    }

    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date() > user.otpExpiry) return res.status(400).json({ message: 'OTP expired' });

    // Use updateOne to bypass full document validation (some users may lack email field)
    await User.updateOne({ _id: user._id }, { otp: null, otpExpiry: null });

    const token = generateToken(user._id);

    // Flags: need to complete profile (name and/or phone missing)?
    const needsUsername = !user.name || user.name.trim() === '';
    const needsPhone = !user.phone || String(user.phone).trim() === '';
    const needsProfile = needsUsername || needsPhone;

    // Notify admins if this is a brand new user (created < 5 min ago, no name yet)
    if (needsProfile && user.createdAt && (Date.now() - new Date(user.createdAt).getTime()) < 5 * 60 * 1000) {
      const io = req.app.get('io');
      if (io) io.to('admins').emit('admin:new-user', { email: user.email, phone: user.phone, userId: user._id });
      sendPushToAdmins(
        'New User Registered',
        `New user registered: ${user.email || user.phone}`,
        { type: 'new_user' }
      );
    }

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      upiId: user.upiId,
      upiNumber: user.upiNumber,
      walletBalance: user.walletBalance,
      isAdmin: user.isAdmin,
      status: user.status,
      totalBetAmount: user.totalBetAmount,
      bonusClaimed: user.bonusClaimed,
      token,
      needsUsername,
      needsPhone,
      needsProfile,
    });
  } catch (error) {
    console.error('Verify OTP error:', error);
    return res.status(400).json({ message: error.message || 'Verification failed' });
  }
};

// @desc    Set username for first-time users
// @route   PUT /api/auth/set-username
const setUsername = async (req, res) => {
  try {
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    if (!name) return res.status(400).json({ message: 'Name is required' });

    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    user.name = name;
    await user.save();

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      upiId: user.upiId,
      upiNumber: user.upiNumber,
      walletBalance: user.walletBalance,
      isAdmin: user.isAdmin,
      status: user.status,
    });
  } catch (error) {
    console.error('Set username error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Update profile (name, phone, upiId, upiNumber)
// @route   PUT /api/auth/profile
const updateProfile = async (req, res) => {
  try {
    const user = await User.findById(req.user._id);
    if (!user) return res.status(404).json({ message: 'User not found' });

    const { name, phone, upiId, upiNumber } = req.body;
    if (name !== undefined) user.name = String(name).trim();
    if (phone !== undefined) user.phone = String(phone).trim() || null;
    if (upiId !== undefined) user.upiId = String(upiId).trim() || null;
    if (upiNumber !== undefined) user.upiNumber = String(upiNumber).trim() || null;

    await user.save();

    res.json({
      _id: user._id,
      name: user.name,
      email: user.email,
      phone: user.phone,
      upiId: user.upiId,
      upiNumber: user.upiNumber,
      walletBalance: user.walletBalance,
      isAdmin: user.isAdmin,
      status: user.status,
      totalBetAmount: user.totalBetAmount,
      bonusClaimed: user.bonusClaimed,
    });
  } catch (error) {
    console.error('Update profile error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Get current user profile
// @route   GET /api/auth/me
const getMe = async (req, res) => {
  try {
    const user = await User.findById(req.user._id).select('-otp -otpExpiry');
    res.json(user);
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// @desc    Find email by mobile number
// @route   POST /api/auth/find-email
const findEmailByPhone = async (req, res) => {
  try {
    const phone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';

    if (!phone) {
      return res.status(400).json({ message: 'Mobile number is required' });
    }

    // Clean the phone: keep only digits (strip +, spaces, dashes)
    const cleanPhone = phone.replace(/[^0-9]/g, '');
    if (cleanPhone.length < 10) {
      return res.status(400).json({ message: 'Please enter a valid mobile number (at least 10 digits)' });
    }

    // Search by phone or upiNumber fields (user may have saved their number in either)
    const users = await User.find({
      $or: [
        { phone: { $regex: cleanPhone.slice(-10), $options: 'i' } },
        { upiNumber: { $regex: cleanPhone.slice(-10), $options: 'i' } },
      ],
    }).select('email phone name');

    if (!users || users.length === 0) {
      return res.status(404).json({ message: 'No account found with this mobile number' });
    }

    // Mask emails for privacy: show first 2 chars + *** + domain
    const results = users.map((u) => {
      const email = u.email || '';
      const [local, domain] = email.split('@');
      const masked = local.length <= 2
        ? local + '***@' + domain
        : local.slice(0, 2) + '***@' + domain;
      return { maskedEmail: masked, fullEmail: email, name: u.name || 'User' };
    });

    res.json({ accounts: results });
  } catch (error) {
    console.error('Find email by phone error:', error);
    res.status(500).json({ message: 'Server error' });
  }
};

// ──────────────────────── ADMIN AUTH ────────────────────────

// Helper: find admin/manager user by phone (last 10 digits)
const findAdminByPhone = async (rawPhone) => {
  const cleanPhone = (typeof rawPhone === 'string' ? rawPhone.trim() : '').replace(/[^0-9]/g, '');
  if (!cleanPhone || cleanPhone.length < 10) return { error: 'Please enter a valid 10-digit mobile number', status: 400 };
  const last10 = cleanPhone.slice(-10);
  const user = await User.findOne({
    $or: [{ phone: last10 }, { phone: { $regex: last10 + '$' } }],
  });
  if (!user) return { error: 'No account found with this mobile number', status: 404 };
  if (user.role !== 'admin' && user.role !== 'manager') return { error: 'Access denied. Admin or Manager role required.', status: 403 };
  if (user.status === 'blocked') return { error: 'Your account has been blocked. Please contact support.', status: 403 };
  if (user.status === 'inactive') return { error: 'Your account is inactive. Please contact support.', status: 403 };
  return { user, last10 };
};

// @desc    Send OTP for admin login (admin/manager only)
// @route   POST /api/auth/admin/send-otp
const adminSendOTP = async (req, res) => {
  try {
    const result = await findAdminByPhone(req.body.phone);
    if (result.error) return res.status(result.status).json({ message: result.error });
    const { user, last10 } = result;

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 2 * 60 * 1000);
    await User.updateOne({ _id: user._id }, { otp, otpExpiry });

    try {
      await sendOtpSms(last10, otp);
      console.log(`\n📱 Admin SMS OTP sent to ${last10}: ${otp}\n`);
      return res.json({ message: 'OTP sent successfully to your mobile number' });
    } catch (smsError) {
      console.error('Admin SMS sending error:', smsError);
      return res.status(500).json({ message: 'Failed to send SMS. Please try again.' });
    }
  } catch (error) {
    console.error('Admin send OTP error:', error);
    return res.status(400).json({ message: error.message || 'Failed to send OTP' });
  }
};

// @desc    Verify OTP for admin login (admin/manager only)
// @route   POST /api/auth/admin/verify-otp
const adminVerifyOTP = async (req, res) => {
  try {
    const result = await findAdminByPhone(req.body.phone);
    if (result.error) return res.status(result.status).json({ message: result.error });
    const { user } = result;

    const otp = typeof req.body.otp === 'string' ? req.body.otp.trim() : '';
    if (!otp) return res.status(400).json({ message: 'OTP is required' });
    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date() > user.otpExpiry) return res.status(400).json({ message: 'OTP expired' });

    await User.updateOne({ _id: user._id }, { otp: null, otpExpiry: null });
    const token = generateToken(user._id);

    res.json({
      _id: user._id, name: user.name, email: user.email, phone: user.phone,
      role: user.role, isAdmin: user.isAdmin, isSubAdmin: user.isSubAdmin,
      status: user.status, token,
    });
  } catch (error) {
    console.error('Admin verify OTP error:', error);
    return res.status(400).json({ message: error.message || 'Verification failed' });
  }
};

// @desc    Login admin with mobile + password
// @route   POST /api/auth/admin/password-login
const adminPasswordLogin = async (req, res) => {
  try {
    const rawPhone = typeof req.body.phone === 'string' ? req.body.phone.trim() : '';
    const cleanPhone = rawPhone.replace(/[^0-9]/g, '');
    const password = typeof req.body.password === 'string' ? req.body.password : '';

    if (!cleanPhone || cleanPhone.length < 10) {
      return res.status(400).json({ message: 'Please enter a valid 10-digit mobile number' });
    }
    if (!password) return res.status(400).json({ message: 'Password is required' });

    const last10 = cleanPhone.slice(-10);
    const user = await User.findOne({
      $or: [{ phone: last10 }, { phone: { $regex: last10 + '$' } }],
    }).select('+password');

    if (!user) return res.status(404).json({ message: 'No account found with this mobile number' });
    if (user.role !== 'admin' && user.role !== 'manager') return res.status(403).json({ message: 'Access denied. Admin or Manager role required.' });
    if (user.status === 'blocked') return res.status(403).json({ message: 'Your account has been blocked.' });
    if (user.status === 'inactive') return res.status(403).json({ message: 'Your account is inactive.' });

    if (!user.password) {
      return res.status(400).json({ message: 'Password not set. Please use OTP login or set a password via Forgot Password.' });
    }

    const isMatch = await bcrypt.compare(password, user.password);
    if (!isMatch) return res.status(401).json({ message: 'Invalid password' });

    const token = generateToken(user._id);

    res.json({
      _id: user._id, name: user.name, email: user.email, phone: user.phone,
      role: user.role, isAdmin: user.isAdmin, isSubAdmin: user.isSubAdmin,
      status: user.status, token,
    });
  } catch (error) {
    console.error('Admin password login error:', error);
    return res.status(400).json({ message: error.message || 'Login failed' });
  }
};

// @desc    Send OTP for admin forgot password
// @route   POST /api/auth/admin/forgot-password/send-otp
const adminForgotPasswordSendOTP = async (req, res) => {
  try {
    const result = await findAdminByPhone(req.body.phone);
    if (result.error) return res.status(result.status).json({ message: result.error });
    const { user, last10 } = result;

    const otp = generateOTP();
    const otpExpiry = new Date(Date.now() + 2 * 60 * 1000);
    await User.updateOne({ _id: user._id }, { otp, otpExpiry });

    try {
      await sendOtpSms(last10, otp);
      console.log(`\n📱 Admin forgot-password OTP sent to ${last10}: ${otp}\n`);
      return res.json({ message: 'OTP sent successfully to your mobile number' });
    } catch (smsError) {
      console.error('Admin forgot-password SMS error:', smsError);
      return res.status(500).json({ message: 'Failed to send SMS. Please try again.' });
    }
  } catch (error) {
    console.error('Admin forgot-password send OTP error:', error);
    return res.status(400).json({ message: error.message || 'Failed to send OTP' });
  }
};

// @desc    Verify OTP for admin forgot password
// @route   POST /api/auth/admin/forgot-password/verify-otp
const adminForgotPasswordVerifyOTP = async (req, res) => {
  try {
    const result = await findAdminByPhone(req.body.phone);
    if (result.error) return res.status(result.status).json({ message: result.error });
    const { user } = result;

    const otp = typeof req.body.otp === 'string' ? req.body.otp.trim() : '';
    if (!otp) return res.status(400).json({ message: 'OTP is required' });
    if (user.otp !== otp) return res.status(400).json({ message: 'Invalid OTP' });
    if (new Date() > user.otpExpiry) return res.status(400).json({ message: 'OTP expired' });

    await User.updateOne({ _id: user._id }, { otp: null, otpExpiry: null });
    const resetToken = jwt.sign({ id: user._id, purpose: 'password-reset' }, process.env.JWT_SECRET, { expiresIn: '5m' });

    res.json({ message: 'OTP verified. You can now reset your password.', resetToken });
  } catch (error) {
    console.error('Admin forgot-password verify OTP error:', error);
    return res.status(400).json({ message: error.message || 'Verification failed' });
  }
};

// @desc    Reset admin password (after OTP verification)
// @route   POST /api/auth/admin/reset-password
const adminResetPassword = async (req, res) => {
  try {
    const { resetToken, newPassword, confirmPassword } = req.body;

    if (!resetToken) return res.status(400).json({ message: 'Reset token is required. Please verify OTP first.' });
    if (!newPassword || newPassword.length < 6) return res.status(400).json({ message: 'Password must be at least 6 characters' });
    if (newPassword !== confirmPassword) return res.status(400).json({ message: 'Passwords do not match' });

    let decoded;
    try {
      decoded = jwt.verify(resetToken, process.env.JWT_SECRET);
    } catch (err) {
      return res.status(401).json({ message: 'Reset token expired or invalid. Please start over.' });
    }

    if (decoded.purpose !== 'password-reset') return res.status(401).json({ message: 'Invalid reset token.' });

    const user = await User.findById(decoded.id);
    if (!user) return res.status(404).json({ message: 'User not found' });
    if (user.role !== 'admin' && user.role !== 'manager') return res.status(403).json({ message: 'Access denied.' });

    const salt = await bcrypt.genSalt(10);
    const hashedPassword = await bcrypt.hash(newPassword, salt);
    await User.updateOne({ _id: user._id }, { password: hashedPassword });

    res.json({ message: 'Password reset successfully. You can now login with your new password.' });
  } catch (error) {
    console.error('Admin reset password error:', error);
    return res.status(400).json({ message: error.message || 'Password reset failed' });
  }
};

module.exports = {
  sendOTP,
  verifyOTP,
  setUsername,
  updateProfile,
  getMe,
  findEmailByPhone,
  adminSendOTP,
  adminVerifyOTP,
  adminPasswordLogin,
  adminForgotPasswordSendOTP,
  adminForgotPasswordVerifyOTP,
  adminResetPassword,
};
