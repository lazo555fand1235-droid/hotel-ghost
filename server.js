const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));

const rooms = {};

// ---- CONFIG ----
const ROUND_TIME = 60;          // วินาทีต่อรอบ
const MAX_STARS = 5;
const HOTEL_ROOMS = ['101','102','103','201','202','203','301','302']; // 8 ห้อง
const MIN_PLAYERS = 1;
const MAX_AI_STAFF = 3;

// ---- GUEST GENERATION ----
const THAI_FIRST = ['สมชาย','วิภา','อนุชา','มาลี','ประสิทธิ์','ศิริพร','นคร','รัตนา','ไกรวุฒิ','จินตนา','พรทิพย์','สุรชัย'];
const THAI_LAST  = ['ใจดี','มีสุข','ทองคำ','สว่างใจ','แก้วมณี','พลายงาม','รุ่งเรือง','ดาวเรือง'];

// clue pool — human clues (เป็นจริง) vs ghost clues (ขัดแย้ง)
const HUMAN_CLUES = [
  'รองเท้ามีรอยสึกตามธรรมชาติ','ผิวหนังอุ่น สัมผัสได้ถึงชีพจร',
  'หายใจสม่ำเสมอ เห็นไอน้ำในอากาศเย็น','ดวงตากระพริบตามปกติ',
  'มีกลิ่นเหงื่อเล็กน้อย','เงาตกตามทิศที่ถูกต้อง',
  'น้ำหนักกดพื้นเป็นเสียงก้อง','ผมมีไขมันตามธรรมชาติ',
  'สีหน้าเปลี่ยนเมื่อถูกถาม','มีรอยช้ำเก่าที่แขน',
  'ตอบสนองเมื่อเรียกชื่อ','กระพริบตาเมื่อแสงจ้า',
  'มีรอยยิ้มจริงๆ เมื่อพูดคุย','ผิวหนังมีขุยเล็กน้อยตามธรรมชาติ',
];
const GHOST_CLUES = [
  'เงาหายไปช่วงสั้นๆ','อุณหภูมิรอบตัวเย็นกว่าปกติ 3°C',
  'กระจกไม่สะท้อนใบหน้า','กลิ่นดอกไม้ที่ไม่มีแหล่งที่มา',
  'เดินแต่ไม่มีเสียงเท้า','ดวงตาสะท้อนแสงในความมืด',
  'รอยเท้าหยุดกลางทาง','ผิวเย็นเหมือนหินอ่อน',
  'ปฏิทินในมือแสดงวันที่ผิด','หายใจแต่ไม่มีไอน้ำในอากาศเย็น',
  'เดินผ่านอุปกรณ์ตรวจจับความร้อนแต่ไม่แสดงผล',
  'เงาในกระจกเคลื่อนไหวช้ากว่าตัวจริง',
];
const AMBIGUOUS_CLUES = [
  'นิ่งผิดปกติเมื่อมีคนเข้ามาใกล้','ตอบคำถามช้ากว่าปกติเล็กน้อย',
  'สีหน้าซีดกว่าคนทั่วไป','ไม่ค่อยสบตาเมื่อพูดคุย',
  'ผ้าเสื้อไม่มีรอยยับแม้เดินทางมาไกล','รูปถ่ายในบัตรดูเก่ากว่าที่ควร',
  'ตัวเย็นกว่าปกติเล็กน้อย อาจเพราะอากาศ','ไม่ยิ้มเลยตลอดการสนทนา',
  'พูดน้อยผิดปกติ','มองรอบๆ ห้องบ่อยครั้ง',
  'ยืนนิ่งเป็นเวลานานโดยไม่มีเหตุผล','ดูเหนื่อยล้าอย่างผิดปกติ',
  'ไม่แสดงอาการหนาวแม้อุณหภูมิจะต่ำ','ตอบคำถามแบบท่องจำ ไม่เป็นธรรมชาติ',
];

const CARD_TYPES = ['ปกติ','เจาะรู','ไม่มีบัตร'];
// ไม่มีบัตร = อาจเป็นคนจริงที่ลืม หรือผีก็ได้ — ทำให้ยาก

