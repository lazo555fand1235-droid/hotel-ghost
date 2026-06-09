const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

// rooms[roomId] = { players, gameState, ... }
const rooms = {};

const HOTEL_TIME = 300; // seconds
const SCAN_PENALTY = 30; // seconds lost per wrong scan
const MIN_PLAYERS = 4;

function createRoom(roomId) {
  return {
    id: roomId,
    players: {},       // socketId -> playerData
    phase: 'lobby',    // lobby | pictionary | hotel | ended
    hotelTime: HOTEL_TIME,
    timerInterval: null,
    guests: [],        // แขกที่รอเช็คอิน (queue)
    guestInterval: null,
    pictionary: null,
    voteCount: 0,
  };
}

function assignRoles(room) {
  const ids = Object.keys(room.players);
  // ~30% ผี
  const ghostCount = Math.max(1, Math.floor(ids.length * 0.3));
  const shuffled = ids.sort(() => Math.random() - 0.5);
  shuffled.forEach((id, i) => {
    room.players[id].role = i < ghostCount ? 'ghost' : 'human';
    room.players[id].roleRevealed = false;
  });
}

// Pictionary chain per round
function startPictionary(room) {
  room.phase = 'pictionary';
  const ids = Object.keys(room.players);
  const words = ['แมว','บ้าน','ต้นไม้','รถยนต์','ดาว','ปลา','เครื่องบิน','ช้าง','ดอกไม้','พิซซ่า'];
  const word = words[Math.floor(Math.random() * words.length)];

  room.pictionary = {
    chain: ids.map(id => ({ playerId: id, type: null, data: null })),
    currentIndex: 0,
    word,
    originalWord: word,
    phase: 'draw', // draw | guess (alternating)
    timeLeft: 5,
    interval: null,
  };

  // บอก host คนแรกว่าคำคืออะไร
  const firstId = ids[0];
  io.to(firstId).emit('pictionary_turn', {
    type: 'draw',
    prompt: word,
    timeLeft: 5,
    turnIndex: 0,
    total: ids.length,
  });

  broadcastToRoom(room, 'pictionary_start', {
    totalPlayers: ids.length,
    currentPlayer: room.players[firstId].name,
  });

  startPictionaryTimer(room);
}

function startPictionaryTimer(room) {
  const p = room.pictionary;
  if (p.interval) clearInterval(p.interval);
  p.timeLeft = p.phase === 'draw' ? 5 : 3;

  p.interval = setInterval(() => {
    p.timeLeft--;
    broadcastToRoom(room, 'pictionary_timer', { timeLeft: p.timeLeft });

    if (p.timeLeft <= 0) {
      clearInterval(p.interval);
      advancePictionary(room);
    }
  }, 1000);
}

function advancePictionary(room) {
  const p = room.pictionary;
  const ids = Object.keys(room.players);
  p.currentIndex++;

  if (p.currentIndex >= ids.length) {
    // จบ chain — ให้คนสุดท้ายเดา
    const lastId = ids[ids.length - 1];
    io.to(lastId).emit('pictionary_final_guess', {
      image: p.chain[ids.length - 1].data,
    });
    broadcastToRoom(room, 'pictionary_waiting_guess', {
      guesser: room.players[lastId].name,
    });
    return;
  }

  const currentId = ids[p.currentIndex];
  const prevEntry = p.chain[p.currentIndex - 1];

  if (prevEntry.type === 'draw') {
    // คนถัดไป guess
    io.to(currentId).emit('pictionary_turn', {
      type: 'guess',
      image: prevEntry.data,
      timeLeft: 3,
      turnIndex: p.currentIndex,
      total: ids.length,
    });
    p.phase = 'guess';
  } else {
    // คนถัดไป draw
    io.to(currentId).emit('pictionary_turn', {
      type: 'draw',
      prompt: prevEntry.data,
      timeLeft: 5,
      turnIndex: p.currentIndex,
      total: ids.length,
    });
    p.phase = 'draw';
  }

  startPictionaryTimer(room);
}

