// ------------------------------------------------------------------
// Cloudflare Worker: secure relay between the lecture notes site and
// the Gemini API. Keeps your Gemini API key private (never sent to
// the browser) by holding it as a Worker secret instead.
//
// Deploy this on workers.cloudflare.com (free), then set a secret
// named GEMINI_API_KEY with your key from Google AI Studio.
//
// This Worker does two unrelated jobs behind one URL:
//
// 1. AI relay (HTTP POST, JSON body with body.mode) — nine modes:
//   "ask"        (default) — one-shot question + answer, used by the
//                per-lecture and per-course "Ask AI" panels.
//   "chat"       — multi-turn tutor conversation (body.history is the
//                prior back-and-forth), used by the Tutor Chat panel.
//   "generate"   — structured JSON generation (body.genType is
//                "flashcards" or "quiz"), used by the Flashcards/Quiz
//                features.
//   "transcribe" — sends the recorded lecture audio (body.audioUrl)
//                itself to Gemini for a full, accurate transcript —
//                much more complete than the browser's live captions.
//   "summarize"  — turns a transcript into organized study notes,
//                used automatically right after a lecture is saved so
//                notes appear without the student asking for them.
//   "cleanup"    — rewrites a raw transcript for readability (filler
//                words, punctuation, natural paragraphs) without
//                summarizing or dropping content; run automatically
//                right after a lecture is saved, alongside "summarize".
//   "studyguide" — turns selected lectures into an exam study guide, used
//                by the Exam prep panel.
//   "keymoments" — finds exam hints, deadlines, definitions and
//                announcements in a timestamped transcript.
//   "searchterms" — suggests keywords and synonyms, which the site uses to
//                find the lecture passages relevant to a question.
//   "ask" and "chat" stream their answer as plain text when body.stream is set.
//   "title"      — suggests a short title for a lecture.
//   "embed"      — turns text into vectors, for searching lectures by meaning.
//   "enqueue" and "jobkick" — start or resume a background job (see below).
//
// Background jobs let a lecture's AI steps finish after its tab is closed. The
// Worker can't write to Firebase, so each job keeps its results in R2 at
// jobs/<courseId>/<entryId>.json and the site collects them when it's next open.
// A job starts straight away but only gets 30 seconds after the response, so a
// Cron Trigger (set to every minute on this Worker) finishes whatever is left.
//
// 2. File storage (HTTP GET/PUT/DELETE) — recordings, slides, and notes PDFs
//    live in a bound R2 bucket (binding name RECORDINGS_BUCKET) instead of
//    a separate storage service, so the whole app runs off one free
//    Cloudflare account with 10x the storage Supabase's free tier gives
//    and no egress/bandwidth cap. The file's storage key travels in the
//    X-File-Path header (URL-encoded) rather than the URL path, so this
//    stays the same one Worker URL used for the AI calls above. See the
//    setup notes for the two dashboard steps this needs (create the R2
//    bucket + bind it here) — this code is inert without that binding.
// ------------------------------------------------------------------

const ALLOWED_ORIGIN = "https://ethantam12.github.io";
const MODEL = "gemini-3.5-flash-lite"; // fastest/cheapest current model — check https://ai.google.dev/gemini-api/docs/models if this ever errors as "not found" — model names change over time
const FALLBACK_MODEL = "gemini-2.5-flash-lite"; // tried if the primary model reports it's overloaded, so a busy Gemini server doesn't just fail the request

// Questions use a stronger model. If it's busy, out of quota or unavailable on
// this API key, answers drop back to the faster models above.
const ANSWER_MODEL = "gemini-3.6-flash";
const ANSWER_MODELS = [ANSWER_MODEL, MODEL, FALLBACK_MODEL];
const DEFAULT_MODELS = [MODEL, MODEL, FALLBACK_MODEL];
const ANSWER_CONTEXT_LIMIT = 60000;

const ANSWER_RULES =
  "Answer the question directly in your first sentence, then add only the detail that helps. " +
  "Base your answer on the course material provided. When you use an excerpt tagged like [S3], cite that exact tag right after the claim. " +
  "Keep names, numbers and dates exactly as they appear. Never invent what the professor said. " +
  "If the material doesn't cover the question, say so plainly, then give a brief general explanation if it would help and clearly label it as general knowledge, not from the lectures. " +
  "The transcripts are auto-generated and can contain misheard words, so when a term looks wrong, use what it most likely means and say so. " +
  "When asked to explain something, use plain language and one concrete example. " +
  "Format with simple markdown: short paragraphs, - for lists and **bold** for key terms. No headings unless the answer is long.";

const EMBED_MODEL = "gemini-embedding-001";
const EMBED_DIMENSIONS = 256;

function termsNote(terms) {
  return terms
    ? "This course uses these names and terms. Spell them exactly like this when they come up, but never add them if they weren't said: " + terms + ". "
    : "";
}

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": ALLOWED_ORIGIN,
    "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, X-File-Path"
  };
}