const TASKS = [
  { id:'seal',    name:'อุดรอยแตก',       desc:'ปิดรอยร้าวในผนัง H.{room} ก่อนผีเพิ่มขึ้น', rooms:1, timeBonus:0  },
  { id:'ward',    name:'วางเครื่องรางห้อง', desc:'วางเครื่องรางป้องกันที่ห้อง H.{room}',      rooms:1, timeBonus:5  },
  { id:'inspect', name:'ตรวจสอบห้อง',      desc:'ค้นห้อง H.{room} หาของผิดปกติ',             rooms:1, timeBonus:0  },
  { id:'exorcise',name:'ขับผีห้อง',        desc:'ทำพิธีขับผีที่ห้อง H.{room} ต้องการ 2 คน', rooms:1, timeBonus:10, needPlayers:2 },
  { id:'lockdown',name:'ล็อคชั้น',         desc:'ล็อคกุญแจชั้น {floor} ป้องกันผีขยาย',      rooms:2, timeBonus:5  },
  { id:'ritual',  name:'พิธีกรรมกลุ่ม',    desc:'ทำพิธีกลางล็อบบี้ ต้องการ 3 คน',           rooms:0, timeBonus:15, needPlayers:3 },
  { id:'review',  name:'ดูกล้องวงจรปิด',   desc:'ตรวจสอบกล้องหาผีในโรงแรม',                 rooms:0, timeBonus:0  },
  { id:'purify',  name:'ชำระล้างห้อง',     desc:'ชำระล้างห้อง H.{room} ที่มีผีพัก',          rooms:1, timeBonus:8  },
];

function pickRandom(arr, n=1) {
  if (!arr || arr.length === 0) return n === 1 ? null : [];
  const s = [...arr].sort(() => Math.random()-0.5);
  // always return array when n>1, single item when n=1
  return n === 1 ? s[0] : s.slice(0, n);
}
// safe spread — always returns array of strings, never spreads a bare string
function pickRandomArr(arr, n) {
  if (!arr || arr.length === 0 || n <= 0) return [];
  const s = [...arr].sort(() => Math.random()-0.5);
  return s.slice(0, n);
}

function generateGuest(isGhost) {
  const firstName = pickRandom(THAI_FIRST);
  const lastName  = pickRandom(THAI_LAST);
  const gender    = Math.random()<0.5 ? 'ชาย' : 'หญิง';
  const height    = isGhost
    ? (Math.random()<0.5 ? Math.floor(Math.random()*20+145) : Math.floor(Math.random()*20+185)) // สูงหรือเตี้ยผิดปกติ
    : Math.floor(Math.random()*40+155); // 155-195
  const weight    = isGhost
    ? (Math.random()<0.5 ? Math.floor(Math.random()*15+35) : Math.floor(Math.random()*20+90))   // เบาหรือหนักผิดปกติ
    : Math.floor(Math.random()*50+50);  // 50-100
  const age       = isGhost ? Math.floor(Math.random()*80+20) : Math.floor(Math.random()*50+20);

  // บัตรประชาชน — ผีมีโอกาสบัตรเจาะรู/ไม่มีบัตรสูงกว่า แต่ก็อาจมีบัตรปกติได้
  let cardType;
  if (isGhost) {
    const r = Math.random();
    cardType = r < 0.35 ? 'เจาะรู' : r < 0.6 ? 'ไม่มีบัตร' : 'ปกติ';
  } else {
    const r = Math.random();
    cardType = r < 0.08 ? 'เจาะรู' : r < 0.2 ? 'ไม่มีบัตร' : 'ปกติ'; // คนปกติก็อาจลืมบัตรได้
  }

  // สร้าง clue 3 ข้อ — ผสม clue ให้ยากตัดสิน
  let clues = [];
  if (isGhost) {
    const numGhost = Math.random()<0.4 ? 1 : 2;
    const numAmbig  = Math.max(0, 3 - numGhost - (Math.random()<0.35 ? 1 : 0));
    clues = [
      ...pickRandomArr(GHOST_CLUES, numGhost),
      ...pickRandomArr(AMBIGUOUS_CLUES, numAmbig),
      ...(Math.random()<0.35 ? pickRandomArr(HUMAN_CLUES, 1) : []),
    ].filter(Boolean).slice(0, 3);
  } else {
    const numHuman = Math.random()<0.3 ? 1 : 2;
    clues = [
      ...pickRandomArr(HUMAN_CLUES, numHuman),
      ...pickRandomArr(AMBIGUOUS_CLUES, 3 - numHuman),
    ].filter(Boolean).slice(0, 3);
  }

  return {
    id: 'g_' + Date.now() + '_' + Math.random().toString(36).slice(2,6),
    name: `${firstName} ${lastName}`,
    gender,
    height,
    weight,
    age,
    cardType,
    clues,
    isGhost,
    checkedIn: false,
    assignedRoom: null,
    votes: { accept:0, reject:0, voters:[] },
    voteActive: false,
    voteTimeout: null,
  };
}