function startHotelPhase(room) {
  room.phase = 'hotel';
  room.hotelTime = HOTEL_TIME;

  broadcastToRoom(room, 'hotel_start', {
    hotelTime: HOTEL_TIME,
    players: sanitizePlayers(room),
  });

  // spawn แขก (คน/ผี) ทุก 20วิ
  room.guestInterval = setInterval(() => {
    spawnGuest(room);
  }, 20000);

  // countdown
  room.timerInterval = setInterval(() => {
    room.hotelTime--;
    broadcastToRoom(room, 'hotel_timer', { hotelTime: room.hotelTime });
    if (room.hotelTime <= 0) {
      endGame(room, 'timeout');
    }
  }, 1000);

  // spawn แขกแรกทันที
  setTimeout(() => spawnGuest(room), 3000);
}

function spawnGuest(room) {
  if (room.phase !== 'hotel') return;
  const isGhost = Math.random() < 0.4;
  const names = ['นาย A','นาง B','เด็กชาย C','คุณ D','ท่าน E','ลุง F','ป้า G'];
  const guest = {
    id: 'guest_' + Date.now(),
    name: names[Math.floor(Math.random() * names.length)],
    isGhost,
    checkedIn: false,
  };
  room.guests.push(guest);
  broadcastToRoom(room, 'guest_arrived', {
    guestId: guest.id,
    guestName: guest.name,
  });
}

function sanitizePlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    role: p.roleRevealed ? p.role : 'unknown',
    roleRevealed: p.roleRevealed,
  }));
}

function broadcastToRoom(room, event, data) {
  Object.keys(room.players).forEach(id => {
    io.to(id).emit(event, data);
  });
}

function endGame(room, reason) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (room.guestInterval) clearInterval(room.guestInterval);
  if (room.pictionary?.interval) clearInterval(room.pictionary.interval);
  room.phase = 'ended';

  // ตรวจว่ายังมีผีในโรงแรมมั้ย
  const ghostsRemaining = room.guests.filter(g => g.isGhost && g.checkedIn).length;
  const ghostStaff = Object.values(room.players).filter(p => p.role === 'ghost').length;
  const totalGhosts = ghostsRemaining + ghostStaff;

  const win = totalGhosts === 0 && reason === 'vote';

  broadcastToRoom(room, 'game_over', {
    win,
    reason,
    totalGhosts,
    players: Object.values(room.players).map(p => ({
      name: p.name,
      role: p.role,
    })),
    guests: room.guests.map(g => ({ name: g.guestName || g.name, isGhost: g.isGhost, checkedIn: g.checkedIn })),
  });
}

