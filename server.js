const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const compression = require('compression');
const { authenticateToken } = require('./middleware/auth');
require('dotenv').config();

const app = express();

// Middlewares
app.use(compression()); // GZIP compress all responses — 60-80% smaller JSON payloads
app.use(cors());
app.use(express.json());

// 1. Database Connection
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("✅ MongoDB Database Connected Successfully!"))
    .catch((err) => console.log("❌ MongoDB Connection Error: ", err.message));

// 2. Basic Test Route
app.get('/', (req, res) => {
    res.send('Backend Server is Running Perfectly! (GridFS Active)');
});

// 3. API Routes Connection (Smart Check)
try {
    // Auth Routes (Login/Register)
    const authRoutes = require('./routes/auth');
    app.use('/api/auth', authRoutes);
    console.log("✅ Auth API Routes Connected!");

    // File Upload Routes (GridFS enabled)
    const uploadRoutes = require('./routes/upload');
    app.use('/api/files', uploadRoutes);

    // Orders API (paginated, fast)
    const ordersRoutes = require('./routes/orders');
    app.use('/api/orders', ordersRoutes);

    // Dropdown Master Setup API
    const dropdownRoutes = require('./routes/dropdowns');
    app.use('/api/dropdowns', dropdownRoutes);
    
    // GridFS File Serving Route
    // Protected by authenticateToken
    let serverGfsBucket;
    mongoose.connection.on('connected', () => {
        serverGfsBucket = null;
    });

    app.get('/uploads/:filename', authenticateToken, async (req, res) => {
        try {
            if (mongoose.connection.readyState !== 1) {
                return res.status(503).json({ message: 'Database not ready' });
            }

            if (!serverGfsBucket) {
                serverGfsBucket = new mongoose.mongo.GridFSBucket(mongoose.connection.db, {
                    bucketName: 'uploads'
                });
            }
            const bucket = serverGfsBucket;

            const filename = req.params.filename;

            // GridFS-e file ache ki na check kori
            const files = await mongoose.connection.db
                .collection('uploads.files')
                .find({ filename: filename })
                .toArray();

            if (!files || files.length === 0) {
                return res.status(404).json({ message: 'File not found' });
            }

            // Content type and Cache headers set kori
            const file = files[0];
            res.set('Content-Type', file.contentType || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
            res.set('Cache-Control', 'public, max-age=31536000, immutable');

            // GridFS theke file stream kore pathay dei
            const downloadStream = bucket.openDownloadStreamByName(filename);

            downloadStream.on('error', (err) => {
                console.error('GridFS stream error:', err);
                if (!res.headersSent) {
                    res.status(404).json({ message: 'File not found in GridFS' });
                }
            });

            downloadStream.pipe(res);

        } catch (error) {
            console.error('File serve error:', error);
            if (!res.headersSent) {
                res.status(500).json({ message: 'Error serving file' });
            }
        }
    });

    console.log("✅ File Upload API Connected (GridFS Mode)!");

} catch (error) {
    console.log("❌ Route connect korte somossa hoyeche!");
    console.error("Error details:", error.message);
}

// 4. Server Port Setup
const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`🚀 Server is running on http://localhost:${PORT}`);
});