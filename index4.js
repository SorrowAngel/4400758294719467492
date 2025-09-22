process.stdin.setRawMode(true);
process.stdin.resume();
process.stdin.setEncoding('utf8');

const lovense = require('lovense-dart');
const MemoryReader = require('memory-reader');
const ffi = require('ffi-napi');
const ref = require('ref-napi');

const MAX_VIBRATION_STRENGTH = 50; // Start with 50% max intensity
const MIN_VIBRATION_STRENGTH = 10; // Minimum 10% intensity

// Lovense toy settings - replace with your details!
const toyName = 'YourToyName';
const toyIP = '192.168.1.XXX'; // Replace with actual IP

// Game state storage
let playerPosition = { x: 0, y: 0, z: 0 };
let viewAngles = { x: 0, y: 0 };
let enemyPositions = [];
let toyConnected = false;
let lastGoodAngles = { x: 0, y: 0 };
let processHandle = null;

// Memory offsets for CS2
const OFFSETS = {
    LOCAL_PLAYER: 0x1F8BAC,
    ENTITY_LIST: 0x4A83E40,
    PLAYER_POSITION: 0x4F30,
    VIEW_ANGLES: 0x4D90B4
};

// Windows API functions for drawing
const user32 = ffi.Library('user32', {
    'GetWindowLongW': ['long', ['int', 'int']],
    'SetWindowLongW': ['long', ['int', 'int', 'long']],
    'GetDC': ['int', ['int']],
    'ReleaseDC': ['int', ['int', 'int']],
    'GetClientRect': ['bool', ['int', 'pointer']]
});

const gdi32 = ffi.Library('gdi32', {
    'CreatePen': ['int', ['int', 'int', 'int']],
    'SelectObject': ['int', ['int', 'int']],
    'Rectangle': ['bool', ['int', 'int', 'int', 'int', 'int']],
    'DeleteObject': ['bool', ['int']]
});

// Safe view angle clamping function
function clampViewAngles(angles) {
    return {
        x: Math.max(-89, Math.min(89, angles.x)),
        y: (angles.y + 180) % 360 - 180
    };
}

// Safe memory reading wrapper
async function safeReadMemory(handle, address, type, offset = 0) {
    try {
        return await MemoryReader.readMemory(handle, address, type, offset);
    } catch (error) {
        console.warn('Memory read failed, using last good value');
        return null;
    }
}

// Convert world coordinates to screen coordinates
function worldToScreen(x, y, z) {
    const screenWidth = 1920;
    const screenHeight = 1080;
    
    const fov = 90; // Field of view in degrees
    const fovRad = (fov * Math.PI) / 180;
    const focalLength = 1 / Math.tan(fovRad / 2);
    
    const screenX = (x * focalLength / (z + 3)) * (screenWidth / 2) + (screenWidth / 2);
    const screenY = (-y * focalLength / (z + 3)) * (screenHeight / 2) + (screenHeight / 2);
    
    return { x: screenX, y: screenY };
}

// Draw boxes around enemies
function drawEnemyBoxes() {
    const csgoHwnd = user32.FindWindowW(null, 'Counter-Strike 2');
    if (!csgoHwnd) return;
    
    const hdc = user32.GetDC(csgoHwnd);
    if (!hdc) return;
    
    const pen = gdi32.CreatePen(0x000000FF, 2); // Red pen, 2 pixels thick
    const oldPen = gdi32.SelectObject(hdc, pen);
    
    // Draw boxes for each enemy
    enemyPositions.forEach(enemy => {
        gdi32.Rectangle(hdc, 
            enemy.x - 25, enemy.y - 25, // Top-left corner
            enemy.x + 25, enemy.y + 25  // Bottom-right corner
        );
    });
    
    // Clean up
    gdi32.SelectObject(hdc, oldPen);
    gdi32.DeleteObject(pen);
    user32.ReleaseDC(csgoHwnd, hdc);
}

// Initialize everything
async function initialize() {
    console.log('Connecting to Lovense toy...');
    
    try {
        await lovense.connect(toyIP);
        toyConnected = true;
        console.log(`Connected to ${toyName}`);
        
        return true;
    } catch (error) {
        console.error('Failed to connect to toy:', error);
        process.exit(1);
    }
}

// Calculate angle between positions
function calculateScreenAngle(pos1, pos2, viewX, viewY) {
    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    
    const angleToEnemy = Math.atan2(dy, dx) * (180 / Math.PI);
    const viewAngleRad = (viewY * Math.PI) / 180;
    const deltaAngle = Math.abs(angleToEnemy - viewY);
    
    return Math.min(deltaAngle, 360 - deltaAngle);
}

