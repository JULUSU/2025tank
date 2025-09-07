window.Net = (function(){
  const socket = io();

  function on(evt, cb){ socket.on(evt, cb); }
  function emit(evt, data, ack){ socket.emit(evt, data, ack); }

  return { socket, on, emit };
})();
