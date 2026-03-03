require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

const migrate = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const users = await User.find({});
    let migrated = 0;

    for (const user of users) {
      user.depositBalance = 0;
      user.earningsBalance = Math.max(0, user.walletBalance);
      await user.save();
      migrated++;
    }

    console.log(`Migrated ${migrated} users (earningsBalance = walletBalance, depositBalance = 0)`);
    process.exit(0);
  } catch (error) {
    console.error('Migration error:', error);
    process.exit(1);
  }
};

migrate();
