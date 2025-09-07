// public/net.js —— 允许回退、稳定重连、别用弹窗打断
window.Net = (function(){
  // 前后端同域部署：直接用相对地址即可
  const socket = io({
    path: "/socket.io",
    transports: ["websocket", "polling"],   // 允许回退，解决某些网络/浏览器握手失败
    reconnection: true,
    reconnectionAttempts: 20,
    reconnectionDelay: 500
  });

  socket.on("connect",    () => console.log("[socket] connected:", socket.id));
  socket.on("disconnect", r  => console.warn("[socket] disconnected:", r));
  socket.on("reconnect",  n  => console.log("[socket] reconnected attempt:", n));
  socket.on("connect_error", e => {
    // 不再弹窗，避免“加入时”被误以为失败；控制台看详情即可
    console.error("[socket] connect_error:", e?.message || e);
  });

  function on(evt, cb){ socket.on(evt, cb); }
  function emit(evt, data, ack){
    console.log("[emit]", evt, data);
    socket.emit(evt, data, (res)=>{ console.log("[ack]", evt, res); ack && ack(res); });
  }
  return { socket, on, emit };
})();
