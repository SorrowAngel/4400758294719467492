const lovense = require('lovense-dart');
const MemoryReader = require('memory-reader');

// Lovense toy settings - replace with your details!
const toyName = 'YourToyName';
const toyIP = '192.168.1.XXX'; // Replace with actual IP

// Game state storage
let playerPosition = { x: 0, y: 0, z: 0 };
let viewAngles = { x: 0, y: 0 };
let enemyPositions = [];
let toyConnected = false;

// Memory offsets for CS2
const OFFSETS = {
    LOCAL_PLAYER: 0x1F8BAC,
    ENTITY_LIST: 0x4A83E40,
    PLAYER_POSITION: 0x4F30,
    VIEW_ANGLES: 0x4D90B4 
};

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

// Calculate angle between two positions (modified for screen space)
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

// Main game loop
async function startGameLoop() {
    await initialize();
    
    setInterval(async () => {
        try {
            // Find CS2 process
            const processes = await MemoryReader.getProcessesByName('cs2.exe');
            
            if (!processes || processes.length === 0) {
                console.log('CS2 not found! Please start CS2.');
                return;
            }
            
            const csgoProcess = processes[0];
            
            // Get view angles (camera direction)
            const viewAnglesBuffer = await MemoryReader.readMemory(
                csgoProcess.handle,
                OFFSETS.VIEW_ANGLES,
                'float',
                2 // Read both X and Y angles
            );
            viewAngles = {
                x: viewAnglesBuffer[0], // Pitch (up/down)
                y: viewAnglesBuffer[1]  // Yaw (left/right)
            };
            
            // Get player position
            const playerPosBuffer = await MemoryReader.readMemory(
                csgoProcess.handle,
                OFFSETS.LOCAL_PLAYER,
                'float',
                OFFSETS.PLAYER_POSITION
            );
            playerPosition = {
                x: playerPosBuffer[0],
                y: playerPosBuffer[1],
                z: playerPosBuffer[2]
            };
            
            // Find enemies
            const entityList = await MemoryReader.readMemory(
                csgoProcess.handle,
                OFFSETS.ENTITY_LIST,
                'uint32'
            );
            
            enemyPositions = [];
            
            // Check each entity slot
            for (let i = 0; i < 64; i++) {
                const entityBase = await MemoryReader.readMemory(
                    csgoProcess.handle,
                    entityList + (i * 16),
                    'uint32'
                );
                
                if (!entityBase || entityBase[0] === 0) continue;
                
                const enemyPosBuffer = await MemoryReader.readMemory(
                    csgoProcess.handle,
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
            console.error('Error reading game memory:', error);
        }
    }, 100); // Update every 100ms
}

// Start everything!
startGameLoop().catch(console.error);