function getFilePath(request) {
  const raw = request.headers.get("X-File-Path") || "";
  try { return decodeURIComponent(raw); } catch (e) { return raw; }
}

async function handleUpload(request, env) {
  if (!env.RECORDINGS_BUCKET) {
    return jsonResponse({ error: "Storage isn't set up on this Worker yet (missing RECORDINGS_BUCKET R2 binding)." }, 500);
  }
  const path = getFilePath(request);
  if (!path) return jsonResponse({ error: "Missing X-File-Path header" }, 400);
  const contentType = request.headers.get("Content-Type") || "application/octet-stream";
  try {
    // request.body streams straight into R2 rather than buffering the whole
    // file in the Worker first — keeps this comfortable for even a
    // multi-hour lecture recording.
    await env.RECORDINGS_BUCKET.put(path, request.body, { httpMetadata: { contentType } });
    return jsonResponse({ ok: true, path: path });
  } catch (e) {
    return jsonResponse({ error: "Upload failed: " + (e && e.message || e) }, 500);
  }
}

// Serves a stored file with CORS headers, so the site can read a recording's
// audio to re-transcribe it (R2's public URL doesn't allow that by default).
async function handleDownload(request, env) {
  const key = new URL(request.url).searchParams.get("file");
  if (!key) return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
  if (!env.RECORDINGS_BUCKET) {
    return jsonResponse({ error: "Storage isn't set up on this Worker yet (missing RECORDINGS_BUCKET R2 binding)." }, 500);
  }
  const object = await env.RECORDINGS_BUCKET.get(key);
  if (!object) return jsonResponse({ error: "File not found" }, 404);
  return new Response(object.body, {
    headers: { ...corsHeaders(), "Content-Type": (object.httpMetadata && object.httpMetadata.contentType) || "application/octet-stream" }
  });
}

async function handleDelete(request, env) {
  if (!env.RECORDINGS_BUCKET) {
    return jsonResponse({ error: "Storage isn't set up on this Worker yet (missing RECORDINGS_BUCKET R2 binding)." }, 500);
  }
  const path = getFilePath(request);
  if (!path) return jsonResponse({ error: "Missing X-File-Path header" }, 400);
  try {
    await env.RECORDINGS_BUCKET.delete(path);
    return jsonResponse({ ok: true });
  } catch (e) {
    return jsonResponse({ error: "Delete failed: " + (e && e.message || e) }, 500);
  }
}

function jsonResponse(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { ...corsHeaders(), "Content-Type": "application/json" }
  });
}

function arrayBufferToBase64(buffer) {
  let binary = "";
  const bytes = new Uint8Array(buffer);
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

// Fetch slide images/PDFs in parallel instead of one-at-a-time — with
// several slides attached this alone used to add seconds of latency.
async function fetchSlideParts(slideUrls) {
  const results = await Promise.all(slideUrls.map(async (url) => {
    try {
      const res = await fetch(url);
      if (!res.ok) return null;
      const contentType = res.headers.get("content-type") || "application/octet-stream";
      if (!/^image\/|^application\/pdf/.test(contentType)) return null;
      const buf = await res.arrayBuffer();
      if (buf.byteLength > 15 * 1024 * 1024) return null; // skip anything oversized
      return { inline_data: { mime_type: contentType, data: arrayBufferToBase64(buf) } };
    } catch (e) {
      return null; // skip slides that fail to fetch
    }
  }));
  return results.filter(Boolean);
}

function httpError(message, status, overloaded, kind) {
  return Object.assign(new Error(message), { status: status, overloaded: !!overloaded, kind: kind || "" });
}

function kindOfFailure(status, message) {
  if (status === 429 || /quota|rate limit/i.test(message)) return "quota";
  if (status === 503 || /overload|unavailable|high demand/i.test(message)) return "busy";
  return "";
}

// What the student sees once every model has been tried.
function friendlyError(e) {
  if (e && e.kind === "quota") return httpError("The AI has reached its usage limit for now. Try again in a few minutes, or tomorrow if it's the daily limit.", 429, true, "quota");
  if (e && e.kind === "busy") return httpError("The AI is very busy right now. Try again in a moment.", 503, true, "busy");
  return e;
}

// Gemini accepts audio two ways: embedded directly in the request as base64
// ("inline"), or uploaded once beforehand through its separate Files API and
// then just referenced by a URL. Inline is simpler but Gemini caps the whole
// request around 20MB, which at a healthy recording bitrate is only roughly
// 20 minutes of audio — nowhere near long enough for a full lecture. The
// Files API has no such practical limit (up to 2GB / many hours), so full
// recordings ("Improve with AI", and re-transcribing after import) go
// through that path once they're over the inline-safe size; short clips
// still use inline since it's one less round trip.
const INLINE_AUDIO_LIMIT = 18 * 1024 * 1024;

async function startGeminiFileUpload(env, contentLength, contentType) {
  const startRes = await fetch(
    `https://generativelanguage.googleapis.com/upload/v1beta/files?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: {
        "X-Goog-Upload-Protocol": "resumable",
        "X-Goog-Upload-Command": "start",
        "X-Goog-Upload-Header-Content-Length": String(contentLength),
        "X-Goog-Upload-Header-Content-Type": contentType,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ file: { display_name: "lecture-audio" } })
    }
  );
  if (!startRes.ok) throw httpError("Couldn't start uploading the audio to the AI.", 502);
  const uploadUrl = startRes.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw httpError("Couldn't start uploading the audio to the AI.", 502);
  return uploadUrl;
}

// Audio files are usually ready to use almost immediately after uploading,
// but this polls briefly in case Gemini is still processing it.
async function waitForGeminiFileActive(env, name, state, uri) {
  for (let i = 0; i < 15 && state === "PROCESSING"; i++) {
    await sleep(1000);
    const checkRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/${name}?key=${env.GEMINI_API_KEY}`);
    const checkData = await checkRes.json().catch(() => ({}));
    state = checkData.state || state;
    uri = checkData.uri || uri;
  }
  if (state === "FAILED") throw httpError("The AI couldn't process the uploaded audio. Try again.", 502);
  return uri;
}

