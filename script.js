// ============================================================================
// CAPYBARA JELLY DODGE — Level 1 (Easy)
//
// This file is organized into these sections:
//   1. GAME_CONFIG        - all tunable numbers live here
//   2. Setup & state       - canvas, lanes, game state variables
//   3. Player (capybara)   - position, movement, drawing
//   4. Jelly beans          - spawning system, movement, drawing
//   5. Collision detection
//   6. Score & high score
//   7. Background drawing
//   8. Game loop
//   9. Input handling (buttons, keyboard, touch)
//  10. Start / game over screens
// ============================================================================


// ----------------------------------------------------------------------------
// 1. GAME_CONFIG — change these numbers to tune difficulty.
//    Later, Level 2 / Level 3 can simply swap in a different config object.
// ----------------------------------------------------------------------------
const GAME_CONFIG = {
    laneCount: 3,

    // Jelly beans
    jellyBeanSpeed: 150,        // pixels per second they fall
    jellyBeanRadiusX: 20,       // visual size
    jellyBeanRadiusY: 24,
    jellyBeanHitboxScale: 0.72, // collision circle is smaller than the visual bean (forgiving)

    // Spawning — see spawnJellyBeans() for how these are used to keep things fair
    spawnIntervalMin: 1300,     // ms between one wave finishing and the next starting (min)
    spawnIntervalMax: 2000,     // ms (max)
    doubleSpawnChance: 0.3,     // chance a wave gets a 2nd "companion" bean
    companionDelayMin: 500,     // ms after the first bean of a wave before a companion can appear
    companionDelayMax: 1000,    // ms

    // Player (capybara)
    playerMoveSpeed: 12,        // how quickly the capybara slides to a new lane (higher = snappier)
    capybaraBodyRadiusX: 46,
    capybaraBodyRadiusY: 40,
    capybaraHitboxScale: 0.55,  // collision circle is smaller than the visual capybara (forgiving)

    // Score
    pointsPerSecond: 10
};


// ----------------------------------------------------------------------------
// 2. Setup & state
// ----------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const CANVAS_WIDTH = canvas.width;   // 360 — fixed internal resolution.
const CANVAS_HEIGHT = canvas.height; // 640 — CSS scales this to fit the screen.
const GROUND_HEIGHT = 100;

// Work out the x position (center) of each of the 3 lanes.
const LANE_WIDTH = CANVAS_WIDTH / GAME_CONFIG.laneCount;
const LANE_CENTERS = [];
for (let i = 0; i < GAME_CONFIG.laneCount; i++) {
    LANE_CENTERS.push(LANE_WIDTH * i + LANE_WIDTH / 2);
}

const JELLY_BEAN_COLORS = [
    '#FF9FB8', // pink
    '#9FD8FA', // light blue
    '#FFE08A', // yellow
    '#C9A6FF', // purple
    '#9CF0C4', // mint green
    '#FFC08A'  // orange
];

// Game state: 'start' | 'playing' | 'gameover'
let gameState = 'start';

let activeBeans = [];      // jelly beans currently falling
let spawnTimer = 0;        // counts down (ms) until the next wave may spawn
let surviveTimeMs = 0;     // how long the current run has lasted
let score = 0;
let bestScore = loadBestScore();

let lastFrameTime = null;

// The capybara's current lane (0 = left, 1 = middle, 2 = right)
let playerLane = 1;
// Its animated x position (slides smoothly toward the target lane's x)
let playerX = LANE_CENTERS[playerLane];
const playerY = CANVAS_HEIGHT - GROUND_HEIGHT - 34; // resting position on the ground


// ----------------------------------------------------------------------------
// 3. Player (capybara) — movement & drawing
// ----------------------------------------------------------------------------
function movePlayerLeft() {
    if (gameState !== 'playing') return;
    if (playerLane > 0) playerLane -= 1;
}

function movePlayerRight() {
    if (gameState !== 'playing') return;
    if (playerLane < GAME_CONFIG.laneCount - 1) playerLane += 1;
}

function updatePlayer(dt) {
    const targetX = LANE_CENTERS[playerLane];
    // Smoothly slide toward the target lane instead of snapping instantly.
    const closeAmount = Math.min(1, GAME_CONFIG.playerMoveSpeed * dt);
    playerX += (targetX - playerX) * closeAmount;
}

