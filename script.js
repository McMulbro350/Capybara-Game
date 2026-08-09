// ============================================================================
// CAPYBARA BEAN BOUNCE
//
// This file is organized into these sections:
//   1. LEVEL_CONFIGS & GAME_CONFIG - all tunable numbers live here
//   2. Asset loading                - loads the canvas-drawn images
//   3. Progress (level unlocks)      - saved to localStorage
//   4. Setup & state                 - canvas, lanes, game state variables
//   5. Player (capybara)             - position, movement, jump, drawing
//   6. Jelly beans                    - fair "always something falling" spawner
//   7. Collision detection
//   8. Score & high score
//   9. Background drawing (sky gradient, drifting clouds, ground art)
//  10. Game loop
//  11. Input handling (buttons, keyboard, touch)
//  12. Title screen intro animation
//  13. Level select screen
//  14. Level flow (start / win / lose) + screen transitions
// ============================================================================


// ----------------------------------------------------------------------------
// 1. LEVEL_CONFIGS & GAME_CONFIG
//
//    LEVEL_CONFIGS holds only the numbers that change between levels
//    (speed, spawn rate, how many beans you need to dodge to win). Add a
//    "2:" and "3:" entry here later to bring Level 2 / 3 to life — the rest
//    of the game already reads from whichever level is currently active.
//
//    GAME_CONFIG holds everything else (sizes, movement feel, hitboxes)
//    that stays the same across every level.
// ----------------------------------------------------------------------------
const LEVEL_CONFIGS = {
    1: {
        label: 'Level 1 — Easy',
        jellyBeanSpeed: 195,     // pixels per second they fall
        spawnIntervalMin: 500,   // ms between spawns (min) — keeps the sky lively
        spawnIntervalMax: 900,   // ms (max)
        maxActiveBeans: 3,       // never more than this many falling at once
        winScore: 10             // beans you must dodge to clear the level
    }
};
const TOTAL_LEVELS = 3; // level-select shows this many badges (levels 2 & 3 arrive later)

