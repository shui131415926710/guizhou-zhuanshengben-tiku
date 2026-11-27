/* AI 答疑组件（本地静态页，自带设置面板；未配置 API Key 时只做题库内答疑）
   用法：AIQA.open(questionObj, { paperTitle })
*/
(function(){
  'use strict';
  var LSKEY = 'sb:ai';
  var PRESETS = {
    agnes:    { label:'Agnes AI（能看图）', base:'https://apihub.agnes-ai.com/v1', model:'agnes-2.5-flash', vision:true,
                tip:'platform.agnes-ai.com 创建 API Key，粘贴 sk- 开头的整串（不要加 Bearer）。' },
    deepseek: { label:'DeepSeek（文本）', base:'https://api.deepseek.com/v1', model:'deepseek-chat', vision:false,
                tip:'platform.deepseek.com 注册后创建 API Key，有免费额度。' },
    qwen:     { label:'通义千问 VL（能看图）', base:'https://dashscope.aliyuncs.com/compatible-mode/v1', model:'qwen-vl-max', vision:true,
                tip:'阿里云百炼控制台开通后创建 API Key，可让模型直接看题干公式图。' },
    openai:   { label:'OpenAI', base:'https://api.openai.com/v1', model:'gpt-4o-mini', vision:true,
                tip:'platform.openai.com 创建 Key，需自备额度。' },
    custom:   { label:'自建 / 中转', base:'', model:'', vision:true, tip:'填任何 OpenAI 兼容的 /v1 地址。' }
  };

  var state = { q:null, ctx:null, history:[], busy:false, panel:null, quote:null, quoteBar:null };

  function cfg(){
    try{ return JSON.parse(localStorage.getItem(LSKEY) || '{}'); }catch(e){ return {}; }
  }
  function saveCfg(o){
    try{ localStorage.setItem(LSKEY, JSON.stringify(o)); }catch(e){}
  }

  /* ---------- 数学公式渲染（KaTeX 本地化托管，失败则降级为纯文本） ---------- */
  var KATEX_VER  = '?v=20261126';
  var KATEX_BASE = 'assets/katex/';
  var KATEX_CSS  = KATEX_BASE + 'katex.min.css' + KATEX_VER;
  var KATEX_JS   = KATEX_BASE + 'katex.min.js' + KATEX_VER;
  var KATEX_AUTO = KATEX_BASE + 'contrib/auto-render.min.js' + KATEX_VER;
  var kx = { loading:false, queue:[], timer:null, roots:[] };

  function hasTag(attr, needle){
    var tags = document.head.querySelectorAll(attr === 'link' ? 'link[rel="stylesheet"]' : 'script');
    for(var i=0;i<tags.length;i++){
      var href = tags[i].getAttribute('href') || tags[i].getAttribute('src') || '';
      if(href.indexOf(needle) >= 0) return true;
    }
    return false;
  }

  function loadKatex(cb){
    if(window.renderMathInElement){ try{ cb(); }catch(e){} return; }
    if(kx.loading){ kx.queue.push(cb); return; }
    kx.loading = true; kx.queue = [cb];
    if(!hasTag('link', 'katex.min.css')){
      var l = document.createElement('link');
      l.rel = 'stylesheet'; l.href = KATEX_CSS; document.head.appendChild(l);
    }
    var done = function(){
      kx.loading = false;
      if(kx.timer){ clearTimeout(kx.timer); kx.timer = null; }
      flushKx();
      rescanRoots();
    };
    var s1 = document.createElement('script');
    s1.src = KATEX_JS;
    var s2 = document.createElement('script');
    s1.onload = function(){
      if(window.renderMathInElement){ done(); return; }
      s2.src = KATEX_AUTO;
      s2.onload = done; s2.onerror = done;
      document.head.appendChild(s2);
    };
    s1.onerror = done;
    kx.timer = setTimeout(done, 10000);
    document.head.appendChild(s1);
    function flushKx(){ var q = kx.queue; kx.queue = []; q.forEach(function(f){ try{ f(); }catch(e){} }); }
  }

  // 库就绪后，补渲染此前已注册、但仍残留 $ 的题卡区域（自愈首次加载抖动）
  function rescanRoots(){
    if(!window.renderMathInElement) return;
    kx.roots.forEach(function(r){
      try{ if(r && r.isConnected && r.innerHTML.indexOf('$') >= 0) mathify(r); }catch(e){}
    });
  }

  function mathify(el){
    if(!el) return;
    if(!window.renderMathInElement){ return; }
    try{
      window.renderMathInElement(el, {
        delimiters: [
          { left:'$$', right:'$$', display:true },
          { left:'$', right:'$', display:false },
          { left:'\\[', right:'\\]', display:true },
          { left:'\\(', right:'\\)', display:false }
        ],
        throwOnError: false,
        ignoredTags: ['script','noscript','style','textarea','pre','code']
      });
    }catch(e){}
  }

  /* ---------- 题目上下文 ---------- */
  function strip(html){
    return String(html||'').replace(/<img[^>]*>/g,' [图] ')
      .replace(/<[^>]*>/g,' ').replace(/&nbsp;/g,' ').replace(/\s+/g,' ').trim();
  }
  function imgs(html){
    var out = [], re = /<img[^>]+src=["']([^"']+)["']/g, m;
    while((m = re.exec(String(html||'')))) { if(out.indexOf(m[1]) < 0) out.push(m[1]); }
    return out;
  }

  function buildQA(q){
    var parts = [];
    parts.push('第 ' + q.no + ' 题（' + (q.type === 'choice' ? '选择题' : '主观题') + '，' + (q.score ? q.score + ' 分' : '分值未标注') + '）');
    if(q.material) parts.push('【材料】' + strip(q.material));
    parts.push('【题干】' + (strip(q.stem) || '（题干正文为图片，见附图）'));
    if(q.options && q.options.length){
      parts.push('【选项】' + q.options.map(function(o){
        return o.k + '. ' + (strip(o.html) || '（图）');
      }).join('  '));
    }
    var right = (q.options || []).filter(function(o){ return o.correct; }).map(function(o){ return o.k; });
    if(right.length) parts.push('【标准答案】' + right.join('、'));
    if(q.answer) parts.push('【参考答案文本】' + strip(q.answer));
    if(q.analysis) parts.push('【题库解析】' + strip(q.analysis));
    var myans = '';
    try{ myans = localStorage.getItem('sb:ans:' + (window.__currentPaperId || '') + ':' + q.no) || ''; }catch(e){}
    if(myans) parts.push('【学生自己的作答】' + myans);
    var img = [];
    if(q.stem) img = img.concat(imgs(q.stem));
    (q.options || []).forEach(function(o){ img = img.concat(imgs(o.html || '')); });
    return { text: parts.join('\n'), images: img.slice(0, 4) };
  }

  /* ---------- 本地答疑（无 Key） ---------- */
  var TOPICS = [
    { k:['极限','lim','∞','连续'], t:'极限与连续：等价无穷小、洛必达、夹逼、分段点连续性' },
    { k:['导数','可导','f\'','切线','单调','极值'], t:'导数与微分：求导法则、隐函数、单调性与极值' },
    { k:['积分','dx','不定积分','定积分','∫'], t:'积分：换元/分部、变限积分、定积分几何应用' },
    { k:['矩阵','行列式','方程组','秩'], t:'线性代数：矩阵运算、行列式、解的判定' },
    { k:['概率','随机','分布','期望'], t:'概率统计：古典概型、分布律、期望方差' },
    { k:['微分方程','y\'','通解'], t:'微分方程：一阶线性、可分离变量' },
    { k:['级数','收敛','发散'], t:'级数：正项级数判敛、幂级数收敛半径' },
    { k:['向量','平面','直线'], t:'空间解析几何：法向量、夹角、距离' }
  ];

  function localAnswer(){
    var q = state.q;
    var txt = strip(q.stem) + ' ' + (q.options || []).map(function(o){ return strip(o.html); }).join(' ');
    var hits = TOPICS.filter(function(t){ return t.k.some(function(k){ return txt.indexOf(k) >= 0; }); });
    var blocks = [];
    blocks.push('当前未配置模型 API Key，只能按题库内容答疑（不做推导，避免算错）。');
    if(hits.length) blocks.push('**可能考的知识点**：' + hits.map(function(h){ return h.t; }).join('；'));
    var right = (q.options || []).filter(function(o){ return o.correct; }).map(function(o){ return o.k; });
    if(right.length) blocks.push('**标准答案**：' + right.join('、'));
    if(q.analysis) blocks.push('**题库解析**：' + strip(q.analysis));
    else if(!q.answerHtml) blocks.push('这道题题库没有给文字解析，答案可能是图片；点「查看答案」对照。');
    blocks.push('——\n想让我讲解思路、对比选项、检查你的解法，请点右上角「设置」填入 API Key（支持 DeepSeek / 通义 / OpenAI 兼容）。');
    return blocks.join('\n\n');
  }

  /* ---------- 面板 ---------- */
  var CSS = '\
  .aiq-fab{position:fixed;right:22px;bottom:26px;z-index:998;width:56px;height:56px;border-radius:50%;border:0;\
    background:linear-gradient(135deg,#0f766e,#14b8a6);color:#fff;font-size:21px;cursor:pointer;padding:0;\
    box-shadow:0 8px 22px rgba(15,118,110,.35);display:flex;align-items:center;justify-content:center;\
    transition:transform .15s ease,box-shadow .15s ease;line-height:1}\
  .aiq-fab:hover{transform:scale(1.07);box-shadow:0 10px 26px rgba(15,118,110,.45)}\
  .aiq-fab:active{transform:scale(.95)}\
  .aiq-fab::after{content:"";position:absolute;inset:-5px;border-radius:50%;border:2px solid rgba(20,184,166,.5);\
    animation:aiqPulse 2.6s ease-out infinite;pointer-events:none}\
  @keyframes aiqPulse{0%{transform:scale(.85);opacity:.75}70%{transform:scale(1.45);opacity:0}100%{opacity:0}}\
  .aiq{position:fixed;right:14px;bottom:92px;width:min(330px,90vw);max-height:min(520px,64vh);z-index:999;\
    background:#fff;border:1px solid #e3e7ec;border-radius:14px;overflow:hidden;\
    display:none;flex-direction:column;box-shadow:0 14px 34px rgba(16,32,43,.2);\
    transform:translateZ(0);will-change:transform;isolation:isolate}\
  .aiq.on{display:flex}\
  .aiq-top{position:relative;z-index:2;display:flex;align-items:center;gap:8px;padding:10px 12px;border-bottom:1px solid #e3e7ec;background:#fbfcfd}\
  .aiq-top .t{font-size:13px;font-weight:650;color:#16202b;flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}\
  .aiq-btn{border:1px solid #e3e7ec;background:#fff;color:#4b5a68;border-radius:7px;padding:4px 9px;font-size:12px;cursor:pointer}\
  .aiq-btn:hover{background:#f4f6f8}\
  .aiq-body{flex:1;overflow:auto;padding:12px;background:#fff}\
  .aiq-q{background:#f7f9fa;border:1px solid #e3e7ec;border-radius:9px;padding:9px 11px;font-size:12.5px;color:#4b5a68;margin-bottom:10px;line-height:1.7;max-height:170px;overflow:auto}\
  .aiq-msg{margin-bottom:12px;font-size:13.5px;line-height:1.85;white-space:pre-wrap;word-break:break-word}\
  .aiq-msg.me{background:#eef4ff;border-radius:9px;padding:8px 11px;color:#1f3b6e}\
  .aiq-msg.ai{color:#16202b}\
  .aiq-msg.ai b{color:#0d7a71}\
  .aiq-chip{display:inline-block;border:1px solid #d8e6e3;background:#f4fbf9;color:#0d7a71;border-radius:16px;\
    padding:4px 11px;font-size:12px;margin:0 6px 6px 0;cursor:pointer}\
  .aiq-chip:hover{background:#e8f5f3}\
  .aiq-foot{border-top:1px solid #e3e7ec;padding:9px 12px;display:flex;gap:8px;align-items:flex-end;background:#fbfcfd}\
  .aiq-in{flex:1;border:1px solid #e3e7ec;border-radius:9px;padding:8px 10px;font-size:13.5px;resize:none;max-height:110px;min-height:40px;outline:none;font-family:inherit}\
  .aiq-in:focus{border-color:#9ed3cb;box-shadow:0 0 0 3px rgba(15,118,110,.08)}\
  .aiq-send{background:#0f766e;color:#fff;border:0;border-radius:9px;padding:9px 15px;font-size:13px;cursor:pointer}\
  .aiq-send.stop{background:#c0392b}\
  .aiq-send:disabled{opacity:.5;cursor:not-allowed}\
  .aiq-hist{position:absolute;inset:0;background:#fff;z-index:6;display:none;flex-direction:column}\
  .aiq-hist .list{flex:1;overflow:auto;padding:10px}\
  .aiq-hist .item{border:1px solid #e8edf2;border-radius:9px;padding:9px 11px;margin-bottom:8px;cursor:pointer;background:#fff}\
  .aiq-hist .item:hover{background:#f7fafc;border-color:#cfe0ec}\
  .aiq-hist .no{font-size:12.5px;font-weight:650;color:#0d7a71}\
  .aiq-hist .snip{font-size:12px;color:#5b6b79;margin-top:3px;line-height:1.6;max-height:38px;overflow:hidden}\
  .aiq-hist .tm{font-size:11px;color:#9aa7b4;margin-top:4px}\
  .aiq-hist .empty{color:#8a97a4;font-size:12.5px;padding:10px 6px;line-height:1.7}\
  .aiq-set{position:absolute;inset:0;background:#fff;z-index:5;padding:18px;overflow:auto}\
  .aiq-set h3{margin:0 0 12px;font-size:15px}\
  .aiq-set label{display:block;font-size:12.5px;color:#4b5a68;margin:12px 0 5px}\
  .aiq-set input,.aiq-set select{width:100%;border:1px solid #e3e7ec;border-radius:8px;padding:8px 10px;font-size:13px;outline:none;font-family:inherit}\
  .aiq-set .hint{font-size:11.5px;color:#8a97a4;margin-top:6px;line-height:1.7}\
  .aiq-set .row{display:flex;gap:8px;margin-top:16px}\
  .aiq-err{color:#c0392b;font-size:12.5px}\
  .aiq-quote{position:fixed;z-index:1000;display:none;align-items:center;gap:6px;\
    background:#0f766e;color:#fff;border:0;border-radius:8px;padding:6px 11px;font-size:12.5px;\
    cursor:pointer;box-shadow:0 6px 16px rgba(15,118,110,.35);white-space:nowrap;font-family:inherit}\
  .aiq-quote:hover{background:#0d6a63}\
  .aiq-quote .q-ic{font-size:13px}\
  ';

  function el(tag, cls, html){
    var e = document.createElement(tag);
    if(cls) e.className = cls;
    if(html != null) e.innerHTML = html;
    return e;
  }

  function ensureUI(){
    if(state.panel) return;
    var st = document.createElement('style'); st.textContent = CSS; document.head.appendChild(st);

    var fab = el('button', 'aiq-fab', '✦');
    fab.title = 'AI 答疑 · 自动识别当前题目';
    fab.onclick = function(){
      var pp = state.panel;
      if(pp && pp.classList.contains('on')){ pp.classList.remove('on'); return; }
      openAuto();
    };
    document.body.appendChild(fab);

    var p = el('div', 'aiq');    p.innerHTML = '\
      <div class="aiq-top">\
        <span class="t" id="aiqTitle">AI 答疑</span>\
        <button class="aiq-btn" id="aiqPrev" title="上一题">‹</button>\
        <button class="aiq-btn" id="aiqNext" title="下一题">›</button>\
        <button class="aiq-btn" id="aiqHist">历史</button>\
        <button class="aiq-btn" id="aiqCfg">设置</button>\
        <button class="aiq-btn" id="aiqClose">关闭</button>\
      </div>\
      <div class="aiq-body" id="aiqBody"></div>\
      <div class="aiq-foot">\
        <textarea class="aiq-in" id="aiqIn" placeholder="问：这题为什么选这个？帮我讲讲思路…"></textarea>\
        <button class="aiq-send" id="aiqSend">发送</button>\
      </div>\
      <div class="aiq-hist">\
        <div class="aiq-top">\
          <span class="t">对话历史（按题保存）</span>\
          <button class="aiq-btn" id="aiqHistClear">清空</button>\
          <button class="aiq-btn" id="aiqHistBack">返回</button>\
        </div>\
        <div class="list" id="aiqHistList"></div>\
      </div>';
    document.body.appendChild(p);
    state.panel = p;

    var setWin = el('div', 'aiq-set');
    setWin.style.display = 'none';
    setWin.innerHTML = '\
      <h3>模型接口设置</h3>\
      <label>服务商</label>\
      <select id="aiqPreset"></select>\
      <label>Base URL</label>\
      <input id="aiqBase" placeholder="https://api.deepseek.com/v1">\
      <label>模型名称</label>\
      <input id="aiqModel" placeholder="deepseek-chat">\
      <label>API Key</label>\
      <input id="aiqKey" type="password" placeholder="sk-...">\
      <div class="hint" id="aiqTip"></div>\
      <div class="hint">Key 只保存在本机浏览器（localStorage），直连服务商，不经过本站服务器。公共电脑用完请清空。</div>\
      <div class="row">\
        <button class="aiq-btn" id="aiqSetCancel">取消</button>\
        <button class="aiq-btn" id="aiqSetSave" style="background:#0f766e;color:#fff;border-color:#0f766e">保存</button>\
      </div>';
    p.appendChild(setWin);

    var sel = setWin.querySelector('#aiqPreset');
    Object.keys(PRESETS).forEach(function(k){
      var o = el('option'); o.value = k; o.textContent = PRESETS[k].label; sel.appendChild(o);
    });
    sel.onchange = function(){
      var pr = PRESETS[sel.value];
      setWin.querySelector('#aiqBase').value = pr.base;
      setWin.querySelector('#aiqModel').value = pr.model;
      setWin.querySelector('#aiqTip').textContent = pr.tip || '';
    };

    p.querySelector('#aiqClose').onclick = function(){ p.classList.remove('on'); };
    p.querySelector('#aiqPrev').onclick = function(){ shift(-1); };
    p.querySelector('#aiqNext').onclick = function(){ shift(1); };
    p.querySelector('#aiqHist').onclick = function(){ showHist(); };
    p.querySelector('#aiqHistBack').onclick = function(){ p.querySelector('.aiq-hist').style.display = 'none'; };
    p.querySelector('#aiqHistClear').onclick = function(){ clearHist(); };
    p.querySelector('#aiqCfg').onclick = function(){
      var c = cfg();
      sel.value = c.preset || 'agnes';
      setWin.querySelector('#aiqBase').value = c.base || PRESETS[sel.value].base;
      setWin.querySelector('#aiqModel').value = c.model || PRESETS[sel.value].model;
      setWin.querySelector('#aiqKey').value = c.key || '';
      setWin.querySelector('#aiqTip').textContent = PRESETS[sel.value].tip || '';
      setWin.style.display = 'block';
    };
    setWin.querySelector('#aiqSetCancel').onclick = function(){ setWin.style.display = 'none'; };
    setWin.querySelector('#aiqSetSave').onclick = function(){
      saveCfg({
        preset: sel.value,
        base: setWin.querySelector('#aiqBase').value.trim(),
        model: setWin.querySelector('#aiqModel').value.trim(),
        key: setWin.querySelector('#aiqKey').value.trim(),
        vision: PRESETS[sel.value].vision
      });
      setWin.style.display = 'none';
      render();
    };

    p.querySelector('#aiqSend').onclick = function(){ if(state.busy) stopGen(); else send(); };
    var ta = p.querySelector('#aiqIn');
    ta.addEventListener('keydown', function(e){
      if(e.key === 'Enter' && (e.ctrlKey || e.metaKey)){ e.preventDefault(); send(); }
    });

    // 选中文字 → 引用追问浮条
    var bar = el('button', 'aiq-quote');
    bar.innerHTML = '<span class="q-ic">❝</span>引用追问';
    bar.style.display = 'none';
    bar.addEventListener('mousedown', function(e){ e.preventDefault(); });
    bar.onclick = onQuoteAsk;
    document.body.appendChild(bar);
    state.quoteBar = bar;

    document.addEventListener('mouseup', function(){ setTimeout(detectQuote, 120); });
    document.addEventListener('mousedown', function(e){
      if(bar.style.display === 'flex' && !bar.contains(e.target)) hideQuoteBar();
    });
  }

  /* ---------- 对话历史（按试卷 + 题号持久化） ---------- */
  function pid(){ return window.__currentPaperId || ''; }
  function histKey(no){ return 'sb:aichat:' + pid() + ':' + no; }
  function loadHist(no){
    try{ var v = localStorage.getItem(histKey(no)); return v ? JSON.parse(v) : []; }catch(e){ return []; }
  }
  function saveHist(no, h){
    if(!no) return;
    try{
      var arr = (h || []).slice(-40);
      if(arr.length) localStorage.setItem(histKey(no), JSON.stringify(arr));
      else localStorage.removeItem(histKey(no));
    }catch(e){}
  }
  function histNos(){
    var out = [], pre = 'sb:aichat:' + pid() + ':';
    try{
      for(var i=0;i<localStorage.length;i++){
        var k = localStorage.key(i);
        if(k && k.indexOf(pre) === 0){ var n = +k.slice(pre.length); if(n) out.push(n); }
      }
    }catch(e){}
    return out;
  }

  function showHist(){
    var p = state.panel;
    var list = p.querySelector('#aiqHistList');
    var win = p.querySelector('.aiq-hist');
    list.innerHTML = '';
    var nos = histNos();
    if(!nos.length){
      list.innerHTML = '<div class="empty">这套卷还没有对话记录。<br>问过之后会按题号自动存到这里，换题、关面板都不会丢。</div>';
      win.style.display = 'flex';
      return;
    }
    var items = nos.map(function(no){
      var arr = loadHist(no);
      return { no: no, arr: arr, last: arr.length ? arr[arr.length-1] : null };
    }).sort(function(a,b){ return ((b.last && b.last.ts) || 0) - ((a.last && a.last.ts) || 0); });

    var pk = currentPk();
    items.forEach(function(it){
      var d = el('div', 'item');
      var snip = String((it.last && it.last.content) || '').replace(/\s+/g,' ').slice(0, 80);
      var tm = it.last && it.last.ts
        ? new Date(it.last.ts).toLocaleString('zh-CN', { month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit' })
        : '';
      d.innerHTML = '<div class="no">第 ' + it.no + ' 题 · ' + it.arr.length + ' 条</div>'
        + '<div class="snip">' + escHtml(snip) + '</div>'
        + '<div class="tm">' + escHtml(tm) + '</div>';
      d.onclick = function(){
        win.style.display = 'none';
        var q = pk ? pk.questions.filter(function(x){ return x.no === it.no; })[0] : null;
        if(q) open(q, { paperTitle: pk.title });
      };
      list.appendChild(d);
    });
    win.style.display = 'flex';
  }

  function clearHist(){
    var pre = 'sb:aichat:' + pid() + ':';
    try{
      var keys = [];
      for(var i=0;i<localStorage.length;i++){
        var k = localStorage.key(i);
        if(k && k.indexOf(pre) === 0) keys.push(k);
      }
      keys.forEach(function(k){ localStorage.removeItem(k); });
    }catch(e){}
    state.history = [];
    render();
    showHist();
  }

  /* ---------- 选中引用追问 ---------- */
  function resolveQFromCard(card){
    if(!card) return null;
    var no = +card.getAttribute('data-no');
    var pid = card.getAttribute('data-paper') || window.__currentPaperId;
    var pk = (window.PAPERS || {})[pid] || currentPk();
    if(!pk) return null;
    var q = pk.questions.filter(function(x){ return x.no === no; })[0];
    return q ? { q: q, ctx: { paperTitle: pk.title } } : null;
  }

  function hideQuoteBar(){
    if(state.quoteBar) state.quoteBar.style.display = 'none';
  }

  function showQuoteBar(rect){
    var bar = state.quoteBar;
    bar.style.display = 'flex';
    var bw = bar.offsetWidth || 130;
    var left = Math.max(8, Math.min(rect.left + rect.width / 2 - bw / 2, window.innerWidth - bw - 8));
    var top = rect.top - bar.offsetHeight - 8;
    if(top < 8) top = rect.bottom + 8;
    bar.style.left = left + 'px';
    bar.style.top = top + 'px';
  }

  function detectQuote(){
    hideQuoteBar();
    var sel = window.getSelection();
    if(!sel || sel.isCollapsed) return;
    var text = String(sel.toString() || '').replace(/\s+/g, ' ').trim();
    if(text.length < 2) return;
    var node = sel.anchorNode;
    if(!node) return;
    var el = node.nodeType === 1 ? node : node.parentElement;
    if(!el) return;
    var tag = (el.tagName || '').toLowerCase();
    if(tag === 'textarea' || tag === 'input') return;

    var card = el.closest ? el.closest('.q') : null;
    var aiMsg = el.closest ? el.closest('.aiq-msg.ai') : null;
    var data = null;
    if(card){
      var r = resolveQFromCard(card);
      if(!r) return;
      data = { q: r.q, ctx: r.ctx, source: 'card' };
    } else if(aiMsg){
      if(!state.q) return;
      data = { q: state.q, ctx: state.ctx || {}, source: 'ai' };
    } else {
      return;
    }
    var range = sel.getRangeAt(0);
    var rect = range.getBoundingClientRect();
    state.quote = data;
    state.quote.text = text;
    showQuoteBar(rect);
  }

  function onQuoteAsk(){
    var d = state.quote;
    if(!d) return;
    var quote = state.quote.text;
    open(d.q, d.ctx);
    var question = d.source === 'ai'
      ? '关于上面回答里这句话：“' + quote + '”，这个结论 / 这一步是怎么来的？请再展开讲清楚推导过程。'
      : '针对题目或解析里这句话：“' + quote + '”，这一步是怎么来的？请结合本题把推导或理由讲清楚。';
    var ta = state.panel.querySelector('#aiqIn');
    ta.value = question;
    hideQuoteBar();
    send();
  }

  function open(q, ctx){
    ensureUI();
    if(!q) return;
    var keepY = window.scrollY;
    state.q = q; state.ctx = ctx || {};
    state.history = loadHist(q.no);
    var p = state.panel;
    p.classList.add('on');
    var pk = currentPk();
    var idx = pk ? pk.questions.findIndex(function(x){ return x.no === q.no; }) : -1;
    var title = (ctx && ctx.paperTitle) || (pk ? pk.title : '');
    p.querySelector('#aiqTitle').textContent = (title ? title + ' · ' : '') + '第 ' + q.no + ' 题'
      + (idx >= 0 ? ' / 共 ' + pk.questions.length + ' 题' : '');
    render();
    requestAnimationFrame(function(){ if(window.scrollY !== keepY) window.scrollTo(0, keepY); });
  }

  /* ---------- 自动识别当前在做的题 ---------- */
  function currentPk(){
    var pid = window.__currentPaperId;
    if(!pid){
      // 兜底：题目卡片上带了试卷 id
      var card = document.querySelector('.q[data-no][data-paper]');
      if(card) pid = card.getAttribute('data-paper');
      if(pid) window.__currentPaperId = pid;
    }
    if(!pid) return null;
    return (window.PAPERS || {})[pid] || null;
  }

  function pickNo(){
    // 1) 草稿纸模式下，以浮窗里正在做的那道题为准
    var bd = document.getElementById('board');
    if(bd && bd.classList.contains('on')){
      var qf = document.querySelector('.qfloat');
      if(qf && qf.dataset.no){ return { no: +qf.dataset.no, src: '草稿纸' }; }
    }
    // 2) 否则取视口里最靠近中心的题卡
    var cards = [].slice.call(document.querySelectorAll('.q[data-no]'));
    if(!cards.length) return null;
    var mid = window.innerHeight * 0.42, best = null, bestD = 1e9;
    cards.forEach(function(c){
      var r = c.getBoundingClientRect();
      if(r.bottom < 70 || r.top > window.innerHeight - 50) return;
      var d = Math.abs((r.top + r.bottom) / 2 - mid);
      if(d < bestD){ bestD = d; best = c; }
    });
    if(!best){
      // 没有完整可见的，取离视口上边最近的一张
      cards.forEach(function(c){
        var r = c.getBoundingClientRect();
        var d = Math.abs(r.top - 120);
        if(d < bestD){ bestD = d; best = c; }
      });
    }
    return { no: +best.dataset.no, src: '页面' };
  }

  function openAuto(){
    ensureUI();
    var p = state.panel;
    p.classList.add('on');
    var pk = currentPk();
    if(!pk){
      p.querySelector('#aiqTitle').textContent = 'AI 答疑';
      var b0 = p.querySelector('#aiqBody');
      b0.innerHTML = '<div class="aiq-msg ai" style="color:#8a97a4">还没选中试卷。先在左侧列表点一套真题或模拟卷，题目出来后再点这个小球。</div>';
      return;
    }
    var sel = pickNo();
    if(!sel){
      p.querySelector('#aiqTitle').textContent = 'AI 答疑';
      var kw0 = window.__sbKeyword;
      p.querySelector('#aiqBody').innerHTML = kw0
        ? '<div class="aiq-msg ai">页面搜索框里是“' + escHtml(kw0) + '”，题目被它过滤掉了，所以页面上看不到题。<div style="margin-top:8px"><button class="aiq-chip" id="aiqClrKw" style="cursor:pointer">清空搜索</button></div></div>'
        : '<div class="aiq-msg ai" style="color:#8a97a4">试卷里没找到题目卡片，请刷新页面后重试。</div>';
      var cb = p.querySelector('#aiqClrKw');
      if(cb) cb.onclick = function(){ if(window.__sbClearSearch) window.__sbClearSearch(); openAuto(); };
      return;
    }
    var q = pk.questions.filter(function(x){ return x.no === sel.no; })[0] || pk.questions[0];
    open(q, { paperTitle: pk.title });
    var tip = document.createElement('div');
    tip.className = 'aiq-msg';
    tip.style.cssText = 'font-size:12px;color:#0d7a71;background:#f2fbf9;border:1px solid #d8efe9;border-radius:8px;padding:7px 10px;margin-bottom:10px';
    tip.textContent = '已按' + sel.src + '位置识别：第 ' + q.no + ' 题，可点右上角 ‹ › 换题';
    var body = state.panel.querySelector('#aiqBody');
    body.insertBefore(tip, body.firstChild.nextSibling);
    var kw = window.__sbKeyword;
    if(kw){
      var warn = document.createElement('div');
      warn.className = 'aiq-msg';
      warn.style.cssText = 'font-size:12px;color:#8a5a00;background:#fff8e6;border:1px solid #f0e0b8;border-radius:8px;padding:7px 10px;margin-bottom:10px;cursor:pointer';
      warn.textContent = '页面搜索框里是“' + kw + '”，题目被它过滤掉了。点这里清空搜索。';
      warn.onclick = function(){
        if(window.__sbClearSearch) window.__sbClearSearch();
        warn.remove();
      };
      body.insertBefore(warn, tip.nextSibling);
    }
  }

  function shift(n){
    var pk = currentPk();
    if(!pk || !state.q) return;
    var i = pk.questions.findIndex(function(x){ return x.no === state.q.no; });
    if(i < 0) i = 0;
    i = (i + n + pk.questions.length) % pk.questions.length;
    open(pk.questions[i], { paperTitle: pk.title });
  }

  function render(){
    var body = state.panel.querySelector('#aiqBody');
    var c = cfg();
    var q = state.q;
    var head = el('div', 'aiq-q');
    var txt = strip(q.stem || '');
    if(q.material){ txt = '【材料】' + strip(q.material).slice(0, 80) + '…  ' + txt; }
    head.textContent = txt || '（题干为图片）';
    var wrap = [head];

    if(!c.key && !state.history.length){
      wrap.push(el('div', 'aiq-msg ai', localAnswer().replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')));
    }
    state.history.forEach(function(m){
      var d = el('div', 'aiq-msg ' + (m.role === 'user' ? 'me' : 'ai'));
      d.innerHTML = m.role === 'user' ? escHtml(m.content) : fmt(m.content);
      wrap.push(d);
    });
    var chips = el('div');
    ['这题考什么？', '为什么选这个答案？', '其他选项错在哪？', '帮我检查我的思路'].forEach(function(t){
      var ch = el('span', 'aiq-chip', t);
      ch.onclick = function(){ state.panel.querySelector('#aiqIn').value = t; send(); };
      chips.appendChild(ch);
    });
    wrap.push(chips);

    body.innerHTML = '';
    wrap.forEach(function(w){ body.appendChild(w); });
    loadKatex(function(){
      wrap.forEach(function(w){
        if(!w.className || String(w.className).indexOf('aiq-msg') < 0) return;
        if(window.renderMathInElement) mathify(w);
        else w.innerHTML = fmt(String(w.textContent || '').replace(/\$\$?/g, ''));
      });
    });
    body.scrollTop = body.scrollHeight;
  }

  function escHtml(s){
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function fmt(s){
    return escHtml(s)
      .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
      .replace(/`([^`]+)`/g, '<code style="background:#f3f5f7;padding:1px 4px;border-radius:4px">$1</code>');
  }

  function send(){
    if(state.busy) return;
    var ta = state.panel.querySelector('#aiqIn');
    var text = ta.value.trim();
    if(!text) return;
    ta.value = '';
    state.history.push({ role:'user', content:text, ts:Date.now() });
    saveHist(state.q.no, state.history);
    render();

    var c = cfg();
    if(!c.key){
      state.history.push({ role:'assistant', content: localAnswer(), ts:Date.now() });
      saveHist(state.q.no, state.history);
      render();
      return;
    }
    ask(text, c);
  }

  function stopGen(){
    if(state.ctrl){ try{ state.ctrl.abort(); }catch(e){} }
  }

  function buildMessages(q, question, vision){
    var ctx = buildQA(q);
    var sys = '你是贵州专升本（高等数学 / 英语）辅导老师。学生正在做这套题。'
      + '回答要求：先给结论，再给步骤；数学推导逐步写清楚，指出用到的定理或公式；'
      + '数学表达式用 LaTeX 写在 $...$ 里（例如 $\\ln 0.3<0$），页面会自动渲染成公式，不要用图片或字符画。'
      + '若题目给了标准答案，你的结论必须与标准答案一致，如认为答案可能有误要明确说明理由。'
      + '不要编造题目里没有的信息；看不清图片时说清缺什么。语气简洁，面向备考学生。';
    var userText = '题目信息：\n' + ctx.text + '\n\n我的问题：' + question
      + (ctx.text.indexOf('【学生自己的作答】') >= 0 ? '\n（内含学生自己的作答，请先判断对错再讲）' : '');
    if(vision && ctx.images.length){
      var content = [{ type:'text', text:userText }];
      ctx.images.forEach(function(u){ content.push({ type:'image_url', image_url:{ url:u } }); });
      return [{ role:'system', content:sys }, { role:'user', content:content }];
    }
    return [{ role:'system', content:sys }, { role:'user', content:userText + '\n（题干公式为图片，若信息不足请说明）' }];
  }

  function ask(text, c){
    state.busy = true;
    var btn = state.panel.querySelector('#aiqSend');
    btn.disabled = false;
    btn.textContent = '停止';
    btn.classList.add('stop');

    var body = state.panel.querySelector('#aiqBody');
    var live = el('div', 'aiq-msg ai', '<span style="color:#8a97a4">正在读题并思考…（带公式图的题约 20–40 秒，随时可点「停止」）</span>');
    body.appendChild(live);
    body.scrollTop = body.scrollHeight;

    var acc = '';
    state.ctrl = (typeof AbortController !== 'undefined') ? new AbortController() : null;

    var url = (c.base || '').replace(/\/+$/, '') + '/chat/completions';
    var payload = {
      model: c.model,
      stream: true,
      temperature: 0.3,
      messages: buildMessages(state.q, text, !!c.vision)
    };

    fetch(url, {
      method:'POST',
      headers:{ 'Content-Type':'application/json', 'Authorization':'Bearer ' + c.key },
      body: JSON.stringify(payload),
      signal: state.ctrl ? state.ctrl.signal : undefined
    }).then(function(res){
      if(!res.ok){
        return res.text().then(function(t){
          throw new Error('HTTP ' + res.status + ' ' + t.slice(0, 180));
        });
      }
      var reader = res.body.getReader();
      var dec = new TextDecoder();
      var buf = '';
      function pump(){
        return reader.read().then(function(r){
          if(r.done){ resetBtn(); settle(acc, ''); return; }
          buf += dec.decode(r.value, {stream:true});
          var lines = buf.split('\n');
          buf = lines.pop();
          lines.forEach(function(line){
            line = line.trim();
            if(!line.indexOf('data:')) line = line.slice(5).trim();
            else return;
            if(!line || line === '[DONE]') return;
            try{
              var j = JSON.parse(line);
              var d = j.choices && j.choices[0] && j.choices[0].delta && j.choices[0].delta.content;
              if(d){ acc += d; live.innerHTML = fmt(acc); body.scrollTop = body.scrollHeight; }
            }catch(e){}
          });
          return pump();
        });
      }
      return pump();
    }).catch(function(err){
      resetBtn();
      if(err && (err.name === 'AbortError' || String(err).indexOf('AbortError') >= 0)){
        settle(acc, acc ? '⏹ 已停止生成' : '⏹ 已停止');
        return;
      }
      live.className = 'aiq-msg';
      live.innerHTML = '<span class="aiq-err">请求失败：' + escHtml(err.message || String(err)) +
        '<br>检查 Base URL / Key / 模型名是否正确，或该服务是否支持浏览器直连（部分服务需要 CORS 白名单）。</span>';
    });

    function resetBtn(){
      state.busy = false;
      state.ctrl = null;
      btn.disabled = false;
      btn.textContent = '发送';
      btn.classList.remove('stop');
    }

    function settle(acc2, note){
      var content = acc2 || '';
      if(note) content = (content ? content + '\n\n' : '') + note;
      if(content){
        state.history.push({ role:'assistant', content:content, ts:Date.now() });
        saveHist(state.q.no, state.history);
        live.innerHTML = fmt(content);
        loadKatex(function(){
          if(window.renderMathInElement) mathify(live);
          else live.innerHTML = fmt(String(content).replace(/\$\$?/g, ''));
        });
      } else if(!live.innerHTML){
        live.remove();
      }
    }
  }

  window.AIQA = { open: open, cfg: cfg };

  // 供题库页/工作台对题卡区域做公式渲染（KaTeX 未加载成功时静默跳过）
  window.__renderMath = function(root){
    if(!root) return;
    if(kx.roots.indexOf(root) < 0) kx.roots.push(root);
    loadKatex(function(){ mathify(root); });
  };

  // 页面一加载就把悬浮球挂出来（面板默认收起）
  if(document.body){ ensureUI(); }
  else { document.addEventListener('DOMContentLoaded', ensureUI); }
})();
