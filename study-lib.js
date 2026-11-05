// Helpers for index.html that don't depend on the app's state: finding the
// relevant parts of a course for the AI, spaced repetition, note formatting,
// and audio slicing.
(function(){
  "use strict";

  // -------------------------------------------------------------
  // Finding relevant lecture passages
  // -------------------------------------------------------------
  var STOPWORDS = {};
  ("a an and are as at be but by did do does for from had has have he her his how i if in into is it its me my of on or our she so that the their them they this to us was we were what when where which who why will with would you your about can could should just than then there these those been being not no").split(" ").forEach(function(w){ STOPWORDS[w] = true; });

  // Reduces common word endings, so "enzymes" also matches "enzyme".
  function stem(w){
    if (w.length > 4 && /ies$/.test(w)) return w.slice(0, -3) + "y";
    if (w.length > 5 && /ing$/.test(w)) return w.slice(0, -3);
    if (w.length > 4 && /ed$/.test(w)) return w.slice(0, -2);
    if (w.length > 3 && /s$/.test(w) && !/(ss|us|is)$/.test(w)) return w.slice(0, -1);
    return w;
  }
  function tokenize(text){
    return String(text || "").toLowerCase().split(/[^a-z0-9]+/).filter(function(w){ return w.length > 1 && !STOPWORDS[w]; }).map(stem);
  }
  function fmtStamp(sec){
    sec = Math.max(0, Math.floor(sec || 0));
    var h = Math.floor(sec/3600), m = Math.floor((sec%3600)/60), s = sec%60;
    var ss = s < 10 ? "0" + s : "" + s;
    if (h > 0) return h + ":" + (m < 10 ? "0" + m : m) + ":" + ss;
    return m + ":" + ss;
  }
  function parseStamp(str){
    var parts = String(str == null ? "" : str).trim().split(":").map(Number);
    if (!parts.length || parts.length > 3 || parts.some(isNaN)) return null;
    return parts.reduce(function(total, p){ return total*60 + p; }, 0);
  }
  // Splits text into pieces of at most maxChars, preferring paragraph and
  // sentence boundaries so no piece stops mid-thought.
  function splitText(text, maxChars){
    var out = [], current = "";
    var units = String(text || "").match(/[^.!?\n]+[.!?]*\s*|[.!?]+\s*|\n+/g) || [];
    units.forEach(function(unit){
      while (unit.length > maxChars){
        if (current.trim()){ out.push(current.trim()); current = ""; }
        out.push(unit.slice(0, maxChars));
        unit = unit.slice(maxChars);
      }
      if (current.length + unit.length > maxChars && current.trim()){ out.push(current.trim()); current = ""; }
      current += unit;
    });
    if (current.trim()) out.push(current.trim());
    return out;
  }
  // One entry's text as searchable passages, keeping timestamps where the
  // transcript has them so answers can link back to that moment in the audio.
  function entryPassages(entry, size){
    size = size || 900;
    var out = [];
    var base = { entryId: entry.id, title: entry.title || "Untitled", date: entry.date || "" };
    function add(text, t, kind){ if (text && text.trim()) out.push(Object.assign({ text: text.trim(), t: t, kind: kind }, base)); }
    if (Array.isArray(entry.segments) && entry.segments.length){
      var buf = "", start = null;
      entry.segments.forEach(function(seg){
        if (start === null) start = seg.t;
        buf += (buf ? " " : "") + seg.text;
        if (buf.length >= size){
          splitText(buf, size).forEach(function(piece){ add(piece, start, "transcript"); });
          buf = ""; start = null;
        }
      });
      if (buf) add(buf, start, "transcript");
    } else {
      splitText(entry.transcript, size).forEach(function(piece){ add(piece, null, "transcript"); });
    }
    splitText(entry.notesText, size).forEach(function(piece){ add(piece, null, "notes"); });
    return out;
  }
  function rankPassages(question, passages){
    var terms = tokenize(question).filter(function(t, i, all){ return all.indexOf(t) === i; });
    if (!terms.length || !passages.length) return [];
    var docs = passages.map(function(p){ return tokenize(p.text + " " + p.title); });
    var avgLen = docs.reduce(function(sum, d){ return sum + d.length; }, 0) / docs.length || 1;
    var df = {};
    terms.forEach(function(term){ df[term] = docs.filter(function(d){ return d.indexOf(term) > -1; }).length; });
    var scored = [];
    docs.forEach(function(doc, i){
      var score = 0;
      terms.forEach(function(term){
        if (!df[term]) return;
        var tf = doc.filter(function(w){ return w === term; }).length;
        if (!tf) return;
        var idf = Math.log(1 + (docs.length - df[term] + 0.5) / (df[term] + 0.5));
        score += idf * (tf * 2.4) / (tf + 1.4 * (0.25 + 0.75 * doc.length / avgLen));
      });
      if (score > 0) scored.push({ passage: passages[i], score: score });
    });
    scored.sort(function(a, b){ return b.score - a.score; });
    return scored.map(function(s){ return s.passage; });
  }
  // Builds what the AI reads for a question: a short overview of every entry
  // (so "what have we covered?" works) plus the passages that best match it.
  // The best matches go last: if a Worker trims the text to a smaller limit, it
  // keeps the end. `opts.terms` adds extra search words for the question.
  function buildAiContext(question, entries, opts){
    opts = opts || {};
    var budget = opts.budget || 58000;
    var usable = (entries || []).filter(function(e){ return (e.transcript || "").trim() || (e.notesText || "").trim(); });
    usable = usable.slice().sort(function(a, b){ return String(b.date || "").localeCompare(String(a.date || "")); });
    var sources = [], lines = [], used = 0;
    function addSource(p, text){
      var n = sources.length + 1;
      var line = "[S" + n + "] " + p.title + (p.date ? " (" + String(p.date).slice(0,10) + ")" : "") + (p.t != null ? " at " + fmtStamp(p.t) : "") + ": " + text;
      lines.push(line);
      used += line.length + 1;
      sources.push({ n: n, entryId: p.entryId, title: p.title, t: p.t == null ? null : p.t });
    }
    var overviewEach = usable.length ? Math.min(500, Math.floor(budget * 0.3 / usable.length)) : 0;
    if (overviewEach >= 40){
      usable.forEach(function(e){
        var overview = (e.notesText || e.cleanTranscript || e.transcript || "").replace(/\s+/g, " ").trim().slice(0, overviewEach);
        addSource({ entryId: e.id, title: e.title || "Untitled", date: e.date, t: null }, overview);
      });
    }
    var passagesByEntry = usable.map(function(e){ return entryPassages(e); });
    var all = [].concat.apply([], passagesByEntry);
    var ranked = rankPassages(question + " " + (opts.terms || []).join(" "), all);
    var bestEntryIds = [];
    ranked.slice(0, 8).forEach(function(p){ if (bestEntryIds.indexOf(p.entryId) === -1) bestEntryIds.push(p.entryId); });
    // A broad question may match nothing, so fill any leftover room evenly
    // across entries (newest first) instead of favoring a single lecture.
    var longest = passagesByEntry.reduce(function(max, list){ return Math.max(max, list.length); }, 0);
    for (var round = 0; round < longest; round++){
      passagesByEntry.forEach(function(list){ if (list[round]) ranked.push(list[round]); });
    }
    var seen = [];
    ranked.forEach(function(p){
      if (seen.indexOf(p) > -1) return;
      seen.push(p);
      if (used + p.text.length + 80 > budget) return;
      addSource(p, p.text);
    });
    var header = "Each excerpt below starts with a source tag like [S1]. Whenever you use an excerpt, cite its tag right after the claim, for example [S3]. Only cite tags listed here.";
    var overviewCount = overviewEach >= 40 ? usable.length : 0;
    var ordered = lines.slice(0, overviewCount).concat(lines.slice(overviewCount).reverse());
    return { contextText: sources.length ? ordered.join("\n") + "\n\n" + header : "", sources: sources, bestEntryIds: bestEntryIds };
  }
  // Splits an answer into plain text and [S1, S2] citation pieces.
  function splitCitations(answer){
    var out = [], re = /\[\s*(S\d+(?:\s*,\s*S\d+)*)\s*\]/g, last = 0, m;
    var str = String(answer || "");
    while ((m = re.exec(str))){
      if (m.index > last) out.push({ text: str.slice(last, m.index) });
      out.push({ refs: m[1].split(",").map(function(r){ return parseInt(r.trim().slice(1), 10); }) });
      last = m.index + m[0].length;
    }
    if (last < str.length) out.push({ text: str.slice(last) });
    return out;
  }
  function timestampedTranscript(entry){
    if (Array.isArray(entry.segments) && entry.segments.length){
      return entry.segments.map(function(s){ return "[" + fmtStamp(s.t) + "] " + s.text; }).join("\n");
    }
    return entry.transcript || "";
  }

  // -------------------------------------------------------------
  // Spaced repetition (a simplified SM-2)
  // -------------------------------------------------------------
  var DAY_MS = 24*60*60*1000;
  function scheduleCard(card, grade, nowMs){
    var c = Object.assign({}, card);
    var ease = c.ease || 2.5, reps = c.reps || 0, interval = c.interval || 0;
    if (grade === "again"){
      c.lapses = (c.lapses || 0) + 1;
      c.reps = 0;
      c.ease = Math.max(1.3, ease - 0.2);
      c.interval = 0;
      c.due = nowMs + 60*1000; // comes back later in this same session
      return c;
    }
    if (grade === "hard"){ ease = Math.max(1.3, ease - 0.15); interval = reps === 0 ? 1 : Math.max(1, interval * 1.2); }
    else if (grade === "easy"){ ease = ease + 0.15; interval = reps === 0 ? 4 : interval * ease * 1.3; }
    else { interval = reps === 0 ? 1 : (reps === 1 ? 3 : interval * ease); }
    c.ease = ease;
    c.reps = reps + 1;
    c.interval = Math.round(interval * 10) / 10;
    c.due = nowMs + c.interval * DAY_MS;
    return c;
  }
  function dueCards(cards, nowMs){
    return (cards || []).filter(function(c){ return !c.due || c.due <= nowMs; });
  }
  // Keeps review progress for cards that survive a regeneration unchanged.
  function mergeCards(existing, incoming){
    var byFront = {};
    (existing || []).forEach(function(c){ byFront[String(c.front).trim().toLowerCase()] = c; });
    var merged = (existing || []).slice();
    (incoming || []).forEach(function(c){
      if (!byFront[String(c.front).trim().toLowerCase()]) merged.push(c);
    });
    return merged;
  }

  // -------------------------------------------------------------
  // Quiz topics
  // -------------------------------------------------------------
  function recordTopicResult(stats, topic, correct){
    var list = (stats || []).map(function(s){ return Object.assign({}, s); });
    var name = String(topic || "General").trim() || "General";
    var row = list.find(function(s){ return s.topic.toLowerCase() === name.toLowerCase(); });
    if (!row){ row = { topic: name, right: 0, wrong: 0 }; list.push(row); }
    if (correct) row.right++; else row.wrong++;
    return list;
  }
  function weakTopics(stats){
    return (stats || []).filter(function(s){ return s.wrong > 0 && s.right / (s.right + s.wrong) < 0.8; })
      .sort(function(a, b){ return (a.right / (a.right + a.wrong)) - (b.right / (b.right + b.wrong)) || b.wrong - a.wrong; });
  }

  // -------------------------------------------------------------
  // Note formatting: headings, lists, bold, italic and code only.
  // -------------------------------------------------------------
  function parseInline(text){
    var spans = [], re = /(\*\*[^*]+\*\*|\*[^*\s][^*]*\*|`[^`]+`)/g, last = 0, m;
    while ((m = re.exec(text))){
      if (m.index > last) spans.push({ text: text.slice(last, m.index) });
      var token = m[0];
      if (token.indexOf("**") === 0) spans.push({ text: token.slice(2, -2), bold: true });
      else if (token.charAt(0) === "`") spans.push({ text: token.slice(1, -1), code: true });
      else spans.push({ text: token.slice(1, -1), italic: true });
      last = m.index + token.length;
    }
    if (last < text.length) spans.push({ text: text.slice(last) });
    return spans;
  }
  function parseNotes(text){
    var blocks = [], para = [];
    function flush(){ if (para.length){ blocks.push({ type: "p", spans: parseInline(para.join(" ")) }); para = []; } }
    String(text || "").split(/\r?\n/).forEach(function(line){
      var heading = line.match(/^\s*(#{1,3})\s+(.*)$/);
      var item = line.match(/^\s*[-*]\s+(.*)$/);
      if (heading){ flush(); blocks.push({ type: "h", level: heading[1].length, spans: parseInline(heading[2]) }); }
      else if (item){ flush(); blocks.push({ type: "li", spans: parseInline(item[1]) }); }
      else if (!line.trim()) flush();
      else para.push(line.trim());
    });
    flush();
    return blocks;
  }
  function spansText(spans){ return (spans || []).map(function(s){ return s.text; }).join(""); }
  // Uses text nodes only, so nothing in a note can run as HTML. With onCite,
  // [S1] tags become whatever element onCite returns for that source number.
  function renderNotes(container, text, onCite){
    container.textContent = "";
    var list = null;
    parseNotes(text).forEach(function(block){
      var node;
      if (block.type === "li"){
        if (!list){ list = document.createElement("ul"); container.appendChild(list); }
        node = document.createElement("li");
        list.appendChild(node);
      } else {
        list = null;
        node = document.createElement(block.type === "h" ? "h" + (block.level + 2) : "p");
        container.appendChild(node);
      }
      block.spans.forEach(function(span){
        var tag = span.bold ? "strong" : span.italic ? "em" : span.code ? "code" : null;
        var parent = node;
        if (tag){ parent = document.createElement(tag); node.appendChild(parent); }
        if (!onCite || span.code){ parent.appendChild(document.createTextNode(span.text)); return; }
        splitCitations(span.text).forEach(function(piece){
          if (piece.text != null){ parent.appendChild(document.createTextNode(piece.text)); return; }
          piece.refs.forEach(function(n){ var cite = onCite(n); if (cite) parent.appendChild(cite); });
        });
      });
    });
  }

  // -------------------------------------------------------------
  // Audio: cuts decoded audio into WAV clips small enough to transcribe.
  // -------------------------------------------------------------
  var TRANSCRIBE_RATE = 16000;
  function encodeWav(samples, sampleRate){
    var buffer = new ArrayBuffer(44 + samples.length * 2);
    var view = new DataView(buffer);
    function writeStr(offset, str){ for (var i = 0; i < str.length; i++) view.setUint8(offset + i, str.charCodeAt(i)); }
    writeStr(0, "RIFF"); view.setUint32(4, 36 + samples.length * 2, true); writeStr(8, "WAVE");
    writeStr(12, "fmt "); view.setUint32(16, 16, true); view.setUint16(20, 1, true); view.setUint16(22, 1, true);
    view.setUint32(24, sampleRate, true); view.setUint32(28, sampleRate * 2, true); view.setUint16(32, 2, true); view.setUint16(34, 16, true);
    writeStr(36, "data"); view.setUint32(40, samples.length * 2, true);
    for (var i = 0; i < samples.length; i++){
      var v = Math.max(-1, Math.min(1, samples[i]));
      view.setInt16(44 + i*2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return new Blob([buffer], { type: "audio/wav" });
  }
  function decodeToMono(arrayBuffer){
    var Ctx = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!Ctx) return Promise.reject(new Error("This browser can't process audio files."));
    var ctx = new Ctx(1, TRANSCRIBE_RATE, TRANSCRIBE_RATE); // decoded audio is resampled to this rate, keeping memory use low
    return ctx.decodeAudioData(arrayBuffer).then(function(buf){
      return { samples: buf.getChannelData(0), sampleRate: buf.sampleRate, durationSec: buf.duration };
    });
  }
  function audioSections(audio, sectionSec, overlapSec){
    var out = [], step = sectionSec * audio.sampleRate, overlap = overlapSec * audio.sampleRate;
    for (var start = 0; start < audio.samples.length; start += step){
      var end = Math.min(audio.samples.length, start + step + overlap);
      if (end - start < audio.sampleRate / 2) break; // less than half a second: nothing to transcribe
      out.push({ t: Math.round(start / audio.sampleRate), blob: encodeWav(audio.samples.subarray(start, end), audio.sampleRate) });
    }
    return out;
  }

  window.studyLib = {
    tokenize: tokenize, fmtStamp: fmtStamp, parseStamp: parseStamp, splitText: splitText,
    entryPassages: entryPassages, rankPassages: rankPassages, buildAiContext: buildAiContext,
    splitCitations: splitCitations, timestampedTranscript: timestampedTranscript,
    scheduleCard: scheduleCard, dueCards: dueCards, mergeCards: mergeCards,
    recordTopicResult: recordTopicResult, weakTopics: weakTopics,
    parseNotes: parseNotes, spansText: spansText, renderNotes: renderNotes,
    encodeWav: encodeWav, decodeToMono: decodeToMono, audioSections: audioSections
  };
})();
