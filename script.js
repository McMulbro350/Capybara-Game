// ============================================================================
// CAPYBARA JELLY DODGE — Level 1 (Easy)
//
// This file is organized into these sections:
//   1. GAME_CONFIG        - all tunable numbers live here
//   2. Asset loading       - loads all images before the game can start
//   3. Setup & state       - canvas, lanes, game state variables
//   4. Player (capybara)   - position, movement, jump animation, drawing
//   5. Jelly beans          - spawning system, movement, drawing
//   6. Collision detection
//   7. Score & high score
//   8. Background drawing (sky gradient, drifting clouds, ground art)
//   9. Game loop
//  10. Input handling (buttons, keyboard, touch)
//  11. Start / game over screens
// ============================================================================


// ----------------------------------------------------------------------------
// 1. GAME_CONFIG — change these numbers to tune difficulty.
//    Later, Level 2 / Level 3 can simply swap in a different config object.
// ----------------------------------------------------------------------------
const GAME_CONFIG = {
    laneCount: 3,

    // Jelly beans
    jellyBeanSpeed: 150,        // pixels per second they fall
    jellyBeanDisplayWidth: 40,  // visual width in canvas pixels (height follows each sprite's own aspect ratio)
    jellyBeanHitboxSafeFraction: 0.72, // collision radius as a fraction of the bean's own half-size (kept inside its art)

    // Spawning — see updateSpawning() for how these are used to keep things fair
    spawnIntervalMin: 1300,     // ms between one wave finishing and the next starting (min)
    spawnIntervalMax: 2000,     // ms (max)
    doubleSpawnChance: 0.3,     // chance a wave gets a 2nd "companion" bean
    companionDelayMin: 500,     // ms after the first bean of a wave before a companion can appear
    companionDelayMax: 1000,    // ms

    // Player (capybara)
    playerMoveSpeed: 12,          // how quickly the capybara slides to a new lane (higher = snappier)
    capybaraDisplayWidth: 96,     // visual width in canvas pixels (height follows the sprite's aspect ratio)
    capybaraHitboxSafeFraction: 0.55, // collision radius as a fraction of the capybara's own half-size (kept inside its art)
    jumpAnimationDurationMs: 380, // how long the "jump" sprite shows after a lane change
    jumpBounceHeight: 12,         // purely visual hop height in pixels (does not affect collision)

    // Score
    pointsPerSecond: 10,

    // Clouds — each drifts slowly and loops around when it exits the screen
    clouds: [
        { file: 'cloud_1.png', width: 92, yFraction: 0.16, xFraction: 0.15, speed: 9 },
        { file: 'cloud_2.png', width: 88, yFraction: 0.34, xFraction: 0.80, speed: 13 },
        { file: 'cloud_3.png', width: 60, yFraction: 0.48, xFraction: 0.05, speed: 6 },
        { file: 'cloud_4.png', width: 58, yFraction: 0.58, xFraction: 0.90, speed: 11 }
    ]
};


// ----------------------------------------------------------------------------
// 2. Asset loading
// ----------------------------------------------------------------------------
function loadImage(src) {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => resolve(img);
        img.onerror = reject;
        img.src = src;
    });
}

const ASSET_PATH = 'assets/';
const assets = {}; // filled in once loading finishes

async function loadAllAssets() {
    const beanFiles = [1, 2, 3, 4, 5, 6, 7, 8, 9].map(n => `bean_${n}.png`);
    const cloudFiles = GAME_CONFIG.clouds.map(c => c.file);

    const [capybaraStill, capybaraJump, ground, skyGradient, ...rest] = await Promise.all([
        loadImage(ASSET_PATH + 'capybara_still.png'),
        loadImage(ASSET_PATH + 'capybara_jump.png'),
        loadImage(ASSET_PATH + 'ground_layer.png'),
        loadImage(ASSET_PATH + 'sky_gradient.png'),
        ...beanFiles.map(f => loadImage(ASSET_PATH + f)),
        ...cloudFiles.map(f => loadImage(ASSET_PATH + f))
    ]);

    assets.capybaraStill = capybaraStill;
    assets.capybaraJump = capybaraJump;
    assets.ground = ground;
    assets.skyGradient = skyGradient;
    assets.beans = rest.slice(0, beanFiles.length);
    assets.clouds = rest.slice(beanFiles.length);
}


