const mongoose = require('mongoose');

const SettingsSchema = new mongoose.Schema({
  logVisitors: Boolean,
  autoBlock: Boolean,
  dailyReports: Boolean,
  advancedSecurity: Boolean,
});

module.exports = mongoose.model('Settings', SettingsSchema);