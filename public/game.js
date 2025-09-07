// public/game.js
window.Game = (function(){
  const cvs = document.getElementById('canvas');
  const ctx = cvs.getContext('2d');

  let state = null;
  let myPlayerId = null;
  let myRoomId = null;

  const logPane = document.getElementById('log');
  function log(msg){ logPane.textContent += msg + '\n'; logPane.scrollTop = logPane.scrollHeight; }

  function setIdentifiers({ playerId, roomId }){ myPlayerId = playerId; myRoomId = roomId; }
  function setState(s){ state = s; draw(); updateHUD(); }

  function isPlacementPhase(){
    return !!(state?.started && (!state.turnOrder || state.turnOrder.length===0));
  }

  function updateHUD(){
    const tinfo = document.getElementById('turn-info');
    const endBtn = document.getElementById('btn-endturn');

    if (!state?.started){
      tinfo.textContent = '等待开始或正在放置单位…';
      endBtn.disabled = true;
      return;
    }
    if (isPlacementPhase()){
      tinfo.textContent = `回合 ${state.turn} | 放置阶段：等待所有玩家放置完单位`;
      endBtn.disabled = true; // 放置阶段禁用结束回合
      return;
    }
    const me = state.players.find(p=>p.id===myPlayerId);
    const cur = state.curTurn;
    const isMe = cur === myPlayerId;
    tinfo.textContent = `回合 ${state.turn} | 当前手：${cur||'未知'} ${isMe?'(你)':''} | 我方：${me?.faction}`;
    endBtn.disabled = !isMe;
  }

  function toScreen(p){
    const pad = 40;
    const W = cvs.width - pad*2, H = cvs.height - pad*2;
    return { x: pad + (p.x+1)/2*W, y: pad + (p.y+1)/2*H };
  }
  const Images = (function(){
    const map = new Map();
    function get(src){
      if (!src) return null;
      if (map.has(src)) return map.get(src);
      const img = new Image(); img.src = src; map.set(src, img); return img;
    }
    return { get };
  })();

  // 交互
  let selectedUnitId = null;

  function draw(){
    ctx.clearRect(0,0,cvs.width,cvs.height);
    if (!state) return;
    ctx.fillStyle = '#0a0d12'; ctx.fillRect(0,0,cvs.width,cvs.height);

    // 边
    if (state.map?.edges && state.map?.points){
      for (const e of state.map.edges){
        const a = state.map.points[e.a], b = state.map.points[e.b];
        const A = toScreen(a), B = toScreen(b);
        ctx.strokeStyle = '#2a3342'; ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(A.x,A.y); ctx.lineTo(B.x,B.y); ctx.stroke();
        if (e.w > 1){
          const n = e.w-1;
          for (let i=1;i<=n;i++){
            const t = i/(e.w);
            const x = A.x + (B.x-A.x)*t, y = A.y + (B.y-A.y)*t;
            ctx.fillStyle = '#314055';
            ctx.beginPath(); ctx.arc(x,y,3,0,Math.PI*2); ctx.fill();
          }
        }
      }
    }
    // 点
    if (state.map?.points){
      for (const p of state.map.points){
        const S = toScreen(p);
        ctx.fillStyle = '#0e1420';
        ctx.beginPath(); ctx.arc(S.x,S.y,8,0,Math.PI*2); ctx.fill();
        ctx.strokeStyle = '#3a465a'; ctx.lineWidth = 2; ctx.stroke();
      }
    }
    // 单位（我方可见坐标，敌方隐藏）
    if (state.units){
      for (const u of state.units){
        if (u.node==null) continue;
        const p = state.map.points[u.node]; if (!p) continue;
        const S = toScreen(p);

        ctx.fillStyle = (u.faction==='A') ? '#2a79ff' : '#e85b5b';
        ctx.beginPath(); ctx.arc(S.x,S.y,16,0,Math.PI*2); ctx.fill();

        const img = Images.get(u.img);
        if (img) ctx.drawImage(img, S.x-18, S.y-18, 36,36);
        else { ctx.fillStyle = '#fff'; ctx.beginPath(); ctx.arc(S.x,S.y,12,0,Math.PI*2); ctx.fill(); }

        const w = 28, h=5;
        const ratio = Math.max(0, u.hpCur / u.hp);
        ctx.fillStyle = '#111'; ctx.fillRect(S.x-w/2, S.y-26, w, h);
        ctx.fillStyle = ratio>0.5?'#1ec28b':(ratio>0.2?'#e8c85b':'#e85b5b');
        ctx.fillRect(S.x-w/2, S.y-26, w*ratio, h);

        if (u.id === selectedUnitId){
          ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 3;
          ctx.beginPath(); ctx.arc(S.x,S.y,20,0,Math.PI*2); ctx.stroke();
        }
      }
    }
  }

  // 点击
  cvs.addEventListener('click', (e)=>{
    if (!state) return;
    const rect = cvs.getBoundingClientRect();
    const x = e.clientX - rect.left, y = e.clientY - rect.top;

    // 命中
    let hitUnit = null, hitNode = null;
    if (state.units){
      for (const u of state.units){
        if (u.node==null) continue;
        const p = state.map.points[u.node]; const S = toScreen(p);
        if (Math.hypot(S.x-x, S.y-y) <= 18){ hitUnit = u; break; }
      }
    }
    if (!hitUnit && state.map?.points){
      for (const p of state.map.points){
        const S = toScreen(p);
        if (Math.hypot(S.x-x, S.y-y) <= 10){ hitNode = p.id; break; }
      }
    }

    // 放置阶段：点击空节点依次放置
    if (isPlacementPhase()){
      if (hitNode!=null){
        const queue = (window.Client.pendingUnits || []);
        const i = window.Client.placeCursor|0;
        if (queue[i]){
          const unitId = queue[i].id;
          Net.emit('placeUnits', { roomId: myRoomId, placements: [{ unitId, nodeId: hitNode }] }, (res)=>{
            if (!res?.ok){ log(`放置失败：${res?.error||'未知'}`); return; }
            window.Client.placeCursor = i + 1;
            log(`已放置 ${i+1}/${queue.length}`);
          });
        }else{
          log('你已放置完全部单位；等待对手完成。');
        }
      }
      return;
    }

    // 战斗阶段
    if (!state?.started) return;

    const meFaction = state.players.find(p=>p.id===myPlayerId)?.faction || 'A';
    if (!selectedUnitId){
      if (hitUnit && hitUnit.faction===meFaction){
        selectedUnitId = hitUnit.id; draw();
      }
      return;
    }else{
      if (hitUnit){
        if (hitUnit.faction !== meFaction){
          window.Client.attack(selectedUnitId, hitUnit.id);
          selectedUnitId = null;
        }else{
          selectedUnitId = hitUnit.id;
        }
        draw();
        return;
      }
      if (hitNode!=null){
        window.Client.move(selectedUnitId, hitNode);
        selectedUnitId = null;
        draw();
        return;
      }
    }
  });

  return { setState, setIdentifiers, log, draw, updateHUD };
})();