function generateTask(room) {
  const base = pickRandom(TASKS);
  const task = { ...base, id: base.id+'_'+Date.now() };
  const floors = ['1','2','3'];
  task.desc = task.desc
    .replace('{room}', pickRandom(HOTEL_ROOMS))
    .replace('{floor}', pickRandom(floors));
  task.completed = false;
  task.progress = {};  // playerId -> bool (เข้าร่วมแล้ว)
  return task;
}

// ---- ROOM ----
function createRoom(roomId) {
  return {
    id: roomId,
    players: {},      // socketId -> playerObj
    phase: 'lobby',
    stars: MAX_STARS,
    round: 0,
    roundTime: ROUND_TIME,
    roundInterval: null,
    hotelRooms: initHotelRooms(),
    guestQueue: [],   // แขกรอเช็คอิน
    tasks: [],
    clues: [],        // clue ที่ผู้เล่นค้นพบ
    aiIntervals: [],
    voteEndActive: false,
    voteEnd: {},      // playerId -> bool
    ghostStaff: [],   // AI พนักงานที่เป็นผี
  };
}

function initHotelRooms() {
  const r = {};
  HOTEL_ROOMS.forEach(id => {
    r[id] = { id, guest: null, hasGhost: false, clueLeft: null };
  });
  return r;
}

// ---- STAFF (AI) ----
const AI_STAFF_NAMES = ['คุณบัว','คุณนก','คุณเอิน','คุณต้น'];
function addAIStaff(room) {
  for (let i=0; i<2; i++) {
    const aid = 'ai_'+i;
    const isGhost = i===0 && Math.random()<0.3; // บางครั้ง AI เป็นผี
    room.players[aid] = {
      name: AI_STAFF_NAMES[i],
      isAI: true,
      isHost: false,
      role: isGhost ? 'ghost' : 'human',
      currentRoom: 'lobby',
      taskProgress: {},
    };
    if (isGhost) room.ghostStaff.push(aid);
  }
}

// ---- BROADCAST ----
function broadcastToRoom(room, event, data) {
  Object.keys(room.players).forEach(id => {
    if (!room.players[id]?.isAI) io.to(id).emit(event, data);
  });
}
function broadcastState(room) {
  broadcastToRoom(room, 'state_update', buildState(room));
}
function buildState(room) {
  return {
    phase: room.phase,
    stars: room.stars,
    round: room.round,
    roundTime: room.roundTime,
    hotelRooms: Object.values(room.hotelRooms).map(r => ({
      id: r.id,
      occupied: !!r.guest,
      guestName: r.guest?.name || null,
      hasGhost: false, // ไม่เปิดเผยให้ client
      clueLeft: r.clueLeft,
    })),
    guestQueue: room.guestQueue.map(g => sanitizeGuest(g)),
    tasks: room.tasks,
    clues: room.clues,
    players: sanitizePlayers(room),
    voteEnd: room.voteEnd,
    voteEndActive: room.voteEndActive,
  };
}
function sanitizeGuest(g) {
  return {
    id: g.id,
    name: g.name,
    gender: g.gender,
    height: g.height,
    weight: g.weight,
    age: g.age,
    cardType: g.cardType,
    clues: g.clues,
    checkedIn: g.checkedIn,
    assignedRoom: g.assignedRoom,
    votes: g.votes,
    voteActive: g.voteActive,
    // isGhost ไม่ส่ง!
  };
}
function sanitizePlayers(room) {
  return Object.entries(room.players).map(([id,p])=>({
    id, name:p.name, isAI:p.isAI||false, isHost:p.isHost||false,
    role: p.role, // จะ reveal เฉพาะตอนเกมจบ
    currentRoom: p.currentRoom||'lobby',
  }));
}

