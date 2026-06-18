const $ = (id) => document.getElementById(id);
let currentPath = "/";
let selected = new Set();
let editingPath = "";
let statusCache = null;
let modalResolver = null;
let authPollTimer = null;
let booted = false;
let previewFile = null;
let videoFile = null;
let currentItems = [];
let currentImages = [];
let currentVideos = [];
let currentAudios = [];
let currentPage = 1;
let pageSize = 50;
let previewIndex = -1;
let videoIndex = -1;
let audioIndex = -1;
let imageZoom = 1;
let audioFile = null;
let textFile = null;
let dragState = null;
let shareLinks = {native: "", local: ""};
let currentAuthSession = "";
let authPollInFlight = false;

async function api(url, opts = {}) {
  const res = await fetch(url, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && shouldShowLogin(url, data)) showLogin(data.error || "请先登录后台");
  if (!res.ok || data.ok === false) throw new Error(data.error || res.statusText);
  return data;
}

function shouldShowLogin(url, data = {}) {
  const path = String(url || "");
  const error = String(data.error || "");
  return path === "/api/session" || path === "/api/login" || error.includes("后台");
}

function post(url, body) {
  return api(url, {method: "POST", headers: {"Content-Type": "application/json"}, body: JSON.stringify(body)});
}

function toast(msg) {
  $("toast").textContent = msg;
  $("toast").classList.add("active");
  clearTimeout(window.__toastTimer);
  window.__toastTimer = setTimeout(() => $("toast").classList.remove("active"), 2600);
}

function showLogin(message = "") {
  $("loginOverlay").classList.add("active");
  document.body.classList.add("login-mode");
  $("loginError").textContent = message;
  setTimeout(() => $("loginPass").focus(), 20);
}

function hideLogin() {
  $("loginOverlay").classList.remove("active");
  document.body.classList.remove("login-mode");
  $("loginError").textContent = "";
}

async function checkSession() {
  const s = await api("/api/session");
  setSiteTitle(s.siteTitle);
  if (!s.logged_in) {
    showLogin();
    return false;
  }
  hideLogin();
  return true;
}

function setSiteTitle(title) {
  const name = title || "度盘";
  $("title").textContent = name;
  $("brandTitle").textContent = name;
  $("loginBrandTitle").textContent = name;
  document.title = name;
}

function switchTab(id) {
  document.querySelectorAll(".nav,.panel").forEach(x => x.classList.remove("active"));
  document.querySelector(`.nav[data-tab="${id}"]`)?.classList.add("active");
  $(id).classList.add("active");
}

function ask(title, label, value = "") {
  $("modalTitle").textContent = title;
  $("modalLabel").textContent = label;
  $("modalInput").value = value;
  $("modal").showModal();
  $("modalInput").focus();
  $("modalInput").select();
  return new Promise(resolve => modalResolver = resolve);
}

function closeAsk(value) {
  $("modal").close();
  if (modalResolver) modalResolver(value);
  modalResolver = null;
}

function dirname(p) {
  if (!p || p === "/") return "/";
  const parts = p.split("/").filter(Boolean);
  parts.pop();
  return "/" + parts.join("/");
}

function basename(p) {
  return (p || "/").split("/").filter(Boolean).pop() || "/";
}

function isText(name) {
  return /\.(txt|md|json|csv|log|ini|conf|yaml|yml|xml|html|css|js|go|rs|php|py|sh)$/i.test(name);
}

function isImage(name) {
  return /\.(png|jpe?g|gif|webp|bmp|svg|ico|heic)$/i.test(name || "");
}

function isVideo(name) {
  return /\.(mp4|mkv|mov|avi|wmv|flv|webm|m4v)$/i.test(name || "");
}

function isAudio(name) {
  return /\.(mp3|flac|wav|aac|ogg|m4a|ape)$/i.test(name || "");
}