async function finishGeminiFileUpload(env, uploadUrl, body, contentLength) {
  const uploadRes = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(contentLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize"
    },
    body: body
  });
  if (!uploadRes.ok) throw httpError("Couldn't upload the audio to the AI.", 502);
  const fileInfo = await uploadRes.json().catch(() => ({}));
  const file = fileInfo.file;
  if (!file || !file.uri) throw httpError("The AI didn't accept the audio upload.", 502);
  return waitForGeminiFileActive(env, file.name, file.state, file.uri);
}

async function uploadAudioToGeminiFile(env, body, contentLength, contentType) {
  const uploadUrl = await startGeminiFileUpload(env, contentLength, contentType);
  const uri = await finishGeminiFileUpload(env, uploadUrl, body, contentLength);
  return { file_data: { mime_type: contentType, file_uri: uri } };
}

// Downloads the recorded lecture audio and prepares it as a part Gemini can
// use — inline for anything reasonably short, or via the Files API above for
// anything too big to embed directly in the request (see INLINE_AUDIO_LIMIT).
async function fetchAudioPart(env, audioUrl) {
  let res;
  try {
    res = await fetch(audioUrl);
  } catch (e) {
    throw httpError("Couldn't download the recording's audio.", 502);
  }
  if (!res.ok) {
    throw httpError("Couldn't download the recording's audio.", 502);
  }
  const contentType = (res.headers.get("content-type") || "audio/webm").split(";")[0];
  const contentLengthHeader = res.headers.get("content-length");
  const knownLength = contentLengthHeader ? parseInt(contentLengthHeader, 10) : null;

  if (knownLength !== null && knownLength > INLINE_AUDIO_LIMIT) {
    // Stream the download straight into the upload rather than buffering the
    // whole recording in memory first — keeps this comfortable even for a
    // multi-hour lecture.
    return uploadAudioToGeminiFile(env, res.body, knownLength, contentType);
  }

  // Either it's within the inline size budget, or the storage host didn't
  // send a Content-Length — either way, this is a definite answer.
  const buf = await res.arrayBuffer();
  if (buf.byteLength > INLINE_AUDIO_LIMIT) {
    return uploadAudioToGeminiFile(env, buf, buf.byteLength, contentType);
  }
  return { inline_data: { mime_type: contentType, data: arrayBufferToBase64(buf) } };
}

function buildContextText(transcript, notes) {
  let ctx = "";
  if (transcript) ctx += "LECTURE TRANSCRIPT:\n" + transcript + "\n\n";
  if (notes) ctx += "STUDENT'S NOTES:\n" + notes + "\n\n";
  return ctx;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Not every model accepts every thinking level: the 2.5 models have no "minimal".
function requestForModel(model, requestBody) {
  const thinking = requestBody.generationConfig && requestBody.generationConfig.thinkingConfig;
  if (model.startsWith("gemini-2.5") && thinking && thinking.thinkingLevel === "minimal") {
    return { ...requestBody, generationConfig: { ...requestBody.generationConfig, thinkingConfig: { thinkingLevel: "low" } } };
  }
  return requestBody;
}

// Worth trying the next model: it's busy, out of quota, or not on this key.
function shouldTryNextModel(status, message) {
  return status === 503 || status === 429 || status === 404 || /overload|unavailable|high demand|quota/i.test(message);
}

async function callGeminiOnce(env, model, requestBody) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestForModel(model, requestBody))
    }
  );
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "Gemini request failed";
    const overloaded = shouldTryNextModel(res.status, msg);
    throw httpError(msg, 502, overloaded, kindOfFailure(res.status, msg));
  }
  const candidate = data.candidates && data.candidates[0];
  return (candidate && candidate.content && candidate.content.parts && candidate.content.parts.map(p => p.text || "").join("")) || "";
}