function drawCapybara(x, y) {
    const rx = GAME_CONFIG.capybaraBodyRadiusX;
    const ry = GAME_CONFIG.capybaraBodyRadiusY;

    ctx.save();
    ctx.translate(x, y);

    // Tiny legs peeking out from under the body
    ctx.fillStyle = '#C99A6B';
    ctx.beginPath();
    ctx.ellipse(-rx * 0.55, ry * 0.75, 10, 8, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rx * 0.55, ry * 0.75, 10, 8, 0, 0, Math.PI * 2);
    ctx.fill();

    // Ears
    ctx.fillStyle = '#C99A6B';
    ctx.beginPath();
    ctx.ellipse(-rx * 0.55, -ry * 0.85, 15, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rx * 0.55, -ry * 0.85, 15, 15, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#8C6845';
    ctx.beginPath();
    ctx.ellipse(-rx * 0.55, -ry * 0.85, 7, 7, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rx * 0.55, -ry * 0.85, 7, 7, 0, 0, Math.PI * 2);
    ctx.fill();

    // Main potato-shaped body
    ctx.fillStyle = '#D8AE7E';
    ctx.strokeStyle = '#8C6845';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    // Eyes
    ctx.fillStyle = '#3A2A1D';
    ctx.beginPath();
    ctx.ellipse(-rx * 0.32, -ry * 0.1, 4.5, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.beginPath();
    ctx.ellipse(rx * 0.32, -ry * 0.1, 4.5, 5.5, 0, 0, Math.PI * 2);
    ctx.fill();

    // Nose / simple mouth
    ctx.fillStyle = '#8C6845';
    ctx.beginPath();
    ctx.ellipse(0, ry * 0.28, 7, 5, 0, 0, Math.PI * 2);
    ctx.fill();

    ctx.restore();
}


// ----------------------------------------------------------------------------
// 4. Jelly beans — the fair spawning system
//
//    FAIRNESS RULE: at most 2 jelly beans are ever on screen at once, and a
//    2nd ("companion") bean is only ever placed in one of the lanes NOT
//    already used by the 1st bean. That means at most 2 of the 3 lanes are
//    ever occupied at the same time — there is always at least one lane free
//    for the player to escape into, so an unavoidable 3-lane wall is
//    impossible by construction (not just by luck).
// ----------------------------------------------------------------------------
function randomLane() {
    return Math.floor(Math.random() * GAME_CONFIG.laneCount);
}

function spawnBean(lane) {
    activeBeans.push({
        lane: lane,
        x: LANE_CENTERS[lane],
        y: -GAME_CONFIG.jellyBeanRadiusY,
        speed: GAME_CONFIG.jellyBeanSpeed,
        color: JELLY_BEAN_COLORS[Math.floor(Math.random() * JELLY_BEAN_COLORS.length)],
        hasFace: Math.random() < 0.3,   // only some beans get a tiny face, to stay uncluttered
        ageMs: 0,
        isWaveStarter: false,
        companionPending: false,
        companionDelay: 0
    });
}

function updateSpawning(dt, dtMs) {
    // Only start a brand-new wave once the screen is completely clear of beans.
    // This guarantees waves never overlap in a way that could stack up lanes.
    if (activeBeans.length === 0) {
        spawnTimer -= dtMs;
        if (spawnTimer <= 0) {
            const lane = randomLane();
            spawnBean(lane);
            const startedBean = activeBeans[activeBeans.length - 1];
            startedBean.isWaveStarter = true;

            // Decide right away whether this wave will get a companion bean,
            // and if so, how long to wait before it appears.
            startedBean.companionPending = Math.random() < GAME_CONFIG.doubleSpawnChance;
            startedBean.companionDelay =
                GAME_CONFIG.companionDelayMin +
                Math.random() * (GAME_CONFIG.companionDelayMax - GAME_CONFIG.companionDelayMin);

            // Reset the timer for the wave AFTER this one.
            spawnTimer =
                GAME_CONFIG.spawnIntervalMin +
                Math.random() * (GAME_CONFIG.spawnIntervalMax - GAME_CONFIG.spawnIntervalMin);
        }
    }

    // Check whether any wave-starting bean is ready to spawn its companion.
    for (const bean of activeBeans) {
        if (bean.isWaveStarter && bean.companionPending) {
            if (bean.ageMs >= bean.companionDelay) {
                // Pick a lane that is NOT the wave-starter's lane. With only
                // one other bean ever active, this leaves the 3rd lane free.
                const otherLanes = [];
                for (let i = 0; i < GAME_CONFIG.laneCount; i++) {
                    if (i !== bean.lane) otherLanes.push(i);
                }
                const companionLane = otherLanes[Math.floor(Math.random() * otherLanes.length)];
                spawnBean(companionLane);
                bean.companionPending = false; // only one companion per wave
            }
        }
    }
}

function updateBeans(dt, dtMs) {
    for (const bean of activeBeans) {
        bean.y += bean.speed * dt;
        bean.ageMs += dtMs;
    }
    // Remove beans that have fallen off the bottom of the screen.
    activeBeans = activeBeans.filter(bean => bean.y - GAME_CONFIG.jellyBeanRadiusY < CANVAS_HEIGHT);
}

function drawJellyBean(bean) {
    const rx = GAME_CONFIG.jellyBeanRadiusX;
    const ry = GAME_CONFIG.jellyBeanRadiusY;

    ctx.save();
    ctx.translate(bean.x, bean.y);

    // Soft shadow beneath the bean for a little depth
    ctx.fillStyle = 'rgba(0,0,0,0.08)';
    ctx.beginPath();
    ctx.ellipse(0, ry * 0.85, rx * 0.8, ry * 0.25, 0, 0, Math.PI * 2);
    ctx.fill();

    // Glossy puffy bean body, using a gradient for a squishy highlight
    const gradient = ctx.createRadialGradient(-rx * 0.35, -ry * 0.4, 2, 0, 0, rx * 1.3);
    gradient.addColorStop(0, '#ffffff');
    gradient.addColorStop(0.25, bean.color);
    gradient.addColorStop(1, bean.color);

    ctx.fillStyle = gradient;
    ctx.beginPath();
    ctx.ellipse(0, 0, rx, ry, 0, 0, Math.PI * 2);
    ctx.fill();

    if (bean.hasFace) {
        ctx.fillStyle = 'rgba(60,40,30,0.65)';
        ctx.beginPath();
        ctx.ellipse(-rx * 0.3, ry * 0.05, 2, 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.beginPath();
        ctx.ellipse(rx * 0.3, ry * 0.05, 2, 2.6, 0, 0, Math.PI * 2);
        ctx.fill();
    }

    ctx.restore();
}


// ----------------------------------------------------------------------------
// 5. Collision detection (circle-based, with shrunk "forgiving" hitboxes)
// ----------------------------------------------------------------------------
function checkCollisions() {
    const capybaraRadius =
        Math.min(GAME_CONFIG.capybaraBodyRadiusX, GAME_CONFIG.capybaraBodyRadiusY) *
        GAME_CONFIG.capybaraHitboxScale;

    for (const bean of activeBeans) {
        const beanRadius =
            Math.min(GAME_CONFIG.jellyBeanRadiusX, GAME_CONFIG.jellyBeanRadiusY) *
            GAME_CONFIG.jellyBeanHitboxScale;

        const dx = bean.x - playerX;
        const dy = bean.y - playerY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < capybaraRadius + beanRadius) {
            return true; // collision!
        }
    }
    return false;
}


// ----------------------------------------------------------------------------
// 6. Score & high score
// ----------------------------------------------------------------------------
function loadBestScore() {
    const saved = localStorage.getItem('capybaraJellyDodge_bestScore');
    return saved ? parseInt(saved, 10) : 0;
}

function saveBestScore(value) {
    localStorage.setItem('capybaraJellyDodge_bestScore', String(value));
}

function updateHud() {
    document.getElementById('score-display').textContent = 'Score: ' + score;
    document.getElementById('best-display').textContent = 'Best: ' + bestScore;
}


// ----------------------------------------------------------------------------
// 7. Background drawing (sky, clouds, grass, faint lane guides)
// ----------------------------------------------------------------------------
function drawBackground(timeMs) {
    // Sky
    const skyGradient = ctx.createLinearGradient(0, 0, 0, CANVAS_HEIGHT - GROUND_HEIGHT);
    skyGradient.addColorStop(0, '#bfe6f5');
    skyGradient.addColorStop(1, '#e8f6f5');
    ctx.fillStyle = skyGradient;
    ctx.fillRect(0, 0, CANVAS_WIDTH, CANVAS_HEIGHT);

    // Slowly drifting clouds
    drawCloud(60 + ((timeMs * 0.006) % (CANVAS_WIDTH + 120)) - 60, 90);
    drawCloud(220 - ((timeMs * 0.004) % (CANVAS_WIDTH + 120)) + 60, 170);
    drawCloud(140 + ((timeMs * 0.005) % (CANVAS_WIDTH + 120)) - 60, 260);

    // Faint lane guides (subtle, not big racing-lane lines)
    ctx.save();
    ctx.strokeStyle = 'rgba(255,255,255,0.35)';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 10]);
    for (let i = 1; i < GAME_CONFIG.laneCount; i++) {
        const x = LANE_WIDTH * i;
        ctx.beginPath();
        ctx.moveTo(x, 0);
        ctx.lineTo(x, CANVAS_HEIGHT - GROUND_HEIGHT);
        ctx.stroke();
    }
    ctx.restore();

    // Ground
    ctx.fillStyle = '#bfe6a0';
    ctx.fillRect(0, CANVAS_HEIGHT - GROUND_HEIGHT, CANVAS_WIDTH, GROUND_HEIGHT);

    // Little grass tufts along the top edge of the ground
    ctx.fillStyle = '#a8d98a';
    for (let x = 10; x < CANVAS_WIDTH; x += 24) {
        ctx.beginPath();
        ctx.ellipse(x, CANVAS_HEIGHT - GROUND_HEIGHT, 10, 6, 0, 0, Math.PI * 2);
        ctx.fill();
    }
}

