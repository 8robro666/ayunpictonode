const { WebSocket, WebSocketServer } = require("ws");
const fs = require("fs");
const path = require("path");
const mime = require("mime-types");
const express = require("express");
const session = require("express-session");
const bodyParser = require("body-parser");

const prefix = "www";

let files = [];
let cache = {};

function throughDirectory(directory) {
  fs.readdirSync(directory).forEach(file => {
    const absolute = path.join(directory, file);
    if (fs.statSync(absolute).isDirectory()) return throughDirectory(absolute);
    else return files.push(absolute.toString().slice(prefix.length+1).replace(/\\/g,"/"));
  });
}

throughDirectory(prefix);

const app = express();

// Parse form bodies for login
app.use(bodyParser.urlencoded({ extended: false }));
app.use(bodyParser.json());

// Session middleware - set SESSION_SECRET and ADMIN_PASSWORD in environment for production.
app.use(session({ secret: process.env.SESSION_SECRET || 'replace-this', resave: false, saveUninitialized: false }));

function requireAdmin(req, res, next) {
  if (req.session && req.session.isAdmin) return next();
  return res.status(401).json({ error: 'Not authenticated' });
}

// Login endpoint - compares to ADMIN_PASSWORD env var; fallback to 'KingSquincy' for convenience.
app.post('/admin/login', (req, res) => {
  const provided = req.body && req.body.password ? req.body.password : '';
  const adminSecret = process.env.ADMIN_PASSWORD || 'KingSquincy';
  if (provided === adminSecret) {
    req.session.isAdmin = true;
    return res.redirect('/admin.html');
  }
  res.status(401).send('Invalid password');
});

app.get('/admin/logout', (req, res) => {
  req.session.destroy(()=>res.redirect('/'));
});

// Protect admin page
app.get('/admin.html', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, prefix, 'admin.html'));
});

// Server info endpoint
app.get('/admin/info', requireAdmin, (req, res) => {
  res.json({
    users: users.length,
    maxUsers: 16,
    timestamp: new Date().toISOString()
  });
});

// Broadcast announcement endpoint
app.post('/admin/broadcast', requireAdmin, (req, res) => {
  const message = req.body && req.body.message ? req.body.message : '';
  if (!message || message.trim().length === 0) {
    return res.status(400).json({ error: 'Message cannot be empty' });
  }
  
  const announcement = {
    type: 'sv_announcement',
    message: message.slice(0, 200) // Limit to 200 chars
  };
  
  // Send to all connected clients
  sendToAll(announcement);
  
  res.json({ success: true, message: 'Announcement sent to ' + users.length + ' users' });
});

// Serve other static files from www
app.use(express.static(prefix));

const server = require("http").createServer(app);

const wss = new WebSocketServer({ server });

let users=[];

let abusers=[];

let consperip={};

function playerChecks(data){
  return ("player" in data)&&("name" in data.player)&&("color" in data.player);
}

function sendToAll(data) {
  wss.clients.forEach(ws => {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(data));
    }
  });
}

wss.on('connection', function(ws,req) {
  ws.playerData=null;
  let ip=req.headers['x-forwarded-for']||req.connection.remoteAddress;
  ip=ip.split(",",2)[0];
  if(!(ip in consperip))consperip[ip]=0;
  consperip[ip]++;
  if(consperip[ip]>5)return ws.close();
  let rate=0;
  let rateInterval=setInterval(()=>{
    if(rate>=10){
      abusers.push(ip);
      setTimeout(()=>{
        let ind=abusers.indexOf(ip);
        if(ind>-1){
          abusers.splice(ip,1);
        }
      },10000);
      ws.close();
    }else{
      rate=0;
    }
  },5000);
  ws.on('message', function message(data) {
    data=data.toString();
    if(data=="pong")return setTimeout(()=>ws!=null&&ws.readyState===WebSocket.OPEN&&ws.send("ping"),10000);
    rate++;
    try{
      data=JSON.parse(data);
      if(!("type" in data))return ws.close();
      switch(data.type){
        case "cl_verifyName":
          if(!playerChecks(data))return ws.close();
          data.player.name=data.player.name.replace(/[^A-Za-z0-9_]/g,"").slice(0,10);
          while(data.player.name.length==0)data.player.name=(""+Math.random()).slice(2);
          data.player.color=+data.player.color;
          if(isNaN(data.player.color)||data.player.color>16777215)data.player.color=0;
          ws.playerData=data.player;
          ws.send(JSON.stringify({type:"sv_nameVerified",player:ws.playerData}));
          ws.send(JSON.stringify({type:"sv_roomIds",count:[users.length],ids:["room_a"]}));
          break;
        case "cl_joinRoom":
          if(ws.playerData==null)return ws.close();
          if(!(playerChecks(data)&&("id" in data)))return ws.close();
          if(users.length>=16||abusers.includes(ip))return;
          if(users.includes(ws.playerData))return ws.close();
          if(users.some(p=>p.name==ws.playerData.name))return ws.close();
          users.push(ws.playerData);
          ws.send(JSON.stringify({type:"sv_roomData",id:"room_a"}));
          sendToOthers(ws,{type:"sv_playerJoined",player:ws.playerData,id:"room_a"});
          break;
        case "cl_sendMessage":
          if(ws.playerData==null)return ws.close();
          if(!( ("message" in data) && playerChecks(data.message) && ("textboxes" in data.message) && Array.isArray(data.message.textboxes) && ("lines" in data.message) && !isNaN(data.message.lines) ))return ws.close();
          for(let i=0;i<data.message.textboxes.length;i++){
            if("text" in data.message.textboxes[i]){
              data.message.textboxes[i].text=data.message.textboxes[i].text.slice(0,30);
            }
          }
          data.message.textboxes=data.message.textboxes.slice(0,50);
          data.type="sv_receivedMessage";
          data.message.player=ws.playerData;
          sendToOthers(ws,data);
          break;
        case "cl_leaveRoom":
          if(ws.playerData==null)return ws.close();
          let ind=users.indexOf(ws.playerData);
          if(ind>-1){
            users.splice(ind,1);
            sendToOthers(ws,{type:"sv_playerLeft",player:ws.playerData,id:"room_a"});
          }
          break;
        default:
          ws.close();
      }
    }catch(e){
      ws.close();
    }
  });
  ws.on('close', function(){
    clearInterval(rateInterval);
    consperip[ip]=Math.max(0,consperip[ip]-1);
    if(ws.playerData!=null){
      let ind=users.indexOf(ws.playerData);
      if(ind>-1){
        users.splice(ind,1);
        sendToOthers(ws,{type:"sv_playerLeft",player:ws.playerData,id:"room_a"});
      }
    }
  });
});

function sendToOthers(ws,data,cond){
  if(!cond)cond=()=>true;
  wss.clients.forEach(w=>w.readyState===WebSocket.OPEN&&w.playerData!=null&&users.includes(w.playerData)&&w.playerData!=ws.playerData&&cond(w)&&w.send(JSON.stringify(data)));
}

server.listen(process.env.PORT||8080);