// ----------------------------------------------------------------------------
// 3. Setup & state
// ----------------------------------------------------------------------------
const canvas = document.getElementById('game-canvas');
const ctx = canvas.getContext('2d');

const CANVAS_WIDTH = canvas.width;   // 360 — fixed internal resolution.
const CANVAS_HEIGHT = canvas.height; // 720 — CSS scales this to fit the screen.

// Work out the x position (center) of each of the 3 lanes.
const LANE_WIDTH = CANVAS_WIDTH / GAME_CONFIG.laneCount;
const LANE_CENTERS = [];
for (let i = 0; i < GAME_CONFIG.laneCount; i++) {
    LANE_CENTERS.push(LANE_WIDTH * i + LANE_WIDTH / 2);
}

// Game state: 'loading' | 'start' | 'playing' | 'gameover'
let gameState = 'loading';

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

// Ground/sky layout — computed once assets are loaded (depends on the
// ground art's own aspect ratio so it never looks stretched or squished).
let groundDisplayHeight = 0;
let groundTopY = 0;
let playerY = 0;

// The capybara's collision circle — computed once from the STILL sprite so
// it stays perfectly consistent even while the jump sprite (a slightly
// different size) is briefly showing. See computeLayout() for the math.
let capybaraCollisionCenterY = 0;
let capybaraCollisionRadius = 0;


function computeLayout() {
    groundDisplayHeight = assets.ground.naturalHeight * (CANVAS_WIDTH / assets.ground.naturalWidth);
    groundTopY = CANVAS_HEIGHT - groundDisplayHeight;
    // Stand the capybara on the flat grass, above where the on-screen buttons sit.
    playerY = groundTopY + groundDisplayHeight * 0.56;

    // The capybara sprite is drawn with its TOP edge at (playerY - refH*0.72)
    // (see drawCapybara), so its true visual center sits a bit above playerY.
    // Work that out here, then size the collision circle to comfortably fit
    // inside the sprite's own width/height — never larger than either —
    // so the hitbox can never poke out past the art in any direction.
    const refH = GAME_CONFIG.capybaraDisplayWidth *
        (assets.capybaraStill.naturalHeight / assets.capybaraStill.naturalWidth);
    capybaraCollisionCenterY = playerY - refH * 0.22;
    capybaraCollisionRadius =
        (Math.min(GAME_CONFIG.capybaraDisplayWidth, refH) / 2) * GAME_CONFIG.capybaraHitboxSafeFraction;
}


// ----------------------------------------------------------------------------
// 4. Player (capybara) — movement, jump animation, drawing
// ----------------------------------------------------------------------------
let playerJumpUntil = 0; // timestamp (ms) until which the "jump" sprite is shown
let facingDirection = 'right'; // 'right' or 'left' — flips the capybara sprite to match

function movePlayerLeft() {
    if (gameState !== 'playing') return;
    if (playerLane > 0) {
        playerLane -= 1;
        facingDirection = 'left';
        triggerJumpAnimation();
    }
}

function movePlayerRight() {
    if (gameState !== 'playing') return;
    if (playerLane < GAME_CONFIG.laneCount - 1) {
        playerLane += 1;
        facingDirection = 'right';
        triggerJumpAnimation();
    }
}

function triggerJumpAnimation() {
    playerJumpUntil = performance.now() + GAME_CONFIG.jumpAnimationDurationMs;
}

function updatePlayer(dt) {
    const targetX = LANE_CENTERS[playerLane];
    // Smoothly slide toward the target lane instead of snapping instantly.
    const closeAmount = Math.min(1, GAME_CONFIG.playerMoveSpeed * dt);
    playerX += (targetX - playerX) * closeAmount;
}

function drawCapybara(now) {
    const isJumping = now < playerJumpUntil;
    const img = isJumping ? assets.capybaraJump : assets.capybaraStill;

    const w = GAME_CONFIG.capybaraDisplayWidth;
    const h = w * (img.naturalHeight / img.naturalWidth);

    // Small cosmetic hop while the jump sprite is showing (visual only —
    // collision detection always uses the capybara's resting position).
    let bounce = 0;
    if (isJumping) {
        const remaining = playerJumpUntil - now;
        const progress = 1 - remaining / GAME_CONFIG.jumpAnimationDurationMs; // 0 -> 1
        bounce = Math.sin(progress * Math.PI) * GAME_CONFIG.jumpBounceHeight;
    }

    const drawY = playerY - h * 0.72 - bounce;

    // The source art faces right by default, so mirror it horizontally
    // whenever the capybara is facing left.
    if (facingDirection === 'left') {
        ctx.save();
        ctx.translate(playerX, 0);
        ctx.scale(-1, 1);
        ctx.drawImage(img, -w / 2, drawY, w, h);
        ctx.restore();
    } else {
        ctx.drawImage(img, playerX - w / 2, drawY, w, h);
    }
}


