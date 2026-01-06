require('dotenv').config();
const express = require('express');
const cors = require('cors');
const cron = require('node-cron');
const db = require('./config/db');

const app = express();
const PORT = process.env.PORT || 3001;

// MIDDLEWARE
app.use(cors({
  origin: function (origin, callback) {
    if (!origin) return callback(null, true);
    const allowedOrigins = [
      'https://syncnexus.aifund.co.za',
      'https://syncnexus-brain-core-5.aifund.co.za',
      'http://localhost:3000',
      'http://localhost:5173'
    ];
    if (allowedOrigins.indexOf(origin) !== -1 || origin.endsWith('.aifund.co.za')) {
      callback(null, true);
    } else {
      console.warn('CORS Blocked Origin:', origin);
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'apikey']
}));
app.use(express.json());

// LOGGING
app.use((req, res, next) => {
  console.log(`${new Date().toISOString()} - ${req.method} ${req.path}`);
  next();
});

// HEALTH CHECK
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString(), database: 'connected' });
});

// ROUTES
app.use('/api/sync', require('./routes/sync'));
app.use('/api/admin', require('./routes/admin'));
app.use('/api/webhook', require('./routes/webhook')); // <-- NEW: Real-time Listener
app.use('/api/dashboard', require('./routes/dashboard')); // Includes /stats
app.use('/api', require('./routes/dashboard')); // For /members, /groups fallback to root /api if needed or move to /api/data

// BACKWARD COMPATIBILITY & DIRECT ROUTES
// Some frontend calls might be /api/groups directly, not /api/dashboard/groups
// So we mount dashboard routes to /api as well?
// Better: update routes/dashboard to NOT have 'dashboard' prefix in the file, and mount carefully.
// Dashboard file has /stats, /groups, /members.
// If we mount to /api: /api/stats, /api/groups.
// If we mount to /api/dashboard: /api/dashboard/stats.

// Correction: 
// Frontend expects /api/dashboard/stats
// Frontend expects /api/groups
// Frontend expects /api/members

// So we should split dashboard.js or mount it twice?
// Let's rely on specific mounts for cleaner code.
const dashboardRoutes = require('./routes/dashboard');
app.use('/api/dashboard', dashboardRoutes); // Serving /api/dashboard/stats
app.use('/api', dashboardRoutes); // Serving /api/groups, /api/members

// CRON JOBS (Keep here or move to jobs folder?)
// Keeping lightweight Cron setup here for now to ensure they start.

cron.schedule('0 0 * * *', async () => {
  console.log('🔄 Cron: Resetting daily stats...');
  await db.query(`INSERT INTO crm.wa_system_stats (date) VALUES (CURRENT_DATE) ON CONFLICT (date) DO NOTHING`);
});

// START
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV}`);
  console.log(`Architecture: Modular (Routes/Config Split)`);
});