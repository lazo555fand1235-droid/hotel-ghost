const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

const HOTEL_TIME = 300;
const SCAN_PENALTY = 30;
const MIN_PLAYERS = 2; // ลดเป็น 2 เพื่อให้เล่นกับ AI ได้
const MAX_AI = 3;

const AI_NAMES = ['บอท ผี', 'บอท นก', 'บอท หมา', 'บอท แมว'];

function createRoom(roomId) {
  return {
    id: roomId,
    players: {},
    phase: 'lobby',
    hotelTime: HOTEL_TIME,
    timerInterval: null,
    guests: [],
    guestInterval: null,
    pictionary: null,
    voteCount: 0,
    aiIntervals: [],
  };
}

function assignRoles(room) {
  const ids = Object.keys(room.players);
  const ghostCount = Math.max(1, Math.floor(ids.length * 0.3));
  const shuffled = ids.sort(() => Math.random() - 0.5);
  shuffled.forEach((id, i) => {
    room.players[id].role = i < ghostCount ? 'ghost' : 'human';
    room.players[id].roleRevealed = false;
  });
}

// ---- AI ----
function addAIPlayers(room) {
  const humanCount = Object.keys(room.players).length;
  const needed = Math.max(0, MIN_PLAYERS + 1 - humanCount); // เติมให้ครบ MIN+1
  const toAdd = Math.min(needed, MAX_AI);
  for (let i = 0; i < toAdd; i++) {
    const aiId = 'ai_' + Date.now() + '_' + i;
    room.players[aiId] = {
      name: AI_NAMES[i % AI_NAMES.length],
      role: null,
      roleRevealed: false,
      isHost: false,
      isAI: true,
      suspicion: {}, // targetId -> suspicion score
      scanCooldown: 0,
    };
  }
}

function runAIHotel(room) {
  Object.entries(room.players).forEach(([aiId, ai]) => {
    if (!ai.isAI) return;

    const interval = setInterval(() => {
      if (room.phase !== 'hotel') { clearInterval(interval); return; }

      ai.scanCooldown = (ai.scanCooldown || 0) - 1;

      if (ai.role === 'human') {
        aiHumanBehavior(room, aiId, ai);
      } else {
        aiGhostBehavior(room, aiId, ai);
      }
    }, 3000 + Math.random() * 4000); // tick ทุก 3-7 วิ

    room.aiIntervals.push(interval);
  });
}

function aiHumanBehavior(room, aiId, ai) {
  if (ai.scanCooldown > 0) return;

  // สแกนแขกที่รอนานหน้าสุด (น่าสงสัย)
  const pendingGuests = room.guests.filter(g => !g.checkedIn);
  if (pendingGuests.length > 0 && Math.random() < 0.6) {
    // เลือกแขกที่อยู่นานที่สุด (index แรก = มาก่อน)
    const target = pendingGuests[0];
    performAIScanGuest(room, aiId, ai, target.id);
    ai.scanCooldown = 3;
    return;
  }

  // สแกนผู้เล่นที่ไม่เคยสแกนเลย (น่าสงสัยว่าเป็นผี)
  const otherPlayers = Object.entries(room.players).filter(([id, p]) =>
    id !== aiId && !p.isAI && p.role !== undefined
  );

  if (otherPlayers.length > 0 && Math.random() < 0.2) {
    // เลือกคนที่มี suspicion สูงสุด
    const sorted = otherPlayers.sort(([idA], [idB]) =>
      (ai.suspicion[idB] || 0) - (ai.suspicion[idA] || 0)
    );
    const [targetId] = sorted[0];
    performAIScanPlayer(room, aiId, ai, targetId);
    ai.scanCooldown = 5;
    return;
  }

  // โหวตจบเมื่อเวลาน้อยกว่า 60 วิ และไม่มีแขกผีเหลือ
  const ghostGuests = room.guests.filter(g => g.isGhost && g.checkedIn).length;
  if (room.hotelTime < 60 && ghostGuests === 0 && Math.random() < 0.4) {
    performAIVote(room, aiId);
  }
}

function aiGhostBehavior(room, aiId, ai) {
  // ผี — แกล้งทำเป็นสแกนแขกบ้างเพื่อไม่ให้น่าสงสัย แต่สแกนแบบสุ่ม
  const pendingGuests = room.guests.filter(g => !g.checkedIn);
  if (pendingGuests.length > 0 && Math.random() < 0.15) {
    // สแกนแบบสุ่ม (ไม่똑똑 — อาจสแกนผิดเสียเวลา)
    const target = pendingGuests[Math.floor(Math.random() * pendingGuests.length)];
    performAIScanGuest(room, aiId, ai, target.id);
    ai.scanCooldown = 8;
  }

  // ไม่โหวตจบ (ต้องการให้เวลาหมด)
}

