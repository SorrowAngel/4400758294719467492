const lovense = require('lovense-dart');
const MemoryReader = require('memory-reader');

// Lovense toy settings - replace with your details!
const toyName = 'YourToyName';
const toyIP = '192.168.1.XXX'; // Replace with actual IP

// Game state storage with safety defaults
let playerPosition = { x: 0, y: 0, z: 0 };
let viewAngles = { x: 0, y: 0 }; // Camera angles
let enemyPositions = [];
let toyConnected = false;
let lastGoodAngles = { x: 0, y: 0 }; // For safety fallback
let processHandle = null;

// Memory offsets for CS2
const OFFSETS = {
    LOCAL_PLAYER: 0x1F8BAC,
    ENTITY_LIST: 0x4A83E40,
    PLAYER_POSITION: 0x4F30,
    VIEW_ANGLES: 0x4D90B4
};

// Safe view angle clamping function
function clampViewAngles(angles) {
    return {
        x: Math.max(-89, Math.min(89, angles.x)), // Pitch (up/down)
        y: (angles.y + 180) % 360 - 180 // Yaw (left/right)
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

// Calculate angle between positions (modified for screen space)
function calculateScreenAngle(pos1, pos2, viewX, viewY) {
    const dx = pos2.x - pos1.x;
    const dy = pos2.y - pos1.y;
    
    // Convert world angles to screen space
    const angleToEnemy = Math.atan2(dy, dx) * (180 / Math.PI);
    
    // Calculate difference from view direction
    const viewAngleRad = (viewY * Math.PI) / 180;
    const deltaAngle = Math.abs(angleToEnemy - viewY);
    
    // Normalize to 0-180 degrees
    return Math.min(deltaAngle, 360 - deltaAngle);
}

// Send vibration based on screen position
function sendVibration(screenDistance) {
    if (!toyConnected) return;
    
    // Map distance to vibration intensity (0-100)
    // Stronger vibration when closer to center
    const intensity = Math.max(0, Math.min(100, 100 * (1 - screenDistance)));
    
    lovense.command(toyName, 'Vibrate', intensity);
}

// Main game loop with safety checks
async function startGameLoop() {
    await initialize();
    
    setInterval(async () => {
        try {
            // Find CS2 process with retry mechanism
            if (!processHandle) {
                const processes = await MemoryReader.getProcessesByName('csgo2.exe');
                
                if (!processes || processes.length === 0) {
                    console.log('CS2 not found! Please start CS2.');
                    return;
                }
                
                processHandle = processes[0].handle;
            }
            
            // Read view angles with safety checks
            const viewAnglesBuffer = await safeReadMemory(
                processHandle,
                OFFSETS.VIEW_ANGLES,
                'float',
                2
            );
            
            if (viewAnglesBuffer) {
                // Update last good angles
                lastGoodAngles = clampViewAngles({
                    x: viewAnglesBuffer[0],
                    y: viewAnglesBuffer[1]
                });
                viewAngles = { ...lastGoodAngles };
            } else {
                // Use last good angles if current read fails
                viewAngles = { ...lastGoodAngles };
            }
            
            // Get player position with safety checks
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
            
            // Find enemies with safety checks
            const entityList = await safeReadMemory(
                processHandle,
                OFFSETS.ENTITY_LIST,
                'uint32'
            );
            
            if (!entityList) return;
            
            enemyPositions = [];
            
            // Check each entity slot with safety checks
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
                
                // Calculate angle from crosshair to enemy
                const angleFromCrosshair = calculateScreenAngle(
                    playerPosition,
                    { x: enemyPosBuffer[0], y: enemyPosBuffer[1] },
                    viewAngles.x,
                    viewAngles.y
                );
                
                // Only add enemies within FOV
                if (angleFromCrosshair <= 30) { // 30 degree FOV
                    enemyPositions.push({
                        position: {
                            x: enemyPosBuffer[0],
                            y: enemyPosBuffer[1]
                        },
                        angleFromCrosshair,
                        distance: Math.sqrt(
                            Math.pow(enemyPosBuffer[0] - playerPosition.x, 2) +
                            Math.pow(enemyPosBuffer[1] - playerPosition.y, 2)
                        )
                    });
                }
            }
            
            // Sort enemies by angle from crosshair
            enemyPositions.sort((a, b) => a.angleFromCrosshair - b.angleFromCrosshair);
            
            // Vibrate based on nearest enemy to crosshair
            if (enemyPositions.length > 0) {
                sendVibration(enemyPositions[0].angleFromCrosshair / 30); // Normalize to 0-1
            }
        } catch (error) {
            console.error('Error in game loop:', error);
        }
    }, 100); // Update every 100ms
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
