package app

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"html"
	"io"
	"io/ioutil"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
)

type Server struct {
	store        *Store
	baidu        *BaiduClient
	dataDir      string
	authMu       sync.Mutex
	authSessions map[string]*BaiduQRSession
}

func New(dataDir string) (*Server, error) {
	store, err := NewStore(dataDir)
	if err != nil {
		return nil, err
	}
	return &Server{store: store, baidu: NewBaiduClient(), dataDir: dataDir, authSessions: make(map[string]*BaiduQRSession)}, nil
}

func (s *Server) Routes() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("/", s.index)
	mux.HandleFunc("/admin", s.index)
	mux.HandleFunc("/api/session", s.session)
	mux.HandleFunc("/api/login", s.login)
	mux.HandleFunc("/api/session/logout", s.sessionLogout)
	mux.HandleFunc("/api/status", s.status)
	mux.HandleFunc("/api/settings", s.settings)
	mux.HandleFunc("/api/auth/url", s.authURL)
	mux.HandleFunc("/api/auth/session", s.authSession)
	mux.HandleFunc("/api/auth/qrcode", s.authQRCode)
	mux.HandleFunc("/api/auth/qrcode-image", s.authQRCodeImage)
	mux.HandleFunc("/api/auth/poll", s.authPoll)
	mux.HandleFunc("/api/auth/exchange", s.exchange)
	mux.HandleFunc("/api/auth/refresh", s.refresh)
	mux.HandleFunc("/api/auth/logout", s.logout)
	mux.HandleFunc("/auth/callback", s.authCallback)
	mux.HandleFunc("/auth/code", s.authCodeCallback)
	mux.HandleFunc("/api/files", s.files)
	mux.HandleFunc("/api/mkdir", s.mkdir)
	mux.HandleFunc("/api/delete", s.delete)
	mux.HandleFunc("/api/rename", s.rename)
	mux.HandleFunc("/api/move", s.move)
	mux.HandleFunc("/api/copy", s.copyFile)
	mux.HandleFunc("/api/upload", s.upload)
	mux.HandleFunc("/api/text", s.textFile)
	mux.HandleFunc("/api/download-link", s.downloadLink)
	mux.HandleFunc("/download", s.download)
	mux.HandleFunc("/d/", s.shortDownload)
	mux.HandleFunc("/preview", s.preview)
	mux.HandleFunc("/favicon.ico", s.favicon)
	mux.Handle("/static/", http.StripPrefix("/static/", http.FileServer(http.Dir("./web/static"))))
	return s.cookieAuth(mux)
}