// Google's free-tier models sometimes reply "the model is overloaded" during
// traffic spikes, which used to fail every single question outright. Now we
// retry the same model once after a short pause, then fall back to a second
// free model, before giving up — real errors (bad request, missing key, etc.)
// still fail immediately without wasting time retrying.
async function callGemini(env, requestBody, models) {
  const list = models || DEFAULT_MODELS;
  let lastErr;
  for (let i = 0; i < list.length; i++) {
    if (i > 0) await sleep(list[i] === list[i - 1] ? 300 : 250);
    try {
      return await callGeminiOnce(env, list[i], requestBody);
    } catch (e) {
      lastErr = e;
      if (!e.overloaded) throw e;
    }
  }
  throw friendlyError(lastErr);
}

// Sends the answer to the browser as it's written. Falling back to another
// model is only possible before the first words have been sent.
async function streamGemini(env, requestBody, models) {
  let upstream, lastErr;
  for (let i = 0; i < models.length && !upstream; i++) {
    if (i > 0) await sleep(250);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${models[i]}:streamGenerateContent?alt=sse&key=${env.GEMINI_API_KEY}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(requestForModel(models[i], requestBody)) }
    );
    if (res.ok) { upstream = res; break; }
    const data = await res.json().catch(() => ({}));
    const msg = (data && data.error && data.error.message) || "Gemini request failed";
    lastErr = httpError(msg, 502, shouldTryNextModel(res.status, msg), kindOfFailure(res.status, msg));
    if (!lastErr.overloaded) throw lastErr;
  }
  if (!upstream) throw friendlyError(lastErr);
  const reader = upstream.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "";
  const body = new ReadableStream({
    async pull(controller) {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) { controller.close(); return; }
        pending += decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop();
        let out = "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          try {
            const parts = JSON.parse(line.slice(5)).candidates[0].content.parts;
            out += parts.map((p) => p.text || "").join("");
          } catch (e) { /* a piece with no text, such as the closing metadata */ }
        }
        if (out) { controller.enqueue(encoder.encode(out)); return; }
      }
    },
    cancel() { return reader.cancel(); }
  });
  return new Response(body, { headers: { ...corsHeaders(), "Content-Type": "text/plain; charset=utf-8" } });
}

async function summarizeText(env, transcript, slideUrls, terms) {
  const promptText =
    "You are an expert note-taker helping a student study. Read the lecture transcript below and write clear, " +
    "well-organized study notes covering everything important in it. Start with a one-to-two sentence overview " +
    "of what the lecture was about. Then cover the main topics in the order they came up, using a short topic " +
    "label followed by a few sentences explaining it — include specific facts, definitions, dates, names, and " +
    "examples that were actually mentioned, not vague generalities. " +
    "If slides are attached, use them too, and include anything important they add. " + termsNote(terms) +
    "Format with simple markdown only: ## for each topic heading, - for list items, and **bold** for key terms. " +
    "Use no other formatting.\n\n" + buildContextText(transcript.slice(0, 100000), "");
  const slideParts = await fetchSlideParts(slideUrls || []);
  return callGemini(env, {
    contents: [{ parts: [{ text: promptText }, ...slideParts] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 5000 }
  });
}

async function cleanSection(env, section, terms) {
  const promptText =
    "Below is a raw, AI-generated verbatim transcript of a recorded lecture, stitched together from many short audio chunks. " +
    "Rewrite it for readability WITHOUT summarizing, shortening, or omitting any actual content: remove filler words and false " +
    "starts (um, uh, you know, restarted sentences), fix punctuation and capitalization, and reorganize it into natural " +
    "paragraphs by topic instead of the arbitrary chunk breaks in the raw text below. Keep every fact, name, number, and " +
    "example that was actually said — this must remain a complete, faithful record of the lecture, just easier to read. " + termsNote(terms) +
    "Do not add commentary, headers, or anything that wasn't actually said.\n\n" + buildContextText(section, "");
  return callGemini(env, {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 8192 }
  });
}

async function findMoments(env, transcript) {
  const promptText =
    "Find the moments in this lecture transcript that a student must not miss: hints about what will be on an exam (kind \"exam\"), " +
    "due dates and deadlines (\"deadline\"), formal definitions of key terms (\"definition\"), and course logistics announcements " +
    "(\"announcement\"). Only list what was actually said, and return an empty list if there are none. " +
    "Lines may start with a time marker like [12:30].\n\n" + buildContextText(transcript.slice(0, 100000), "");
  const raw = await callGemini(env, {
    contents: [{ parts: [{ text: promptText }] }],
    generationConfig: {
      thinkingConfig: { thinkingLevel: "low" },
      maxOutputTokens: 3000,
      responseMimeType: "application/json",
      responseSchema: keyMomentSchema()
    }
  });
  const moments = JSON.parse(raw);
  if (!Array.isArray(moments)) throw new Error("The AI didn't return usable results.");
  return moments;
}

