/**
 * WhatsApp Gateway (multi-user) - Baileys (ESM) - STABLE
 *
 * ✅ Multi-user sessions: sessions/user_<USER_ID>/
 * ✅ QR as DataURL
 * ✅ Start / QR / Status / Send / Logout
 * ✅ Auto-reconnect (handles restartRequired, connectionClosed, timedOut, 515)
 * ✅ Creates the folder automatically
 *
 * ENV:
 *  - PORT=3005
 *  - API_KEY=super-secret
 *  - SESSIONS_PATH=/absolute/path/to/sessions
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import qrcode from "qrcode";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

import makeWASocket, {
    DisconnectReason,
    useMultiFileAuthState,
    fetchLatestBaileysVersion,
} from "@whiskeysockets/baileys";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(cors());
app.use(express.json());

const PORT = Number(process.env.PORT || 3005);
const API_KEY = (process.env.API_KEY || "").trim();

const SESSIONS_PATH = process.env.SESSIONS_PATH
    ? path.resolve(process.env.SESSIONS_PATH)
    : path.join(__dirname, "sessions");

// userId -> state
const clients = new Map(); // userId -> { status, qrDataUrl, phone, lastError, sock, lastUsedAt }
const initLocks = new Map(); // userId -> Promise

function requireKey(req, res, next) {
    const key = req.header("X-API-Key");
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
}

function ensureDir(dir) {
    fs.mkdirSync(dir, { recursive: true });
}

function ensureSessionsPath() {
    ensureDir(SESSIONS_PATH);
}

function userSessionDir(userId) {
    return path.join(SESSIONS_PATH, `user_${String(userId)}`);
}

function ensureState(userId) {
    const id = String(userId);
    if (!clients.has(id)) {
        clients.set(id, {
            status: "idle", // idle|starting|qr|ready|disconnected|error
            qrDataUrl: null,
            phone: null,
            lastError: null,
            sock: null,
            lastUsedAt: Date.now(),
        });
    }
    return clients.get(id);
}

function touch(st) {
    st.lastUsedAt = Date.now();
}

function normalizePhoneFromBaileysId(rawId) {
    // "5358212822:68@s.whatsapp.net" -> "5358212822"
    if (!rawId) return null;
    const s = String(rawId);
    return s.split(":")[0] || null;
}

/**
 * Decide if we should auto-reconnect
 */
function shouldReconnect(statusCode) {
    // Baileys uses DisconnectReason.*
    // 515 usually appears as "restart required" / transient.
    const retryables = new Set([
        DisconnectReason.restartRequired,
        DisconnectReason.timedOut,
        DisconnectReason.connectionClosed,
        DisconnectReason.connectionLost,
        DisconnectReason.badSession,
        DisconnectReason.multideviceMismatch,
    ]);

    return retryables.has(statusCode);
}

