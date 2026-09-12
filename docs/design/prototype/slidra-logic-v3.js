// Slidra editor logic — attached to the DC logic class (see Slidra (New).dc.html).
const ICONS = {
  plus: '<path d="M10 4v12M4 10h12"/>',
  template: '<rect x="3" y="2.5" width="14" height="15" rx="2"/><path d="M6 6.5h8M6 10h8M6 13.5h5"/>',
  paste: '<rect x="5" y="3" width="10" height="14" rx="2"/><path d="M8 3V1.5h4V3"/>',
  cut: '<circle cx="5" cy="15" r="2"/><circle cx="15" cy="15" r="2"/><path d="M6 13.5L14 3M14 13.5L6 3"/>',
  copy: '<rect x="3" y="3" width="9" height="11" rx="2"/><path d="M6 16h8V6"/>',
  textbox: '<rect x="2.5" y="5" width="15" height="10" rx="2"/><path d="M7 8h6M10 8v4"/>',
  shape: '<circle cx="7" cy="7" r="4.5"/><rect x="8" y="9" width="8" height="8" rx="1.5"/>',
  rect: '<rect x="3" y="4" width="14" height="12" rx="1.5"/>',
  ellipse: '<ellipse cx="10" cy="10" rx="7.5" ry="6"/>',
  line: '<path d="M3 16L17 4"/>',
  arrange: '<rect x="2.5" y="2.5" width="9" height="9" rx="1.5"/><rect x="8" y="8" width="9" height="9" rx="1.5"/>',
  image: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><circle cx="7" cy="8" r="1.5"/><path d="M3 15l5-5 4 4 2-2 3 3"/>',
  video: '<rect x="2.5" y="4.5" width="10" height="11" rx="2"/><path d="M13 8l4.5-2.5v9L13 12z"/>',
  audio: '<path d="M4 8v4h3l4 3.5V4.5L7 8z"/><path d="M13.5 7.5a4 4 0 010 5"/>',
  table: '<rect x="2.5" y="3.5" width="15" height="13" rx="1.5"/><path d="M2.5 8h15M7.5 8v8.5M12.5 8v8.5"/>',
  chart: '<path d="M3 17h14M5 14V9M9 14V5M13 14v-3M17 14V7"/>',
  number: '<rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="M12 14h3"/>',
  none: '<circle cx="10" cy="10" r="7"/><path d="M5 15L15 5"/>',
  fade: '<circle cx="10" cy="10" r="7"/><path d="M10 3a7 7 0 010 14z" fill="currentColor" stroke="none" opacity=".5"/>',
  fromstart: '<path d="M6 4l9 6-9 6z"/><path d="M3 4v12"/>',
  fromhere: '<path d="M5 4l9 6-9 6z"/>',
  fullscr: '<path d="M3 7V3h4M17 7V3h-4M3 13v4h4M17 13v4h-4"/>',
  alignL: '<path d="M4 3v14M8 6h8v3H8zM8 11h5v3H8z"/>',
  alignC: '<path d="M10 3v14M6 6h8v3H6zM7.5 11h5v3h-5z"/>',
  alignR: '<path d="M16 3v14M4 6h8v3H4zM7 11h5v3H7z"/>',
  alignT: '<path d="M3 4h14M6 8h3v8H6zM11 8h3v5h-3z"/>',
  alignM: '<path d="M3 10h14M6 6h3v8H6zM11 7.5h3v5h-3z"/>',
  alignB: '<path d="M3 16h14M6 4h3v8H6zM11 7h3v5h-3z"/>',
  distH: '<path d="M3 3v14M17 3v14M7.5 7h5v6h-5z"/>',
  distV: '<path d="M3 3h14M3 17h14M7 7.5h6v5H7z"/>',
  front: '<rect x="3" y="3" width="10" height="10" rx="1.5"/><path d="M8 17h9V8"/>',
  back: '<rect x="7" y="7" width="10" height="10" rx="1.5"/><path d="M12 3H3v9"/>',
  forward: '<rect x="5" y="7" width="10" height="10" rx="1.5"/><path d="M10 5V1.5M7.5 4L10 1.5 12.5 4"/>',
  backward: '<rect x="5" y="3" width="10" height="10" rx="1.5"/><path d="M10 15v3.5M7.5 16l2.5 2.5 2.5-2.5"/>',
  dup: '<rect x="6" y="6" width="11" height="11" rx="2"/><path d="M3 14V3h11"/>',
  trash: '<path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/>',
  comment: '<path d="M3 4h14v9H9l-4 3v-3H3z"/>',
  edit: '<path d="M4 16h3l9-9-3-3-9 9z"/><path d="M11.5 5.5l3 3"/>',
  up: '<path d="M10 16V4M5 9l5-5 5 5"/>',
  down: '<path d="M10 4v12M5 11l5 5 5-5"/>',
  group: '<rect x="2.5" y="2.5" width="7" height="7" rx="1.5"/><rect x="10.5" y="10.5" width="7" height="7" rx="1.5"/><path d="M2.5 13v4.5h4M17.5 7V2.5h-4" stroke-dasharray="2 2"/>',
  wipe: '<rect x="3" y="5" width="14" height="10" rx="1.5"/><path d="M3 5l7 10M8 5l7 10" opacity=".5"/>',
  spark: '<path d="M10 2l1.8 5.2L17 9l-5.2 1.8L10 16l-1.8-5.2L3 9l5.2-1.8z"/>',
};
const FLAT = [
  {label:"Insert", cmds:[["textbox","Text","textbox"],["shape","Shape","shape"],["insert-image","Image","image"],["insert-video","Video","video"],["insert-audio","Audio","audio"],["insert-table","Table","table"],["insert-chart","Chart","chart"]]},
  {label:"Edit", cmds:[["animate","Animate","spark"],["arrange","Arrange","arrange"],["group","Group","group"]]},
];
const ENTER_FX = [["none","None"],["fade","Fade"],["slide","Slide in"],["zoom","Zoom in"]];
const EXIT_FX = [["none","None"],["fade","Fade"],["slide","Slide out"],["zoom","Zoom out"]];
const TABS = [["home","Home"],["insert","Insert"],["transitions","Transitions"],["show","Present"]];
const RIBBON = {
  home: [
    {label:"Slides", cmds:[["new-slide","New slide","plus"],["template","Templates","template"]]},
    {label:"Clipboard", cmds:[["paste","Paste","paste"],["cut","Cut","cut"],["copy","Copy","copy"]]},
    {label:"Draw", cmds:[["textbox","Text box","textbox"],["shape","Shape","shape"],["arrange","Arrange","arrange"]]},
  ],
  insert: [
    {label:"Media", cmds:[["insert-image","Image","image"],["insert-video","Video","video"],["insert-audio","Audio","audio"]]},
    {label:"Content", cmds:[["insert-table","Table","table"],["insert-chart","Chart","chart"],["insert-shape","Shape","shape"]]},
    {label:"Text", cmds:[["insert-textbox","Text box","textbox"],["slide-number","Slide number","number"]]},
  ],
  transitions: [{label:"Transition", cmds:[["transition-none","None","none"],["transition-fade","Fade","fade"]]}],
  show: [{label:"Start", cmds:[["play-from-start","From start","fromstart"],["play-from-current","From current","fromhere"],["toggle-fullscreen","Fullscreen","fullscr"]]}],
};
const TEMPLATES = [
  {name:"Title", tag:"text", bg:"#14161a", accent:"#c41e3a"},
  {name:"Section", tag:"text", bg:"#1b1d24", accent:"#4a8f45"},
  {name:"Two columns", tag:"layout", bg:"#14161a", accent:"#5b6dea", hasCols:true, kind:"cols"},
  {name:"Image + caption", tag:"image", bg:"#14161a", accent:"#e08a2e", hasMedia:true, kind:"image", mediaLabel:"image · drop a file"},
  {name:"Video", tag:"video", bg:"#1b1d24", accent:"#c41e3a", hasMedia:true, kind:"video", mediaLabel:"video · drop a file"},
  {name:"Data table", tag:"table", bg:"#14161a", accent:"#4a8f45", hasWide:true, kind:"table"},
];
const EFFECTS = [["fade","Fade in"],["flyup","Fly in (up)"],["flyleft","Fly in (left)"],["zoom","Zoom in"],["wipe","Wipe"]];
const TRIGGERS = [["click","On click"],["with","With previous"],["after","After previous"]];
const MEDIA_BOX = { image:{l:56,t:20,w:36,h:60}, video:{l:56,t:20,w:36,h:60}, audio:{l:9,t:56,w:82,h:22}, table:{l:9,t:40,w:82,h:44}, chart:{l:54,t:16,w:38,h:66} };
const PALETTES = { brand:["#C8233B","#5B6DEA","#4A8F45","#E08A2E","#2B9E75","#A9B0B8"], cool:["#5B6DEA","#2B9E75","#38BDF8","#A78BFA","#22C55E","#94A3B8"], warm:["#C8233B","#E08A2E","#F4C542","#D9634C","#B45309","#A9B0B8"] };
const CHART_TYPES = [["bar","Bar",'<path d="M3 17h14M5 14V8M9 14V4M13 14v-4M17 14V7"/>'],["hbar","Horizontal",'<path d="M3 3v14M6 5h9M6 9h5M6 13h11"/>'],["line","Line",'<path d="M3 15l4-5 3 3 4-6 3 2"/>'],["area","Area",'<path d="M3 16V13l4-5 3 3 4-6 3 3v8z" fill="currentColor" fill-opacity=".25"/>'],["pie","Pie",'<circle cx="10" cy="10" r="7"/><path d="M10 3v7h7"/>'],["donut","Donut",'<circle cx="10" cy="10" r="7"/><circle cx="10" cy="10" r="3"/><path d="M10 3v4"/>']];
const TABLE_THEMES = { dark:{bg:"transparent", head:"rgba(255,255,255,.06)", color:"#e7e9ee", headColor:"#a9b0b8", border:"rgba(255,255,255,.1)", zebra:"transparent"}, light:{bg:"#fff", head:"#F5F1EF", color:"#1F1A1A", headColor:"#6E635F", border:"#ECE5E2", zebra:"#FBF9F8"}, zebra:{bg:"transparent", head:"rgba(255,255,255,.08)", color:"#e7e9ee", headColor:"#a9b0b8", border:"rgba(255,255,255,.08)", zebra:"rgba(255,255,255,.045)"} };
const CELL = (t) => ({t});
const mkTable = (head, rows) => ({cells: [head.map(CELL), ...rows.map(r => r.map(CELL))], cols: head.map(() => ({w:1})), header:true, theme:"dark", border:true});
const mkChart = () => ({chartType:"bar", categories:["W1","W2","W3","W4","W5","W6"], series:[{name:"TTFB (ms)", values:[840,760,610,520,430,380]}], palette:"brand", legend:"bottom", grid:true, labels:true, xTitle:"Week", yTitle:"ms"});
const TYPE_LABEL = {text:"Text box", rect:"Rectangle", ellipse:"Ellipse", line:"Line", image:"Image", video:"Video", audio:"Audio", table:"Table", chart:"Chart"};
const TYPE_ICON = {text:"textbox", rect:"rect", ellipse:"ellipse", line:"line", image:"image", video:"video", audio:"audio", table:"table", chart:"chart"};
let _uid = 100; const uid = () => "e" + (++_uid);
const TXT = (name, text, box, size, weight, color) => ({id: uid(), type:"text", name, text, box, size, weight, color, align:"left"});
const mk = (o) => {
  const layout = o.kind ? (["table","audio"].includes(o.kind) ? "top" : "left") : "center";
  const tb = layout === "center" ? {l:8.4, t:36.5, w:52, h:15} : layout === "left" ? {l:8.4, t:30, w:44, h:15} : {l:8.4, t:12, w:60, h:14};
  const sb = layout === "center" ? {l:8.4, t:51, w:46, h:7.5} : layout === "left" ? {l:8.4, t:45, w:44, h:7.5} : {l:8.4, t:26, w:60, h:7.5};
  const els = [TXT("title", o.title, tb, layout === "left" ? 4.6 : 6.2, 700, "#f4f6f8")];
  if (o.sub) els.push(TXT("sub", o.sub, sb, 2.6, 400, "#a9b0b8"));
  els.push({id: uid(), type:"rect", name:"bar", box:{l: sb.l + .6, t: sb.t + sb.h + 3.5, w:12, h:1.2}, fill: o.accent});
  if (o.kind === "cols") { els.push(TXT("left column", "第一欄重點", {l:8.4,t:48,w:38,h:8}, 2.4, 500, "#e7e9ee")); els.push(TXT("right column", "第二欄重點", {l:53,t:48,w:38,h:8}, 2.4, 500, "#e7e9ee")); }
  else if (o.kind === "table") els.push({id: uid(), type:"table", name:"table", box:{...MEDIA_BOX.table}, ...mkTable(o.head || ["Column","Q2","Q3"], o.rows || [["Row 1","—","—"],["Row 2","—","—"]])});
  else if (o.kind === "chart") els.push({id: uid(), type:"chart", name:"chart", box:{...MEDIA_BOX.chart}, ...mkChart()});
  else if (o.kind) els.push({id: uid(), type:o.kind, name:o.kind, box:{...MEDIA_BOX[o.kind]}, mediaLabel:o.mediaLabel});
  return {id: uid(), bg: o.bg, accent: o.accent, elements: els, animOrder: []};
};
const SEED = [
  mk({title:"Q3 產品路線圖", sub:"2026 年第三季 · 產品團隊", bg:"#14161a", accent:"#c41e3a"}),
  mk({title:"本季三個重點", sub:"效能、協作、可觀測性", bg:"#14161a", accent:"#4a8f45", kind:"image", mediaLabel:"hero photo · 1600×900"}),
  mk({title:"效能：首屏 < 1s", sub:"Server-side streaming 與快取分層", bg:"#1b1d24", accent:"#c41e3a", kind:"chart"}),
  mk({title:"協作：即時多人編輯", sub:"CRDT 同步、衝突可視化", bg:"#14161a", accent:"#5b6dea", kind:"video", mediaLabel:"demo.mp4 · 0:42"}),
  mk({title:"可觀測性", sub:"追蹤、指標、告警一體化", bg:"#1b1d24", accent:"#e08a2e", kind:"table", head:["指標","Q2","Q3 目標"], rows:[["P95 延遲","840 ms","< 400 ms"],["錯誤率","0.8%","< 0.2%"],["告警平均回應","31 min","< 10 min"]]}),
  mk({title:"客戶訪談重點", sub:"三位企業客戶 · 逐字稿已附", bg:"#14161a", accent:"#2b9e75", kind:"audio", mediaLabel:"interview.m4a · 3:12"}),
  mk({title:"時程與里程碑", sub:"七月至九月", bg:"#14161a", accent:"#c41e3a"}),
];
(() => { const s = SEED[2], t = s.elements[0], sub = s.elements[1], ch = s.elements.find(e => e.type === "chart");
  t.anim = {effect:"flyup", trigger:"click", duration:.6, delay:0}; sub.anim = {effect:"fade", trigger:"after", duration:.5, delay:0}; ch.anim = {effect:"zoom", trigger:"click", duration:.7, delay:0};
  s.animOrder = [t.id, sub.id, ch.id]; })();
const SEED_MESSAGES = [
  {role:"author", text:"把第三頁的標題改成「效能：首屏 < 1s」"},
  {role:"command", state:"completed", target:"slides/03.svg", command:"textbox set --id title --text \"效能：首屏 < 1s\""},
  {role:"agent", text:"已更新第 3 頁的標題。要不要一併把副標改成量化目標？"},
  {role:"author", text:"好，副標寫「Server-side streaming 與快取分層」"},
  {role:"command", state:"in_progress", target:"slides/03.svg", command:"textbox set --id sub --text \"Server-side streaming 與快取分層\""},
];

export const INITIAL_STATE = { slides: SEED, cur:2, sels:[], past:[], future:[], tab:"home", view:"normal", mode:"view", side:"chat", menu:null, notice:false, dialog:false, fs:false, draft:"", note:"",
  comments:[], composer:false, commentDraft:"", flash:null, nextId:1, hoverIdx:-1, editingId:null, exportOpen:false, composerPos:{left:"-9999px", top:"0px"}, ctxPos:{left:"-9999px", top:"0px"},
  editing:null, editDraft:"", cellEdit:null, cellDraft:"", guides:[], marquee:null, ctxMenu:null, railFrom:-1, railOver:-1, outline:"", outlineModal:false, generating:false, messages: SEED_MESSAGES, dirty:false,
  playStep:0, preview:null, previewOne:null, tsel:null, chartWin:null, chartWinPos:null, transTick:0, exiting:null, insertDlg:null, deckW:1280, deckH:720, zoom:1, pan:{x:0,y:0}, space:false, panning:false, hand:false };