function fileKind(name, isDir) {
  if (isDir) return {cls: "folder", label: "文件夹"};
  const n = String(name || "").toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|ico|heic)$/.test(n)) return {cls: "image", label: "图片"};
  if (/\.(mp4|mkv|mov|avi|wmv|flv|webm|m4v)$/.test(n)) return {cls: "video", label: "视频"};
  if (/\.(mp3|flac|wav|aac|ogg|m4a|ape)$/.test(n)) return {cls: "audio", label: "音频"};
  if (/\.(zip|rar|7z|tar|gz|bz2|xz)$/.test(n)) return {cls: "archive", label: "压缩包"};
  if (/\.pdf$/.test(n)) return {cls: "pdf", label: "PDF"};
  if (/\.(docx?|rtf)$/.test(n)) return {cls: "doc", label: "文档"};
  if (/\.(xlsx?|csv)$/.test(n)) return {cls: "sheet", label: "表格"};
  if (/\.(pptx?)$/.test(n)) return {cls: "slide", label: "演示"};
  if (/\.(js|ts|go|php|py|sh|rs|java|c|cpp|css|html|xml|json|ya?ml)$/.test(n)) return {cls: "code", label: "代码"};
  if (isText(n)) return {cls: "text", label: "文本"};
  return {cls: "file", label: "文件"};
}

function escapeAttr(value) {
  return String(value ?? "").replace(/[&<>"']/g, ch => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
  }[ch]));
}

async function loadStatus() {
  const s = await api("/api/status");
  statusCache = s;
  setSiteTitle(s.siteTitle);
  $("userLine").textContent = s.logged_in
    ? `已授权：${s.user.netdisk_name || s.user.baidu_name || "百度用户"}，默认目录 ${s.defaultDir}`
    : "等待扫码授权";
  $("metricAuth").textContent = s.logged_in ? "已授权" : "待授权";
  if (!s.logged_in) renderQR();
  updateAuthPolling(s);
  return s;
}

async function renderQR(force = false) {
  if (currentAuthSession && !force) return;
  const img = $("authFrame");
  const empty = $("qrEmpty");
  const status = $("qrStatus");
  currentAuthSession = "";
  empty.textContent = "正在创建百度官方扫码会话";
  status.textContent = "正在连接百度授权服务";
  empty.style.display = "grid";
  img.style.display = "none";
  try {
    const session = await post("/api/auth/session", {});
    currentAuthSession = session.id;
    status.textContent = session.message || "等待扫码";
    img.onload = () => {
      img.style.display = "block";
      empty.style.display = "none";
    };
    img.onerror = () => {
      img.style.display = "none";
      empty.textContent = "二维码图片读取失败，请刷新";
      empty.style.display = "grid";
    };
    img.src = session.image + "&t=" + Date.now();
  } catch (err) {
    img.style.display = "none";
    empty.textContent = err.message;
    empty.style.display = "grid";
    status.textContent = "二维码创建失败";
  }
}

function updateAuthPolling(s) {
  if (authPollTimer) {
    clearInterval(authPollTimer);
    authPollTimer = null;
  }
  if (s.logged_in) return;
  authPollTimer = setInterval(async () => {
    if (authPollInFlight) return;
    authPollInFlight = true;
    try {
      if (currentAuthSession) {
        const auth = await api("/api/auth/poll?id=" + encodeURIComponent(currentAuthSession));
        $("qrStatus").textContent = auth.message || "等待扫码";
        if (auth.status === "expired" || auth.status === "error") {
          clearInterval(authPollTimer);
          authPollTimer = null;
          toast(auth.message || "二维码已失效");
          return;
        }
        if (!auth.logged_in) return;
      }
      const fresh = await api("/api/status");
      if (!fresh.logged_in) return;
      statusCache = fresh;
      clearInterval(authPollTimer);
      authPollTimer = null;
      currentAuthSession = "";
      toast("授权成功");
      await loadStatus();
      await loadFiles("/");
      switchTab("drive");
    } catch (_) {
    } finally {
      authPollInFlight = false;
    }
  }, 3000);
}

async function loadSettings() {
  const s = await api("/api/settings");
  $("siteTitle").value = s.site_title || "";
  $("defaultDir").value = s.default_dir || "/";
  $("adminUser").value = s.admin_user || "admin";
}

async function loadFiles(path = currentPath) {
  currentPath = path || "/";
  $("metricPath").textContent = currentPath;
  renderPathCrumbs(currentPath);
  const data = await api("/api/files?path=" + encodeURIComponent(currentPath));
  selected.clear();
  const items = data.list || [];
  currentItems = items;
  currentImages = items.filter(item => !item.isdir && isImage(itemName(item)));
  currentVideos = items.filter(item => !item.isdir && isVideo(itemName(item)));
  currentAudios = items.filter(item => !item.isdir && isAudio(itemName(item)));
  currentPage = 1;
  $("metricItems").textContent = String(items.length);
  $("tableHint").textContent = `当前根目录：${data.root || "/"}，实际路径：${data.realPath || currentPath}`;
  $("empty").style.display = items.length ? "none" : "block";
  renderFilePage();
}

