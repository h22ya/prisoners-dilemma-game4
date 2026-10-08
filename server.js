const express=require("express"),http=require("http"),{Server}=require("socket.io"),QRCode=require("qrcode");
const app=express(),server=http.createServer(app),io=new Server(server);app.use(express.static("public"));
const PORT=process.env.PORT||3000,rooms=new Map(),socketTokens=new Map();
const shuffle=a=>{a=[...a];for(let i=a.length-1;i>0;i--){let j=Math.floor(Math.random()*(i+1));[a[i],a[j]]=[a[j],a[i]]}return a};
function newPairs(ids){ids=shuffle(ids);let pairs=[];for(let i=0;i+1<ids.length;i+=2)pairs.push([ids[i],ids[i+1]]);return{pairs,bye:ids.length%2?ids[ids.length-1]:null}}
function emit(r){if(r.teacher)io.to(r.teacher).emit("teacherState",tState(r));for(const [token,p] of r.players)if(p.connected&&p.socketId)io.to(p.socketId).emit("studentState",sState(r,token))}
function tState(r){return{code:r.code,phase:r.phase,round:r.round,bye:r.bye,players:[...r.players.values()].map(p=>({...p,id:p.token,choice:r.choices[p.token]||null})),results:r.results}}
function sState(r,token){
 const me=r.players.get(token),pr=r.pairs.find(x=>x.includes(token)),oid=pr?.find(x=>x!==token),opp=oid&&r.players.get(oid);
 const history=r.results.map((rr,i)=>{const x=rr.find(z=>z.a===token||z.b===token);if(!x)return null;const mine=x.a===token?{choice:x.aChoice,opponent:x.bNickname,opponentChoice:x.bChoice,points:x.aPoints}:{choice:x.bChoice,opponent:x.aNickname,opponentChoice:x.aChoice,points:x.bPoints};return{round:i+1,...mine}}).filter(Boolean);
 const last=r.results[r.results.length-1]||[];
 return{code:r.code,phase:r.phase,round:r.round,me:me&&{id:token,nickname:me.nickname,total:me.total},opponent:opp&&{id:oid,nickname:opp.nickname},myChoice:r.choices[token]||null,result:last.find(x=>x.a===token||x.b===token)||null,bye:r.bye===token,history};
}
function resolve(r){
 let rr=[];
 for(const [a,b] of r.pairs){let ca=r.choices[a],cb=r.choices[b],pa,pb;
  if(ca==="C"&&cb==="C")[pa,pb]=[3,3];else if(ca==="C"&&cb==="D")[pa,pb]=[0,5];else if(ca==="D"&&cb==="C")[pa,pb]=[5,0];else[pa,pb]=[1,1];
  r.players.get(a).total+=pa;r.players.get(b).total+=pb;
  rr.push({a,b,aNickname:r.players.get(a).nickname,bNickname:r.players.get(b).nickname,aChoice:ca,bChoice:cb,aPoints:pa,bPoints:pb});
 }
 r.results.push(rr);r.phase=r.round===3?"finished":"roundResult";emit(r)
}
function findPlayerBySocket(sid){for(const r of rooms.values())for(const [token,p] of r.players)if(p.socketId===sid)return{r,token,p};return null}
io.on("connection",s=>{
 s.on("createRoom",async({origin}={},cb)=>{
  let c;do c=Math.random().toString(36).slice(2,7).toUpperCase();while(rooms.has(c));
  let r={code:c,teacher:s.id,players:new Map(),round:0,phase:"lobby",pairs:[],bye:null,choices:{},results:[]};rooms.set(c,r);s.join(c);
  const base=String(origin||"").replace(/\/$/,"")||`${s.handshake.headers["x-forwarded-proto"]||"http"}://${s.handshake.headers.host}`;
  const url=`${base}/?room=${c}`,qr=await QRCode.toDataURL(url,{margin:2,width:360});cb({ok:true,code:c,qr,url});emit(r)
 });
 s.on("joinRoom",({code,nickname,token}={},cb)=>{
  let c=String(code||"").trim().toUpperCase(),n=String(nickname||"").trim().slice(0,24),t=String(token||"").trim(),r=rooms.get(c);
  if(!r)return cb({ok:false,error:"방을 찾을 수 없습니다. 방 코드가 맞는지 확인해주세요."});
  if(!n)return cb({ok:false,error:"닉네임을 입력해주세요."});
  if(t&&r.players.has(t)){
   const p=r.players.get(t);
   if(p.nickname.toLowerCase()===n.toLowerCase()||r.phase!=="lobby"){p.socketId=s.id;p.connected=true;s.join(c);socketTokens.set(s.id,t);cb({ok:true,reconnected:true,nickname:p.nickname});emit(r);return}
  }
  if(r.phase!=="lobby")return cb({ok:false,error:"이미 게임이 시작된 방입니다. 기존 참가자는 같은 기기의 참가 화면으로 돌아와 주세요."});
  if([...r.players.values()].some(p=>p.nickname.toLowerCase()===n.toLowerCase()))return cb({ok:false,error:"이미 사용 중인 닉네임입니다."});
  t=t||require("crypto").randomBytes(12).toString("hex");
  r.players.set(t,{token:t,id:t,socketId:s.id,nickname:n,total:0,connected:true});s.join(c);socketTokens.set(s.id,t);cb({ok:true,reconnected:false,token:t,nickname:n});emit(r)
 });
 s.on("startGame",({code},cb)=>{let r=rooms.get(String(code).toUpperCase());if(!r||r.teacher!==s.id)return cb({ok:false,error:"교사 권한이 없습니다."});if(r.players.size<2)return cb({ok:false,error:"학생이 2명 이상 필요합니다."});r.round=1;r.phase="playing";r.choices={};({pairs:r.pairs,bye:r.bye}=newPairs([...r.players.keys()]));emit(r);cb({ok:true})});
 s.on("choose",({code,choice},cb)=>{let r=rooms.get(String(code).toUpperCase()),t=socketTokens.get(s.id);if(!r||r.phase!=="playing")return cb({ok:false,error:"현재 선택할 수 없습니다."});if(!t||!r.players.has(t)||r.bye===t)return cb({ok:false,error:"참가 정보가 없습니다."});if(choice!=="C"&&choice!=="D")return cb({ok:false,error:"잘못된 선택입니다."});r.choices[t]=choice;emit(r);if(r.pairs.every(([a,b])=>r.choices[a]&&r.choices[b]))resolve(r);cb({ok:true})});
 s.on("nextRound",({code},cb)=>{let r=rooms.get(String(code).toUpperCase());if(!r||r.teacher!==s.id||r.round>=3)return cb({ok:false,error:"다음 라운드를 시작할 수 없습니다."});r.round++;r.phase="playing";r.choices={};({pairs:r.pairs,bye:r.bye}=newPairs([...r.players.keys()]));emit(r);cb({ok:true})});
 s.on("kickPlayer",({code,token},cb)=>{let r=rooms.get(String(code).toUpperCase());if(!r||r.teacher!==s.id)return cb({ok:false,error:"권한이 없습니다."});const p=r.players.get(String(token||""));if(!p)return cb({ok:false,error:"학생을 찾을 수 없습니다."});
  if(p.socketId){io.to(p.socketId).emit("kicked",{message:"교사가 이 게임방에서 내보냈습니다. 다시 참가하려면 게임방에 새로 입장해주세요."});io.sockets.sockets.get(p.socketId)?.leave(r.code);socketTokens.delete(p.socketId)}
  r.players.delete(p.token);r.pairs=r.pairs.map(pair=>pair.filter(x=>x!==p.token)).filter(pair=>pair.length===2);if(r.bye===p.token)r.bye=null;delete r.choices[p.token];emit(r);cb({ok:true})
 });
 s.on("reset",({code},cb)=>{let r=rooms.get(String(code).toUpperCase());if(!r||r.teacher!==s.id)return cb({ok:false,error:"권한이 없습니다."});for(let p of r.players.values())p.total=0;r.round=0;r.phase="lobby";r.pairs=[];r.bye=null;r.choices={};r.results=[];emit(r);cb({ok:true})});
 s.on("disconnect",()=>{const x=findPlayerBySocket(s.id);if(x){x.p.connected=false;x.p.socketId=null;socketTokens.delete(s.id);emit(x.r)}});
});
server.listen(PORT,()=>console.log("Listening on "+PORT));
