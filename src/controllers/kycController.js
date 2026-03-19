const KycRequest = require('../models/KycRequest');
const User = require('../models/User');
const Notification = require('../models/Notification');
const { uploadFromBuffer } = require('../config/cloudinary');
const { sendPushToAdmins, sendPushNotification } = require('../config/firebase');
const multer = require('multer');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024 } });

// POST /api/user/kyc — submit or resubmit KYC
const submitKyc = async (req, res) => {
  try {
    const { email, aadhaarNumber, address } = req.body;
    if (!email || !address) {
      return res.status(400).json({ message: 'Email and address are required' });
    }

    const userId = req.user._id;

    // Check if already approved
    if (req.user.kycStatus === 'approved') {
      return res.status(400).json({ message: 'KYC already approved' });
    }

    // Upload aadhaar front image
    let aadhaarFrontUrl = null;
    if (req.file) {
      try {
        aadhaarFrontUrl = await uploadFromBuffer(req.file.buffer, 'kyc', req.file.mimetype || 'image/jpeg');
      } catch (e) {
        return res.status(500).json({ message: 'Image upload failed. Please try again.' });
      }
    } else {
      // Check if existing request already has a photo
      const existing = await KycRequest.findOne({ userId });
      if (!existing?.aadhaarFrontUrl) {
        return res.status(400).json({ message: 'Aadhaar front photo is required' });
      }
      aadhaarFrontUrl = existing.aadhaarFrontUrl;
    }

    const kyc = await KycRequest.findOneAndUpdate(
      { userId },
      { email, aadhaarNumber: (aadhaarNumber || '').replace(/\s/g, ''), aadhaarFrontUrl, address, status: 'pending', rejectionReason: '', reviewedAt: null, reviewedBy: null },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    const updatedUser = await User.findByIdAndUpdate(userId, { kycStatus: 'pending' }, { new: true });

    // Send response immediately — notifications are non-blocking
    res.json({ message: 'KYC submitted successfully. Awaiting admin review.', kyc });

    // Fire notifications after response (won't affect user if they fail)
    (async () => {
      try {
        await Notification.create({
          userId,
          type: 'kyc',
          title: 'KYC Submitted',
          message: 'Aapki KYC request submit ho gayi hai. Admin review karenge aur aapko notify karenge.',
        });

        const admins = await User.find({ $or: [{ isAdmin: true }, { isSubAdmin: true }] }).select('_id fcmTokens');
        await Promise.all(admins.map(a => Notification.create({
          userId: a._id,
          type: 'kyc',
          title: 'New KYC Request',
          message: `${updatedUser.name} (${updatedUser.phone}) ne KYC submit ki hai. Review karein.`,
        })));

        sendPushToAdmins(
          'New KYC Request',
          `${updatedUser.name} (${updatedUser.phone}) ne KYC submit ki hai. Review karein.`,
          { type: 'kyc_submitted' }
        );

        const io = req.app.get('io');
        if (io) {
          io.to('admins').emit('admin:kyc-request', {
            userId: updatedUser._id,
            userName: updatedUser.name,
            userPhone: updatedUser.phone,
          });
        }
      } catch (notifErr) {
        console.error('[KYC submit] Notification error (non-fatal):', notifErr.message);
      }
    })();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/user/kyc — get own KYC status
const getKycStatus = async (req, res) => {
  try {
    const kyc = await KycRequest.findOne({ userId: req.user._id }).lean();
    res.json({ kycStatus: req.user.kycStatus, kyc: kyc || null });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// GET /api/admin/kyc — list KYC requests
const getKycRequests = async (req, res) => {
  try {
    const { status, page = 1, limit = 30 } = req.query;
    const filter = {};
    if (status && status !== 'all') filter.status = status;
    const skip = (Number(page) - 1) * Number(limit);
    const [requests, total] = await Promise.all([
      KycRequest.find(filter).populate('userId', 'name phone').sort({ createdAt: -1 }).skip(skip).limit(Number(limit)).lean(),
      KycRequest.countDocuments(filter),
    ]);
    const pendingCount = await KycRequest.countDocuments({ status: 'pending' });
    res.json({ requests, total, totalPages: Math.ceil(total / Number(limit)), pendingCount });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// PUT /api/admin/kyc/:id/approve
const approveKyc = async (req, res) => {
  try {
    const kyc = await KycRequest.findByIdAndUpdate(
      req.params.id,
      { status: 'approved', rejectionReason: '', reviewedAt: new Date(), reviewedBy: req.user._id },
      { new: true }
    );
    if (!kyc) return res.status(404).json({ message: 'KYC request not found' });
    const approvedUser = await User.findByIdAndUpdate(kyc.userId, { kycStatus: 'approved' }, { new: true });

    // Send response immediately
    res.json({ message: 'KYC approved', kyc });

    // Fire notifications after response
    (async () => {
      try {
        const approveNotif = await Notification.create({
          userId: kyc.userId,
          type: 'kyc',
          title: 'KYC Approved ✅',
          message: 'Aapki KYC verify ho gayi hai. Ab aap withdrawal kar sakte hain.',
        });

        const io = req.app.get('io');
        if (io) {
          io.to(`user_${kyc.userId}`).emit('notification:new', approveNotif);
          io.to(`user_${kyc.userId}`).emit('user:kyc-updated', { kycStatus: 'approved' });
        }

        if (approvedUser?.fcmTokens?.length) {
          sendPushNotification(
            approvedUser._id, approvedUser.fcmTokens,
            'KYC Approved ✅',
            'Aapki KYC verify ho gayi hai. Ab aap withdrawal kar sakte hain.',
            { type: 'kyc_approved' }
          );
        }
      } catch (notifErr) {
        console.error('[KYC approve] Notification error (non-fatal):', notifErr.message);
      }
    })();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// PUT /api/admin/kyc/:id/reject
const rejectKyc = async (req, res) => {
  try {
    const { reason } = req.body;
    if (!reason) return res.status(400).json({ message: 'Rejection reason is required' });
    const kyc = await KycRequest.findByIdAndUpdate(
      req.params.id,
      { status: 'rejected', rejectionReason: reason, reviewedAt: new Date(), reviewedBy: req.user._id },
      { new: true }
    );
    if (!kyc) return res.status(404).json({ message: 'KYC request not found' });
    const rejectedUser = await User.findByIdAndUpdate(kyc.userId, { kycStatus: 'rejected' }, { new: true });

    // Send response immediately
    res.json({ message: 'KYC rejected', kyc });

    // Fire notifications after response
    (async () => {
      try {
        const rejectNotif = await Notification.create({
          userId: kyc.userId,
          type: 'kyc',
          title: 'KYC Rejected ❌',
          message: `Aapki KYC reject ho gayi hai. Reason: ${reason}. Profile pe jaake dubara submit karein.`,
        });

        const io = req.app.get('io');
        if (io) {
          io.to(`user_${kyc.userId}`).emit('notification:new', rejectNotif);
          io.to(`user_${kyc.userId}`).emit('user:kyc-updated', { kycStatus: 'rejected', reason });
        }

        if (rejectedUser?.fcmTokens?.length) {
          sendPushNotification(
            rejectedUser._id, rejectedUser.fcmTokens,
            'KYC Rejected ❌',
            `Aapki KYC reject ho gayi hai. Reason: ${reason}. Profile se dubara submit karein.`,
            { type: 'kyc_rejected' }
          );
        }
      } catch (notifErr) {
        console.error('[KYC reject] Notification error (non-fatal):', notifErr.message);
      }
    })();
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

// DELETE /api/admin/kyc/:id — delete KYC record entirely (user must resubmit from scratch)
const deleteKyc = async (req, res) => {
  try {
    const kyc = await KycRequest.findByIdAndDelete(req.params.id);
    if (!kyc) return res.status(404).json({ message: 'KYC request not found' });
    // Reset user kycStatus to 'none' so they can resubmit
    await User.findByIdAndUpdate(kyc.userId, { kycStatus: 'none' });

    // Notify user (non-blocking)
    (async () => {
      try {
        const notif = await Notification.create({
          userId: kyc.userId,
          type: 'kyc',
          title: 'KYC Deleted',
          message: 'Aapki KYC request delete kar di gayi hai. Profile pe jaake dubara submit karein.',
        });
        const io = req.app.get('io');
        if (io) {
          io.to(`user_${kyc.userId}`).emit('notification:new', notif);
          io.to(`user_${kyc.userId}`).emit('user:kyc-updated', { kycStatus: 'none' });
        }
      } catch (e) {
        console.error('[KYC delete] Notification error (non-fatal):', e.message);
      }
    })();

    res.json({ message: 'KYC deleted. User must resubmit.' });
  } catch (error) {
    console.error(error);
    res.status(500).json({ message: 'Server error' });
  }
};

module.exports = { submitKyc, getKycStatus, getKycRequests, approveKyc, rejectKyc, deleteKyc, upload };
