const express = require("express");
const http = require("http");
const { Server } = require("socket.io");

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static("public"));

const rooms = new Map();

function code() {
  return Math.random().toString(36).substring(2, 7).toUpperCase();
}

function sendRoom(room) {
  io.to(room.code).emit("state", {
    players: room.players.map(p => ({
      name: p.name,
      alive: p.alive,
      host: p.id === room.host
    })),
    phase: room.phase,
    time: room.time,
    day: room.day,
    started: room.started
  });
}

function privateMessage(id, message) {
  io.to(id).emit("notice", message);
}

function giveRoles(room) {
  const roles = [
    "Mafiyaboshi",
    "Hufya",
    "Mafia",
    "Mafia",
    "Hamsoya"
  ];

  while (roles.length < room.players.length) {
    roles.push("Tinch aholi");
  }

  for (let i = roles.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [roles[i], roles[j]] = [roles[j], roles[i]];
  }

  room.players.forEach((p, i) => {
    p.role = roles[i];
    p.alive = true;
  });

  room.players.forEach(p => {
    privateMessage(p.id, {
      type: "role",
      role: p.role
    });

    if (["Mafia", "Mafiyaboshi", "Hufya"].includes(p.role)) {
      privateMessage(p.id, {
        type: "team",
        players: room.players
          .filter(x => ["Mafia", "Mafiyaboshi", "Hufya"].includes(x.role))
          .map(x => x.name)
      });
    }

    if (p.role === "Hufya") {
      privateMessage(p.id, {
        type: "allroles",
        players: room.players.map(x => ({
          name: x.name,
          role: x.role
        }))
      });
    }
  });
}

function alive(room) {
  return room.players.filter(p => p.alive);
}

function mafiaTeam(p) {
  return ["Mafia", "Mafiyaboshi", "Hufya"].includes(p.role);
}

function checkWinner(room) {
  const living = alive(room);
  const mafia = living.filter(mafiaTeam).length;
  const town = living.length - mafia;

  if (mafia === 0) return "Tinch aholi";
  if (mafia >= town) return "Mafiya";
  return null;
}

function endGame(room, winner) {
  room.phase = "finished";
  room.started = false;
  clearInterval(room.timer);

  io.to(room.code).emit("finished", {
    winner,
    players: room.players.map(p => ({
      name: p.name,
      role: p.role,
      alive: p.alive
    }))
  });

  sendRoom(room);
}

function nextNight(room) {
  room.phase = "night";
  room.time = 30;
  room.actions = {};
  room.watch = {};

  io.to(room.code).emit("phase", {
    phase: "night",
    day: room.day,
    time: room.time
  });

  sendRoom(room);
}

function nextDay(room) {
  room.phase = "day";
  room.time = Math.max(30, 120 - (room.day - 1) * 10);
  room.votes = {};

  io.to(room.code).emit("phase", {
    phase: "day",
    day: room.day,
    time: room.time
  });

  sendRoom(room);
}

function resolveNight(room) {
  const targets = Object.values(room.actions);
  const counts = {};

  targets.forEach(id => {
    counts[id] = (counts[id] || 0) + 1;
  });

  let victimId = null;
  let max = 0;

  Object.entries(counts).forEach(([id, n]) => {
    if (n > max) {
      max = n;
      victimId = id;
    }
  });

  if (victimId) {
    const victim = room.players.find(p => p.id === victimId);
    if (victim && victim.alive) {
      victim.alive = false;
      io.to(room.code).emit("announcement",
        victim.name + " bugun tunda o'yindan chiqdi."
      );
    }
  }

  for (const [observerId, targetId] of Object.entries(room.watch)) {
    const observer = room.players.find(p => p.id === observerId);
    if (!observer || !observer.alive) continue;

    const visitors = Object.entries(room.actions)
      .filter(([visitor, target]) => target === targetId)
      .map(([visitor]) => room.players.find(p => p.id === visitor))
      .filter(Boolean)
      .map(p => p.name);

    privateMessage(observerId, {
      type: "watch",
      target: room.players.find(p => p.id === targetId)?.name,
      visitors
    });
  }

  const winner = checkWinner(room);
  if (winner) return endGame(room, winner);

  room.day++;
  nextDay(room);
}