function totalPages() {
  return Math.max(1, Math.ceil(currentItems.length / pageSize));
}

function pageItems() {
  const start = (currentPage - 1) * pageSize;
  return currentItems.slice(start, start + pageSize);
}

function renderFilePage() {
  const tbody = $("files");
  tbody.innerHTML = "";
  currentPage = Math.min(Math.max(1, currentPage), totalPages());
  const visibleItems = pageItems();
  for (const item of visibleItems) {
    const tr = document.createElement("tr");
    const fsid = String(item.fs_id);
    const name = item.server_filename || basename(item.rel_path);
    const kind = fileKind(name, item.isdir);
    tr.dataset.path = item.rel_path;
    tr.innerHTML = `
      <td class="select-col"><input class="row-select" type="checkbox" data-path="${escapeAttr(item.rel_path)}" aria-label="选择 ${escapeAttr(name)}" ${selected.has(item.rel_path) ? "checked" : ""}></td>
      <td><button class="file-name" title="${escapeAttr(name)}"><span class="file-icon ${kind.cls}" aria-hidden="true"><span></span></span><span class="file-main"><strong>${escapeAttr(name)}</strong><small>${kind.label}</small></span></button></td>
      <td>${item.isdir ? "-" : escapeAttr(item.size_text)}</td>
      <td>${escapeAttr(item.mtime_text || "")}</td>
      <td>${item.isdir ? "-" : `<button type="button" class="download-btn">下载</button>`}</td>`;
    tr.querySelector("input").onchange = (e) => {
      e.target.checked ? selected.add(item.rel_path) : selected.delete(item.rel_path);
      updateSelectionHint();
      syncSelectAll();
    };
    tr.querySelector(".file-name").onclick = () => openFile(item, name, fsid);
    const downloadBtn = tr.querySelector(".download-btn");
    if (downloadBtn) {
      downloadBtn.onclick = (e) => {
        e.stopPropagation();
        openDownload(fsid, name);
      };
    }
    tr.oncontextmenu = (e) => {
      e.preventDefault();
      openContextMenu(item, name, fsid, e.clientX, e.clientY);
    };
    tbody.appendChild(tr);
  }
  updatePager();
  updateSelectionHint();
  syncSelectAll();
}

function updatePager() {
  const total = currentItems.length;
  const pages = totalPages();
  const start = total ? (currentPage - 1) * pageSize + 1 : 0;
  const end = Math.min(currentPage * pageSize, total);
  $("pagerInfo").textContent = total
    ? `第 ${currentPage} / ${pages} 页，显示 ${start}-${end}，共 ${total} 项`
    : "第 1 / 1 页，共 0 项";
  $("firstPage").disabled = currentPage <= 1;
  $("prevPage").disabled = currentPage <= 1;
  $("nextPage").disabled = currentPage >= pages;
  $("lastPage").disabled = currentPage >= pages;
}

function goPage(page) {
  currentPage = Math.min(Math.max(1, page), totalPages());
  renderFilePage();
}

function itemName(item) {
  return item.server_filename || basename(item.rel_path);
}

function itemFsid(item) {
  return String(item.fs_id);
}

function renderPathCrumbs(path) {
  const nav = $("pathCrumbs");
  nav.innerHTML = "";
  addCrumb(nav, "根目录", "/");
  const parts = (path || "/").split("/").filter(Boolean);
  let next = "";
  for (const part of parts) {
    next += "/" + part;
    addCrumb(nav, part, next);
  }
}

function addCrumb(parent, label, path) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  btn.title = path;
  btn.onclick = () => loadFiles(path);
  parent.appendChild(btn);
}

function updateSelectionHint() {
  const total = currentItems.length;
  $("selectionHint").textContent = selected.size ? `已选择 ${selected.size} / ${total} 项` : "未选择项目";
}

function syncSelectAll() {
  const checkAll = $("selectAll");
  if (!checkAll) return;
  const items = pageItems();
  const total = items.length;
  const count = items.reduce((sum, item) => sum + (selected.has(item.rel_path) ? 1 : 0), 0);
  checkAll.checked = total > 0 && count === total;
  checkAll.indeterminate = count > 0 && count < total;
  checkAll.disabled = total === 0;
}

function setAllSelected(checked) {
  pageItems().forEach(item => {
    checked ? selected.add(item.rel_path) : selected.delete(item.rel_path);
  });
  document.querySelectorAll("#files .row-select").forEach(input => {
    input.checked = checked;
  });
  updateSelectionHint();
  syncSelectAll();
}

