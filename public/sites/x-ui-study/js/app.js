const seedPosts=[
 {name:"Design Journal",handle:"@design_journal",time:"2時間",avatar:"D",color:"purple",text:"優れたUIは、見た目の美しさだけでなく、情報の優先順位と操作の流れまで設計されている。\n\n画面を観察するときは「何があるか」だけでなく「なぜこの位置なのか」を考えるのが面白い。",media:"UI DESIGN / INFORMATION ARCHITECTURE",replies:18,reposts:42,likes:386,views:"1.2万"},
 {name:"Creative Coding",handle:"@creative_code",time:"4時間",avatar:"C",color:"green",text:"Three.jsで複数ディスプレイを扱うとき、カメラの投影とワールド座標の関係を整理しておくと実装がかなり分かりやすくなる。",replies:7,reposts:15,likes:129,views:"3,204"},
 {name:"映像とデザイン",handle:"@visual_notes",time:"6時間",avatar:"V",color:"orange",text:"今日の制作メモ。情報を詰め込むより、余白を使って視線の流れをつくる。シンプルに見える画面ほど、細かい判断の積み重ねでできている。",replies:12,reposts:31,likes:214,views:"8,912"},
 {name:"Tech News",handle:"@tech_news_jp",time:"8時間",avatar:"T",color:"blue",text:"WebのUI設計を学ぶなら、実際のサービスを観察して、共通パターンとサービス固有の工夫を切り分けてみるのがおすすめです。",replies:23,reposts:58,likes:502,views:"2.1万"}
];
let posts=[...seedPosts];
const feed=document.querySelector("#feed");
const esc=s=>String(s).replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
function postHTML(p,i){return `<article class="post" data-id="${i}"><div class="avatar ${p.color||"me"}">${esc(p.avatar||"R")}</div><div class="post-content"><div class="post-head"><strong>${esc(p.name)}</strong><span>${esc(p.handle)}</span><span>·</span><time>${esc(p.time)}</time><span class="post-more">•••</span></div><p class="post-text">${esc(p.text)}</p>${p.media?`<div class="post-media">${esc(p.media)}</div>`:""}<div class="post-actions"><button class="action reply">▢ <span>${p.replies}</span></button><button class="action repost">⇄ <span>${p.reposts}</span></button><button class="action like">♡ <span>${p.likes}</span></button><button class="action views">▥ <span>${p.views}</span></button><button class="action share">↗</button></div></div></article>`}
function render(list=posts){if(feed)feed.innerHTML=list.map((p,i)=>postHTML(p,i)).join("")}
render();
const textArea=document.querySelector("#postText"), postBtn=document.querySelector("#postBtn");
textArea?.addEventListener("input",()=>{postBtn.disabled=!textArea.value.trim()});
function createPost(){const value=textArea.value.trim();if(!value)return;posts.unshift({name:"Rin Watanabe",handle:"@rin_design",time:"今",avatar:"R",color:"me",text:value,replies:0,reposts:0,likes:0,views:"1"});render();textArea.value="";postBtn.disabled=true;notify("ポストを投稿しました");}
postBtn?.addEventListener("click",createPost);
document.querySelector("#navPost")?.addEventListener("click",()=>{textArea?.focus();window.scrollTo({top:0,behavior:"smooth"})});
function notify(msg){const t=document.querySelector("#toast");t.textContent=msg;t.classList.add("show");clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>t.classList.remove("show"),1800)}
feed?.addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;const n=b.querySelector("span");if(b.classList.contains("like")){b.classList.toggle("liked");b.firstChild.textContent=b.classList.contains("liked")?"♥ ":"♡ ";if(n)n.textContent=Number(n.textContent)+(b.classList.contains("liked")?1:-1)}else if(b.classList.contains("repost")){b.classList.toggle("reposted");if(n)n.textContent=Number(n.textContent)+(b.classList.contains("reposted")?1:-1);notify("リポストしました")}else if(b.classList.contains("reply"))notify("返信機能のデモです");else if(b.classList.contains("share"))notify("共有リンクをコピーする操作のデモです")});
document.querySelectorAll(".tab").forEach(tab=>tab.addEventListener("click",()=>{document.querySelector(".tab.active")?.classList.remove("active");tab.classList.add("active");render(tab.dataset.tab==="following"?posts.filter(p=>p.handle!=="@tech_news_jp"):posts)}));
document.querySelectorAll(".follow-btn").forEach(b=>b.addEventListener("click",()=>{const on=b.classList.toggle("following");b.textContent=on?"フォロー中":"フォロー"}));
document.querySelector("#searchInput")?.addEventListener("keydown",e=>{if(e.key==="Enter"){const q=e.target.value.toLowerCase();render(posts.filter(p=>(p.text+" "+p.name+" "+p.handle).toLowerCase().includes(q)));notify(q?"検索結果を表示しています":"検索語を入力してください")}});
