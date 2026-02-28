require('dotenv').config({ path: require('path').join(__dirname, '../../.env') });
const mongoose = require('mongoose');
const User = require('../models/User');

const createAdmin = async () => {
  try {
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('Connected to MongoDB');

    const adminEmail = 'admin@leanaviator.com';
    const adminName = 'Admin';

    // Check if admin exists
    let admin = await User.findOne({ email: adminEmail });

    if (admin) {
      console.log('Admin already exists:', admin.email);
    } else {
      admin = await User.create({
        name: adminName,
        email: adminEmail,
        isAdmin: true,
        walletBalance: 0
      });
      console.log('Admin created successfully!');
    }

    console.log('\n========================================');
    console.log('Admin Credentials:');
    console.log(`Email: ${adminEmail}`);
    console.log(`Name: ${adminName}`);
    console.log('========================================\n');

    process.exit(0);
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
};

createAdmin();