func (s *Server) cookieAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/" || r.URL.Path == "/admin" || r.URL.Path == "/favicon.ico" || strings.HasPrefix(r.URL.Path, "/static/") ||
			r.URL.Path == "/api/session" || r.URL.Path == "/api/login" || r.URL.Path == "/auth/callback" || r.URL.Path == "/auth/code" {
			next.ServeHTTP(w, r)
			return
		}
		if !s.validSession(r) {
			fail(w, http.StatusUnauthorized, "请先登录后台")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func (s *Server) index(w http.ResponseWriter, r *http.Request) {
	http.ServeFile(w, r, "./web/static/index.html")
}

func (s *Server) favicon(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Content-Type", "image/svg+xml")
	http.ServeFile(w, r, "./web/static/favicon.svg")
}

func (s *Server) session(w http.ResponseWriter, r *http.Request) {
	cfg := s.store.Get()
	writeJSON(w, map[string]interface{}{
		"ok":        true,
		"logged_in": s.validSession(r),
		"siteTitle": cfg.SiteTitle,
	})
}

func (s *Server) login(w http.ResponseWriter, r *http.Request) {
	var in struct {
		User string `json:"user"`
		Pass string `json:"pass"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	cfg := s.store.Get()
	if strings.TrimSpace(in.User) != cfg.AdminUser || in.Pass != cfg.AdminPass {
		fail(w, http.StatusUnauthorized, "账号或密码错误")
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name:     "bpdrive_session",
		Value:    s.signSession(cfg.AdminUser, time.Now().Add(24*time.Hour).Unix()),
		Path:     "/",
		MaxAge:   86400,
		HttpOnly: true,
		SameSite: http.SameSiteLaxMode,
	})
	writeJSON(w, ok())
}

func (s *Server) sessionLogout(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: "bpdrive_session", Value: "", Path: "/", MaxAge: -1, HttpOnly: true, SameSite: http.SameSiteLaxMode})
	writeJSON(w, ok())
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	cfg := s.store.Get()
	writeJSON(w, map[string]interface{}{
		"configured": true,
		"logged_in":  cfg.Token.AccessToken != "",
		"user":       cfg.User,
		"defaultDir": cfg.DefaultDir,
		"siteTitle":  cfg.SiteTitle,
		"authURL":    s.authURLForRequest(r, cfg),
	})
}

func (s *Server) settings(w http.ResponseWriter, r *http.Request) {
	if r.Method == "GET" {
		cfg := s.store.Get()
		writeJSON(w, map[string]interface{}{
			"default_dir": cfg.DefaultDir, "site_title": cfg.SiteTitle, "admin_user": cfg.AdminUser,
		})
		return
	}
	if r.Method != "POST" {
		fail(w, http.StatusMethodNotAllowed, "method not allowed")
		return
	}
	var in struct {
		DefaultDir string `json:"default_dir"`
		SiteTitle  string `json:"site_title"`
		AdminUser  string `json:"admin_user"`
		AdminPass  string `json:"admin_pass"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	err := s.store.Update(func(c *Config) {
		c.DefaultDir = CleanPath(in.DefaultDir)
		c.SiteTitle = strings.TrimSpace(in.SiteTitle)
		if strings.TrimSpace(in.AdminUser) != "" {
			c.AdminUser = strings.TrimSpace(in.AdminUser)
		}
		if strings.TrimSpace(in.AdminPass) != "" {
			c.AdminPass = strings.TrimSpace(in.AdminPass)
		}
	})
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, ok())
}

func (s *Server) authURL(w http.ResponseWriter, r *http.Request) {
	cfg := s.store.Get()
	writeJSON(w, map[string]interface{}{"url": s.authURLForRequest(r, cfg)})
}

func (s *Server) authQRCode(w http.ResponseWriter, r *http.Request) {
	s.authQRCodeImage(w, r)
}

func (s *Server) authCallback(w http.ResponseWriter, r *http.Request) {
	param := r.URL.Query().Get("param")
	if param == "" {
		fail(w, 400, "授权失败，未收到百度授权参数")
		return
	}
	var token Token
	if err := json.Unmarshal([]byte(param), &token); err != nil {
		fail(w, 400, "授权参数解析失败: "+err.Error())
		return
	}
	if token.AccessToken == "" {
		fail(w, 400, "授权失败，未取得 access_token")
		return
	}
	if token.CreatedAt == 0 {
		token.CreatedAt = time.Now().Unix()
	}
	user, _ := s.baidu.UserInfo(token.AccessToken)
	if err := s.store.Update(func(c *Config) { c.Token = token; c.User = user }); err != nil {
		fail(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	title := html.EscapeString(s.store.Get().SiteTitle)
	_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title><meta http-equiv="refresh" content="1;url=/"></head><body>授权成功，正在返回 ` + title + `。<script>setTimeout(function(){location.href="/"},500)</script></body></html>`))
}

func (s *Server) authCodeCallback(w http.ResponseWriter, r *http.Request) {
	code := strings.TrimSpace(r.URL.Query().Get("code"))
	if code == "" {
		fail(w, 400, "授权失败，未收到 code")
		return
	}
	cfg := s.store.Get()
	token, err := s.baidu.ExchangeCode(cfg, code)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	user, _ := s.baidu.UserInfo(token.AccessToken)
	if err := s.store.Update(func(c *Config) { c.Token = token; c.User = user }); err != nil {
		fail(w, 500, err.Error())
		return
	}
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	title := html.EscapeString(s.store.Get().SiteTitle)
	_, _ = w.Write([]byte(`<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>授权成功</title><meta http-equiv="refresh" content="1;url=/"></head><body>授权成功，正在返回 ` + title + `。<script>setTimeout(function(){location.href="/"},500)</script></body></html>`))
}

func (s *Server) exchange(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code string `json:"code"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	cfg := s.store.Get()
	token, err := s.baidu.ExchangeCode(cfg, in.Code)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	user, _ := s.baidu.UserInfo(token.AccessToken)
	if err := s.store.Update(func(c *Config) { c.Token = token; c.User = user }); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, map[string]interface{}{"ok": true, "user": user})
}

func (s *Server) refresh(w http.ResponseWriter, r *http.Request) {
	cfg := s.store.Get()
	token, err := s.baidu.Refresh(cfg)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	user, _ := s.baidu.UserInfo(token.AccessToken)
	if err := s.store.Update(func(c *Config) { c.Token = token; c.User = user }); err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, ok())
}

func (s *Server) logout(w http.ResponseWriter, r *http.Request) {
	_ = s.store.Update(func(c *Config) { c.Token = Token{}; c.User = User{} })
	writeJSON(w, ok())
}

func (s *Server) files(w http.ResponseWriter, r *http.Request) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	rel := CleanPath(r.URL.Query().Get("path"))
	real := JoinUnderRoot(cfg.DefaultDir, rel)
	list, err := s.baidu.List(cfg.Token.AccessToken, real)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	for i := range list {
		list[i].RelPath = RelativeToRoot(cfg.DefaultDir, list[i].Path)
		list[i].SizeText = humanSize(list[i].Size)
		if list[i].ServerMTime > 0 {
			list[i].MTimeText = time.Unix(list[i].ServerMTime, 0).Format("2006-01-02 15:04")
		}
	}
	writeJSON(w, map[string]interface{}{"path": rel, "realPath": real, "root": cfg.DefaultDir, "list": list})
}

