const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
  cors: {
    origin: "*",
    methods: ["GET", "POST"]
  }
});

// Middleware
app.use(cors());
app.use(express.json());

// Database configuration for PostgreSQL
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
async function testConnection() {
  try {
    const client = await pool.connect();
    console.log('✅ Database connected successfully');
    client.release();
  } catch (error) {
    console.error('❌ Database connection failed:', error.message);
  }
}

// In-memory storage for active connections (for real-time features)
const connectedDevices = new Map();

// Socket.IO connection handling
io.on('connection', (socket) => {
  console.log('Device connected:', socket.id);

  // Register device
  socket.on('registerDevice', async (data) => {
    try {
      const { deviceId, pushToken, platform } = data;
      
      // Store in memory for real-time
      connectedDevices.set(deviceId, {
        socketId: socket.id,
        deviceId: deviceId,
        connectedAt: new Date()
      });
      
      // Update/insert device token in database
      if (pushToken) {
        await pool.query(
          `INSERT INTO device_tokens (device_id, push_token, platform) 
           VALUES ($1, $2, $3) 
           ON CONFLICT (device_id) 
           DO UPDATE SET 
           push_token = EXCLUDED.push_token, 
           platform = EXCLUDED.platform, 
           updated_at = CURRENT_TIMESTAMP`,
          [deviceId, pushToken, platform]
        );
      }
      
      console.log(`Device registered: ${deviceId}`);
      socket.join(deviceId);
    } catch (error) {
      console.error('Error registering device:', error);
    }
  });

  // Create prayer request
  socket.on('createPrayerRequest', async (data, callback) => {
    try {
      const { deviceId, topicId, timestamp } = data;
      
      // Insert prayer request into database
      const result = await pool.query(
        'INSERT INTO prayer_requests (device_id, topic_id, created_at) VALUES ($1, $2, $3) RETURNING id',
        [deviceId, topicId, new Date(timestamp)]
      );
      
      const requestId = result.rows[0].id;
      
      // Notify all connected devices
      socket.broadcast.emit('prayerRequestUpdate', {
        type: 'new_request',
        topicId,
        requestId,
        timestamp
      });
      
      // Send push notifications (implement with your preferred service)
      await sendPushNotifications(topicId, requestId);
      
      callback({ success: true, requestId });
    } catch (error) {
      console.error('Error creating prayer request:', error);
      callback({ success: false, error: error.message });
    }
  });

  // Start praying
  socket.on('startPraying', async (data, callback) => {
    try {
      const { deviceId, requestId } = data;
      
      // Insert prayer session
      await pool.query(
        'INSERT INTO prayer_sessions (device_id, request_id) VALUES ($1, $2)',
        [deviceId, requestId]
      );
      
      // Update active count
      await pool.query(
        `UPDATE prayer_requests 
         SET active_count = (
           SELECT COUNT(*) FROM prayer_sessions 
           WHERE request_id = $1 AND ended_at IS NULL
         ) 
         WHERE id = $1`,
        [requestId]
      );
      
      // Get updated count
      const result = await pool.query(
        'SELECT active_count FROM prayer_requests WHERE id = $1',
        [requestId]
      );
      
      const activeCount = result.rows[0]?.active_count || 0;
      
      // Broadcast count update
      io.emit('prayerCountUpdate', {
        requestId,
        count: activeCount
      });
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error starting prayer:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Stop praying
  socket.on('stopPraying', async (data, callback) => {
    try {
      const { deviceId, requestId } = data;
      
      // End prayer session
      await pool.query(
        'UPDATE prayer_sessions SET ended_at = CURRENT_TIMESTAMP WHERE device_id = $1 AND request_id = $2 AND ended_at IS NULL',
        [deviceId, requestId]
      );
      
      // Update active count
      await pool.query(
        `UPDATE prayer_requests 
         SET active_count = (
           SELECT COUNT(*) FROM prayer_sessions 
           WHERE request_id = $1 AND ended_at IS NULL
         ) 
         WHERE id = $1`,
        [requestId]
      );
      
      // Get updated count
      const result = await pool.query(
        'SELECT active_count FROM prayer_requests WHERE id = $1',
        [requestId]
      );
      
      const activeCount = result.rows[0]?.active_count || 0;
      
      // Broadcast count update
      io.emit('prayerCountUpdate', {
        requestId,
        count: activeCount
      });
      
      if (callback) callback({ success: true });
    } catch (error) {
      console.error('Error stopping prayer:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Get prayer requests for topic
  socket.on('getPrayerRequests', async (data, callback) => {
    try {
      const { topicId } = data;
      const result = await pool.query(
        'SELECT * FROM prayer_requests WHERE topic_id = $1 AND is_active = true ORDER BY created_at DESC',
        [topicId]
      );
      
      if (callback) callback({ success: true, requests: result.rows });
    } catch (error) {
      console.error('Error getting prayer requests:', error);
      if (callback) callback({ success: false, error: error.message });
    }
  });

  // Handle disconnection
  socket.on('disconnect', async () => {
    console.log('Device disconnected:', socket.id);
    
    // Find and remove device from connected devices
    let disconnectedDeviceId = null;
    for (const [deviceId, device] of connectedDevices.entries()) {
      if (device.socketId === socket.id) {
        disconnectedDeviceId = deviceId;
        connectedDevices.delete(deviceId);
        break;
      }
    }
    
    // End any active prayer sessions for this device
    if (disconnectedDeviceId) {
      try {
        await pool.query(
          'UPDATE prayer_sessions SET ended_at = CURRENT_TIMESTAMP WHERE device_id = $1 AND ended_at IS NULL',
          [disconnectedDeviceId]
        );
        
        // Update all affected prayer request counts
        await pool.query(
          `UPDATE prayer_requests 
           SET active_count = (
             SELECT COUNT(*) FROM prayer_sessions ps
             WHERE ps.request_id = prayer_requests.id AND ps.ended_at IS NULL
           )
           WHERE prayer_requests.id IN (
             SELECT DISTINCT request_id FROM prayer_sessions 
             WHERE device_id = $1
           )`,
          [disconnectedDeviceId]
        );
      } catch (error) {
        console.error('Error handling disconnection:', error);
      }
    }
  });
});

// Push notification function (implement with your preferred service)
async function sendPushNotifications(topicId, requestId) {
  try {
    // Get topic title
    const topicResult = await pool.query(
      'SELECT title FROM prayer_topics WHERE id = $1',
      [topicId]
    );
    
    if (topicResult.rows.length === 0) return;
    
    const topicTitle = topicResult.rows[0].title;
    
    // Get all device tokens
    const deviceResult = await pool.query(
      'SELECT push_token, platform FROM device_tokens WHERE push_token IS NOT NULL'
    );
    
    console.log(`Would send push notification to ${deviceResult.rows.length} devices for: ${topicTitle}`);
    
    // Implement actual push notification sending here
    // You can use Expo Push API, Firebase, or any other service
    
  } catch (error) {
    console.error('Error sending push notifications:', error);
  }
}

// REST API endpoints
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'OK', 
    timestamp: new Date(),
    database: 'connected'
  });
});

app.get('/api/topics', async (req, res) => {
  try {
    const result = await pool.query(
      'SELECT * FROM prayer_topics ORDER BY id'
    );
    res.json(result.rows);
  } catch (error) {
    console.error('Error fetching topics:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

app.get('/api/stats', async (req, res) => {
  try {
    const requestCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM prayer_requests WHERE is_active = true'
    );
    
    const sessionCountResult = await pool.query(
      'SELECT COUNT(*) as count FROM prayer_sessions WHERE ended_at IS NULL'
    );
    
    res.json({
      connectedDevices: connectedDevices.size,
      activePrayerRequests: parseInt(requestCountResult.rows[0].count),
      activePrayerSessions: parseInt(sessionCountResult.rows[0].count)
    });
  } catch (error) {
    console.error('Error fetching stats:', error);
    res.status(500).json({ error: 'Database error' });
  }
});

// Initialize database connection and start server
const PORT = process.env.PORT || 3001;

testConnection().then(() => {
  server.listen(PORT, () => {
    console.log(`🙏 Prayer Warrior server running on port ${PORT}`);
  });
});

module.exports = app;
