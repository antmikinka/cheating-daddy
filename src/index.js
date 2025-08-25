if (require('electron-squirrel-startup')) {
    process.exit(0);
}

const { app, BrowserWindow, shell, ipcMain } = require('electron');
const { createWindow, updateGlobalShortcuts } = require('./utils/window');
const { setupUnifiedIpcHandlers, cleanupAllSessions } = require('./unified-handlers');
const { stopMacOSAudioCapture } = require('./gemini');
const { stopMacOSAudioCapture: stopOpenRouterAudio } = require('./openrouter');
const { initializeRandomProcessNames } = require('./utils/processRandomizer');
const { applyAntiAnalysisMeasures } = require('./utils/stealthFeatures');
const { getLocalConfig, writeConfig } = require('./config');

// Session references are now managed by unified-handlers
let mainWindow = null;

// Initialize random process names for stealth
const randomNames = initializeRandomProcessNames();

function createMainWindow() {
    mainWindow = createWindow(
        // sendToRenderer function from unified-handlers
        require('./unified-handlers').sendToRenderer,
        // Pass session references getter instead of single session
        require('./unified-handlers').getSessionReferences,
        randomNames
    );
    return mainWindow;
}

app.whenReady().then(async () => {
    try {
        // Apply anti-analysis measures with random delay
        await applyAntiAnalysisMeasures();

        createMainWindow();
        
        // Initialize unified IPC handlers (handles both Gemini and OpenRouter)
        setupUnifiedIpcHandlers();
        
        setupGeneralIpcHandlers();
        
        console.log('Application initialized successfully');
    } catch (error) {
        console.error('Error during app initialization:', error);
        // Don't exit - try to continue with basic functionality
    }
});

app.on('window-all-closed', async () => {
    try {
        // Clean up both audio capture systems
        stopMacOSAudioCapture();
        stopOpenRouterAudio();
        
        // Clean up all sessions
        await cleanupAllSessions();
    } catch (error) {
        console.error('Error during cleanup:', error);
    }
    
    if (process.platform !== 'darwin') {
        app.quit();
    }
});

app.on('before-quit', async () => {
    try {
        stopMacOSAudioCapture();
        stopOpenRouterAudio();
        await cleanupAllSessions();
    } catch (error) {
        console.error('Error during before-quit cleanup:', error);
    }
});

app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
    }
});

function setupGeneralIpcHandlers() {
    // Config-related IPC handlers
    ipcMain.handle('set-onboarded', async (event) => {
        try {
            const config = getLocalConfig();
            config.onboarded = true;
            writeConfig(config);
            return { success: true, config };
        } catch (error) {
            console.error('Error setting onboarded:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-stealth-level', async (event, stealthLevel) => {
        try {
            const validLevels = ['visible', 'balanced', 'ultra'];
            if (!validLevels.includes(stealthLevel)) {
                throw new Error(`Invalid stealth level: ${stealthLevel}. Must be one of: ${validLevels.join(', ')}`);
            }
            
            const config = getLocalConfig();
            config.stealthLevel = stealthLevel;
            writeConfig(config);
            return { success: true, config };
        } catch (error) {
            console.error('Error setting stealth level:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('set-layout', async (event, layout) => {
        try {
            const validLayouts = ['normal', 'compact'];
            if (!validLayouts.includes(layout)) {
                throw new Error(`Invalid layout: ${layout}. Must be one of: ${validLayouts.join(', ')}`);
            }
            
            const config = getLocalConfig();
            config.layout = layout;
            writeConfig(config);
            return { success: true, config };
        } catch (error) {
            console.error('Error setting layout:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-config', async (event) => {
        try {
            const config = getLocalConfig();
            return { success: true, config };
        } catch (error) {
            console.error('Error getting config:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('quit-application', async event => {
        try {
            stopMacOSAudioCapture();
            stopOpenRouterAudio();
            await cleanupAllSessions();
            app.quit();
            return { success: true };
        } catch (error) {
            console.error('Error quitting application:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('open-external', async (event, url) => {
        try {
            if (!url || typeof url !== 'string') {
                throw new Error('Invalid URL provided');
            }
            await shell.openExternal(url);
            return { success: true };
        } catch (error) {
            console.error('Error opening external URL:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.on('update-keybinds', (event, newKeybinds) => {
        if (mainWindow && !mainWindow.isDestroyed()) {
            try {
                const sessionRefs = require('./unified-handlers').getSessionReferences();
                updateGlobalShortcuts(newKeybinds, mainWindow, require('./unified-handlers').sendToRenderer, sessionRefs);
            } catch (error) {
                console.error('Error updating keybinds:', error);
            }
        }
    });

    ipcMain.handle('update-content-protection', async (event, contentProtection) => {
        try {
            if (mainWindow && !mainWindow.isDestroyed()) {
                // Get content protection setting from localStorage via cheddar
                const contentProtection = await mainWindow.webContents.executeJavaScript(`
                    (function() {
                        try {
                            return cheddar.getContentProtection();
                        } catch (e) {
                            console.error('Error getting content protection:', e);
                            return true; // Default to protected
                        }
                    })()
                `);
                mainWindow.setContentProtection(contentProtection);
                console.log('Content protection updated:', contentProtection);
            }
            return { success: true };
        } catch (error) {
            console.error('Error updating content protection:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-random-display-name', async event => {
        try {
            return randomNames && randomNames.displayName ? randomNames.displayName : 'System Monitor';
        } catch (error) {
            console.error('Error getting random display name:', error);
            return 'System Monitor';
        }
    });

    console.log('General IPC handlers initialized successfully');
}