function addAction(parent, text, fn) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.onclick = (e) => {
    e.stopPropagation();
    fn(e);
  };
  parent.appendChild(b);
}

function selectedPaths() {
  return Array.from(selected);
}

async function openDownload(fsid, name = "") {
  const a = document.createElement("a");
  const params = new URLSearchParams({fsid: String(fsid)});
  if (name) params.set("name", name);
  a.href = "/download?" + params.toString();
  if (name) a.download = name;
  a.rel = "noopener";
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) {
    await navigator.clipboard.writeText(text);
    return;
  }
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-9999px";
  ta.style.top = "0";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  const ok = document.execCommand("copy");
  ta.remove();
  if (!ok) throw new Error("clipboard unavailable");
}

function openFile(item, name, fsid) {
  if (item.isdir) {
    loadFiles(item.rel_path);
    return;
  }
  if (isImage(name)) {
    previewImage(fsid, name);
    return;
  }
  if (isVideo(name)) {
    previewVideo(fsid, name);
    return;
  }
  if (isAudio(name)) {
    previewAudio(fsid, name);
    return;
  }
  if (isText(name)) {
    previewText(fsid, name, item.rel_path);
    return;
  }
  openDownload(fsid, name);
}

async function shareFile(fsid, name) {
  const d = await api("/api/download-link?fsid=" + encodeURIComponent(fsid));
  const local = new URL(location.origin + "/d/" + encodeURIComponent(fsid));
  if (d.name || name) local.searchParams.set("name", d.name || name);
  shareLinks = {
    native: d.url || "",
    local: local.toString()
  };
  $("shareTitle").textContent = name ? "分享：" + name : "分享";
  $("nativeShareLink").value = shareLinks.native || "暂无";
  $("nativeShareLink").title = shareLinks.native || "";
  $("localShareLink").value = shareLinks.local;
  $("localShareLink").title = shareLinks.local;
  $("shareModal").showModal();
}

async function previewImage(fsid, name) {
  previewIndex = currentImages.findIndex(item => itemFsid(item) === String(fsid));
  await openImage(fsid, name);
}

async function openImage(fsid, name) {
  previewFile = {fsid, name};
  const image = $("previewImage");
  const stage = $("previewStage");
  const canvas = $("previewCanvas");
  $("previewTitle").textContent = name || "图片预览";
  $("imagePreview").classList.remove("is-maximized");
  $("togglePreviewMax").textContent = "最大化";
  imageZoom = 1;
  stage.scrollLeft = 0;
  stage.scrollTop = 0;
  image.onload = () => requestAnimationFrame(() => fitImageToStage());
  image.removeAttribute("src");
  image.style.width = "";
  image.style.height = "";
  image.style.maxWidth = "";
  image.style.maxHeight = "";
  canvas.style.width = "";
  canvas.style.height = "";
  updatePreviewButtons();
  $("imagePreview").showModal();
  image.src = "/preview?fsid=" + encodeURIComponent(fsid);
}

async function previewImageAt(index) {
  if (!currentImages.length) return;
  previewIndex = ((index % currentImages.length) + currentImages.length) % currentImages.length;
  const item = currentImages[previewIndex];
  await openImage(itemFsid(item), itemName(item));
}

function fitImageToStage() {
  setImageZoom(1, true);
}

function setImageZoom(value, forceCenter = false) {
  const stage = $("previewStage");
  const canvas = $("previewCanvas");
  const image = $("previewImage");
  const oldWidth = Math.max(canvas.offsetWidth, stage.clientWidth, 1);
  const oldHeight = Math.max(canvas.offsetHeight, stage.clientHeight, 1);
  const centerX = forceCenter ? .5 : (stage.scrollLeft + stage.clientWidth / 2) / oldWidth;
  const centerY = forceCenter ? .5 : (stage.scrollTop + stage.clientHeight / 2) / oldHeight;
  imageZoom = Math.max(.2, Math.min(8, value));
  image.classList.toggle("is-zoomed", imageZoom !== 1);
  stage.classList.toggle("is-zoomed", imageZoom !== 1);
  if (!image.naturalWidth || !image.naturalHeight || !stage.clientWidth || !stage.clientHeight) {
    return;
  }
  const fit = Math.min(stage.clientWidth / image.naturalWidth, stage.clientHeight / image.naturalHeight, 1);
  const width = Math.max(1, Math.round(image.naturalWidth * fit * imageZoom));
  const height = Math.max(1, Math.round(image.naturalHeight * fit * imageZoom));
  canvas.style.width = `${Math.max(stage.clientWidth, width)}px`;
  canvas.style.height = `${Math.max(stage.clientHeight, height)}px`;
  image.style.width = `${width}px`;
  image.style.height = `${height}px`;
  image.style.maxWidth = "none";
  image.style.maxHeight = "none";
  requestAnimationFrame(() => {
    const nextWidth = Math.max(canvas.offsetWidth, stage.clientWidth, 1);
    const nextHeight = Math.max(canvas.offsetHeight, stage.clientHeight, 1);
    stage.scrollLeft = Math.max(0, nextWidth * centerX - stage.clientWidth / 2);
    stage.scrollTop = Math.max(0, nextHeight * centerY - stage.clientHeight / 2);
  });
}

