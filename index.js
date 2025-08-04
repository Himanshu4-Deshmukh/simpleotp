const express = require('express');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const cors = require('cors');

const app = express();
app.use(express.json());
app.use(cors());

// In-memory storage for OTPs (in production, use a database)
const otpStorage = new Map();

// WhatsApp client
let whatsappClient = null;
let whatsappConnected = false;
let currentQR = null;

// Helper function to generate 6-digit OTP
const generateOTP = () => {
    return Math.floor(100000 + Math.random() * 900000).toString();
};

// Helper function to format phone number
const formatPhoneNumber = (phoneNumber) => {
    let formatted = phoneNumber.replace(/\D/g, '');
    // Add country code if not present (assuming India +91)
    if (!formatted.startsWith('91') && formatted.length === 10) {
        formatted = '91' + formatted;
    }
    return formatted + '@c.us';
};

// Initialize WhatsApp client
const initializeWhatsApp = () => {
    whatsappClient = new Client({
        authStrategy: new LocalAuth({ clientId: 'whatsapp_otp_service' }),
        puppeteer: {
            headless: true,
            args: ['--no-sandbox', '--disable-setuid-sandbox']
        }
    });

    // QR Code generation
    whatsappClient.on('qr', (qr) => {
        console.log('WhatsApp QR Code generated:');
        qrcode.generate(qr, { small: true });
        currentQR = qr;
    });

    // When WhatsApp is ready
    whatsappClient.on('ready', () => {
        console.log('WhatsApp client is ready!');
        whatsappConnected = true;
        currentQR = null;
        const clientInfo = whatsappClient.info;
        console.log(`Connected WhatsApp: ${clientInfo.wid.user}`);
    });

    // Handle authentication failure
    whatsappClient.on('auth_failure', () => {
        console.log('WhatsApp authentication failed');
        whatsappClient = null;
        whatsappConnected = false;
        currentQR = null;
    });

    // Handle disconnection
    whatsappClient.on('disconnected', () => {
        console.log('WhatsApp disconnected');
        whatsappClient = null;
        whatsappConnected = false;
        currentQR = null;
    });

    // Initialize the client
    whatsappClient.initialize();
};

// Routes

// Connect WhatsApp and get QR code
app.post('/api/whatsapp/connect', (req, res) => {
    try {
        if (whatsappConnected) {
            return res.json({ 
                message: 'WhatsApp already connected',
                connected: true 
            });
        }

        if (!whatsappClient) {
            initializeWhatsApp();
        }

        // Wait for QR code generation
        const checkQR = setInterval(() => {
            if (currentQR) {
                clearInterval(checkQR);
                res.json({
                    message: 'QR code generated. Please scan with WhatsApp.',
                    qrCode: currentQR,
                    connected: false
                });
            } else if (whatsappConnected) {
                clearInterval(checkQR);
                res.json({
                    message: 'WhatsApp connected successfully',
                    connected: true
                });
            }
        }, 1000);

        // Timeout after 30 seconds
        setTimeout(() => {
            clearInterval(checkQR);
            if (!whatsappConnected && !currentQR) {
                res.status(500).json({ error: 'Failed to generate QR code' });
            }
        }, 30000);

    } catch (error) {
        console.error('Error connecting WhatsApp:', error);
        res.status(500).json({ error: 'Failed to connect WhatsApp' });
    }
});

// Get WhatsApp connection status
app.get('/api/whatsapp/status', (req, res) => {
    res.json({
        connected: whatsappConnected,
        qrAvailable: !!currentQR,
        qrCode: currentQR,
        clientInfo: whatsappConnected && whatsappClient ? {
            number: whatsappClient.info?.wid?.user,
            name: whatsappClient.info?.pushname
        } : null
    });
});

