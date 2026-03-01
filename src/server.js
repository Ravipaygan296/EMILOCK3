require('dotenv').config();
const express    = require('express');
const helmet     = require('helmet');
const cors       = require('cors');
const rateLimit  = require('express-rate-limit');
const { Pool }   = require('pg');
const admin      = require('firebase-admin');
const bcrypt     = require('bcryptjs');
const jwt        = require('jsonwebtoken');
const cloudinary = require('cloudinary').v2;
const nodemailer = require('nodemailer');
const cron       = require('node-cron');

const app  = express();
const PORT = process.env.PORT || 3000;

// ════════════════════════════════════════════════════════════════
//  MIDDLEWARE
// ════════════════════════════════════════════════════════════════
app.use(helmet());
app.use(cors());
app.use(express.json({ limit: '10mb' }));

const limiter     = rateLimit({ windowMs: 15 * 60 * 1000, max: 100 });
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, max: 20  });
app.use('/api/', limiter);
app.use('/api/admin/login', authLimiter);

// ════════════════════════════════════════════════════════════════
//  DATABASE — Supabase PostgreSQL
// ════════════════════════════════════════════════════════════════
const db = new Pool({
    connectionString:        process.env.DATABASE_URL,
    ssl:                     { rejectUnauthorized: false },
    max:                     10,
    idleTimeoutMillis:       30000,
    connectionTimeoutMillis: 2000
});

db.connect()
    .then(client => { console.log('✅ Database connected'); client.release(); })
    .catch(e     => console.error('❌ Database error:', e.message));

// ════════════════════════════════════════════════════════════════
//  FIREBASE — FCM Push Notifications
//
//  ✅ FIXED — No firebase-service-account.json file needed
//
//  HOW TO SET UP ON RENDER:
//  1. Open your firebase-service-account.json file
//  2. Copy ALL the contents
//  3. Go to Render → Your Service → Environment
//  4. Add new variable:
//     Key:   FIREBASE_SERVICE_ACCOUNT
//     Value: paste the entire JSON here
//  5. Save — Done!
// ════════════════════════════════════════════════════════════════
let firebaseReady = false;

try {
    let firebaseConfig;

    if (process.env.FIREBASE_SERVICE_ACCOUNT) {
        // ✅ Running on Render — reads from environment variable
        firebaseConfig = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
        console.log('✅ Firebase loaded from environment variable');
    } else {
        // Running locally — reads from file (for your PC only)
        firebaseConfig = require('../firebase-service-account.json');
        console.log('✅ Firebase loaded from local file');
    }

    admin.initializeApp({ credential: admin.credential.cert(firebaseConfig) });
    firebaseReady = true;
    console.log('✅ Firebase ready');

} catch (e) {
    console.error('❌ Firebase failed:', e.message);
    console.error('   → On Render: Add FIREBASE_SERVICE_ACCOUNT environment variable');
    console.error('   → Locally: Make sure firebase-service-account.json exists');
}

// ════════════════════════════════════════════════════════════════
//  CLOUDINARY — Tamper Photo Storage (Free 25GB)
// ════════════════════════════════════════════════════════════════
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_NAME,
    api_key:    process.env.CLOUDINARY_KEY,
    api_secret: process.env.CLOUDINARY_SECRET
});

// ════════════════════════════════════════════════════════════════
//  EMAIL — Gmail SMTP
// ════════════════════════════════════════════════════════════════
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SMTP_USER,  // your@gmail.com
        pass: process.env.SMTP_PASS   // 16-char App Password from Google
    }
});

// ════════════════════════════════════════════════════════════════
//  HELPER FUNCTIONS
// ════════════════════════════════════════════════════════════════

// --- Verify Admin JWT (Dashboard login) ---
const verifyAdminToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        req.admin = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// --- Verify Device JWT (Android app) ---
const verifyDeviceToken = (req, res, next) => {
    const token = req.headers.authorization?.split(' ')[1];
    if (!token) return res.status(401).json({ error: 'No token provided' });
    try {
        req.device = jwt.verify(token, process.env.JWT_SECRET);
        next();
    } catch {
        res.status(401).json({ error: 'Invalid or expired token' });
    }
};