function performAIScanGuest(room, aiId, ai, guestId) {
  const guest = room.guests.find(g => g.id === guestId);
  if (!guest || guest.checkedIn) return;

  const scannerName = room.players[aiId]?.name || 'AI';

  if (guest.isGhost) {
    room.guests = room.guests.filter(g => g.id !== guestId);
    broadcastToRoom(room, 'guest_scanned', {
      guestId,
      guestName: guest.name,
      isGhost: true,
      scannerName,
    });
  } else {
    room.hotelTime = Math.max(0, room.hotelTime - SCAN_PENALTY);
    broadcastToRoom(room, 'guest_scanned', {
      guestId,
      guestName: guest.name,
      isGhost: false,
      penalty: SCAN_PENALTY,
      scannerName,
      hotelTime: room.hotelTime,
    });
    if (room.hotelTime <= 0) endGame(room, 'timeout');
  }
}

function performAIScanPlayer(room, aiId, ai, targetId) {
  const target = room.players[targetId];
  if (!target) return;
  const scannerName = room.players[aiId]?.name || 'AI';

  if (target.role === 'ghost') {
    delete room.players[targetId];
    broadcastToRoom(room, 'player_scanned', {
      targetName: target.name,
      isGhost: true,
      scannerName,
    });
    // เพิ่ม suspicion ให้คนอื่น
    Object.keys(room.players).forEach(id => {
      if (room.players[id]?.isAI && room.players[id].suspicion) {
        room.players[id].suspicion[targetId] = 0;
      }
    });
  } else {
    room.hotelTime = Math.max(0, room.hotelTime - SCAN_PENALTY);
    // สแกนผิด เพิ่ม suspicion ให้ตัวเอง (AI อื่นจะหลีกเลี่ยง)
    Object.keys(room.players).forEach(id => {
      if (room.players[id]?.isAI && room.players[id].suspicion) {
        room.players[id].suspicion[targetId] = (room.players[id].suspicion[targetId] || 0) - 2;
      }
    });
    broadcastToRoom(room, 'player_scanned', {
      targetName: target.name,
      isGhost: false,
      penalty: SCAN_PENALTY,
      scannerName,
      hotelTime: room.hotelTime,
    });
    if (room.hotelTime <= 0) endGame(room, 'timeout');
  }
}

function performAIVote(room, aiId) {
  room.voteCount++;
  const total = Object.keys(room.players).length;
  broadcastToRoom(room, 'vote_update', {
    votes: room.voteCount,
    needed: Math.ceil(total / 2),
  });
  if (room.voteCount >= Math.ceil(total / 2)) {
    endGame(room, 'vote');
  }
}

// AI ทำ pictionary อัตโนมัติ (ส่ง canvas ว่างๆ / เดาคำ)
function handleAIPictionary(room) {
  const p = room.pictionary;
  const ids = Object.keys(room.players);
  const currentId = ids[p.currentIndex];
  const ai = room.players[currentId];
  if (!ai?.isAI) return;

  const delay = 1500 + Math.random() * 2000;

  if (p.phase === 'draw' || (p.currentIndex === 0)) {
    setTimeout(() => {
      if (room.phase !== 'pictionary') return;
      if (ids[p.currentIndex] !== currentId) return;
      // ส่ง canvas ว่างๆ
      if (p.interval) clearInterval(p.interval);
      p.chain[p.currentIndex] = { playerId: currentId, type: 'draw', data: createBlankCanvas() };
      advancePictionary(room);
    }, delay);
  } else {
    setTimeout(() => {
      if (room.phase !== 'pictionary') return;
      if (ids[p.currentIndex] !== currentId) return;
      if (p.interval) clearInterval(p.interval);
      // เดาคำ — บางครั้งเดาถูก บางครั้งผิด
      const correct = Math.random() < 0.3;
      p.chain[p.currentIndex] = {
        playerId: currentId,
        type: 'guess',
        data: correct ? p.originalWord : 'ไม่รู้',
      };
      advancePictionary(room);
    }, delay);
  }
}

function createBlankCanvas() {
  // base64 PNG ขาว 1x1 pixel แทน canvas จริง
  return 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwADhQGAWjR9awAAAABJRU5ErkJggg==';
}