func (s *Server) mkdir(w http.ResponseWriter, r *http.Request) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	var in struct{ Path, Name string }
	if !decodeJSON(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || strings.Contains(name, "/") {
		fail(w, 400, "文件夹名称不合法")
		return
	}
	res, err := s.baidu.Mkdir(cfg.Token.AccessToken, JoinUnderRoot(cfg.DefaultDir, in.Path)+"/"+name)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) delete(w http.ResponseWriter, r *http.Request) {
	s.fileManager(w, r, "delete")
}

func (s *Server) rename(w http.ResponseWriter, r *http.Request) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	var in struct{ Path, Name string }
	if !decodeJSON(w, r, &in) {
		return
	}
	name := strings.TrimSpace(in.Name)
	if name == "" || strings.Contains(name, "/") {
		fail(w, 400, "文件名不合法")
		return
	}
	filelist := []map[string]string{{"path": JoinUnderRoot(cfg.DefaultDir, in.Path), "newname": name}}
	res, err := s.baidu.FileManager(cfg.Token.AccessToken, "rename", filelist)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) move(w http.ResponseWriter, r *http.Request) {
	s.transfer(w, r, "move")
}

func (s *Server) copyFile(w http.ResponseWriter, r *http.Request) {
	s.transfer(w, r, "copy")
}

