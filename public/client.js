(function(){
  const { S } = UI;

  // --- 全局标识（由服务器 ack 设置） ---
  window.Client = {
    myPlayerId: null,
    myRoomId: null,
    move(unitId, nodeId){
      Net.emit('unitAction', { roomId:this.myRoomId, unitId, action:'move', toNode: nodeId }, (res)=>{
        if (!res?.ok) Game.log(`移动失败：${res?.error||'未知'}`); 
      });
    },
    attack(unitId, targetId){
      Net.emit('unitAction', { roomId:this.myRoomId, unitId, action:'attack', targetUnitId: targetId }, (res)=>{
        if (!res?.ok) Game.log(`攻击失败：${res?.error||'未知'}`); 
      });
    }
  };

  // --- 房间列表 ---
  function refreshRooms(){
    Net.emit('listRooms');
  }
  Net.on('rooms', (list) => {
    S.roomList.innerHTML = '';
    list.forEach(r => {
      const div = document.createElement('div');
      div.className = 'room';
      div.innerHTML = `
        <div>${r.name} <span class="badge">${r.curPlayers}/${r.maxPlayers}${r.started?' | 已开始':''}</span></div>
        <button ${r.started?'disabled':''}>加入</button>
      `;
      div.querySelector('button').onclick = () => {
        Net.emit('joinRoom', { roomId: r.id, faction: S.joinFaction.value }, (ack) => {
          if (!ack?.ok) return alert(ack.error||'加入失败');
          enterLobby(ack.roomId, ack.playerId);
        });
      };
      S.roomList.appendChild(div);
    });
  });

  // --- 创建房间 ---
  S.btnCreate.onclick = () => {
    const payload = {
      name: S.rName.value || '我的房间',
      maxPlayers: +S.rMaxPlayers.value || 2,
      maxTotalScore: +S.rMaxTotal.value || 1000,
      maxSingleScore: +S.rMaxSingle.value || 600,
      mapSize: +S.rMapSize.value || 80
    };
    Net.emit('createRoom', payload, (ack)=>{
      if (!ack?.ok) return alert(ack.error||'创建失败');
      Net.emit('joinRoom', { roomId: ack.id, faction: 'A' }, (ack2)=>{
        if (!ack2?.ok) return alert(ack2.error||'加入失败');
        enterLobby(ack2.roomId, ack2.playerId);
      });
    });
  };

  // --- 进入大厅 ---
  function enterLobby(roomId, playerId){
    window.Client.myRoomId = roomId;
    window.Client.myPlayerId = playerId;
    Game.setIdentifiers({ roomId, playerId });

    S.menu.classList.add('hidden');
    S.lobby.classList.remove('hidden');

    // 请求单位列表
    Net.emit('getUnitList', { roomId }, (ack)=>{
      if (!ack?.ok) return;
      renderUnitPicks(ack.units, ack.maxSingle, ack.maxTotal);
    });
  }

  // --- 渲染单位选择 ---
  let pickKeys = [];
  function renderUnitPicks(units, maxSingle, maxTotal){
    S.unitsWrap.innerHTML = '';
    S.pickMax.textContent = maxTotal;
    pickKeys = [];
    for (const key of Object.keys(units)){
      const u = units[key];
      const card = document.createElement('div');
      card.className = 'unit-card';
      card.innerHTML = `
        <img src="${u.img}" alt="${u.name}" />
        <div style="flex:1">
          <div><strong>${u.name}</strong> <span class="badge">分:${u.score}</span></div>
          <div>HP:${u.hp} ATK:${u.atk} RNG:${u.range} SPD:${u.speed}</div>
        </div>
        <button>添加</button>
      `;
      const btn = card.querySelector('button');
      btn.onclick = () => {
        if (u.score > maxSingle) return alert('超过最大单个单位分');
        pickKeys.push(key);
        updatePickTotal(units, maxTotal);
      };
      S.unitsWrap.appendChild(card);
    }
    S.btnSubmitPicks.onclick = () => {
      const total = computeTotal(units, pickKeys);
      if (total > maxTotal) return alert('超过最大单位总分');
      Net.emit('selectUnits', { roomId: window.Client.myRoomId, picks: pickKeys }, (ack)=>{
        if (!ack?.ok) return alert(ack.error||'提交失败');
        alert('已提交阵容：' + ack.total);
      });
    };
  }

  function computeTotal(units, keys){
    return keys.reduce((s,k)=> s + (units[k]?.score||0), 0);
  }
  function updatePickTotal(units, maxTotal){
    const t = computeTotal(units, pickKeys);
    S.pickTotal.textContent = t;
    if (t>maxTotal) S.pickTotal.style.color = '#e85b5b'; else S.pickTotal.style.color = '#eaeef3';
  }

  // --- 房主开始游戏 / 离开房间 ---
  S.btnStart.onclick = ()=> {
    Net.emit('startGame', { roomId: window.Client.myRoomId }, (ack)=>{
      if (!ack?.ok) return alert(ack.error||'开始失败');
    });
  };
  S.btnLeave.onclick = ()=> {
    Net.emit('leaveRoom', { roomId: window.Client.myRoomId });
    location.reload();
  };

  // --- 服务器状态同步（雾隐可见态） ---
  Net.on('roomState', (state)=>{
    // 切屏：当 started==true -> 进入游戏画面；否则停留大厅
    if (state.started){
      document.getElementById('lobby').classList.add('hidden');
      document.getElementById('game').classList.remove('hidden');

      // 首次开始后：提示玩家去地图上放置单位（按规则）
      Game.log('提示：在己方半区选择首个单位落点，之后每个新单位必须与己方已落单位相邻。');
    }
    // 更新房间信息
    UI.S.lobbyInfo.textContent = `房间【${state.name}】玩家：` + state.players.map(p=>`${p.name}(${p.faction})${p.placed?'✅':''}`).join('，');

    Game.setState(state);
    Game.draw();
  });

  // --- 结束回合按钮 ---
  document.getElementById('btn-endturn').onclick = () => {
    Net.emit('endTurn', { roomId: window.Client.myRoomId }, (ack)=>{
      if (!ack?.ok) Game.log(`结束失败：${ack?.error||'未知'}`);
    });
  };

  // --- 比赛结束 ---
  Net.on('matchOver', (stats) => {
    Game.log(`比赛结束，胜者：${stats.winner} | 回合数：${stats.turns} | A伤害:${stats.damageA} | B伤害:${stats.damageB}`);
    alert('比赛结束！查看日志区统计。');
  });

  // 初次载入拉取房间列表
  refreshRooms();
  setInterval(refreshRooms, 3000);
})();