async function getOrCreateClient(userId) {
    const id = String(userId);
    const st = ensureState(id);
    touch(st);

    if (st.sock) return st.sock;

    // single-flight init
    if (initLocks.has(id)) {
        await initLocks.get(id);
        return ensureState(id).sock;
    }

    const initPromise = (async () => {
        ensureSessionsPath();
        st.status = "starting";
        st.qrDataUrl = null;
        st.phone = null;
        st.lastError = null;

        // ✅ create per-user auth folder
        const authDir = userSessionDir(id);
        ensureDir(authDir);

        console.log(`[AUTH] userId=${id}`);
        console.log(`[AUTH] authDir=${authDir}`);

        const { state, saveCreds } = await useMultiFileAuthState(authDir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false,
            syncFullHistory: false,
            markOnlineOnConnect: false,
            // browser identity (optional)
            // browser: Browsers.macOS("Chrome"),
        });

        st.sock = sock;

        // ✅ MUST save creds
        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                try {
                    st.status = "qr";
                    st.qrDataUrl = await qrcode.toDataURL(qr);
                    st.lastError = null;
                    touch(st);
                } catch (e) {
                    st.status = "error";
                    st.lastError = String(e?.message || e);
                    touch(st);
                }
            }

            if (connection === "open") {
                st.status = "ready";
                st.qrDataUrl = null;
                st.lastError = null;

                st.phone = normalizePhoneFromBaileysId(sock.user?.id);
                touch(st);

                console.log(`[READY] user_${id} phone=${st.phone || "-"}`);
            }

            if (connection === "close") {
                const statusCode =
                    lastDisconnect?.error?.output?.statusCode ||
                    lastDisconnect?.error?.statusCode ||
                    null;

                const reason =
                    statusCode !== null ? `code=${statusCode}` : "code=unknown";

                st.status = "disconnected";
                st.qrDataUrl = null;
                st.phone = null;
                st.lastError = `disconnected: ${reason}`;
                touch(st);

                console.log(`[DISCONNECTED] user_${id} ${reason}`);

                // ✅ LOGGED OUT => clear folder (forces fresh QR)
                if (statusCode === DisconnectReason.loggedOut) {
                    console.log(`[LOGGED_OUT] Clearing authDir: ${authDir}`);
                    try {
                        fs.rmSync(authDir, { recursive: true, force: true });
                    } catch (_) { }
                    st.sock = null;
                    return;
                }

                // ✅ retryable disconnect => reconnect after a small delay
                if (statusCode !== null && shouldReconnect(statusCode)) {
                    st.sock = null; // force new init
                    setTimeout(() => {
                        // fire-and-forget reconnect
                        getOrCreateClient(id).catch((err) => {
                            const msg = String(err?.message || err);
                            console.log(`[RECONNECT_ERROR] user_${id}: ${msg}`);
                            const st2 = ensureState(id);
                            st2.status = "error";
                            st2.lastError = msg;
                            st2.sock = null;
                        });
                    }, 1500);
                    return;
                }

                // Non-retryable => keep error
                st.sock = null;
            }
        });

        return sock;
    })();

    initLocks.set(id, initPromise);

    try {
        await initPromise;
    } finally {
        initLocks.delete(id);
    }

    return ensureState(id).sock;
}

/**
 * 1) Start session
 */
app.post("/sessions/:userId/start", requireKey, async (req, res) => {
    const { userId } = req.params;
    await getOrCreateClient(userId);
    const st = ensureState(userId);
    res.json({ ok: true, status: st.status });
});

/**
 * 2) Get QR (polling)
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
        return res.status(422).json({
            ok: false,
            error: "to and message are required",
        });
    }

    await getOrCreateClient(userId);
    const st = ensureState(userId);
    touch(st);

    if (st.status !== "ready" || !st.sock) {
        return res.status(409).json({
            ok: false,
            error: "WhatsApp not connected",
            status: st.status,
            detail: st.lastError,
        });
    }

    try {
        const clean = String(to).replace(/\D/g, "");
        const jid = clean.includes("@s.whatsapp.net")
            ? clean
            : `${clean}@s.whatsapp.net`;

        await st.sock.sendMessage(jid, { text: String(message) });
        res.json({ ok: true });
    } catch (e) {
        res.status(500).json({ ok: false, error: String(e?.message || e) });
    }
});

/**
 * 5) Logout (delete session folder to force new QR)
 */
app.post("/sessions/:userId/logout", requireKey, async (req, res) => {
    const { userId } = req.params;
    const id = String(userId);
    const st = ensureState(id);

    try {
        st.sock?.end?.();
    } catch (_) { }

    st.sock = null;
    st.status = "idle";
    st.qrDataUrl = null;
    st.phone = null;
    st.lastError = null;
    touch(st);

    // delete user folder => new QR next time
    try {
        fs.rmSync(userSessionDir(id), { recursive: true, force: true });
    } catch (_) { }

    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`Baileys WhatsApp Gateway running on port ${PORT}`);
    console.log(`Sessions path: ${SESSIONS_PATH}`);
});