export class Logic {
  constructor(host, React) { this.host = host; this.React = React; this._timers = []; }
  get state() { return this.host.state; }
  get props() { return this.host.props; }
  setState(p) { this.host.setState(p); }
  get wellRef() { return this.host.wellRef; } get stageRef() { return this.host.stageRef; } get selRef() { return this.host.selRef; } get composerRef() { return this.host.composerRef; } get ctxRef() { return this.host.ctxRef; }
  mount() {
    if (this.props.startEmpty) this.setState({slides:[], cur:0});
    this._onResize = () => this.placeComposer(); this._onKey = (e) => this.onKey(e); this._onKeyUp = (e) => { if (e.key === " " || e.code === "Space") this.setState({space:false}); };
    window.addEventListener("resize", this._onResize); window.addEventListener("keydown", this._onKey); window.addEventListener("keyup", this._onKeyUp);
  }
  unmount() { window.removeEventListener("resize", this._onResize); window.removeEventListener("keydown", this._onKey); window.removeEventListener("keyup", this._onKeyUp); this.clearTimers(); }
  update(prev) {
    if (prev.startEmpty !== this.props.startEmpty) this.setState(this.props.startEmpty ? {slides:[], cur:0, sels:[]} : {slides: SEED, cur:0, sels:[]});
    this.placeComposer();
  }
  clearTimers() { this._timers.forEach(clearTimeout); this._timers = []; }
  // canvas zoom / pan (Figma-style)
  setZoom(z, cx, cy) { const s = this.state, nz = Math.max(.25, Math.min(4, z)); if (cx !== undefined) { const k = nz / s.zoom; this.setState({zoom: nz, pan: {x: cx - (cx - s.pan.x) * k, y: cy - (cy - s.pan.y) * k}}); } else this.setState({zoom: nz}); }
  zoomIn() { this.setZoom(this.state.zoom * 1.25); } zoomOut() { this.setZoom(this.state.zoom / 1.25); } zoomFit() { this.setState({zoom:1, pan:{x:0,y:0}}); }
  wellWheel(e) { const s = this.state; if (s.mode === "play") return; e.preventDefault(); if (e.ctrlKey || e.metaKey) { const W = this.wellRef.current.getBoundingClientRect(); const cx = e.clientX - W.left - W.width/2, cy = e.clientY - W.top - W.height/2; this.setZoom(s.zoom * Math.exp(-e.deltaY * .0025), cx, cy); } else this.setState({pan: {x: s.pan.x - e.deltaX, y: s.pan.y - e.deltaY}}); }
  wellDown(e) { const s = this.state; if (s.mode === "play") return; if (e.target.closest && e.target.closest("[data-ui]")) return; const onStage = e.target.closest && e.target.closest("[data-stage]"); const pan = e.button === 1 || s.space || s.hand || !onStage; if (!pan) return; e.preventDefault(); e.stopPropagation(); const x0 = e.clientX, y0 = e.clientY, p0 = {...s.pan}; this.setState({panning:true, menu:null, ctxMenu:null, insertDlg:null}); const onMove = (ev) => this.setState({pan: {x: p0.x + ev.clientX - x0, y: p0.y + ev.clientY - y0}}); const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); this.setState({panning:false}); }; window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp); }
  // history
  snapshot() { return {slides: this.state.slides}; }
  commit(patch, snap) { const s = this.state; this.setState({past: [...s.past.slice(-49), snap || this.snapshot()], future: [], dirty:true, ...patch}); }
  undo() { const s = this.state; if (this.props.editingFrozen) return this.toast("Undo paused while the agent is editing"); if (!s.past.length) return; const prev = s.past[s.past.length-1]; this.setState({past: s.past.slice(0,-1), future: [this.snapshot(), ...s.future], slides: prev.slides, cur: Math.min(s.cur, Math.max(0, prev.slides.length-1)), sels:[], editing:null, cellEdit:null}); }
  redo() { const s = this.state; if (this.props.editingFrozen) return this.toast("Redo paused while the agent is editing"); if (!s.future.length) return; const nxt = s.future[0]; this.setState({future: s.future.slice(1), past: [...s.past, this.snapshot()], slides: nxt.slides, cur: Math.min(s.cur, Math.max(0, nxt.slides.length-1)), sels:[], editing:null, cellEdit:null}); }
  // slides
  slide() { const s = this.state; return s.slides[Math.min(s.cur, s.slides.length-1)]; }
  go(i) { const n = this.state.slides.length; this.clearTimers(); this.setState({cur: Math.max(0, Math.min(i, n-1)), sels:[], editing:null, cellEdit:null, composer:false, editingId:null, ctxMenu:null, playStep:0, preview:null, previewOne:null, tsel:null, chartWin:null, transTick: this.state.transTick + 1, exiting:null}); }
  trans(sl) { const t = (sl && sl.transition) || {}; return {enter: t.enter || {effect:"none", duration:.6}, exit: t.exit || {effect:"none", duration:.5}}; }
  goWithExit(i) { const s = this.state, sl = this.slide(), x = this.trans(sl).exit; if (s.mode === "play" && x.effect !== "none" && !s.exiting) { this.setState({exiting: x}); this._timers.push(setTimeout(() => this.go(i), x.duration * 1000)); return; } this.go(i); }
  steps(slide) { if (!slide) return []; const groups = []; slide.animOrder.map(id => slide.elements.find(e => e.id === id)).filter(e => e && e.anim).forEach(e => { if (!groups.length || e.anim.trigger === "click") groups.push([e.id]); else groups[groups.length-1].push(e.id); }); return groups; }
  next() { const s = this.state; if (s.mode === "play") { if (s.exiting) return; const st = this.steps(this.slide()); if (s.playStep < st.length) return this.setState({playStep: s.playStep + 1}); if (s.cur >= s.slides.length - 1) return; return this.goWithExit(s.cur + 1); } this.go(s.cur + 1); }
  prev() { const s = this.state; if (s.mode === "play") { if (s.playStep > 0) return this.setState({playStep: s.playStep - 1}); if (s.cur <= 0) return; this.go(s.cur - 1); this.setState({playStep: this.steps(s.slides[s.cur-1]).length}); return; } this.go(s.cur - 1); }
  addSlide(at, tpl) {
    const s = this.state, sl = mk({title: tpl ? tpl.name : "New slide", sub: "Subtitle", bg: tpl ? tpl.bg : "#14161a", accent: tpl ? tpl.accent : "#c41e3a", kind: tpl && tpl.kind, mediaLabel: tpl && tpl.mediaLabel, head: tpl && tpl.kind === "table" ? ["Column","Q2","Q3"] : undefined, rows: tpl && tpl.kind === "table" ? [["Row 1","—","—"],["Row 2","—","—"]] : undefined});
    const slides = [...s.slides]; slides.splice(at, 0, sl);
    this.commit({slides, cur: at, sels:[], menu:null, ctxMenu:null, dialog:false});
  }
  duplicateSlide(i) {
    const s = this.state, src = s.slides[i]; if (!src) return;
    const map = {}; const els = src.elements.map(e => { const id = uid(); map[e.id] = id; return {...e, id, box:{...e.box}, anim: e.anim ? {...e.anim} : undefined}; });
    const copy = {...src, id: uid(), elements: els, animOrder: src.animOrder.map(id => map[id])};
    const slides = [...s.slides]; slides.splice(i+1, 0, copy);
    this.commit({slides, cur: i+1, sels:[], ctxMenu:null}); this.toast("Slide duplicated");
  }
  deleteSlide(i) { const s = this.state, sl = s.slides[i]; if (!sl) return; const slides = s.slides.filter((_, j) => j !== i); this.commit({slides, cur: Math.max(0, Math.min(i, slides.length-1)), sels:[], ctxMenu:null, comments: s.comments.filter(c => c.slideId !== sl.id)}); }
  moveSlide(from, to) {
    const s = this.state; if (from < 0 || from === to || from + 1 === to) return this.setState({railFrom:-1, railOver:-1});
    const slides = [...s.slides]; const [m] = slides.splice(from, 1); const idx = to > from ? to - 1 : to; slides.splice(idx, 0, m);
    this.commit({slides, cur: idx, railFrom:-1, railOver:-1});
  }
  updateSlide(patch, i = this.state.cur, live = false) { const slides = this.state.slides.map((sl, j) => j === i ? {...sl, ...patch} : sl); live ? this.setState({slides}) : this.commit({slides}); }
  // elements
  el(id) { const sl = this.slide(); return sl && sl.elements.find(e => e.id === id); }
  updateEls(map, live) { const sl = this.slide(); this.updateSlide({elements: sl.elements.map(e => map[e.id] ? {...e, ...map[e.id]} : e)}, this.state.cur, live); }
  addElement(el) { const sl = this.slide(); if (!sl) return this.toast("Add a slide first"); el.id = uid(); this.updateSlide({elements: [...sl.elements, el]}); this.setState({sels:[el.id], menu:null, ctxMenu:null}); }
  newText() { this.addElement({type:"text", name:`Text ${this.slide().elements.filter(e => e.type === "text").length + 1}`, text:"New text", box:{l:30, t:42, w:40, h:9}, size:2.6, weight:500, color:"#f4f6f8", align:"left"}); }
  newShape(kind) { const sl = this.slide(); if (!sl) return this.toast("Add a slide first"); const n = sl.elements.filter(e => e.type === kind).length + 1; const box = kind === "line" ? {l:20, t:50, w:60, h:.8} : {l:36, t:32, w:28, h:36}; this.addElement({type:kind, name:`${TYPE_LABEL[kind]} ${n}`, box, fill: kind === "line" ? "#f4f6f8" : sl.accent}); }
  newMedia(kind) { const sl = this.slide(); if (!sl) return this.toast("Add a slide first"); const label = {image:"image · drop a file", video:"video · drop a file", audio:"audio · drop a file"}[kind]; const extra = kind === "table" ? mkTable(["Column","Q2","Q3"], [["Row 1","—","—"],["Row 2","—","—"]]) : kind === "chart" ? mkChart() : {}; this.addElement({type:kind, name:`${TYPE_LABEL[kind]} ${sl.elements.filter(e => e.type === kind).length + 1}`, box:{...MEDIA_BOX[kind]}, mediaLabel:label, ...extra}); }
  // ---------- groups (nested: e.groups = [outermost, ..., innermost]) ----------
  gAt(e, d) { return e && e.groups ? e.groups[d] : undefined; }
  expandGroup(ids, depth = 0) { const sl = this.slide(); if (!sl) return ids; const gids = new Set(ids.map(id => this.gAt(sl.elements.find(x => x.id === id), depth)).filter(Boolean)); if (!gids.size) return ids; return [...new Set([...ids, ...sl.elements.filter(e => gids.has(this.gAt(e, depth))).map(e => e.id)])]; }
  groupInfo(sels) { const sl = this.slide(); if (!sl || !sels.length) return {isGroup:false, depth:0, name:""}; const d = this.state.groupDepth || 0; const els = sels.map(id => sl.elements.find(e => e.id === id)).filter(Boolean); const gid = this.gAt(els[0], d); if (!gid || !els.every(e => this.gAt(e, d) === gid)) return {isGroup:false, depth:d, name:""}; const all = sl.elements.filter(e => this.gAt(e, d) === gid); const isGroup = all.length === els.length; const names = (els[0].groups || []).slice(0, d + 1).map(g => (sl.groupNames || {})[g] || "Group"); return {isGroup, depth:d, gid, name: names.join(" › "), canDrill: isGroup && els.some(e => e.groups.length > d + 1)}; }
  groupSel() { const s = this.state, sl = this.slide(); if (!sl || s.sels.length < 2) return; const gid = uid(), names = {...(sl.groupNames || {})}; names[gid] = `Group ${Object.keys(names).length + 1}`; const set = new Set(s.sels); const hadAnim = sl.elements.some(e => set.has(e.id) && e.anim); this.updateSlide({elements: sl.elements.map(e => set.has(e.id) ? {...e, groups: [gid, ...(e.groups || [])], anim: undefined} : e), groupNames: names, animOrder: sl.animOrder.filter(id => !set.has(id))}); this.setState({groupDepth: 0}); this.toast(hadAnim ? `Grouped ${s.sels.length} elements · their animations were removed` : `Grouped ${s.sels.length} elements`); }
  ungroupSel() { const s = this.state, sl = this.slide(); if (!sl) return; const gi = this.groupInfo(s.sels); if (!gi.isGroup) return; const members = sl.elements.filter(e => this.gAt(e, gi.depth) === gi.gid); const ids = new Set(members.map(e => e.id)); const hadAnim = members.some(e => e.anim); this.updateSlide({elements: sl.elements.map(e => ids.has(e.id) ? {...e, groups: e.groups.filter((_, i) => i !== gi.depth), anim: undefined} : e), animOrder: sl.animOrder.filter(id => !ids.has(id))}); this.setState({groupDepth: 0}); this.toast(hadAnim ? "Ungrouped · the group animation was removed" : "Ungrouped"); }
  drillGroup(e) { const s = this.state, gi = this.groupInfo(s.sels); if (!gi.isGroup || !gi.canDrill) return false; const d = gi.depth + 1; const gid = this.gAt(e, d); const next = gid ? this.slide().elements.filter(x => this.gAt(x, d) === gid).map(x => x.id) : [e.id]; this.setState({sels: next, groupDepth: d}); return true; }
  // ---------- insert dialog ----------
  openInsert(kind) { if (!this.slide()) return this.toast("Add a slide first"); const base = {kind, file:null, url:"", caption:""}; const extra = kind === "table" ? {rows:3, cols:3, header:true, theme:"dark"} : kind === "chart" ? {chartType:"bar", series:1, cats:6, palette:"brand"} : kind === "text" ? {text:"", preset:"body", align:"left"} : kind === "animate" ? {effect:"fade", trigger: this.state.animTrigger || "click", duration:.6} : {}; this.setState({insertDlg: {...base, ...extra}, menu:null, ctxMenu:null}); }
  setInsert(p) { this.setState({insertDlg: {...this.state.insertDlg, ...p}}); }
  pickFile(file) { if (!file) return; const d = this.state.insertDlg; if (d.file && d.file.src) URL.revokeObjectURL(d.file.src); this.setInsert({file: {name: file.name, size: file.size, src: URL.createObjectURL(file)}, url: ""}); }
  confirmInsert() {
    const d = this.state.insertDlg, sl = this.slide(); if (!d || !sl) return;
    if (d.kind === "animate") { const ids = this.state.sels; if (!ids.length) return this.toast("Select an element first"); const set = new Set(ids); const gi = this.groupInfo(ids), gkey = gi.isGroup && ids.length > 1 ? gi.gid : null; const ordered = sl.elements.filter(e => set.has(e.id)).map(e => e.id); this.updateSlide({elements: sl.elements.map(e => set.has(e.id) ? {...e, anim: {effect: d.effect, trigger: gkey && e.id !== ordered[0] ? "with" : d.trigger, duration: d.duration, delay: 0, groupId: gkey || undefined}} : e), animOrder: [...sl.animOrder.filter(x => !set.has(x)), ...ordered]}); this.setState({side:"animate", animSub:"object", insertDlg:null, animTrigger: d.trigger}); return; }
    const n = sl.elements.filter(e => e.type === d.kind).length + 1, name = `${TYPE_LABEL[d.kind]} ${n}`;
    if (d.kind === "text") { const P = {title:{size:5.2, weight:700, color:"#f4f6f8", h:12, w:60}, subtitle:{size:2.8, weight:500, color:"#c9ced6", h:8, w:56}, body:{size:2.2, weight:400, color:"#e7e9ee", h:7, w:50}, caption:{size:1.6, weight:500, color:"#a9b0b8", h:5, w:40}}[d.preset]; const text = d.text.trim() || {title:"Title", subtitle:"Subtitle", body:"Body text", caption:"Caption"}[d.preset]; this.addElement({type:"text", name: `Text ${n}`, text, box:{l: d.align === "center" ? 50 - P.w/2 : d.align === "right" ? 92 - P.w : 8.4, t: 42, w: P.w, h: P.h}, size: P.size, weight: P.weight, color: P.color, align: d.align}); }
    else if (d.kind === "table") { const head = Array.from({length: d.cols}, (_, i) => `Column ${i + 1}`); const rows = Array.from({length: Math.max(1, d.rows - 1)}, (_, r) => head.map((_, c) => c === 0 ? `Row ${r + 1}` : "—")); this.addElement({type:"table", name, box:{...MEDIA_BOX.table}, ...mkTable(head, rows), header: d.header, theme: d.theme}); }
    else if (d.kind === "chart") { const cats = Array.from({length: d.cats}, (_, i) => `C${i + 1}`); const series = Array.from({length: d.series}, (_, i) => ({name: `Series ${i + 1}`, values: cats.map((_, j) => Math.round(30 + 60 * Math.abs(Math.sin(j * 1.3 + i)))) })); this.addElement({type:"chart", name, box:{...MEDIA_BOX.chart}, ...mkChart(), chartType: d.chartType, categories: cats, series, palette: d.palette}); }
    else { const label = d.file ? d.file.name : d.url ? d.url.replace(/^https?:\/\//, "").slice(0, 40) : `${d.kind} · placeholder`; this.addElement({type: d.kind, name, box:{...MEDIA_BOX[d.kind]}, mediaLabel: label, src: d.kind === "image" ? (d.file ? d.file.src : d.url || null) : null, caption: d.caption}); }
    this.setState({insertDlg:null});
  }
  // ---------- table ----------
  tsel() { const s = this.state, t = s.tsel; if (!t || !s.sels.includes(t.elId) || !this.el(t.elId)) return null; return {elId: t.elId, r0: Math.min(t.r0, t.r1), r1: Math.max(t.r0, t.r1), c0: Math.min(t.c0, t.c1), c1: Math.max(t.c0, t.c1)}; }
  setCells(el, cells, extra) { this.updateEls({[el.id]: {cells, ...(extra || {})}}); }
  cellRange(fn) { const t = this.tsel(); if (!t) return; const el = this.el(t.elId); const cells = el.cells.map((row, r) => row.map((c, ci) => (r >= t.r0 && r <= t.r1 && ci >= t.c0 && ci <= t.c1) ? fn(c, r, ci) : c)); this.setCells(el, cells); }
  cellStyle(patch) { this.cellRange(c => ({...c, ...patch})); }
  insertRow(at) { const t = this.tsel(); if (!t) return; const el = this.el(t.elId); const cells = [...el.cells]; cells.splice(at, 0, el.cols.map(() => CELL("—"))); this.setCells(el, cells); this.setState({tsel: {elId: el.id, r0: at, r1: at, c0: t.c0, c1: t.c0}, ctxMenu:null}); }
  deleteRows() { const t = this.tsel(); if (!t) return; const el = this.el(t.elId); if (el.cells.length - (t.r1 - t.r0 + 1) < 1) return this.toast("Keep at least one row"); this.setCells(el, el.cells.filter((_, r) => r < t.r0 || r > t.r1).map(row => row.map(c => ({...c, hidden: false, span: undefined})))); this.setState({tsel:null, ctxMenu:null}); }
  insertCol(at) { const t = this.tsel(); if (!t) return; const el = this.el(t.elId); const cells = el.cells.map(row => { const r = [...row]; r.splice(at, 0, CELL("—")); return r; }); const cols = [...el.cols]; cols.splice(at, 0, {w: 1}); this.setCells(el, cells, {cols}); this.setState({tsel: {elId: el.id, r0: t.r0, r1: t.r0, c0: at, c1: at}, ctxMenu:null}); }
  deleteCols() { const t = this.tsel(); if (!t) return; const el = this.el(t.elId); if (el.cols.length - (t.c1 - t.c0 + 1) < 1) return this.toast("Keep at least one column"); this.setCells(el, el.cells.map(row => row.filter((_, c) => c < t.c0 || c > t.c1).map(c => ({...c, hidden: false, span: undefined}))), {cols: el.cols.filter((_, c) => c < t.c0 || c > t.c1)}); this.setState({tsel:null, ctxMenu:null}); }
  mergeCells() { const t = this.tsel(); if (!t || (t.r0 === t.r1 && t.c0 === t.c1)) return; const el = this.el(t.elId); const texts = []; const cells = el.cells.map((row, r) => row.map((c, ci) => { const inR = r >= t.r0 && r <= t.r1 && ci >= t.c0 && ci <= t.c1; if (!inR) return c; if (c.t && c.t !== "—") texts.push(c.t); if (r === t.r0 && ci === t.c0) return c; return {...c, hidden: true, span: undefined}; })); cells[t.r0][t.c0] = {...cells[t.r0][t.c0], t: texts.join(" "), hidden: false, span: {r: t.r1 - t.r0 + 1, c: t.c1 - t.c0 + 1}}; this.setCells(el, cells); this.setState({tsel: {elId: el.id, r0: t.r0, r1: t.r0, c0: t.c0, c1: t.c0}, ctxMenu:null}); }
  unmergeCells() { const t = this.tsel(); if (!t) return; const el = this.el(t.elId), c = el.cells[t.r0][t.c0]; if (!c.span) return; const cells = el.cells.map((row, r) => row.map((x, ci) => (r >= t.r0 && r < t.r0 + c.span.r && ci >= t.c0 && ci < t.c0 + c.span.c) ? {...x, hidden: false, span: undefined} : x)); this.setCells(el, cells); this.setState({ctxMenu:null}); }
  startColResize(e, el, ci) {
    e.stopPropagation(); e.preventDefault();
    const rect = this.stageRef.current.getBoundingClientRect(), tableW = rect.width * el.box.w / 100, sum = el.cols.reduce((a, c) => a + c.w, 0), w0 = el.cols[ci].w, x0 = e.clientX, snap = this.snapshot();
    const onMove = (ev) => { const dw = (ev.clientX - x0) / tableW * sum; const cols = el.cols.map((c, i) => i === ci ? {w: Math.max(.25, Math.round((w0 + dw) * 100) / 100)} : c); this.updateEls({[el.id]: {cols}}, true); };
    const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); this.setState({past: [...this.state.past.slice(-49), snap], future: [], dirty:true}); };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  }
  // ---------- chart ----------
  chartSvg(el) {
    const W = 480, H = 300, pal = PALETTES[el.palette] || PALETTES.brand, type = el.chartType, cats = el.categories, n = cats.length;
    const series = el.series.map((se, i) => ({...se, color: se.color || pal[i % pal.length]}));
    const F = "font-family:'Plus Jakarta Sans','Noto Sans TC',sans-serif", muted = "#a9b0b8", ink = "#e7e9ee", grid = "rgba(255,255,255,.1)";
    const esc = (t) => String(t).replace(/&/g, "&amp;").replace(/</g, "&lt;");
    const legendB = el.legend === "bottom" ? 26 : 0, legendR = el.legend === "right" ? 118 : 0;
    const padL = el.yTitle ? 60 : 44, padB = (el.xTitle ? 42 : 26) + legendB, padT = 14, padR = 14 + legendR, pw = W - padL - padR, ph = H - padT - padB;
    let out = `<style>@keyframes cg-grow{from{transform:scaleY(0)}}@keyframes cg-growx{from{transform:scaleX(0)}}@keyframes cg-fade{from{opacity:0}}@keyframes cg-dash{to{stroke-dashoffset:0}}.cg-g{animation:cg-grow .7s cubic-bezier(.2,.8,.2,1) both}.cg-gx{animation:cg-growx .7s cubic-bezier(.2,.8,.2,1) both}.cg-f{animation:cg-fade .6s ease both}.cg-d{stroke-dasharray:2400;stroke-dashoffset:2400;animation:cg-dash 1.6s ease-out both}</style>`;
    const legendItems = (type === "pie" || type === "donut") ? cats.map((c, i) => ({label: c, color: pal[i % pal.length]})) : series.map(s => ({label: s.name, color: s.color}));
    const legend = () => { if (el.legend === "none") return ""; let g = ""; if (el.legend === "bottom") { let x = padL; legendItems.forEach(it => { g += `<rect x="${x}" y="${H - 16}" width="10" height="10" rx="2" fill="${it.color}"/><text x="${x + 14}" y="${H - 7.5}" font-size="10" fill="${muted}" style="${F}">${esc(it.label)}</text>`; x += 14 + it.label.length * 6.2 + 16; }); } else { legendItems.forEach((it, i) => { const y = padT + 6 + i * 18; g += `<rect x="${W - legendR + 8}" y="${y}" width="10" height="10" rx="2" fill="${it.color}"/><text x="${W - legendR + 22}" y="${y + 8.5}" font-size="10" fill="${muted}" style="${F}">${esc(it.label)}</text>`; }); } return g; };
    const titles = () => (el.xTitle ? `<text x="${padL + pw/2}" y="${H - legendB - 6}" font-size="10" font-weight="700" text-anchor="middle" fill="${muted}" style="${F};letter-spacing:.06em">${esc(el.xTitle.toUpperCase())}</text>` : "") + (el.yTitle ? `<text transform="translate(12 ${padT + ph/2}) rotate(-90)" font-size="10" font-weight="700" text-anchor="middle" fill="${muted}" style="${F};letter-spacing:.06em">${esc(el.yTitle.toUpperCase())}</text>` : "");
    if (type === "pie" || type === "donut") {
      const vals = series[0] ? series[0].values : [], total = vals.reduce((a, v) => a + (+v || 0), 0) || 1, cx = padL + pw/2, cy = padT + ph/2, r = Math.min(pw, ph) / 2 - 6, ri = type === "donut" ? r * .55 : 0; let a0 = -Math.PI/2;
      vals.forEach((v, i) => { const a1 = a0 + (+v || 0) / total * Math.PI * 2, large = a1 - a0 > Math.PI ? 1 : 0; const p = (a, rr) => `${(cx + rr * Math.cos(a)).toFixed(2)} ${(cy + rr * Math.sin(a)).toFixed(2)}`;
        const d = ri ? `M${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} L${p(a1, ri)} A${ri} ${ri} 0 ${large} 0 ${p(a0, ri)} Z` : `M${cx} ${cy} L${p(a0, r)} A${r} ${r} 0 ${large} 1 ${p(a1, r)} Z`;
        out += `<path d="${d}" fill="${pal[i % pal.length]}" stroke="#14161a" stroke-width="1.5" class="cg-f" style="animation-delay:${(i * .08).toFixed(2)}s"/>`;
        if (el.labels && (+v || 0) / total > .04) { const am = (a0 + a1) / 2, rm = ri ? (r + ri) / 2 : r * .65; out += `<text x="${(cx + rm * Math.cos(am)).toFixed(1)}" y="${(cy + rm * Math.sin(am) + 3.5).toFixed(1)}" font-size="10" font-weight="700" text-anchor="middle" fill="#fff" style="${F}">${Math.round((+v || 0) / total * 100)}%</text>`; }
        a0 = a1; });
      if (ri) out += `<text x="${cx}" y="${cy + 5}" font-size="14" font-weight="800" text-anchor="middle" fill="${ink}" style="${F}">${esc(total)}</text>`;
      return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="display:block">${out}${legend()}</svg>`;
    }
    const all = series.flatMap(s => s.values.map(v => +v || 0)), max = Math.max(1, ...all), min = Math.min(0, ...all), span = max - min || 1, ticks = 4;
    const horiz = type === "hbar";
    const X = (i) => padL + (i + .5) * (pw / n), Y = (v) => padT + ph - (v - min) / span * ph, XV = (v) => padL + (v - min) / span * pw, YC = (i) => padT + (i + .5) * (ph / n);
    for (let t = 0; t <= ticks; t++) { const v = min + span * t / ticks, lab = Math.abs(v) >= 1000 ? (v/1000).toFixed(1) + "k" : Math.round(v); if (horiz) { const x = XV(v); out += `${el.grid ? `<line x1="${x}" y1="${padT}" x2="${x}" y2="${padT + ph}" stroke="${grid}" stroke-dasharray="3 4"/>` : ""}<text x="${x}" y="${padT + ph + 14}" font-size="9.5" text-anchor="middle" fill="${muted}" style="${F}">${lab}</text>`; } else { const y = Y(v); out += `${el.grid ? `<line x1="${padL}" y1="${y}" x2="${padL + pw}" y2="${y}" stroke="${grid}" stroke-dasharray="3 4"/>` : ""}<text x="${padL - 8}" y="${y + 3.5}" font-size="9.5" text-anchor="end" fill="${muted}" style="${F}">${lab}</text>`; } }
    out += horiz ? `<line x1="${padL}" y1="${padT}" x2="${padL}" y2="${padT + ph}" stroke="rgba(255,255,255,.25)"/>` : `<line x1="${padL}" y1="${Y(0)}" x2="${padL + pw}" y2="${Y(0)}" stroke="rgba(255,255,255,.25)"/>`;
    cats.forEach((c, i) => { out += horiz ? `<text x="${padL - 8}" y="${YC(i) + 3.5}" font-size="10" text-anchor="end" fill="${muted}" style="${F}">${esc(c)}</text>` : `<text x="${X(i)}" y="${padT + ph + 14}" font-size="10" text-anchor="middle" fill="${muted}" style="${F}">${esc(c)}</text>`; });
    if (type === "bar" || horiz) { const gw = (horiz ? ph : pw) / n, bw = gw * .68 / series.length; series.forEach((s, si) => cats.forEach((_, i) => { const v = +s.values[i] || 0; if (horiz) { const y = YC(i) - gw * .34 + si * bw, x0 = XV(Math.min(0, v)), w = Math.abs(XV(v) - XV(0)); out += `<rect x="${x0.toFixed(1)}" y="${y.toFixed(1)}" width="${w.toFixed(1)}" height="${(bw - 2).toFixed(1)}" rx="2" fill="${s.color}" class="cg-gx" style="transform-origin:${XV(0)}px 0;animation-delay:${(i * .06).toFixed(2)}s"/>`; if (el.labels) out += `<text x="${(XV(v) + 5).toFixed(1)}" y="${(y + bw/2 + 2.5).toFixed(1)}" font-size="9.5" font-weight="700" fill="${ink}" style="${F}">${esc(s.values[i])}</text>`; } else { const x = X(i) - gw * .34 + si * bw, y0 = Y(Math.max(0, v)), h = Math.abs(Y(v) - Y(0)); out += `<rect x="${x.toFixed(1)}" y="${y0.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${h.toFixed(1)}" rx="2" fill="${s.color}" class="cg-g" style="transform-origin:0 ${Y(0)}px;animation-delay:${(i * .06).toFixed(2)}s"/>`; if (el.labels) out += `<text x="${(x + (bw - 2)/2).toFixed(1)}" y="${(y0 - 5).toFixed(1)}" font-size="9.5" font-weight="700" text-anchor="middle" fill="${ink}" style="${F}">${esc(s.values[i])}</text>`; } })); }
    else { series.forEach((s, si) => { const pts = cats.map((_, i) => [X(i), Y(+s.values[i] || 0)]); const line = pts.map(p => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" "); if (type === "area") out += `<polygon points="${padL + pw/n*.5},${Y(0)} ${line} ${X(n-1)},${Y(0)}" fill="${s.color}" fill-opacity=".22" class="cg-f"/>`; out += `<polyline points="${line}" fill="none" stroke="${s.color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round" class="cg-d" style="animation-delay:${(si * .15).toFixed(2)}s"/>`; pts.forEach((p, i) => { out += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="3.5" fill="#14161a" stroke="${s.color}" stroke-width="2" class="cg-f" style="animation-delay:${(.3 + i * .1).toFixed(2)}s"/>`; if (el.labels) out += `<text x="${p[0].toFixed(1)}" y="${(p[1] - 9).toFixed(1)}" font-size="9.5" font-weight="700" text-anchor="middle" fill="${ink}" style="${F}">${esc(s.values[i])}</text>`; }); }); }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="100%" height="100%" preserveAspectRatio="xMidYMid meet" style="display:block">${out}${titles()}${legend()}</svg>`;
  }
  chartNode(el) { const key = JSON.stringify([el.chartType, el.categories, el.series, el.palette, el.legend, el.grid, el.labels, el.xTitle, el.yTitle]); this._chartCache = this._chartCache || {}; const c = this._chartCache[el.id]; if (c && c.key === key) return c.node; const node = this.React.createElement("div", {style:{width:"100%", height:"100%"}, dangerouslySetInnerHTML:{__html: this.chartSvg(el)}}); this._chartCache[el.id] = {key, node}; return node; }
  chartSet(id, patch, live) { this.updateEls({[id]: patch}, live); }
  chartFocus() { this._chartSnap = this.snapshot(); }
  chartBlur() { if (this._chartSnap && this._chartSnap.slides !== this.state.slides) this.setState({past: [...this.state.past.slice(-49), this._chartSnap], future: [], dirty:true}); this._chartSnap = null; }
  copySvg(el) { const svg = this.chartSvg(el); (navigator.clipboard ? navigator.clipboard.writeText(svg) : Promise.reject()).then(() => this.toast("SVG copied — self-contained, with animation"), () => this.toast("Copy failed")); }
  startWinDrag(e) { e.preventDefault(); const well = this.wellRef.current.getBoundingClientRect(), p = this.state.chartWinPos || {x: well.width - 436, y: 16}, x0 = e.clientX, y0 = e.clientY; const onMove = (ev) => this.setState({chartWinPos: {x: Math.max(0, Math.min(p.x + ev.clientX - x0, well.width - 60)), y: Math.max(0, Math.min(p.y + ev.clientY - y0, well.height - 40))}}); const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); }; window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp); }
  removeElements(ids) { const sl = this.slide(); if (!sl || !ids.length) return; this.updateSlide({elements: sl.elements.filter(e => !ids.includes(e.id)), animOrder: sl.animOrder.filter(id => !ids.includes(id))}); this.setState({sels:[], ctxMenu:null, comments: this.state.comments.filter(c => !ids.includes(c.target))}); }
  duplicateElements(ids) { const sl = this.slide(); const copies = sl.elements.filter(e => ids.includes(e.id)).map(e => ({...e, id: uid(), name: e.name + " copy", box:{...e.box, l: Math.min(e.box.l + 3, 100 - e.box.w), t: Math.min(e.box.t + 4, 100 - e.box.h)}, anim: undefined})); this.updateSlide({elements: [...sl.elements, ...copies]}); this.setState({sels: copies.map(c => c.id), ctxMenu:null}); }
  reorder(ids, how) {
    const sl = this.slide(); if (!sl || !ids.length) return; const els = [...sl.elements], set = new Set(ids);
    if (how === "front") this.updateSlide({elements: [...els.filter(e => !set.has(e.id)), ...els.filter(e => set.has(e.id))]});
    else if (how === "back") this.updateSlide({elements: [...els.filter(e => set.has(e.id)), ...els.filter(e => !set.has(e.id))]});
    else { const dir = how === "forward" ? 1 : -1; const idxs = els.map((e, i) => set.has(e.id) ? i : -1).filter(i => i >= 0); (dir > 0 ? idxs.reverse() : idxs).forEach(i => { const j = i + dir; if (j >= 0 && j < els.length && !set.has(els[j].id)) [els[i], els[j]] = [els[j], els[i]]; }); this.updateSlide({elements: els}); }
    this.setState({ctxMenu:null, menu:null});
  }
  arrange(op) {
    const s = this.state, sl = this.slide(), ids = s.sels; if (!sl || !ids.length) return this.toast("Select elements to arrange");
    const els = ids.map(id => this.el(id)).filter(Boolean), bb = ids.length > 1 ? this.bbox(els.map(e => e.box)) : {l:0, t:0, w:100, h:100};
    const m = {}, r = v => Math.round(v * 10) / 10;
    if (op.startsWith("dist")) {
      if (els.length < 3) return this.toast("Select 3+ elements to distribute");
      const horiz = op === "distH", sorted = [...els].sort((a, b) => horiz ? a.box.l - b.box.l : a.box.t - b.box.t);
      const total = horiz ? bb.w : bb.h, used = sorted.reduce((a, e) => a + (horiz ? e.box.w : e.box.h), 0), gap = (total - used) / (sorted.length - 1);
      let pos = horiz ? bb.l : bb.t; sorted.forEach(e => { m[e.id] = {box: {...e.box, [horiz ? "l" : "t"]: r(pos)}}; pos += (horiz ? e.box.w : e.box.h) + gap; });
    } else els.forEach(e => { const b = e.box, nb = {...b};
      if (op === "alignL") nb.l = bb.l; if (op === "alignC") nb.l = r(bb.l + bb.w/2 - b.w/2); if (op === "alignR") nb.l = r(bb.l + bb.w - b.w);
      if (op === "alignT") nb.t = bb.t; if (op === "alignM") nb.t = r(bb.t + bb.h/2 - b.h/2); if (op === "alignB") nb.t = r(bb.t + bb.h - b.h);
      m[e.id] = {box: nb}; });
    this.updateEls(m); this.setState({menu:null, ctxMenu:null});
  }
  // animation
  animBlocks(sl) { const out = []; sl.animOrder.forEach(id => { const e = sl.elements.find(x => x.id === id); if (!e || !e.anim) return; const g = e.anim.groupId; const last = out[out.length - 1]; if (g && last && last.gid === g) last.ids.push(id); else out.push({ids:[id], gid: g || null, lead: e}); }); return out; }
  setAnimIds(ids, patch) { const sl = this.slide(), set = new Set(ids); this.updateSlide({elements: sl.elements.map(e => set.has(e.id) ? {...e, anim: {...e.anim, ...patch}} : e)}); }
  removeAnimIds(ids) { const sl = this.slide(), set = new Set(ids); this.updateSlide({elements: sl.elements.map(e => set.has(e.id) ? {...e, anim: undefined} : e), animOrder: sl.animOrder.filter(x => !set.has(x))}); }
  moveAnimBlock(i, dir) { const sl = this.slide(), blocks = this.animBlocks(sl), j = i + dir; if (i < 0 || j < 0 || j >= blocks.length) return; [blocks[i], blocks[j]] = [blocks[j], blocks[i]]; this.updateSlide({animOrder: blocks.flatMap(b => b.ids)}); }
  addAnim(id, effect) { const sl = this.slide(); if (!sl || !this.el(id)) return; this.updateSlide({elements: sl.elements.map(e => e.id === id ? {...e, anim: {effect: effect || "fade", trigger:"click", duration:.6, delay:0}} : e), animOrder: [...sl.animOrder.filter(x => x !== id), id]}); this.setState({side:"animate", menu:null}); }
  addAnimMany(ids, effect, trigger) { const sl = this.slide(); if (!sl) return; const set = new Set(ids); this.updateSlide({elements: sl.elements.map(e => set.has(e.id) ? {...e, anim: {effect, trigger: trigger || "click", duration:.6, delay:0}} : e), animOrder: [...sl.animOrder.filter(x => !set.has(x)), ...ids]}); this.setState({side:"animate", menu:null}); this.toast(`${(EFFECTS.find(x => x[0] === effect) || [])[1]} · ${(TRIGGERS.find(x => x[0] === (trigger || "click")) || [])[1]}`); }
  setAnim(id, patch) { const sl = this.slide(); this.updateSlide({elements: sl.elements.map(e => e.id === id ? {...e, anim: {...e.anim, ...patch}} : e)}); }
  removeAnim(id) { const sl = this.slide(); this.updateSlide({elements: sl.elements.map(e => e.id === id ? {...e, anim: undefined} : e), animOrder: sl.animOrder.filter(x => x !== id)}); }
  moveAnim(id, dir) { const sl = this.slide(), o = [...sl.animOrder], i = o.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= o.length) return; [o[i], o[j]] = [o[j], o[i]]; this.updateSlide({animOrder: o}); }
  previewAll() {
    const sl = this.slide(), st = this.steps(sl); if (!st.length) return; this.clearTimers();
    this.setState({preview: {step: 0}, previewOne:null, sels:[]});
    let t = 250;
    st.forEach((g, i) => { this._timers.push(setTimeout(() => this.setState({preview: {step: i + 1}}), t)); t += Math.max(...g.map(id => { const a = this.el(id).anim; return (a.duration + a.delay) * 1000; })) + 350; });
    this._timers.push(setTimeout(() => this.setState({preview: null}), t + 400));
  }
  previewOne(id) { const e = this.el(id), a = e && e.anim; if (!a) return; this.clearTimers(); const ids = a.groupId ? this.slide().elements.filter(x => x.anim && x.anim.groupId === a.groupId).map(x => x.id) : [id]; this.setState({previewOne: ids, preview:null}); this._timers.push(setTimeout(() => this.setState({previewOne: null}), (a.duration + a.delay) * 1000 + 100)); }
  animStates(sl) {
    const s = this.state, out = {}; if (!sl) return out;
    const revealed = s.mode === "play" ? s.playStep : s.preview ? s.preview.step : null;
    this.steps(sl).forEach((g, gi) => { let acc = 0; g.forEach(id => { const e = this.el(id); if (!e) return; const a = e.anim;
      const delay = a.delay + (a.trigger === "after" ? acc : 0); acc = a.trigger === "after" ? delay + a.duration : Math.max(acc, a.delay + a.duration);
      const css = `cm-a-${a.effect} ${a.duration}s ${delay}s cubic-bezier(.2,.8,.2,1) both`;
      if (revealed !== null) out[id] = gi < revealed ? {vis:"visible", css: gi === revealed - 1 ? css : "none"} : {vis:"hidden", css:"none"};
      else out[id] = {vis:"visible", css: (Array.isArray(s.previewOne) ? s.previewOne.includes(id) : s.previewOne === id) ? `cm-a-${a.effect} ${a.duration}s ${a.delay}s cubic-bezier(.2,.8,.2,1) both` : "none"}; }); });
    return out;
  }
  // boxes / drag
  boxCss(b) { return {left: b.l + "cqw", top: b.t + "cqh", width: b.w + "cqw", height: b.h + "cqh"}; }
  bbox(boxes) { const l = Math.min(...boxes.map(b => b.l)), t = Math.min(...boxes.map(b => b.t)); return {l, t, w: Math.max(...boxes.map(b => b.l + b.w)) - l, h: Math.max(...boxes.map(b => b.t + b.h)) - t}; }
  snap(bb, others) {
    const TH = 1.4, xs = [0, 50, 100], ys = [0, 50, 100];
    others.forEach(o => { xs.push(o.l, o.l + o.w/2, o.l + o.w); ys.push(o.t, o.t + o.h/2, o.t + o.h); });
    let dx = null, gx = null, dy = null, gy = null;
    for (const e of [bb.l, bb.l + bb.w/2, bb.l + bb.w]) for (const x of xs) { const d = x - e; if (Math.abs(d) < TH && (dx === null || Math.abs(d) < Math.abs(dx))) { dx = d; gx = x; } }
    for (const e of [bb.t, bb.t + bb.h/2, bb.t + bb.h]) for (const y of ys) { const d = y - e; if (Math.abs(d) < TH && (dy === null || Math.abs(d) < Math.abs(dy))) { dy = d; gy = y; } }
    const guides = [];
    if (gx !== null) guides.push({left: gx + "cqw", top: "0", width: "1px", height: "100%"});
    if (gy !== null) guides.push({left: "0", top: gy + "cqh", width: "100%", height: "1px"});
    return {dx: dx || 0, dy: dy || 0, guides};
  }
  startDrag(e, mode) {
    if (this.state.hand || this.state.space) return this.wellDown(e);
    e.stopPropagation(); e.preventDefault();
    const s = this.state, sl = this.slide(); if (!sl || !s.sels.length) return;
    const rect = this.stageRef.current.getBoundingClientRect();
    const start = {}; s.sels.forEach(id => { const el = this.el(id); if (el) start[id] = {...el.box}; });
    this._drag = {mode, x0: e.clientX, y0: e.clientY, start, rect, snap: this.snapshot(), moved:false};
    this._onMove = (ev) => {
      const d = this._drag, dx0 = (ev.clientX - d.x0) / d.rect.width * 100, dy0 = (ev.clientY - d.y0) / d.rect.height * 100;
      if (Math.abs(dx0) + Math.abs(dy0) < .3 && !d.moved) return;
      d.moved = true;
      const r = v => Math.round(v * 10) / 10, out = {}; let guides = [];
      if (d.mode === "move") {
        const bb = this.bbox(Object.values(d.start));
        let dx = Math.max(-bb.l, Math.min(dx0, 100 - bb.w - bb.l)), dy = Math.max(-bb.t, Math.min(dy0, 100 - bb.h - bb.t));
        const others = this.slide().elements.filter(el => !d.start[el.id]).map(el => el.box);
        const sn = ev.altKey ? {dx:0, dy:0, guides:[]} : this.snap({l: bb.l + dx, t: bb.t + dy, w: bb.w, h: bb.h}, others);
        dx += sn.dx; dy += sn.dy; guides = sn.guides;
        for (const id in d.start) { const b = d.start[id]; out[id] = {box: {l: r(b.l + dx), t: r(b.t + dy), w: b.w, h: b.h}}; }
      } else {
        const id = Object.keys(d.start)[0]; let {l, t, w, h} = d.start[id];
        if (d.mode.includes("e")) w = Math.max(3, w + dx0);
        if (d.mode.includes("s")) h = Math.max(.6, h + dy0);
        if (d.mode.includes("w")) { const nw = Math.max(3, w - dx0); l += w - nw; w = nw; }
        if (d.mode.includes("n")) { const nh = Math.max(.6, h - dy0); t += h - nh; h = nh; }
        l = Math.max(0, Math.min(l, 100 - w)); t = Math.max(0, Math.min(t, 100 - h));
        out[id] = {box: {l: r(l), t: r(t), w: r(w), h: r(h)}};
      }
      this.updateEls(out, true); this.setState({guides, composer:false});
    };
    this._onUp = () => {
      window.removeEventListener("mousemove", this._onMove); window.removeEventListener("mouseup", this._onUp);
      const d = this._drag; this._drag = null;
      if (d && d.moved) this.setState({past: [...this.state.past.slice(-49), d.snap], future: [], guides: [], dirty:true}); else this.setState({guides: []});
    };
    window.addEventListener("mousemove", this._onMove); window.addEventListener("mouseup", this._onUp);
  }
  stageDown(e) {
    if (this.state.hand || this.state.space) return this.wellDown(e);
    e.stopPropagation();
    if (e.button !== 0 || (e.target.closest && e.target.closest("[data-el]"))) return;
    const rect = this.stageRef.current.getBoundingClientRect();
    const px = (ev) => ({x: (ev.clientX - rect.left) / rect.width * 100, y: (ev.clientY - rect.top) / rect.height * 100});
    const p0 = px(e); this._mq = {p0, moved:false};
    this.setState({menu:null, exportOpen:false, ctxMenu:null, composer:false, editingId:null});
    const onMove = (ev) => { const p = px(ev); if (Math.abs(p.x - p0.x) + Math.abs(p.y - p0.y) > .6) this._mq.moved = true; if (this._mq.moved) this.setState({marquee: {l: Math.min(p0.x, p.x), t: Math.min(p0.y, p.y), w: Math.abs(p.x - p0.x), h: Math.abs(p.y - p0.y)}}); };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp);
      const sl = this.slide(), m = this.state.marquee;
      if (this._mq.moved && m && sl) this.setState({sels: sl.elements.filter(el => { const b = el.box; return b.l < m.l + m.w && b.l + b.w > m.l && b.t < m.t + m.h && b.t + b.h > m.t; }).map(el => el.id), marquee:null, editing:null});
      else this.setState({sels: [], marquee:null, editing:null, cellEdit:null, tsel:null});
      this._mq = null;
    };
    window.addEventListener("mousemove", onMove); window.addEventListener("mouseup", onUp);
  }
  startEdit(id) { const el = this.el(id); if (!el || el.type !== "text") return; this.setState({editing: id, editDraft: el.text, sels: [id], composer:false, ctxMenu:null}); }
  commitEdit() { const s = this.state; if (!s.editing) return; const el = this.el(s.editing); const text = s.editDraft.trim(); if (el && text && text !== el.text) this.updateEls({[s.editing]: {text}}); this.setState({editing:null, editDraft:""}); }
  commitCell() { const s = this.state, ce = s.cellEdit; if (!ce) return; const el = this.el(ce.elId); if (el && el.cells[ce.r] && el.cells[ce.r][ce.c] && el.cells[ce.r][ce.c].t !== s.cellDraft) { const cells = el.cells.map(r => r.map(c => ({...c}))); cells[ce.r][ce.c].t = s.cellDraft; this.setCells(el, cells); } this.setState({cellEdit:null, cellDraft:""}); }
  onKey(e) {
    const t = e.target, tag = t && t.tagName; if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || (t && t.isContentEditable)) return;
    const s = this.state, meta = e.metaKey || e.ctrlKey, k = e.key;
    if ((k === " " || e.code === "Space") && s.mode !== "play") { e.preventDefault(); if (!s.space) this.setState({space:true, sels:[], composer:false, ctxMenu:null}); return; }
    if (meta && (k === "=" || k === "+")) { e.preventDefault(); return this.zoomIn(); }
    if (meta && k === "-") { e.preventDefault(); return this.zoomOut(); }
    if (meta && k === "0") { e.preventDefault(); return this.zoomFit(); }
    if (k === "Escape") { if (s.mode === "play") return this.setState({mode:"view", fs:false, playStep:0}); if (s.insertDlg) return this.setState({insertDlg:null}); if (s.chartWin) return this.setState({chartWin:null}); if (this.tsel()) return this.setState({tsel:null, ctxMenu:null}); return this.setState({ctxMenu:null, menu:null, exportOpen:false, composer:false, editingId:null, sels:[], dialog:false, outlineModal:false}); }
    if ((k === "Delete" || k === "Backspace") && this.tsel()) { e.preventDefault(); return this.cellStyle({t: ""}); }
    if (meta && k.toLowerCase() === "b" && this.tsel()) { e.preventDefault(); const t = this.tsel(), c = this.el(t.elId).cells[t.r0][t.c0]; return this.cellStyle({b: !c.b}); }
    if (meta && k.toLowerCase() === "z") { e.preventDefault(); return e.shiftKey ? this.redo() : this.undo(); }
    if (meta && k.toLowerCase() === "d") { e.preventDefault(); return s.sels.length ? this.duplicateElements(s.sels) : this.duplicateSlide(s.cur); }
    if (meta && k.toLowerCase() === "s") { e.preventDefault(); return this.saveNow(); }
    if (meta && k.toLowerCase() === "a" && s.mode !== "play") { e.preventDefault(); const sl = this.slide(); return sl && this.setState({sels: sl.elements.map(x => x.id)}); }
    if (meta && e.shiftKey && k === "]") { e.preventDefault(); return this.reorder(s.sels, "front"); }
    if (meta && e.shiftKey && k === "[") { e.preventDefault(); return this.reorder(s.sels, "back"); }
    if (meta && k === "]") { e.preventDefault(); return this.reorder(s.sels, "forward"); }
    if (meta && k === "[") { e.preventDefault(); return this.reorder(s.sels, "backward"); }
    if (k === "ArrowLeft" || k === "PageUp") { e.preventDefault(); return this.prev(); }
    if (k === "ArrowRight" || k === "PageDown" || (k === " " && s.mode === "play")) { e.preventDefault(); return this.next(); }
    if ((k === "Delete" || k === "Backspace") && s.mode !== "play" && s.slides.length) { e.preventDefault(); return s.sels.length ? this.removeElements(s.sels) : this.deleteSlide(s.cur); }
    if (k === "Enter" && s.sels.length === 1 && s.mode !== "play") { e.preventDefault(); return this.startEdit(s.sels[0]); }
  }
  saveNow() { this.setState({dirty:false}); this.toast("Saved"); }
  placeComposer() {
    const well = this.wellRef.current, stage = this.stageRef.current; if (!well || !stage) return;
    const W = well.getBoundingClientRect(), S = stage.getBoundingClientRect(), sel = this.selRef.current, GAP = 24, patch = {};
    const place = (box) => {
      const B = box.getBoundingClientRect(); let left, top;
      if (sel) { const R = sel.getBoundingClientRect(); left = R.left - W.left + (R.width - B.width) / 2; const below = R.bottom - W.top + GAP; top = (below + B.height <= W.height - 76) ? below : Math.max(8, R.top - W.top - GAP - B.height); }
      else { left = S.left - W.left + (S.width - B.width) / 2; top = S.top - W.top + 16; }
      top = Math.min(top, W.height - 76 - B.height);
      left = Math.max(8, Math.min(left, W.width - B.width - 8));
      return {left: Math.round(left) + "px", top: Math.round(top) + "px"};
    };
    const same = (a, b) => a.left === b.left && a.top === b.top;
    if (this.state.composer && this.composerRef.current) { const p = place(this.composerRef.current); if (!same(p, this.state.composerPos)) patch.composerPos = p; }
    if (this.ctxRef.current) { const p = place(this.ctxRef.current); if (!same(p, this.state.ctxPos)) patch.ctxPos = p; }
    if (Object.keys(patch).length) this.setState(patch);
  }
  chart() {
    const R = this.React, bars = [38, 52, 61, 70, 84, 96];
    return R.createElement("svg", {viewBox:"0 0 240 200", width:"100%", height:"100%", preserveAspectRatio:"none", style:{display:"block", overflow:"visible"}},
      R.createElement("style", null, "@keyframes cm-grow{from{transform:scaleY(.15)}to{transform:scaleY(1)}}@keyframes cm-dash{to{stroke-dashoffset:0}}"),
      R.createElement("text", {x:0, y:12, fontSize:9, fontWeight:700, fill:"#a9b0b8", letterSpacing:".06em"}, "TTFB · ms → weeks"),
      [40, 80, 120, 160].map(y => R.createElement("line", {key:y, x1:0, y1:y, x2:240, y2:y, stroke:"rgba(255,255,255,.08)", strokeDasharray:"3 4"})),
      R.createElement("line", {x1:0, y1:176, x2:240, y2:176, stroke:"rgba(255,255,255,.25)"}),
      bars.map((v, i) => R.createElement("rect", {key:i, x:12 + i*38, y:176 - v*1.5, width:22, height:v*1.5, rx:3, fill: i === bars.length-1 ? "#C8233B" : "#5B6DEA", style:{transformOrigin:`${23 + i*38}px 176px`, animation:`cm-grow 1.6s ${i*.12}s cubic-bezier(.2,.8,.2,1) infinite alternate`}})),
      R.createElement("polyline", {points: bars.map((v,i) => `${23 + i*38},${176 - v*1.5 - 12}`).join(" "), fill:"none", stroke:"#f4f6f8", strokeWidth:2, strokeLinejoin:"round", strokeDasharray:400, strokeDashoffset:400, style:{animation:"cm-dash 2.4s .3s ease-out infinite"}}),
      bars.map((v, i) => R.createElement("text", {key:"l"+i, x:23 + i*38, y:192, fontSize:8, fill:"#a9b0b8", textAnchor:"middle"}, "W" + (i+1))));
  }
  waves() {
    const R = this.React, hs = [30,55,80,45,95,60,35,70,90,50,40,75,65,30,85,55,45,95,60,35,70,50,80,40,60,90,35,55,75,45], W = 300, H = 60, bw = W / hs.length;
    return R.createElement("svg", {viewBox:`0 0 ${W} ${H}`, width:"100%", height:"100%", preserveAspectRatio:"none", style:{display:"block"}},
      R.createElement("style", null, "@keyframes cm-wave{0%,100%{transform:scaleY(.4)}50%{transform:scaleY(1)}}"),
      hs.map((h, i) => { const bh = H * h / 100; return R.createElement("rect", {key:i, x: i*bw + bw*.2, y: (H - bh)/2, width: bw*.6, height: bh, rx: bw*.3, fill: i < 11 ? "#C8233B" : "rgba(255,255,255,.35)", style:{transformOrigin:`${i*bw + bw/2}px ${H/2}px`, animation:`cm-wave ${1.2 + (i%5)*.25}s ${i*.07}s ease-in-out infinite`}}); }));
  }
  toast(text) { this.setState({notice:text}); clearTimeout(this._nt); this._nt = setTimeout(() => this.setState({notice:false}), 2500); }
  addComment() {
    const s = this.state, text = s.commentDraft.trim(), sl = this.slide(), target = s.sels.length === 1 ? s.sels[0] : "page";
    if (!text || !sl) return;
    if (s.editingId) return this.setState({comments: s.comments.map(c => c.id === s.editingId ? {...c, text} : c), composer:false, commentDraft:"", editingId:null});
    this.setState({comments: [...s.comments, {id: s.nextId, slideId: sl.id, target, text}], nextId: s.nextId + 1, composer:false, commentDraft:""});
  }
  sorted() { const s = this.state, idx = id => s.slides.findIndex(sl => sl.id === id); return s.comments.filter(c => idx(c.slideId) >= 0).map(c => { const sl = s.slides[idx(c.slideId)], el = sl.elements.find(e => e.id === c.target); return {...c, slide: idx(c.slideId), el, pos: c.target === "page" ? -1 : el ? el.box.t * 1000 + el.box.l : 99999}; }).filter(c => c.target === "page" || c.el).sort((a, b) => a.slide - b.slide || a.pos - b.pos || a.id - b.id); }
  generate() {
    const s = this.state, lines = s.outline.split("\n").filter(l => l.trim()); if (!lines.length || s.generating) return;
    const drafts = []; lines.forEach(raw => { const indented = /^\s/.test(raw) || /^[-•*]/.test(raw.trim()); const text = raw.trim().replace(/^[-•*]\s*/, ""); if (indented && drafts.length) { const last = drafts[drafts.length-1]; last.sub = last.sub ? last.sub + " · " + text : text; } else drafts.push({title: text, sub: ""}); });
    const slides = drafts.map((d, i) => mk({title: d.title, sub: d.sub, bg: i % 3 === 2 ? "#1b1d24" : "#14161a", accent: ["#c41e3a","#4a8f45","#5b6dea","#e08a2e"][i % 4]}));
    const cmd = {role:"command", state:"in_progress", target:"deck", command:`deck draft --from outline.md --slides ${slides.length}`};
    this.setState({generating:true, messages: [...s.messages, {role:"author", text:`Draft slides from this outline:\n${lines.slice(0,3).map(l=>l.trim()).join(" / ")}${lines.length > 3 ? " …" : ""}`}, cmd]});
    this._timers.push(setTimeout(() => { const st = this.state, m = st.messages.map(x => x === cmd ? {...x, state:"completed"} : x); const at = st.slides.length ? st.cur + 1 : 0; const all = [...st.slides]; all.splice(at, 0, ...slides);
      this.commit({slides: all, cur: at, generating:false, outline:"", outlineModal:false, sels:[], messages: [...m, {role:"agent", text:`Drafted ${slides.length} slide${slides.length === 1 ? "" : "s"} from your outline. Pick any slide and tell me what to tighten.`}]}); }, 1400));
  }
  ctxItems() {
    const s = this.state, m = s.ctxMenu; if (!m) return [];
    const item = (label, icon, run, key, color, sep) => ({label, svg:{__html: ICONS[icon]}, run: () => { this.setState({ctxMenu:null}); run(); }, key, hasKey: !!key, color: color || "#1F1A1A", sep: !!sep});
    if (m.kind === "cell") {
      const t = this.tsel(); if (!t) return []; const el = this.el(t.elId), c = el.cells[t.r0][t.c0], multi = t.r0 !== t.r1 || t.c0 !== t.c1;
      return [
        item("Edit cell", "edit", () => this.setState({cellEdit: {elId: el.id, r: t.r0, c: t.c0}, cellDraft: c.t}), "↵"),
        item(c.b ? "Unbold" : "Bold", "textbox", () => this.cellStyle({b: !c.b}), "⌘B"),
        item("Insert row above", "up", () => this.insertRow(t.r0), null, null, true),
        item("Insert row below", "down", () => this.insertRow(t.r1 + 1)),
        item("Insert column left", "alignL", () => this.insertCol(t.c0)),
        item("Insert column right", "alignR", () => this.insertCol(t.c1 + 1)),
        ...(multi ? [item("Merge cells", "arrange", () => this.mergeCells(), null, null, true)] : c.span ? [item("Unmerge", "arrange", () => this.unmergeCells(), null, null, true)] : []),
        item(t.r0 === t.r1 ? "Delete row" : `Delete ${t.r1 - t.r0 + 1} rows`, "trash", () => this.deleteRows(), null, "#A81C31", true),
        item(t.c0 === t.c1 ? "Delete column" : `Delete ${t.c1 - t.c0 + 1} columns`, "trash", () => this.deleteCols(), null, "#A81C31"),
      ];
    }
    if (m.kind === "element") {
      const ids = m.ids, first = this.el(ids[0]), sl = this.slide(), isText = first && first.type === "text" && ids.length === 1;
      return [
        ...(isText ? [item("Edit text", "edit", () => this.startEdit(ids[0]), "↵")] : []),
        item(first && first.type === "chart" ? "Edit chart data" : first && first.type === "table" ? "Table style" : "Style", first && first.type === "chart" ? "table" : "edit", () => first && first.type === "chart" ? this.setState({chartWin: first.id, sels: ids}) : this.setState({side:"style", sels: ids})),
        item(first && first.anim ? "Edit animation" : "Add animation", "spark", () => first && first.anim ? this.setState({side:"animate", sels:ids}) : this.addAnim(ids[0])),
        item("Comment to agent", "comment", () => { const ex = s.comments.find(x => x.slideId === sl.id && x.target === ids[0]); this.setState({sels: ids, composer:true, commentDraft: ex ? ex.text : "", editingId: ex ? ex.id : null}); }),
        item("Bring to front", "front", () => this.reorder(ids, "front"), "⌘⇧]", null, true),
        item("Bring forward", "forward", () => this.reorder(ids, "forward"), "⌘]"),
        item("Send backward", "backward", () => this.reorder(ids, "backward"), "⌘["),
        item("Send to back", "back", () => this.reorder(ids, "back"), "⌘⇧["),
        item("Duplicate", "dup", () => this.duplicateElements(ids), "⌘D", null, true),
        item(ids.length > 1 ? `Delete ${ids.length} elements` : "Delete", "trash", () => this.removeElements(ids), "⌫", "#A81C31"),
      ];
    }
    const i = m.idx;
    return [
      item("New slide below", "plus", () => this.addSlide(i + 1)),
      item("New slides from outline…", "spark", () => this.setState({cur:i, outlineModal:true})),
      item("Duplicate slide", "dup", () => this.duplicateSlide(i), "⌘D"),
      item("Comment to agent", "comment", () => { const sl = s.slides[i], ex = s.comments.find(x => x.slideId === sl.id && x.target === "page"); this.setState({cur:i, sels:[], composer:true, commentDraft: ex ? ex.text : "", editingId: ex ? ex.id : null, view:"normal"}); }, null, null, true),
      item("Move up", "up", () => this.moveSlide(i, i - 1), null, null, true),
      item("Move down", "down", () => this.moveSlide(i, i + 2)),
      item("Delete slide", "trash", () => this.deleteSlide(i), "⌫", "#A81C31", true),
    ];
  }
  openCtx(e, menu) { e.preventDefault(); e.stopPropagation(); const W = window.innerWidth, H = window.innerHeight; this.setState({ctxMenu: {...menu, left: Math.min(e.clientX, W - 240) + "px", top: Math.min(e.clientY, H - 340) + "px"}, menu:null, exportOpen:false}); }
  tableVals(e, isSel) {
    const s = this.state, th = TABLE_THEMES[e.theme] || TABLE_THEMES.dark, ce = s.cellEdit && s.cellEdit.elId === e.id ? s.cellEdit : null, t = this.tsel(), tsel = t && t.elId === e.id ? t : null, sum = e.cols.reduce((a, c) => a + c.w, 0);
    return {
      cols: e.cols.map(c => ({w: (c.w / sum * 100).toFixed(2) + "%"})), tableBorder: e.border ? `1px solid ${th.border}` : "1px solid transparent", tableBg: th.bg,
      tableRows: e.cells.map((row, r) => ({cells: row.map((cell, c) => { if (cell.hidden) return null; const isHead = e.header && r === 0, inSel = tsel && r >= tsel.r0 && r <= tsel.r1 && c >= tsel.c0 && c <= tsel.c1, editing = ce && ce.r === r && ce.c === c;
        return {text: cell.t, rs: cell.span ? cell.span.r : 1, cs: cell.span ? cell.span.c : 1, isEditing: !!editing, showText: !editing, colW: r === 0 ? ((cell.span ? e.cols.slice(c, c + cell.span.c) : [e.cols[c]]).reduce((a, x) => a + x.w, 0) / sum * 100).toFixed(2) + "%" : "auto",
          size: isHead ? "1.5cqw" : "2cqw", ls: isHead ? ".06em" : "0", tt: isHead ? "uppercase" : "none", weight: cell.b ? 700 : isHead ? 700 : 400,
          color: cell.color || (isHead ? th.headColor : th.color), bg: cell.bg || (isHead ? th.head : (r % 2 === 1 ? th.zebra : "transparent")), align: cell.align || "left",
          border: e.border ? th.border : "transparent", outline: editing ? "#C8233B" : inSel ? "#C8233B" : "transparent", selBg: inSel ? "rgba(200,35,59,.12)" : "transparent",
          hasResize: r === 0 && c < e.cols.length - 1 && isSel, resize: (ev) => this.startColResize(ev, e, c),
          click: (ev) => { ev.stopPropagation(); if (s.editing || s.cellEdit) return; const prev = this.tsel(); this.setState({sels:[e.id], tsel: (ev.shiftKey && prev && prev.elId === e.id) ? {elId: e.id, r0: prev.r0, c0: prev.c0, r1: r, c1: c} : {elId: e.id, r0: r, c0: c, r1: r, c1: c}, menu:null, ctxMenu:null, composer:false}); },
          edit: (ev) => { ev.stopPropagation(); this.setState({cellEdit: {elId: e.id, r, c}, cellDraft: cell.t, sels:[e.id], editing:null, tsel: {elId: e.id, r0: r, c0: c, r1: r, c1: c}}); },
          ctx: (ev) => { const prev = this.tsel(), inPrev = prev && prev.elId === e.id && r >= prev.r0 && r <= prev.r1 && c >= prev.c0 && c <= prev.c1; if (!inPrev) this.setState({sels:[e.id], tsel: {elId: e.id, r0: r, c0: c, r1: r, c1: c}}); this.openCtx(ev, {kind:"cell", title: `Cell ${String.fromCharCode(65 + c)}${r + 1}`}); }}; }).filter(Boolean)})),
      addRow: (ev) => { ev.stopPropagation(); this.setCells(e, [...e.cells, e.cols.map(() => CELL("—"))]); }, addCol: (ev) => { ev.stopPropagation(); this.setCells(e, e.cells.map(r => [...r, CELL("—")]), {cols: [...e.cols, {w:1}]}); },
    };
  }
  thumb(sl) { return sl.elements.map(e => { const box = this.boxCss(e.box), isText = e.type === "text", isShape = ["rect","ellipse","line"].includes(e.type); return {box, text: isText ? e.text : "", bg: isShape ? e.fill : isText ? "transparent" : (e.type === "table" || e.type === "audio") ? "rgba(255,255,255,.08)" : "rgba(255,255,255,.1)", radius: e.type === "ellipse" ? "50%" : isText ? "0" : "4%", size: isText ? e.size + "cqw" : "0", weight: e.weight || 400, color: e.color || "transparent", border: (isText || isShape) ? "none" : "1px solid rgba(255,255,255,.14)"}; }); }
  renderVals() {
    const s = this.state, set = (p) => this.setState(p), R = this.React;
    const slides = s.slides, hasSlides = slides.length > 0, curIdx = Math.min(s.cur, Math.max(0, slides.length-1));
    const slide = slides[curIdx] || {id:"none", bg:"#14161a", accent:"#C8233B", elements:[], animOrder:[]};
    const sorted = this.sorted();
    const sels = s.sels.filter(id => slide.elements.some(e => e.id === id)), sel = sels.length > 0, selEls = sels.map(id => slide.elements.find(e => e.id === id));
    const selBB = sel ? this.bbox(selEls.map(e => e.box)) : {l:0,t:0,w:0,h:0};
    const gi = this.groupInfo(sels), isGroupSel = gi.isGroup && selEls.length > 1;
    const working = this.props.agentWorking ?? true, frozen = this.props.editingFrozen ?? false;
    const isPlay = s.mode === "play", shell = !isPlay, isGrid = s.view === "grid" && !isPlay, isEmpty = !hasSlides && !isPlay;
    const anim = this.animStates(slide), steps = this.steps(slide), animOrder = slide.animOrder.filter(id => { const e = slide.elements.find(x => x.id === id); return e && e.anim; });
    const noop = () => set({menu:null});
    const cmdRun = (id) => () => {
      if (id === "template") return set({dialog:true, menu:null});
      if (id === "animate") return this.openInsert("animate");
      if (id === "group") return isGroupSel ? this.ungroupSel() : this.groupSel();
      if (["new-slide","shape","insert-shape","arrange","animate"].includes(id)) return set({menu: s.menu === id ? null : id});
      if (id === "textbox" || id === "insert-textbox") return this.openInsert("text");
      if (id.startsWith("insert-")) return this.openInsert(id.slice(7));
      if (id === "play-from-start") return set({mode:"play", cur:0, menu:null, sels:[], playStep:0});
      if (id === "play-from-current") return set({mode:"play", menu:null, sels:[], playStep:0});
      if (id === "toggle-fullscreen") return set({fs:!s.fs, menu:null});
      if (["paste","cut","copy","slide-number","transition-none","transition-fade"].includes(id)) return noop();
      set({menu:null}); this.toast("Not wired up yet");
    };
    const menuDef = s.menu === "new-slide" ? [
        {items:[{label:"New slides from outline…", icon:"spark", pick: () => set({menu:null, outlineModal:true})}]},
        {label:"Layouts", items:[{label:"Blank", thumb:{bg:"#14161a", accent:"transparent"}, key:"⌘N", tpl:null}, ...TEMPLATES.map(t => ({label:t.name, thumb:t, tpl:t}))]}]
      : (s.menu === "shape" || s.menu === "insert-shape") ? [{items:[{label:"Rectangle", icon:"rect", pick: () => this.newShape("rect")},{label:"Ellipse", icon:"ellipse", pick: () => this.newShape("ellipse")},{label:"Line", icon:"line", pick: () => this.newShape("line")}]}]
      : s.menu === "animate" ? [
        {label:"Effect", items: EFFECTS.map(([v,label]) => ({label, icon: {fade:"fade", flyup:"up", flyleft:"alignL", zoom:"spark", wipe:"wipe"}[v] || "spark", pick: () => this.addAnimMany(sels, v, s.animTrigger || "click")}))},
        {label:"Start", items: TRIGGERS.map(([v,label]) => ({label, icon: v === "click" ? "fromhere" : v === "with" ? "distH" : "forward", key: (s.animTrigger || "click") === v ? "✓" : "", color: (s.animTrigger || "click") === v ? "#A81C31" : "#1F1A1A", keep: true, pick: () => set({animTrigger: v})}))}]
      : s.menu === "arrange" ? [
        {label:"Align", items:[["alignL","Align left"],["alignC","Center horizontally"],["alignR","Align right"],["alignT","Align top"],["alignM","Center vertically"],["alignB","Align bottom"]].map(([op,l]) => ({label:l, icon:op, disabled: !sel, pick: () => this.arrange(op)}))},
        {label:"Distribute", items:[["distH","Distribute horizontally"],["distV","Distribute vertically"]].map(([op,l]) => ({label:l, icon:op, disabled: sels.length < 3, pick: () => this.arrange(op)}))},
        {label:"Order", items:[["front","Bring to front","⌘⇧]"],["forward","Bring forward","⌘]"],["backward","Send backward","⌘["],["back","Send to back","⌘⇧["]].map(([op,l,key]) => ({label:l, icon:op, key, disabled: !sel, pick: () => this.reorder(sels, op)}))}]
      : [];
    const numStyle = (c) => ({numBg: c ? "#C8233B" : "transparent", numColor: c ? "#fff" : "#9A8F8C", numWeight: c ? 700 : 500});
    const segTab = (on) => ({bg: on ? "#fff" : "transparent", color: on ? "#1F1A1A" : "#6E635F", shadow: on ? "0 1px 3px rgba(40,20,20,.12), 0 1px 2px rgba(40,20,20,.06)" : "none"});
    const chatT = segTab(s.side === "chat"), styleT = segTab(s.side === "style"), animT = segTab(s.side === "animate"), nv = segTab(s.view === "normal"), gv = segTab(s.view === "grid");
    const selName = isGroupSel ? gi.name : sels.length > 1 ? `${sels.length} elements` : (selEls[0] ? selEls[0].name : "");
    const flashOn = (id) => { clearTimeout(this._ft); this._ft = setTimeout(() => this.setState({flash:null}), 900); return id; };
    const outlineLines = s.outline.split("\n").filter(l => l.trim()), outlineSlides = outlineLines.filter(l => !/^\s/.test(l) && !/^[-•*]/.test(l.trim())).length;
    const first = selEls[0];
    return {
      shell, isPlay, isGrid, frozen, working, notice: !!s.notice, noticeText: s.notice, dialogOpen: s.dialog, draft: s.draft, noteDraft: s.note, hasSlides, isEmpty,
      deck: {name:"Q3 產品路線圖.slidra", w: s.deckW, h: s.deckH}, stageAspect: `${s.deckW} / ${s.deckH}`,
      pagePresets: [["16:9",1280,720],["4:3",1024,768],["16:10",1280,800],["A4",1123,794]].map(([label,w,h]) => ({label, sub: `${w} × ${h}`, ...segTab(s.deckW === w && s.deckH === h), pick: () => set({deckW:w, deckH:h, dirty:true})})),
      deckW: String(s.deckW), deckH: String(s.deckH), onDeckW: (ev) => { const v = parseInt(ev.target.value, 10); if (v >= 320 && v <= 4096) set({deckW: v, dirty:true}); }, onDeckH: (ev) => { const v = parseInt(ev.target.value, 10); if (v >= 240 && v <= 4096) set({deckH: v, dirty:true}); },
      swapDeck: () => set({deckW: s.deckH, deckH: s.deckW, dirty:true}),
      objectStyleHint: sel ? `${selName} · Slide ${curIdx + 1}` : "Nothing selected",
      stylePage: !(sel && s.styleSub !== "page"), styleObject: sel && s.styleSub !== "page", animPage: !(sel && s.animSub !== "page") && !(animOrder.length && s.animSub === "object"), animObject: (sel && s.animSub !== "page") || (animOrder.length > 0 && s.animSub === "object"),
      styleSubTabs: [["page","Page",0,""],["object","Object", sels.length, "#C8233B"]].map(([id,label,badge,badgeBg]) => { const on = id === "page" ? !(sel && s.styleSub !== "page") : (sel && s.styleSub !== "page"); const dis = id === "object" && !sel; return {label, ...segTab(on), disabled: dis, opacity: dis ? .45 : 1, hasBadge: badge > 0, badge, badgeBg, pick: () => set({styleSub: id})}; }),
      animSubTabs: [["page","Page",0,""],["object","Object", animOrder.length, "#1F1A1A"]].map(([id,label,badge,badgeBg]) => { const objOn = (sel && s.animSub !== "page") || (animOrder.length > 0 && s.animSub === "object"); const on = id === "page" ? !objOn : objOn; const dis = id === "object" && !sel && !animOrder.length; return {label, ...segTab(on), disabled: dis, opacity: dis ? .45 : 1, hasBadge: badge > 0, badge, badgeBg, pick: () => set({animSub: id})}; }), savedLabel: s.dirty ? "Unsaved changes" : "Saved · just now",
      stop: (e) => e.stopPropagation(), preventCtx: (e) => { if (!(e.target.closest && e.target.closest("input,textarea"))) e.preventDefault(); },
      closeMenu: () => { if (s.menu || s.exportOpen || s.ctxMenu || s.insertDlg) set({menu:null, exportOpen:false, ctxMenu:null, insertDlg:null}); },
      undo: () => this.undo(), redo: () => this.redo(),
      undoDisabled: frozen || !s.past.length, redoDisabled: frozen || !s.future.length,
      undoOpacity: (frozen || !s.past.length) ? .35 : 1, redoOpacity: (frozen || !s.future.length) ? .35 : 1,
      undoCursor: (frozen || !s.past.length) ? "default" : "pointer", redoCursor: (frozen || !s.future.length) ? "default" : "pointer",
      openFile: () => this.toast("Open… (not wired up yet)"), saveFile: () => this.saveNow(),
      exportOpen: s.exportOpen, toggleExport: () => set({exportOpen: !s.exportOpen, menu:null}),
      exportBorder: s.exportOpen ? "#D9CFCB" : "#ECE5E2", exportBg: s.exportOpen ? "#F5F1EF" : "#fff", exportColor: s.exportOpen ? "#1F1A1A" : "#3A322F",
      exportItems: [
        {tag:"PPTX", label:"PowerPoint", desc:"Editable slides (.pptx)", bg:"#FDE8EA", color:"#A81C31"},
        {tag:"PDF", label:"PDF", desc:"One page per slide", bg:"#F5F1EF", color:"#3A322F"},
        {tag:"PDF+", label:"By-frame PDF", desc:"One page per animation step", bg:"#EEF0FD", color:"#5B6DEA"},
      ].map(x => ({...x, pick: () => { set({exportOpen:false}); this.toast(`Exporting ${x.label}…`); }})),
      closeDialog: () => set({dialog:false}),
      tabs: TABS.map(([id,label]) => ({label, ...segTab(s.tab===id), pick: () => set({tab:id, menu:null})})),
      groups: FLAT.map((g, i) => ({label:g.label, sep: i ? "#ECE5E2" : "transparent", sepGlass: i ? "rgba(31,26,26,.1)" : "transparent", menuOpen: (!!s.menu && g.cmds.some(c => c[0]===s.menu)) || (g.label === "Animate" && s.menu === "animate"),
        cmds: g.cmds.map(([id,label,icon]) => { const dis = (id === "animate" || id === "arrange") ? !sel : id === "group" ? !(isGroupSel || sels.length >= 2) : false; const lab = id === "group" && isGroupSel ? "Ungroup" : label; return {label: lab, tip: `${g.label} · ${lab}`, showLabel: true, svg:{__html: ICONS[icon]}, disabled: dis, opacity: dis ? .4 : 1, hasMenu: ["new-slide","shape","insert-shape","arrange"].includes(id), run: cmdRun(id), bg: s.menu===id ? "#ECE5E2" : "transparent", color: s.menu===id ? "#1F1A1A" : "#3A322F"}; })})),
      menuGroups: menuDef.map((mg, i) => ({hasLabel: !!mg.label, label: mg.label, dir: menuDef.length === 1 ? "row" : "column", mt: i ? "6px" : "0", pt: i ? "6px" : "0", bt: i ? "#F3EDEA" : "transparent",
        items: mg.items.map(it => ({label: it.label, hasThumb: !!it.thumb, thumbBg: it.thumb?.bg, thumbAccent: it.thumb?.accent, hasIcon: !!it.icon, svg: it.icon ? {__html: ICONS[it.icon]} : null, hasKey: !!it.key, key: it.key, disabled: !!it.disabled, opacity: it.disabled ? .4 : 1, color: it.color || "#1F1A1A",
          pick: it.pick || (s.menu === "new-slide" ? () => this.addSlide(curIdx + (hasSlides ? 1 : 0), it.tpl) : noop)}))})),
      railSlides: slides.map((sl, i) => { const c = i===curIdx; const pIdx = sorted.findIndex(x => x.slide === i && x.target === "page"), pc = pIdx >= 0 ? 1 : 0; const ac = sl.animOrder.filter(id => sl.elements.some(e => e.id === id && e.anim)).length; const t = sl.elements.find(e => e.name === "title") || sl.elements.find(e => e.type === "text"); return {n:i+1, bg: sl.bg, title: t ? t.text : "Untitled", thumb: this.thumb(sl), ...numStyle(c), rowBg: c ? "#ECE5E2" : "transparent", rowOpacity: s.railFrom === i ? .4 : 1, isOver: s.railOver === i && s.railFrom !== i && s.railFrom + 1 !== i,
        hasAnim: ac > 0, animCount: ac,
        hasPageComments: pc > 0, noPageComments: pc === 0, pageCommentN: pIdx + 1, pinOpacity: (pc > 0 || s.hoverIdx === i) ? 1 : 0,
        hoverIn: () => set({hoverIdx:i}), hoverOut: () => { if (s.hoverIdx === i) set({hoverIdx:-1}); }, pinBg: pc > 0 ? "#C8233B" : "#fff", pinColor: pc > 0 ? "#fff" : "#A81C31", pinShadow: pc > 0 ? "0 4px 12px rgba(200,35,59,.35)" : "0 1px 3px rgba(40,20,20,.18)",
        comment: (e) => { e.stopPropagation(); const ex = s.comments.find(x => x.slideId === sl.id && x.target === "page"); set({cur:i, sels:[], composer:true, commentDraft: ex ? ex.text : "", editingId: ex ? ex.id : null, view:"normal", menu:null, flash: ex ? flashOn(ex.id) : null}); },
        ring: c ? "0 0 0 2px #C8233B, 0 1px 3px rgba(40,20,20,.12)" : "0 1px 3px rgba(40,20,20,.12), 0 1px 2px rgba(40,20,20,.06)",
        gridRing: c ? "0 0 0 2.5px #C8233B, 0 1px 3px rgba(40,20,20,.12)" : "0 1px 3px rgba(40,20,20,.12), 0 1px 2px rgba(40,20,20,.06)",
        show: () => this.go(i), pickGrid: () => { this.go(i); set({view:"normal"}); },
        ctx: (e) => this.openCtx(e, {kind:"slide", idx:i, title:`Slide ${i+1}`}),
        dragStart: (e) => { e.dataTransfer.effectAllowed = "move"; e.dataTransfer.setData("text/plain", String(i)); set({railFrom:i}); },
        dragOver: (e) => { e.preventDefault(); e.dataTransfer.dropEffect = "move"; if (s.railOver !== i) set({railOver:i}); },
        drop: (e) => { e.preventDefault(); this.moveSlide(s.railFrom, i); }}; }),
      railDragEnd: () => set({railFrom:-1, railOver:-1}),
      railOverEnd: (e) => { e.preventDefault(); if (s.railOver !== slides.length) set({railOver: slides.length}); }, railDropEnd: (e) => { e.preventDefault(); this.moveSlide(s.railFrom, slides.length); }, overEnd: s.railOver === slides.length && s.railFrom >= 0 && s.railFrom !== slides.length - 1,
      newSlideQuick: () => set({menu:"new-slide", tab:"home"}), railNew: () => set({menu: s.menu === "new-slide" ? null : "new-slide"}), railTemplates: () => set({dialog:true, menu:null}), railMenuOpen: s.menu === "new-slide",
      cur: {bg: slide.bg},
      elements: slide.elements.map((e, zi) => { const isSel = sels.includes(e.id), multi = isSel && sels.length > 1, a = anim[e.id] || {vis:"visible", css:"none"}, an = (() => { const bs = this.animBlocks(slide); const bi = bs.findIndex(b => b.ids.includes(e.id)); return bi < 0 ? -1 : (bs[bi].ids[0] === e.id ? bi : -1); })(), ce = s.cellEdit && s.cellEdit.elId === e.id ? s.cellEdit : null;
        return {id: e.id, box: this.boxCss(e.box), z: zi + 1, vis: a.vis, animCss: a.css, outline: multi ? "#C8233B" : "transparent",
          showText: e.type === "text" && s.editing !== e.id, isEditing: e.type === "text" && s.editing === e.id, text: e.text, size: e.size + "cqw", weight: e.weight, color: e.color, align: e.align || "left", justify: e.align === "center" ? "center" : e.align === "right" ? "flex-end" : "flex-start",
          isShape: ["rect","ellipse","line"].includes(e.type), fill: e.fill, radius: e.type === "ellipse" ? "50%" : "2px",
          isImage: e.type === "image", isVideo: e.type === "video", isAudio: e.type === "audio", isChart: e.type === "chart", isTable: e.type === "table", mediaLabel: e.mediaLabel, hasSrc: !!e.src, noSrc: !e.src, src: e.src || "", srcCss: e.src ? `url("${e.src}")` : "none",
          chartNode: e.type === "chart" ? this.chartNode(e) : null,
          ...(e.type === "table" ? this.tableVals(e, isSel) : {cols: [], tableRows: []}),
          showAnimBadge: an >= 0 && s.side === "animate" && !isPlay, animN: an + 1, animBadgeBorder: isSel ? "#C8233B" : "transparent", badgeLeft: `calc(${e.box.l}cqw - 26px)`, badgeTop: `calc(${e.box.t}cqh - 2px)`, pickAnim: (ev) => { ev.stopPropagation(); set({sels:[e.id], side:"animate"}); },
          select: (ev) => { ev.stopPropagation(); if (s.editing || s.cellEdit || s.hand) return; set({sels: ev.shiftKey ? (isSel ? sels.filter(x => x !== e.id) : this.expandGroup([...sels, e.id])) : (isSel ? sels : this.expandGroup([e.id])), groupDepth: isSel ? (s.groupDepth || 0) : 0, menu:null, composer:false, ctxMenu:null}); },
          down: (ev) => { if (s.hand || s.space) return this.wellDown(ev); ev.stopPropagation(); if (ev.button !== 0 || s.editing || s.cellEdit) return; if (!isSel && !ev.shiftKey) { this.setState({sels: this.expandGroup([e.id]), groupDepth: 0, composer:false}); const cx = ev.clientX, cy = ev.clientY; setTimeout(() => this.startDrag({clientX: cx, clientY: cy, stopPropagation(){}, preventDefault(){}}, "move"), 0); } else if (isSel && !ev.shiftKey) this.startDrag(ev, "move"); },
          edit: (ev) => { ev.stopPropagation(); if (isSel && sels.length > 1 && this.drillGroup(e)) return; if (e.type === "text") this.startEdit(e.id); if (e.type === "chart") set({chartWin: e.id, sels:[e.id]}); },
          ctx: (ev) => this.openCtx(ev, {kind:"element", ids: isSel ? sels : [e.id], title: isSel && sels.length > 1 ? `${sels.length} elements` : e.name})}; }),
      editDraft: s.editDraft, onEditDraft: (e) => set({editDraft: e.target.value}), commitEdit: () => this.commitEdit(),
      editKey: (e) => { if (e.key === "Enter") { e.preventDefault(); this.commitEdit(); } if (e.key === "Escape") { e.stopPropagation(); set({editing:null, editDraft:""}); } },
      cellDraft: s.cellDraft, onCellDraft: (e) => set({cellDraft: e.target.value}), commitCell: () => this.commitCell(),
      cellKey: (e) => { if (e.key === "Enter") { e.preventDefault(); this.commitCell(); } if (e.key === "Escape") { e.stopPropagation(); set({cellEdit:null, cellDraft:""}); } if (e.key === "Tab") { e.preventDefault(); const ce = s.cellEdit, el = this.el(ce.elId); this.commitCell(); const cols = el.cols.length; let r = ce.r, c = ce.c + 1; if (c >= cols) { c = 0; r += 1; } if (r < el.cells.length) setTimeout(() => set({cellEdit:{elId: el.id, r, c}, cellDraft: el.cells[r][c].t, tsel:{elId: el.id, r0:r, c0:c, r1:r, c1:c}}), 0); } },
      chartAnim: this._chart || (this._chart = this.chart()), waveBars: this._waves || (this._waves = this.waves()),
      curN: hasSlides ? curIdx+1 : 0, total: slides.length,
      bodyCols: shell ? "212px minmax(0,1fr) 340px" : "1fr",
      mainRows: (shell && !isGrid && hasSlides) ? "minmax(0,1fr) 112px" : "1fr",
      notesVisible: shell && !isGrid && hasSlides,
      wellBg: isPlay ? "#000" : "#3A3A3D", wellPad: isPlay ? "0" : "28px 36px 76px",
      stageTransform: isPlay ? "translate(-50%,-50%)" : `translate(calc(-50% + ${s.pan.x}px), calc(-50% + ${s.pan.y}px)) scale(${s.zoom})`,
      wellCursor: s.panning ? "grabbing" : (s.space || s.hand) ? "grab" : "default", stageCursor: s.panning ? "grabbing" : (s.space || s.hand) ? "grab" : "default", wellWheel: (e) => this.wellWheel(e), wellDown: (e) => this.wellDown(e),
      zoomLabel: Math.round(s.zoom * 100) + "%", zoomIn: () => this.zoomIn(), zoomOut: () => this.zoomOut(), zoomFit: () => this.zoomFit(),
      zoomMenuOpen: s.menu === "zoom", toggleZoomMenu: () => set({menu: s.menu === "zoom" ? null : "zoom", insertDlg:null}), zoomBtnBg: s.menu === "zoom" ? "rgba(31,26,26,.1)" : "transparent",
      zoomOptions: [["Fit", 0, "⌘0"],["50%", .5, ""],["75%", .75, ""],["100%", 1, ""],["150%", 1.5, ""],["200%", 2, ""],["400%", 4, ""]].map(([label,z,key]) => ({label, key, color: (z ? Math.abs(s.zoom - z) < .001 : (s.zoom === 1 && !s.pan.x && !s.pan.y)) ? "#A81C31" : "#1F1A1A", pick: () => { z ? this.setZoom(z) : this.zoomFit(); set({menu:null}); }})),
      toggleHand: () => set({hand: !s.hand, sels: s.hand ? s.sels : [], composer:false, editing:null, cellEdit:null, tsel:null, menu:null, insertDlg:null}), handBg: s.hand ? "#1F1A1A" : "transparent", handColor: s.hand ? "#fff" : "#3A322F",
      stageRadius: isPlay ? "0" : "6px", stageShadow: isPlay ? "none" : "0 1px 2px rgba(0,0,0,.4), 0 24px 64px -16px rgba(0,0,0,.7)",
      selVisible: sel && !isPlay && !s.editing && !s.preview, noSel: !sel, selName, selCount: sels.length, selBox: this.boxCss(selBB), handlesVisible: sels.length === 1, selOutlineStyle: sels.length > 1 ? (isGroupSel ? "solid" : "dashed") : "solid", selPointer: ((first && first.type === "table" && sels.length === 1) || sels.length > 1) ? "none" : "auto",
      selIcon: {__html: ICONS[first ? TYPE_ICON[first.type] : "textbox"]}, selTypeLabel: sels.length > 1 ? "Group" : first ? TYPE_LABEL[first.type] : "",
      ctxVisible: sel && !isPlay && !isGrid && !s.composer && !s.editing && !s.cellEdit && !s.marquee && !s.preview,
      selCtx: (e) => this.openCtx(e, {kind:"element", ids: sels, title: selName}), selDbl: (e) => { e.stopPropagation(); if (sels.length === 1) { if (first.type === "chart") set({chartWin: first.id}); else this.startEdit(sels[0]); } },
      stageDown: (e) => this.stageDown(e),
      dragStart: (e) => this.startDrag(e, "move"), resizeNW: (e) => this.startDrag(e, "nw"), resizeNE: (e) => this.startDrag(e, "ne"), resizeSW: (e) => this.startDrag(e, "sw"), resizeSE: (e) => this.startDrag(e, "se"),
      guides: s.guides, marqueeVisible: !!s.marquee, marquee: s.marquee ? this.boxCss(s.marquee) : {},
      selFlash: s.flash ? "0 0 0 10px rgba(200,35,59,.28)" : "0 0 0 0 rgba(200,35,59,0)",
      selQuote: first ? (first.text || first.name) : (slide.elements[0] ? slide.elements[0].text : ""),
      composerTargetLabel: sels.length === 1 ? first.name : "whole slide",
      wellRef: this.wellRef, stageRef: this.stageRef, selRef: this.selRef, composerRef: this.composerRef, composerPos: s.composerPos, ctxRef: this.ctxRef, ctxPos: s.ctxPos,
      composerOpen: s.composer && !isPlay && !isGrid && hasSlides,
      commentDraft: s.commentDraft, onCommentDraft: (e) => set({commentDraft: e.target.value}),
      commentBtnBg: s.composer ? "#FDE8EA" : "transparent", commentBtnColor: s.composer ? "#A81C31" : "#3A322F",
      openComposer: () => { if (s.composer) return set({composer:false, commentDraft:"", editingId:null}); const tgt = sels.length === 1 ? sels[0] : "page"; const ex = s.comments.find(x => x.slideId === slide.id && x.target === tgt); set({composer:true, commentDraft: ex ? ex.text : "", editingId: ex ? ex.id : null}); },
      cancelComment: () => set({composer:false, commentDraft:"", editingId:null}),
      submitComment: () => this.addComment(), commentKey: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.addComment(); } if (e.key === "Escape") set({composer:false, editingId:null}); },
      hasComments: sorted.length > 0, commentCount: sorted.length,
      comments: sorted.map((c, i) => { const isPage = c.target === "page"; const active = curIdx === c.slide && (isPage ? !sel : (sels.length === 1 && sels[0] === c.target)); return {n: i+1, slideN: c.slide+1, isPage, text: c.text,
        border: active ? "#F5C6CC" : "#ECE5E2", shadow: active ? "0 0 0 2px #FDE8EA" : "none",
        jump: () => set({cur:c.slide, sels: isPage ? [] : [c.target], view:"normal", mode:"view", composer:true, editingId:c.id, commentDraft:c.text, menu:null, editing:null, flash: flashOn(c.id)}),
        remove: () => set({comments: s.comments.filter(x => x.id !== c.id)})}; }),
      pins: sorted.map((c, i) => ({c, n:i+1})).filter(({c}) => c.slide === curIdx && sels.length === 1 && c.target === sels[0] && !isPlay).map(({c, n}) => ({n, text: c.text,
          select: (e) => { e.stopPropagation(); set({composer:true, editingId:c.id, commentDraft:c.text, flash: flashOn(c.id)}); }})),
      isEditing: !!s.editingId, editingN: sorted.findIndex(c => c.id === s.editingId) + 1,
      deleteEditing: () => set({comments: s.comments.filter(c => c.id !== s.editingId), composer:false, commentDraft:"", editingId:null}),
      composerTitle: s.editingId ? "Save changes" : "Add comment",
      ctxCmds: [
        ...(first && first.type === "chart" && sels.length === 1 ? [["Edit data", "table", () => set({chartWin: first.id})]] : []),
        ["Edit style", "edit", () => set({side:"style"})],
        ...(first && first.anim ? [["Edit animation", "spark", () => set({side:"animate", animSub:"object"})]] : []),
        ["Delete", "trash", () => this.removeElements(sels), "#A81C31", true],
      ].map(([label,icon,run,color,sep]) => ({label, svg:{__html: ICONS[icon]}, run, color: color || "#3A322F", sep: !!sep})),
      tableStyleVisible: !!first && first.type === "table" && sels.length === 1,
      tableThemes: [["dark","Dark"],["light","Light"],["zebra","Zebra"]].map(([v,label]) => ({label, on: first && first.theme === v, bg: first && first.theme === v ? "#fff" : "transparent", color: first && first.theme === v ? "#1F1A1A" : "#6E635F", shadow: first && first.theme === v ? "0 1px 3px rgba(40,20,20,.12)" : "none", pick: () => this.chartSet(first.id, {theme: v})})),
      tableHeader: !!(first && first.header), tableBorder: !!(first && first.border), toggleHeader: () => this.chartSet(first.id, {header: !first.header}), toggleBorder: () => this.chartSet(first.id, {border: !first.border}),
      headerBg: first && first.header ? "#C8233B" : "#D9CFCB", headerX: first && first.header ? "16px" : "2px", borderBg: first && first.border ? "#C8233B" : "#D9CFCB", borderX: first && first.border ? "16px" : "2px",
      cellStyleVisible: !!this.tsel(), cellStyleHidden: !this.tsel(), cellBoldBg: (() => { const t = this.tsel(); return (t && this.el(t.elId).cells[t.r0][t.c0].b) ? "#1F1A1A" : "#fff"; })(), cellBoldColor: (() => { const t = this.tsel(); return (t && this.el(t.elId).cells[t.r0][t.c0].b) ? "#fff" : "#3A322F"; })(), cellRangeLabel: (() => { const t = this.tsel(); if (!t) return ""; const A = c => String.fromCharCode(65 + c); return t.r0 === t.r1 && t.c0 === t.c1 ? `Cell ${A(t.c0)}${t.r0 + 1}` : `${A(t.c0)}${t.r0 + 1} – ${A(t.c1)}${t.r1 + 1}`; })(),
      cellBold: (() => { const t = this.tsel(); return !!(t && this.el(t.elId).cells[t.r0][t.c0].b); })(), toggleCellBold: () => { const t = this.tsel(); this.cellStyle({b: !this.el(t.elId).cells[t.r0][t.c0].b}); },
      cellAligns: [["left","alignL"],["center","alignC"],["right","alignR"]].map(([v,icon]) => { const t = this.tsel(); const cur = t ? (this.el(t.elId).cells[t.r0][t.c0].align || "left") : "left"; return {svg:{__html: ICONS[icon]}, bg: cur === v ? "#fff" : "transparent", color: cur === v ? "#C8233B" : "#6E635F", pick: () => this.cellStyle({align: v})}; }),
      cellFills: ["", "rgba(200,35,59,.28)", "rgba(91,109,234,.28)", "rgba(74,143,69,.28)", "rgba(224,138,46,.28)", "rgba(255,255,255,.12)"].map(v => ({swatch: v || "transparent", isNone: !v, pick: () => this.cellStyle({bg: v || undefined})})),
      cellColors: ["", "#f4f6f8", "#7fd3a5", "#f5a3b1", "#9db4ff", "#f4c542"].map(v => ({swatch: v || "transparent", isNone: !v, pick: () => this.cellStyle({color: v || undefined})})),
      cellCanMerge: (() => { const t = this.tsel(); return !!t && (t.r0 !== t.r1 || t.c0 !== t.c1); })(), cellCanUnmerge: (() => { const t = this.tsel(); return !!t && !!this.el(t.elId).cells[t.r0][t.c0].span; })(), mergeCells: () => this.mergeCells(), unmergeCells: () => this.unmergeCells(),
      cw: (() => { const e = s.chartWin && this.el(s.chartWin); if (!e || e.type !== "chart" || isPlay) return {open:false}; const well = this.wellRef.current, pos = s.chartWinPos || {x: well ? well.clientWidth - 436 : 40, y: 76};
        return {open:true, name: e.name, left: pos.x + "px", top: pos.y + "px",
          types: CHART_TYPES.map(([v,label,svg]) => ({label, svg:{__html: svg}, bg: e.chartType === v ? "#1F1A1A" : "transparent", color: e.chartType === v ? "#fff" : "#3A322F", pick: () => this.chartSet(e.id, {chartType: v})})),
          series: e.series.map((se, si) => ({name: se.name, color: se.color || (PALETTES[e.palette] || PALETTES.brand)[si % 6], onName: (ev) => this.chartSet(e.id, {series: e.series.map((x, j) => j === si ? {...x, name: ev.target.value} : x)}, true), del: () => { if (e.series.length > 1) this.chartSet(e.id, {series: e.series.filter((_, j) => j !== si)}); }})),
          rows: e.categories.map((cat, ri) => ({cat, onCat: (ev) => this.chartSet(e.id, {categories: e.categories.map((x, j) => j === ri ? ev.target.value : x)}, true),
            cells: e.series.map((se, si) => ({v: se.values[ri] ?? "", onV: (ev) => this.chartSet(e.id, {series: e.series.map((x, j) => j === si ? {...x, values: x.values.map((vv, k) => k === ri ? (ev.target.value === "" ? "" : +ev.target.value) : vv)} : x)}, true)})),
            del: () => { if (e.categories.length > 1) this.chartSet(e.id, {categories: e.categories.filter((_, j) => j !== ri), series: e.series.map(x => ({...x, values: x.values.filter((_, j) => j !== ri)}))}); }})),
          addRow: () => this.chartSet(e.id, {categories: [...e.categories, `C${e.categories.length + 1}`], series: e.series.map(x => ({...x, values: [...x.values, 0]}))}),
          addSeries: () => this.chartSet(e.id, {series: [...e.series, {name: `Series ${e.series.length + 1}`, values: e.categories.map(() => 0)}]}),
          palettes: Object.keys(PALETTES).map(k => ({colors: PALETTES[k].slice(0, 4).map(c => ({c})), on: e.palette === k, border: e.palette === k ? "#C8233B" : "#ECE5E2", pick: () => this.chartSet(e.id, {palette: k})})),
          legends: [["none","None"],["bottom","Bottom"],["right","Right"]].map(([v,label]) => ({label, bg: e.legend === v ? "#fff" : "transparent", color: e.legend === v ? "#1F1A1A" : "#6E635F", shadow: e.legend === v ? "0 1px 3px rgba(40,20,20,.12)" : "none", pick: () => this.chartSet(e.id, {legend: v})})),
          grid: !!e.grid, labels: !!e.labels, toggleGrid: () => this.chartSet(e.id, {grid: !e.grid}), toggleLabels: () => this.chartSet(e.id, {labels: !e.labels}),
          gridBg: e.grid ? "#C8233B" : "#D9CFCB", gridX: e.grid ? "16px" : "2px", labelsBg: e.labels ? "#C8233B" : "#D9CFCB", labelsX: e.labels ? "16px" : "2px",
          xTitle: e.xTitle, yTitle: e.yTitle, onX: (ev) => this.chartSet(e.id, {xTitle: ev.target.value}, true), onY: (ev) => this.chartSet(e.id, {yTitle: ev.target.value}, true),
          isPie: e.chartType === "pie" || e.chartType === "donut", notPie: !(e.chartType === "pie" || e.chartType === "donut"), copySvg: () => this.copySvg(e), close: () => set({chartWin:null}), dragStart: (ev) => this.startWinDrag(ev)}; })(),
      chartFocus: () => this.chartFocus(), chartBlur: () => this.chartBlur(),
      openStyle: () => set({side:"style"}),
      ins: (() => { const d = s.insertDlg; if (!d) return {open:false}; const isMedia = ["image","video","audio"].includes(d.kind);
        return {open:true, isMedia, isText: d.kind === "text", isAnimate: d.kind === "animate", isTable: d.kind === "table", isChart: d.kind === "chart", title: d.kind === "animate" ? `Animate ${selName || "selection"}` : `Insert ${TYPE_LABEL[d.kind].toLowerCase()}`, icon: {__html: ICONS[d.kind === "animate" ? "spark" : TYPE_ICON[d.kind]]},
          effects: EFFECTS.map(([v,label]) => ({label, on: d.effect === v, border: d.effect === v ? "#C8233B" : "#ECE5E2", color: d.effect === v ? "#A81C31" : "#3A322F", anim: `cm-a-${v} 1.2s .2s cubic-bezier(.2,.8,.2,1) infinite`, pick: () => this.setInsert({effect: v})})),
          triggers: TRIGGERS.map(([v,label]) => ({label, ...segTab(d.trigger === v), pick: () => this.setInsert({trigger: v})})),
          duration: d.duration, onDuration: (ev) => this.setInsert({duration: +ev.target.value}),
          text: d.text || "", onText: (ev) => this.setInsert({text: ev.target.value}), textKey: (ev) => { if (ev.key === "Enter" && !ev.shiftKey) { ev.preventDefault(); this.confirmInsert(); } },
          presets: [["title","Title","20px",700],["subtitle","Subtitle","14px",500],["body","Body","12.5px",400],["caption","Caption","10.5px",500]].map(([v,label,fs,fw]) => ({label, fs, fw, ...segTab(d.preset === v), pick: () => this.setInsert({preset: v})})),
          aligns: [["left","alignL"],["center","alignC"],["right","alignR"]].map(([v,icon]) => ({svg:{__html: ICONS[icon]}, bg: d.align === v ? "#fff" : "transparent", color: d.align === v ? "#C8233B" : "#6E635F", pick: () => this.setInsert({align: v})})),
          accept: d.kind === "image" ? "image/*" : d.kind === "video" ? "video/*" : "audio/*", hasFile: !!d.file, noFile: !d.file, fileName: d.file ? d.file.name : "", fileSize: d.file ? (d.file.size > 1048576 ? (d.file.size/1048576).toFixed(1) + " MB" : Math.round(d.file.size/1024) + " KB") : "", isImagePreview: d.kind === "image" && !!d.file, previewSrc: d.file ? d.file.src : "", previewCss: d.file ? `url("${d.file.src}")` : "none",
          onFile: (ev) => this.pickFile(ev.target.files && ev.target.files[0]), onDrop: (ev) => { ev.preventDefault(); this.pickFile(ev.dataTransfer.files && ev.dataTransfer.files[0]); }, onDragOver: (ev) => ev.preventDefault(), clearFile: () => this.setInsert({file:null}),
          url: d.url, onUrl: (ev) => this.setInsert({url: ev.target.value, file: null}), caption: d.caption, onCaption: (ev) => this.setInsert({caption: ev.target.value}),
          rows: d.rows, cols: d.cols, rowsDec: () => this.setInsert({rows: Math.max(2, d.rows - 1)}), rowsInc: () => this.setInsert({rows: Math.min(12, d.rows + 1)}), colsDec: () => this.setInsert({cols: Math.max(1, d.cols - 1)}), colsInc: () => this.setInsert({cols: Math.min(8, d.cols + 1)}),
          gridCells: d.kind === "table" ? Array.from({length: 48}, (_, i) => { const r = Math.floor(i / 8), c = i % 8; const hr = d.hoverRows || d.rows, hc = d.hoverCols || d.cols; const on = r < d.rows && c < d.cols, hov = r < hr && c < hc; return {bg: on ? "#C8233B" : hov ? "#F5C6CC" : "#F5F1EF", pick: () => this.setInsert({rows: r + 1, cols: c + 1, hoverRows: null, hoverCols: null}), hover: () => this.setInsert({hoverRows: r + 1, hoverCols: c + 1})}; }) : [],
          gridLeave: () => this.setInsert({hoverRows: null, hoverCols: null}), sizeLabel: `${d.hoverRows || d.rows} × ${d.hoverCols || d.cols}`,
          header: !!d.header, toggleHeader: () => this.setInsert({header: !d.header}), headerBg: d.header ? "#C8233B" : "#D9CFCB", headerX: d.header ? "16px" : "2px",
          themes: [["dark","Dark"],["light","Light"],["zebra","Zebra"]].map(([v,label]) => ({label, ...segTab(d.theme === v), pick: () => this.setInsert({theme: v})})),
          types: CHART_TYPES.map(([v,label,svg]) => ({label, svg:{__html: svg}, bg: d.chartType === v ? "#1F1A1A" : "transparent", color: d.chartType === v ? "#fff" : "#3A322F", pick: () => this.setInsert({chartType: v})})),
          series: d.series, cats: d.cats, seriesDec: () => this.setInsert({series: Math.max(1, d.series - 1)}), seriesInc: () => this.setInsert({series: Math.min(4, d.series + 1)}), catsDec: () => this.setInsert({cats: Math.max(2, d.cats - 1)}), catsInc: () => this.setInsert({cats: Math.min(12, d.cats + 1)}),
          palettes: Object.keys(PALETTES).map(k => ({colors: PALETTES[k].slice(0, 4).map(c => ({c})), border: d.palette === k ? "#C8233B" : "#ECE5E2", pick: () => this.setInsert({palette: k})})),
          canInsert: true, insertLabel: d.kind === "animate" ? "Add animation" : isMedia && !d.file && !d.url ? "Insert placeholder" : "Insert", confirm: () => this.confirmInsert(), close: () => set({insertDlg:null})}; })(),
      enterFx: ENTER_FX.map(([v,label]) => { const on = this.trans(slide).enter.effect === v; return {label, border: on ? "#C8233B" : "#ECE5E2", color: on ? "#A81C31" : "#3A322F", thumb: v === "none" ? "rgba(255,255,255,.18)" : "#C8233B", thumbOp: v === "fade" ? .5 : 1, thumbT: v === "slide" ? "translateX(6px)" : v === "zoom" ? "scale(.8)" : "none", pick: () => this.updateSlide({transition: {...this.trans(slide), enter: {...this.trans(slide).enter, effect: v}}})}; }),
      exitFx: EXIT_FX.map(([v,label]) => { const on = this.trans(slide).exit.effect === v; return {label, border: on ? "#C8233B" : "#ECE5E2", color: on ? "#A81C31" : "#3A322F", thumb: v === "none" ? "rgba(255,255,255,.18)" : "#5B6DEA", thumbOp: v === "fade" ? .5 : 1, thumbT: v === "slide" ? "translateX(-6px)" : v === "zoom" ? "scale(.8)" : "none", pick: () => this.updateSlide({transition: {...this.trans(slide), exit: {...this.trans(slide).exit, effect: v}}})}; }),
      enterDur: this.trans(slide).enter.duration, exitDur: this.trans(slide).exit.duration,
      setEnterDur: (ev) => this.updateSlide({transition: {...this.trans(slide), enter: {...this.trans(slide).enter, duration: +ev.target.value}}}), setExitDur: (ev) => this.updateSlide({transition: {...this.trans(slide), exit: {...this.trans(slide).exit, duration: +ev.target.value}}}),
      applyTransAll: () => { const t = this.trans(slide); this.commit({slides: slides.map(sl => ({...sl, transition: {enter: {...t.enter}, exit: {...t.exit}}}))}); this.toast(`Page animation applied to ${slides.length} slides`); },
      stageTrans: (() => { if (!isPlay) return "none"; if (s.exiting) return `cm-x-${s.exiting.effect} ${s.exiting.duration}s cubic-bezier(.4,0,.8,.4) both`; const en = this.trans(slide).enter; return en.effect !== "none" ? `cm-t-${en.effect}-${s.transTick % 2 ? "a" : "b"} ${en.duration}s cubic-bezier(.2,.8,.2,1) both` : "none"; })(),
      prev: () => this.prev(), next: () => this.next(),
      hasSteps: steps.length > 0, stepCount: steps.length, playStep: s.playStep,
      playFromCurrent: () => set({mode:"play", menu:null, sels:[], editing:null, playStep:0}), playFromStart: () => set({mode:"play", cur:0, menu:null, sels:[], editing:null, playStep:0}), exitPlay: () => set({mode:"view", fs:false, playStep:0}),
      toggleFullscreen: () => set({fs:!s.fs}), fsLabel: s.fs ? "Exit fullscreen" : "Fullscreen",
      viewNormal: () => set({view:"normal"}), viewGrid: () => set({view:"grid", sels:[], editing:null}),
      normalBg: nv.bg, normalColor: s.view==="normal" ? "#C8233B" : "#6E635F", normalShadow: nv.shadow,
      gridBg: gv.bg, gridColor: s.view==="grid" ? "#C8233B" : "#6E635F", gridShadow: gv.shadow,
      isChat: s.side==="chat", isStyle: s.side==="style", isAnimate: s.side==="animate", pickChat: () => set({side:"chat"}), pickStyle: () => set({side:"style"}), pickAnimate: () => set({side:"animate"}),
      chatTabBg: chatT.bg, chatTabColor: chatT.color, chatTabShadow: chatT.shadow, styleTabBg: styleT.bg, styleTabColor: styleT.color, styleTabShadow: styleT.shadow, animTabBg: animT.bg, animTabColor: animT.color, animTabShadow: animT.shadow,
      hasAnims: animOrder.length > 0, noAnims: animOrder.length === 0, animCount: this.animBlocks(slide).length,
      canAddAnim: sels.length === 1 && first && !first.anim, addAnim: () => this.addAnim(sels[0]),
      previewAll: () => this.previewAll(), previewDisabled: !steps.length || !!s.preview, previewOpacity: (!steps.length || !!s.preview) ? .5 : 1,
      effectOptions: EFFECTS.map(([v,label]) => ({v, label})), triggerOptions: TRIGGERS.map(([v,label]) => ({v, label})),
      animItems: this.animBlocks(slide).map((b, i) => { const e = b.lead, a = e.anim, active = b.ids.every(id => sels.includes(id)) && sels.length === b.ids.length; const name = b.gid ? ((slide.groupNames || {})[b.gid] || "Group") + ` (${b.ids.length})` : e.name; return {n: i+1, name, effect: a.effect, trigger: a.trigger, duration: a.duration, delay: a.delay, triggerLabel: (TRIGGERS.find(t => t[0] === a.trigger) || [])[1],
        border: active ? "#F5C6CC" : "#ECE5E2", shadow: active ? "0 0 0 2px #FDE8EA" : "none",
        select: () => set({sels: b.ids, groupDepth: 0}), setEffect: (ev) => this.setAnimIds(b.ids, {effect: ev.target.value}), setTrigger: (ev) => { const v = ev.target.value; const sl2 = this.slide(); this.updateSlide({elements: sl2.elements.map(x => b.ids.includes(x.id) ? {...x, anim: {...x.anim, trigger: x.id === b.ids[0] ? v : "with"}} : x)}); },
        setDuration: (ev) => this.setAnimIds(b.ids, {duration: +ev.target.value}), setDelay: (ev) => this.setAnimIds(b.ids, {delay: +ev.target.value}),
        up: (ev) => { ev.stopPropagation(); this.moveAnimBlock(i, -1); }, down: (ev) => { ev.stopPropagation(); this.moveAnimBlock(i, 1); }, remove: (ev) => { ev.stopPropagation(); this.removeAnimIds(b.ids); }, preview: (ev) => { ev.stopPropagation(); this.previewOne(b.ids[0]); }}; }),
      messages: s.messages.map(m => ({...m, isAuthor: m.role==="author", isAgent: m.role==="agent", isCommand: m.role==="command", done: m.state==="completed", running: m.state==="in_progress"})),
      onDraft: (e) => set({draft: e.target.value}),
      send: (e) => { e.preventDefault(); const t = s.draft.trim(); if (!t) return; set({draft:"", messages: [...s.messages, {role:"author", text:t}]}); },
      draftKey: (e) => { if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) { e.preventDefault(); const t = s.draft.trim(); if (t) set({draft:"", messages: [...s.messages, {role:"author", text:t}]}); } },
      onNote: (e) => set({note: e.target.value}),
      ctxOpen: !!s.ctxMenu, ctxMenu: s.ctxMenu || {}, ctxItems: this.ctxItems(),
      outline: s.outline, onOutline: (e) => set({outline: e.target.value}), generating: s.generating, notGenerating: !s.generating,
      outlineModal: s.outlineModal, closeOutline: () => set({outlineModal:false}),
      outlineCount: outlineLines.length ? `${outlineSlides} slide${outlineSlides === 1 ? "" : "s"} from ${outlineLines.length} line${outlineLines.length === 1 ? "" : "s"}` : "Tip: indent a line to make it a subtitle",
      generate: () => this.generate(), generateDisabled: !outlineLines.length || s.generating, generateOpacity: (!outlineLines.length || s.generating) ? .5 : 1, generateLabel: s.generating ? "Drafting…" : "Draft with agent",
      blankSlide: () => this.addSlide(0),
      styleSections: (first ? (first.type === "text" ? [
        {label:"Text", fields:[{label:"Font", value:"Noto Sans TC", span:"1 / -1"}, {label:"Size", value: String(Math.round(first.size * 12.8)), unit:"px"}, {label:"Weight", value: String(first.weight)}, {label:"Text color", value: first.color.toUpperCase(), swatch: first.color, span:"1 / -1"}, {label:"Align", value: first.align || "left"}]},
        {label:"Position", fields:[{label:"X", value: String(first.box.l), unit:"%"}, {label:"Y", value: String(first.box.t), unit:"%"}, {label:"W", value: String(first.box.w), unit:"%"}, {label:"H", value: String(first.box.h), unit:"%"}]},
      ] : first.type === "table" || first.type === "chart" ? [
        {label:"Position", fields:[{label:"X", value: String(first.box.l), unit:"%"}, {label:"Y", value: String(first.box.t), unit:"%"}, {label:"W", value: String(first.box.w), unit:"%"}, {label:"H", value: String(first.box.h), unit:"%"}]},
      ] : [
        {label:"Fill", fields:[{label:"Fill color", value: (first.fill || "").toUpperCase(), placeholder:"—", swatch: first.fill || "transparent", span:"1 / -1"}]},
        {label:"Position", fields:[{label:"X", value: String(first.box.l), unit:"%"}, {label:"Y", value: String(first.box.t), unit:"%"}, {label:"W", value: String(first.box.w), unit:"%"}, {label:"H", value: String(first.box.h), unit:"%"}]},
      ]) : []).concat([{label:"Appearance", fields:[{label:"Opacity", value:"1"}, {label:"Animation", value: first && first.anim ? (EFFECTS.find(x => x[0] === first.anim.effect) || [])[1] : "", placeholder:"None"}]}])
        .map(sec => ({...sec, fields: sec.fields.map(f => ({...f, span: f.span || "auto", hasSwatch: !!f.swatch, hasUnit: !!f.unit, placeholder: f.placeholder || "", borderColor: "#ECE5E2", borderStyle: "solid"}))})),
      templates: TEMPLATES.map(t => ({...t, use: () => this.addSlide(curIdx + (hasSlides ? 1 : 0), t)})), templateCount: TEMPLATES.length,
    };
  }
}