const GAME_CONFIG = {
    laneCount: 3,

    // Jelly beans (visual size / hitbox — falling speed lives in LEVEL_CONFIGS)
    jellyBeanDisplayWidth: 40,
    jellyBeanHitboxSafeFraction: 0.72, // collision radius as a fraction of the bean's own half-size

    // Player (capybara)
    playerMoveSpeed: 12,          // how quickly the capybara slides to a new lane (higher = snappier)
    capybaraDisplayWidth: 96,
    capybaraHitboxSafeFraction: 0.55, // collision radius as a fraction of the capybara's own half-size
    jumpAnimationDurationMs: 380,     // how long the "jump" sprite shows after a lane change
    jumpBounceHeight: 12,             // purely visual hop height in pixels (does not affect collision)

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
//    (Only images drawn ON THE CANVAS need to be preloaded like this — the
//    title logo, buttons, and level badges are plain HTML <img> tags, so the
//    browser loads those on its own.)
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
// 3. Progress (which levels are unlocked) — saved to localStorage
// ----------------------------------------------------------------------------
const PROGRESS_KEY = 'capybaraBeanBounce_progress';

function loadProgress() {
    try {
        const saved = JSON.parse(localStorage.getItem(PROGRESS_KEY));
        if (saved && typeof saved.unlockedLevel === 'number') return saved;
    } catch (e) {
        // ignore malformed/missing data and fall back to defaults below
    }
    return { unlockedLevel: 1 };
}

function saveProgress() {
    localStorage.setItem(PROGRESS_KEY, JSON.stringify(progress));
}

let progress = loadProgress();


// ----------------------------------------------------------------------------
// 4. Setup & state
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

// Game state: 'loading' | 'title' | 'levelSelect' | 'playing' | 'levelComplete' | 'gameover'
let gameState = 'loading';

let currentLevel = 1;
let currentLevelConfig = LEVEL_CONFIGS[1];

let activeBeans = [];      // jelly beans currently falling
let spawnTimer = 0;        // counts down (ms) until the next bean may spawn
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
// 5. Player (capybara) — movement, jump animation, drawing
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
// 6. Jelly beans — a fair, "always something falling" spawner
//
//    FAIRNESS RULE: at most 2 of the 3 lanes are ever occupied by a bean at
//    the same time. Whenever a new bean is due to spawn, if 2 lanes already
//    have a bean falling, the new one is placed in one of THOSE 2 lanes —
//    never a brand new 3rd lane. That means a lane is always free to dodge
//    into, by construction, no matter how often beans spawn.
// ----------------------------------------------------------------------------
function spawnBean(lane) {
    const img = assets.beans[Math.floor(Math.random() * assets.beans.length)];
    const w = GAME_CONFIG.jellyBeanDisplayWidth;
    const h = w * (img.naturalHeight / img.naturalWidth);
    activeBeans.push({
        lane: lane,
        x: LANE_CENTERS[lane],
        y: -h,
        speed: currentLevelConfig.jellyBeanSpeed,
        img: img,
        // Sized to this specific bean's own art, so the hitbox never
        // reaches past its actual width or height in any direction.
        radius: (Math.min(w, h) / 2) * GAME_CONFIG.jellyBeanHitboxSafeFraction,
        scored: false // becomes true the moment it passes the capybara (see updateBeans)
    });
}

function updateSpawning(dtMs) {
    spawnTimer -= dtMs;

    const occupiedLanes = new Set(activeBeans.map(bean => bean.lane));
    const screenIsEmpty = activeBeans.length === 0; // never leave the sky completely clear

    if ((spawnTimer <= 0 || screenIsEmpty) && activeBeans.length < currentLevelConfig.maxActiveBeans) {
        const candidateLanes = [];
        for (let i = 0; i < GAME_CONFIG.laneCount; i++) {
            if (occupiedLanes.has(i) || occupiedLanes.size < 2) candidateLanes.push(i);
        }
        const lane = candidateLanes[Math.floor(Math.random() * candidateLanes.length)];
        spawnBean(lane);

        spawnTimer = currentLevelConfig.spawnIntervalMin +
            Math.random() * (currentLevelConfig.spawnIntervalMax - currentLevelConfig.spawnIntervalMin);
    }
}

function updateBeans(dt) {
    for (const bean of activeBeans) {
        bean.y += bean.speed * dt;

        // The score counts beans that get past you, not survival time —
        // award the point the instant a bean's center passes your row.
        if (!bean.scored && bean.y > capybaraCollisionCenterY) {
            bean.scored = true;
            score += 1;
        }
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
// 7. Collision detection (circle-based, with hitboxes kept inside the art)
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
// 8. Score & high score
// ----------------------------------------------------------------------------
function loadBestScore() {
    const saved = localStorage.getItem('capybaraBeanBounce_bestScore');
    return saved ? parseInt(saved, 10) : 0;
}

function saveBestScoreIfNeeded() {
    if (score > bestScore) {
        bestScore = score;
        localStorage.setItem('capybaraBeanBounce_bestScore', String(bestScore));
    }
}

function updateHud() {
    document.getElementById('score-display').textContent = 'Score: ' + score;
    document.getElementById('best-display').textContent = 'Best: ' + bestScore;
}


// ----------------------------------------------------------------------------
// 9. Background drawing (sky gradient, drifting clouds, ground art)
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
// 10. Game loop
// ----------------------------------------------------------------------------
function gameLoop(timestamp) {
    if (lastFrameTime === null) lastFrameTime = timestamp;
    const dtMs = Math.min(50, timestamp - lastFrameTime); // clamp to avoid huge jumps (e.g. tab switch)
    const dt = dtMs / 1000;
    lastFrameTime = timestamp;

    if (gameState === 'playing') {
        updateSpawning(dtMs);
        updateBeans(dt);
        updatePlayer(dt);
        updateHud();

        if (checkCollisions()) {
            triggerGameOver();
        } else if (score >= currentLevelConfig.winScore) {
            completeLevel();
        }
    }

    // The sky/clouds/ground keep drifting behind every screen, including
    // the title and level-select overlays, for a lively, continuous feel.
    drawBackground(timestamp);

    // Only draw the gameplay capybara/beans while actually playing (or on
    // the game-over screen, so the moment of collision is still visible) —
    // the title screen has its own separate capybara graphic.
    if (gameState === 'playing' || gameState === 'gameover') {
        for (const bean of activeBeans) drawJellyBean(bean);
        drawCapybara(timestamp);
    }

    requestAnimationFrame(gameLoop);
}


// ----------------------------------------------------------------------------
// 11. Input handling — keyboard, on-screen buttons, and touch
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
// 12. Title screen intro animation
//     Logo drops in and starts wobbling -> capybara drops in and starts
//     wobbling -> Play button pops in. Each step waits for the previous
//     one's drop animation to actually finish (via 'animationend') rather
//     than a guessed delay, so it stays in sync even if timings change.
// ----------------------------------------------------------------------------
function runTitleIntro() {
    const scene = document.getElementById('title-scene');
    const logo = document.getElementById('title-logo');
    const capy = document.getElementById('title-capybara');
    const playBtn = document.getElementById('btn-play');

    scene.classList.remove('hidden');
    logo.classList.add('drop-in');

    logo.addEventListener('animationend', () => {
        logo.classList.add('wobble');

        setTimeout(() => {
            capy.classList.add('drop-in');

            capy.addEventListener('animationend', () => {
                capy.classList.add('wobble');

                setTimeout(() => {
                    playBtn.classList.remove('hidden');
                    playBtn.classList.add('pop-in');
                }, 250);
            }, { once: true });
        }, 200);
    }, { once: true });
}


// ----------------------------------------------------------------------------
// 13. Level select screen
// ----------------------------------------------------------------------------
const levelSelectScreen = document.getElementById('level-select-screen');

function renderLevelSelect() {
    document.querySelectorAll('.level-btn').forEach(btn => {
        const level = parseInt(btn.dataset.level, 10);
        btn.classList.toggle('locked', level > progress.unlockedLevel);
    });
}

function showComingSoonToast() {
    const toast = document.getElementById('coming-soon-toast');
    toast.classList.remove('hidden');
    clearTimeout(showComingSoonToast.timer);
    showComingSoonToast.timer = setTimeout(() => toast.classList.add('hidden'), 1500);
}

document.querySelectorAll('.level-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const level = parseInt(btn.dataset.level, 10);
        const unlocked = level <= progress.unlockedLevel;

        if (!unlocked) {
            btn.classList.remove('shake');
            requestAnimationFrame(() => btn.classList.add('shake'));
            return;
        }
        if (!LEVEL_CONFIGS[level]) {
            showComingSoonToast(); // badge is unlocked, but this level isn't built yet
            return;
        }

        levelSelectScreen.classList.add('hidden');
        startGame(level);
    });
});