// Send vibration based on screen position
function sendVibration(screenDistance) {
    if (!toyConnected) return;
    
    // Calculate intensity based on screen distance and max strength
    const intensity = Math.max(
        MIN_VIBRATION_STRENGTH,
        Math.min(
            MAX_VIBRATION_STRENGTH,
            MAX_VIBRATION_STRENGTH * (1 - screenDistance)
        )
    );
    
    lovense.command(toyName, 'Vibrate', intensity);
}

// Add this function to change max strength during runtime
function setMaxVibrationStrength(newStrength) {
    if (newStrength >= 0 && newStrength <= 100) {
        MAX_VIBRATION_STRENGTH = newStrength;
        console.log(`Max vibration strength set to ${newStrength}%`);
    } else {
        console.log('Strength must be between 0 and 100');
    }
}

process.stdin.on('data', (key) => {
    // Increase max strength with '+' key
    if (key.toString() === 'F1') {
        setMaxVibrationStrength(MAX_VIBRATION_STRENGTH + 10);
    }
    // Decrease max strength with '-' key
    else if (key.toString() === 'F2') {
        setMaxVibrationStrength(MAX_VIBRATION_STRENGTH - 10);
    }
});

// Main game loop
async function startGameLoop() {
    await initialize();
    
    setInterval(async () => {
        try {
            if (!processHandle) {
                const processes = await MemoryReader.getProcessesByName('cs2.exe');
                if (!processes || processes.length === 0) {
                    console.log('CS2 not found! Please start CS2.');
                    return;
                }
                processHandle = processes[0].handle;
            }
            
            const viewAnglesBuffer = await safeReadMemory(
                processHandle,
                OFFSETS.VIEW_ANGLES,
                'float',
                2
            );
            
            if (viewAnglesBuffer) {
                lastGoodAngles = clampViewAngles({
                    x: viewAnglesBuffer[0],
                    y: viewAnglesBuffer[1]
                });
                viewAngles = { ...lastGoodAngles };
            } else {
                viewAngles = { ...lastGoodAngles };
            }
            
            const playerPosBuffer = await safeReadMemory(
                processHandle,
                OFFSETS.LOCAL_PLAYER,
                'float',
                OFFSETS.PLAYER_POSITION
            );
            
            if (playerPosBuffer) {
                playerPosition = {
                    x: playerPosBuffer[0],
                    y: playerPosBuffer[1],
                    z: playerPosBuffer[2]
                };
            }
            
            const entityList = await safeReadMemory(
                processHandle,
                OFFSETS.ENTITY_LIST,
                'uint32'
            );
            
            if (!entityList) return;
            
            enemyPositions = [];
            
            for (let i = 0; i < 64; i++) {
                const entityBase = await safeReadMemory(
                    processHandle,
                    entityList + (i * 16),
                    'uint32'
                );
                
                if (!entityBase || entityBase[0] === 0) continue;
                
                const enemyPosBuffer = await safeReadMemory(
                    processHandle,
                    entityBase[0],
                    'float',
                    OFFSETS.PLAYER_POSITION
                );
                
                if (!enemyPosBuffer) continue;
                
                const screenPos = worldToScreen(
                    enemyPosBuffer[0],
                    enemyPosBuffer[1],
                    enemyPosBuffer[2]
                );
                
                const angleFromCrosshair = calculateScreenAngle(
                    playerPosition,
                    { x: enemyPosBuffer[0], y: enemyPosBuffer[1] },
                    viewAngles.x,
                    viewAngles.y
                );
                
                if (angleFromCrosshair <= 30) {
                    enemyPositions.push({
                        x: screenPos.x,
                        y: screenPos.y,
                        angleFromCrosshair
                    });
                }
            }
            
            enemyPositions.sort((a, b) => a.angleFromCrosshair - b.angleFromCrosshair);
            
            if (enemyPositions.length > 0) {
                sendVibration(enemyPositions[0].angleFromCrosshair / 30);
            }
        } catch (error) {
            console.error('Error in game loop:', error);
        }
    }, 100);
}

// Cleanup function for safe exit
function cleanup() {
    if (toyConnected) {
        lovense.disconnect();
        console.log('Disconnected from toy');
    }
    processHandle = null;
    console.log('Cleanup complete');
}

// Start everything with error handling
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

startGameLoop().catch(console.error);