function updatePreviewButtons() {
  const disabled = currentImages.length < 2 || previewIndex < 0;
  $("prevPreview").disabled = disabled;
  $("nextPreview").disabled = disabled;
}

async function previewVideo(fsid, name) {
  videoIndex = currentVideos.findIndex(item => itemFsid(item) === String(fsid));
  await openVideo(fsid, name);
}

async function openVideo(fsid, name) {
  const video = $("previewVideo");
  videoFile = {fsid, name};
  $("videoTitle").textContent = name || "视频播放";
  video.pause();
  video.src = "/preview?fsid=" + encodeURIComponent(fsid);
  video.load();
  updateVideoButtons();
  $("videoPreview").showModal();
}

async function previewVideoAt(index) {
  if (!currentVideos.length) return;
  videoIndex = ((index % currentVideos.length) + currentVideos.length) % currentVideos.length;
  const item = currentVideos[videoIndex];
  await openVideo(itemFsid(item), itemName(item));
}

function updateVideoButtons() {
  const disabled = currentVideos.length < 2 || videoIndex < 0;
  $("prevVideo").disabled = disabled;
  $("nextVideo").disabled = disabled;
}

async function previewAudio(fsid, name) {
  audioIndex = currentAudios.findIndex(item => itemFsid(item) === String(fsid));
  await openAudio(fsid, name);
}

async function openAudio(fsid, name) {
  const audio = $("previewAudio");
  audioFile = {fsid, name};
  $("audioTitle").textContent = name || "音频播放";
  audio.pause();
  audio.src = "/preview?fsid=" + encodeURIComponent(fsid);
  audio.load();
  updateAudioButtons();
  $("audioPreview").showModal();
  audio.play().catch(() => {});
}

async function previewAudioAt(index) {
  if (!currentAudios.length) return;
  audioIndex = ((index % currentAudios.length) + currentAudios.length) % currentAudios.length;
  const item = currentAudios[audioIndex];
  await openAudio(itemFsid(item), itemName(item));
}

function updateAudioButtons() {
  const disabled = currentAudios.length < 2 || audioIndex < 0;
  $("prevAudio").disabled = disabled;
  $("nextAudio").disabled = disabled;
}

async function previewText(fsid, name, path) {
  textFile = {fsid, name, path};
  $("textTitle").textContent = name || "文本预览";
  $("textContent").textContent = "正在读取...";
  $("textPreview").showModal();
  try {
    const d = await api("/api/text?fsid=" + encodeURIComponent(fsid));
    $("textContent").textContent = d.content || "";
  } catch (err) {
    $("textContent").textContent = err.message;
  }
}

function closeContextMenu() {
  $("contextMenu").classList.remove("active");
  $("contextMenu").innerHTML = "";
}

function addMenuItem(menu, label, fn, danger = false) {
  const btn = document.createElement("button");
  btn.type = "button";
  btn.textContent = label;
  if (danger) btn.className = "danger";
  btn.onclick = async (e) => {
    e.stopPropagation();
    closeContextMenu();
    await fn();
  };
  menu.appendChild(btn);
}