// --- Send FCM Push to Android Device ---
const sendFCM = async (fcmToken, data) => {
    if (!firebaseReady) { console.warn('⚠️ FCM skipped — Firebase not ready'); return false; }
    try {
        await admin.messaging().send({
            token:   fcmToken,
            data:    data,
            android: { priority: 'high', ttl: 60000 }
        });
        console.log('📡 FCM sent:', data.command);
        return true;
    } catch (e) {
        console.error('❌ FCM error:', e.message);
        return false;
    }
};

// --- Send Email Alert to Lender ---
const sendEmail = async (to, subject, html) => {
    try {
        await transporter.sendMail({ from: `EMI Lock <${process.env.SMTP_USER}>`, to, subject, html });
        console.log('📧 Email sent to:', to);
        return true;
    } catch (e) {
        console.error('❌ Email error:', e.message);
        return false;
    }
};

// --- Upload Tamper Photo to Cloudinary ---
const savePhoto = async (base64Photo, deviceId) => {
    try {
        const result = await cloudinary.uploader.upload(
            `data:image/jpeg;base64,${base64Photo}`,
            { folder: 'emi-lock-tamper', public_id: `${deviceId}_${Date.now()}`, transformation: [{ width: 800, crop: 'limit' }] }
        );
        console.log('📸 Photo saved:', result.secure_url);
        return result.secure_url;
    } catch (e) {
        console.error('❌ Photo error:', e.message);
        return null;
    }
};

// --- Build Tamper Alert Email HTML ---
const tamperEmailHTML = ({ deviceId, borrowerName, borrowerPhone, eventType, tamperCount, latitude, longitude, photoUrl, batteryLevel }) => {
    const mapsLink  = latitude ? `https://maps.google.com/?q=${latitude},${longitude}` : null;
    const warnText  = tamperCount >= 4 ? '💀 AUTO WIPE ORDERED!'
                    : tamperCount >= 3 ? '🚨 CRITICAL — Next tamper = auto wipe!'
                    : tamperCount >= 2 ? '⚠️ WARNING — Multiple attempts'
                    : '🔔 Tamper detected';
    const warnBg    = tamperCount >= 3 ? '#7f1d1d' : '#fef2f2';
    const warnColor = tamperCount >= 3 ? 'white'   : '#dc2626';

    return `<div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
        <div style="background:#dc2626;padding:24px;text-align:center">
            <h1 style="color:white;margin:0">⚠️ TAMPER ALERT — EMI Lock</h1>
        </div>
        <div style="padding:24px;background:#f9fafb">
            <div style="background:${warnBg};border:1px solid #fca5a5;border-radius:8px;padding:16px;margin-bottom:20px;text-align:center">
                <p style="color:${warnColor};font-weight:bold;margin:0;font-size:16px">${warnText}</p>
                <p style="color:${tamperCount >= 3 ? '#fca5a5' : '#991b1b'};margin:8px 0 0">Attempt ${tamperCount} of 4</p>
            </div>
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;border:1px solid #e5e7eb">
                <tr style="background:#f3f4f6"><td style="padding:12px;font-weight:bold;color:#374151;width:40%">Device ID</td><td style="padding:12px;font-family:monospace">${deviceId}</td></tr>
                <tr><td style="padding:12px;font-weight:bold;color:#374151">Borrower</td><td style="padding:12px">${borrowerName}</td></tr>
                <tr style="background:#f3f4f6"><td style="padding:12px;font-weight:bold;color:#374151">Phone</td><td style="padding:12px">${borrowerPhone}</td></tr>
                <tr><td style="padding:12px;font-weight:bold;color:#374151">Event</td><td style="padding:12px;color:#dc2626;font-weight:bold">${eventType}</td></tr>
                <tr style="background:#f3f4f6"><td style="padding:12px;font-weight:bold;color:#374151">Tamper Count</td><td style="padding:12px;color:#dc2626;font-weight:bold">${tamperCount} / 4</td></tr>
                <tr><td style="padding:12px;font-weight:bold;color:#374151">GPS</td><td style="padding:12px">${mapsLink ? `<a href="${mapsLink}">${latitude}, ${longitude}</a>` : 'Not available'}</td></tr>
                <tr style="background:#f3f4f6"><td style="padding:12px;font-weight:bold;color:#374151">Battery</td><td style="padding:12px">${batteryLevel || '?'}%</td></tr>
                <tr><td style="padding:12px;font-weight:bold;color:#374151">Time (IST)</td><td style="padding:12px">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td></tr>
            </table>
            ${photoUrl ? `<div style="margin-top:20px;background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
                <p style="font-weight:bold;color:#374151;margin:0 0 12px">📸 Tamper Photo</p>
                <img src="${photoUrl}" style="max-width:100%;border-radius:8px;border:2px solid #dc2626"/>
                <p style="margin:8px 0 0"><a href="${photoUrl}" style="color:#2563eb">View full photo →</a></p>
            </div>` : ''}
            ${mapsLink ? `<div style="margin-top:16px;text-align:center">
                <a href="${mapsLink}" style="background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">📍 Open in Google Maps</a>
            </div>` : ''}
        </div>
        <div style="background:#1f2937;padding:16px;text-align:center">
            <p style="color:#9ca3af;margin:0;font-size:12px">EMI Lock Security System — Automated Alert</p>
        </div>
    </div>`;
};

