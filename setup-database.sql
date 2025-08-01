-- Prayer Warrior Database Setup for PostgreSQL
-- Run this SQL in your Render PostgreSQL database

-- Create prayer_topics table
CREATE TABLE prayer_topics (
  id SERIAL PRIMARY KEY,
  title VARCHAR(255) NOT NULL,
  category VARCHAR(50) DEFAULT 'main',
  parent_id INTEGER REFERENCES prayer_topics(id) ON DELETE SET NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Create prayer_requests table
CREATE TABLE prayer_requests (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL,
  topic_id INTEGER NOT NULL REFERENCES prayer_topics(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  is_active BOOLEAN DEFAULT true,
  active_count INTEGER DEFAULT 0
);

-- Create prayer_sessions table
CREATE TABLE prayer_sessions (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(255) NOT NULL,
  request_id INTEGER NOT NULL REFERENCES prayer_requests(id) ON DELETE CASCADE,
  started_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  ended_at TIMESTAMP NULL
);

-- Create device_tokens table
CREATE TABLE device_tokens (
  id SERIAL PRIMARY KEY,
  device_id VARCHAR(255) UNIQUE NOT NULL,
  push_token VARCHAR(512),
  platform VARCHAR(20),
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- Insert prayer topics (hierarchical structure)
INSERT INTO prayer_topics (id, title, category, parent_id) VALUES
(1, 'Job', 'main', NULL),
(2, 'Money', 'main', NULL),
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
(15, 'Other - God will know', 'main', NULL);

-- Update the sequence to continue from 15
SELECT setval('prayer_topics_id_seq', 15, true);

-- Create indexes for better performance
CREATE INDEX idx_prayer_requests_topic_id ON prayer_requests(topic_id);
CREATE INDEX idx_prayer_requests_device_id ON prayer_requests(device_id);
CREATE INDEX idx_prayer_requests_active ON prayer_requests(is_active);
CREATE INDEX idx_prayer_sessions_request_id ON prayer_sessions(request_id);
CREATE INDEX idx_prayer_sessions_device_id ON prayer_sessions(device_id);
CREATE INDEX idx_prayer_sessions_ended_at ON prayer_sessions(ended_at);
CREATE INDEX idx_device_tokens_device_id ON device_tokens(device_id);
