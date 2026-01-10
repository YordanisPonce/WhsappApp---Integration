/**
 * WhatsApp Gateway (multi-user) - PRO + STABLE
 *
 * ✅ Multi-user via LocalAuth(clientId=user_<id>)
 * ✅ QR as DataURL for frontend
 * ✅ Per-user init lock (prevents double init under polling)
 * ✅ Auto-recover from "browser already running" (kills stray chromium + clears lockfiles + retries once)
 * ✅ Graceful shutdown (SIGTERM/SIGINT) to avoid zombie chromium
 * ✅ Idle TTL (auto-destroy inactive clients to keep RAM stable for 10–50 users)
 *
 * ENV:
 *  - PORT=3005
 *  - API_KEY=super-secret
 *  - SESSIONS_PATH=/absolute/path/to/sessions   (recommended)
 *  - CHROME_BIN=/usr/bin/chromium-browser       (optional; only used if exists)
 *  - IDLE_TTL_MINUTES=15                        (optional; default 15)
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3005);
const API_KEY = process.env.API_KEY || "";

// Prefer absolute sessions path for stability
const SESSIONS_PATH = process.env.SESSIONS_PATH
    ? path.resolve(process.env.SESSIONS_PATH)
    : path.join(__dirname, "sessions");

// Optional Chrome path
const CHROME_BIN = (process.env.CHROME_BIN || "").trim();

// Idle TTL to avoid keeping 50 chromiums always alive
const IDLE_TTL_MINUTES = Number(process.env.IDLE_TTL_MINUTES || 15);
const IDLE_TTL_MS = Math.max(1, IDLE_TTL_MINUTES) * 60 * 1000;

// userId -> state
const clients = new Map(); // userId -> { status, qrDataUrl, phone, lastError, client, lastUsedAt }
// userId -> init promise (single-flight)
const initLocks = new Map();

function requireKey(req, res, next) {
    const key = req.header("X-API-Key");
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
}

function ensureSessionsPath() {
    try {
        fs.mkdirSync(SESSIONS_PATH, { recursive: true });
    } catch (e) {
        console.error("[SESSIONS_PATH] cannot create:", SESSIONS_PATH, e?.message || e);
    }
}

function ensureState(userId) {
    const id = String(userId);
    if (!clients.has(id)) {
        clients.set(id, {
            status: "idle", // idle|starting|qr|ready|disconnected|error
            qrDataUrl: null,
            phone: null,
            lastError: null,
            client: null,
            lastUsedAt: Date.now(),
        });
    }
    return clients.get(id);
}

function touch(st) {
    st.lastUsedAt = Date.now();
}

function buildPuppeteerOpts() {
    const puppeteerOpts = {
        headless: "new", // tends to be more stable on modern chromium
        args: [
            "--no-sandbox",
            "--disable-setuid-sandbox",
            "--disable-dev-shm-usage",
            "--disable-gpu",
        ],
    };

    if (CHROME_BIN.length > 0) {
        if (fs.existsSync(CHROME_BIN)) {
            puppeteerOpts.executablePath = CHROME_BIN;
        } else {
            console.warn(`[CHROME_BIN] not found: ${CHROME_BIN}. Using default browser.`);
        }
    }

    return puppeteerOpts;
}

function extractAlreadyRunningDir(msg) {
    // "The browser is already running for /path/session-user_71. Use a different `userDataDir` ..."
    const m = String(msg).match(/already running for (.*)\. Use a different/);
    return m?.[1]?.trim() || null;
}

function cleanupChromeProfileDir(dir) {
    if (!dir) return;

    // 1) Kill any stray chromium that references this profile dir
    try {
        execSync(`pkill -f "${dir.replace(/"/g, '\\"')}" || true`, { stdio: "ignore" });
    } catch (_) { }

    // 2) Remove common lock files that can remain even when process is gone
    const lockFiles = ["SingletonLock", "SingletonSocket", "SingletonCookie", "DevToolsActivePort"];
    for (const f of lockFiles) {
        try {
            fs.rmSync(path.join(dir, f), { force: true });
        } catch (_) { }
    }
}

/**
 * Create or return a Client for userId.
 * - per-user init lock prevents double init
 * - auto-recovery from "already running"
 */
