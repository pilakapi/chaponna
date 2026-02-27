const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;
const PIN_CODE = "198823"; // 6-digit PIN for authentication

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Database
const db = new Database("monitor.db");

// Initialize tables
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    proxy_url TEXT,
    interval_seconds INTEGER DEFAULT 60,
    is_active INTEGER DEFAULT 1,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS metrics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    status_code INTEGER,
    response_time_ms INTEGER,
    viewers INTEGER DEFAULT 0,
    is_online INTEGER DEFAULT 0,
    error_message TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS device_stats (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    monitor_id INTEGER NOT NULL,
    device_type TEXT NOT NULL,
    device_info TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (monitor_id) REFERENCES monitors(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_metrics_monitor_time ON metrics(monitor_id, timestamp);
  CREATE INDEX IF NOT EXISTS idx_device_stats_monitor_time ON device_stats(monitor_id, timestamp);
`);

// ==========================================
// DEVICE DETECTION
// ==========================================

function detectDeviceType(userAgent) {
  if (!userAgent) return 'unknown';

  const ua = userAgent.toLowerCase();

  // TV detection (smart TVs, TV boxes, firestick, chromecast, apple tv)
  if (/tv|smarttv|googletv|appletv|roku|firetv|firetv|chromecast|android tv|netcast|nettv|hbbtv|ce-html|xbmc|playstation|nsd|netfront|boxee|kylo|roku|dlnadoc|sonytv|bravo|polestar/.test(ua)) {
    return 'tv';
  }

  // Tablet detection
  if (/tablet|ipad|tab|kindle|nexus 7|xoom|transformer|slider|m1|.2 7|.3 7|101ml|101g2|101tc|sm-t|sgp|gt-p|sm-p|android 3|playbook/.test(ua)) {
    return 'tablet';
  }

  // Mobile detection
  if (/mobile|iphone|ipod|android.*mobile|blackberry|opera mini|opera mobi|windows phone|symbian|series60|windows ce|palm|minimo|netfront|ucweb|bolt|iris|3g_t|windows mobile|zte|meego|huawei| Nokia | Android /.test(ua)) {
    return 'mobile';
  }

  // PC/Desktop default
  if (/windows|macintosh|linux|x11|unix|cros|chrome/.test(ua)) {
    return 'pc';
  }

  return 'unknown';
}

// ==========================================
// AUTH MIDDLEWARE
// ==========================================

function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization;

  if (!authHeader || authHeader !== `Bearer ${PIN_CODE}`) {
    return res.status(401).json({ error: "Acceso no autorizado" });
  }

  next();
}

// ==========================================
// API ENDPOINTS
// ==========================================

// Login with PIN
app.post("/api/login", (req, res) => {
  const { pin } = req.body;

  if (pin === PIN_CODE) {
    res.json({ success: true, token: PIN_CODE });
  } else {
    res.status(401).json({ error: "PIN incorrecto" });
  }
});

// Get all monitors with latest data
app.get("/api/monitors", (req, res) => {
  try {
    const monitors = db.prepare(`
      SELECT
        m.*,
        (SELECT status_code FROM metrics WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as last_status,
        (SELECT response_time_ms FROM metrics WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as last_response_time,
        (SELECT viewers FROM metrics WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as last_viewers,
        (SELECT is_online FROM metrics WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as last_online,
        (SELECT timestamp FROM metrics WHERE monitor_id = m.id ORDER BY timestamp DESC LIMIT 1) as last_check,
        (SELECT COUNT(*) FROM metrics WHERE monitor_id = m.id AND is_online = 1 AND timestamp > datetime('now', '-24 hours')) as uptime_24h,
        (SELECT COUNT(*) FROM metrics WHERE monitor_id = m.id AND timestamp > datetime('now', '-24 hours')) as total_checks_24h
      FROM monitors m
      WHERE m.is_active = 1
      ORDER BY m.created_at DESC
    `).all();

    // Get device stats for each monitor
    const monitorsWithDevices = monitors.map(monitor => {
      const deviceStats = db.prepare(`
        SELECT
          device_type,
          COUNT(*) as count
        FROM device_stats
        WHERE monitor_id = ? AND timestamp > datetime('now', '-1 hour')
        GROUP BY device_type
      `).all(monitor.id);

      const devices = { mobile: 0, tablet: 0, tv: 0, pc: 0, unknown: 0 };
      deviceStats.forEach(stat => {
        devices[stat.device_type] = stat.count;
      });

      return {
        ...monitor,
        devices
      };
    });

    res.json(monitorsWithDevices);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Create new monitor
app.post("/api/monitors", (req, res) => {
  const { name, url, interval_seconds = 60 } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: "Nombre y URL son requeridos" });
  }

  try {
    // Generate proxy URL
    const proxyUrl = `${req.protocol}://${req.get('host')}/stream/`;

    const result = db.prepare(`
      INSERT INTO monitors (name, url, proxy_url, interval_seconds) VALUES (?, ?, ?, ?)
    `).run(name, url, proxyUrl, interval_seconds);

    const newMonitor = db.prepare("SELECT * FROM monitors WHERE id = ?").get(result.lastInsertRowid);

    // Execute first check immediately
    checkMonitor(newMonitor);

    res.json(newMonitor);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Delete monitor
app.delete("/api/monitors/:id", (req, res) => {
  const { id } = req.params;

  try {
    db.prepare("DELETE FROM metrics WHERE monitor_id = ?").run(id);
    db.prepare("DELETE FROM device_stats WHERE monitor_id = ?").run(id);
    db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get metrics for a monitor
app.get("/api/metrics/:id", (req, res) => {
  const { id } = req.params;
  const { range = "24h" } = req.query;

  let timeFilter = "datetime('now', '-24 hours')";
  if (range === "7d") timeFilter = "datetime('now', '-7 days')";
  if (range === "30d") timeFilter = "datetime('now', '-30 days')";

  try {
    const metrics = db.prepare(`
      SELECT * FROM metrics
      WHERE monitor_id = ? AND timestamp > datetime(?)
      ORDER BY timestamp ASC
    `).all(id, timeFilter);

    res.json(metrics);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get device statistics for a monitor
app.get("/api/devices/:id", (req, res) => {
  const { id } = req.params;
  const { range = "24h" } = req.query;

  let timeFilter = "datetime('now', '-24 hours')";
  if (range === "7d") timeFilter = "datetime('now', '-7 days')";
  if (range === "30d") timeFilter = "datetime('now', '-30 days')";

  try {
    const stats = db.prepare(`
      SELECT
        device_type,
        COUNT(*) as count,
        MAX(timestamp) as last_seen
      FROM device_stats
      WHERE monitor_id = ? AND timestamp > datetime(?)
      GROUP BY device_type
      ORDER BY count DESC
    `).all(id, timeFilter);

    // Get time series data for devices
    const timeSeries = db.prepare(`
      SELECT
        strftime('%Y-%m-%d %H:00:00', timestamp) as hour,
        device_type,
        COUNT(*) as count
      FROM device_stats
      WHERE monitor_id = ? AND timestamp > datetime(?)
      GROUP BY hour, device_type
      ORDER BY hour ASC
    `).all(id, timeFilter);

    res.json({ stats, timeSeries });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Get aggregated statistics
app.get("/api/stats/:id", (req, res) => {
  const { id } = req.params;

  try {
    const stats = db.prepare(`
      SELECT
        COUNT(*) as total_checks,
        SUM(CASE WHEN is_online = 1 THEN 1 ELSE 0 END) as online_checks,
        AVG(response_time_ms) as avg_response_time,
        MAX(viewers) as max_viewers,
        AVG(viewers) as avg_viewers
      FROM metrics
      WHERE monitor_id = ? AND timestamp > datetime('now', '-24 hours')
    `).get(id);

    // Uptime percentage
    stats.uptime_percent = stats.total_checks > 0
      ? Math.round((stats.online_checks / stats.total_checks) * 100)
      : 0;

    // Get device breakdown
    const deviceStats = db.prepare(`
      SELECT
        device_type,
        COUNT(*) as count
      FROM device_stats
      WHERE monitor_id = ? AND timestamp > datetime('now', '-24 hours')
      GROUP BY device_type
    `).all(id);

    const devices = { mobile: 0, tablet: 0, tv: 0, pc: 0, unknown: 0 };
    deviceStats.forEach(stat => {
      devices[stat.device_type] = stat.count;
    });

    stats.devices = devices;

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle active/inactive
app.post("/api/monitors/:id/toggle", (req, res) => {
  const { id } = req.params;

  try {
    const monitor = db.prepare("SELECT is_active FROM monitors WHERE id = ?").get(id);
    const newStatus = monitor.is_active === 1 ? 0 : 1;

    db.prepare("UPDATE monitors SET is_active = ? WHERE id = ?").run(newStatus, id);

    res.json({ success: true, is_active: newStatus });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Generate new proxy URL for a monitor
app.post("/api/monitors/:id/regenerate-proxy", (req, res) => {
  const { id } = req.params;

  try {
    const monitor = db.prepare("SELECT * FROM monitors WHERE id = ?").get(id);
    if (!monitor) {
      return res.status(404).json({ error: "Monitor no encontrado" });
    }

    // Generate unique proxy token
    const token = Math.random().toString(36).substring(2) + Date.now().toString(36);
    const proxyUrl = `${req.protocol}://${req.get('host')}/stream/${token}`;

    db.prepare("UPDATE monitors SET proxy_url = ? WHERE id = ?").run(proxyUrl, id);

    res.json({ success: true, proxy_url: proxyUrl });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ==========================================
// PROXY STREAM ENDPOINT
// ==========================================

app.get("/stream/:token", async (req, res) => {
  const { token } = req.params;
  const userAgent = req.headers['user-agent'] || '';
  const deviceType = detectDeviceType(userAgent);

  try {
    // Find monitor by proxy token
    const proxyUrlBase = `${req.protocol}://${req.get('host')}/stream/`;
    const monitors = db.prepare("SELECT * FROM monitors WHERE is_active = 1").all();

    let monitor = null;
    for (const m of monitors) {
      if (m.proxy_url && m.proxy_url.includes(token)) {
        monitor = m;
        break;
      }
    }

    if (!monitor) {
      return res.status(404).send("Stream no encontrado");
    }

    // Record device access
    db.prepare(`
      INSERT INTO device_stats (monitor_id, device_type, device_info)
      VALUES (?, ?, ?)
    `).run(monitor.id, deviceType, JSON.stringify({
      userAgent: userAgent.substring(0, 500),
      ip: req.ip,
      referer: req.headers['referer'] || ''
    }));

    // Fetch and proxy the M3U content
    const response = await axios.get(monitor.url, {
      timeout: 15000,
      headers: {
        "User-Agent": userAgent || "M3U-Proxy/1.0"
      },
      responseType: 'text'
    });

    // Set appropriate headers
    res.set('Content-Type', 'application/vnd.apple.mpegurl');
    res.set('Access-Control-Allow-Origin', '*');
    res.set('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept');
    res.send(response.data);

  } catch (error) {
    console.error("Proxy error:", error.message);
    res.status(502).send("Error al obtener el stream");
  }
});

// ==========================================
// MONITORING WORKER
// ==========================================

async function checkMonitor(monitor) {
  const startTime = Date.now();

  try {
    const response = await axios.get(monitor.url, {
      timeout: 10000,
      headers: {
        "User-Agent": "M3U-Sentinel/1.0"
      }
    });

    const responseTime = Date.now() - startTime;
    const statusCode = response.status;

    // Try to get viewers from response if JSON
    let viewers = 0;
    try {
      if (response.headers['content-type'] && response.headers['content-type'].includes('application/json')) {
        const data = response.data;
        // Search for common viewer fields
        viewers = data.viewers || data.users || data.connections ||
                  data.active_users || data.current_viewers || 0;
      }
    } catch (e) {
      // Not JSON, ignore
    }

    db.prepare(`
      INSERT INTO metrics (monitor_id, status_code, response_time_ms, viewers, is_online, error_message)
      VALUES (?, ?, ?, ?, 1, NULL)
    `).run(monitor.id, statusCode, responseTime, viewers);

  } catch (error) {
    const responseTime = Date.now() - startTime;
    const statusCode = error.response ? error.response.status : 0;
    const errorMessage = error.message;

    db.prepare(`
      INSERT INTO metrics (monitor_id, status_code, response_time_ms, viewers, is_online, error_message)
      VALUES (?, ?, ?, 0, 0, ?)
    `).run(monitor.id, statusCode, responseTime, errorMessage);
  }
}

// Worker that runs every 30 seconds
function startWorker() {
  console.log("🔄 Starting monitoring worker...");

  setInterval(() => {
    try {
      const monitors = db.prepare(`
        SELECT * FROM monitors
        WHERE is_active = 1
      `).all();

      monitors.forEach(monitor => {
        checkMonitor(monitor);
      });

      if (monitors.length > 0) {
        console.log(`✅ Checks completed: ${monitors.length} monitors`);
      }
    } catch (error) {
      console.error("❌ Worker error:", error.message);
    }
  }, 30000); // Every 30 seconds
}

// Cleanup old data (keep only 30 days)
function cleanupOldData() {
  setInterval(() => {
    try {
      db.prepare(`
        DELETE FROM metrics
        WHERE timestamp < datetime('now', '-30 days')
      `).run();

      db.prepare(`
        DELETE FROM device_stats
        WHERE timestamp < datetime('now', '-30 days')
      `).run();

      console.log("🧹 Old data cleanup completed");
    } catch (error) {
      console.error("❌ Cleanup error:", error.message);
    }
  }, 86400000); // Once a day
}

// Start server
app.listen(PORT, () => {
  console.log("========================================");
  console.log("  Monitor started");
  console.log("  Port: " + PORT);
  console.log("  Dashboard: http://localhost:" + PORT);
  console.log("  PIN Code: " + PIN_CODE);
  console.log("========================================");

  startWorker();
  cleanupOldData();
});