// ----------------------------------------------------------------------------
// 5. Jelly beans — the fair spawning system
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
    const img = assets.beans[Math.floor(Math.random() * assets.beans.length)];
    const w = GAME_CONFIG.jellyBeanDisplayWidth;
    const h = w * (img.naturalHeight / img.naturalWidth);
    activeBeans.push({
        lane: lane,
        x: LANE_CENTERS[lane],
        y: -GAME_CONFIG.jellyBeanDisplayWidth,
        speed: GAME_CONFIG.jellyBeanSpeed,
        img: img,
        // Sized to this specific bean's own art, so the hitbox never
        // reaches past its actual width or height in any direction.
        radius: (Math.min(w, h) / 2) * GAME_CONFIG.jellyBeanHitboxSafeFraction,
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
    activeBeans = activeBeans.filter(bean => bean.y - GAME_CONFIG.jellyBeanDisplayWidth < CANVAS_HEIGHT);
}

function drawJellyBean(bean) {
    const w = GAME_CONFIG.jellyBeanDisplayWidth;
    const h = w * (bean.img.naturalHeight / bean.img.naturalWidth);

    ctx.drawImage(bean.img, bean.x - w / 2, bean.y - h / 2, w, h);
}


// ----------------------------------------------------------------------------
// 6. Collision detection (circle-based, with hitboxes kept inside the art)
// ----------------------------------------------------------------------------
function checkCollisions() {
    for (const bean of activeBeans) {
        const dx = bean.x - playerX;
        const dy = bean.y - capybaraCollisionCenterY;
        const distance = Math.sqrt(dx * dx + dy * dy);

        if (distance < capybaraCollisionRadius + bean.radius) {
            return true; // collision!
        }
    }
    return false;
}


// ----------------------------------------------------------------------------
// 7. Score & high score
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
// 8. Background drawing (sky gradient, drifting clouds, ground art)
// ----------------------------------------------------------------------------
function drawSky() {
    // The sky gradient image is just a thin vertical strip of the exact
    // colors from the original artwork — stretching it to fill the sky
    // area keeps the gradient pixel-accurate without hardcoding colors.
    ctx.drawImage(assets.skyGradient, 0, 0, CANVAS_WIDTH, groundTopY);
}

function drawClouds(timeMs) {
    const t = timeMs / 1000; // seconds
    GAME_CONFIG.clouds.forEach((cfg, i) => {
        const img = assets.clouds[i];
        const w = cfg.width;
        const h = w * (img.naturalHeight / img.naturalWidth);
        const totalRange = CANVAS_WIDTH + w;
        const startOffset = cfg.xFraction * totalRange;
        const x = ((startOffset + t * cfg.speed) % totalRange) - w;
        const y = cfg.yFraction * groundTopY;
        ctx.drawImage(img, x, y, w, h);
    });
}

function drawGround() {
    ctx.drawImage(assets.ground, 0, groundTopY, CANVAS_WIDTH, groundDisplayHeight);
}

function drawBackground(timeMs) {
    drawSky();
    drawClouds(timeMs);
    drawGround();
}


// ----------------------------------------------------------------------------
// 9. Game loop
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
    drawCapybara(timestamp);

    requestAnimationFrame(gameLoop);
}


// ----------------------------------------------------------------------------
// 10. Input handling — keyboard, on-screen buttons, and touch
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
// 11. Start / game over screens
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
    playerJumpUntil = 0;
    facingDirection = 'right';

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


// ----------------------------------------------------------------------------
// Boot up: load assets, compute layout, then reveal the Play button and
// kick off the render loop (which draws the idle scene even before Play).
// ----------------------------------------------------------------------------
loadAllAssets().then(() => {
    computeLayout();
    gameState = 'start';
    document.getElementById('loading-text').classList.add('hidden');
    document.getElementById('btn-play').classList.remove('hidden');
    updateHud();
    requestAnimationFrame(gameLoop);
}).catch(err => {
    console.error('Failed to load game assets:', err);
    document.getElementById('loading-text').textContent = 'Could not load game assets.';
});