function drawCloud(x, y) {
    ctx.save();
    ctx.fillStyle = 'rgba(255,255,255,0.8)';
    ctx.beginPath();
    ctx.ellipse(x, y, 26, 14, 0, 0, Math.PI * 2);
    ctx.ellipse(x + 22, y + 3, 18, 11, 0, 0, Math.PI * 2);
    ctx.ellipse(x - 20, y + 4, 16, 10, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
}


// ----------------------------------------------------------------------------
// 8. Game loop
// ----------------------------------------------------------------------------
function gameLoop(timestamp) {
    if (lastFrameTime === null) lastFrameTime = timestamp;
    const dtMs = Math.min(50, timestamp - lastFrameTime); // clamp to avoid huge jumps (e.g. tab switch)
    const dt = dtMs / 1000;
    lastFrameTime = timestamp;

    if (gameState === 'playing') {
        updateSpawning(dt, dtMs);
        updateBeans(dt, dtMs);
        updatePlayer(dt);

        surviveTimeMs += dtMs;
        score = Math.floor((surviveTimeMs / 1000) * GAME_CONFIG.pointsPerSecond);
        updateHud();

        if (checkCollisions()) {
            triggerGameOver();
        }
    }

    // Draw everything (also drawn behind the start/game-over overlays)
    drawBackground(timestamp);
    for (const bean of activeBeans) drawJellyBean(bean);
    drawCapybara(playerX, playerY);

    requestAnimationFrame(gameLoop);
}


// ----------------------------------------------------------------------------
// 9. Input handling — keyboard, on-screen buttons, and touch
// ----------------------------------------------------------------------------
document.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowLeft') movePlayerLeft();
    if (e.key === 'ArrowRight') movePlayerRight();
});