// ---- Socket.io ----
io.on('connection', (socket) => {
  console.log('connected:', socket.id);

  socket.on('join_room', ({ roomId, playerName }) => {
    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    if (room.phase !== 'lobby') {
      socket.emit('error_msg', 'เกมเริ่มแล้ว');
      return;
    }

    room.players[socket.id] = {
      name: playerName,
      role: null,
      roleRevealed: false,
      isHost: Object.keys(room.players).length === 0,
    };

    socket.join(roomId);
    socket.roomId = roomId;

    broadcastToRoom(room, 'lobby_update', {
      players: Object.values(room.players).map(p => ({ name: p.name, isHost: p.isHost })),
      count: Object.keys(room.players).length,
      minPlayers: MIN_PLAYERS,
    });
  });

  socket.on('start_game', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    if (!room.players[socket.id]?.isHost) return;
    if (Object.keys(room.players).length < MIN_PLAYERS) {
      socket.emit('error_msg', `ต้องการผู้เล่นอย่างน้อย ${MIN_PLAYERS} คน`);
      return;
    }
    assignRoles(room);
    startPictionary(room);
  });

  // รับ drawing data จาก canvas
  socket.on('pictionary_submit', ({ type, data }) => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'pictionary') return;
    const p = room.pictionary;
    const ids = Object.keys(room.players);

    if (ids[p.currentIndex] !== socket.id) return;

    if (p.interval) clearInterval(p.interval);
    p.chain[p.currentIndex] = { playerId: socket.id, type, data };
    advancePictionary(room);
  });

  // คนสุดท้ายส่งคำเดา
  socket.on('pictionary_guess', ({ guess }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const p = room.pictionary;
    const correct = guess.trim() === p.originalWord;

    // reveal บทให้ทุกคน
    Object.keys(room.players).forEach(id => {
      room.players[id].roleRevealed = true;
      io.to(id).emit('role_revealed', {
        role: room.players[id].role,
        correct,
        originalWord: p.originalWord,
        guess,
      });
    });

    setTimeout(() => startHotelPhase(room), 3000);
  });

  // Staff สแกนแขก
  socket.on('scan_guest', ({ guestId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'hotel') return;

    const guest = room.guests.find(g => g.id === guestId);
    if (!guest) return;

    if (guest.isGhost) {
      // ไล่ออก
      guest.checkedIn = false;
      room.guests = room.guests.filter(g => g.id !== guestId);
      broadcastToRoom(room, 'guest_scanned', {
        guestId,
        guestName: guest.name,
        isGhost: true,
        scannerName: room.players[socket.id]?.name,
      });
    } else {
      // คนจริง — ลดเวลา
      room.hotelTime = Math.max(0, room.hotelTime - SCAN_PENALTY);
      broadcastToRoom(room, 'guest_scanned', {
        guestId,
        guestName: guest.name,
        isGhost: false,
        penalty: SCAN_PENALTY,
        scannerName: room.players[socket.id]?.name,
        hotelTime: room.hotelTime,
      });
      if (room.hotelTime <= 0) endGame(room, 'timeout');
    }
  });

  // Staff สแกน player อื่น (พนักงานที่อาจเป็นผี)
  socket.on('scan_player', ({ targetId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'hotel') return;
    if (targetId === socket.id) return;

    const target = room.players[targetId];
    if (!target) return;

    if (target.role === 'ghost') {
      delete room.players[targetId];
      io.to(targetId).emit('you_were_caught');
      broadcastToRoom(room, 'player_scanned', {
        targetName: target.name,
        isGhost: true,
        scannerName: room.players[socket.id]?.name,
      });
    } else {
      room.hotelTime = Math.max(0, room.hotelTime - SCAN_PENALTY);
      broadcastToRoom(room, 'player_scanned', {
        targetName: target.name,
        isGhost: false,
        penalty: SCAN_PENALTY,
        scannerName: room.players[socket.id]?.name,
        hotelTime: room.hotelTime,
      });
      if (room.hotelTime <= 0) endGame(room, 'timeout');
    }
  });

  // โหวตจบเกม
  socket.on('vote_end', () => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'hotel') return;
    room.voteCount++;
    const total = Object.keys(room.players).length;
    broadcastToRoom(room, 'vote_update', {
      votes: room.voteCount,
      needed: Math.ceil(total / 2),
    });
    if (room.voteCount >= Math.ceil(total / 2)) {
      endGame(room, 'vote');
    }
  });

  // แขกเช็คอิน (auto หลัง spawn)
  socket.on('checkin_guest', ({ guestId }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const guest = room.guests.find(g => g.id === guestId);
    if (guest) guest.checkedIn = true;
  });

  socket.on('disconnect', () => {
    const room = rooms[socket.roomId];
    if (!room) return;
    const name = room.players[socket.id]?.name;
    delete room.players[socket.id];
    if (Object.keys(room.players).length === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      if (room.guestInterval) clearInterval(room.guestInterval);
      delete rooms[socket.roomId];
    } else {
      broadcastToRoom(room, 'player_left', { name });
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Hotel Ghost running on :${PORT}`));
