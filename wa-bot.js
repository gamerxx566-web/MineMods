/**
 * WhatsApp Smart Bot
 * messages.txt + رياضيات + Llama AI (مجاني)
 * ردود طبيعية كأنه إنسان
 *
 * التثبيت: npm install @whiskeysockets/baileys @hapi/boom pino
 * التشغيل: node whatsapp_bot_node.js
 */

const {
    default: makeWASocket,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
    DisconnectReason,
} = require("@whiskeysockets/baileys");

const { Boom } = require("@hapi/boom");
const https    = require("https");
const fs       = require("fs");
const path     = require("path");

// ══════════════════════════════════════════
const FIXED_PHONE  = "201037360171";
const SESSION_DIR  = "./wa_session";
const MESSAGES_FILE = path.join(__dirname, "messages.txt");
const KEY_FILE     = path.join(__dirname, ".groq_key");
const REPLY_DELAY  = 800; // ms — يبدو طبيعياً
// ══════════════════════════════════════════

// ── شخصية البوت (لا يُرسَل للمستخدم) ───
const SYSTEM_PROMPT = `أنت شخص عادي يتحدث العربية بشكل طبيعي جداً عبر واتساب.
قواعد صارمة:
- اكتب كأنك إنسان يرد على واتساب، قصير وطبيعي
- لا تذكر أبداً أنك ذكاء اصطناعي أو بوت أو نموذج
- لا تستخدم عبارات رسمية مثل "بالطبع" أو "يسعدني مساعدتك"
- الرد من جملة إلى ثلاث جمل بحد أقصى
- استخدم لهجة عربية عامية أحياناً
- إيموجي واحد فقط إذا ناسب، وليس دائماً
- إذا لم تعرف شيئاً قل "مو عارف" أو "ما عندي فكرة"`;

// تاريخ المحادثات لكل شخص
const chatMemory = {};

// ══════════════════════════════════════════
// 📂 messages.txt
// ══════════════════════════════════════════
function loadMessages() {
    if (!fs.existsSync(MESSAGES_FILE)) return [];
    const map = [];
    for (const raw of fs.readFileSync(MESSAGES_FILE, "utf8").split("\n")) {
        const line = raw.trim();
        if (!line || line.startsWith("#")) continue;
        const sep = line.indexOf("|");
        if (sep === -1) continue;
        const q = line.slice(0, sep).trim().toLowerCase();
        const a = line.slice(sep + 1).trim();
        if (q && a) map.push({ q, a });
    }
    return map;
}

function findReply(text, map) {
    const t = text.trim().toLowerCase();
    for (const e of map) if (t.includes(e.q)) return e.a;
    return null;
}

// ══════════════════════════════════════════
// 🧮 الرياضيات
// ══════════════════════════════════════════
function isMath(text) {
    return /[\+\-\*\/×÷]|\d/.test(text) &&
        /ضرب|قسمة|جمع|طرح|ناقص|زائد|على|اجمع|احسب|مجموع|[\+\-\*\/×÷]/.test(text);
}

function solveMath(text) {
    const t = text
        .replace(/×/g, "*").replace(/÷/g, "/")
        .replace(/ضرب/g, "*").replace(/قسمة|على/g, "/")
        .replace(/زائد|جمع/g, "+").replace(/ناقص|طرح/g, "-");

    // جمع قائمة
    if (/اجمع|مجموع/.test(text)) {
        const nums = t.match(/-?\d+\.?\d*/g);
        if (nums && nums.length >= 2) {
            const sum = nums.map(Number).reduce((a, b) => a + b, 0);
            return `${nums.join(" + ")} = ${sum}`;
        }
    }

    // عملية بسيطة
    const m = t.match(/(-?\d+\.?\d*)\s*([\+\-\*\/])\s*(-?\d+\.?\d*)/);
    if (!m) return null;
    const [, a, op, b] = m;
    const an = parseFloat(a), bn = parseFloat(b);
    let res;
    if (op === "+") res = an + bn;
    if (op === "-") res = an - bn;
    if (op === "*") res = an * bn;
    if (op === "/") {
        if (bn === 0) return "القسمة على صفر ما تنفع 😅";
        res = an / bn;
    }
    const fmt = Number.isInteger(res) ? res : parseFloat(res.toFixed(6));
    return `${an} ${op} ${bn} = ${fmt}`;
}

// ══════════════════════════════════════════
// 🤖 Llama عبر Groq (مجاني)
// ══════════════════════════════════════════
function loadGroqKey() {
    if (fs.existsSync(KEY_FILE)) return fs.readFileSync(KEY_FILE, "utf8").trim();
    return process.env.GROQ_API_KEY || "";
}

function httpsPost(hostname, path, headers, body) {
    return new Promise((resolve, reject) => {
        const data = JSON.stringify(body);
        const req  = https.request(
            { hostname, path, method: "POST", headers: { ...headers, "Content-Length": Buffer.byteLength(data) } },
            res => { let d = ""; res.on("data", c => d += c); res.on("end", () => resolve({ status: res.statusCode, body: d })); }
        );
        req.on("error", reject);
        req.write(data);
        req.end();
    });
}