function openContextMenu(item, name, fsid, x, y) {
  const menu = $("contextMenu");
  menu.innerHTML = "";
  if (item.isdir) {
    addMenuItem(menu, "打开", () => loadFiles(item.rel_path));
  } else {
    if (isImage(name)) addMenuItem(menu, "预览", () => previewImage(fsid, name));
    if (isVideo(name)) addMenuItem(menu, "播放", () => previewVideo(fsid, name));
    if (isAudio(name)) addMenuItem(menu, "播放", () => previewAudio(fsid, name));
    if (isText(name)) addMenuItem(menu, "预览", () => previewText(fsid, name, item.rel_path));
    addMenuItem(menu, "下载", () => openDownload(fsid, name));
    addMenuItem(menu, "分享", () => shareFile(fsid, name));
    if (isText(name)) addMenuItem(menu, "编辑", () => editText(fsid, item.rel_path));
  }
  addMenuItem(menu, "重命名", () => renameOne(item.rel_path, name));
  addMenuItem(menu, "复制到", () => copyOne(item.rel_path));
  addMenuItem(menu, "移动到", () => moveOne(item.rel_path));
  addMenuItem(menu, "删除", () => deleteOne(item.rel_path), true);
  menu.classList.add("active");
  const rect = menu.getBoundingClientRect();
  const left = Math.min(x, window.innerWidth - rect.width - 8);
  const top = Math.min(y, window.innerHeight - rect.height - 8);
  menu.style.left = Math.max(8, left) + "px";
  menu.style.top = Math.max(8, top) + "px";
}

async function copyOne(path) {
  const dest = await ask("复制到", "目标目录", currentPath);
  if (!dest) return;
  await post("/api/copy", {paths: [path], dest});
  toast("已复制");
  loadFiles();
}

async function moveOne(path) {
  const dest = await ask("移动到", "目标目录", currentPath);
  if (!dest) return;
  await post("/api/move", {paths: [path], dest});
  toast("已移动");
  loadFiles();
}

async function deleteOne(path) {
  if (!confirm("确定删除这个文件或文件夹？")) return;
  await post("/api/delete", {paths: [path]});
  toast("已删除");
  loadFiles();
}

async function renameOne(path, oldName) {
  const name = await ask("重命名", "新名称", oldName);
  if (!name) return;
  await post("/api/rename", {path, name});
  toast("已重命名");
  loadFiles();
}

async function editText(fsid, path) {
  const d = await api("/api/text?fsid=" + encodeURIComponent(fsid));
  editingPath = path;
  $("editContent").value = d.content || "";
  $("editor").showModal();
}

document.querySelectorAll(".nav").forEach(btn => btn.onclick = () => switchTab(btn.dataset.tab));
$("selectAll").onchange = (e) => setAllSelected(e.target.checked);
$("pageSize").onchange = (e) => {
  pageSize = Number(e.target.value) || 50;
  currentPage = 1;
  renderFilePage();
};
$("firstPage").onclick = () => goPage(1);
$("prevPage").onclick = () => goPage(currentPage - 1);
$("nextPage").onclick = () => goPage(currentPage + 1);
$("lastPage").onclick = () => goPage(totalPages());

