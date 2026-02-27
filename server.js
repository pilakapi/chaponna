const express = require("express");
const axios = require("axios");
const cors = require("cors");
const path = require("path");
const Database = require("better-sqlite3");

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Base de datos
const db = new Database("monitor.db");

// Inicializar tablas
db.exec(`
  CREATE TABLE IF NOT EXISTS monitors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
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

  CREATE INDEX IF NOT EXISTS idx_metrics_monitor_time ON metrics(monitor_id, timestamp);
`);

// ==========================================
// ENDPOINTS API
// ==========================================

// Obtener todos los monitores con últimos datos
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

    res.json(monitors);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Crear nuevo monitor
app.post("/api/monitors", (req, res) => {
  const { name, url, interval_seconds = 60 } = req.body;

  if (!name || !url) {
    return res.status(400).json({ error: "Nombre y URL son requeridos" });
  }

  try {
    const result = db.prepare(`
      INSERT INTO monitors (name, url, interval_seconds) VALUES (?, ?, ?)
    `).run(name, url, interval_seconds);

    const newMonitor = db.prepare("SELECT * FROM monitors WHERE id = ?").get(result.lastInsertRowid);

    // Ejecutar primer check inmediatamente
    checkMonitor(newMonitor);

    res.json(newMonitor);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Eliminar monitor
app.delete("/api/monitors/:id", (req, res) => {
  const { id } = req.params;

  try {
    db.prepare("DELETE FROM metrics WHERE monitor_id = ?").run(id);
    db.prepare("DELETE FROM monitors WHERE id = ?").run(id);
    res.json({ success: true });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Obtener métricas de un monitor
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

// Obtener estadísticas agregadas
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

    res.json(stats);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Toggle activo/inactivo
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

// ==========================================
// WORKER DE MONITOREO
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

    // Intentar obtener viewers del response si es JSON
    let viewers = 0;
    try {
      if (response.headers['content-type'] && response.headers['content-type'].includes('application/json')) {
        const data = response.data;
        // Buscar campos comunes de viewers
        viewers = data.viewers || data.users || data.connections ||
                  data.active_users || data.current_viewers || 0;
      }
    } catch (e) {
      // No es JSON, ignoramos
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

// Worker que corre cada 30 segundos
function startWorker() {
  console.log("🔄 Iniciando worker de monitoreo...");

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
        console.log(`✅ Checks completados: ${monitors.length} monitores`);
      }
    } catch (error) {
      console.error("❌ Error en worker:", error.message);
    }
  }, 30000); // Cada 30 segundos
}

// Cleanup de datos antiguos (mantener solo 30 días)
function cleanupOldData() {
  setInterval(() => {
    try {
      db.prepare(`
        DELETE FROM metrics
        WHERE timestamp < datetime('now', '-30 days')
      `).run();
      console.log("🧹 Limpieza de datos antiguos completada");
    } catch (error) {
      console.error("❌ Error en cleanup:", error.message);
    }
  }, 86400000); // Una vez al día
}

// Iniciar servidor
app.listen(PORT, () => {
  console.log("========================================");
  console.log("  M3U Sentinel Monitor iniciado");
  console.log("  Puerto: " + PORT);
  console.log("  Dashboard: http://localhost:" + PORT);
  console.log("========================================");

  startWorker();
  cleanupOldData();
});