// ---- ROUND ----
function startRound(room) {
  room.round++;
  room.roundTime = ROUND_TIME;
  room.tasks = [generateTask(room), generateTask(room)]; // 2 ภารกิจต่อรอบ
  room.guestQueue = [];

  // spawn แขก 2-4 คน
  const n = 2 + Math.floor(Math.random()*3);
  for (let i=0;i<n;i++) {
    const isGhost = Math.random()<0.35;
    room.guestQueue.push(generateGuest(isGhost));
  }

  // แขกแรกเปิดให้โหวตทันที
  if (room.guestQueue.length>0) openGuestVote(room, room.guestQueue[0]);

  broadcastToRoom(room, 'round_start', {
    round: room.round,
    tasks: room.tasks,
    guestCount: room.guestQueue.length,
  });
  broadcastState(room);

  if (room.roundInterval) clearInterval(room.roundInterval);
  room.roundInterval = setInterval(()=>tickRound(room), 1000);

  // AI behavior
  runAI(room);
}

function tickRound(room) {
  if (room.phase !== 'playing') { clearInterval(room.roundInterval); return; }
  room.roundTime--;
  broadcastToRoom(room, 'round_timer', { roundTime: room.roundTime });

  if (room.roundTime <= 0) {
    clearInterval(room.roundInterval);
    endRound(room);
  }
}

function endRound(room) {
  const ghostsIn = Object.values(room.hotelRooms).filter(r=>r.hasGhost).length;

  // ไม่ลดดาวต่อรอบ — ผีในห้องไม่ทำให้เสียดาวทันที
  // แพ้เฉพาะเมื่อผีเต็มทุกห้องหรือดาวหมดจากสาเหตุอื่น
  broadcastToRoom(room, 'round_end', {
    round: room.round,
    ghostsIn,
    starsLost: 0,
    stars: room.stars,
  });

  // แขกคนที่พักเสร็จมีโอกาสทิ้งเบาะแส
  Object.values(room.hotelRooms).forEach(hr=>{
    if (hr.guest && hr.guest.checkedIn && !hr.hasGhost) {
      if (Math.random()<0.5) {
        const clue = generateRoomClue(room);
        hr.clueLeft = clue;
        room.clues.push({ roomId:hr.id, text:clue, round:room.round });
        broadcastToRoom(room, 'clue_found', { roomId:hr.id, text:clue });
      }
      hr.guest = null;
    }
    // ผีในห้องยังคงอยู่ข้ามรอบ
  });

  // เงื่อนไขแพ้: ดาวหมด
  if (room.stars <= 0) { endGame(room,'no_stars'); return; }
  // เงื่อนไขแพ้: ผีเต็มทุกห้อง
  const ghostRooms = Object.values(room.hotelRooms).filter(r=>r.hasGhost).length;
  if (ghostRooms >= HOTEL_ROOMS.length) { endGame(room,'ghost_full'); return; }

  // รอบใหม่
  setTimeout(()=>startRound(room), 3000);
}

function generateRoomClue(room) {
  const ghostRooms = Object.entries(room.hotelRooms).filter(([,r])=>r.hasGhost).map(([id])=>id);
  const pool = [];
  if (ghostRooms.length>0) {
    pool.push(`ได้ยินเสียงแปลกๆ จากบริเวณชั้น ${ghostRooms[0][0]}`);
    pool.push(`อุณหภูมิต่างกันมากระหว่างห้อง ${ghostRooms[0]} กับห้องข้างเคียง`);
    pool.push(`พบรอยขีดข่วนที่ผนังห้อง ${ghostRooms[0]}`);
    pool.push(`กลิ่นดอกไม้แรงผิดปกติแถวๆ ห้อง ${ghostRooms[0]}`);
  }
  pool.push('ไม่พบสิ่งผิดปกติในห้อง');
  pool.push('แขกรายนี้ดูปกติดีตลอดการพัก');
  pool.push('พบรูปถ่ายเก่าๆ ทิ้งไว้ในห้อง ไม่รู้เจ้าของ');
  pool.push('กระจกในห้องมีรอยฝ้าแปลกๆ');
  return pickRandom(pool);
}

// ---- GUEST VOTE ----
function openGuestVote(room, guest) {
  guest.voteActive = true;
  guest.votes = { accept:0, reject:0, voters:[] };
  broadcastToRoom(room, 'guest_vote_open', { guest: sanitizeGuest(guest) });

  // 15 วิถ้าไม่มีใครโหวต = รับเข้าอัตโนมัติ
  guest.voteTimeout = setTimeout(()=>{
    if (!guest.voteActive) return;
    resolveGuestVote(room, guest, 'timeout');
  }, 15000);

  // AI โหวต
  setTimeout(()=>aiVoteGuest(room, guest), 2000+Math.random()*5000);
}

