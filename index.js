/**
 * WhatsApp Gateway (multi-user) - Baileys (ESM)
 * ✅ Multi-user sessions (auth state per user)
 * ✅ QR as DataURL for frontend
 * ✅ Status endpoint
 * ✅ Send message endpoint
 * ✅ Logout endpoint (delete session folder)
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
const API_KEY = process.env.API_KEY || "";

const SESSIONS_PATH = process.env.SESSIONS_PATH
    ? path.resolve(process.env.SESSIONS_PATH)
    : path.join(__dirname, "sessions");

const clients = new Map(); // userId -> { status, qrDataUrl, phone, lastError, sock, lastUsedAt }
const initLocks = new Map(); // userId -> Promise

function requireKey(req, res, next) {
    const key = req.header("X-API-Key");
    if (!API_KEY || key !== API_KEY) {
        return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    next();
}

function ensureSessionsPath() {
    fs.mkdirSync(SESSIONS_PATH, { recursive: true });
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

async function getOrCreateClient(userId) {
    const id = String(userId);
    const st = ensureState(id);
    touch(st);

    if (st.sock) return st.sock;

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

        const dir = userSessionDir(id);
        fs.mkdirSync(dir, { recursive: true });

        const { state, saveCreds } = await useMultiFileAuthState(dir);
        const { version } = await fetchLatestBaileysVersion();

        const sock = makeWASocket({
            version,
            auth: state,
            printQRInTerminal: false, // nosotros lo devolvemos al frontend
            syncFullHistory: false,
            markOnlineOnConnect: false,
        });

        st.sock = sock;

        sock.ev.on("creds.update", saveCreds);

        sock.ev.on("connection.update", async (update) => {
            const { connection, lastDisconnect, qr } = update;

            if (qr) {
                st.status = "qr";
                st.qrDataUrl = await qrcode.toDataURL(qr);
                touch(st);
            }

            if (connection === "open") {
                st.status = "ready";
                st.qrDataUrl = null;

                // Baileys: sock.user?.id ejemplo: "5358830083:12@s.whatsapp.net"
                const raw = sock.user?.id || null;
                st.phone = raw ? String(raw).split(":")[0] : null;

                touch(st);
            }

            if (connection === "close") {
                const code =
                    lastDisconnect?.error?.output?.statusCode ||
                    lastDisconnect?.error?.statusCode;

                st.status = "disconnected";
                st.qrDataUrl = null;
                st.phone = null;
                st.lastError = `disconnected: ${code || "unknown"}`;
                touch(st);

                // si se deslogueó: credenciales inválidas -> limpiar y forzar nuevo QR
                if (code === DisconnectReason.loggedOut) {
                    try {
                        fs.rmSync(dir, { recursive: true, force: true });
                    } catch (_) { }
                }

                try {
                    st.sock?.end?.();
                } catch (_) { }
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
 * 2) Get QR (polling from frontend)
 */
app.get("/sessions/:userId/qr", requireKey, async (req, res) => {
    const { userId } = req.params;
    await getOrCreateClient(userId);
    const st = ensureState(userId);

    res.json({
        ok: true,
        status: st.status,
        qr: st.qrDataUrl,
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

    if (st.status !== "ready" || !st.sock) {
        return res.status(409).json({
            ok: false,
            error: "WhatsApp not connected",
            status: st.status,
        });
    }

    try {
        const clean = String(to).replace(/\D/g, "");
        const jid = clean.includes("@s.whatsapp.net") ? clean : `${clean}@s.whatsapp.net`;

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

    // borrar sesión
    try {
        fs.rmSync(userSessionDir(id), { recursive: true, force: true });
    } catch (_) { }

    res.json({ ok: true });
});

app.listen(PORT, () => {
    console.log(`Baileys WhatsApp Gateway running on port ${PORT}`);
    console.log(`Sessions path: ${SESSIONS_PATH}`);
});