$("reload").onclick = () => loadFiles().catch(err => {
  toast(err.message);
  if (/扫码授权|百度网盘/.test(err.message)) switchTab("auth");
});
$("up").onclick = () => loadFiles(dirname(currentPath));
$("mkdir").onclick = async () => {
  const name = await ask("新建目录", "目录名称");
  if (!name) return;
  await post("/api/mkdir", {path: currentPath, name});
  toast("目录已创建");
  loadFiles();
};
$("delete").onclick = async () => {
  const paths = selectedPaths();
  if (!paths.length || !confirm("确定删除选中的文件？")) return;
  await post("/api/delete", {paths});
  toast("已删除");
  loadFiles();
};
$("copy").onclick = async () => {
  const paths = selectedPaths();
  if (!paths.length) return toast("请选择要复制的项目");
  const dest = await ask("复制到", "目标目录", currentPath);
  if (!dest) return;
  await post("/api/copy", {paths, dest});
  toast("已复制");
  loadFiles();
};
$("move").onclick = async () => {
  const paths = selectedPaths();
  if (!paths.length) return toast("请选择要移动的项目");
  const dest = await ask("移动到", "目标目录", currentPath);
  if (!dest) return;
  await post("/api/move", {paths, dest});
  toast("已移动");
  loadFiles();
};
$("file").onchange = async (e) => {
  const files = Array.from(e.target.files || []);
  if (!files.length) return;
  try {
    for (let i = 0; i < files.length; i++) {
      await uploadFile(files[i], i + 1, files.length);
    }
    toast("上传完成");
    loadFiles();
  } catch (err) {
    toast(err.message);
  } finally {
    e.target.value = "";
    hideUploadProgress();
  }
};
$("reloadQR").onclick = async () => {
  renderQR(true);
  toast("二维码已刷新");
};
$("refreshToken").onclick = async () => {
  try {
    await post("/api/auth/refresh", {});
    toast("令牌已刷新");
    await loadStatus();
  } catch (err) {
    toast("刷新令牌失败：" + err.message);
    await loadStatus().catch(() => {});
    switchTab("auth");
  }
};
$("logout").onclick = async () => {
  await post("/api/auth/logout", {});
  toast("已退出授权");
  loadStatus();
  switchTab("auth");
};
$("adminLogout").onclick = async () => {
  await post("/api/session/logout", {});
  booted = false;
  showLogin("已退出后台");
};
$("loginForm").onsubmit = async (e) => {
  e.preventDefault();
  try {
    await post("/api/login", {user: $("loginUser").value.trim(), pass: $("loginPass").value});
    $("loginPass").value = "";
    hideLogin();
    booted = false;
    await bootApp();
  } catch (err) {
    showLogin(err.message);
  }
};
$("saveSettings").onclick = async () => {
  await post("/api/settings", {
    site_title: $("siteTitle").value,
    default_dir: $("defaultDir").value,
    admin_user: $("adminUser").value,
    admin_pass: $("adminPass").value
  });
  $("adminPass").value = "";
  toast("设置已保存");
  await loadStatus();
};
$("saveText").onclick = async () => {
  await post("/api/text", {path: editingPath, content: $("editContent").value});
  $("editor").close();
  toast("文件已保存");
  loadFiles();
};
$("closeEditor").onclick = () => $("editor").close();
$("closePreview").onclick = () => $("imagePreview").close();
$("prevPreview").onclick = () => previewImageAt(previewIndex - 1);
$("nextPreview").onclick = () => previewImageAt(previewIndex + 1);
$("zoomOut").onclick = () => setImageZoom(imageZoom - .2);
$("zoomReset").onclick = () => fitImageToStage();
$("zoomIn").onclick = () => setImageZoom(imageZoom + .2);
$("togglePreviewMax").onclick = () => {
  const dialog = $("imagePreview");
  const maximized = dialog.classList.toggle("is-maximized");
  $("togglePreviewMax").textContent = maximized ? "还原" : "最大化";
  requestAnimationFrame(() => setImageZoom(imageZoom, true));
};
$("previewDownload").onclick = () => {
  if (previewFile) openDownload(previewFile.fsid, previewFile.name);
};
$("previewShare").onclick = () => {
  if (previewFile) shareFile(previewFile.fsid, previewFile.name);
};
$("closeVideo").onclick = () => $("videoPreview").close();
$("prevVideo").onclick = () => previewVideoAt(videoIndex - 1);
$("nextVideo").onclick = () => previewVideoAt(videoIndex + 1);
$("videoDownload").onclick = () => {
  if (videoFile) openDownload(videoFile.fsid, videoFile.name);
};
$("videoShare").onclick = () => {
  if (videoFile) shareFile(videoFile.fsid, videoFile.name);
};
$("closeAudio").onclick = () => $("audioPreview").close();
$("prevAudio").onclick = () => previewAudioAt(audioIndex - 1);
$("nextAudio").onclick = () => previewAudioAt(audioIndex + 1);
$("audioDownload").onclick = () => {
  if (audioFile) openDownload(audioFile.fsid, audioFile.name);
};
$("audioShare").onclick = () => {
  if (audioFile) shareFile(audioFile.fsid, audioFile.name);
};
$("closeText").onclick = () => $("textPreview").close();
$("textDownload").onclick = () => {
  if (textFile) openDownload(textFile.fsid, textFile.name);
};
$("editPreviewText").onclick = () => {
  if (!textFile) return;
  $("textPreview").close();
  editText(textFile.fsid, textFile.path);
};
$("previewStage").onwheel = (e) => {
  e.preventDefault();
  setImageZoom(imageZoom + (e.deltaY < 0 ? .15 : -.15), true);
};
$("previewStage").addEventListener("pointerdown", (e) => {
  if (e.button !== undefined && e.button !== 0) return;
  const stage = $("previewStage");
  dragState = {
    pointerId: e.pointerId,
    x: e.clientX,
    y: e.clientY,
    left: stage.scrollLeft,
    top: stage.scrollTop
  };
  stage.classList.add("is-dragging");
  if (stage.setPointerCapture) stage.setPointerCapture(e.pointerId);
  e.preventDefault();
});
$("videoPreview").addEventListener("close", () => {
  const video = $("previewVideo");
  video.pause();
  video.removeAttribute("src");
  video.load();
});
$("audioPreview").addEventListener("close", () => {
  const audio = $("previewAudio");
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
});
$("modalCancel").onclick = () => closeAsk("");
$("modalOk").onclick = () => closeAsk($("modalInput").value.trim());
$("modalInput").onkeydown = (e) => {
  if (e.key === "Enter") closeAsk($("modalInput").value.trim());
  if (e.key === "Escape") closeAsk("");
};
$("closeShare").onclick = () => $("shareModal").close();
$("nativeShareLink").onclick = () => copyShareLink("native");
$("localShareLink").onclick = () => copyShareLink("local");
document.addEventListener("click", (e) => {
  if (!$("contextMenu").contains(e.target)) closeContextMenu();
});
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeContextMenu();
  if ($("imagePreview").open && e.key === "ArrowLeft") previewImageAt(previewIndex - 1);
  if ($("imagePreview").open && e.key === "ArrowRight") previewImageAt(previewIndex + 1);
  if ($("videoPreview").open && e.key === "ArrowLeft") previewVideoAt(videoIndex - 1);
  if ($("videoPreview").open && e.key === "ArrowRight") previewVideoAt(videoIndex + 1);
  if ($("audioPreview").open && e.key === "ArrowLeft") previewAudioAt(audioIndex - 1);
  if ($("audioPreview").open && e.key === "ArrowRight") previewAudioAt(audioIndex + 1);
});
$("previewStage").addEventListener("pointermove", (e) => {
  if (!dragState || dragState.pointerId !== e.pointerId) return;
  const stage = $("previewStage");
  stage.scrollLeft = dragState.left - (e.clientX - dragState.x);
  stage.scrollTop = dragState.top - (e.clientY - dragState.y);
});

