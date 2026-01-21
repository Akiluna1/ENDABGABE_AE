/********************************************
 * Web Rooms – WebSocket Connection
 ********************************************/
const ws = new WebSocket("wss://socket-server-endabgabe-ae.onrender.com:443");

/********************************************
 * Shared Control State (sent to server)
 ********************************************/

// 0..360 – controlled by horizontal pointer movement
let hue = 0;

// 0..1 – controlled by vertical pointer movement
let volumeValue = 0.5;

// Cycles 0 → 1 → 2 → 0 on each pointerdown (discrete trigger)
let clickCounter = 0;

/********************************************
 * Client Identity + Cursor Storage
 ********************************************/

// Unique ID for this browser session
const clientId = Math.random().toString(36).slice(2);

// Local + remote cursors (normalized positions 0..1)
const cursors = new Map();

/**
 * Send full state to the server (Web Rooms).
 * - `stars`: legacy key (some servers/clients still use it)
 * - `coursor`: current key (kept for compatibility, even though misspelled)
 * - `slider1`: hue (0..360)
 * - `slider2`: volume/control (0..1, 4 decimals)
 * - `click`: discrete trigger (0/1/2)
 */
function sendFullState() {
  if (ws.readyState !== WebSocket.OPEN) return;

  const cursorsArray = Array.from(cursors.values()).map((c) => ({
    id: c.id,
    x: c.x,
    y: c.y,
    own: c.own,
  }));

  ws.send(
    JSON.stringify({
      // Send both keys for compatibility with different server/client versions
      stars: cursorsArray,
      coursor: cursorsArray,
      slider1: Math.max(0, Math.min(360, hue)),
      slider2: Math.max(0, Math.min(1, Number(volumeValue.toFixed(4)))),
      click: clickCounter,
    })
  );
}

/********************************************
 * Web Audio
 * - Plays local `music.mp3`
 * - While pressed: Y-position blends between Highpass (top) and Lowpass (bottom)
 ********************************************/
const AudioContext = window.AudioContext || window.webkitAudioContext;

let audioContext = null;
let audioEl = null;
let mediaSource = null;

let lowpass = null;
let highpass = null;
let lpGain = null;
let hpGain = null;
let masterGain = null;

function clamp01(v) {
  return Math.max(0, Math.min(1, v));
}

function ensureAudioGraph() {
  if (audioContext) return;

  audioContext = new AudioContext();

  // Use an <audio> element so MP3 decoding works reliably across browsers (incl. iOS)
  audioEl = new Audio();
  audioEl.src = "music.mp3";
  audioEl.loop = true;
  audioEl.preload = "auto";

  mediaSource = audioContext.createMediaElementSource(audioEl);

  // Filters
  lowpass = audioContext.createBiquadFilter();
  lowpass.type = "lowpass";
  lowpass.frequency.value = 12000;
  lowpass.Q.value = 0.7;

  highpass = audioContext.createBiquadFilter();
  highpass.type = "highpass";
  highpass.frequency.value = 20;
  highpass.Q.value = 0.7;

  // Crossfade gains
  lpGain = audioContext.createGain();
  hpGain = audioContext.createGain();
  lpGain.gain.value = 0.5;
  hpGain.gain.value = 0.5;

  // Master
  masterGain = audioContext.createGain();
  masterGain.gain.value = 0.9;

  // Routing: source -> (LP -> lpGain) + (HP -> hpGain) -> master -> out
  mediaSource.connect(lowpass);
  mediaSource.connect(highpass);

  lowpass.connect(lpGain);
  highpass.connect(hpGain);

  lpGain.connect(masterGain);
  hpGain.connect(masterGain);

  masterGain.connect(audioContext.destination);
}

async function startAudioIfNeeded() {
  ensureAudioGraph();

  if (audioContext.state === "suspended") {
    try {
      await audioContext.resume();
    } catch {
      // ignore
    }
  }

  // Start playback if not already playing
  if (audioEl && audioEl.paused) {
    try {
      await audioEl.play();
    } catch {
      // autoplay blocked if not triggered by gesture — pointerdown should be a gesture
    }
  }
}

// yNorm: 0 (top) .. 1 (bottom)
function setFilterFromY(yNorm) {
  if (!audioContext || !lowpass || !highpass || !lpGain || !hpGain) return;

  const y = clamp01(yNorm);

  // Crossfade: top -> highpass, bottom -> lowpass
  const hpMix = 1 - y; // 1 at top, 0 at bottom
  const lpMix = y;     // 0 at top, 1 at bottom
  hpGain.gain.value = hpMix;
  lpGain.gain.value = lpMix;

  // Cutoff curves: map vertical position to filter tone (tweakable)
  // Lowpass: bottom muffled (low cutoff), top open (high cutoff)
  const lpFreq = 300 + (1 - y) * 11700; // ~300..12000
  // Highpass: top thin/bright (higher cutoff), bottom full (near 20 Hz)
  const hpFreq = 20 + (1 - y) * 1980;   // ~20..2000

  lowpass.frequency.value = lpFreq;
  highpass.frequency.value = hpFreq;
}

