function clamp(n, a, b){ return Math.max(a, Math.min(b, n)); }
function randBetween(a,b){ return a + Math.random()*(b-a); }
function choice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

module.exports = { clamp, randBetween, choice };