function endPreviewDrag(e) {
  if (dragState && e && e.pointerId !== dragState.pointerId) return;
  dragState = null;
  $("previewStage").classList.remove("is-dragging");
}
$("previewStage").addEventListener("pointerup", endPreviewDrag);
$("previewStage").addEventListener("pointercancel", endPreviewDrag);
$("previewStage").addEventListener("lostpointercapture", endPreviewDrag);

function uploadFile(file, index, total) {
  return new Promise((resolve, reject) => {
    const fd = new FormData();
    fd.append("path", currentPath);
    fd.append("file", file);
    const xhr = new XMLHttpRequest();
    xhr.open("POST", "/api/upload");
    xhr.upload.onprogress = (e) => {
      if (!e.lengthComputable) {
        showUploadProgress(`正在上传 ${index}/${total}：${file.name}`, 0);
        return;
      }
      showUploadProgress(`正在上传 ${index}/${total}：${file.name}`, Math.round(e.loaded / e.total * 100));
    };
    xhr.onload = () => {
      let data = {};
      try {
        data = JSON.parse(xhr.responseText || "{}");
      } catch (_) {}
      if (xhr.status === 401 && shouldShowLogin("/api/upload", data)) showLogin(data.error || "请先登录后台");
      if (xhr.status >= 200 && xhr.status < 300 && data.ok !== false) {
        showUploadProgress(`已上传 ${index}/${total}：${file.name}`, 100);
        resolve(data);
        return;
      }
      reject(new Error(data.error || xhr.statusText || "上传失败"));
    };
    xhr.onerror = () => reject(new Error("上传失败"));
    showUploadProgress(`正在上传 ${index}/${total}：${file.name}`, 0);
    xhr.send(fd);
  });
}

function showUploadProgress(name, percent) {
  $("uploadName").textContent = name;
  $("uploadPercent").textContent = percent + "%";
  $("uploadBar").style.width = percent + "%";
  $("uploadProgress").classList.add("active");
}

function hideUploadProgress() {
  setTimeout(() => $("uploadProgress").classList.remove("active"), 700);
}

async function copyShareLink(kind) {
  const link = shareLinks[kind];
  const field = $(kind + "ShareLink");
  if (field) {
    field.focus();
    field.select();
    field.setSelectionRange(0, field.value.length);
  }
  if (!link) return toast("请手动选择链接");
  await copyText(link).then(() => toast("链接已复制")).catch(() => toast("复制失败，请手动选择链接"));
}

async function bootApp() {
  if (booted) return;
  if (!await checkSession()) return;
  booted = true;
  try {
    const s = await loadStatus();
    await loadSettings();
    if (s.logged_in) {
      await loadFiles("/");
    } else {
      switchTab("auth");
    }
  } catch (e) {
    toast(e.message);
    switchTab("auth");
  }
}

bootApp();