// ---- PICTIONARY ----
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
    phase: 'draw',
    timeLeft: 5,
    interval: null,
  };

  const firstId = ids[0];

  broadcastToRoom(room, 'pictionary_start', {
    totalPlayers: ids.length,
    currentPlayer: room.players[firstId].name,
  });

  if (room.players[firstId]?.isAI) {
    handleAIPictionary(room);
  } else {
    io.to(firstId).emit('pictionary_turn', {
      type: 'draw',
      prompt: word,
      timeLeft: 5,
      turnIndex: 0,
      total: ids.length,
    });
    startPictionaryTimer(room);
  }
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
    const lastId = ids[ids.length - 1];
    const lastPlayer = room.players[lastId];

    if (lastPlayer?.isAI) {
      // AI เดาคำสุดท้าย
      setTimeout(() => {
        const correct = Math.random() < 0.3;
        finalizePictionary(room, correct ? p.originalWord : 'ไม่รู้');
      }, 2000);
    } else {
      io.to(lastId).emit('pictionary_final_guess', {
        image: p.chain[ids.length - 1].data,
      });
      broadcastToRoom(room, 'pictionary_waiting_guess', {
        guesser: lastPlayer.name,
      });
    }
    return;
  }

  const currentId = ids[p.currentIndex];
  const prevEntry = p.chain[p.currentIndex - 1];

  if (prevEntry.type === 'draw') {
    p.phase = 'guess';
  } else {
    p.phase = 'draw';
  }

  if (room.players[currentId]?.isAI) {
    handleAIPictionary(room);
  } else {
    if (prevEntry.type === 'draw') {
      io.to(currentId).emit('pictionary_turn', {
        type: 'guess',
        image: prevEntry.data,
        timeLeft: 3,
        turnIndex: p.currentIndex,
        total: ids.length,
      });
    } else {
      io.to(currentId).emit('pictionary_turn', {
        type: 'draw',
        prompt: prevEntry.data,
        timeLeft: 5,
        turnIndex: p.currentIndex,
        total: ids.length,
      });
    }
    startPictionaryTimer(room);
  }
}

function finalizePictionary(room, guess) {
  const p = room.pictionary;
  const correct = guess.trim() === p.originalWord;

  Object.keys(room.players).forEach(id => {
    room.players[id].roleRevealed = true;
    if (!room.players[id].isAI) {
      io.to(id).emit('role_revealed', {
        role: room.players[id].role,
        correct,
        originalWord: p.originalWord,
        guess,
      });
    }
  });

  setTimeout(() => startHotelPhase(room), 3000);
}

function startHotelPhase(room) {
  room.phase = 'hotel';
  room.hotelTime = HOTEL_TIME;

  broadcastToRoom(room, 'hotel_start', {
    hotelTime: HOTEL_TIME,
    players: sanitizePlayers(room),
  });

  room.guestInterval = setInterval(() => spawnGuest(room), 20000);

  room.timerInterval = setInterval(() => {
    room.hotelTime--;
    broadcastToRoom(room, 'hotel_timer', { hotelTime: room.hotelTime });
    if (room.hotelTime <= 0) endGame(room, 'timeout');
  }, 1000);

  setTimeout(() => spawnGuest(room), 3000);

  // เริ่ม AI behavior
  runAIHotel(room);
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
  broadcastToRoom(room, 'guest_arrived', { guestId: guest.id, guestName: guest.name });
}

function sanitizePlayers(room) {
  return Object.entries(room.players).map(([id, p]) => ({
    id,
    name: p.name,
    role: p.roleRevealed ? p.role : 'unknown',
    roleRevealed: p.roleRevealed,
    isAI: p.isAI || false,
  }));
}

function broadcastToRoom(room, event, data) {
  Object.keys(room.players).forEach(id => {
    if (!room.players[id]?.isAI) {
      io.to(id).emit(event, data);
    }
  });
}

function endGame(room, reason) {
  if (room.timerInterval) clearInterval(room.timerInterval);
  if (room.guestInterval) clearInterval(room.guestInterval);
  if (room.pictionary?.interval) clearInterval(room.pictionary.interval);
  room.aiIntervals.forEach(iv => clearInterval(iv));
  room.aiIntervals = [];
  room.phase = 'ended';

  const ghostsRemaining = room.guests.filter(g => g.isGhost && g.checkedIn).length;
  const ghostStaff = Object.values(room.players).filter(p => p.role === 'ghost').length;
  const totalGhosts = ghostsRemaining + ghostStaff;
  const win = totalGhosts === 0 && reason === 'vote';

  broadcastToRoom(room, 'game_over', {
    win,
    reason,
    totalGhosts,
    players: Object.values(room.players).map(p => ({ name: p.name, role: p.role, isAI: p.isAI || false })),
    guests: room.guests.map(g => ({ name: g.name, isGhost: g.isGhost, checkedIn: g.checkedIn })),
  });
}

