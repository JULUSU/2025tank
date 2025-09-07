const { randBetween, clamp } = require('./util');

// 生成 N 个点，[-1,1] 坐标，稍后前端映射到画布
function generatePoints(n){
  const pts = [];
  for (let i=0;i<n;i++){
    pts.push({ id:i, x: randBetween(-1,1), y: randBetween(-1,1) });
  }
  return pts;
}

// k近邻连边，权重=欧氏距离，长度分档到[1..4]
function connectEdges(points, k=3){
  const edges = [];
  for (const a of points){
    const others = points.filter(p=>p!==a)
      .map(b => ({ b, d: Math.hypot(a.x-b.x, a.y-b.y) }))
      .sort((u,v)=>u.d-v.d)
      .slice(0,k);
    for (const {b,d} of others){
      const key1 = `${a.id}-${b.id}`;
      const key2 = `${b.id}-${a.id}`;
      if (edges.find(e=> (e.a===a.id && e.b===b.id) || (e.a===b.id && e.b===a.id))) continue;
      const w = lengthBucket(d);
      const dir = directionBucket(a,b); // 用于直线“路”判定
      edges.push({ a:a.id, b:b.id, w, dir });
    }
  }
  return edges;
}

// 将连续距离映射到 1..4 四档（渲染时>1显示刻度点）
function lengthBucket(d){
  // d 基于 [-1,1] 空间，粗略线性映射
  const scaled = d*3; // 调整密度
  if (scaled < 0.8) return 1;
  if (scaled < 1.2) return 2;
  if (scaled < 1.8) return 3;
  return 4;
}

// 为“直线不可转弯攻击/射程”判定做方向离散
function directionBucket(a,b){
  const dx = b.x - a.x, dy = b.y - a.y;
  const ang = Math.atan2(dy,dx); // -PI..PI
  // 量化到 16 个方向桶
  const bins = 16;
  const bucket = Math.round(((ang + Math.PI) / (2*Math.PI)) * bins) % bins;
  return bucket;
}

// 随机二分地图（雾隐阵营区）：用随机直线将点分为 sideA/sideB
function splitSides(points){
  const ang = randBetween(0, Math.PI);
  const nx = Math.cos(ang), ny = Math.sin(ang);
  const c  = randBetween(-0.2,0.2);
  const sides = {};
  for (const p of points){
    const s = Math.sign(p.x*nx + p.y*ny + c);
    sides[p.id] = (s>=0)? 'A' : 'B';
  }
  return sides;
}

module.exports = { generatePoints, connectEdges, splitSides };