async function suggestTitle(env, transcript) {
  const raw = await callGemini(env, {
    contents: [{ parts: [{ text:
      "Write a short, specific title of 2 to 6 words for this lecture, naming its main topic, such as \"Enzymes and metabolism\". " +
      "Reply with only the title, with no quotes or final period.\n\nTRANSCRIPT:\n" + transcript.slice(0, 12000) }] }],
    generationConfig: { thinkingConfig: { thinkingLevel: "minimal" }, maxOutputTokens: 60 }
  });
  return raw.replace(/^["'\s]+|["'.\s]+$/g, "").slice(0, 80);
}

function splitSections(text, size) {
  const out = [];
  let rest = text;
  while (rest.length > size) {
    let cut = rest.lastIndexOf(". ", size);
    if (cut < size / 2) cut = size - 2;
    out.push(rest.slice(0, cut + 2));
    rest = rest.slice(cut + 2);
  }
  if (rest.trim()) out.push(rest);
  return out;
}

const JOB_STEPS = ["summary", "title", "moments", "cleanup"];
const JOB_MAX_ATTEMPTS = 4; // keeps a step that always fails from using up the AI quota
const JOB_LEASE_MS = 90000;
const JOB_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

function jobKey(courseId, entryId) { return "jobs/" + courseId + "/" + entryId + ".json"; }

function saveJob(env, key, job) {
  return env.RECORDINGS_BUCKET.put(key, JSON.stringify(job), {
    httpMetadata: { contentType: "application/json" },
    customMetadata: { done: job.done ? "1" : "0" }
  });
}

async function runJobStep(env, key, job, step) {
  const attempt = job.attempts[step];
  if (step === "summary") {
    // On the later attempts, leave the slides out in case they're what's failing.
    job.result.notes = await summarizeText(env, job.transcript, attempt <= 2 ? job.slideUrls : [], job.terms);
  } else if (step === "title") {
    job.result.title = await suggestTitle(env, job.transcript);
  } else if (step === "moments") {
    job.result.moments = await findMoments(env, job.timestamped || job.transcript);
  } else {
    const sections = splitSections(job.transcript, 20000);
    job.result.cleanSections = job.result.cleanSections || [];
    for (let i = job.result.cleanSections.length; i < sections.length; i++) {
      job.result.cleanSections.push((await cleanSection(env, sections[i], job.terms)) || sections[i]);
      await saveJob(env, key, job);
    }
  }
}

async function runJob(env, key, force) {
  const object = await env.RECORDINGS_BUCKET.get(key);
  if (!object) return;
  const job = await object.json();
  if (job.done || (!force && job.leaseUntil > Date.now())) return;
  for (const step of JOB_STEPS) {
    if (job.steps[step]) continue;
    // Counted before running, so a run that gets cut off still counts.
    job.attempts[step] = (job.attempts[step] || 0) + 1;
    if (job.attempts[step] > JOB_MAX_ATTEMPTS) { job.steps[step] = "failed"; continue; }
    job.leaseUntil = Date.now() + JOB_LEASE_MS;
    await saveJob(env, key, job);
    try {
      await runJobStep(env, key, job, step);
      job.steps[step] = "done";
      await saveJob(env, key, job);
    } catch (e) {
      job.lastError = String((e && e.message) || e).slice(0, 300);
      // Waits 2, 4, 8, then 16 minutes, so a busy or rate-limited AI has time to recover.
      job.leaseUntil = Date.now() + 60000 * Math.pow(2, job.attempts[step]);
      await saveJob(env, key, job);
      return;
    }
  }
  job.done = true;
  job.leaseUntil = 0;
  await saveJob(env, key, job);
}

async function runPendingJobs(env) {
  const startedAt = Date.now();
  const listed = await env.RECORDINGS_BUCKET.list({ prefix: "jobs/", limit: 100, include: ["customMetadata"] });
  for (const item of listed.objects) {
    if (Date.now() - new Date(item.uploaded).getTime() > JOB_MAX_AGE_MS) {
      await env.RECORDINGS_BUCKET.delete(item.key);
      continue;
    }
    if (item.customMetadata && item.customMetadata.done === "1") continue;
    if (Date.now() - startedAt > 12 * 60 * 1000) return;
    await runJob(env, item.key, false);
  }
}

async function embedTexts(env, texts, kind) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${EMBED_MODEL}:batchEmbedContents?key=${env.GEMINI_API_KEY}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        requests: texts.map((text) => ({
          model: "models/" + EMBED_MODEL,
          content: { parts: [{ text: text }] },
          taskType: kind === "query" ? "RETRIEVAL_QUERY" : "RETRIEVAL_DOCUMENT",
          outputDimensionality: EMBED_DIMENSIONS
        }))
      })
    }
  );
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = (data && data.error && data.error.message) || "Embedding request failed";
    throw friendlyError(httpError(msg, 502, false, kindOfFailure(res.status, msg)));
  }
  return (data.embeddings || []).map((e) => e.values);
}

