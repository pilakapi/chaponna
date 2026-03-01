const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");
const { spawn } = require("child_process");
const { Pool } = require("pg");

const app = express();
const PORT = process.env.PORT || 3000;
const PIN = process.env.ADMIN_PIN || "198823";

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false }
});

let procesos = {};

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.json());

app.use(session({
  secret: "supersecretkey",
  resave: false,
  saveUninitialized: false
}));

// Crear tabla si no existe
async function initDB() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS canales (
      id SERIAL PRIMARY KEY,
      nombre TEXT NOT NULL,
      url TEXT NOT NULL
    )
  `);
}

async function obtenerCanales() {
  const res = await pool.query("SELECT * FROM canales ORDER BY id ASC");
  return res.rows;
}

function iniciarCanal(canal) {
  if (procesos[canal.id]) return;

  const ejecutar = () => {
    const proceso = spawn("ffmpeg", [
      "-loglevel", "error",
      "-reconnect", "1",
      "-reconnect_streamed", "1",
      "-reconnect_delay_max", "5",
      "-i", canal.url,
      "-c", "copy",
      "-f", "null",
      "-"
    ]);

    procesos[canal.id] = proceso;

    proceso.on("close", () => {
      delete procesos[canal.id];
      setTimeout(ejecutar, 5000);
    });
  };

  ejecutar();
}

async function reiniciarTodos() {
  Object.values(procesos).forEach(p => p.kill());
  procesos = {};
  const canales = await obtenerCanales();
  canales.forEach(iniciarCanal);
}

// Middleware auth
function auth(req, res, next) {
  if (req.session.auth) return next();
  res.redirect("/login");
}

// Login
app.get("/login", (req, res) => {
  res.send(`
    <h2>Panel de Acceso</h2>
    <form method="POST">
      <input type="password" name="pin" maxlength="6" required />
      <button>Entrar</button>
    </form>
  `);
});

app.post("/login", (req, res) => {
  if (req.body.pin === PIN) {
    req.session.auth = true;
    res.redirect("/");
  } else {
    res.send("PIN incorrecto");
  }
});

// Panel
app.get("/", auth, async (req, res) => {
  const canales = await obtenerCanales();
  let lista = canales.map(c => `
    <li>
      ${c.nombre}
      <a href="/delete/${c.id}">Eliminar</a>
    </li>
  `).join("");

  res.send(`
    <h2>Panel Streams</h2>
    <ul>${lista}</ul>
    <h3>Agregar Canal</h3>
    <form method="POST" action="/add">
      <input name="nombre" placeholder="Nombre" required />
      <input name="url" placeholder="URL m3u8" required />
      <button>Guardar</button>
    </form>
    <br><a href="/status">Ver Estado</a>
  `);
});

// Agregar
app.post("/add", auth, async (req, res) => {
  await pool.query(
    "INSERT INTO canales (nombre, url) VALUES ($1, $2)",
    [req.body.nombre, req.body.url]
  );
  await reiniciarTodos();
  res.redirect("/");
});

// Eliminar
app.get("/delete/:id", auth, async (req, res) => {
  await pool.query("DELETE FROM canales WHERE id=$1", [req.params.id]);
  await reiniciarTodos();
  res.redirect("/");
});

// Estado
app.get("/status", auth, async (req, res) => {
  const canales = await obtenerCanales();
  res.json({
    activos: Object.keys(procesos).length,
    canales
  });
});

app.listen(PORT, async () => {
  await initDB();
  await reiniciarTodos();
  console.log("Panel iniciado con Neon");
});