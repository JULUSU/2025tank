const path = require('path');
const fs = require('fs');
const express = require('express');
const cors = require('cors');
const { Server } = require('socket.io');
const http = require('http');

const GameEngine = require('./server/gameEngine');

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// 确保数据目录存在
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) fs.mkdirSync(dataDir, { recursive: true });
for (const f of ['matches.log.jsonl','units_balancing.log.jsonl']) {
  const p = path.join(dataDir, f);
  if (!fs.existsSync(p)) fs.writeFileSync(p, '');
}

app.get('/health', (req, res) => res.json({ ok: true }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

const engine = new GameEngine(io);

io.on('connection', (socket) => {
  engine.attachSocket(socket);
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Server running on :${PORT}`);
});