function resolveGuestVote(room, guest, reason) {
  if (!guest.voteActive) return;
  clearTimeout(guest.voteTimeout);
  guest.voteActive = false;

  const total = guest.votes.accept + guest.votes.reject;
  const accepted = total===0 || guest.votes.accept >= guest.votes.reject;

  if (accepted) {
    checkInGuest(room, guest);
  } else {
    // โหวตไล่ออก
    if (guest.isGhost) {
      broadcastToRoom(room, 'guest_rejected', { guestId:guest.id, guestName:guest.name, correct:true });
      addLog(room, `✅ ${guest.name} โดนโหวตไล่ออก — เป็นผีจริง!`, 'good');
    } else {
      room.stars = Math.max(0, room.stars-1);
      broadcastToRoom(room, 'guest_rejected', { guestId:guest.id, guestName:guest.name, correct:false, stars:room.stars });
      addLog(room, `❌ ${guest.name} โดนไล่ออกทั้งที่เป็นคน เสีย 1 ดาว`, 'bad');
    }
    room.guestQueue = room.guestQueue.filter(g=>g.id!==guest.id);
  }

  // เปิดโหวตแขกคนต่อไป
  const next = room.guestQueue.find(g=>!g.checkedIn && !g.voteActive && !g.voteTimeout);
  if (next) setTimeout(()=>openGuestVote(room,next), 2000);

  broadcastState(room);
}

function checkInGuest(room, guest) {
  // หาห้องว่าง
  const emptyRoom = Object.values(room.hotelRooms).find(r=>!r.guest);
  if (!emptyRoom) {
    // โรงแรมเต็ม
    broadcastToRoom(room, 'hotel_full', { guestName:guest.name });
    return;
  }
  guest.checkedIn = true;
  guest.assignedRoom = emptyRoom.id;
  emptyRoom.guest = guest;
  emptyRoom.hasGhost = guest.isGhost;

  broadcastToRoom(room, 'guest_checkin', {
    guestId: guest.id,
    guestName: guest.name,
    roomId: emptyRoom.id,
    isGhost: false, // ไม่บอก client
  });
  addLog(room, `🏨 ${guest.name} เช็คอินห้อง ${emptyRoom.id}`, 'info');

  // ผีเต็มทุกห้อง?
  const ghostRooms = Object.values(room.hotelRooms).filter(r=>r.hasGhost).length;
  if (ghostRooms >= HOTEL_ROOMS.length) endGame(room,'ghost_full');
  broadcastState(room);
}

function addLog(room, text, type='') {
  broadcastToRoom(room, 'log', { text, type });
}

// ---- TASKS ----
function joinTask(room, playerId, taskId) {
  const task = room.tasks.find(t => t.id === taskId);
  if (!task || task.completed) return;
  // ห้าม join ซ้ำ
  if (task.progress[playerId]) {
    const name = room.players[playerId]?.name || '?';
    broadcastToRoom(room, 'task_already_joined', { taskId, playerName: name });
    return;
  }
  task.progress[playerId] = true;
  const needed = task.needPlayers || 1;
  const joined = Object.keys(task.progress).length;

  broadcastToRoom(room, 'task_joined', {
    taskId,
    joined,
    needed,
    playerName: room.players[playerId]?.name || '?',
  });

  if (joined >= needed) {
    task.completed = true;
    if (task.timeBonus > 0) {
      room.roundTime = Math.min(ROUND_TIME * 2, room.roundTime + task.timeBonus);
    }
    broadcastToRoom(room, 'task_complete', {
      taskId,
      taskName: task.name,
      timeBonus: task.timeBonus,
    });
    addLog(room, `✅ ภารกิจ "${task.name}" สำเร็จ!${task.timeBonus > 0 ? ' +' + task.timeBonus + ' วิ' : ''}`, 'good');

    // inspect/review/purify → ได้เบาะแส
    if (['inspect','review','purify'].includes(task.id.split('_')[0])) {
      const clue = generateRoomClue(room);
      room.clues.push({ text: clue, round: room.round, source: 'task' });
      broadcastToRoom(room, 'clue_found', { text: clue, source: 'task' });
    }
  }
  broadcastState(room);
}

