// server/gameEngine.js
const { nanoid } = require('nanoid');
const { PRESET_UNITS } = require('./units');
const { generatePoints, connectEdges, splitSides } = require('./map');
const BalanceLogger = require('./balanceLogger');

// ---------- 图算法 ----------
function shortestPath(graph, start, goal, blockedNodes = new Set()){
  if (!graph || !graph.nodes || !graph.adj) return { cost: Infinity, path: [] };
  const dist = new Map(), prev = new Map();
  const Q = new Set(graph.nodes || []);
  (graph.nodes || []).forEach(n => dist.set(n, Infinity));
  dist.set(start, 0);

  while (Q.size){
    let u = null, best = Infinity;
    for (const n of Q){
      const d = dist.get(n);
      if (d < best){ best = d; u = n; }
    }
    if (u === null) break;
    Q.delete(u);
    if (u === goal) break;

    for (const e of (graph.adj.get(u) || [])){
      const v = (e.a === u) ? e.b : e.a;
      if (v !== start && blockedNodes.has(v)) continue;
      const alt = dist.get(u) + e.w;
      if (alt < dist.get(v)){
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }
  if (!dist.has(goal) || dist.get(goal) === Infinity) return { cost: Infinity, path: [] };
  const path = [];
  let cur = goal;
  while (cur !== undefined){
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { cost: dist.get(goal), path };
}
function buildGraph(points, edges){
  const nodes = (points || []).map(p=>p.id);
  const adj = new Map();
  for (const id of nodes) adj.set(id, []);
  for (const e of (edges || [])){
    adj.get(e.a).push(e);
    adj.get(e.b).push(e);
  }
  return { nodes, adj, edges: edges || [] };
}
function sameRoad(graph, path){
  if (!graph || !path || path.length < 2) return true;
  let dir = null;
  for (let i=0;i<path.length-1;i++){
    const a = path[i], b = path[i+1];
    const e = (graph.adj.get(a)||[]).find(ed => (ed.a===a&&ed.b===b)||(ed.a===b&&ed.b===a));
    if (!e) return false;
    if (dir===null) dir = e.dir;
    else if (dir !== e.dir) return false;
  }
  return true;
}

// ---------- 引擎 ----------
class GameEngine {
  constructor(io){
    this.io = io;
    this.rooms = new Map();
    this.logger = new BalanceLogger();

    // 空房 60s 后清理
    setInterval(() => {
      const now = Date.now();
      for (const [id, room] of this.rooms){
        if (room._emptySince && now - room._emptySince > 60_000){
          this.rooms.delete(id);
        }
      }
    }, 10_000);
  }

  attachSocket(socket){
    socket.on('listRooms', ()=> {
      const list = [...this.rooms.values()].map(r => ({
        id: r.id, name: r.name, maxPlayers: r.maxPlayers,
        curPlayers: r.players.length, started: r.started
      }));
      socket.emit('rooms', list);
    });

    socket.on('createRoom', (payload, ack) => {
      try{
        const { name, maxPlayers, maxTotalScore, maxSingleScore, mapSize } = payload || {};
        const room = this.createRoom(socket.id, { name, maxPlayers, maxTotalScore, maxSingleScore, mapSize });
        ack && ack({ ok:true, id: room.id });
        this.broadcastRooms();
      }catch(e){
        ack && ack({ ok:false, error: e.message || '创建失败' });
      }
    });

    socket.on('joinRoom', (payload, ack) => {
      const { roomId, faction } = payload || {};
      const room = this.rooms.get(roomId);
      if (!room) return ack && ack({ ok:false, error:'房间不存在' });
      if (room.started) return ack && ack({ ok:false, error:'游戏已开始' });
      if (room.players.length >= room.maxPlayers) return ack && ack({ ok:false, error:'房间已满' });

      const player = {
        id: nanoid(6),
        socketId: socket.id,
        name: `P${room.players.length+1}`,
        faction: faction || (room.players.length===0?'A':'B'),
        units: [],
        placed: false,
        totalScore: 0,
        alive: true,
        damageDealt: 0
      };
      room.players.push(player);
      room._emptySince = null;

      socket.join(room.id);
      this.syncRoom(room.id);
      ack && ack({ ok:true, playerId: player.id, roomId: room.id });
      this.broadcastRooms();
    });

    socket.on('leaveRoom', (payload) => {
      const { roomId } = payload || {};
      const room = this.rooms.get(roomId);
      if (!room) return;
      const before = room.players.length;
      room.players = room.players.filter(p=>p.socketId!==socket.id);

      if (room.players.length===0){
        room._emptySince = Date.now();
      }else if (before !== room.players.length){
        if (room.hostSocketId === socket.id){
          room.hostSocketId = room.players[0].socketId;
        }
        this.syncRoom(roomId);
      }
      this.broadcastRooms();
    });

    // 开局（仅房主）
    socket.on('startGame', ({ roomId } = {}, ack) => {
      const room = this.rooms.get(roomId);
      if (!room) return ack && ack({ ok:false, error:'房间不存在' });
      if (room.hostSocketId !== socket.id) return ack && ack({ ok:false, error:'只有房主可开始' });
      if (room.players.length < 2) return ack && ack({ ok:false, error:'至少2名玩家' });

      const N = Math.min(200, Math.max(20, room.mapSize|0));
      room.points = generatePoints(N);
      room.edges  = connectEdges(room.points, 3 + Math.floor(Math.random()*2));
      room.sides  = splitSides(room.points);   // 仍生成，但不再用于放置限制
      room.graph  = buildGraph(room.points, room.edges);

      room.started = true;
      room.turn = 1;
      room.turnOrder = [];
      room.curTurnIndex = 0;
      room.actionsTaken = new Set();
      room.unitAt = new Map();
      room.units = new Map();
      room.killedAt = [];

      this.syncRoom(roomId);
      ack && ack({ ok:true });
    });

    // 单位列表
    socket.on('getUnitList', ({ roomId } = {}, ack) => {
      const room = this.rooms.get(roomId);
      if (!room) return ack && ack({ ok:false, error:'房间不存在' });
      ack && ack({ ok:true, units: PRESET_UNITS, maxSingle: room.maxSingleScore, maxTotal: room.maxTotalScore });
    });

    // 选单位（返回生成的 unitId，供前端逐个放置）
    socket.on('selectUnits', ({ roomId, picks } = {}, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false, error:'房间不存在或未开始' });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false, error:'玩家不存在' });

      const chosen = [];
      let total = 0;
      for (const key of (picks||[])){
        const base = PRESET_UNITS[key];
        if (!base) continue;
        if (base.score > room.maxSingleScore) continue;
        total += base.score;
        chosen.push({ ...base });
      }
      if (total > room.maxTotalScore) return ack && ack({ ok:false, error:'超过最大单位总分' });

      player.units = chosen.map((u, idx) => ({
        id: `${player.id}-${idx}`,
        owner: player.id,
        faction: player.faction,
        ...u,
        hpCur: u.hp,
        node: null,
        actedTurn: 0
      }));
      player.totalScore = total;
      player.placed = false;

      this.syncRoom(roomId);
      ack && ack({
        ok:true,
        total,
        units: player.units.map(u => ({ id:u.id, name:u.name, img:u.img, hp:u.hp, atk:u.atk, range:u.range, speed:u.speed, score:u.score }))
      });
    });

    // 放置单位（不再有“己方半区”限制；支持多次调用）
    socket.on('placeUnits', ({ roomId, placements } = {}, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false, error:'房间不存在或未开始' });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false, error:'玩家不存在' });
      if (!player.units?.length) return ack && ack({ ok:false, error:'尚未选择单位' });

      const ownedIds = new Set(player.units.map(u=>u.id));

      // 已放置的己方节点
      const existingPlacedNodes = new Set(player.units.filter(u=>u.node!=null).map(u=>u.node));
      let ownedPlacedNodes = new Set(existingPlacedNodes);

      // 校验：不可与已占节点冲突；首个随意，其后需与己方已落相邻（若你也要取消相邻，删掉相邻检查块即可）
      for (const pl of (placements||[])){
        const { unitId, nodeId } = pl || {};
        if (!ownedIds.has(unitId)) return ack && ack({ ok:false, error:'非法单位' });
        if (room.unitAt.get(nodeId)) return ack && ack({ ok:false, error:'目标点被占据' });

        // —— 相邻校验（如需移除相邻规则，删掉此块 7 行）——
        if (ownedPlacedNodes.size > 0){
          const ok = (room.graph.adj.get(nodeId)||[]).some(e => {
            const v = (e.a===nodeId)? e.b : e.a;
            return ownedPlacedNodes.has(v);
          });
          if (!ok) return ack && ack({ ok:false, error:'必须与己方已落单位相邻' });
        }
        // 更新“已落集合”，保证同一次批量内也能连着放
        ownedPlacedNodes.add(nodeId);
      }

      // 写入
      const byId = new Map(player.units.map(u=>[u.id,u]));
      for (const pl of (placements||[])){
        const u = byId.get(pl.unitId);
        if (!u) continue;
        u.node = pl.nodeId;
        room.unitAt.set(pl.nodeId, u.id);
        room.units.set(u.id, u);
      }

      // 只有当该玩家所有单位都落位，才视为 placed 完成
      const allPlaced = player.units.every(u=>u.node!=null);
      player.placed = allPlaced;

      // 全员放置完毕 -> 决定回合顺序（总分低者先）
      if (room.players.length > 0 && room.players.every(p=>p.placed)){
        room.turnOrder = [...room.players].sort((a,b)=>a.totalScore - b.totalScore).map(p=>p.id);
        room.curTurnIndex = 0;
      }

      this.syncRoom(roomId);
      ack && ack({ ok:true, allPlaced });
    });

    // 结束回合（仅当前手）
    socket.on('endTurn', ({ roomId } = {}, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false });

      const curPlayerId = (room.turnOrder || [])[room.curTurnIndex] || null;
      if (player.id !== curPlayerId) return ack && ack({ ok:false, error:'未到你的回合' });

      room.actionsTaken.clear();
      room.curTurnIndex = (room.curTurnIndex + 1) % room.turnOrder.length;
      if (room.curTurnIndex === 0) room.turn += 1;

      this.syncRoom(roomId);
      ack && ack({ ok:true });
    });

    // 行动
    socket.on('unitAction', ({ roomId, unitId, action, toNode, targetUnitId } = {}, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false });

      const curPlayerId = (room.turnOrder || [])[room.curTurnIndex] || null;
      if (player.id !== curPlayerId) return ack && ack({ ok:false, error:'未到你的回合' });

      const unit = room.units.get(unitId);
      if (!unit || unit.owner !== player.id) return ack && ack({ ok:false, error:'非法单位' });
      if (room.actionsTaken.has(unitId)) return ack && ack({ ok:false, error:'该单位本回合已行动' });

      if (action === 'move'){
        if (toNode==null) return ack && ack({ ok:false, error:'缺少目标点' });
        if (room.unitAt.get(toNode)) return ack && ack({ ok:false, error:'目标被占据' });

        const occupied = new Set([...room.unitAt.keys()]);
        occupied.delete(unit.node);
        const sp = shortestPath(room.graph, unit.node, toNode, occupied);
        if (!sp.path.length || sp.cost===Infinity) return ack && ack({ ok:false, error:'不可达' });
        if (sp.cost > unit.speed * 4) return ack && ack({ ok:false, error:'超出速度可达范围' });

        room.unitAt.delete(unit.node);
        unit.node = toNode;
        room.unitAt.set(unit.node, unit.id);
        room.actionsTaken.add(unitId);

        this.logger.logUnitEvent({ type:'move', roomId, unitId, owner:unit.owner, cost: sp.cost });
        this.syncRoom(roomId);
        return ack && ack({ ok:true });
      }

      if (action === 'attack'){
        if (!targetUnitId) return ack && ack({ ok:false, error:'缺少目标' });
        const target = room.units.get(targetUnitId);
        if (!target || target.faction === unit.faction) return ack && ack({ ok:false, error:'非法目标' });

        const sp = shortestPath(room.graph, unit.node, target.node, new Set());
        if (!sp.path.length) return ack && ack({ ok:false, error:'不可达' });

        let inRange = false;
        if (sameRoad(room.graph, sp.path)) inRange = sp.cost <= unit.range;
        else inRange = sp.cost <= 1;
        if (!inRange) return ack && ack({ ok:false, error:'不在射程内或不可转弯' });

        target.hpCur -= unit.atk;
        player.damageDealt += unit.atk;
        this.logger.logUnitEvent({ type:'attack', roomId, attacker:unitId, target:targetUnitId, dmg: unit.atk });

        if (target.hpCur <= 0){
          room.unitAt.delete(target.node);
          room.units.delete(target.id);
          room.killedAt.push({ unitId: target.id, owner: target.owner, faction: target.faction, turn: room.turn });

          const aliveA = [...room.units.values()].some(u=>u.faction==='A');
          const aliveB = [...room.units.values()].some(u=>u.faction==='B');
          if (!aliveA || !aliveB){
            const winner = aliveA ? 'A' : (aliveB ? 'B' : 'draw');
            this.finishMatch(room, winner);
          }
        }

        room.actionsTaken.add(unitId);
        this.syncRoom(roomId);
        return ack && ack({ ok:true });
      }

      return ack && ack({ ok:false, error:'未知动作' });
    });

    // 断线：延迟清房
    socket.on('disconnect', () => {
      for (const room of this.rooms.values()){
        const before = room.players.length;
        room.players = room.players.filter(p=>p.socketId!==socket.id);

        if (room.players.length === 0){
          room._emptySince = Date.now();
        }else if (before !== room.players.length){
          if (room.hostSocketId === socket.id){
            room.hostSocketId = room.players[0].socketId;
          }
          this.syncRoom(room.id);
        }
      }
      this.broadcastRooms();
    });
  }

  createRoom(hostSocketId, opts){
    const id = nanoid(6);
    const room = {
      id,
      name: (opts.name || `房间-${id}`).slice(0,40),
      hostSocketId,
      maxPlayers: Math.max(2, Math.min(8, opts.maxPlayers|0 || 2)),
      maxTotalScore: Math.max(200, opts.maxTotalScore|0 || 1000),
      maxSingleScore: Math.max(100, opts.maxSingleScore|0 || 600),
      mapSize: Math.min(200, Math.max(20, opts.mapSize|0 || 80)),
      // 初始化避免 lobby 阶段 undefined
      players: [],
      started: false,
      turn: 0,
      turnOrder: [],
      curTurnIndex: 0,
      actionsTaken: new Set(),
      units: new Map(),
      unitAt: new Map(),
      points: [],
      edges: [],
      sides: {},
      graph: buildGraph([], []),
      killedAt: [],
      _emptySince: null
    };
    this.rooms.set(id, room);
    return room;
  }

  finishMatch(room, winnerFaction){
    room.started = false;
    const sumA = room.players.filter(p=>p.faction==='A').reduce((s,p)=>s+p.damageDealt,0);
    const sumB = room.players.filter(p=>p.faction==='B').reduce((s,p)=>s+p.damageDealt,0);
    const stats = {
      roomId: room.id,
      name: room.name,
      turns: room.turn,
      damageA: sumA, damageB: sumB,
      winner: winnerFaction,
      killed: room.killedAt
    };
    this.logger.logMatch(stats);
    this.io.to(room.id).emit('matchOver', stats);
  }

  buildVisibleState(roomId, forSocketId){
    const room = this.rooms.get(roomId);
    if (!room) return null;
    if (!(room.units instanceof Map)) room.units = new Map();
    if (!Array.isArray(room.turnOrder)) room.turnOrder = [];
    if (typeof room.curTurnIndex !== 'number') room.curTurnIndex = 0;

    const me = room.players.find(p=>p.socketId===forSocketId);
    const myFaction = me?.faction || 'A';
    const visibleUnits = [];

    for (const u of room.units.values()){
      if (u.faction === myFaction){
        visibleUnits.push(u);
      }else{
        visibleUnits.push({
          id: u.id, owner: u.owner, faction: u.faction,
          hpCur: u.hpCur, hp: u.hp, atk: u.atk, range: u.range, speed: u.speed, score: u.score,
          node: null, img: u.img, name: u.name
        });
      }
    }

    return {
      id: room.id,
      name: room.name,
      started: room.started,
      turn: room.turn,
      turnOrder: room.turnOrder,
      curTurn: (room.turnOrder || [])[room.curTurnIndex] || null,
      players: room.players.map(p=>({ id:p.id, name:p.name, faction:p.faction, placed:p.placed, totalScore:p.totalScore, damageDealt:p.damageDealt })),
      limits: { maxPlayers: room.maxPlayers, maxTotalScore: room.maxTotalScore, maxSingleScore: room.maxSingleScore },
      map: { points: room.points, edges: room.edges, sides: room.sides },
      units: visibleUnits
    };
  }

  syncRoom(roomId){
    const room = this.rooms.get(roomId);
    if (!room) return;
    for (const p of room.players){
      const state = this.buildVisibleState(roomId, p.socketId);
      if (state) this.io.to(p.socketId).emit('roomState', state);
    }
  }
  broadcastRooms(){
    const list = [...this.rooms.values()].map(r => ({
      id: r.id, name: r.name, maxPlayers: r.maxPlayers, curPlayers: r.players.length, started: r.started
    }));
    this.io.emit('rooms', list);
  }
}

module.exports = GameEngine;