async function askLlama(userMsg, jid) {
    const key = loadGroqKey();
    if (!key) return null;

    if (!chatMemory[jid]) chatMemory[jid] = [];
    const history = chatMemory[jid].slice(-8); // آخر 8 رسائل فقط

    const messages = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: userMsg },
    ];

    try {
        const res = await httpsPost(
            "api.groq.com",
            "/openai/v1/chat/completions",
            { "Content-Type": "application/json", "Authorization": `Bearer ${key}` },
            { model: "llama-3.3-70b-versatile", messages, max_tokens: 150, temperature: 0.85 }
        );

        if (res.status !== 200) return null;

        const reply = JSON.parse(res.body)?.choices?.[0]?.message?.content?.trim();
        if (!reply) return null;

        // حفظ في الذاكرة
        chatMemory[jid].push({ role: "user", content: userMsg });
        chatMemory[jid].push({ role: "assistant", content: reply });
        if (chatMemory[jid].length > 20) chatMemory[jid].splice(0, 2);

        return reply;
    } catch {
        return null;
    }
}

// ══════════════════════════════════════════
// تأخير عشوائي (يبدو طبيعياً)
// ══════════════════════════════════════════
function humanDelay(textLength) {
    // كلما كان الرد أطول، زاد التأخير قليلاً
    const base  = REPLY_DELAY;
    const extra = Math.min(textLength * 15, 1500);
    const jitter = Math.random() * 400;
    return base + extra + jitter;
}

// ══════════════════════════════════════════
// 🚀 تشغيل البوت
// ══════════════════════════════════════════
async function startBot() {
    let msgMap = loadMessages();

    if (fs.existsSync(MESSAGES_FILE)) {
        fs.watchFile(MESSAGES_FILE, () => {
            msgMap = loadMessages();
            console.log(`[✓] messages.txt: ${msgMap.length} رد`);
        });
    }

    const { state, saveCreds } = await useMultiFileAuthState(SESSION_DIR);
    const { version }          = await fetchLatestBaileysVersion();

    const sock = makeWASocket({
        version,
        auth:              state,
        printQRInTerminal: false,
        logger:            require("pino")({ level: "silent" }),
    });

    // ── رمز الاقتران تلقائي ───────────────
    if (!sock.authState.creds.registered) {
        console.log(`\nجاري طلب رمز الاقتران للرقم ${FIXED_PHONE}...\n`);
        await new Promise(r => setTimeout(r, 3000));

        try {
            const code = await sock.requestPairingCode(FIXED_PHONE);
            console.log("╔══════════════════════════════╗");
            console.log("║     رمز الاقتران:            ║");
            console.log(`║     🔑  ${code}  🔑        ║`);
            console.log("╚══════════════════════════════╝");
            console.log("\nواتساب ← الأجهزة المرتبطة ← ربط برقم الهاتف");
            console.log(`أدخل: ${code}  (صالح دقيقتين)\n`);
        } catch (err) {
            console.error("خطأ:", err.message);
            process.exit(1);
        }
    }

    sock.ev.on("connection.update", ({ connection, lastDisconnect }) => {
        if (connection === "open") {
            const hasKey = !!loadGroqKey();
            console.log("\n[✓] متصل بواتساب");
            console.log(`[✓] messages.txt: ${msgMap.length} رد`);
            console.log(`[✓] Llama AI: ${hasKey ? "مفعّل" : "غير مفعّل — أضف GROQ_API_KEY في .groq_key"}`);
            console.log("[✓] البوت يعمل...\n");

            if (!hasKey) {
                console.log("للحصول على مفتاح Groq مجاناً:");
                console.log("  https://console.groq.com/keys");
                console.log("  ثم احفظه في ملف .groq_key\n");
            }
        }

        if (connection === "close") {
            const code = new Boom(lastDisconnect?.error)?.output?.statusCode;
            if (code === DisconnectReason.loggedOut) {
                fs.rmSync(SESSION_DIR, { recursive: true, force: true });
                process.exit(0);
            } else {
                startBot();
            }
        }
    });

    sock.ev.on("creds.update", saveCreds);

    // ── الرسائل ───────────────────────────
    sock.ev.on("messages.upsert", async ({ messages, type }) => {
        if (type !== "notify") return;

        for (const msg of messages) {
            if (msg.key.fromMe) continue;

            const jid  = msg.key.remoteJid;
            const text =
                msg.message?.conversation ||
                msg.message?.extendedTextMessage?.text || "";

            if (!text.trim()) continue;

            let reply = null;

            // 1. messages.txt
            reply = findReply(text, msgMap);

            // 2. رياضيات
            if (!reply && isMath(text)) {
                reply = solveMath(text);
            }

            // 3. Llama AI — فقط إذا لم يُجَب
            if (!reply) {
                // إظهار "يكتب..." أثناء تفكير الـ AI
                await sock.sendPresenceUpdate("composing", jid);
                reply = await askLlama(text, jid);
            }

            if (!reply) continue; // لا رد على الإطلاق إذا فشل كل شيء

            // تأخير طبيعي بناءً على طول الرد
            const delay = humanDelay(reply.length);
            await new Promise(r => setTimeout(r, delay));

            await sock.sendPresenceUpdate("paused", jid);
            await sock.sendMessage(jid, { text: reply }, { quoted: msg });

            console.log(`[→] ${jid.split("@")[0]}: ${reply.substring(0, 60)}`);
        }
    });
}

startBot().catch(err => { console.error(err); process.exit(1); });
