// server.js
const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bodyParser = require('body-parser');
const faceapi = require('face-api.js');
const { Canvas, Image, ImageData, loadImage } = require('canvas');
const path = require('path');

// Patch face-api for Node.js
faceapi.env.monkeyPatch({ Canvas, Image, ImageData });

const app = express();
app.use(cors());
app.use(bodyParser.json({ limit: '50mb' }));

// --------------------
// Load AI Models
// --------------------
async function loadModels() {
    const modelPath = path.join(__dirname, 'models');
    await faceapi.nets.ssdMobilenetv1.loadFromDisk(modelPath);
    await faceapi.nets.faceLandmark68Net.loadFromDisk(modelPath);
    await faceapi.nets.faceRecognitionNet.loadFromDisk(modelPath);
    console.log("✅ AI Face Models Loaded");
}
loadModels();

// --------------------
// MongoDB Connection
// --------------------
const uri = "mongodb://localhost:27017/bankFaceDB";
mongoose.connect(uri)
    .then(() => console.log("✅ Connected to MongoDB"))
    .catch(err => console.error("❌ MongoDB Connection Error:", err.message));

// --------------------
// User Schema
// --------------------
const userSchema = new mongoose.Schema({
    name: String,
    accountNumber: { type: String, unique: true },
    mobile: String,
    mpin: { type: String, required: true },
    balance: { type: Number, default: 5000 },
    faceDescriptor: Array
});
const User = mongoose.model('User', userSchema);

// --------------------
// Helper: Image → Descriptor
// --------------------
async function getDescriptorFromBinary(base64Image) {
    try {
        const img = await loadImage(base64Image);
        const detections = await faceapi
            .detectSingleFace(img)
            .withFaceLandmarks()
            .withFaceDescriptor();
        return detections ? Array.from(detections.descriptor) : null;
    } catch (e) {
        return null;
    }
}

// --------------------
// Register API
// --------------------
app.post('/api/register', async (req, res) => {
    try {
        const { name, accountNumber, mobile, mpin, faceData } = req.body;
        if (!name || !accountNumber || !mpin || !faceData) {
            return res.status(400).json({ message: "Missing required fields" });
        }
        const existing = await User.findOne({ accountNumber });
        if (existing) return res.status(400).json({ message: "Account already registered" });
        const descriptor = await getDescriptorFromBinary(faceData);
        if (!descriptor) return res.status(400).json({ message: "No face detected" });
        const user = new User({ name, accountNumber, mobile, mpin, faceDescriptor: descriptor });
        await user.save();
        res.json({ success: true, message: "Registration successful" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------
// Login API (Credential Only)
// --------------------
app.post('/api/login', async (req, res) => {
    try {
        const { accountNumber, mpin } = req.body;
        const user = await User.findOne({ accountNumber });
        if (!user || user.mpin !== mpin) {
            return res.status(401).json({ success: false, message: "Invalid Account Number or MPIN" });
        }
        res.json({
            success: true,
            user: {
                name: user.name,
                accountNumber: user.accountNumber,
                balance: user.balance
            }
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------
// Face Verification API
// --------------------
app.post('/api/verify', async (req, res) => {
    try {
        const { faceData } = req.body;
        const incomingDescriptor = await getDescriptorFromBinary(faceData);
        if (!incomingDescriptor) return res.status(400).json({ message: "No face detected" });
        const users = await User.find();
        let matchedUser = null;
        const threshold = 0.6;
        for (let user of users) {
            const distance = faceapi.euclideanDistance(incomingDescriptor, user.faceDescriptor);
            if (distance < threshold) { matchedUser = user; break; }
        }
        if (!matchedUser) return res.status(401).json({ success: false, message: "Face not recognized" });
        res.json({
            success: true,
            name: matchedUser.name,
            balance: matchedUser.balance,
            accountNumber: matchedUser.accountNumber
        });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------
// Update MPIN API
// --------------------
app.post('/api/update-pin', async (req, res) => {
    try {
        const { accountNumber, oldMpin, newMpin } = req.body;
        const user = await User.findOne({ accountNumber });
        if (!user || user.mpin !== oldMpin) return res.status(401).json({ message: "Incorrect current PIN" });
        user.mpin = newMpin;
        await user.save();
        res.json({ success: true, message: "MPIN updated successfully" });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------
// Transaction API
// --------------------
app.post('/api/transaction', async (req, res) => {
    try {
        const { accountNumber, amount } = req.body;
        const numAmount = parseFloat(amount);
        const user = await User.findOne({ accountNumber });
        if (!user || user.balance < numAmount) return res.status(400).json({ message: "Insufficient balance" });
        user.balance -= numAmount;
        await user.save();
        const txnId = "TXN" + Date.now();
        res.json({ success: true, transactionId: txnId, remainingBalance: user.balance });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------
// Fetch Account Name API
// --------------------
app.get('/api/account/:accountNumber', async (req, res) => {
    try {
        const user = await User.findOne({ accountNumber: req.params.accountNumber });
        if (!user) return res.status(404).json({ success: false, message: "Account not found" });
        res.json({ success: true, name: user.name });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// --------------------
// Transfer API
// --------------------
app.post('/api/transfer', async (req, res) => {
    try {
        const { senderAccount, receiverAccount, amount } = req.body;
        const numAmount = parseFloat(amount);
        
        if (senderAccount === receiverAccount) return res.status(400).json({ message: "Cannot transfer to self" });

        const sender = await User.findOne({ accountNumber: senderAccount });
        const receiver = await User.findOne({ accountNumber: receiverAccount });

        if (!sender || sender.balance < numAmount) return res.status(400).json({ message: "Insufficient balance" });
        if (!receiver) return res.status(404).json({ message: "Receiver account not found" });

        sender.balance -= numAmount;
        receiver.balance += numAmount;

        await sender.save();
        await receiver.save();

        const txnId = "TRF" + Date.now();
        res.json({ success: true, transactionId: txnId, remainingBalance: sender.balance, receiverName: receiver.name });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = 5000;
app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));