// Send OTP via WhatsApp
app.post('/api/send-otp', async (req, res) => {
    try {
        const { phoneNumber, message } = req.body;

        if (!phoneNumber) {
            return res.status(400).json({ error: 'Phone number is required' });
        }

        // Check if WhatsApp is connected
        if (!whatsappClient || !whatsappConnected) {
            return res.status(400).json({ 
                error: 'WhatsApp not connected. Please connect WhatsApp first.' 
            });
        }

        // Generate OTP
        const otp = generateOTP();
        const otpId = `otp_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        // Format phone number
        const formattedNumber = formatPhoneNumber(phoneNumber);

        // Create message
        const otpMessage = message 
            ? message.replace('{otp}', otp)
            : `Your OTP is: ${otp}\n\nThis OTP will expire in 5 minutes.\n\n- WhatsApp OTP Service`;

        try {
            // Send message via WhatsApp
            await whatsappClient.sendMessage(formattedNumber, otpMessage);

            // Store OTP with 5-minute expiry
            const expiryTime = Date.now() + (5 * 60 * 1000); // 5 minutes
            otpStorage.set(otpId, {
                phoneNumber: phoneNumber,
                otp: otp,
                expiresAt: expiryTime,
                verified: false,
                createdAt: Date.now()
            });

            // Clean up expired OTPs
            setTimeout(() => {
                otpStorage.delete(otpId);
            }, 5 * 60 * 1000);

            res.json({
                message: 'OTP sent successfully',
                otpId: otpId,
                phoneNumber: phoneNumber,
                expiresIn: '5 minutes'
            });

        } catch (whatsappError) {
            console.error('WhatsApp send error:', whatsappError);
            res.status(500).json({ error: 'Failed to send OTP via WhatsApp' });
        }

    } catch (error) {
        console.error('Send OTP error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Verify OTP
app.post('/api/verify-otp', (req, res) => {
    try {
        const { otpId, otp, phoneNumber } = req.body;

        if (!otp) {
            return res.status(400).json({ error: 'OTP is required' });
        }

        let otpRecord = null;

        if (otpId) {
            // Verify using OTP ID
            otpRecord = otpStorage.get(otpId);
        } else if (phoneNumber) {
            // Find OTP by phone number (get the latest one)
            let latestOtp = null;
            let latestTime = 0;

            for (const [id, record] of otpStorage.entries()) {
                if (record.phoneNumber === phoneNumber && 
                    record.createdAt > latestTime && 
                    !record.verified) {
                    latestOtp = record;
                    latestTime = record.createdAt;
                    otpRecord = record;
                }
            }
        }

        if (!otpRecord) {
            return res.status(400).json({ error: 'OTP not found' });
        }

        // Check if OTP has expired
        if (otpRecord.expiresAt < Date.now()) {
            return res.status(400).json({ error: 'OTP has expired' });
        }

        // Check if OTP is already verified
        if (otpRecord.verified) {
            return res.status(400).json({ error: 'OTP already verified' });
        }

        // Verify OTP
        if (otpRecord.otp !== otp) {
            return res.status(400).json({ error: 'Invalid OTP' });
        }

        // Mark OTP as verified
        otpRecord.verified = true;
        otpRecord.verifiedAt = Date.now();

        res.json({
            message: 'OTP verified successfully',
            verified: true,
            phoneNumber: otpRecord.phoneNumber,
            verifiedAt: new Date().toISOString()
        });

    } catch (error) {
        console.error('Verify OTP error:', error);
        res.status(500).json({ error: 'Server error' });
    }
});

// Get service status
app.get('/api/status', (req, res) => {
    const activeOTPs = Array.from(otpStorage.values()).filter(
        otp => otp.expiresAt > Date.now() && !otp.verified
    ).length;

    res.json({
        service: 'WhatsApp OTP Service',
        status: 'Running',
        whatsapp: {
            connected: whatsappConnected,
            qrAvailable: !!currentQR
        },
        stats: {
            activeOTPs: activeOTPs,
            totalOTPs: otpStorage.size
        },
        timestamp: new Date().toISOString()
    });
});

// Clean up expired OTPs periodically
setInterval(() => {
    const now = Date.now();
    for (const [id, record] of otpStorage.entries()) {
        if (record.expiresAt < now) {
            otpStorage.delete(id);
        }
    }
}, 60000); // Clean up every minute

// Error handling middleware
app.use((err, req, res, next) => {
    console.error(err.stack);
    res.status(500).json({ error: 'Something went wrong!' });
});

const PORT =  5000;
app.listen(PORT, () => {
    console.log(`🚀 WhatsApp OTP Service running on port ${PORT}`);
    console.log(`📱 WhatsApp Status: ${whatsappConnected ? 'Connected' : 'Disconnected'}`);
    console.log('\nAvailable endpoints:');
    console.log('POST /api/whatsapp/connect - Connect WhatsApp and get QR');
    console.log('GET  /api/whatsapp/status - Get WhatsApp status');
    console.log('POST /api/send-otp - Send OTP via WhatsApp');
    console.log('POST /api/verify-otp - Verify OTP');
    console.log('GET  /api/status - Get service status');
});

module.exports = app;
