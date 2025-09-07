const { nanoid } = require('nanoid');
const { PRESET_UNITS, scoreOf } = require('./units');
const { generatePoints, connectEdges, splitSides } = require('./map');
const BalanceLogger = require('./balanceLogger');

function now(){ return Date.now(); }

// 简单最短路（Dijkstra）基于边权 w（1..4）
function shortestPath(graph, start, goal, blockedNodes = new Set()){
  const dist = new Map(), prev = new Map();
  const Q = new Set(graph.nodes);
  graph.nodes.forEach(n => dist.set(n, Infinity));
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

    for (const e of graph.adj.get(u) || []){
      const v = (e.a === u) ? e.b : e.a;
      // 不能穿过被占据节点（起点除外）
      if (v !== start && blockedNodes.has(v)) continue;
      const alt = dist.get(u) + e.w;
      if (alt < dist.get(v)){
        dist.set(v, alt);
        prev.set(v, u);
      }
    }
  }
  if (dist.get(goal) === Infinity) return { cost: Infinity, path: [] };
  const path = [];
  let cur = goal;
  while (cur !== undefined){
    path.unshift(cur);
    cur = prev.get(cur);
  }
  return { cost: dist.get(goal), path };
}

function buildGraph(points, edges){
  const nodes = points.map(p=>p.id);
  const adj = new Map();
  for (const id of nodes) adj.set(id, []);
  for (const e of edges){
    adj.get(e.a).push(e);
    adj.get(e.b).push(e);
  }
  return { nodes, adj, edges };
}

