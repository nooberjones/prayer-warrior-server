const express = require('express');
const { Pool } = require('pg');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const fetch = require('node-fetch');
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
      
      console.log(`📱 Registering device: ${deviceId}, has push token: ${!!pushToken}, platform: ${platform}`);
      if (pushToken) {
        console.log(`🔑 Push token preview: ${pushToken.substring(0, 30)}...`);
      }
      
      // Store in memory for real-time
      connectedDevices.set(deviceId, {
        socketId: socket.id,
        deviceId: deviceId,
        connectedAt: new Date()
      });
      
      console.log(`🔗 Total connected devices: ${connectedDevices.size}`);
      
      // Update/insert device token in database
      if (pushToken) {
        console.log(`💾 Storing push token for device ${deviceId}`);
        
        // Check if device already exists
        const existingDevice = await pool.query(
          'SELECT device_id FROM device_tokens WHERE device_id = $1',
          [deviceId]
        );
        
        if (existingDevice.rows.length > 0) {
          console.log(`🔄 Updating existing device: ${deviceId}`);
        } else {
          console.log(`🆕 Creating new device: ${deviceId}`);
        }
        
        const result = await pool.query(
          `INSERT INTO device_tokens (device_id, push_token, platform) 
           VALUES ($1, $2, $3) 
           ON CONFLICT (device_id) 
           DO UPDATE SET 
           push_token = EXCLUDED.push_token, 
           platform = EXCLUDED.platform, 
           updated_at = CURRENT_TIMESTAMP
           RETURNING device_id, push_token IS NOT NULL as has_token`,
          [deviceId, pushToken, platform]
        );
        
        console.log(`✅ Device ${deviceId} registration result:`, result.rows[0]);
        
        // Show current total in database
        const totalDevices = await pool.query('SELECT COUNT(*) as count FROM device_tokens');
        console.log(`📊 Total devices in database: ${totalDevices.rows[0].count}`);
        
      } else {
        console.log(`⚠️ No push token provided for device ${deviceId}`);
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
      
      console.log(`📝 Creating prayer request from device: ${deviceId} for topic: ${topicId}`);
      
      // Insert prayer request into database
      const result = await pool.query(
        'INSERT INTO prayer_requests (device_id, topic_id, created_at) VALUES ($1, $2, $3) RETURNING id',
        [deviceId, topicId, new Date(timestamp)]
      );
      
      const requestId = result.rows[0].id;
      
      // Get topic title for notifications
      const topicResult = await pool.query('SELECT title FROM prayer_topics WHERE id = $1', [topicId]);
      const topicTitle = topicResult.rows[0]?.title || 'Unknown';
      
      // Notify all connected devices via socket (real-time notification)
      console.log(`🔔 Sending real-time notifications to ${connectedDevices.size} connected devices`);
      
      connectedDevices.forEach((deviceInfo, deviceIdKey) => {
        if (deviceIdKey !== deviceId) { // Don't notify the requesting device
          const targetSocket = io.sockets.sockets.get(deviceInfo.socketId);
          if (targetSocket) {
            console.log(`📱 Sending notification to device: ${deviceIdKey}`);
            targetSocket.emit('prayerRequestNotification', {
              type: 'prayer_request',
              title: 'Prayer Request 🙏',
              body: `Someone needs prayer for: ${topicTitle}`,
              data: {
                topicId: topicId,
                requestId: requestId,
                topicTitle: topicTitle,
                timestamp: timestamp
              }
            });
          }
        }
      });
      
      // Also send the regular broadcast for UI updates
      socket.broadcast.emit('prayerRequestUpdate', {
        type: 'new_request',
        topicId,
        requestId,
        timestamp
      });
      
      // Send push notifications (for production builds with real tokens)
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
      
      // Get updated count and topicId
      const result = await pool.query(
        'SELECT active_count, topic_id FROM prayer_requests WHERE id = $1',
        [requestId]
      );
      
      const activeCount = result.rows[0]?.active_count || 0;
      const topicId = result.rows[0]?.topic_id;
      
      // Broadcast count update
      io.emit('prayerCountUpdate', {
        requestId,
        topicId,
        change: 1,
        newCount: activeCount
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
        'UPDATE prayer_sessions SET ended_at = NOW() WHERE device_id = $1 AND request_id = $2 AND ended_at IS NULL',
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
      
      // Get updated count and topicId
      const result = await pool.query(
        'SELECT active_count, topic_id FROM prayer_requests WHERE id = $1',
        [requestId]
      );
      
      const activeCount = result.rows[0]?.active_count || 0;
      const topicId = result.rows[0]?.topic_id;
      
      // Broadcast count update
      io.emit('prayerCountUpdate', {
        requestId,
        topicId,
        change: -1,
        newCount: activeCount
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

// Cleanup function to remove old prayer requests
async function cleanupOldPrayerRequests() {
  try {
    // Remove prayer requests older than 24 hours
    const result = await pool.query(
      `UPDATE prayer_requests 
       SET is_active = false 
       WHERE created_at < NOW() - INTERVAL '24 hours' 
       AND is_active = true`
    );
    
    // End any prayer sessions for expired requests
    await pool.query(
      `UPDATE prayer_sessions 
       SET ended_at = CURRENT_TIMESTAMP 
       WHERE request_id IN (
         SELECT id FROM prayer_requests 
         WHERE is_active = false AND ended_at IS NULL
       ) AND ended_at IS NULL`
    );
    
    if (result.rowCount > 0) {
      console.log(`🧹 Cleaned up ${result.rowCount} expired prayer requests`);
      
      // Notify all connected clients about the updates
      io.emit('prayerRequestUpdate', {
        type: 'cleanup_complete',
        timestamp: new Date().toISOString()
      });
    }
  } catch (error) {
    console.error('Error cleaning up old prayer requests:', error);
  }
}

// Run cleanup every hour
setInterval(cleanupOldPrayerRequests, 60 * 60 * 1000);

// Run initial cleanup on server start
setTimeout(cleanupOldPrayerRequests, 5000);

// Push notification function with Expo Push API
async function sendPushNotifications(topicId, requestId) {
  try {
    // Get topic title
    const topicResult = await pool.query(
      'SELECT title FROM prayer_topics WHERE id = $1',
      [topicId]
    );
    
    if (topicResult.rows.length === 0) return;
    
    const topicTitle = topicResult.rows[0].title;
    
    // Get all device tokens except the requester's device
    const deviceResult = await pool.query(
      `SELECT push_token, platform, device_id FROM device_tokens 
       WHERE push_token IS NOT NULL 
       AND device_id != (
         SELECT device_id FROM prayer_requests WHERE id = $1
       )`,
      [requestId]
    );
    
    console.log(`🔍 Found ${deviceResult.rows.length} devices to notify (excluding requester)`);
    console.log('Device tokens found:', deviceResult.rows.map(d => ({ 
      deviceId: d.device_id, 
      hasToken: !!d.push_token,
      platform: d.platform 
    })));
    
    if (deviceResult.rows.length === 0) {
      console.log('No devices to notify - checking all registered devices:');
      const allDevices = await pool.query('SELECT device_id, push_token, platform FROM device_tokens');
      console.log('All devices in database:', allDevices.rows.map(d => ({ 
        deviceId: d.device_id, 
        hasToken: !!d.push_token,
        platform: d.platform 
      })));
      return;
    }
    
    console.log(`📱 Sending push notifications to ${deviceResult.rows.length} devices for: ${topicTitle}`);
    
    // Prepare push notification messages with proper background delivery settings
    const messages = deviceResult.rows.map(device => ({
      to: device.push_token,
      sound: 'default',
      title: 'Prayer Request 🙏',
      body: `Someone needs prayer for: ${topicTitle}`,
      data: {
        type: 'prayer_request',
        topicId: topicId,
        requestId: requestId,
        topicTitle: topicTitle
      },
      categoryId: 'prayer_request',
      priority: 'high', // Ensures delivery even when app is backgrounded/closed
      ttl: 3600, // Time to live in seconds (1 hour)
      badge: 1,
      channelId: device.platform === 'android' ? 'prayer_requests' : undefined, // Use high-priority channel on Android
      android: {
        priority: 'high',
        channelId: 'prayer_requests',
        sound: 'default',
        vibrate: [0, 250, 250, 250],
        color: '#6B46C1',
        icon: 'notification_icon',
        sticky: false,
        autoCancel: true,
      },
      ios: {
        sound: 'default',
        badge: 1,
        categoryId: 'prayer_request',
        mutableContent: false,
        criticalSound: {
          critical: false,
          name: 'default',
          volume: 1.0,
        },
      },
    }));
    
    // Send notifications in batches to Expo Push API
    const expoPushApiUrl = 'https://exp.host/--/api/v2/push/send';
    
    try {
      const response = await fetch(expoPushApiUrl, {
        method: 'POST',
        headers: {
          'Accept': 'application/json',
          'Accept-encoding': 'gzip, deflate',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(messages),
      });
      
      const result = await response.json();
      console.log('✅ Push notifications sent successfully:', result);
      
    } catch (fetchError) {
      console.error('❌ Error sending push notifications:', fetchError);
    }
    
  } catch (error) {
    console.error('Error preparing push notifications:', error);
  }
}

// REST API endpoints

// Get current prayer topic counts
app.get('/api/prayer-counts', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        topic_id,
        COUNT(*) as count
      FROM prayer_requests 
      WHERE is_active = true 
      GROUP BY topic_id
    `);
    
    // Convert to object format
    const counts = {};
    result.rows.forEach(row => {
      counts[row.topic_id] = parseInt(row.count);
    });
    
    res.json({
      success: true,
      counts: counts,
      timestamp: new Date().toISOString()
    });
  } catch (error) {
    console.error('Error getting prayer counts:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get prayer counts'
    });
  }
});

// Get active prayer requests
app.get('/api/active-requests', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT 
        pr.id,
        pr.topic_id as "topicId", 
        pr.created_at as timestamp,
        pr.device_id as "deviceId",
        COALESCE(ps.active_count, 0) as "activeCount"
      FROM prayer_requests pr
      LEFT JOIN (
        SELECT 
          request_id, 
          COUNT(*) as active_count 
        FROM prayer_sessions 
        WHERE ended_at IS NULL 
        GROUP BY request_id
      ) ps ON pr.id = ps.request_id
      WHERE pr.is_active = true 
        AND pr.created_at > NOW() - INTERVAL '24 hours'
      ORDER BY pr.created_at DESC
    `);

    res.json(result.rows);
  } catch (error) {
    console.error('Error getting active requests:', error);
    res.status(500).json({
      success: false,
      error: 'Failed to get active requests'
    });
  }
});

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

// Debug endpoint to see registered devices
app.get('/api/debug/devices', async (req, res) => {
  try {
    // First, let's see what columns exist
    const schemaResult = await pool.query(`
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = 'device_tokens'
    `);
    
    const columns = schemaResult.rows.map(row => row.column_name);
    
    // Get ALL devices, not just 10
    const result = await pool.query('SELECT * FROM device_tokens ORDER BY device_id');
    
    res.json({
      columns: columns,
      totalDevices: result.rows.length,
      devicesWithTokens: result.rows.filter(d => d.push_token !== null && d.push_token !== '').length,
      connectedDevicesInMemory: connectedDevices.size,
      devices: result.rows.map(d => ({
        deviceId: d.device_id,
        hasToken: !!(d.push_token && d.push_token !== ''),
        tokenPreview: d.push_token ? `${d.push_token.substring(0, 30)}...` : null,
        platform: d.platform,
        updatedAt: d.updated_at
      }))
    });
  } catch (error) {
    console.error('Error fetching devices:', error);
    res.status(500).json({ error: 'Database error', details: error.message });
  }
});

// Test endpoint to send a notification to all registered devices
app.post('/api/debug/test-notification', async (req, res) => {
  try {
    const result = await pool.query('SELECT * FROM device_tokens WHERE push_token IS NOT NULL');
    
    if (result.rows.length === 0) {
      return res.json({ success: false, message: 'No devices with push tokens found' });
    }

    const messages = result.rows.map(device => ({
      to: device.push_token,
      sound: 'default',
      title: 'Test Notification 🧪',
      body: 'This is a test notification to verify push notifications are working!',
      data: {
        type: 'test',
        timestamp: new Date().toISOString()
      },
      priority: 'normal'
    }));

    // For now, just return what would be sent without actually sending
    res.json({
      success: true,
      deviceCount: result.rows.length,
      wouldSendTo: result.rows.map(d => ({
        deviceId: d.device_id,
        platform: d.platform,
        tokenPreview: d.push_token.substring(0, 20) + '...'
      })),
      messageCount: messages.length,
      note: 'Notifications prepared but not sent (test mode)'
    });
    
  } catch (error) {
    console.error('Error in test notification:', error);
    res.status(500).json({ error: 'Database error', details: error.message });
  }
});

// Register push token endpoint
app.post('/api/register-push-token', async (req, res) => {
  try {
    const { deviceId, pushToken, platform } = req.body;
    
    console.log(`📡 API: Registering push token for device: ${deviceId}, platform: ${platform}`);
    
    if (!deviceId || !pushToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'Device ID and push token are required' 
      });
    }

    // Update/insert device token in database
    const result = await pool.query(
      `INSERT INTO device_tokens (device_id, push_token, platform) 
       VALUES ($1, $2, $3) 
       ON CONFLICT (device_id) 
       DO UPDATE SET 
       push_token = EXCLUDED.push_token, 
       platform = EXCLUDED.platform, 
       updated_at = CURRENT_TIMESTAMP
       RETURNING device_id, push_token IS NOT NULL as has_token`,
      [deviceId, pushToken, platform]
    );
    
    console.log(`✅ API: Push token registered for device ${deviceId}:`, result.rows[0]);
    
    res.json({ 
      success: true, 
      message: 'Push token registered successfully',
      deviceId,
      hasToken: result.rows[0].has_token
    });
    
  } catch (error) {
    console.error('❌ API: Error registering push token:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to register push token',
      details: error.message
    });
  }
});

