const express = require('express');
const router = express.Router();
const Settings = require('../models/Settings');

router.get('/', async (req, res) => {
  let settings = await Settings.findOne();
  if (!settings) {
    settings = new Settings({
      logVisitors: true,
      autoBlock: false,
      dailyReports: true,
      advancedSecurity: false
    });
    await settings.save();
  }
  res.json(settings);
});

router.put('/', async (req, res) => {
  const settings = await Settings.findOneAndUpdate({}, req.body, { new: true, upsert: true });
  res.json(settings);
});

module.exports = router;