// ---- SCAN GUEST (by player, แทนโหวต) ----
function scanGuest(room, socketId, guestId) {
  const guest = room.guestQueue.find(g=>g.id===guestId) ||
    Object.values(room.hotelRooms).find(r=>r.guest?.id===guestId)?.guest;
  if (!guest) return;
  const scanner = room.players[socketId]?.name || 'พนักงาน';
  if (guest.isGhost) {
    // ไล่ออก
    if (guest.checkedIn && guest.assignedRoom) {
      const hr = room.hotelRooms[guest.assignedRoom];
      hr.guest = null; hr.hasGhost = false;
    }
    room.guestQueue = room.guestQueue.filter(g=>g.id!==guestId);
    broadcastToRoom(room,'scan_result',{guestId,guestName:guest.name,isGhost:true,scannerName:scanner});
    addLog(room,`👻 ${scanner} สแกน ${guest.name} → เป็นผี! ไล่ออกแล้ว`,'good');
  } else {
    room.stars = Math.max(0,room.stars-1);
    broadcastToRoom(room,'scan_result',{guestId,guestName:guest.name,isGhost:false,scannerName:scanner,stars:room.stars});
    addLog(room,`⚠️ ${scanner} สแกน ${guest.name} → เป็นคน! เสีย 1 ดาว`,'bad');
    if (room.stars<=0) endGame(room,'no_stars');
  }
  broadcastState(room);
}

// ---- VOTE END GAME ----
function voteEndGame(room, socketId) {
  room.voteEnd[socketId] = true;
  const humanPlayers = Object.entries(room.players).filter(([,p])=>!p.isAI);
  const votes = Object.keys(room.voteEnd).length;
  const needed = Math.ceil(humanPlayers.length/2);
  broadcastToRoom(room,'vote_end_update',{votes,needed});
  if (votes>=needed) {
    // เช็คว่ายังมีผีอยู่ไหม
    const ghostsInRooms = Object.values(room.hotelRooms).filter(r=>r.hasGhost).length;
    const ghostStaffAlive = room.ghostStaff.filter(id=>room.players[id]).length;
    if (ghostsInRooms===0 && ghostStaffAlive===0) {
      endGame(room,'win');
    } else {
      // โหวตจบแต่ยังมีผี = แพ้
      endGame(room,'vote_with_ghost');
    }
  }
}

// ---- AI ----
function aiVoteGuest(room, guest) {
  if (!guest.voteActive) return;
  // AI วิเคราะห์ clue
  const score = analyzeGuestAI(guest);
  const vote = score > 0.5 ? 'reject' : 'accept';
  guest.votes[vote]++;
  guest.votes.voters.push('AI');
  broadcastToRoom(room,'guest_vote_cast',{guestId:guest.id, vote, voterName:'ระบบ AI', accept:guest.votes.accept, reject:guest.votes.reject});

  // ถ้า AI มั่นใจมาก reject ทันที
  const humanCount = Object.keys(room.players).filter(id=>!room.players[id].isAI).length;
  if (score>0.75 && guest.votes.reject > guest.votes.accept) {
    setTimeout(()=>resolveGuestVote(room,guest,'ai_reject'), 1500);
  }
}

function analyzeGuestAI(guest) {
  // score 0-1: 1 = น่าจะผี
  let score = 0;
  // บัตร
  if (guest.cardType==='เจาะรู') score+=0.3;
  if (guest.cardType==='ไม่มีบัตร') score+=0.2;
  // clue
  guest.clues.forEach(c=>{
    if (GHOST_CLUES.includes(c)) score+=0.25;
    if (HUMAN_CLUES.includes(c)) score-=0.15;
    if (AMBIGUOUS_CLUES.includes(c)) score+=0.05;
  });
  // ส่วนสูง/น้ำหนักผิดปกติ
  if (guest.height<148||guest.height>188) score+=0.1;
  if (guest.weight<42||guest.weight>95) score+=0.1;
  return Math.min(1,Math.max(0,score));
}

function runAI(room) {
  // AI staff ช่วย task และวิเคราะห์แขก
  const interval = setInterval(()=>{
    if (room.phase!=='playing'){clearInterval(interval);return;}
    Object.entries(room.players).forEach(([id,p])=>{
      if (!p.isAI) return;
      // AI join task
      const pending = room.tasks.find(t=>!t.completed&&!t.progress[id]);
      if (pending&&Math.random()<0.4) joinTask(room,id,pending.id);
    });
  },4000+Math.random()*3000);
  room.aiIntervals.push(interval);
}