// ----------------------------------------------------------------------------
// 14. Level flow (start / win / lose) + screen transitions
// ----------------------------------------------------------------------------
const titleScreen = document.getElementById('title-screen');
const gameOverScreen = document.getElementById('game-over-screen');
const levelCompleteScreen = document.getElementById('level-complete-screen');
const hudEl = document.getElementById('hud');
const controlsEl = document.getElementById('controls');

// Fades hideEl out, then fades showEl in. Used for the bigger screen swaps
// (title <-> level select) so the transition feels smooth rather than an
// abrupt cut.
function fadeSwap(hideEl, showEl, duration = 500) {
    hideEl.style.transition = `opacity ${duration}ms ease`;
    hideEl.style.opacity = '0';

    setTimeout(() => {
        hideEl.classList.add('hidden');
        hideEl.style.opacity = '';
        hideEl.style.transition = '';

        showEl.classList.remove('hidden');
        showEl.style.opacity = '0';
        showEl.style.transition = `opacity ${duration}ms ease`;
        requestAnimationFrame(() => {
            showEl.style.opacity = '1';
        });
        setTimeout(() => {
            showEl.style.opacity = '';
            showEl.style.transition = '';
        }, duration);
    }, duration);
}

document.getElementById('btn-play').addEventListener('click', () => {
    renderLevelSelect();
    fadeSwap(titleScreen, levelSelectScreen, 600);
    gameState = 'levelSelect';
});

function startGame(level) {
    currentLevel = level;
    currentLevelConfig = LEVEL_CONFIGS[level];

    activeBeans = [];
    spawnTimer = 0; // spawn the first bean right away
    score = 0;
    playerLane = 1;
    playerX = LANE_CENTERS[playerLane];
    playerJumpUntil = 0;
    facingDirection = 'right';

    updateHud();
    gameOverScreen.classList.add('hidden');
    levelCompleteScreen.classList.add('hidden');
    hudEl.classList.remove('hidden');
    controlsEl.classList.remove('hidden');
    gameState = 'playing';
}

function triggerGameOver() {
    gameState = 'gameover';
    saveBestScoreIfNeeded();

    hudEl.classList.add('hidden');
    controlsEl.classList.add('hidden');

    document.getElementById('final-score').textContent = 'Score: ' + score;
    document.getElementById('final-best').textContent = 'Best: ' + bestScore;
    gameOverScreen.classList.remove('hidden');
}

function completeLevel() {
    gameState = 'levelComplete';
    saveBestScoreIfNeeded();

    hudEl.classList.add('hidden');
    controlsEl.classList.add('hidden');

    // Unlock the next level (if this was the newest one beaten).
    if (currentLevel === progress.unlockedLevel && progress.unlockedLevel < TOTAL_LEVELS) {
        progress.unlockedLevel = currentLevel + 1;
        saveProgress();
    }

    levelCompleteScreen.classList.remove('hidden');

    setTimeout(() => {
        levelCompleteScreen.classList.add('hidden');
        renderLevelSelect();
        levelSelectScreen.classList.remove('hidden');
        gameState = 'levelSelect';
    }, 1600);
}

document.getElementById('btn-play-again').addEventListener('click', () => startGame(currentLevel));

document.getElementById('btn-to-level-select').addEventListener('click', () => {
    gameOverScreen.classList.add('hidden');
    renderLevelSelect();
    levelSelectScreen.classList.remove('hidden');
    gameState = 'levelSelect';
});


// ----------------------------------------------------------------------------
// Boot up: load assets, compute layout, then run the title screen intro
// and kick off the render loop (which draws the drifting background right
// away, even before Play is pressed).
// ----------------------------------------------------------------------------
loadAllAssets().then(() => {
    computeLayout();
    document.getElementById('loading-text').classList.add('hidden');
    gameState = 'title';
    runTitleIntro();
    requestAnimationFrame(gameLoop);
}).catch(err => {
    console.error('Failed to load game assets:', err);
    document.getElementById('loading-text').textContent = 'Could not load game assets.';
});
