// Per-video caption config. This is the ONLY file you edit per project —
// the generator, layout detection, karaoke, guards, and verify all live in
// ../_caption-kit and read this. See ../_caption-kit/README.md.
//
// It's .mjs, not .json, because the fix map needs real regex (and the odd
// function replacement), which JSON can't hold.

export default {
  slug: "tailscale-ep1",
  language: "th",
  // Files under assets/. Resolution / fps / duration are read from the video
  // itself — never hardcode them (that shipped a 30fps render once).
  video: "tailscale-ep1.mp4",
  audio: "tailscale-ep1.m4a",

  // Top-left label: mint dot + product word + uppercase category.
  kicker: { word: "tailscale", sub: "vpn mesh network" },

  // Literal strings that must NEVER survive into a finished caption — checked by
  // check-captions.mjs. Each one shipped into a build at some point this session.
  neverSurvive: [
    "โคตร", "คลอด", "พลอด", "cloud", "Cloud", "lock in", "hoesop", "herder",
    "ทุลลา", "จอช่อง", "จอดช่อง", "กอบซีเรียม", "ซีโกรธ", "วงแรน", "intel scale",
    "tail scale", "โลคโหส", "หลับการ", "สมเหนือน", "มุตร", "เสียดวก", "อันยาท",
  ],

  // Mint accent = product names only, longest-first (the tokeniser alternates
  // leftmost, so "Claude Code" must precede "Claude"). Generic tech terms are
  // spelling-fixed in fixMap below but stay white.
  accent: ["Claude Code", "Claude", "MagicDNS", "Tailscale"],

  // ASR corrections, applied in order to the raw transcript BEFORE splitting.
  // Skipped entirely in --from-srt mode: a proofread srt is literal truth.
  fixMap: [
    // --- "Claude Code": whisper hears คลอดโคตร AND พลอดโคตร (โคตร = crude slang) ---
    [/[คพ]ลอดโคตร|[คพ]ลอดโค้ด|คลาวด์โคตร/g, "Claude Code"],
    [/\bcl(?:ou|au)d\s*(?:code|host)\b/gi, "Claude Code"],
    [/\bcloud\b/gi, "Claude"], // this audio never means literal cloud
    [/[คพ]ลอด(?!โคตร)/g, "Claude"],
    [/โคตรละ/g, "คนละ"], // "a different one" — unrelated to the Claude Code mis-hear
    // --- product names ---
    [/\btail\s*scale\b/gi, "Tailscale"],
    [/\bintel\s*scale\b/gi, "Tailscale"], // whisper genuinely hears it as "intel scale"
    [/\btailscale\b/g, "Tailscale"],
    [/เทลสเกล|เทลสเคล/g, "Tailscale"],
    [/\bmagic\s*dns\b/gi, "MagicDNS"],
    [/เมจิก\s*DNS|แมจิกดีเอ็นเอส/g, "MagicDNS"],
    [/\bherder\b/gi, "Herdr"],
    // --- generic glossary terms: spelling only, stay white ---
    [/\bport\s*forwarding\b/gi, "port forwarding"],
    [/พอร์ตฟอร์เวิร์ด(ดิ้ง)?/g, "port forwarding"],
    [/\bsubscription\b/gi, "subscription"],
    [/ซับสคริ[ปบ]ชั่?น/g, "subscription"],
    [/\bdevices?\b/gi, (m) => (m.toLowerCase().endsWith("s") ? "devices" : "device")],
    [/ดีไวซ์|ดีไวส์/g, "device"],
    [/\bnetworks?\b/gi, (m) => (m.toLowerCase().endsWith("s") ? "networks" : "network")],
    [/เน็ตเวิร์[คก]/g, "network"],
    // --- Thai mis-hears observed in this audio ---
    [/\bhoesop\b/gi, "โทรศัพท์"], // confirmed against a large-v3 pass on 415–428s
    [/ทุ[ลร]ลา/g, "ธุระ"],
    [/จอ[ดช]ช่อง/g, "เจาะช่อง"],
    [/กอบซีเรียม/g, "กรอบสี่เหลี่ยม"],
    [/ซีโกรธ/g, "ซีกโลก"],
    [/วงแรน/g, "วง LAN"],
    [/สมเหนือนกับ/g, "เสมือนกับ"],
    [/แล้วกลมๆ/g, "แล้ววงกลมๆ"],
    [/เปรียบสำหรับ/g, "เปรียบเสมือน"],
    // --- Thai mis-hears caught by the user's own srt pass (2026-07-17) ---
    [/มุตร/g, "มุด"],
    [/เสียดวก/g, "สะดวก"],
    [/อันยาท/g, "อนุญาต"],
    [/(?:เท้า|เข้า)ข้าว/g, "คร่าวๆ"],
    [/เข้าเลี่ยน/g, "เข้าเล่น"],
    [/อินเตอร์เนท/g, "อินเตอร์เน็ต"],
    [/โลคโหส|โลคัลโฮสต์/g, "localhost"],
    // --- English tidy ---
    [/\block\s+Tailscale\b/gi, "login Tailscale"], // must follow the intel-scale rule above
    [/\block\s*in\b/gi, "login"], // user spells it as one word
    [/\blog\s+in\b/gi, "login"],
    [/\blocal\s*host\b/gi, "localhost"],
    [/\bmac\s*mini\b/gi, "Mac Mini"],
    [/\bmini\s*pc\b/gi, "Mini PC"],
    [/\bgaming\s*pc\b/gi, "Gaming PC"],
    [/\bmacbook\b/gi, "MacBook"],
    [/\bwi-?fi\b/gi, "Wi-Fi"],
    [/\bandroid\b/gi, "Android"],
    [/\binternet\b/gi, "Internet"],
    [/\bip\b/g, "IP"],
    [/\bvpn\b/gi, "VPN"],
    [/แอพ/g, "แอป"],
    [/\s{2,}/g, " "],
  ],
};
