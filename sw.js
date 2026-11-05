// Lets the app open with no connection. The app's own files are fetched fresh
// whenever possible, so a deploy shows up right away; the saved copies are only
// used when offline. Firestore, the AI Worker and audio files are never cached.
var CACHE = "lecture-notes-v1";
var APP_FILES = [
  "./", "./index.html", "./study-lib.js", "./firebase-config.js", "./supabase-config.js",
  "./ai-config.js", "./r2-config.js", "./manifest.webmanifest", "./icon-192.png", "./icon-512.png"
];
var CDN_HOSTS = ["www.gstatic.com", "cdn.jsdelivr.net", "fonts.googleapis.com", "fonts.gstatic.com"];

self.addEventListener("install", function(event){
  event.waitUntil(caches.open(CACHE).then(function(cache){ return cache.addAll(APP_FILES); }).then(function(){ return self.skipWaiting(); }));
});
self.addEventListener("activate", function(event){
  event.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});
self.addEventListener("fetch", function(event){
  var req = event.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  var sameOrigin = url.origin === self.location.origin;
  if (!sameOrigin && CDN_HOSTS.indexOf(url.hostname) === -1) return;
  event.respondWith(fetch(req).then(function(res){
    if (res.ok){
      var copy = res.clone();
      caches.open(CACHE).then(function(cache){ cache.put(req, copy); });
    }
    return res;
  }).catch(function(){
    return caches.match(req).then(function(hit){
      if (hit) return hit;
      if (req.mode === "navigate") return caches.match("./index.html");
      return Response.error();
    });
  }));
});