function resolveDay(room) {
  const counts = {};

  Object.values(room.votes).forEach(id => {
    counts[id] = (counts[id] || 0) + 1;
  });

  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);

  if (entries.length && (!entries[1] || entries[0][1] > entries[1][1])) {
    const player = room.players.find(p => p.id === entries[0][0]);
    if (player && player.alive) {
      player.alive = false;
      io.to(room.code).emit("announcement",
        player.name + " ovoz berish orqali o'yindan chiqarildi."
      );
    }
  } else {
    io.to(room.code).emit("announcement",
      "Ovozlar teng yoki berilmadi. Hech kim chiqarilmadi."
    );
  }

  const winner = checkWinner(room);
  if (winner) return endGame(room, winner);

  nextNight(room);
}

function startTimer(room) {
  clearInterval(room.timer);

  room.timer = setInterval(() => {
    if (!room.started) return;

    room.time--;

    io.to(room.code).emit("tick", room.time);

    if (room.time <= 0) {
      clearInterval(room.timer);

      if (room.phase === "night") resolveNight(room);
      else if (room.phase === "day") resolveDay(room);
    }
  }, 1000);
}

function startPhase(room) {
  startTimer(room);
}

io.on("connection", socket => {

  socket.on("create", name => {
    const roomCode = code();

    const room = {
      code: roomCode,
      host: socket.id,
      players: [{
        id: socket.id,
        name: String(name).slice(0, 20),
        alive: true
      }],
      started: false,
      phase: "lobby",
      day: 1,
      time: 0,
      actions: {},
      votes: {},
      watch: {}
    };

    rooms.set(roomCode, room);
    socket.join(roomCode);

    socket.emit("joined", roomCode);
    sendRoom(room);
  });

  socket.on("join", ({ name, code: roomCode }) => {
    const room = rooms.get(String(roomCode).toUpperCase());

    if (!room) return privateMessage(socket.id, {
      type: "error", text: "Bunday xona topilmadi!"
    });

    if (room.started || room.players.length >= 20) {
      return privateMessage(socket.id, {
        type: "error", text: "Xona to'la yoki o'yin boshlangan!"
      });
    }

    if (room.players.some(p => p.name === name)) {
      return privateMessage(socket.id, {
        type: "error", text: "Bu ism band!"
      });
    }

    room.players.push({
      id: socket.id,
      name: String(name).slice(0, 20),
      alive: true
    });

    socket.join(room.code);
    socket.emit("joined", room.code);
    sendRoom(room);
  });

  socket.on("start", () => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );

    if (!room || room.host !== socket.id || room.started) return;

    if (room.players.length < 8) {
      return privateMessage(socket.id, {
        type: "error",
        text: "O'yin boshlash uchun kamida 8 kishi kerak!"
      });
    }

    room.started = true;
    room.day = 1;

    giveRoles(room);
    nextNight(room);
    startPhase(room);
  });

  socket.on("action", targetId => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );

    if (!room || room.phase !== "night") return;

    const player = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);

    if (!player || !player.alive || !target ||
        !target.alive || target.id === player.id) return;

    if (mafiaTeam(player)) {
      room.actions[socket.id] = targetId;
      privateMessage(socket.id, {
        type: "success", text: "Nishon tanlandi."
      });
    }

    if (player.role === "Hamsoya") {
      room.watch[socket.id] = targetId;
      privateMessage(socket.id, {
        type: "success", text: "Uy kuzatuvga olindi."
      });
    }
  });

  socket.on("vote", targetId => {
    const room = [...rooms.values()].find(r =>
      r.players.some(p => p.id === socket.id)
    );

    if (!room || room.phase !== "day") return;

    const player = room.players.find(p => p.id === socket.id);
    const target = room.players.find(p => p.id === targetId);

    if (!player || !player.alive || !target ||
        !target.alive || target.id === player.id) return;

    room.votes[socket.id] = targetId;
    privateMessage(socket.id, {
      type: "success", text: "Ovozingiz qabul qilindi."
    });
  });

  socket.on("disconnect", () => {
    for (const room of rooms.values()) {
      const player = room.players.find(p => p.id === socket.id);

      if (player && !room.started) {
        room.players = room.players.filter(p => p.id !== socket.id);

        if (room.players.length === 0) {
          rooms.delete(room.code);
        } else {
          if (room.host === socket.id) {
            room.host = room.players[0].id;
          }
          sendRoom(room);
        }
      }
    }
  });
});

server.listen(3000, "0.0.0.0", () => {
  console.log("PLAY MAFIA: http://localhost:3000");
});
