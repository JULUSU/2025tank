window.UI = (function(){
  const qs = s => document.querySelector(s);
  const qsa = s => [...document.querySelectorAll(s)];

  const S = {
    menu: qs('#menu'),
    lobby: qs('#lobby'),
    game: qs('#game'),
    roomList: qs('#room-list'),
    btnCreate: qs('#btn-create'),
    rName: qs('#r-name'),
    rMaxPlayers: qs('#r-maxPlayers'),
    rMaxTotal: qs('#r-maxTotal'),
    rMaxSingle: qs('#r-maxSingle'),
    rMapSize: qs('#r-mapSize'),
    joinFaction: qs('#join-faction'),
    lobbyInfo: qs('#lobby-info'),
    unitsWrap: qs('#units'),
    pickTotal: qs('#pick-total'),
    pickMax: qs('#pick-max'),
    btnSubmitPicks: qs('#btn-submit-picks'),
    btnStart: qs('#btn-start'),
    btnLeave: qs('#btn-leave')
  };

  return { qs, qsa, S };
})();