function flashcardSchema() {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        front: { type: "STRING", description: "The question or term side of the flashcard." },
        back: { type: "STRING", description: "The answer or definition side of the flashcard." }
      },
      required: ["front", "back"]
    }
  };
}

function quizSchema() {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        question: { type: "STRING" },
        choices: { type: "ARRAY", items: { type: "STRING" } },
        correctIndex: { type: "INTEGER", description: "Index (0-3) into choices of the correct answer." },
        explanation: { type: "STRING", description: "One or two sentences on why that answer is correct." },
        topic: { type: "STRING", description: "A short topic label of one to four words. Reuse the same label for questions on the same topic." }
      },
      required: ["question", "choices", "correctIndex", "explanation", "topic"]
    }
  };
}

function keyMomentSchema() {
  return {
    type: "ARRAY",
    items: {
      type: "OBJECT",
      properties: {
        time: { type: "STRING", description: "The [mm:ss] or [h:mm:ss] marker nearest before this moment, without brackets. Empty if the transcript has no markers." },
        kind: { type: "STRING", description: "One of: exam, deadline, definition, announcement." },
        text: { type: "STRING", description: "One short sentence saying what was said." }
      },
      required: ["time", "kind", "text"]
    }
  };
}

export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runPendingJobs(env));
  },

  async fetch(request, env, ctx) {
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders() });
    }
    // File storage (see the big comment at the top) — separate from the AI
    // JSON API below, distinguished by HTTP method rather than a URL path.
    if (request.method === "GET") {
      return handleDownload(request, env);
    }
    if (request.method === "PUT") {
      return handleUpload(request, env);
    }
    if (request.method === "DELETE") {
      return handleDelete(request, env);
    }
    if (request.method !== "POST") {
      return new Response("Method not allowed", { status: 405, headers: corsHeaders() });
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return jsonResponse({ error: "Invalid JSON body" }, 400);
    }

    const mode = String(body.mode || "ask");
    const fullTranscript = String(body.transcript || "");
    // "ask"/"chat" keep only the END (most recent part) of the transcript —
    // that's what matters most for "what did they just say" questions during
    // a live recording, and a smaller prompt also means a noticeably faster
    // answer. But "summarize" and "generate" (flashcards/quiz) need the
    // WHOLE lecture, not just its last ~24,000 characters — that same limit
    // used to apply to every mode, which meant a lecture longer than about
    // 30-35 minutes silently had its summary, flashcards, and quiz built
    // from only the tail end of the recording. Give those modes a much
    // larger allowance instead.
    const wantsFullTranscript = mode === "summarize" || mode === "generate" || mode === "studyguide" || mode === "keymoments";
    const transcript = wantsFullTranscript
      ? (fullTranscript.length > 100000 ? fullTranscript.slice(0, 100000) : fullTranscript)
      : (fullTranscript.length > ANSWER_CONTEXT_LIMIT ? fullTranscript.slice(-ANSWER_CONTEXT_LIMIT) : fullTranscript);
    const notes = String(body.notes || "").slice(0, 12000);
    const slideUrls = Array.isArray(body.slideUrls) ? body.slideUrls.slice(0, 8) : [];
    const terms = String(body.terms || "").slice(0, 1000);

    try {
      if (mode === "enqueue" || mode === "jobkick") {
        const courseId = String(body.courseId || ""), entryId = String(body.entryId || "");
        if (!/^[\w-]{1,128}$/.test(courseId) || !/^[\w-]{1,128}$/.test(entryId)) return jsonResponse({ error: "Invalid job" }, 400);
        if (!env.RECORDINGS_BUCKET) return jsonResponse({ error: "Storage isn't set up on this Worker yet." }, 500);
        const key = jobKey(courseId, entryId);
        if (mode === "enqueue") {
          if (!fullTranscript.trim()) return jsonResponse({ error: "No transcript to process" }, 400);
          await saveJob(env, key, {
            courseId, entryId, transcript: fullTranscript, timestamped: String(body.timestamped || ""), slideUrls, terms,
            steps: {}, attempts: {}, result: {}, done: false, leaseUntil: 0, createdAt: Date.now()
          });
        }
        ctx.waitUntil(runJob(env, key, mode === "enqueue").catch(() => {}));
        return jsonResponse({ queued: true });
      }

      if (mode === "embed") {
        const texts = Array.isArray(body.texts) ? body.texts.slice(0, 100).map((t) => String(t).slice(0, 4000)) : [];
        if (!texts.length) return jsonResponse({ error: "Nothing to embed" }, 400);
        return jsonResponse({ vectors: await embedTexts(env, texts, body.kind) });
      }

      if (mode === "title") {
        if (!fullTranscript.trim()) return jsonResponse({ error: "No transcript" }, 400);
        return jsonResponse({ title: await suggestTitle(env, fullTranscript) });
      }

      if (mode === "chat") {
        const question = String(body.question || "").slice(0, 4000);
        if (!question) return jsonResponse({ error: "Missing question" }, 400);
        const history = Array.isArray(body.history) ? body.history.slice(-20) : [];
        const slideParts = await fetchSlideParts(slideUrls);

        const systemText =
          "You are a friendly, encouraging study tutor inside a student's lecture notes app, having a natural back-and-forth conversation. " +
          "Use the earlier conversation to understand follow-up questions. " + ANSWER_RULES + "\n\n" +
          buildContextText(transcript, notes);

        const contents = history.map((h) => ({
          role: h.role === "assistant" ? "model" : "user",
          parts: [{ text: String(h.text || "").slice(0, 4000) }]
        }));
        const lastParts = [{ text: question }];
        slideParts.forEach((p) => lastParts.push(p));
        contents.push({ role: "user", parts: lastParts });

        const chatRequest = {
          systemInstruction: { parts: [{ text: systemText }] },
          contents: contents,
          generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 2048 }
        };
        if (body.stream) return await streamGemini(env, chatRequest, ANSWER_MODELS);
        const answer = await callGemini(env, chatRequest, ANSWER_MODELS);
        return jsonResponse({ answer: answer || "No answer returned." });
      }

      if (mode === "searchterms") {
        const question = String(body.question || "").slice(0, 2000);
        if (!question) return jsonResponse({ error: "Missing question" }, 400);
        const earlier = Array.isArray(body.history) ? body.history.slice(-4).map((h) => String(h.text || "").slice(0, 500)).join("\n") : "";
        const raw = await callGemini(env, {
          contents: [{ parts: [{ text:
            "A student is searching their lecture transcripts. List up to 12 single words or short phrases likely to appear in the passages that answer this question: " +
            "key terms, synonyms, the formal names of concepts, and likely spelling variants. " +
            (earlier ? "Use the earlier conversation to work out what the question refers to.\n\nEarlier conversation:\n" + earlier + "\n\n" : "\n\n") +
            "Question: " + question }] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: "minimal" },
            maxOutputTokens: 200,
            responseMimeType: "application/json",
            responseSchema: { type: "ARRAY", items: { type: "STRING" } }
          }
        });
        let terms;
        try { terms = JSON.parse(raw); } catch (e) { terms = []; }
        return jsonResponse({ terms: Array.isArray(terms) ? terms.slice(0, 12).map(String) : [] });
      }

      if (mode === "transcribe") {
        // Either a full recording fetched from its storage URL (the "Improve
        // with AI" button, after saving) or a short raw audio chunk sent
        // straight from the browser as base64 (live in-progress recording,
        // re-transcribed every ~30s for far better accuracy than the
        // browser's built-in live captions).
        let audioPart;
        if (body.audioBase64) {
          const b64 = String(body.audioBase64);
          if (b64.length > 26 * 1024 * 1024) return jsonResponse({ error: "Audio chunk too large" }, 413);
          const mimeType = String(body.mimeType || "audio/webm").split(";")[0];
          audioPart = { inline_data: { mime_type: mimeType, data: b64 } };
        } else {
          const audioUrl = String(body.audioUrl || "");
          if (!audioUrl) return jsonResponse({ error: "Missing audioUrl or audioBase64" }, 400);
          audioPart = await fetchAudioPart(env, audioUrl);
        }
        // A short hint of what was said in the moments just before this clip
        // (from the browser's live, rougher speech recognition) — not
        // authoritative, just enough for the model to stay consistent on
        // names/terms and to know where a sentence left off across the cut
        // between consecutive audio chunks.
        const contextTail = String(body.contextTail || "").slice(0, 800);
        const promptText =
          (contextTail
            ? "For context only, here is a rough guess at what was said in the few seconds just before this clip: \"" + contextTail + "\". " +
              "It may be inexact — use it only to stay consistent with names/terms and to pick up mid-sentence if this clip starts mid-thought. " +
              "Do not repeat or include this context in your answer — transcribe only the audio below.\n\n"
            : "") +
          "Transcribe this lecture audio verbatim, as accurately and completely as you can. " +
          "It may be a short excerpt from a longer recording — transcribe only what is actually heard, " +
          "with no introduction, commentary, or note about it being an excerpt. " +
          "Capture everything that is said — do not summarize, paraphrase, or skip parts. " +
          "If a portion is inaudible or unclear, write [inaudible] rather than guessing at it. " + termsNote(terms);
        const newTranscript = await callGemini(env, {
          contents: [{ parts: [{ text: promptText }, audioPart] }],
          generationConfig: { thinkingConfig: { thinkingLevel: "minimal" }, maxOutputTokens: 8192 }
        });
        if (!newTranscript) return jsonResponse({ error: "The AI didn't return a transcript. Try again." }, 502);
        return jsonResponse({ transcript: newTranscript });
      }

      if (mode === "generate") {
        const genType = body.genType === "quiz" ? "quiz" : "flashcards";
        const count = Math.max(3, Math.min(20, parseInt(body.count, 10) || 10));
        if (!transcript && !notes) return jsonResponse({ error: "No transcript or notes to generate from" }, 400);

        const promptText =
          (genType === "quiz"
            ? "Write exactly " + count + " multiple-choice quiz questions (4 choices each) testing understanding of the material below. " +
              "Vary difficulty, cover different parts of the material, test understanding rather than exact wording, and make the wrong choices plausible. Each question needs exactly 4 choices, a correctIndex (0-3), and a short explanation."
            : "Write exactly " + count + " study flashcards (front = question/term, back = concise answer/definition) covering the key concepts in the material below. " +
              "Favor the most exam-relevant ideas over trivia.") +
          "\n\n" + buildContextText(transcript, notes);
        const slideParts = await fetchSlideParts(slideUrls);

        const raw = await callGemini(env, {
          contents: [{ parts: [{ text: promptText }, ...slideParts] }],
          generationConfig: {
            thinkingConfig: { thinkingLevel: "low" },
            maxOutputTokens: 4000,
            responseMimeType: "application/json",
            responseSchema: genType === "quiz" ? quizSchema() : flashcardSchema()
          }
        });
        let items;
        try { items = JSON.parse(raw); } catch (e) { items = null; }
        if (!Array.isArray(items)) return jsonResponse({ error: "The AI didn't return usable results. Try again." }, 502);
        return jsonResponse({ items: items });
      }

      if (mode === "summarize") {
        // Used right after a lecture recording is saved, to automatically fill
        // in a first draft of the student's notes — no button press needed.
        if (!transcript && !notes) return jsonResponse({ error: "No transcript or notes to summarize" }, 400);

        const notesOut = await summarizeText(env, transcript + (notes ? "\n\nSTUDENT'S NOTES:\n" + notes : ""), slideUrls, terms);
        if (!notesOut) return jsonResponse({ error: "The AI didn't return notes. Try again." }, 502);
        return jsonResponse({ notes: notesOut });
      }

      if (mode === "studyguide") {
        if (!transcript && !notes) return jsonResponse({ error: "No transcript or notes to build a study guide from" }, 400);
        const weakTopics = Array.isArray(body.weakTopics) ? body.weakTopics.slice(0, 10).map((t) => String(t).slice(0, 80)) : [];
        const promptText =
          "Write an exam study guide from the lecture material below. Start with the big themes, then give the key concepts, " +
          "definitions, names, dates and examples actually covered, and end with a short list of likely exam questions. " +
          (weakTopics.length ? "The student has struggled with these topics, so explain them more fully: " + weakTopics.join(", ") + ". " : "") +
          "Only include what the material supports. " +
          "Format with simple markdown only: ## for headings, - for list items, and **bold** for key terms.\n\n" +
          buildContextText(transcript, notes);
        const slideParts = await fetchSlideParts(slideUrls);
        const guide = await callGemini(env, {
          contents: [{ parts: [{ text: promptText }, ...slideParts] }],
          generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 6000 }
        });
        if (!guide) return jsonResponse({ error: "The AI didn't return a study guide. Try again." }, 502);
        return jsonResponse({ guide: guide });
      }

      if (mode === "keymoments") {
        if (!transcript) return jsonResponse({ error: "No transcript to read" }, 400);
        return jsonResponse({ moments: await findMoments(env, transcript) });
      }

      if (mode === "cleanup") {
        // A near-verbatim rewrite, so its output is about as long as its input.
        // This is capped below the model's output limit; the site sends long
        // transcripts in sections.
        const CLEANUP_MAX_CHARS = 35000;
        if (!fullTranscript.trim()) return jsonResponse({ error: "No transcript to clean up" }, 400);
        if (fullTranscript.length > CLEANUP_MAX_CHARS) {
          return jsonResponse({ skipped: true, reason: "This transcript section is too long to clean up in one pass." });
        }
        const cleaned = await cleanSection(env, fullTranscript, terms);
        if (!cleaned) return jsonResponse({ error: "The AI didn't return a cleaned transcript. Try again." }, 502);
        return jsonResponse({ cleanTranscript: cleaned });
      }

      // mode === "ask" (default) — one-shot question, unchanged behavior.
      const question = String(body.question || "").slice(0, 4000);
      if (!question) return jsonResponse({ error: "Missing question" }, 400);
      const slideParts = await fetchSlideParts(slideUrls);

      let promptText = "You are a study assistant inside a student's lecture notes app. " + ANSWER_RULES + "\n\n";
      promptText += buildContextText(transcript, notes);
      promptText += "QUESTION: " + question;

      const parts = [{ text: promptText }];
      slideParts.forEach((p) => parts.push(p));

      const askRequest = {
        contents: [{ parts }],
        generationConfig: { thinkingConfig: { thinkingLevel: "low" }, maxOutputTokens: 2048 }
      };
      if (body.stream) return await streamGemini(env, askRequest, ANSWER_MODELS);
      const answer = await callGemini(env, askRequest, ANSWER_MODELS);
      return jsonResponse({ answer: answer || "No answer returned." });
    } catch (e) {
      return jsonResponse({ error: e.message || "Unexpected error" }, e.status || 500);
    }
  }
};
