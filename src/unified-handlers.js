/**
 * Unified IPC Handlers for Cheating Daddy - PRODUCTION VERSION
 * 
 * Provides unified IPC handlers that route requests to either Gemini or OpenRouter
 * based on the current model type from localStorage. This allows the renderer to use
 * the same IPC calls regardless of which AI service is active.
 */

const { BrowserWindow, ipcMain } = require('electron');

let geminiSessionRef = { current: null };
let openRouterSessionRef = { current: null };

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Get current model type from renderer localStorage with error handling
async function getCurrentModelType() {
    try {
        const windows = BrowserWindow.getAllWindows();
        if (windows.length > 0) {
            const modelType = await windows[0].webContents.executeJavaScript(`
                (function() {
                    try {
                        return localStorage.getItem('modelType') || 'gemini';
                    } catch (e) {
                        console.error('Error getting modelType:', e);
                        return 'gemini';
                    }
                })()
            `);
            return modelType.toLowerCase();
        }
    } catch (error) {
        console.warn('Could not get model type from renderer, defaulting to gemini:', error);
    }
    return 'gemini';
}

function setupUnifiedIpcHandlers() {
    // Store session references globally for access from other modules
    global.geminiSessionRef = geminiSessionRef;
    global.openRouterSessionRef = openRouterSessionRef;

    // Import handler setup functions and call them with prefixed names
    let geminiModule, openRouterModule;
    try {
        geminiModule = require('./gemini');
        openRouterModule = require('./openrouter');
        
        const { setupGeminiIpcHandlers } = geminiModule;
        const { setupOpenRouterIpcHandlers } = openRouterModule;
        
        setupGeminiIpcHandlers(geminiSessionRef, 'gemini');
        setupOpenRouterIpcHandlers(openRouterSessionRef, 'openrouter');
        
        console.log('Individual API handlers registered successfully');
    } catch (error) {
        console.error('Error setting up individual API handlers:', error);
        throw new Error(`Failed to setup API handlers: ${error.message}`);
    }

    // Unified initialization handler
    ipcMain.handle('initialize-model', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        try {
            if (!apiKey || typeof apiKey !== 'string' || apiKey.trim().length === 0) {
                return { success: false, error: 'Invalid API key provided' };
            }

            const modelType = await getCurrentModelType();
            console.log(`Unified handler: Initializing ${modelType} model...`);

            if (modelType === 'openrouter') {
                const model = await event.sender.executeJavaScript(`
                    (function() {
                        try {
                            return localStorage.getItem('openRouterModel') || 'anthropic/claude-3.5-sonnet';
                        } catch (e) {
                            console.error('Error getting OpenRouter model:', e);
                            return 'anthropic/claude-3.5-sonnet';
                        }
                    })()
                `);
                
                const session = await openRouterModule.initializeOpenRouterSession(apiKey.trim(), model, customPrompt, profile, language);
                if (session) {
                    openRouterSessionRef.current = session;
                    return { success: true };
                } else {
                    return { success: false, error: 'Failed to initialize OpenRouter session' };
                }
            } else {
                const session = await geminiModule.initializeGeminiSession(apiKey.trim(), customPrompt, profile, language);
                if (session) {
                    geminiSessionRef.current = session;
                    return { success: true };
                } else {
                    return { success: false, error: 'Failed to initialize Gemini session' };
                }
            }
        } catch (error) {
            console.error('Error in unified model initialization:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified text message handler
    ipcMain.handle('send-text-message', async (event, text) => {
        try {
            if (!text || typeof text !== 'string' || text.trim().length === 0) {
                return { success: false, error: 'Invalid text message' };
            }

            const modelType = await getCurrentModelType();
            
            if (modelType === 'openrouter') {
                if (!openRouterSessionRef.current || !openRouterSessionRef.current.active) {
                    return { success: false, error: 'No active OpenRouter session' };
                }
                
                await openRouterModule.sendTextToOpenRouter(text.trim(), openRouterSessionRef.current);
                return { success: true };
            } else {
                if (!geminiSessionRef.current) {
                    return { success: false, error: 'No active Gemini session' };
                }
                
                await geminiSessionRef.current.sendRealtimeInput({ text: text.trim() });
                return { success: true };
            }
        } catch (error) {
            console.error('Error in unified text message handler:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified image content handler
    ipcMain.handle('send-image-content', async (event, { data, debug }) => {
        try {
            if (!data || typeof data !== 'string') {
                return { success: false, error: 'Invalid image data' };
            }

            const modelType = await getCurrentModelType();
            
            if (modelType === 'openrouter') {
                if (!openRouterSessionRef.current || !openRouterSessionRef.current.active) {
                    return { success: false, error: 'No active OpenRouter session' };
                }
                
                await openRouterModule.sendImageToOpenRouter(data, openRouterSessionRef.current);
                return { success: true };
            } else {
                if (!geminiSessionRef.current) {
                    return { success: false, error: 'No active Gemini session' };
                }
                
                const buffer = Buffer.from(data, 'base64');
                if (buffer.length < 1000) {
                    return { success: false, error: 'Image buffer too small' };
                }

                await geminiSessionRef.current.sendRealtimeInput({
                    media: { data: data, mimeType: 'image/jpeg' },
                });
                return { success: true };
            }
        } catch (error) {
            console.error('Error in unified image handler:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified audio content handler (Gemini only)
    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        try {
            const modelType = await getCurrentModelType();
            if (modelType === 'openrouter') {
                return { success: false, error: 'Audio input not supported with OpenRouter model.' };
            }
            
            if (!geminiSessionRef.current) {
                return { success: false, error: 'No active Gemini session' };
            }

            if (!data || typeof data !== 'string') {
                return { success: false, error: 'Invalid audio data' };
            }

            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType || 'audio/pcm;rate=24000' },
            });
            return { success: true };
        } catch (error) {
            console.error('Error in unified audio handler:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified microphone audio handler (Gemini only)
    ipcMain.handle('send-mic-audio-content', async (event, { data, mimeType }) => {
        try {
            const modelType = await getCurrentModelType();
            if (modelType === 'openrouter') {
                return { success: false, error: 'Audio input not supported with OpenRouter model.' };
            }
            
            if (!geminiSessionRef.current) {
                return { success: false, error: 'No active Gemini session' };
            }

            if (!data || typeof data !== 'string') {
                return { success: false, error: 'Invalid microphone audio data' };
            }

            await geminiSessionRef.current.sendRealtimeInput({
                audio: { data: data, mimeType: mimeType || 'audio/pcm;rate=24000' },
            });
            return { success: true };
        } catch (error) {
            console.error('Error in unified mic audio handler:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified macOS audio handlers (Gemini only)
    ipcMain.handle('start-macos-audio', async (event) => {
        try {
            const modelType = await getCurrentModelType();
            if (modelType === 'openrouter') {
                return { success: false, error: 'Audio capture not supported with OpenRouter model.' };
            }
            
            if (process.platform !== 'darwin') {
                return { success: false, error: 'macOS audio capture only available on macOS' };
            }
            
            const success = await geminiModule.startMacOSAudioCapture(geminiSessionRef);
            return { success };
        } catch (error) {
            console.error('Error in unified macOS audio start:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async (event) => {
        try {
            if (geminiModule && typeof geminiModule.stopMacOSAudioCapture === 'function') {
                geminiModule.stopMacOSAudioCapture();
            }
            // Also try to stop OpenRouter's audio (which should be a no-op)
            try {
                if (openRouterModule && typeof openRouterModule.stopMacOSAudioCapture === 'function') {
                    openRouterModule.stopMacOSAudioCapture();
                }
            } catch (e) {
                // Ignore errors from OpenRouter audio stop
            }
            return { success: true };
        } catch (error) {
            console.error('Error in unified macOS audio stop:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified session management handlers
    ipcMain.handle('close-session', async (event) => {
        try {
            const results = [];
            
            // Close Gemini session
            if (geminiSessionRef.current) {
                try {
                    if (geminiModule && typeof geminiModule.stopMacOSAudioCapture === 'function') {
                        geminiModule.stopMacOSAudioCapture();
                    }
                    await geminiSessionRef.current.close();
                    geminiSessionRef.current = null;
                    results.push({ type: 'gemini', success: true });
                } catch (error) {
                    console.warn('Error closing Gemini session:', error);
                    results.push({ type: 'gemini', success: false, error: error.message });
                }
            }

            // Close OpenRouter session
            if (openRouterSessionRef.current) {
                try {
                    openRouterSessionRef.current.active = false;
                    openRouterSessionRef.current = null;
                    results.push({ type: 'openrouter', success: true });
                } catch (error) {
                    console.warn('Error closing OpenRouter session:', error);
                    results.push({ type: 'openrouter', success: false, error: error.message });
                }
            }

            return { success: true, results };
        } catch (error) {
            console.error('Error in unified session close:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified session data handler
    ipcMain.handle('get-current-session', async (event) => {
        try {
            const modelType = await getCurrentModelType();
            
            if (modelType === 'openrouter') {
                if (openRouterModule && typeof openRouterModule.getCurrentSessionData === 'function') {
                    return { success: true, data: openRouterModule.getCurrentSessionData() };
                } else {
                    return { success: false, error: 'OpenRouter module not available' };
                }
            } else {
                if (geminiModule && typeof geminiModule.getCurrentSessionData === 'function') {
                    return { success: true, data: geminiModule.getCurrentSessionData() };
                } else {
                    return { success: false, error: 'Gemini module not available' };
                }
            }
        } catch (error) {
            console.error('Error in unified get current session:', error);
            return { success: false, error: error.message };
        }
    });

    // Unified new session handler
    ipcMain.handle('start-new-session', async (event) => {
        try {
            const modelType = await getCurrentModelType();
            
            if (modelType === 'openrouter') {
                if (openRouterModule && typeof openRouterModule.initializeNewSession === 'function') {
                    openRouterModule.initializeNewSession();
                }
            } else {
                if (geminiModule && typeof geminiModule.initializeNewSession === 'function') {
                    geminiModule.initializeNewSession();
                }
            }
            
            return { success: true, sessionId: Date.now().toString() };
        } catch (error) {
            console.error('Error in unified start new session:', error);
            return { success: false, error: error.message };
        }
    });

    console.log('Unified IPC handlers initialized successfully');
}

// Cleanup function for both sessions with error handling
async function cleanupAllSessions() {
    const promises = [];
    
    if (geminiSessionRef.current) {
        promises.push(
            new Promise(resolve => {
                try {
                    const geminiModule = require('./gemini');
                    if (geminiModule && typeof geminiModule.stopMacOSAudioCapture === 'function') {
                        geminiModule.stopMacOSAudioCapture();
                    }
                    geminiSessionRef.current.close();
                    geminiSessionRef.current = null;
                    console.log('Gemini session cleaned up');
                    resolve();
                } catch (error) {
                    console.warn('Error cleaning up Gemini session:', error);
                    resolve();
                }
            })
        );
    }

    if (openRouterSessionRef.current) {
        promises.push(
            new Promise(resolve => {
                try {
                    openRouterSessionRef.current.active = false;
                    openRouterSessionRef.current = null;
                    console.log('OpenRouter session cleaned up');
                    resolve();
                } catch (error) {
                    console.warn('Error cleaning up OpenRouter session:', error);
                    resolve();
                }
            })
        );
    }

    await Promise.all(promises);
    console.log('All sessions cleaned up successfully');
}

// Get session references (for use by other modules)
function getSessionReferences() {
    return {
        gemini: geminiSessionRef,
        openrouter: openRouterSessionRef
    };
}

module.exports = {
    setupUnifiedIpcHandlers,
    cleanupAllSessions,
    getSessionReferences,
    getCurrentModelType,
    sendToRenderer
};