// ════════════════════════════════════════════════════════════════
//  HEALTH CHECK — Tests server is running
// ════════════════════════════════════════════════════════════════
app.get('/api/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date(), firebase: firebaseReady, message: 'EMI Lock Backend ✅' });
});

// ════════════════════════════════════════════════════════════════
//  DEVICE APIs — Called by Android App on customer phones
// ════════════════════════════════════════════════════════════════

// ── 1. REGISTER DEVICE ───────────────────────────────────────────
app.post('/api/register-device', async (req, res) => {
    try {
        const { device_id, device_model, android_version, imei, sim_serial, fcm_token, phone_number } = req.body;
        if (!device_id) return res.status(400).json({ error: 'device_id required' });

        const existing = await db.query('SELECT * FROM devices WHERE device_id=$1', [device_id]);

        if (existing.rows.length > 0) {
            await db.query('UPDATE devices SET fcm_token=$1, last_seen=NOW() WHERE device_id=$2', [fcm_token, device_id]);
            const token = jwt.sign({ device_id }, process.env.JWT_SECRET, { expiresIn: '365d' });
            return res.json({ success: true, token, is_locked: existing.rows[0].is_locked, wipe_ordered: existing.rows[0].wipe_ordered });
        }

        await db.query(
            'INSERT INTO devices (device_id,device_model,android_version,imei,sim_serial,fcm_token,phone_number,last_seen) VALUES ($1,$2,$3,$4,$5,$6,$7,NOW())',
            [device_id, device_model, android_version, imei, sim_serial, fcm_token, phone_number]
        );

        const token = jwt.sign({ device_id }, process.env.JWT_SECRET, { expiresIn: '365d' });
        res.json({ success: true, token, is_locked: false });

    } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// ── 2. GET DEVICE STATUS ──────────────────────────────────────────
app.get('/api/device-status/:deviceId', verifyDeviceToken, async (req, res) => {
    try {
        const { deviceId } = req.params;
        const device = await db.query('SELECT * FROM devices WHERE device_id=$1', [deviceId]);
        if (!device.rows.length) return res.status(404).json({ error: 'Device not found' });

        const loan = await db.query('SELECT * FROM loans WHERE device_id=$1 AND is_active=TRUE ORDER BY created_at DESC LIMIT 1', [deviceId]);
        await db.query('UPDATE devices SET last_seen=NOW() WHERE device_id=$1', [deviceId]);

        res.json({ is_locked: device.rows[0].is_locked, wipe_ordered: device.rows[0].wipe_ordered, tamper_count: device.rows[0].tamper_count, loan: loan.rows[0] || null });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 3. TAMPER ALERT ───────────────────────────────────────────────
app.post('/api/tamper-alert', verifyDeviceToken, async (req, res) => {
    try {
        const { device_id, event_type, latitude, longitude, photo_base64, sim_serial, battery_level } = req.body;

        let photo_url = null;
        if (photo_base64) photo_url = await savePhoto(photo_base64, device_id);

        const deviceResult = await db.query(
            'UPDATE devices SET tamper_count=tamper_count+1, last_location_lat=$1, last_location_lng=$2, battery_level=$3, last_seen=NOW() WHERE device_id=$4 RETURNING *',
            [latitude, longitude, battery_level, device_id]
        );
        const tamperCount = deviceResult.rows[0]?.tamper_count || 1;

        await db.query(
            'INSERT INTO tamper_events (device_id,event_type,tamper_count,latitude,longitude,photo_url,sim_serial,battery_level) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
            [device_id, event_type, tamperCount, latitude, longitude, photo_url, sim_serial, battery_level]
        );

        const loanResult = await db.query(
            'SELECT l.*, a.email AS admin_email FROM loans l JOIN admins a ON l.admin_id=a.id WHERE l.device_id=$1 AND l.is_active=TRUE LIMIT 1',
            [device_id]
        );

        if (loanResult.rows.length > 0) {
            const l = loanResult.rows[0];
            await sendEmail(
                l.admin_email,
                `🚨 Tamper Alert: ${l.borrower_name} — ${event_type} (Attempt ${tamperCount})`,
                tamperEmailHTML({ deviceId: device_id, borrowerName: l.borrower_name, borrowerPhone: l.borrower_phone, eventType: event_type, tamperCount, latitude, longitude, photoUrl: photo_url, batteryLevel: battery_level })
            );
        }

        if (tamperCount >= 4) await db.query('UPDATE devices SET wipe_ordered=TRUE WHERE device_id=$1', [device_id]);

        res.json({ success: true, tamper_count: tamperCount, wipe_ordered: tamperCount >= 4 });

    } catch (e) { console.error(e.message); res.status(500).json({ error: e.message }); }
});

// ── 4. VERIFY OTP ─────────────────────────────────────────────────
app.post('/api/verify-otp', verifyDeviceToken, async (req, res) => {
    try {
        const { device_id, otp } = req.body;

        const otpRecord = await db.query(
            'SELECT * FROM otp_tokens WHERE device_id=$1 AND otp=$2 AND is_used=FALSE AND expires_at>NOW() ORDER BY created_at DESC LIMIT 1',
            [device_id, otp]
        );

        if (!otpRecord.rows.length) {
            await db.query('UPDATE devices SET otp_fail_count=otp_fail_count+1 WHERE device_id=$1', [device_id]);
            return res.status(400).json({ error: 'Invalid or expired OTP' });
        }

        await db.query('UPDATE otp_tokens SET is_used=TRUE, used_at=NOW() WHERE id=$1', [otpRecord.rows[0].id]);
        await db.query('UPDATE devices SET is_locked=FALSE, otp_fail_count=0 WHERE device_id=$1', [device_id]);

        res.json({ success: true, duration_hours: otpRecord.rows[0].temp_duration_hours });

    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. UPDATE FCM TOKEN ───────────────────────────────────────────
app.post('/api/update-fcm-token', verifyDeviceToken, async (req, res) => {
    try {
        const { device_id, fcm_token } = req.body;
        await db.query('UPDATE devices SET fcm_token=$1, last_seen=NOW() WHERE device_id=$2', [fcm_token, device_id]);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 6. DEVICE HEARTBEAT PING ──────────────────────────────────────
app.post('/api/device-ping', verifyDeviceToken, async (req, res) => {
    try {
        const { device_id, battery_level, latitude, longitude } = req.body;
        await db.query('UPDATE devices SET last_seen=NOW(), battery_level=$1, last_location_lat=$2, last_location_lng=$3 WHERE device_id=$4', [battery_level, latitude, longitude, device_id]);
        const device = await db.query('SELECT is_locked, wipe_ordered FROM devices WHERE device_id=$1', [device_id]);
        res.json({ success: true, is_locked: device.rows[0]?.is_locked, wipe_ordered: device.rows[0]?.wipe_ordered });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  ADMIN APIs — Called by Web Dashboard
// ════════════════════════════════════════════════════════════════

// ── 1. ADMIN LOGIN ────────────────────────────────────────────────
app.post('/api/admin/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        const result = await db.query('SELECT * FROM admins WHERE email=$1 AND is_active=TRUE', [email]);
        if (!result.rows.length) return res.status(401).json({ error: 'Invalid email or password' });

        const adminUser = result.rows[0];
        const valid = await bcrypt.compare(password, adminUser.password_hash);
        if (!valid) return res.status(401).json({ error: 'Invalid email or password' });

        await db.query('UPDATE admins SET last_login=NOW() WHERE id=$1', [adminUser.id]);
        const token = jwt.sign({ admin_id: adminUser.id, email: adminUser.email }, process.env.JWT_SECRET, { expiresIn: '24h' });

        res.json({ success: true, token, admin: { name: adminUser.name, email: adminUser.email, company_name: adminUser.company_name, plan_name: adminUser.plan_name, max_devices: adminUser.max_devices } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 2. GET ALL DEVICES ────────────────────────────────────────────
app.get('/api/admin/devices', verifyAdminToken, async (req, res) => {
    try {
        const { page = 1, search = '', status = '' } = req.query;
        const offset = (page - 1) * 20;
        const params = [req.admin.admin_id];

        let query = `SELECT d.*, l.borrower_name, l.borrower_phone, l.emi_amount, l.due_date, l.due_amount, l.paid_emis, l.total_emis
            FROM devices d LEFT JOIN loans l ON d.device_id=l.device_id AND l.is_active=TRUE WHERE d.admin_id=$1`;

        if (search) { params.push(`%${search}%`); query += ` AND (d.device_id ILIKE $${params.length} OR l.borrower_name ILIKE $${params.length} OR l.borrower_phone ILIKE $${params.length})`; }
        if (status === 'locked')   query += ` AND d.is_locked=TRUE`;
        if (status === 'unlocked') query += ` AND d.is_locked=FALSE`;
        if (status === 'tampered') query += ` AND d.tamper_count>0`;

        params.push(20, offset);
        query += ` ORDER BY d.enrolled_at DESC LIMIT $${params.length - 1} OFFSET $${params.length}`;

        const result      = await db.query(query, params);
        const countResult = await db.query('SELECT COUNT(*) FROM devices WHERE admin_id=$1', [req.admin.admin_id]);

        res.json({ devices: result.rows, total: parseInt(countResult.rows[0].count), page: parseInt(page) });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 3. REMOTE LOCK ────────────────────────────────────────────────
app.post('/api/admin/lock', verifyAdminToken, async (req, res) => {
    try {
        const { device_id, reason } = req.body;
        await db.query('UPDATE devices SET is_locked=TRUE WHERE device_id=$1', [device_id]);

        const device   = await db.query('SELECT fcm_token FROM devices WHERE device_id=$1', [device_id]);
        const fcm_sent = device.rows[0]?.fcm_token ? await sendFCM(device.rows[0].fcm_token, { command: 'LOCK', reason: reason || 'EMI overdue' }) : false;

        await db.query('INSERT INTO admin_actions (admin_id,device_id,action,reason) VALUES ($1,$2,$3,$4)', [req.admin.admin_id, device_id, 'LOCK', reason]);
        res.json({ success: true, fcm_sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 4. REMOTE UNLOCK ──────────────────────────────────────────────
app.post('/api/admin/unlock', verifyAdminToken, async (req, res) => {
    try {
        const { device_id, reason } = req.body;
        await db.query('UPDATE devices SET is_locked=FALSE WHERE device_id=$1', [device_id]);

        const device   = await db.query('SELECT fcm_token FROM devices WHERE device_id=$1', [device_id]);
        const fcm_sent = device.rows[0]?.fcm_token ? await sendFCM(device.rows[0].fcm_token, { command: 'UNLOCK', reason: reason || 'Payment received' }) : false;

        await db.query('INSERT INTO admin_actions (admin_id,device_id,action,reason) VALUES ($1,$2,$3,$4)', [req.admin.admin_id, device_id, 'UNLOCK', reason]);
        res.json({ success: true, fcm_sent });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 5. GENERATE OTP ───────────────────────────────────────────────
app.post('/api/admin/generate-otp', verifyAdminToken, async (req, res) => {
    try {
        const { device_id, duration_hours = 4 } = req.body;
        const otp     = Math.floor(100000 + Math.random() * 900000).toString();
        const expires = new Date(Date.now() + 60 * 60 * 1000);

        await db.query('INSERT INTO otp_tokens (device_id,admin_id,otp,temp_duration_hours,expires_at) VALUES ($1,$2,$3,$4,$5)', [device_id, req.admin.admin_id, otp, duration_hours, expires]);
        await db.query('INSERT INTO admin_actions (admin_id,device_id,action) VALUES ($1,$2,$3)', [req.admin.admin_id, device_id, 'GENERATE_OTP']);

        res.json({ success: true, otp, duration_hours, expires_at: expires });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 6. REMOTE WIPE ────────────────────────────────────────────────
app.post('/api/admin/remote-wipe', verifyAdminToken, async (req, res) => {
    try {
        const { device_id, confirmation } = req.body;
        if (confirmation !== 'WIPE_CONFIRMED') return res.status(400).json({ error: 'Type WIPE_CONFIRMED to confirm' });

        await db.query('UPDATE devices SET wipe_ordered=TRUE, is_locked=TRUE WHERE device_id=$1', [device_id]);
        const device = await db.query('SELECT fcm_token FROM devices WHERE device_id=$1', [device_id]);
        if (device.rows[0]?.fcm_token) await sendFCM(device.rows[0].fcm_token, { command: 'WIPE' });

        await db.query('INSERT INTO admin_actions (admin_id,device_id,action) VALUES ($1,$2,$3)', [req.admin.admin_id, device_id, 'REMOTE_WIPE']);
        res.json({ success: true });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 7. DASHBOARD STATS ────────────────────────────────────────────
app.get('/api/admin/dashboard-stats', verifyAdminToken, async (req, res) => {
    try {
        const adminId = req.admin.admin_id;

        const stats = await db.query(`
            SELECT
                COUNT(*)                                                                   AS total,
                SUM(CASE WHEN is_locked=TRUE  THEN 1 ELSE 0 END)                          AS locked,
                SUM(CASE WHEN is_locked=FALSE THEN 1 ELSE 0 END)                          AS unlocked,
                SUM(CASE WHEN tamper_count>0  THEN 1 ELSE 0 END)                          AS tampered,
                SUM(CASE WHEN last_seen > NOW()-INTERVAL '5 minutes' THEN 1 ELSE 0 END)   AS online
            FROM devices WHERE admin_id=$1`, [adminId]);

        const recentAlerts = await db.query(`
            SELECT t.*, d.device_model, l.borrower_name, l.borrower_phone
            FROM tamper_events t
            JOIN devices d ON t.device_id=d.device_id
            LEFT JOIN loans l ON t.device_id=l.device_id AND l.is_active=TRUE
            WHERE d.admin_id=$1 ORDER BY t.created_at DESC LIMIT 10`, [adminId]);

        res.json({ stats: stats.rows[0], recent_alerts: recentAlerts.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 8. TAMPER EVENTS FOR DEVICE ───────────────────────────────────
app.get('/api/admin/tamper-events/:deviceId', verifyAdminToken, async (req, res) => {
    try {
        const events = await db.query('SELECT * FROM tamper_events WHERE device_id=$1 ORDER BY created_at DESC LIMIT 50', [req.params.deviceId]);
        res.json({ events: events.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 9. ADD LOAN ───────────────────────────────────────────────────
app.post('/api/admin/add-loan', verifyAdminToken, async (req, res) => {
    try {
        const { device_id, borrower_name, borrower_phone, borrower_email, loan_amount, emi_amount, total_emis, due_date, payment_url } = req.body;

        await db.query('UPDATE devices SET admin_id=$1 WHERE device_id=$2', [req.admin.admin_id, device_id]);

        const result = await db.query(`
            INSERT INTO loans (device_id,admin_id,borrower_name,borrower_phone,borrower_email,loan_amount,emi_amount,total_emis,due_amount,due_date,payment_url,lender_name,lender_phone)
            VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,(SELECT name FROM admins WHERE id=$2),(SELECT phone FROM admins WHERE id=$2))
            RETURNING *`,
            [device_id, req.admin.admin_id, borrower_name, borrower_phone, borrower_email, loan_amount, emi_amount, total_emis, emi_amount, due_date, payment_url]
        );

        res.json({ success: true, loan: result.rows[0] });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ── 10. AUDIT LOG ─────────────────────────────────────────────────
app.get('/api/admin/audit-log', verifyAdminToken, async (req, res) => {
    try {
        const result = await db.query('SELECT * FROM admin_actions WHERE admin_id=$1 ORDER BY created_at DESC LIMIT 100', [req.admin.admin_id]);
        res.json({ actions: result.rows });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  RAZORPAY PAYMENT WEBHOOK
//  Razorpay calls this when borrower pays EMI
//  → Automatically unlocks device within 3 seconds
// ════════════════════════════════════════════════════════════════
app.post('/api/webhook/payment', express.raw({ type: '*/*' }), async (req, res) => {
    try {
        let body;
        try { body = JSON.parse(req.body.toString()); } catch { body = req.body; }

        const event = body.event;
        console.log('💳 Webhook:', event);

        if (event === 'payment.captured') {
            const payment   = body.payload?.payment?.entity;
            const device_id = payment?.notes?.device_id;
            const amount    = payment ? payment.amount / 100 : 0;

            if (device_id) {
                await db.query(
                    "INSERT INTO payments (device_id,razorpay_payment_id,amount,status,auto_unlocked) VALUES ($1,$2,$3,'captured',TRUE) ON CONFLICT (razorpay_payment_id) DO NOTHING",
                    [device_id, payment.id, amount]
                );

                await db.query('UPDATE devices SET is_locked=FALSE WHERE device_id=$1', [device_id]);

                await db.query(
                    "UPDATE loans SET paid_emis=paid_emis+1, due_date=due_date+INTERVAL '1 month', due_amount=emi_amount WHERE device_id=$1 AND is_active=TRUE",
                    [device_id]
                );

                const device = await db.query('SELECT fcm_token FROM devices WHERE device_id=$1', [device_id]);
                if (device.rows[0]?.fcm_token) await sendFCM(device.rows[0].fcm_token, { command: 'UNLOCK', reason: 'Payment received' });

                console.log(`✅ Auto-unlocked: ${device_id} after ₹${amount} payment`);
            }
        }

        res.json({ received: true });
    } catch (e) { console.error('Webhook error:', e.message); res.status(500).json({ error: e.message }); }
});

// ════════════════════════════════════════════════════════════════
//  AUTO LOCK CRON JOB
//  Every day 9:00 AM India time
//  Locks all devices where EMI is overdue
// ════════════════════════════════════════════════════════════════
cron.schedule('0 9 * * *', async () => {
    console.log('⏰ Daily auto-lock starting...');
    try {
        const overdue = await db.query(`
            SELECT l.device_id, d.fcm_token, l.borrower_name
            FROM loans l JOIN devices d ON l.device_id=d.device_id
            WHERE l.due_date < CURRENT_DATE AND l.is_active=TRUE AND d.is_locked=FALSE`
        );

        let count = 0;
        for (const row of overdue.rows) {
            await db.query('UPDATE devices SET is_locked=TRUE WHERE device_id=$1', [row.device_id]);
            if (row.fcm_token) await sendFCM(row.fcm_token, { command: 'LOCK', reason: 'EMI overdue - auto lock' });
            count++;
            console.log(`🔒 Auto-locked: ${row.device_id} (${row.borrower_name})`);
        }

        console.log(`✅ Auto-lock done: ${count} devices locked`);
    } catch (e) { console.error('❌ Cron error:', e.message); }
}, { timezone: 'Asia/Kolkata' });

// ════════════════════════════════════════════════════════════════
//  START SERVER
// ════════════════════════════════════════════════════════════════
app.listen(PORT, () => {
    console.log(`🚀 EMI Lock Backend running on port ${PORT}`);
    console.log(`📡 Test it: /api/ping`);
});
