/**
 * WhatsApp Gateway (multi-user) - PRO version
 * - Per-user sessions via LocalAuth(clientId=user_<id>)
 * - QR returned as DataURL for frontend
 * - Safe CHROME_BIN handling (only if file exists)
 * - Absolute sessions path (stable across cwd)
 * - Per-user init lock to avoid double initialization under polling/concurrency
 */

require("dotenv").config();

const express = require("express");
const cors = require("cors");
const qrcode = require("qrcode");
const fs = require("fs");
const path = require("path");
const { Client, LocalAuth } = require("whatsapp-web.js");

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3005);
const API_KEY = process.env.API_KEY || "";

// Always prefer absolute sessions path for stability
const SESSIONS_PATH = process.env.SESSIONS_PATH
    ? path.resolve(process.env.SESSIONS_PATH)
    : path.join(__dirname, "sessions");

// Optional: set Chrome path (Windows/Linux). We'll verify it exists.
const CHROME_BIN = (process.env.CHROME_BIN || "").trim();

const clients = new Map();    // userId -> { status, qrDataUrl, phone, lastError, client }
const initLocks = new Map();  // userId -> Promise (single-flight lock)

function requireKey(req, res, next) {
    const key = req.header("X-API-Key");
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
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
        });
    }
    return clients.get(id);
}

function buildPuppeteerOpts() {
    const puppeteerOpts = {
        headless: true, // for debugging you can set false
        // headless: "new", // try this if headless:true gives trouble in your environment
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
            console.warn(`CHROME_BIN not found: ${CHROME_BIN}. Using default browser.`);
        }
    }

    return puppeteerOpts;
}

/**
 * Create or return a Client for the user, with a per-user init lock
 * so polling doesn't spawn multiple clients.
 */
async function getOrCreateClient(userId) {
    const id = String(userId);
    const state = ensureState(id);

    // Already created (even if not ready yet)
    if (state.client) return state.client;

    // Single-flight lock: if another request is initializing, wait for it.
    if (initLocks.has(id)) {
        await initLocks.get(id);
        return ensureState(id).client;
    }

    const initPromise = (async () => {
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
            } catch (e) {
                state.status = "error";
                state.lastError = String(e?.message || e);
            }
        });

        client.on("ready", async () => {
            state.status = "ready";
            state.qrDataUrl = null;
            try {
                const me = client.info?.wid?.user; // number without +
                state.phone = me ? String(me) : null;
            } catch (_) { }
        });

        client.on("authenticated", () => {
            // Sometimes emitted before "ready"
            // You could set state.status = "authenticated" if you want
        });

        client.on("auth_failure", (msg) => {
            state.status = "error";
            state.lastError = `auth_failure: ${msg}`;
        });

        client.on("disconnected", (reason) => {
            state.status = "disconnected";
            state.qrDataUrl = null;
            state.phone = null;
            state.lastError = `disconnected: ${reason}`;

            try { client.destroy(); } catch (_) { }
            state.client = null; // force re-init -> new QR
        });

        state.client = client;

        try {
            // initialize kicks off puppeteer + session restore (async)
            await Promise.resolve(client.initialize());
        } catch (e) {
            const msg = String(e?.message || e);

            state.status = "error";
            state.lastError = msg;

            // si el error es "browser already running", NO revientes el proceso.
            // libera el client para que en el próximo poll se reintente.
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
 * 1) Start/ensure session
 */
app.post("/sessions/:userId/start", requireKey, async (req, res) => {
    const { userId } = req.params;
    await getOrCreateClient(userId);
    const st = ensureState(userId);
    res.json({ ok: true, status: st.status });
});

/**
 * 2) Get QR (DataURL) for frontend
 *    Frontend polls until status === "ready"
 */
app.get("/sessions/:userId/qr", requireKey, async (req, res) => {
    const { userId } = req.params;
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

    try {
        if (st.client) await st.client.logout();
    } catch (_) { }

    try {
        if (st.client) await st.client.destroy();
    } catch (_) { }

    st.client = null;
    st.status = "idle";
    st.qrDataUrl = null;
    st.phone = null;
    st.lastError = null;

    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`WhatsApp Gateway running on port ${PORT}`);
    console.log(`Sessions path: ${SESSIONS_PATH}`);
});

async function shutdown() {
    console.log("Shutting down...");

    for (const [userId, st] of clients.entries()) {
        if (st?.client) {
            try { await Promise.resolve(st.client.destroy()); } catch (_) { }
            st.client = null;
        }
    }

    process.exit(0);
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
