// public/net.js  —— 强化日志 & 显式 websocket
window.Net = (function(){
  const BASE_URL = window.location.origin; // 若前端和后端不同域：改成 "https://<你的后端>.onrender.com"
  const socket = io(BASE_URL, { transports: ["websocket"], path: "/socket.io" });

  socket.on("connect",      () => console.log("[socket] connected:", socket.id));
  socket.on("disconnect",   (r) => console.warn("[socket] disconnected:", r));
  socket.on("connect_error",(e) => { console.error("[socket] connect_error:", e?.message||e); alert("无法连接服务器，请确认访问的是 Render 服务地址。"); });

  function on(evt, cb){ socket.on(evt, cb); }
  function emit(evt, data, ack){
    console.log("[emit]", evt, data);
    socket.emit(evt, data, (res)=>{ console.log("[ack]", evt, res); ack && ack(res); });
  }
  return { socket, on, emit };
})();