// ---- END GAME ----
function endGame(room, reason) {
  if (room.phase==='ended') return;
  room.phase = 'ended';
  if (room.roundInterval) clearInterval(room.roundInterval);
  room.aiIntervals.forEach(iv=>clearInterval(iv));
  room.aiIntervals=[];
  Object.values(room.guestQueue).forEach(g=>clearTimeout(g.voteTimeout));

  const win = reason==='win';
  const ghostsInRooms = Object.values(room.hotelRooms).filter(r=>r.hasGhost).length;
  const ghostStaffAlive = room.ghostStaff.filter(id=>room.players[id]).length;

  // เปิดเผยความจริงทั้งหมด
  const revealRooms = Object.values(room.hotelRooms).map(r=>({
    id:r.id,
    guestName:r.guest?.name||null,
    hasGhost:r.hasGhost,
  }));

  const reasonText = {
    'win':          '✅ ไล่ผีออกหมดแล้ว โรงแรมปลอดภัย!',
    'no_stars':     '💔 ดาวหมดแล้ว โรงแรมเสียชื่อเสียง!',
    'ghost_full':   '👻 ผียึดครองโรงแรมครบทุกห้องแล้ว!',
    'vote_with_ghost':'⚠️ โหวตจบเกมแต่ยังมีผีซ่อนอยู่!',
    'timeout':      '⏱️ เวลาหมด',
  }[reason]||reason;

  broadcastToRoom(room,'game_over',{
    win, reason, reasonText,
    stars: room.stars,
    ghostsInRooms, ghostStaffAlive,
    revealRooms,
    players: Object.values(room.players).map(p=>({name:p.name,role:p.role,isAI:p.isAI||false})),
    allGuests: [...room.guestQueue, ...Object.values(room.hotelRooms).filter(r=>r.guest).map(r=>r.guest)]
      .map(g=>({ name:g.name, isGhost:g.isGhost, checkedIn:g.checkedIn, cardType:g.cardType })),
  });
}

