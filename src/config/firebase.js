const admin = require('firebase-admin');

let messaging = null;

function initFirebase() {
  if (admin.apps.length) {
    messaging = admin.messaging();
    return;
  }

  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!serviceAccount) {
    console.warn('[Firebase] FIREBASE_SERVICE_ACCOUNT_JSON not set — push notifications disabled');
    return;
  }

  try {
    const parsed = JSON.parse(serviceAccount);
    admin.initializeApp({
      credential: admin.credential.cert(parsed),
    });
    messaging = admin.messaging();
    console.log('[Firebase] Initialized successfully');
  } catch (err) {
    console.error('[Firebase] Init failed:', err.message);
  }
}

const SITE_URL = 'https://rushkroludo.com';

/**
 * Send push notification to an array of FCM tokens.
 * Silently removes invalid/expired tokens from the user's DB record.
 */
async function sendPushNotification(userId, tokens, title, body, data = {}) {
  if (!messaging || !tokens || tokens.length === 0) return;

  const message = {
    data: {
      ...data,
      title,
      body,
    },
    webpush: {
      notification: {
        title,
        body,
        icon: `${SITE_URL}/icon-192.png`,
        badge: `${SITE_URL}/icon-192.png`,
        tag: data.type || 'general',
        renotify: 'true',
      },
      fcm_options: {
        link: SITE_URL,
      },
    },
  };

  try {
    const response = await messaging.sendEachForMulticast({
      tokens,
      ...message,
    });

    // Clean up invalid tokens
    const invalidTokens = [];
    response.responses.forEach((resp, idx) => {
      if (!resp.success) {
        const code = resp.error?.code;
        if (code === 'messaging/invalid-registration-token' ||
            code === 'messaging/registration-token-not-registered') {
          invalidTokens.push(tokens[idx]);
        }
      }
    });

    if (invalidTokens.length > 0 && userId) {
      const User = require('../models/User');
      await User.findByIdAndUpdate(userId, {
        $pull: { fcmTokens: { $in: invalidTokens } },
      });
    }
  } catch (err) {
    console.error('[Firebase] Push failed:', err.message);
  }
}

/**
 * Send push to all admin users.
 */
async function sendPushToAdmins(title, body, data = {}) {
  if (!messaging) return;
  const User = require('../models/User');
  const admins = await User.find({
    $or: [{ isAdmin: true }, { isSubAdmin: true }],
    fcmTokens: { $exists: true, $ne: [] },
  }).select('_id fcmTokens');

  for (const admin of admins) {
    await sendPushNotification(admin._id, admin.fcmTokens, title, body, data);
  }
}

module.exports = { initFirebase, sendPushNotification, sendPushToAdmins };