async function getOrCreateClient(userId) {
    const id = String(userId);
    const state = ensureState(id);
    touch(state);

    if (state.client) return state.client;

    // If another request is initializing this user, wait for it
    if (initLocks.has(id)) {
        await initLocks.get(id);
        return ensureState(id).client;
    }

    const initPromise = (async () => {
        ensureSessionsPath();

        state.status = "starting";
        state.qrDataUrl = null;
        state.phone = null;
        state.lastError = null;

        const puppeteerOpts = buildPuppeteerOpts();

        const client = new Client({
            authStrategy: new LocalAuth({
                clientId: `user_${id}`,
                dataPath: SESSIONS_PATH,
            }),
            puppeteer: puppeteerOpts,
        });

        client.on("qr", async (qr) => {
            try {
                state.status = "qr";
                state.qrDataUrl = await qrcode.toDataURL(qr);
                touch(state);
            } catch (e) {
                state.status = "error";
                state.lastError = String(e?.message || e);
            }
        });

        client.on("ready", async () => {
            state.status = "ready";
            state.qrDataUrl = null;
            touch(state);

            try {
                // try a couple of fields depending on lib versions
                const wid = client.info?.wid;
                state.phone =
                    (wid && (wid.user || wid._serialized)) ||
                    client.info?.me?.user ||
                    null;

                if (state.phone && String(state.phone).includes("@")) {
                    // normalize: "5358830083@c.us" -> "5358830083"
                    state.phone = String(state.phone).split("@")[0];
                }
            } catch (_) { }
        });

        client.on("auth_failure", (msg) => {
            state.status = "error";
            state.lastError = `auth_failure: ${msg}`;
        });

        client.on("disconnected", async (reason) => {
            state.status = "disconnected";
            state.qrDataUrl = null;
            state.phone = null;
            state.lastError = `disconnected: ${reason}`;
            touch(state);

            try { await Promise.resolve(client.destroy()); } catch (_) { }
            state.client = null; // force re-init (new QR)
        });

        state.client = client;

        // Initialize with auto-recovery if profile is locked
        try {
            await Promise.resolve(client.initialize());
        } catch (e) {
            const msg = String(e?.message || e);
            console.error(`[INIT ERROR] user_${id}:`, msg);

            if (msg.includes("already running for")) {
                const dir = extractAlreadyRunningDir(msg);
                cleanupChromeProfileDir(dir);

                // Retry once
                try {
                    await Promise.resolve(client.initialize());
                    return;
                } catch (e2) {
                    const msg2 = String(e2?.message || e2);
                    console.error(`[INIT ERROR RETRY] user_${id}:`, msg2);

                    state.status = "error";
                    state.lastError = msg2;

                    try { await Promise.resolve(client.destroy()); } catch (_) { }
                    state.client = null;
                    return;
                }
            }

            state.status = "error";
            state.lastError = msg;

            try { await Promise.resolve(client.destroy()); } catch (_) { }
            state.client = null;
        }
    })();

    initLocks.set(id, initPromise);

    try {
        await initPromise;
    } finally {
        initLocks.delete(id);
    }

    return ensureState(id).client;
}

/**
 * 1) Start / ensure session
 */
app.post("/sessions/:userId/start", requireKey, async (req, res) => {
    const { userId } = req.params;
    await getOrCreateClient(userId);
    const st = ensureState(userId);
    res.json({ ok: true, status: st.status });
});

/**
 * 2) Get QR (DataURL) for frontend
 */
app.get("/sessions/:userId/qr", requireKey, async (req, res) => {
    const { userId } = req.params;

    console.log("[QR request] userId =", userId);

    await getOrCreateClient(userId);
    const st = ensureState(userId);

    res.json({
        ok: true,
        status: st.status,
        qr: st.qrDataUrl, // data:image/png;base64,...
        phone: st.phone,
        error: st.lastError,
    });
});

/**
 * 3) Status
 */
app.get("/sessions/:userId/status", requireKey, async (req, res) => {
    const { userId } = req.params;
    const st = ensureState(userId);
    touch(st);

    res.json({
        ok: true,
        status: st.status,
        phone: st.phone,
        error: st.lastError,
    });
});

/**
 * 4) Send message
 * body: { to: "5355555555", message: "hola" }
 */
app.post("/sessions/:userId/send", requireKey, async (req, res) => {
    const { userId } = req.params;
    const { to, message } = req.body || {};

    if (!to || !message) {
        return res.status(422).json({ ok: false, error: "to and message are required" });
    }

    await getOrCreateClient(userId);
    const st = ensureState(userId);
    touch(st);

    if (st.status !== "ready" || !st.client) {
        return res.status(409).json({
            ok: false,
            error: "WhatsApp not connected",
            status: st.status,
        });
    }

    try {
        const chatId = String(to).includes("@c.us")
            ? String(to)
            : `${String(to).replace(/\D/g, "")}@c.us`;

        await st.client.sendMessage(chatId, String(message));
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

/**
 * 5) Logout (force new QR)
 */
app.post("/sessions/:userId/logout", requireKey, async (req, res) => {
    const { userId } = req.params;
    const st = ensureState(userId);

    try { if (st.client) await Promise.resolve(st.client.logout()); } catch (_) { }
    try { if (st.client) await Promise.resolve(st.client.destroy()); } catch (_) { }

    st.client = null;
    st.status = "idle";
    st.qrDataUrl = null;
    st.phone = null;
    st.lastError = null;
    touch(st);

    res.json({ ok: true });
});

/**
 * Background sweep: destroy inactive clients to keep server stable
 * - Keeps auth data on disk, so next init restores without QR (if session still valid)
 */
setInterval(async () => {
    const now = Date.now();

    for (const [userId, st] of clients.entries()) {
        if (!st?.client) continue;
        if (st.status !== "ready") continue;

        const idleMs = now - (st.lastUsedAt || now);
        if (idleMs < IDLE_TTL_MS) continue;

        console.log(`[TTL] Destroying inactive client user_${userId} (idle ${Math.round(idleMs / 1000)}s)`);

        try { await Promise.resolve(st.client.destroy()); } catch (_) { }
        st.client = null;
        st.status = "idle";
        st.qrDataUrl = null;
        // Keep phone if you want; I reset it to be accurate after reconnect
        st.phone = null;
        st.lastError = null;
    }
}, 60 * 1000);

app.listen(PORT, () => {
    console.log(`WhatsApp Gateway running on port ${PORT}`);
    console.log(`Sessions path: ${SESSIONS_PATH}`);
    console.log(`Idle TTL: ${IDLE_TTL_MINUTES} minutes`);
});

async function shutdown() {
    console.log("Shutting down...");

    for (const st of clients.values()) {
        if (st?.client) {
            try { await Promise.resolve(st.client.destroy()); } catch (_) { }
            st.client = null;
        }
    }

    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
