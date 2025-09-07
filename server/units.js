// 单位分公式：score = hp + atk + 100*range + 200*speed
function scoreOf(u){
  return Math.round(u.hp + u.atk + 100*u.range + 200*u.speed);
}

// 预设三个单位（你可改数值或新增）
const PRESET_UNITS = {
  swordsman: { key:'swordsman', name:'重装步兵', hp:200, atk:30, range:1, speed:0.7, img:'/assets/units/swordsman.svg' },
  archer:    { key:'archer',    name:'弓手',     hp:80,  atk:20, range:2, speed:1.0, img:'/assets/units/archer.svg'    },
  rider:     { key:'rider',     name:'轻骑',     hp:50,  atk:10, range:1, speed:1.5, img:'/assets/units/rider.svg'     }
};

for (const k of Object.keys(PRESET_UNITS)){
  PRESET_UNITS[k].score = scoreOf(PRESET_UNITS[k]);
}

module.exports = { PRESET_UNITS, scoreOf };
