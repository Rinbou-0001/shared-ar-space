const img=(id,w=480)=>`https://images.unsplash.com/${id}?auto=format&fit=crop&w=${w}&q=82`;
const articles=[
 ["COP31閉幕　各国の合意内容をめぐり協議続く","国際会議の動向を伝える学習用サンプル記事です。","photo-1529107386315-e1a2ed48a620"],
 ["キーウへの攻撃を受け、現地で救助活動","海外の出来事を扱うニュース記事ページのサンプルです。","photo-1519608487953-e999c86e7455"],
 ["企業のセキュリティ対策、見直しの動き","企業・IT分野のニュース一覧から遷移する記事例です。","photo-1550751827-4bd374c3f58b"],
 ["地域の防災情報　日頃から備えを確認","地域ニュースや防災情報の導線を確認するための記事です。","photo-1500530855697-b586d89ba3ee"],
 ["新しい商品やサービスに注目集まる","暮らし・消費に関する記事のサンプルです。","photo-1497366754035-f200968a6e72"],
 ["スポーツの試合結果と今後の見どころ","スポーツニュースのサンプル記事です。","photo-1461896836934-ffe607ba8211"],
 ["週末のお出かけ　各地でイベント開催","地域・レジャー情報のサンプル記事です。","photo-1470252649378-9c29740c9fa8"],
 ["テクノロジーの最新動向を紹介","IT・科学ニュースのサンプル記事です。","photo-1518770660439-4636190af475"]
];
const services=[
 ["ショッピング","商品検索・カテゴリ・商品詳細","shopping"],["オークション","出品一覧・商品詳細・入札導線","auction"],["フリマ","商品を探す・出品情報","flea"],["トラベル","宿泊施設・旅行検索","travel"],["ニュース","トピックス・記事詳細","news"],["天気・災害","地域天気・週間予報・防災情報","weather"],["スポーツナビ","競技ニュース・試合情報","sports"],["ファイナンス","マーケット・銘柄詳細","finance"],["知恵袋","質問一覧・質問詳細","chiebukuro"],["マップ","地図検索・場所情報","map"],["路線情報","乗換検索・検索結果","route"],["メール","受信箱・メール一覧","mail"],["サービス一覧","Yahoo! JAPANのサービス","services"],["ログイン","IDログイン画面のデモ","login"]
];
const products=[
 ["ワイヤレスイヤホン","4,980","photo-1505740420928-5e560c06d30e"],
 ["ランニングシューズ","6,980","photo-1542291026-7eec264c27ff"],
 ["腕時計","3,980","photo-1523275335684-37898b6baf30"],
 ["カメラ","12,800","photo-1526170375885-4d8ecf77b99f"],
 ["バッグ","4,200","photo-1490481651871-ab68de25d43d"],
 ["ヘッドホン","5,500","photo-1546435770-a3e426bf472b"],
 ["スマートフォン","39,800","photo-1512499617640-c74ae3a79d37"],
 ["ファッションアイテム","2,980","photo-1529139574466-a303027c1d8b"]
];
const $=s=>document.querySelector(s);
const esc=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function renderHomeNews(){ $('#home-headlines').innerHTML=articles.slice(0,8).map((a,i)=>`<article class="headline"><img src="${img(a[2],220)}" alt=""><div class="headline-copy"><a href="#" data-article="${i}">${a[0]}</a><p>サンプル通信　${i+1}時間前</p></div></article>`).join('');$('#recommend-grid').innerHTML=articles.slice(2,5).map((a,i)=>`<article class="recommend-card"><img src="${img(a[2],360)}" alt=""><a href="#" data-article="${i+2}">${a[0]}</a></article>`).join('');}
function go(view){if(view==='home'){$('#home-view').hidden=false;$('#sub-view').hidden=true;}else{$('#home-view').hidden=true;$('#sub-view').hidden=false;renderView(view);}window.scrollTo(0,0);history.replaceState(null,'','#'+view);}
function shell(title,body,aside=''){ $('#crumb').textContent=title;$('#sub-content').innerHTML=`<h1 class="sub-title">${title}</h1><div class="sub-layout"><div>${body}</div><aside>${aside||'<div class="content-card"><b>Yahoo! JAPAN</b><p><a href="#" data-view="home">トップページへ戻る ›</a></p></div>'}</aside></div>`;}
function newsList(){return articles.map((a,i)=>`<article class="sub-news-item"><img src="${img(a[2],260)}" alt=""><div><a href="#" data-article="${i}">${a[0]}</a><p>${a[1]}</p><small class="demo-note">サンプル通信 ・ ${i+1}時間前</small></div></article>`).join('');}
function productGrid(){return `<div class="product-grid">${products.map((p,i)=>`<article class="product-card" data-product="${i}"><img src="${img(p[2],300)}"><b>${p[0]}</b><span class="price">￥${p[1]}</span><p class="demo-note">サンプルストア</p></article>`).join('')}</div>`;}
function renderView(view){
 const titles={news:'ニュース',article:'ニュース記事',search:'検索結果',services:'サービス一覧',weather:'天気・災害',disaster:'防災情報',shopping:'ショッピング',product:'商品詳細',auction:'オークション',auctionDetail:'オークション商品詳細',chiebukuro:'知恵袋',question:'質問詳細',mail:'メール',sports:'スポーツナビ',finance:'ファイナンス',map:'マップ',route:'路線情報',travel:'トラベル',login:'ログイン',topics:'お知らせ',flea:'フリマ',help:'ヘルプ',account:'アカウント情報'};
 if(view==='news'){shell(titles.news,`<div class="content-card"><nav class="sub-tabs"><button class="active">主要</button><button>経済</button><button>エンタメ</button><button>スポーツ</button><button>国内</button><button>国際</button><button>IT</button><button>科学</button><button>地域</button></nav><p class="demo-note">11月23日 14:00更新・学習用サンプル</p>${newsList()}</div>`);return;}
 if(view==='article'){const a=articles[window.articleIndex||0];shell(titles.article,`<article class="content-card"><p class="demo-note">ニュース / サンプル記事</p><h2>${a[0]}</h2><p class="demo-note">2026年11月23日 14:00配信　サンプル通信</p><img style="width:100%;max-height:330px;object-fit:cover" src="${img(a[2],900)}"><p style="font-size:15px;line-height:1.9">${a[1]}</p><p style="font-size:15px;line-height:1.9">この記事はページ階層と記事詳細画面の構成を理解するためのサンプルです。実際のニュース配信、報道内容、速報情報ではありません。本番サイトでは記事IDを使ってAPIから本文・画像・配信元・公開日時などを取得します。</p><a href="#" data-view="news">← ニュース一覧へ</a></article>`);return;}
 if(view==='search'){const q=window.searchQuery||'Yahoo! JAPAN';shell('検索結果',`<div class="content-card"><p>「${esc(q)}」の検索結果（デモ）</p>${Array.from({length:7},(_,i)=>`<div class="result-item"><h3><a href="#" data-view="news">${esc(q)}に関する情報 ${i+1}</a></h3><small>https://example.jp/sample</small><p>検索キーワードに関連するページ概要を表示するサンプルです。検索エンジンには接続していません。</p></div>`).join('')}</div>`);return;}
 if(view==='services'){shell(titles.services,`<div class="content-card"><div class="service-directory">${services.map(s=>`<a class="directory-item" href="#" data-view="${s[2]}"><b>${s[0]}</b><span>${s[1]}</span></a>`).join('')}</div></div>`);return;}
 if(view==='weather'){shell(titles.weather,`<div class="content-card"><div class="weather-hero"><div><b>宮城県 石巻市</b><h2>今日の天気</h2><div class="big-temp">☀ 18℃</div><p>晴れ　降水確率 10%</p></div><div style="font-size:58px">🌤️</div></div><h2 style="margin-top:20px">週間天気</h2><div class="forecast">${['月','火','水','木','金','土','日'].map((d,i)=>`<div>${d}<b>${['☀','🌤','☁','🌧','☀','☀','🌤'][i]}</b>${17+i%3}℃<br><small>9℃</small></div>`).join('')}</div><p class="demo-note">天気・気温・降水確率はすべて架空のサンプル値です。</p><p><a href="#" data-view="disaster">災害・防災情報 ›</a></p></div>`);return;}
 if(view==='disaster'){shell(titles.disaster,`<div class="content-card"><h2>災害・防災情報</h2><p>地震・津波・台風・避難情報などを表示する下層ページの例です。</p><p class="demo-note">このページはデモであり、実際の警報・避難情報ではありません。</p><a href="#" data-view="weather">天気ページへ戻る</a></div>`);return;}
 if(view==='shopping'){shell(titles.shopping,`<div class="content-card"><form class="inner-search"><input placeholder="商品名・キーワードで検索"><button>検索</button></form><p class="demo-note">カテゴリ：すべて　家電　ファッション　食品　日用品</p><h2>おすすめ商品</h2>${productGrid()}</div>`);return;}
 if(view==='product'){const p=products[window.productIndex||0];shell(titles.product,`<div class="content-card"><div class="detail-layout"><img src="${img(p[2],800)}"><div><p class="demo-note">サンプルストア</p><h2>${p[0]}</h2><div class="price" style="font-size:25px">￥${p[1]}</div><p>商品説明・仕様・配送情報を表示する商品詳細ページのサンプルです。</p><button class="action-button" data-toast="カートに追加しました（デモ）">カートに入れる</button></div></div></div>`);return;}
 if(view==='auction'){shell(titles.auction,`<div class="content-card"><h2>注目のオークション</h2>${productGrid()}</div>`);return;}
 if(view==='chiebukuro'){shell(titles.chiebukuro,`<div class="content-card"><h2>カテゴリから探す</h2><div class="service-directory">${['暮らし','インターネット','健康','趣味','学問','エンタメ'].map(x=>`<a class="directory-item" href="#" data-view="question"><b>${x}</b><span>質問・回答一覧</span></a>`).join('')}</div><h2 style="margin-top:22px">注目の質問</h2><div class="result-item"><h3><a href="#" data-view="question">Webサイトの仕組みを学ぶには何から始める？</a></h3><p>HTML・CSS・JavaScriptの役割を教えてください。</p></div><div class="result-item"><h3><a href="#" data-view="question">ポータルサイトの構成について</a></h3><p>複数サービスをまとめる設計の考え方は？</p></div></div>`);return;}
 if(view==='question'){shell(titles.chiebukuro,`<div class="content-card"><h2>Q. Webサイトの仕組みを学ぶには何から始める？</h2><p>HTML・CSS・JavaScriptの役割を教えてください。</p><hr><h3>ベストアンサー（サンプル）</h3><p>HTMLは構造、CSSは見た目、JavaScriptは動作を担当します。APIとデータベースを学ぶことで、Webアプリケーション全体の理解につながります。</p><a href="#" data-view="chiebukuro">知恵袋トップへ</a></div>`);return;}
 if(view==='mail'){shell(titles.mail,`<div class="content-card"><h2>受信箱</h2>${[['Yahoo! JAPAN','サービスからのお知らせ','今日 09:00'],['サンプルストア','ご注文内容の確認','昨日'],['ニュースレター','今週のトピックス','11/21']].map(x=>`<div class="result-item"><b>${x[0]}</b>　${x[1]}<small style="float:right">${x[2]}</small></div>`).join('')}<p class="demo-note">メールの閲覧・送信はデモ表示です。実際のアカウントには接続しません。</p></div>`);return;}
 if(view==='sports'){shell(titles.sports,`<div class="content-card"><h2>スポーツニュース</h2>${newsList()}<a href="#" data-view="sportsDetail">試合情報を見る ›</a></div>`);return;}
 if(view==='finance'){shell(titles.finance,`<div class="content-card"><h2>マーケット情報（サンプル値）</h2><div class="service-directory"><div class="directory-item"><b>日経平均</b><span>38,250　+0.42%</span></div><div class="directory-item"><b>ドル/円</b><span>154.20　+0.15%</span></div><div class="directory-item"><b>NYダウ</b><span>42,100　-0.12%</span></div></div><p><a href="#" data-view="stock">銘柄詳細を見る ›</a></p></div>`);return;}
 if(view==='map'){shell(titles.map,`<div class="content-card"><input placeholder="住所・施設名を検索" style="padding:11px;width:75%"><button class="action-button" data-toast="地図検索（デモ）">検索</button><div style="height:340px;background:#e7efe5;display:grid;place-items:center;margin-top:15px;color:#617b67;font-size:18px">地図表示エリア（地図API未接続）</div></div>`);return;}
 if(view==='route'){shell(titles.route,`<div class="content-card"><h2>乗換案内</h2><label>出発駅</label><input placeholder="例：仙台" style="display:block;padding:10px;width:100%;margin:6px 0 14px"><label>到着駅</label><input placeholder="例：石巻" style="display:block;padding:10px;width:100%;margin:6px 0 14px"><button class="action-button" data-view="routeResult">検索する</button></div>`);return;}
 if(view==='travel'){shell(titles.travel,`<div class="content-card"><h2>宿泊施設を検索</h2><input placeholder="目的地" style="padding:10px"><input type="date" style="padding:10px"><button class="action-button" data-toast="宿泊施設検索（デモ）">検索</button>${productGrid()}</div>`);return;}
 if(view==='login'){shell(titles.login,`<div class="content-card login-form"><h2>ログイン</h2><label>Yahoo! JAPAN ID</label><input placeholder="ID・携帯電話番号・メールアドレス"><label>パスワード</label><input type="password" placeholder="パスワード"><button class="action-button" data-toast="認証機能は未実装です">ログイン</button><p class="demo-note">実際のIDやパスワードを入力しないでください。学習用の画面です。</p></div>`);return;}
 if(view==='flea'){shell(titles.flea,`<div class="content-card"><h2>フリマ</h2><p>商品一覧・商品詳細・出品導線を持つマーケットプレイスの画面例です。</p><a href="#" data-view="shopping">商品一覧を見る ›</a></div>`);return;}
 if(view==='topics'||view==='help'||view==='account'){shell(titles[view],`<div class="content-card"><h2>${titles[view]}</h2><p>このページは情報・設定コンテンツの下層ページを表す学習用サンプルです。</p><a href="#" data-view="home">トップページへ戻る ›</a></div>`);return;}
 shell(titles[view]||'サービス',`<div class="content-card"><p>学習用の下層ページです。</p><a href="#" data-view="home">トップページへ戻る</a></div>`);
}
document.addEventListener('click',e=>{
 const v=e.target.closest('[data-view]');if(v){e.preventDefault();go(v.dataset.view);return;}
 const art=e.target.closest('[data-article]');if(art){e.preventDefault();window.articleIndex=Number(art.dataset.article);go('article');return;}
 const prod=e.target.closest('[data-product]');if(prod){e.preventDefault();window.productIndex=Number(prod.dataset.product);go('product');return;}
 const q=e.target.closest('[data-query]');if(q){e.preventDefault();window.searchQuery=q.dataset.query;go('search');return;}
 const toast=e.target.closest('[data-toast]');if(toast){e.preventDefault();showToast(toast.dataset.toast);}
});
document.addEventListener('submit',e=>{if(e.target.id==='global-search'){e.preventDefault();window.searchQuery=$('#query').value.trim()||'検索';go('search');}if(e.target.classList.contains('inner-search')){e.preventDefault();window.searchQuery=e.target.querySelector('input').value||'商品';go('search');}});
function showToast(t){const el=$('#toast');el.textContent=t;el.style.display='block';clearTimeout(window.toastTimer);window.toastTimer=setTimeout(()=>el.style.display='none',1800);}
renderHomeNews();
const initial=location.hash.slice(1);if(initial&&initial!=='home')go(initial);
