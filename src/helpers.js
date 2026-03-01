// ═══════════════════════════════════════════════════════════════════════════
//  HELPERS.JS — EMI Lock Backend
//  Contains: Database connection, SMS alerts, Email alerts
//  Place this file in: src/helpers.js
// ═══════════════════════════════════════════════════════════════════════════

const { Pool } = require('pg');
const nodemailer = require('nodemailer');

// ════════════════════════════════════════════════════════════════
//  DATABASE CONNECTION
//  Used by server.js to connect to Supabase PostgreSQL
// ════════════════════════════════════════════════════════════════
const db = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
    max: 10,                  // maximum 10 connections in pool
    idleTimeoutMillis: 30000, // close idle connections after 30s
    connectionTimeoutMillis: 2000
});

// Test database connection on startup
db.connect()
    .then(client => {
        console.log('✅ Database connected successfully');
        client.release();
    })
    .catch(err => {
        console.error('❌ Database connection failed:', err.message);
    });

module.exports.db = db;

// ════════════════════════════════════════════════════════════════
//  EMAIL ALERTS
//  Sends tamper alerts, payment confirmations to lender via Gmail
// ════════════════════════════════════════════════════════════════
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.SMTP_USER, // your@gmail.com
        pass: process.env.SMTP_PASS  // Gmail App Password (16 characters)
    }
});

// Generic send email function
const sendEmail = async (to, subject, html) => {
    try {
        await transporter.sendMail({
            from: `EMI Lock Alert <${process.env.SMTP_USER}>`,
            to,
            subject,
            html
        });
        console.log(`📧 Email sent to: ${to}`);
        return true;
    } catch (e) {
        console.error('❌ Email error:', e.message);
        return false;
    }
};

