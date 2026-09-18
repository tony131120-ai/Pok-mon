import express from 'express';
import http from 'http';
import path from 'path';
import {fileURLToPath} from 'url';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import pg from 'pg';
import {Server as SocketServer} from 'socket.io';

const {Pool}=pg;
const __dirname=path.dirname(fileURLToPath(import.meta.url));
const app=express();
const server=http.createServer(app);
const io=new SocketServer(server,{cors:{origin:true,credentials:true}});
const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production"
    ? { rejectUnauthorized: false }
    : false
});
const JWT_SECRET=process.env.JWT_SECRET||'change-this-secret-on-render';
const TCG='https://api.tcgdex.net/v2/en';

app.use(express.json({limit:'1mb'}));
app.use(express.static(__dirname));

const packNames=[['Rayquaza VMAX Sky',30000,'sv6','Rayquaza VMAX'],['Charizard Gold',1500000,'swsh3','Charizard VMAX'],['Moonbreon Vault',750000,'swsh7','Umbreon VMAX'],['Pikachu Crown',500000,'swsh8','Pikachu VMAX'],['Lugia Silver',420000,'swsh12','Lugia VSTAR'],['Giratina Lost',390000,'swsh11','Giratina VSTAR'],['Mew Fusion',350000,'swsh8','Mew VMAX'],['Gengar Fusion',330000,'swsh8','Gengar VMAX'],['Rayquaza Evolving',280000,'swsh7','Rayquaza VMAX'],['Sylveon Evolving',240000,'swsh7','Sylveon VMAX'],['Eevee Heroes',200000,'swsh6','Umbreon VMAX'],['Charizard Darkness',180000,'swsh3','Charizard VMAX'],['Shining Fates',160000,'swsh45','Charizard VMAX'],['Celebrations',140000,'cel25','Charizard'],['Base Set Vault',120000,'base1','Charizard'],['Scarlet Elite',100000,'sv1','Miraidon ex'],['Paldea Evolved',85000,'sv2','Iono'],['Obsidian Flames',75000,'sv3','Charizard ex'],['Paradox Rift',65000,'sv4','Gholdengo ex'],['Temporal Forces',60000,'sv5','Raging Bolt ex'],['Twilight Masquerade',55000,'sv6','Greninja ex'],['Stellar Crown',50000,'sv7','Terapagos ex'],['Surging Sparks',45000,'sv8','Pikachu ex'],['Prismatic Echo',40000,'sv8pt5','Umbreon ex'],['Destined Rivals',35000,'sv10',"Team Rocket's Mewtwo ex"],['Mega Evolution',30000,'sv8pt5','Mega Lucario ex'],['Classic Hits',25000,'swsh12','Charizard'],['Modern Hits',20000,'sv4','Groudon ex'],['Budget Shine',12000,'sv2','Magikarp'],['Starter Pack',5000,'sv1','Pikachu']];
const packs=packNames.map((x,i)=>({id:i+1,name:x[0],price:x[1],set:x[2],chase:x[3],n:7+(i%2)})).sort((a,b)=>a.price-b.price);
let cardCache=null;
async function getCards(){
  if(cardCache)return cardCache;
  const r=await fetch(`${TCG}/cards`);
  if(!r.ok)throw new Error('TCGdex cards failed');
  const data=await r.json();
  cardCache=(Array.isArray(data)?data:[]).filter(c=>c?.id).slice(0,15000);
  return cardCache;
}
function imageUrl(c,quality='high',ext='webp'){
  const b=(c.image||'').replace(/\/$/,'');
  return b?`${b}/${quality}.${ext}`:'';
}
function tokenFor(u){return jwt.sign({id:u.id,username:u.username},JWT_SECRET,{expiresIn:'7d'});}
async function auth(req,res,next){
  try{const h=req.headers.authorization||'';const t=h.startsWith('Bearer ')?h.slice(7):'';const p=jwt.verify(t,JWT_SECRET);const q=await pool.query('SELECT id,username,cash FROM users WHERE id=$1',[p.id]);if(!q.rowCount)return res.status(401).json({error:'인증 필요'});req.user=q.rows[0];next();}catch(e){res.status(401).json({error:'인증 필요'});}
}
app.get('/api/health',(req,res)=>res.json({ok:true}));
app.get('/api/packs',(req,res)=>res.json(packs));
app.get('/api/cards',async(req,res)=>{try{const cards=await getCards();res.json(cards.map(c=>({...c,image:imageUrl(c)})));}catch(e){res.status(502).json({error:'카드 데이터를 불러오지 못했습니다.'});}});
app.post('/api/signup',async(req,res)=>{const {username,password}=req.body||{};if(!/^[\w가-힣]{3,32}$/.test(username||'')||(password||'').length<4)return res.status(400).json({error:'닉네임 3~32자, 비밀번호 4자 이상'});try{const hash=await bcrypt.hash(password,10);const q=await pool.query('INSERT INTO users(username,password_hash) VALUES($1,$2) RETURNING id,username,cash',[username,hash]);res.json({token:tokenFor(q.rows[0]),user:q.rows[0]});}catch(e){res.status(409).json({error:'이미 사용 중인 닉네임입니다.'});}});
app.post('/api/login',async(req,res)=>{const {username,password}=req.body||{};const q=await pool.query('SELECT id,username,cash,password_hash FROM users WHERE username=$1',[username]);if(!q.rowCount||!(await bcrypt.compare(password||'',q.rows[0].password_hash)))return res.status(401).json({error:'닉네임 또는 비밀번호가 올바르지 않습니다.'});const {password_hash,...u}=q.rows[0];res.json({token:tokenFor(u),user:u});});
app.get('/api/me',auth,async(req,res)=>{const inv=await pool.query('SELECT id,card_id,card_name,image,rarity,price FROM inventory WHERE user_id=$1 ORDER BY id DESC',[req.user.id]);res.json({user:req.user,inventory:inv.rows});});
function commonPool(cards){return cards.filter(c=>{const r=(c.rarity||'').toLowerCase();const n=(c.name||'').toLowerCase();return !/(secret|ultra|illustration|special|hyper|radiant|amazing|shining|vmax|vstar|ex)/.test(r+' '+n)&&!/^(rare holo|double rare|ultra rare)/i.test(r);});}
function rarePool(cards){return cards.filter(c=>{const r=(c.rarity||'').toLowerCase();const n=(c.name||'').toLowerCase();return /(rare|holo|ex|vmax|vstar|illustration|secret|ultra|special|hyper|radiant|amazing|shining)/.test(r+' '+n);});}
function tier(p){return Math.min(1,0.01+Math.sqrt(p.price/1500000)*0.27);}
function priceFor(c,p,final){const r=(c.rarity||'').toLowerCase();let mult=final?0.7+Math.random()*1.2:0.02+Math.random()*0.08;if(/secret|special|hyper|illustration|ultra/.test(r))mult*=final?(2+Math.random()*5):1;if(/vmax|vstar|ex/.test((c.name||'').toLowerCase()+' '+r))mult*=final?1.4:1;return Math.max(50,Math.round(p.price*mult));}
app.post('/api/open',auth,async(req,res)=>{try{const p=packs.find(x=>x.id===Number(req.body.packId));if(!p)return res.status(404).json({error:'팩 없음'});if(Number(req.user.cash)<p.price)return res.status(400).json({error:'돈이 부족합니다.'});const all=await getCards();const normal=commonPool(all);const rare=rarePool(all);if(!normal.length||!rare.length)throw new Error('pool empty');const out=[];for(let i=0;i<p.n-1;i++){const c=normal[Math.floor(Math.random()*normal.length)];out.push({...c,image:imageUrl(c),gamePrice:priceFor(c,p,false),final:false});}
  const premium=Math.random()<tier(p);let candidates=rare;if(!premium){candidates=rare.filter(c=>{const r=(c.rarity||'').toLowerCase();return !/(secret|special|hyper|illustration|ultra|vmax|vstar|ex)/.test(r+' '+(c.name||''));})||rare;}const c=candidates[Math.floor(Math.random()*candidates.length)];out.push({...c,image:imageUrl(c),gamePrice:priceFor(c,p,true),final:true,premium});
  await pool.query('UPDATE users SET cash=cash-$1 WHERE id=$2',[p.price,req.user.id]);res.json({pack:p,cards:out});}catch(e){console.error(e);res.status(500).json({error:'팩 개봉 중 오류가 발생했습니다.'});}});
