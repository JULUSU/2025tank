const fs = require('fs');
const path = require('path');

class BalanceLogger {
  constructor(){
    this.matchLog = path.join(__dirname, '..', 'data', 'matches.log.jsonl');
    this.unitLog  = path.join(__dirname, '..', 'data', 'units_balancing.log.jsonl');
  }
  logMatch(obj){
    fs.appendFile(this.matchLog, JSON.stringify({ ts:Date.now(), ...obj })+'\n', ()=>{});
  }
  logUnitEvent(obj){
    fs.appendFile(this.unitLog, JSON.stringify({ ts:Date.now(), ...obj })+'\n', ()=>{});
  }
}

module.exports = BalanceLogger;