// Tamper alert email — sent when device is tampered
const sendTamperAlertEmail = async ({
    adminEmail,
    deviceId,
    borrowerName,
    borrowerPhone,
    eventType,
    tamperCount,
    latitude,
    longitude,
    photoUrl,
    batteryLevel
}) => {
    const mapsLink = latitude
        ? `https://maps.google.com/?q=${latitude},${longitude}`
        : 'Location not available';

    const subject = `🚨 Tamper Alert: ${borrowerName} — ${eventType} (Attempt ${tamperCount})`;

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">

        <!-- Header -->
        <div style="background:#dc2626;padding:24px;text-align:center">
            <h1 style="color:white;margin:0;font-size:24px">⚠️ TAMPER ALERT</h1>
            <p style="color:#fca5a5;margin:8px 0 0">EMI Lock Security System</p>
        </div>

        <!-- Body -->
        <div style="padding:24px;background:#f9fafb">

            <!-- Alert level -->
            <div style="background:${tamperCount >= 3 ? '#7f1d1d' : '#fef2f2'};border:1px solid #fca5a5;border-radius:8px;padding:16px;margin-bottom:20px;text-align:center">
                <p style="color:${tamperCount >= 3 ? 'white' : '#dc2626'};font-weight:bold;margin:0;font-size:16px">
                    ${tamperCount >= 4 ? '💀 AUTO WIPE ORDERED — Device will be erased!' :
                      tamperCount >= 3 ? '🚨 CRITICAL — Next tamper will trigger auto wipe!' :
                      tamperCount >= 2 ? '⚠️ WARNING — Multiple tamper attempts detected' :
                      '🔔 Tamper attempt detected'}
                </p>
                <p style="color:${tamperCount >= 3 ? '#fca5a5' : '#991b1b'};margin:8px 0 0">
                    Attempt ${tamperCount} of 4
                </p>
            </div>

            <!-- Details table -->
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151;width:40%">Device ID</td>
                    <td style="padding:12px 16px;color:#111827;font-family:monospace">${deviceId}</td>
                </tr>
                <tr>
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Borrower</td>
                    <td style="padding:12px 16px;color:#111827">${borrowerName}</td>
                </tr>
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Phone</td>
                    <td style="padding:12px 16px;color:#111827">${borrowerPhone}</td>
                </tr>
                <tr>
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Event Type</td>
                    <td style="padding:12px 16px;color:#dc2626;font-weight:bold">${eventType}</td>
                </tr>
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Tamper Count</td>
                    <td style="padding:12px 16px;color:#dc2626;font-weight:bold">${tamperCount} / 4</td>
                </tr>
                <tr>
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">GPS Location</td>
                    <td style="padding:12px 16px"><a href="${mapsLink}" style="color:#2563eb">${latitude ? `${latitude}, ${longitude}` : 'Not available'}</a></td>
                </tr>
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Battery Level</td>
                    <td style="padding:12px 16px;color:#111827">${batteryLevel || 'Unknown'}%</td>
                </tr>
                <tr>
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Date & Time</td>
                    <td style="padding:12px 16px;color:#111827">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                </tr>
            </table>

            <!-- Photo -->
            ${photoUrl ? `
            <div style="margin-top:20px;background:white;border:1px solid #e5e7eb;border-radius:8px;padding:16px">
                <p style="font-weight:bold;color:#374151;margin:0 0 12px">📸 Tamper Photo (Front Camera)</p>
                <img src="${photoUrl}"
                     style="max-width:100%;border-radius:8px;border:2px solid #dc2626"
                     alt="Tamper photo"/>
                <p style="margin:8px 0 0"><a href="${photoUrl}" style="color:#2563eb;font-size:14px">View full size photo →</a></p>
            </div>` : `
            <div style="margin-top:20px;background:#f3f4f6;border:1px solid #e5e7eb;border-radius:8px;padding:16px;text-align:center">
                <p style="color:#6b7280;margin:0">📷 Camera photo not available for this event</p>
            </div>`}

            <!-- GPS Map link -->
            ${latitude ? `
            <div style="margin-top:16px;text-align:center">
                <a href="${mapsLink}"
                   style="background:#2563eb;color:white;padding:12px 24px;border-radius:8px;text-decoration:none;font-weight:bold;display:inline-block">
                    📍 Open Location in Google Maps
                </a>
            </div>` : ''}

        </div>

        <!-- Footer -->
        <div style="background:#1f2937;padding:16px;text-align:center">
            <p style="color:#9ca3af;margin:0;font-size:12px">
                EMI Lock Security System — This is an automated alert
            </p>
        </div>
    </div>`;

    return sendEmail(adminEmail, subject, html);
};

// Payment received email
const sendPaymentReceivedEmail = async ({
    adminEmail,
    deviceId,
    borrowerName,
    amount,
    paymentId
}) => {
    const subject = `✅ EMI Payment Received — ${borrowerName} — ₹${amount}`;

    const html = `
    <div style="font-family:Arial,sans-serif;max-width:600px;margin:0 auto;border:1px solid #e5e7eb;border-radius:12px;overflow:hidden">
        <div style="background:#16a34a;padding:24px;text-align:center">
            <h1 style="color:white;margin:0;font-size:24px">✅ EMI Payment Received</h1>
            <p style="color:#bbf7d0;margin:8px 0 0">Device has been automatically unlocked</p>
        </div>
        <div style="padding:24px;background:#f9fafb">
            <table style="width:100%;border-collapse:collapse;background:white;border-radius:8px;overflow:hidden;border:1px solid #e5e7eb">
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Borrower</td>
                    <td style="padding:12px 16px;color:#111827">${borrowerName}</td>
                </tr>
                <tr>
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Amount Paid</td>
                    <td style="padding:12px 16px;color:#16a34a;font-weight:bold;font-size:18px">₹${amount}</td>
                </tr>
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Device ID</td>
                    <td style="padding:12px 16px;font-family:monospace">${deviceId}</td>
                </tr>
                <tr>
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Payment ID</td>
                    <td style="padding:12px 16px;font-family:monospace;font-size:13px">${paymentId}</td>
                </tr>
                <tr style="background:#f3f4f6">
                    <td style="padding:12px 16px;font-weight:bold;color:#374151">Date & Time</td>
                    <td style="padding:12px 16px">${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</td>
                </tr>
            </table>
            <div style="margin-top:20px;background:#f0fdf4;border:1px solid #86efac;border-radius:8px;padding:16px;text-align:center">
                <p style="color:#16a34a;font-weight:bold;margin:0">
                    🔓 Device has been automatically unlocked via FCM push notification
                </p>
            </div>
        </div>
    </div>`;

    return sendEmail(adminEmail, subject, html);
};

module.exports.sendEmail = sendEmail;
module.exports.sendTamperAlertEmail = sendTamperAlertEmail;
module.exports.sendPaymentReceivedEmail = sendPaymentReceivedEmail;

// ════════════════════════════════════════════════════════════════
//  SMS ALERTS — Fast2SMS (easier for India, no DLT needed for OTP)
//  Sign up free at: fast2sms.com
//  Get API key from: fast2sms.com/dashboard
// ════════════════════════════════════════════════════════════════
const https = require('https');
const querystring = require('querystring');

const sendSMS = async (phoneNumber, message) => {
    // Remove +91 or 0 from start of phone number
    const cleanPhone = phoneNumber.replace(/^\+91|^91|^0/, '');

    return new Promise((resolve) => {
        const postData = querystring.stringify({
            authorization: process.env.FAST2SMS_API_KEY,
            message:       message,
            language:      'english',
            route:         'q',          // quick SMS route
            numbers:       cleanPhone
        });

        const options = {
            hostname: 'www.fast2sms.com',
            path:     '/dev/bulkV2',
            method:   'POST',
            headers: {
                'Content-Type':   'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(postData)
            }
        };

        const req = https.request(options, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    const result = JSON.parse(data);
                    if (result.return === true) {
                        console.log(`📱 SMS sent to: ${cleanPhone}`);
                        resolve(true);
                    } else {
                        console.error('SMS failed:', result.message);
                        resolve(false);
                    }
                } catch {
                    resolve(false);
                }
            });
        });

        req.on('error', (e) => {
            console.error('SMS error:', e.message);
            resolve(false);
        });

        req.write(postData);
        req.end();
    });
};

// SMS for OTP unlock code
const sendOTPSMS = async (phoneNumber, otp, durationHours) => {
    const message = `EMI Lock OTP: ${otp}. Use this code to unlock your device for ${durationHours} hours. Valid for 1 hour. Do not share this code.`;
    return sendSMS(phoneNumber, message);
};

// SMS for tamper alert to lender
const sendTamperSMS = async (phoneNumber, borrowerName, eventType, tamperCount) => {
    const message = `EMI Lock Alert: ${borrowerName} attempted ${eventType}. Tamper count: ${tamperCount}/4. Check dashboard for photo and GPS location.`;
    return sendSMS(phoneNumber, message);
};

// SMS for payment confirmation to borrower
const sendPaymentSMS = async (phoneNumber, borrowerName, amount) => {
    const message = `EMI Lock: Payment of Rs.${amount} received. Thank you ${borrowerName}! Your phone has been unlocked. Next EMI due in 30 days.`;
    return sendSMS(phoneNumber, message);
};

// SMS for EMI reminder (sent 3 days before due date)
const sendEMIReminderSMS = async (phoneNumber, borrowerName, amount, dueDate) => {
    const message = `Reminder: Dear ${borrowerName}, your EMI of Rs.${amount} is due on ${dueDate}. Please pay on time to avoid device lock.`;
    return sendSMS(phoneNumber, message);
};

module.exports.sendSMS = sendSMS;
module.exports.sendOTPSMS = sendOTPSMS;
module.exports.sendTamperSMS = sendTamperSMS;
module.exports.sendPaymentSMS = sendPaymentSMS;
module.exports.sendEMIReminderSMS = sendEMIReminderSMS;