// ---- SOCKET ----
io.on('connection', socket=>{
  socket.on('join_room',({roomId,playerName})=>{
    if (!rooms[roomId]) rooms[roomId]=createRoom(roomId);
    const room=rooms[roomId];
    if (room.phase!=='lobby'){socket.emit('error_msg','เกมเริ่มแล้ว');return;}
    room.players[socket.id]={
      name:playerName, isAI:false,
      isHost:Object.keys(room.players).filter(id=>!room.players[id].isAI).length===0,
      role:'human', currentRoom:'lobby', taskProgress:{},
    };
    socket.join(roomId);
    socket.roomId=roomId;
    broadcastToRoom(room,'lobby_update',{
      players:Object.values(room.players).map(p=>({name:p.name,isHost:p.isHost,isAI:p.isAI||false})),
      count:Object.keys(room.players).length,
    });
  });

  socket.on('start_game',()=>{
    const room=rooms[socket.roomId];
    if (!room||!room.players[socket.id]?.isHost) return;
    if (Object.keys(room.players).filter(id=>!room.players[id].isAI).length<MIN_PLAYERS){
      socket.emit('error_msg',`ต้องการผู้เล่นอย่างน้อย ${MIN_PLAYERS} คน`);return;
    }
    // กำหนด role ผู้เล่น — ผี 30%
    const ids=Object.keys(room.players).filter(id=>!room.players[id].isAI);
    const ghostCount=Math.max(0,Math.floor(ids.length*0.3));
    const shuffled=[...ids].sort(()=>Math.random()-0.5);
    shuffled.forEach((id,i)=>{
      room.players[id].role=i<ghostCount?'ghost':'human';
      // บอก role เฉพาะตัวเอง
      io.to(id).emit('your_role',{role:room.players[id].role});
    });
    addAIStaff(room);
    room.phase='playing';
    startRound(room);
  });

  socket.on('vote_guest',({guestId,vote})=>{
    const room=rooms[socket.roomId];
    if (!room||room.phase!=='playing') return;
    const guest=room.guestQueue.find(g=>g.id===guestId);
    if (!guest||!guest.voteActive) return;
    if (guest.votes.voters.includes(socket.id)) return;
    guest.votes.voters.push(socket.id);
    guest.votes[vote]++;
    const pName=room.players[socket.id]?.name||'?';
    broadcastToRoom(room,'guest_vote_cast',{guestId,vote,voterName:pName,accept:guest.votes.accept,reject:guest.votes.reject});
    // majority check
    const humanCount=Object.keys(room.players).filter(id=>!room.players[id].isAI).length;
    const majority=Math.ceil(humanCount/2);
    if (guest.votes.accept>=majority||guest.votes.reject>=majority) {
      resolveGuestVote(room,guest,'majority');
    }
  });

  socket.on('scan_guest',({guestId})=>{
    const room=rooms[socket.roomId];
    if (!room||room.phase!=='playing') return;
    scanGuest(room,socket.id,guestId);
  });

  socket.on('join_task',({taskId})=>{
    const room=rooms[socket.roomId];
    if (!room||room.phase!=='playing') return;
    joinTask(room,socket.id,taskId);
  });

  // ไล่แขกออกตรงๆ (ไม่ผ่านโหวต) — ถ้าเป็นผีได้คะแนน ถ้าเป็นคนเสีย 1 ดาว
  socket.on('kick_guest',({guestId})=>{
    const room=rooms[socket.roomId];
    if (!room||room.phase!=='playing') return;
    const kicker=room.players[socket.id]?.name||'พนักงาน';
    // หาใน queue หรือในห้อง
    let guest=room.guestQueue.find(g=>g.id===guestId);
    let fromRoom=null;
    if (!guest) {
      const hr=Object.values(room.hotelRooms).find(r=>r.guest?.id===guestId);
      if (hr) { guest=hr.guest; fromRoom=hr; }
    }
    if (!guest) return;
    // ยกเลิก vote ถ้ากำลัง active
    if (guest.voteActive) {
      clearTimeout(guest.voteTimeout);
      guest.voteActive=false;
    }
    if (guest.isGhost) {
      // ถูกต้อง — ไล่ผีออก
      if (fromRoom) { fromRoom.guest=null; fromRoom.hasGhost=false; }
      room.guestQueue=room.guestQueue.filter(g=>g.id!==guestId);
      broadcastToRoom(room,'kick_result',{guestId,guestName:guest.name,correct:true,kickerName:kicker});
      addLog(room,`✅ ${kicker} ไล่ ${guest.name} ออก — เป็นผีจริง!`,'good');
    } else {
      // ผิด — ไล่คนออก เสีย 1 ดาว
      if (fromRoom) { fromRoom.guest=null; fromRoom.hasGhost=false; }
      room.guestQueue=room.guestQueue.filter(g=>g.id!==guestId);
      room.stars=Math.max(0,room.stars-1);
      broadcastToRoom(room,'kick_result',{guestId,guestName:guest.name,correct:false,kickerName:kicker,stars:room.stars});
      addLog(room,`❌ ${kicker} ไล่ ${guest.name} ออก — เป็นคน! เสีย 1 ดาว`,'bad');
      if (room.stars<=0) { endGame(room,'no_stars'); return; }
    }
    broadcastState(room);
  });

  socket.on('vote_end_game',()=>{
    const room=rooms[socket.roomId];
    if (!room||room.phase!=='playing') return;
    voteEndGame(room,socket.id);
  });

  socket.on('move_room',({roomId})=>{
    const room=rooms[socket.roomId];
    if (!room||room.phase!=='playing') return;
    const player=room.players[socket.id];
    if (!player) return;
    player.currentRoom=roomId;
    socket.emit('moved_to',{roomId});
    // ถ้าห้องมี clue — ส่งให้
    const hr=room.hotelRooms[roomId];
    if (hr?.clueLeft) {
      socket.emit('clue_found',{roomId,text:hr.clueLeft,source:'room'});
      hr.clueLeft=null;
    }
    broadcastState(room);
  });

  socket.on('disconnect',()=>{
    const room=rooms[socket.roomId];
    if (!room) return;
    const name=room.players[socket.id]?.name;
    delete room.players[socket.id];
    const humans=Object.keys(room.players).filter(id=>!room.players[id]?.isAI);
    if (humans.length===0) {
      if (room.roundInterval) clearInterval(room.roundInterval);
      room.aiIntervals.forEach(iv=>clearInterval(iv));
      delete rooms[socket.roomId];
    } else {
      broadcastToRoom(room,'player_left',{name});
    }
  });
});

const PORT=process.env.PORT||8080;
server.listen(PORT,()=>console.log(`Hotel Ghost v2 on :${PORT}`));