// ---- Socket.io ----
io.on('connection', (socket) => {
  socket.on('join_room', ({ roomId, playerName }) => {
    if (!rooms[roomId]) rooms[roomId] = createRoom(roomId);
    const room = rooms[roomId];

    if (room.phase !== 'lobby') { socket.emit('error_msg', 'เกมเริ่มแล้ว'); return; }

    room.players[socket.id] = {
      name: playerName,
      role: null,
      roleRevealed: false,
      isHost: Object.keys(room.players).length === 0,
      isAI: false,
    };

    socket.join(roomId);
    socket.roomId = roomId;

    broadcastToRoom(room, 'lobby_update', {
      players: Object.values(room.players).map(p => ({ name: p.name, isHost: p.isHost, isAI: p.isAI || false })),
      count: Object.keys(room.players).length,
      minPlayers: MIN_PLAYERS,
    });
  });

  socket.on('add_ai', () => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'lobby') return;
    if (!room.players[socket.id]?.isHost) return;
    const currentAI = Object.values(room.players).filter(p => p.isAI).length;
    if (currentAI >= MAX_AI) { socket.emit('error_msg', 'เพิ่ม AI ได้สูงสุด 3 ตัว'); return; }

    const aiId = 'ai_' + Date.now();
    const aiIndex = currentAI;
    room.players[aiId] = {
      name: AI_NAMES[aiIndex % AI_NAMES.length],
      role: null,
      roleRevealed: false,
      isHost: false,
      isAI: true,
      suspicion: {},
      scanCooldown: 0,
    };

    broadcastToRoom(room, 'lobby_update', {
      players: Object.values(room.players).map(p => ({ name: p.name, isHost: p.isHost, isAI: p.isAI || false })),
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

  socket.on('pictionary_guess', ({ guess }) => {
    const room = rooms[socket.roomId];
    if (!room) return;
    finalizePictionary(room, guess);
  });

  socket.on('scan_guest', ({ guestId }) => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'hotel') return;
    const guest = room.guests.find(g => g.id === guestId);
    if (!guest) return;

    if (guest.isGhost) {
      room.guests = room.guests.filter(g => g.id !== guestId);
      broadcastToRoom(room, 'guest_scanned', {
        guestId, guestName: guest.name, isGhost: true,
        scannerName: room.players[socket.id]?.name,
      });
    } else {
      room.hotelTime = Math.max(0, room.hotelTime - SCAN_PENALTY);
      broadcastToRoom(room, 'guest_scanned', {
        guestId, guestName: guest.name, isGhost: false,
        penalty: SCAN_PENALTY, scannerName: room.players[socket.id]?.name,
        hotelTime: room.hotelTime,
      });
      if (room.hotelTime <= 0) endGame(room, 'timeout');
    }
  });

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
        targetName: target.name, isGhost: true,
        scannerName: room.players[socket.id]?.name,
      });
    } else {
      room.hotelTime = Math.max(0, room.hotelTime - SCAN_PENALTY);
      broadcastToRoom(room, 'player_scanned', {
        targetName: target.name, isGhost: false,
        penalty: SCAN_PENALTY, scannerName: room.players[socket.id]?.name,
        hotelTime: room.hotelTime,
      });
      if (room.hotelTime <= 0) endGame(room, 'timeout');
    }
  });

  socket.on('vote_end', () => {
    const room = rooms[socket.roomId];
    if (!room || room.phase !== 'hotel') return;
    room.voteCount++;
    const total = Object.keys(room.players).length;
    broadcastToRoom(room, 'vote_update', {
      votes: room.voteCount,
      needed: Math.ceil(total / 2),
    });
    if (room.voteCount >= Math.ceil(total / 2)) endGame(room, 'vote');
  });

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
    if (Object.keys(room.players).filter(id => !room.players[id]?.isAI).length === 0) {
      if (room.timerInterval) clearInterval(room.timerInterval);
      if (room.guestInterval) clearInterval(room.guestInterval);
      room.aiIntervals.forEach(iv => clearInterval(iv));
      delete rooms[socket.roomId];
    } else {
      broadcastToRoom(room, 'player_left', { name });
    }
  });
});

const PORT = process.env.PORT || 8080;
server.listen(PORT, () => console.log(`Hotel Ghost running on :${PORT}`));