// Cursor = one user's pointer position (local or remote)
class Cursor {
  constructor(id, x, y, own = false) {
    this.id = id;   // Unique identifier for this cursor
    this.x = x;     // Normalized x position (0..1)
    this.y = y;     // Normalized y position (0..1)
    this.own = own; // True if this cursor belongs to this client
  }

  // Update cursor position
  move(x, y) {
    this.x = x;
    this.y = y;
  }
}

// Pointer tracking: handled directly in pointer events (no persistent vars needed)

/********************************************
 * Visuals (Canvas Background)
 * Pipeline per frame:
 * 1) draw moving particles into a LOW-RES buffer (bgLowCanvas)
 * 2) apply ordered dithering (Bayer 8x8) to the buffer
 * 3) upscale to full screen (bgCanvas) with smoothing disabled (chunky look)
 ********************************************/
const bgCanvas = document.getElementById("bgCanvas");
const bgCtx = bgCanvas.getContext("2d");

// Low-res buffer for strong pixel/dither look (render small -> dither -> upscale)
const bgLowCanvas = document.createElement("canvas");
const bgLowCtx = bgLowCanvas.getContext("2d");

// Lower = chunkier + stronger effect (0.15–0.35)
const bgScale = 0.18;

let lowW = 0;
let lowH = 0;

// Shockwaves (spawned on pointerdown)
const shockwaves = [];
const SHOCKWAVE_SPEED = 2.2;   // expansion speed in low-res px/frame
const SHOCKWAVE_MAX_R = 140;   // max radius in low-res px
const SHOCKWAVE_THICKNESS = 2; // ring thickness in low-res px
const SHOCKWAVE_PUSH = 0.12;   // how much it pushes particles near the ring

// Background particle system state (rendered low-res and dithered)
const bg = {
  baseHue: 220,          // controlled by pointer X (you already set bg.baseHue = hue)
  circleCount: 50,      // much denser background (many small circles)
  circles: [],
  // visual tuning
  bgLightness: 12,       // base black level
  circleLightness: 38,   // circle brightness
  circleAlpha: 0.18,     // overall circle opacity
  hueJitter: 42,         // stronger hue differences between circles
  sat: 60,
  ditherLevels: 4,
  ditherStrength: 1.0
};

function rand(min, max) {
  return min + Math.random() * (max - min);
}

// Ordered dithering (Bayer 8x8) — fast and mobile-friendly
const BAYER_8 = [
  0, 48, 12, 60, 3, 51, 15, 63,
  32, 16, 44, 28, 35, 19, 47, 31,
  8, 56, 4, 52, 11, 59, 7, 55,
  40, 24, 36, 20, 43, 27, 39, 23,
  2, 50, 14, 62, 1, 49, 13, 61,
  34, 18, 46, 30, 33, 17, 45, 29,
  10, 58, 6, 54, 9, 57, 5, 53,
  42, 26, 38, 22, 41, 25, 37, 21
];

// Quantize a single 0..255 channel to `levels` steps, with a threshold bias in [-0.5..0.5]
function quantizeWithThreshold(v, levels, tBias) {
  const f = v / 255;
  const stepped = Math.floor(f * (levels - 1) + tBias) / (levels - 1);
  return Math.max(0, Math.min(255, Math.round(stepped * 255)));
}

function applyDither(ctx, w, h, levels, strength) {
  const img = ctx.getImageData(0, 0, w, h);
  const data = img.data;

  const L = Math.max(2, Math.min(16, levels | 0));
  const S = Math.max(0, Math.min(1, strength));

  for (let y = 0; y < h; y++) {
    const by = (y & 7) << 3;
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) << 2;

      // threshold in [-0.5..0.5], scaled by strength
      const t = ((BAYER_8[by + (x & 7)] + 0.5) / 64 - 0.5) * S;

      data[i]     = quantizeWithThreshold(data[i],     L, t);
      data[i + 1] = quantizeWithThreshold(data[i + 1], L, t);
      data[i + 2] = quantizeWithThreshold(data[i + 2], L, t);
      // keep alpha
    }
  }

  ctx.putImageData(img, 0, 0);
}

function makeCircle() {
  const w = lowW;
  const h = lowH;

  const r = rand(5, 20); // much smaller sizes (low-res space)
  const x = rand(-r, w + r);
  const y = rand(-r, h + r);

  // random motion  
  const vx = rand(-0.15, 0.15);
  const vy = rand(-0.15, 0.15);

  // slight tone difference but same color family
  const hueOffset = rand(-bg.hueJitter, bg.hueJitter);

  return { x, y, r, vx, vy, hueOffset };
}