app.post('/api/claim',auth,async(req,res)=>{const c=req.body?.card;if(!c?.id)return res.status(400).json({error:'카드 없음'});await pool.query('INSERT INTO inventory(user_id,card_id,card_name,image,rarity,price) VALUES($1,$2,$3,$4,$5,$6)',[req.user.id,c.id,c.name,c.image,c.rarity||'',Math.max(0,Number(c.gamePrice)||0)]);const q=await pool.query('SELECT id,username,cash FROM users WHERE id=$1',[req.user.id]);res.json({user:q.rows[0]});broadcastRanking();});
app.post('/api/sell/:id',auth,async(req,res)=>{const id=Number(req.params.id);const q=await pool.query('DELETE FROM inventory WHERE id=$1 AND user_id=$2 RETURNING price',[id,req.user.id]);if(!q.rowCount)return res.status(404).json({error:'카드 없음'});const u=await pool.query('UPDATE users SET cash=cash+$1 WHERE id=$2 RETURNING id,username,cash',[q.rows[0].price,req.user.id]);res.json({user:u.rows[0]});broadcastRanking();});
async function ranking(){const q=await pool.query('SELECT username,cash FROM users ORDER BY cash DESC, id ASC LIMIT 50');return q.rows;}
async function broadcastRanking(){io.emit('ranking',await ranking());}
const online=new Map();
function onlineList(){return [...online.values()].map(x=>({id:x.socketId,username:x.username}));}
io.on('connection',socket=>{
  socket.on('auth',async token=>{try{const p=jwt.verify(token,JWT_SECRET);const q=await pool.query('SELECT id,username FROM users WHERE id=$1',[p.id]);if(!q.rowCount)return;online.set(q.rows[0].id,{socketId:socket.id,username:q.rows[0].username});socket.data.userId=q.rows[0].id;io.emit('online',onlineList());socket.emit('ranking',await ranking());}catch(e){}});
  socket.on('battle:request',({to})=>{const me=online.get(socket.data.userId);const target=[...online.entries()].find(([_,v])=>v.username===to);if(!me||!target)return;io.to(target[1].socketId).emit('battle:incoming',{from:me.username});});
  socket.on('battle:answer',({to,accepted})=>{const me=online.get(socket.data.userId);const target=[...online.entries()].find(([_,v])=>v.username===to);if(me&&target)io.to(target[1].socketId).emit('battle:answer',{from:me.username,accepted:!!accepted});});
  socket.on('disconnect',()=>{if(socket.data.userId){online.delete(socket.data.userId);io.emit('online',onlineList());}});
});
app.get('*',(req,res)=>res.sendFile(path.join(__dirname,'index.html')));
async function boot(){if(process.env.DATABASE_URL){await pool.query(`CREATE TABLE IF NOT EXISTS users(id SERIAL PRIMARY KEY,username VARCHAR(32) UNIQUE NOT NULL,password_hash TEXT NOT NULL,cash BIGINT NOT NULL DEFAULT 100000,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE TABLE IF NOT EXISTS inventory(id BIGSERIAL PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,card_id TEXT NOT NULL,card_name TEXT NOT NULL,image TEXT,rarity TEXT,price BIGINT NOT NULL DEFAULT 0,created_at TIMESTAMPTZ NOT NULL DEFAULT NOW());CREATE INDEX IF NOT EXISTS inventory_user_idx ON inventory(user_id);`);}server.listen(PORT,()=>console.log('PokéPack Vault online on '+PORT));}
boot().catch(e=>{console.error(e);process.exit(1)});
const PORT = process.env.PORT || 3000;

  console.log(`Server running on port ${PORT}`);;