const btnLeft = document.getElementById('btn-left');
const btnRight = document.getElementById('btn-right');

// pointerdown covers mouse clicks AND touch taps with no extra delay.
btnLeft.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    movePlayerLeft();
});
btnRight.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    movePlayerRight();
});


// ----------------------------------------------------------------------------
// 10. Start / game over screens
// ----------------------------------------------------------------------------
const startScreen = document.getElementById('start-screen');
const gameOverScreen = document.getElementById('game-over-screen');

function startGame() {
    activeBeans = [];
    spawnTimer = GAME_CONFIG.spawnIntervalMin;
    surviveTimeMs = 0;
    score = 0;
    playerLane = 1;
    playerX = LANE_CENTERS[playerLane];

    updateHud();
    startScreen.classList.add('hidden');
    gameOverScreen.classList.add('hidden');
    gameState = 'playing';
}

function triggerGameOver() {
    gameState = 'gameover';

    if (score > bestScore) {
        bestScore = score;
        saveBestScore(bestScore);
    }

    document.getElementById('final-score').textContent = 'Score: ' + score;
    document.getElementById('final-best').textContent = 'Best: ' + bestScore;
    updateHud();
    gameOverScreen.classList.remove('hidden');
}

document.getElementById('btn-play').addEventListener('click', startGame);
document.getElementById('btn-play-again').addEventListener('click', startGame);

// Initial HUD paint and kick off the render loop (draws the idle background
// and capybara even before the player presses Play).
updateHud();
requestAnimationFrame(gameLoop);