function initBackground() {
  bg.circles.length = 0;
  for (let i = 0; i < bg.circleCount; i++) bg.circles.push(makeCircle());
}

function spawnShockwave(px, py) {
  // px/py are in CSS pixels; convert to low-res space
  const x = px * bgScale;
  const y = py * bgScale;
  shockwaves.push({ x, y, r: 2 });
}

// Update + draw every frame (draw low-res -> dither -> upscale)
function updateAndDrawBackground() {
  const w = lowW;
  const h = lowH;

  if (!w || !h || !bgLowCtx) return;

  // 1) draw circles into low-res buffer
  bgLowCtx.save();
  bgLowCtx.globalCompositeOperation = "source-over";
  bgLowCtx.filter = "none";
  bgLowCtx.fillStyle = `hsl(0, 0%, ${bg.bgLightness}%)`;
  bgLowCtx.fillRect(0, 0, w, h);

  for (let i = 0; i < bg.circles.length; i++) {
    const c = bg.circles[i];

    // move
    c.x += c.vx;
    c.y += c.vy;

    // clamp max velocity so shockwaves don't fling circles too hard,
    // but keep the base random drift (no damping to zero)
    const vmax = 0.45;
    const vmag = Math.hypot(c.vx, c.vy);
    if (vmag > vmax) {
      const s = vmax / vmag;
      c.vx *= s;
      c.vy *= s;
    }

    // wrap around edges
    if (c.x < -c.r) c.x = w + c.r;
    else if (c.x > w + c.r) c.x = -c.r;

    if (c.y < -c.r) c.y = h + c.r;
    else if (c.y > h + c.r) c.y = -c.r;

    const hue = (bg.baseHue + c.hueOffset + 360) % 360;

    const lightness = bg.circleLightness;
    const alpha = bg.circleAlpha;

    bgLowCtx.fillStyle = `hsla(${hue}, ${bg.sat}%, ${lightness}%, ${alpha})`;
    bgLowCtx.beginPath();
    bgLowCtx.arc(c.x, c.y, c.r, 0, Math.PI * 2);
    bgLowCtx.fill();
  }

  // 1a) update + draw shockwaves (ring) and push particles slightly
  if (shockwaves.length) {
    bgLowCtx.save();
    bgLowCtx.lineWidth = SHOCKWAVE_THICKNESS;

    for (let si = shockwaves.length - 1; si >= 0; si--) {
      const s = shockwaves[si];
      s.r += SHOCKWAVE_SPEED;

      // fade out as it expands
      const t = Math.min(1, s.r / SHOCKWAVE_MAX_R);
      const a = (1 - t) * 0.9;

      // Draw ring (bright, same hue family)
      bgLowCtx.strokeStyle = `hsla(${bg.baseHue}, 85%, 75%, ${a})`;
      bgLowCtx.beginPath();
      bgLowCtx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
      bgLowCtx.stroke();

      // Push particles near the ring edge
      const band = 10; // thickness of the influence band in low-res px
      const inner = s.r - band;
      const outer = s.r + band;

      for (let i = 0; i < bg.circles.length; i++) {
        const c = bg.circles[i];
        const dx = c.x - s.x;
        const dy = c.y - s.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;

        if (d > inner && d < outer) {
          const push = SHOCKWAVE_PUSH * (1 - Math.abs(d - s.r) / band);
          c.vx += (dx / d) * push;
          c.vy += (dy / d) * push;
        }
      }

      // remove when done
      if (s.r > SHOCKWAVE_MAX_R) shockwaves.splice(si, 1);
    }

    bgLowCtx.restore();
  }

  // 1b) draw cursors as STARS into the same low-res buffer (so they get dithered too)
  for (const c of cursors.values()) {
    const sx = c.x * w;
    const sy = c.y * h;

    // Own cursor bright, remote cursors semi-transparent
    const alpha = c.own ? 0.95 : 0.6;

    // Star color follows current hue but is kept bright so dither is visible
    bgLowCtx.fillStyle = `hsla(${hue}, 80%, 70%, ${alpha})`;

    // Star size in low-res space (tweak if needed)
    drawStar(bgLowCtx, sx, sy, 6);
  }

  // 2) dither the low-res buffer (always runs; it's small)
  applyDither(bgLowCtx, w, h, bg.ditherLevels, bg.ditherStrength);

  bgLowCtx.restore();

  // 3) upscale to full canvas (pixelated look)
  bgCtx.save();
  bgCtx.globalCompositeOperation = "source-over";
  bgCtx.imageSmoothingEnabled = false; // important: keep chunky pixels
  bgCtx.clearRect(0, 0, bgCanvas.width, bgCanvas.height);
  bgCtx.drawImage(bgLowCanvas, 0, 0, bgCanvas.width, bgCanvas.height);
  bgCtx.restore();
}

