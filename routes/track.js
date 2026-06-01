const express = require("express");
const router = express.Router();
const Visitor = require("../models/Visitor");
const BlockedIP = require("../models/BlockedIP");
const geoip = require("geoip-lite");

// ✅ Rate limiting للـ logging
let lastErrorLog = 0;
function logErrorLimited(message) {
  const now = Date.now();
  if (now - lastErrorLog > 5000) { // مرة كل 5 ثواني
    console.error(message);
    lastErrorLog = now;
  }
}

const bannedISPs = [
  // Cloudflare
  "CLOUDFLARENET",
  "Cloudflare, Inc.",
  "Cloudflare Inc",
  // Microsoft
  "MICROSOFT-CORP-MSN-AS-BLOCK",
  "Microsoft Corporation",
  "Microsoft Azure",
  "AS8075",
  // Amazon
  "AMAZON-02",
  "Amazon.com, Inc.",
  "Amazon Technologies Inc.",
  // Google
  "GOOGLE-IT",
  "Google Cloud",
  "GoogleCloud",
  "Google One VPN",
  "Google One",
  // DigitalOcean
  "DIGITALOCEAN-ASN",
  "DigitalOcean, LLC",
  // OVH
  "OVH SAS",
  "OVHcloud",
  // Hetzner
  "Hetzner Online GmbH",
  // Alibaba
  "Alibaba Cloud LLC",
  "Alibaba Cloud (Singapore) Private Limited",
  "AlibabaCloud",
  // Tencent
  "Tencent Cloud Computing (Beijing) Co., Ltd",
  // Oracle
  "Oracle Cloud",
  "Oracle Public Cloud",
  // IBM
  "IBM Cloud",
  "SoftLayer Technologies Inc",
  // Akamai / Linode
  "Akamai Technologies, Inc.",
  "Linode",
  // Vultr
  "Vultr Holdings LLC",
  // Huawei
  "Huawei Public Cloud Service",
  // Salesforce
  "Salesforce",
  // Kamatera
  "Kamatera",
  // Facebook / Meta
  "Facebook, Inc.",
  "FACEBOOK",
  "Meta Platforms, Inc.",
  "META",
  // Others (various hosting and proxy services)
  "Choopa, LLC",
  "LeaseWeb Netherlands B.V.",
  "M247 Europe SRL",
  "G-Core Labs S.A.",
  "Contabo GmbH",
  "Scaleway",
  "NETNOD",
  "Shodan",
  "Censys",
  "UAB Cherry Servers",
  "HostHatch",
  "FranTech Solutions",
  "OVH Hosting",
  "NetActuate",
  "Packet",
  "Turnkey Internet",
  "PONYNET",
  "Zenedge LLC",
  // CDN/Protection Services
  "Incapsula Inc",
  "Fastly",
  "StackPath, LLC",
  "Sucuri",
  "Reblaze Technologies Ltd",
  // Mobile Proxy / VPN Detection
  "Mullvad",
  "Windscribe Limited",
  "Private Internet Access",
  "NordVPN",
  "ExpressVPN",
  "Proton VPN AG",
  "CyberGhost",
  "Surfshark Ltd.",
  "HideMyAss",
  "TunnelBear, LLC",
  "MAGIC-WAN",
  "Cogent Communications",
  "xTom GmbH",
  "Mythic Beasts Ltd",
  "IVPN",
  "Oeck LTD",
  "Hide.me VPN",
  "AdGuard VPN",
];

const bannedKeywords = [
  "cloud",
  "hosting",
  "host",
  "vpn",
  "proxy",
  "server",
  "colo",
  "datacenter",
  "infrastructure",
  "solutions",
  "vps",
];

const ipCache = new Map(); // ⏱️ cache بسيط في الذاكرة

router.post("/", async (req, res) => {
  try {
    let ip = req.headers["x-forwarded-for"] || req.socket.remoteAddress;
    if (ip.includes(",")) ip = ip.split(",")[0];
    ip = ip.replace("::ffff:", "");

    // ⏱️ التحقق من الـ cache
    const cached = ipCache.get(ip);
    if (cached && cached.timestamp > Date.now() - 10 * 60 * 1000) {
      if (cached.blocked) {
        return res
          .status(403)
          .json({ error: cached.reason || "Blocked (cached)" });
      }
    }

    // 🔒 تحقق إذا كان IP محظور
    const blocked = await BlockedIP.findOne({ ip });
    if (blocked) {
      ipCache.set(ip, {
        blocked: true,
        timestamp: Date.now(),
        reason: blocked.reason,
      });
      return res.status(403).json({ error: "You are blocked." });
    }

    const userAgent = req.get("User-Agent") || "Unknown";
    const isBot = /bot|crawl|spider|crawling|curl|python|fetch/i.test(
      userAgent,
    );
    const isProxyUA = /proxy|vpn|anonym|tor|hidemy|tunnel/i.test(userAgent);

    const geo = geoip.lookup(ip);
    const country = geo?.country || "Unknown";

    // ⬇️ كشف VPN مع timeout
    let isVPN = false;
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 seconds timeout
      
      const vpnRes = await fetch(
        `https://vpnapi.io/api/${ip}?key=${process.env.VPN_API_KEY}`,
        { signal: controller.signal }
      );
      clearTimeout(timeoutId);
      
      const vpnData = await vpnRes.json();
      isVPN = vpnData.security?.vpn || false;
    } catch (vpnError) {
      logErrorLimited("VPN check failed: " + vpnError.message);
    }

    // 🔍 كشف مزود الاستضافة / البروكسي
    let isp = "";
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 5000); // 5 seconds timeout
      
      const ispRes = await fetch(`http://ip-api.com/json/${ip}`, { signal: controller.signal });
      clearTimeout(timeoutId);
      
      const ispData = await ispRes.json();
      isp = (ispData.as || ispData.org || "").toLowerCase();

      const matchISP = bannedISPs.some((b) => isp.includes(b.toLowerCase()));
      const matchKeyword = bannedKeywords.some((k) => isp.includes(k));

      if (matchISP || matchKeyword) {
        const reason = `Blocked ISP/Keyword: ${isp}`;
        await BlockedIP.updateOne(
          { ip },
          { $set: { reason } },
          { upsert: true },
        );
        ipCache.set(ip, { blocked: true, timestamp: Date.now(), reason });
        return res
          .status(403)
          .json({ error: "Access denied (ISP/proxy detected)" });
      }
    } catch (ispError) {
      logErrorLimited("ISP check failed: " + ispError.message);
    }

    // ❌ إذا VPN أو وكيل مريب
    if (isVPN || isProxyUA) {
      const reason = isVPN ? "VPN Detected" : "Suspicious User-Agent";
      await BlockedIP.updateOne({ ip }, { $set: { reason } }, { upsert: true });
      ipCache.set(ip, { blocked: true, timestamp: Date.now(), reason });
      return res.status(403).json({ error: `Access denied (${reason})` });
    }

    // ✅ سجل الزيارة
    const visitor = new Visitor({
      ip,
      userAgent,
      path: req.body.path || "/",
      isBot,
      country,
    });

    await visitor.save();
    ipCache.set(ip, { blocked: false, timestamp: Date.now() });
    res.status(200).json({ message: "Visitor logged", country });
  } catch (err) {
    logErrorLimited("Visitor log error: " + err.message);
    res.status(500).json({ error: "Failed to log visitor" });
  }
});

module.exports = router;