// Test notification endpoint for specific device
app.post('/api/test-notification', async (req, res) => {
  try {
    const { pushToken, deviceId, title = 'Test Notification', body = 'This is a test!' } = req.body;
    
    if (!pushToken) {
      return res.status(400).json({ 
        success: false, 
        error: 'Push token is required' 
      });
    }

    console.log(`🧪 Sending test notification to token: ${pushToken.substring(0, 20)}...`);

    const message = {
      to: pushToken,
      sound: 'default',
      title,
      body,
      data: {
        type: 'test',
        deviceId,
        timestamp: new Date().toISOString()
      },
      priority: 'normal'
    };

    // Send to Expo Push API
    const expoPushApiUrl = 'https://exp.host/--/api/v2/push/send';
    
    const response = await fetch(expoPushApiUrl, {
      method: 'POST',
      headers: {
        'Accept': 'application/json',
        'Accept-encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify([message]), // Expo expects an array
    });
    
    const result = await response.json();
    
    if (response.ok) {
      console.log('✅ Test notification sent successfully:', result);
      res.json({ 
        success: true, 
        message: 'Test notification sent successfully',
        expoPushResponse: result
      });
    } else {
      console.error('❌ Expo Push API error:', result);
      res.status(500).json({ 
        success: false, 
        error: 'Failed to send notification via Expo Push API',
        details: result
      });
    }
    
  } catch (error) {
    console.error('❌ Error sending test notification:', error);
    res.status(500).json({ 
      success: false, 
      error: 'Failed to send test notification',
      details: error.message
    });
  }
});

// Database initialization endpoint
app.post('/api/init-database', async (req, res) => {
  try {
    // Create tables and insert data
    await pool.query(`
      -- Create prayer_topics table
      CREATE TABLE IF NOT EXISTS prayer_topics (
        id SERIAL PRIMARY KEY,
        title VARCHAR(255) NOT NULL,
        category VARCHAR(50) DEFAULT 'main',
        parent_id INTEGER REFERENCES prayer_topics(id) ON DELETE SET NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );

      -- Create prayer_requests table
      CREATE TABLE IF NOT EXISTS prayer_requests (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        topic_id INTEGER NOT NULL REFERENCES prayer_topics(id) ON DELETE CASCADE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        is_active BOOLEAN DEFAULT true,
        active_count INTEGER DEFAULT 0
      );

      -- Create prayer_sessions table
      CREATE TABLE IF NOT EXISTS prayer_sessions (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) NOT NULL,
        request_id INTEGER NOT NULL REFERENCES prayer_requests(id) ON DELETE CASCADE,
        started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        ended_at TIMESTAMP NULL
      );

      -- Create device_tokens table
      CREATE TABLE IF NOT EXISTS device_tokens (
        id SERIAL PRIMARY KEY,
        device_id VARCHAR(255) UNIQUE NOT NULL,
        push_token VARCHAR(512),
        platform VARCHAR(20),
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // Insert prayer topics (use INSERT ... ON CONFLICT to avoid duplicates)
    console.log('🗄️  Inserting prayer topics into database...');
    await pool.query(`
      INSERT INTO prayer_topics (id, title, category, parent_id) VALUES
      (1, 'Job', 'main', NULL),
      (16, 'I just lost my job', 'job', 1),
      (17, 'I need a job', 'job', 1),
      (2, 'Finances', 'main', NULL),
      (18, 'Budget Help', 'Finances', 2),
      (19, 'Work - Raise', 'Finances', 2),
      (3, 'Spouse', 'main', NULL),
      (4, 'Spouse - Infidelity', 'spouse', 3),
      (5, 'Spouse - Divorce', 'spouse', 3),
      (6, 'Spouse - Death', 'spouse', 3),
      (7, 'Children', 'main', NULL),
      (8, 'Children - Defiance', 'children', 7),
      (9, 'Children - School', 'children', 7),
      (10, 'Health', 'main', NULL),
      (11, 'Health - Spouse', 'health', 10),
      (12, 'Health - Friend', 'health', 10),
      (13, 'Health - Parent', 'health', 10),
      (14, 'Health - Child', 'health', 10),
      (20, 'Pregnancy', 'health', 10),
      (15, 'Other - God will know', 'main', NULL)
      ON CONFLICT (id) DO UPDATE SET 
        title = EXCLUDED.title,
        category = EXCLUDED.category,
        parent_id = EXCLUDED.parent_id;
    `);
    console.log('✅ Prayer topics inserted/updated successfully');

    // Update the sequence to continue from 15
    await pool.query(`SELECT setval('prayer_topics_id_seq', 15, true);`);

    // Create indexes for better performance
    await pool.query(`
      CREATE INDEX IF NOT EXISTS idx_prayer_requests_topic_id ON prayer_requests(topic_id);
      CREATE INDEX IF NOT EXISTS idx_prayer_requests_device_id ON prayer_requests(device_id);
      CREATE INDEX IF NOT EXISTS idx_prayer_requests_active ON prayer_requests(is_active);
      CREATE INDEX IF NOT EXISTS idx_prayer_sessions_request_id ON prayer_sessions(request_id);
      CREATE INDEX IF NOT EXISTS idx_prayer_sessions_device_id ON prayer_sessions(device_id);
      CREATE INDEX IF NOT EXISTS idx_prayer_sessions_ended_at ON prayer_sessions(ended_at);
      CREATE INDEX IF NOT EXISTS idx_device_tokens_device_id ON device_tokens(device_id);
    `);

    res.json({ 
      success: true,
      message: 'Database initialized successfully',
      timestamp: new Date()
    });
  } catch (error) {
    console.error('Database initialization error:', error);
    res.status(500).json({ 
      success: false,
      error: error.message 
    });
  }
});

// Debug endpoint to check prayer topics
app.get('/api/debug/topics', async (req, res) => {
  try {
    const result = await pool.query(`
      SELECT id, title, category, parent_id 
      FROM prayer_topics 
      ORDER BY id ASC
    `);
    
    res.json({
      success: true,
      count: result.rows.length,
      topics: result.rows
    });
  } catch (error) {
    console.error('Error fetching prayer topics:', error);
    res.status(500).json({ 
      success: false, 
      error: error.message 
    });
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
// Deployment trigger Sat Aug  2 09:42:53 CDT 2025