// Resize canvas to match window dimensions
function resizeCanvas() {
  const w = window.innerWidth;
  const h = window.innerHeight;

  bgCanvas.width = w;
  bgCanvas.height = h;

  lowW = Math.max(1, Math.floor(w * bgScale));
  lowH = Math.max(1, Math.floor(h * bgScale));
  bgLowCanvas.width = lowW;
  bgLowCanvas.height = lowH;

  // rebuild circles for the new size (in low-res space)
  initBackground();
}

resizeCanvas();
window.addEventListener("resize", resizeCanvas);

// Variables to track interaction state and position
let isInteracting = false;

// Pointer down: start interaction
window.addEventListener("pointerdown", (e) => {
  isInteracting = true;


  // Cycle clickCounter on each pointer down: 0 → 1 → 2 → 0
  clickCounter = (clickCounter + 1) % 3;

  // Shockwave on click/tap
  spawnShockwave(e.clientX, e.clientY);

  // Start music playback on first user gesture
  startAudioIfNeeded();

  // Normalize pointer coordinates relative to canvas size
  const x = e.clientX / bgCanvas.width;
  const y = e.clientY / bgCanvas.height;

  // Store current client's cursor position
  cursors.set(clientId, new Cursor(clientId, x, y, true));
  sendFullState();
});

window.addEventListener("pointermove", (e) => {
  if (!isInteracting) return;



  const x = e.clientX / bgCanvas.width;
  const y = e.clientY / bgCanvas.height;

  // HUE: absolute horizontal position while pressed (0..360 across the screen)
  hue = Math.round((e.clientX / window.innerWidth) * 360);
  hue = Math.max(0, Math.min(360, hue));
  // Background hue follows left/right movement
  bg.baseHue = hue;

  // Vertical position (0..1): drives filter + value sent to server
  const yNorm = e.clientY / window.innerHeight;

  // Send as 0..1 where top=1 and bottom=0 (useful as a control signal)
  volumeValue = Number(clamp01(1 - yNorm).toFixed(4));

  // Apply audio filter (top -> highpass, bottom -> lowpass)
  setFilterFromY(yNorm);

  // Background is handled by bgCanvas animation

  // Update local cursor position
  cursors.get(clientId)?.move(x, y);
  sendFullState();
});

// Pointer up: end interaction
window.addEventListener("pointerup", () => {
  isInteracting = false;

  // Remove current client's cursor from local map
  cursors.delete(clientId);
  sendFullState();
});

// WebSocket event: connection opened
ws.addEventListener("open", () => {
  console.log("Socket connection open");
  ws.send("pong");
});

// WebSocket event: message received
ws.addEventListener("message", (message) => {
  if (!message.data) return;

  let data;
  try {
    data = JSON.parse(message.data);
  } catch {
    return;
  }

  // Combined state message with cursors (accept both `coursor` and legacy `stars`)
  const incomingCursors = (data && (data.coursor || data.stars)) || null;
  if (incomingCursors) {
    // Preserve own cursor locally
    const ownCursor = cursors.get(clientId);

    // Remove only other clients' cursors (we re-add them from the incoming state)
    for (const [id] of cursors) {
      if (id !== clientId) cursors.delete(id);
    }

    // Add all cursors from the server, except own
    incomingCursors.forEach((s) => {
      if (s.id === clientId) return;
      cursors.set(s.id, new Cursor(s.id, s.x, s.y, false));
    });

    // Ensure own cursor remains
    if (ownCursor) cursors.set(clientId, ownCursor);

    // Update sliders and click values (for TouchDesigner sync)
    if (typeof data.slider1 === "number") hue = data.slider1;
    if (typeof data.slider2 === "number") volumeValue = data.slider2;
    if (typeof data.click === "number") clickCounter = data.click;

    return;
  }
});

ws.addEventListener("error", (error) => {
  console.error("Error in the connection", error);
});

ws.addEventListener("close", () => {
  console.log("Socket connection closed");
});

// Helper function to draw a star shape
function drawStar(ctx, x, y, r, points = 5) {
  const step = Math.PI / points;
  ctx.beginPath();
  for (let i = 0; i < 2 * points; i++) {
    const radius = (i % 2 === 0) ? r : r * 0.45;
    const angle = i * step - Math.PI / 2;
    ctx.lineTo(
      x + Math.cos(angle) * radius,
      y + Math.sin(angle) * radius
    );
  }
  ctx.closePath();
  ctx.fill();
}

/********************************************
 * Animation Loop
 ********************************************/
function renderFrame() {
  updateAndDrawBackground();
  requestAnimationFrame(renderFrame);
}

renderFrame();