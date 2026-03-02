require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

const seedAdmins = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    // 1. Create new admin: Krishan Swami (9166821247)
    let admin1 = await User.findOne({ phone: '9166821247' });
    if (admin1) {
      console.log('User with phone 9166821247 already exists.');
      if (admin1.role !== 'admin') {
        admin1.role = 'admin';
        admin1.name = admin1.name || 'Krishan Swami';
        await admin1.save();
        console.log('  -> Updated role to admin.');
      } else {
        console.log('  -> Already an admin.');
      }
    } else {
      admin1 = await User.create({
        name: 'Krishan Swami',
        phone: '9166821247',
        role: 'admin',
      });
      console.log('Created admin: Krishan Swami (9166821247)');
    }

    // 2. Update existing user 7877722306 to admin
    let admin2 = await User.findOne({ phone: '7877722306' });
    if (admin2) {
      if (admin2.role !== 'admin') {
        admin2.role = 'admin';
        await admin2.save();
        console.log(`Updated user ${admin2.name || admin2.phone} (7877722306) to admin.`);
      } else {
        console.log('User 7877722306 is already an admin.');
      }
    } else {
      console.log('WARNING: No user found with phone 7877722306. Create this user first.');
    }

    console.log('\n========================================');
    console.log('Admin seeding complete.');
    console.log('========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

seedAdmins();
