require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

const SUPER_ADMIN_PHONES = ['9166821247', '7877722306'];

async function run() {
  await mongoose.connect(process.env.MONGODB_URI);
  console.log('Connected\n');

  for (const phone of SUPER_ADMIN_PHONES) {
    const user = await User.findOne({ phone });
    if (!user) {
      console.log(`User ${phone} not found — skipping`);
      continue;
    }
    user.role = 'superadmin';
    await user.save();
    console.log(`${user.name} (${phone}) → role: superadmin, isAdmin: ${user.isAdmin}, isSuperAdmin: ${user.isSuperAdmin}`);
  }

  await mongoose.disconnect();
  console.log('\nDone');
}

run().catch(err => { console.error(err); process.exit(1); });
