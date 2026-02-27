const express = require('express');
const cors = require('cors');

const { v4: uuidv4 } = require('uuid');
const path = require('path');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3001;
const ADMIN_PIN = process.env.ADMIN_PIN || '198823';

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Database setup - use /tmp for Render compatibility
const dbPath = process.env.NODE_ENV === 'production' ? '/tmp/monitor-panel.db' : 'monitor-panel.db';
const db = new Database(dbPath);

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS playlists (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    source_url TEXT NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS analytics (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    playlist_id TEXT NOT NULL,
    ip_address TEXT,
    user_agent TEXT,
    device_type TEXT,
    device_name TEXT,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (playlist_id) REFERENCES playlists(id)
  );

  CREATE INDEX IF NOT EXISTS idx_analytics_playlist ON analytics(playlist_id);
  CREATE INDEX IF NOT EXISTS idx_analytics_timestamp ON analytics(timestamp);
`);

// Device detection function
function detectDevice(userAgent) {
  const ua = userAgent || '';

  // Smart TV patterns
  if (/Tizen|WebOS|Android\s+TV|CrKey|Roku|SamsungBrowser.*TV|LG\s+NetCast|Philips.*NetTV|HbbTV/.test(ua)) {
    return { type: 'tv', name: 'Smart TV' };
  }

  // Set-top box
  if (/Mag|Enigma2|STB|VU+|Formuler|OpenATV|Revision|Geexbox Kodi/.test(ua)) {
    return { type: 'tv', name: 'Set-top Box' };
  }

  // Mobile patterns
  if (/Android.*Mobile|iPhone|iPod.*Mobile|Mobile.*Android|webOS|iOS.*Mobile/.test(ua)) {
    return { type: 'mobile', name: 'Móvil' };
  }

  // Tablet patterns
  if (/iPad|Android.*Tablet|Tablet.*Android|Nexus\s+7|Nexus\s+10/.test(ua)) {
    return { type: 'tablet', name: 'Tablet' };
  }

  // PC patterns
  if (/Windows|Macintosh|Linux|VLC|QuickTime|PlayStation|Xbox/.test(ua)) {
    return { type: 'pc', name: 'PC' };
  }

  return { type: 'other', name: 'Desconocido' };
}

// Simple auth middleware (PIN based)
function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'];

  if (!authHeader || authHeader !== `Bearer ${ADMIN_PIN}`) {
    return res.status(401).json({ error: 'No autorizado' });
  }
  next();
}

// ============ AUTH ROUTES ============

app.post('/api/auth/login', (req, res) => {
  const { pin } = req.body;

  if (!pin) {
    return res.status(400).json({ error: 'PIN requerido' });
  }

  if (pin !== ADMIN_PIN) {
    return res.status(401).json({ error: 'PIN incorrecto' });
  }

  // Return simple token (just the PIN for simplicity)
  res.json({ token: ADMIN_PIN, message: 'Login exitoso' });
});

// ============ PLAYLIST ROUTES ============

app.get('/api/playlists', requireAuth, (req, res) => {
  const playlists = db.prepare(`
    SELECT p.*,
           (SELECT COUNT(*) FROM analytics WHERE playlist_id = p.id) as total_hits,
           (SELECT COUNT(DISTINCT ip_address) FROM analytics
            WHERE playlist_id = p.id AND timestamp > datetime('now', '-5 minutes')) as active_connections
    FROM playlists p
    ORDER BY p.created_at DESC
  `).all();

  res.json(playlists);
});

app.post('/api/playlists', requireAuth, (req, res) => {
  try {
    const { name, source_url } = req.body;

    if (!name || !source_url) {
      return res.status(400).json({ error: 'Nombre y URL son requeridos' });
    }

    const id = uuidv4().slice(0, 8);

    db.prepare(
      'INSERT INTO playlists (id, name, source_url) VALUES (?, ?, ?)'
    ).run(id, name, source_url);

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);
    res.json(playlist);
  } catch (error) {
    res.status(500).json({ error: 'Error al crear lista' });
  }
});

app.delete('/api/playlists/:id', requireAuth, (req, res) => {
  try {
    const { id } = req.params;

    db.prepare('DELETE FROM analytics WHERE playlist_id = ?').run(id);
    db.prepare('DELETE FROM playlists WHERE id = ?').run(id);

    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: 'Error al eliminar lista' });
  }
});

// ============ ANALYTICS ROUTES ============

app.get('/api/analytics', requireAuth, (req, res) => {
  try {
    const playlists = db.prepare('SELECT id FROM playlists').all();
    const playlistIds = playlists.map(p => p.id);

    if (playlistIds.length === 0) {
      return res.json({
        total_hits: 0,
        active_connections: 0,
        device_breakdown: [],
        playlists_count: 0
      });
    }

    const placeholders = playlistIds.map(() => '?').join(',');

    const totalHits = db.prepare(`
      SELECT COUNT(*) as count FROM analytics WHERE playlist_id IN (${placeholders})
    `).get(...playlistIds).count;

    const activeConnections = db.prepare(`
      SELECT COUNT(DISTINCT ip_address) as count FROM analytics
      WHERE playlist_id IN (${placeholders}) AND timestamp > datetime('now', '-5 minutes')
    `).get(...playlistIds).count;

    const deviceBreakdown = db.prepare(`
      SELECT device_type as type, COUNT(*) as count
      FROM analytics WHERE playlist_id IN (${placeholders})
      GROUP BY device_type
    `).all(...playlistIds);

    res.json({
      total_hits: totalHits,
      active_connections: activeConnections,
      device_breakdown: deviceBreakdown,
      playlists_count: playlistIds.length
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener analytics' });
  }
});

app.get('/api/analytics/:playlistId', requireAuth, (req, res) => {
  try {
    const { playlistId } = req.params;

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(playlistId);
    if (!playlist) {
      return res.status(404).json({ error: 'Lista no encontrada' });
    }

    const totalHits = db.prepare(
      'SELECT COUNT(*) as count FROM analytics WHERE playlist_id = ?'
    ).get(playlistId).count;

    const activeConnections = db.prepare(`
      SELECT COUNT(DISTINCT ip_address) as count FROM analytics
      WHERE playlist_id = ? AND timestamp > datetime('now', '-5 minutes')
    `).get(playlistId).count;

    const deviceBreakdown = db.prepare(`
      SELECT device_type as type, COUNT(*) as count
      FROM analytics WHERE playlist_id = ?
      GROUP BY device_type
    `).all(playlistId);

    const recentLogs = db.prepare(`
      SELECT ip_address, user_agent, device_type, device_name, timestamp
      FROM analytics WHERE playlist_id = ?
      ORDER BY timestamp DESC LIMIT 20
    `).all(playlistId);

    res.json({
      playlist,
      total_hits: totalHits,
      active_connections: activeConnections,
      device_breakdown: deviceBreakdown,
      recent_logs: recentLogs
    });
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener analytics' });
  }
});

app.get('/api/sessions/active', requireAuth, (req, res) => {
  try {
    const playlists = db.prepare('SELECT id, name FROM playlists').all();

    if (playlists.length === 0) {
      return res.json([]);
    }

    const playlistIds = playlists.map(p => p.id);
    const placeholders = playlistIds.map(() => '?').join(',');

    const sessions = db.prepare(`
      SELECT DISTINCT
        ip_address,
        device_type,
        device_name,
        MAX(timestamp) as last_seen,
        playlist_id
      FROM analytics
      WHERE playlist_id IN (${placeholders}) AND timestamp > datetime('now', '-5 minutes')
      GROUP BY ip_address, playlist_id
      ORDER BY last_seen DESC
    `).all(...playlistIds);

    const sessionsWithPlaylist = sessions.map(s => {
      const playlist = playlists.find(p => p.id === s.playlist_id);
      return {
        ...s,
        playlist_name: playlist?.name || 'Unknown'
      };
    });

    res.json(sessionsWithPlaylist);
  } catch (error) {
    res.status(500).json({ error: 'Error al obtener sesiones' });
  }
});

// ============ M3U PROXY ROUTES ============

// Proxy route - serves M3U content and logs request
app.get('/playlist/:id.m3u', async (req, res) => {
  try {
    const { id } = req.params;
    const clientIp = req.ip || req.connection?.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const userAgent = req.headers['user-agent'] || '';

    const playlist = db.prepare('SELECT * FROM playlists WHERE id = ?').get(id);

    if (!playlist) {
      return res.status(404).send('#EXTM3U\n#EXT-X-ERROR:Playlist not found');
    }

    // Detect device
    const device = detectDevice(userAgent);

    // Log access
    db.prepare(`
      INSERT INTO analytics (playlist_id, ip_address, user_agent, device_type, device_name)
      VALUES (?, ?, ?, ?, ?)
    `).run(id, clientIp, userAgent, device.type, device.name);

    // Fetch original M3U
    try {
      const urlObj = new URL(playlist.source_url);
      const isHttps = urlObj.protocol === 'https:';
      const client = isHttps ? https : http;

      const response = await new Promise((resolve, reject) => {
        const req = client.get(playlist.source_url, {
          headers: {
            'User-Agent': userAgent,
            'Accept': '*/*',
            'Referer': playlist.source_url
          },
          timeout: 10000
        }, (res) => {
          resolve(res);
        });

        req.on('error', reject);
        req.on('timeout', () => reject(new Error('Timeout')));
      });

      if (!response.statusCode || response.statusCode >= 400) {
        return res.status(502).send('#EXTM3U\n#EXT-X-ERROR:Failed to fetch source');
      }

      // Set appropriate headers for M3U
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.setHeader('Content-Type', 'audio/x-mpegurl');
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Referer, User-Agent');
      res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.setHeader('X-Content-Type-Options', 'nosniff');

      // Pipe the response
      response.pipe(res);
    } catch (fetchError) {
      console.error('Error fetching M3U:', fetchError.message);
      res.status(502).send('#EXTM3U\n#EXT-X-ERROR:Error connecting to source server');
    }
  } catch (error) {
    console.error('Proxy error:', error);
    res.status(500).send('#EXTM3U\n#EXT-X-ERROR:Internal server error');
  }
});

// Handle OPTIONS for CORS
app.options('/playlist/:id.m3u', (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, User-Agent');
  res.sendStatus(200);
});

// ============ FRONTEND ROUTES ============

// Serve index.html for all non-API routes (SPA)
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Health check
app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    name: 'Monitor Panel',
    version: '1.0.0'
  });
});

app.listen(PORT, () => {
  console.log(`Monitor Panel corriendo en puerto ${PORT}`);
  console.log(`PIN de acceso: ${ADMIN_PIN}`);
});