func (s *Server) transfer(w http.ResponseWriter, r *http.Request, op string) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	var in struct {
		Paths []string `json:"paths"`
		Dest  string   `json:"dest"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	dest := JoinUnderRoot(cfg.DefaultDir, in.Dest)
	var filelist []map[string]string
	for _, p := range in.Paths {
		filelist = append(filelist, map[string]string{"path": JoinUnderRoot(cfg.DefaultDir, p), "dest": dest})
	}
	res, err := s.baidu.FileManager(cfg.Token.AccessToken, op, filelist)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) fileManager(w http.ResponseWriter, r *http.Request, op string) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	var in struct {
		Paths []string `json:"paths"`
	}
	if !decodeJSON(w, r, &in) {
		return
	}
	var filelist []map[string]string
	for _, p := range in.Paths {
		filelist = append(filelist, map[string]string{"path": JoinUnderRoot(cfg.DefaultDir, p)})
	}
	res, err := s.baidu.FileManager(cfg.Token.AccessToken, op, filelist)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) upload(w http.ResponseWriter, r *http.Request) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	if err := r.ParseMultipartForm(8 << 20); err != nil {
		fail(w, 400, err.Error())
		return
	}
	file, header, err := r.FormFile("file")
	if err != nil {
		fail(w, 400, "未收到上传文件")
		return
	}
	defer file.Close()
	tmp, err := ioutil.TempFile(s.dataDir, "upload-*")
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	defer os.Remove(tmp.Name())
	if _, err := io.Copy(tmp, file); err != nil {
		tmp.Close()
		fail(w, 500, err.Error())
		return
	}
	tmp.Close()
	dir := JoinUnderRoot(cfg.DefaultDir, r.FormValue("path"))
	remote := CleanPath(dir + "/" + filepath.Base(header.Filename))
	res, err := s.baidu.Upload(cfg.Token.AccessToken, remote, tmp.Name(), 1)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	writeJSON(w, res)
}

func (s *Server) textFile(w http.ResponseWriter, r *http.Request) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	switch r.Method {
	case "GET":
		fsid := r.URL.Query().Get("fsid")
		u, _, _, err := s.baidu.DownloadInfo(cfg.Token.AccessToken, fsid)
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		form := url.Values{"access_token": {cfg.Token.AccessToken}}
		req, err := http.NewRequest("POST", u, strings.NewReader(form.Encode()))
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
		req.Header.Set("User-Agent", "pan.baidu.com")
		req.Header.Set("Referer", "https://pan.baidu.com/")
		resp, err := (&http.Client{}).Do(req)
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		defer resp.Body.Close()
		if resp.StatusCode >= 400 {
			body, _ := ioutil.ReadAll(io.LimitReader(resp.Body, 1<<20))
			fail(w, resp.StatusCode, string(body))
			return
		}
		body, _ := ioutil.ReadAll(io.LimitReader(resp.Body, 2<<20))
		writeJSON(w, map[string]interface{}{"content": string(body)})
	case "POST":
		var in struct{ Path, Content string }
		if !decodeJSON(w, r, &in) {
			return
		}
		tmp, err := ioutil.TempFile(s.dataDir, "edit-*")
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		if _, err := tmp.WriteString(in.Content); err != nil {
			tmp.Close()
			os.Remove(tmp.Name())
			fail(w, 500, err.Error())
			return
		}
		tmp.Close()
		defer os.Remove(tmp.Name())
		res, err := s.baidu.Upload(cfg.Token.AccessToken, JoinUnderRoot(cfg.DefaultDir, in.Path), tmp.Name(), 3)
		if err != nil {
			fail(w, 500, err.Error())
			return
		}
		writeJSON(w, res)
	default:
		fail(w, 405, "method not allowed")
	}
}

func (s *Server) downloadLink(w http.ResponseWriter, r *http.Request) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	fsid := r.URL.Query().Get("fsid")
	u, name, err := s.baidu.DownloadURL(cfg.Token.AccessToken, fsid)
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	proxy := "/download?fsid=" + url.QueryEscape(fsid)
	if strings.TrimSpace(name) != "" {
		proxy += "&name=" + url.QueryEscape(name)
	}
	writeJSON(w, map[string]interface{}{"url": u, "name": name, "proxy": proxy})
}

func (s *Server) download(w http.ResponseWriter, r *http.Request) {
	s.streamBaiduFile(w, r, false)
}

func (s *Server) shortDownload(w http.ResponseWriter, r *http.Request) {
	fsid := strings.TrimPrefix(r.URL.Path, "/d/")
	if fsid == "" {
		fail(w, http.StatusBadRequest, "缺少文件 fsid")
		return
	}
	q := r.URL.Query()
	q.Set("fsid", fsid)
	r.URL.RawQuery = q.Encode()
	s.streamBaiduFile(w, r, false)
}

func (s *Server) preview(w http.ResponseWriter, r *http.Request) {
	s.streamBaiduFile(w, r, true)
}

func (s *Server) streamBaiduFile(w http.ResponseWriter, r *http.Request, inline bool) {
	cfg, ok := s.requireToken(w)
	if !ok {
		return
	}
	u, name, size, err := s.baidu.DownloadInfo(cfg.Token.AccessToken, r.URL.Query().Get("fsid"))
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	if requestedName := strings.TrimSpace(r.URL.Query().Get("name")); requestedName != "" {
		name = requestedName
	}
	form := url.Values{"access_token": {cfg.Token.AccessToken}}
	req, err := http.NewRequest("POST", u, strings.NewReader(form.Encode()))
	if err != nil {
		fail(w, 500, err.Error())
		return
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	req.Header.Set("User-Agent", "pan.baidu.com")
	req.Header.Set("Referer", "https://pan.baidu.com/")
	if rg := r.Header.Get("Range"); rg != "" {
		req.Header.Set("Range", rg)
	}
	resp, err := (&http.Client{}).Do(req)
	if err != nil {
		fail(w, 502, err.Error())
		return
	}
	defer resp.Body.Close()
	if resp.StatusCode >= 400 {
		w.WriteHeader(resp.StatusCode)
		_, _ = io.Copy(w, resp.Body)
		return
	}
	ct := resp.Header.Get("Content-Type")
	if ct == "" || ct == "application/octet-stream" {
		if guessed := mime.TypeByExtension(strings.ToLower(filepath.Ext(name))); guessed != "" {
			ct = guessed
		}
	}
	if ct == "" {
		ct = "application/octet-stream"
	}
	disposition := "attachment"
	if inline {
		disposition = "inline"
	}
	w.Header().Set("Content-Type", ct)
	w.Header().Set("Content-Disposition", contentDisposition(disposition, name))
	w.Header().Set("Accept-Ranges", "bytes")
	if cr := resp.Header.Get("Content-Range"); cr != "" {
		w.Header().Set("Content-Range", cr)
	}
	if cl := resp.Header.Get("Content-Length"); cl != "" {
		w.Header().Set("Content-Length", cl)
	} else if size > 0 && r.Header.Get("Range") == "" {
		w.Header().Set("Content-Length", strconv.FormatInt(size, 10))
	}
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func contentDisposition(disposition, name string) string {
	base := filepath.Base(strings.TrimSpace(name))
	if base == "." || base == "/" || base == "" {
		base = "download"
	}
	fallback := asciiFilename(base)
	return disposition + `; filename="` + fallback + `"; filename*=UTF-8''` + url.PathEscape(base)
}

func asciiFilename(name string) string {
	var b strings.Builder
	for _, r := range name {
		if r >= 32 && r <= 126 && r != '"' && r != '\\' && r != ';' {
			b.WriteRune(r)
			continue
		}
		b.WriteByte('_')
	}
	fallback := strings.Trim(b.String(), " .")
	if fallback == "" {
		ext := filepath.Ext(name)
		if ext != "" && ext != name {
			fallback = "download" + ext
		} else {
			fallback = "download"
		}
	}
	return fallback
}

func (s *Server) requireToken(w http.ResponseWriter) (Config, bool) {
	cfg := s.store.Get()
	if cfg.Token.AccessToken == "" {
		fail(w, 401, "请先扫码授权百度网盘")
		return cfg, false
	}
	if cfg.Token.ExpiresIn > 0 && time.Now().Unix()-cfg.Token.CreatedAt > cfg.Token.ExpiresIn-3600 {
		if token, err := s.baidu.Refresh(cfg); err == nil {
			_ = s.store.Update(func(c *Config) { c.Token = token })
			cfg = s.store.Get()
		}
	}
	return cfg, true
}

func (s *Server) authURLForRequest(r *http.Request, cfg Config) string {
	return AuthURL(cfg) + "&state=" + strconv.FormatInt(time.Now().UnixNano(), 10)
}

func (s *Server) validSession(r *http.Request) bool {
	cookie, err := r.Cookie("bpdrive_session")
	if err != nil || cookie.Value == "" {
		return false
	}
	parts := strings.Split(cookie.Value, "|")
	if len(parts) != 3 {
		return false
	}
	user := parts[0]
	exp, err := strconv.ParseInt(parts[1], 10, 64)
	if err != nil || time.Now().Unix() > exp {
		return false
	}
	cfg := s.store.Get()
	if user != cfg.AdminUser {
		return false
	}
	return hmac.Equal([]byte(parts[2]), []byte(s.sessionMAC(user, exp, cfg.AdminPass)))
}

func (s *Server) signSession(user string, exp int64) string {
	cfg := s.store.Get()
	return user + "|" + strconv.FormatInt(exp, 10) + "|" + s.sessionMAC(user, exp, cfg.AdminPass)
}

func (s *Server) sessionMAC(user string, exp int64, secret string) string {
	mac := hmac.New(sha256.New, []byte("bpdrive:"+secret))
	_, _ = mac.Write([]byte(user + "|" + strconv.FormatInt(exp, 10)))
	return hex.EncodeToString(mac.Sum(nil))
}

func decodeJSON(w http.ResponseWriter, r *http.Request, out interface{}) bool {
	if r.Method != "POST" && r.Method != "PUT" {
		fail(w, 405, "method not allowed")
		return false
	}
	defer r.Body.Close()
	if err := json.NewDecoder(r.Body).Decode(out); err != nil {
		fail(w, 400, "JSON 参数错误: "+err.Error())
		return false
	}
	return true
}

func writeJSON(w http.ResponseWriter, v interface{}) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	_ = json.NewEncoder(w).Encode(v)
}

func fail(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	writeJSON(w, map[string]interface{}{"ok": false, "error": msg})
}

func ok() map[string]interface{} {
	return map[string]interface{}{"ok": true}
}

func humanSize(n int64) string {
	if n <= 0 {
		return "-"
	}
	units := []string{"B", "KB", "MB", "GB", "TB"}
	f := float64(n)
	i := 0
	for f >= 1024 && i < len(units)-1 {
		f /= 1024
		i++
	}
	return strconv.FormatFloat(f, 'f', 1, 64) + " " + units[i]
}