function sameRoad(graph, path){
  if (path.length < 2) return true;
  // 检查每条边方向桶是否一致
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

class GameEngine {
  constructor(io){
    this.io = io;
    this.rooms = new Map(); // roomId -> room
    this.logger = new BalanceLogger();
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
        const { name, maxPlayers, maxTotalScore, maxSingleScore, mapSize } = payload;
        const room = this.createRoom(socket.id, { name, maxPlayers, maxTotalScore, maxSingleScore, mapSize });
        ack && ack({ ok:true, id: room.id });
        this.broadcastRooms();
      }catch(e){
        ack && ack({ ok:false, error: e.message });
      }
    });

    socket.on('joinRoom', (payload, ack) => {
      const { roomId, faction } = payload;
      const room = this.rooms.get(roomId);
      if (!room) return ack && ack({ ok:false, error:'房间不存在' });
      if (room.started) return ack && ack({ ok:false, error:'游戏已开始' });
      if (room.players.length >= room.maxPlayers) return ack && ack({ ok:false, error:'房间已满' });

      const isHost = room.hostSocketId === room.players[0]?.socketId;
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
      socket.join(room.id);
      this.syncRoom(room.id);
      ack && ack({ ok:true, playerId: player.id, roomId: room.id });
      this.broadcastRooms();
    });

    socket.on('leaveRoom', (payload) => {
      const { roomId } = payload || {};
      const room = this.rooms.get(roomId);
      if (!room) return;
      room.players = room.players.filter(p=>p.socketId!==socket.id);
      if (room.players.length===0){
        this.rooms.delete(roomId);
      }else{
        if (room.hostSocketId === socket.id){
          // 迁移房主
          room.hostSocketId = room.players[0].socketId;
        }
      }
      this.broadcastRooms();
      this.syncRoom(roomId);
    });

    socket.on('startGame', ({ roomId }, ack) => {
      const room = this.rooms.get(roomId);
      if (!room) return ack && ack({ ok:false, error:'房间不存在' });
      if (room.hostSocketId !== socket.id) return ack && ack({ ok:false, error:'只有房主可开始' });
      if (room.players.length < 2) return ack && ack({ ok:false, error:'至少2人' });

      // 生成地图
      const N = Math.min(200, Math.max(20, room.mapSize|0));
      room.points = generatePoints(N);
      room.edges  = connectEdges(room.points, 3 + Math.floor(Math.random()*2));
      room.sides  = splitSides(room.points);
      room.graph  = buildGraph(room.points, room.edges);

      room.started = true;
      room.turn = 1;
      room.turnOrder = []; // 待选完单位后计算
      room.curTurnIndex = 0;
      room.actionsTaken = new Set(); // 本回合已行动过的单位id
      room.unitAt = new Map(); // nodeId -> unitId
      room.units = new Map(); // unitId -> unit
      room.killedAt = []; // 用于统计
      this.syncRoom(roomId);
      ack && ack({ ok:true });
    });

    // 客户端请求预设单位与可用性
    socket.on('getUnitList', ({ roomId }, ack) => {
      const room = this.rooms.get(roomId);
      if (!room) return ack && ack({ ok:false, error:'房间不存在' });
      ack && ack({ ok:true, units: PRESET_UNITS, maxSingle: room.maxSingleScore, maxTotal: room.maxTotalScore });
    });

    // 选择单位（阵容），校验单个分与总分
    socket.on('selectUnits', ({ roomId, picks }, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false, error:'房间不存在或未开始' });

      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false, error:'玩家不存在' });

      const chosen = [];
      let total = 0;
      for (const key of picks){
        const base = PRESET_UNITS[key];
        if (!base) continue;
        const s = base.score;
        if (s > room.maxSingleScore) continue;
        total += s;
        chosen.push({ ...base });
      }
      if (total > room.maxTotalScore) return ack && ack({ ok:false, error:'超过最大单位总分' });

      player.units = chosen.map((u, idx) => ({
        id: `${player.id}-${idx}`,
        owner: player.id,
        faction: player.faction,
        ...u,
        hpCur: u.hp,
        node: null, // 尚未落位
        actedTurn: 0
      }));
      player.totalScore = total;
      player.placed = false;

      this.syncRoom(roomId);
      ack && ack({ ok:true, total });
    });

    // 放置单位：第一个任意己方半区；之后必须与己有单位相邻（通过图连边）
    socket.on('placeUnits', ({ roomId, placements }, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false, error:'房间不存在或未开始' });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false, error:'玩家不存在' });
      if (!player.units?.length) return ack && ack({ ok:false, error:'尚未选择单位' });

      const ownedIds = new Set(player.units.map(u=>u.id));
      // 校验
      let firstPlaced = false;
      let ownedPlacedNodes = new Set();
      for (const pl of placements){
        const { unitId, nodeId } = pl;
        if (!ownedIds.has(unitId)) return ack && ack({ ok:false, error:'非法单位' });
        if (room.unitAt.get(nodeId)) return ack && ack({ ok:false, error:'目标点被占据' });
        const side = room.sides[nodeId];
        const needSide = player.faction==='A' ? 'A' : 'B';
        if (!firstPlaced){
          if (side !== needSide) return ack && ack({ ok:false, error:'首个单位必须在己方半区' });
        }else{
          // 必须与已放置节点相邻
          const ok = (room.graph.adj.get(nodeId)||[]).some(e => {
            const v = (e.a===nodeId)? e.b : e.a;
            return ownedPlacedNodes.has(v);
          });
          if (!ok) return ack && ack({ ok:false, error:'必须与已放置单位相邻' });
        }
        firstPlaced = true;
        ownedPlacedNodes.add(nodeId);
      }
      // 写入
      const byId = new Map(player.units.map(u=>[u.id,u]));
      for (const pl of placements){
        const u = byId.get(pl.unitId);
        if (!u) continue;
        u.node = pl.nodeId;
        room.unitAt.set(pl.nodeId, u.id);
        room.units.set(u.id, u);
      }
      player.placed = true;

      // 若所有玩家都放置完毕，确定回合顺序（总分低者先）
      if (room.players.every(p=>p.placed)){
        room.turnOrder = [...room.players].sort((a,b)=>a.totalScore - b.totalScore).map(p=>p.id);
        room.curTurnIndex = 0;
      }

      this.syncRoom(roomId);
      ack && ack({ ok:true });
    });

    socket.on('endTurn', ({ roomId }, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false });

      // 仅当前手可结束
      const curPlayerId = room.turnOrder[room.curTurnIndex];
      if (player.id !== curPlayerId) return ack && ack({ ok:false, error:'未到你的回合' });

      // 重置该回合行动标记
      room.actionsTaken.clear();
      // 下一个玩家
      room.curTurnIndex = (room.curTurnIndex + 1) % room.turnOrder.length;
      if (room.curTurnIndex === 0) room.turn += 1;

      this.syncRoom(roomId);
      ack && ack({ ok:true });
    });

    // 单位行动：move 或 attack（每单位每回合一次）
    socket.on('unitAction', ({ roomId, unitId, action, toNode, targetUnitId }, ack) => {
      const room = this.rooms.get(roomId);
      if (!room || !room.started) return ack && ack({ ok:false });
      const player = room.players.find(p=>p.socketId===socket.id);
      if (!player) return ack && ack({ ok:false });

      const curPlayerId = room.turnOrder[room.curTurnIndex];
      if (player.id !== curPlayerId) return ack && ack({ ok:false, error:'未到你的回合' });

      const unit = room.units.get(unitId);
      if (!unit || unit.owner !== player.id) return ack && ack({ ok:false, error:'非法单位' });
      if (room.actionsTaken.has(unitId)) return ack && ack({ ok:false, error:'该单位本回合已行动' });

      if (action === 'move'){
        if (toNode==null) return ack && ack({ ok:false, error:'缺少目标点' });
        if (room.unitAt.get(toNode)) return ack && ack({ ok:false, error:'目标被占据' });

        // 阻挡：路径上不能经过任何占据节点（起点除外）
        const occupied = new Set([...room.unitAt.keys()]);
        occupied.delete(unit.node); // 起点允许
        const sp = shortestPath(room.graph, unit.node, toNode, occupied);
        if (!sp.path.length || sp.cost===Infinity) return ack && ack({ ok:false, error:'不可达' });

        // 距离与速度比较
        if (sp.cost > unit.speed * 4 /* 调整步长尺度 */){
          return ack && ack({ ok:false, error:'超出速度可达范围' });
        }

        // 执行移动
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

        // 计算从 unit.node 到 target.node 的最短路径
        const sp = shortestPath(room.graph, unit.node, target.node, new Set()); // 攻击不考虑阻挡，但“不能转弯”和射程规则在后面校验
        if (!sp.path.length) return ack && ack({ ok:false, error:'不可达' });

        let inRange = false;
        if (sameRoad(room.graph, sp.path)){
          // 直线：可使用单位射程（按边权总和对比）
          inRange = sp.cost <= unit.range;
        }else{
          // 非直线：射程固定为1（相邻一个边权）
          inRange = sp.cost <= 1;
        }
        if (!inRange) return ack && ack({ ok:false, error:'不在射程内或转弯' });

        // 结算伤害
        target.hpCur -= unit.atk;
        player.damageDealt += unit.atk;
        this.logger.logUnitEvent({ type:'attack', roomId, attacker:unitId, target:targetUnitId, dmg: unit.atk });

        if (target.hpCur <= 0){
          // 单位死亡：从地图清除
          room.unitAt.delete(target.node);
          room.units.delete(target.id);
          room.killedAt.push({ unitId: target.id, owner: target.owner, faction: target.faction, turn: room.turn });

          // 若某一方单位耗尽 -> 结束
          const aliveA = [...room.units.values()].some(u=>u.faction==='A');
          const aliveB = [...room.units.values()].some(u=>u.faction==='B');
          if (!aliveA || !aliveB){
            const winner = aliveA ? 'A' : (aliveB ? 'B' : 'draw');
            this.finishMatch(room, winner);
          }
        }

        room.actionsTaken.add(unitId);
        this.syncRoom(room.id);
        return ack && ack({ ok:true });
      }

      return ack && ack({ ok:false, error:'未知动作' });
    });

    socket.on('disconnect', () => {
      // 若断开在房间内，尝试从房间移除
      for (const room of this.rooms.values()){
        const before = room.players.length;
        room.players = room.players.filter(p=>p.socketId!==socket.id);
        if (room.players.length===0){
          this.rooms.delete(room.id);
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
      name: opts.name?.slice(0,40) || `房间-${id}`,
      hostSocketId,
      maxPlayers: Math.max(2, Math.min(8, opts.maxPlayers|0 || 2)),
      maxTotalScore: Math.max(200, opts.maxTotalScore|0 || 1000),
      maxSingleScore: Math.max(100, opts.maxSingleScore|0 || 600),
      mapSize: Math.min(200, Math.max(20, opts.mapSize|0 || 80)),
      players: [],
      started: false
    };
    this.rooms.set(id, room);
    return room;
  }

  finishMatch(room, winnerFaction){
    room.started = false;
    // 汇总统计
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

  // 仅发送“可见信息”：雾隐（只发送自己阵营+盟友单位坐标；敌方单位隐藏为未知）
  buildVisibleState(roomId, forSocketId){
    const room = this.rooms.get(roomId);
    if (!room) return null;
    const me = room.players.find(p=>p.socketId===forSocketId);
    const myFaction = me?.faction || 'A';
    const visibleUnits = [];
    for (const u of room.units.values()){
      if (u.faction === myFaction){
        visibleUnits.push(u);
      }else{
        // 敌方隐藏位置，但前端需要知道敌方数量？这里完全不发敌方坐标
        visibleUnits.push({
          id: u.id, owner: u.owner, faction: u.faction,
          hpCur: u.hpCur, hp: u.hp, atk: u.atk, range: u.range, speed: u.speed, score: u.score,
          node: null, img: u.img, name: u.name // 保留属性但不暴露 node
        });
      }
    }
    return {
      id: room.id,
      name: room.name,
      started: room.started,
      turn: room.turn,
      turnOrder: room.turnOrder,
      curTurn: room.turnOrder[room.curTurnIndex] || null,
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
      this.io.to(p.socketId).emit('roomState', state);
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
