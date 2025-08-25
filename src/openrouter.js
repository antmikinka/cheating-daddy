/**
 * OpenRouter API Client for Cheating Daddy
 * 
 * This module provides session management and IPC for OpenRouter API usage.
 * It is based on the structure of gemini.js but adapted for OpenRouter.
 * Allows dynamic selection of model via settings.
 * 
 * Usage: require and use setupOpenRouterIpcHandlers in your main Electron process.
 */

const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
const axios = require('axios');

// Conversation tracking variables
let currentSessionId = null;
let currentTranscription = '';
let conversationHistory = [];
let isInitializingSession = false;

function formatSpeakerResults(results) {
    let text = '';
    for (const result of results) {
        if (result.transcript && result.speakerId) {
            const speakerLabel = result.speakerId === 1 ? 'Interviewer' : 'Candidate';
            text += `[${speakerLabel}]: ${result.transcript}\n`;
        }
    }
    return text;
}

module.exports.formatSpeakerResults = formatSpeakerResults;

// Audio capture variables
let systemAudioProc = null;
let messageBuffer = '';

// Reconnection tracking variables
let reconnectionAttempts = 0;
let maxReconnectionAttempts = 3;
let reconnectionDelay = 2000; // 2 seconds between attempts
let lastSessionParams = null;

function sendToRenderer(channel, data) {
    const windows = BrowserWindow.getAllWindows();
    if (windows.length > 0) {
        windows[0].webContents.send(channel, data);
    }
}

// Conversation management functions
function initializeNewSession() {
    currentSessionId = Date.now().toString();
    currentTranscription = '';
    conversationHistory = [];
    console.log('New OpenRouter conversation session started:', currentSessionId);
}

function saveConversationTurn(transcription, aiResponse) {
    if (!currentSessionId) {
        initializeNewSession();
    }

    const conversationTurn = {
        timestamp: Date.now(),
        transcription: transcription.trim(),
        ai_response: aiResponse.trim(),
    };

    conversationHistory.push(conversationTurn);
    console.log('Saved OpenRouter conversation turn:', conversationTurn);

    // Send to renderer to save in IndexedDB
    sendToRenderer('save-conversation-turn', {
        sessionId: currentSessionId,
        turn: conversationTurn,
        fullHistory: conversationHistory,
    });
}

function getCurrentSessionData() {
    return {
        sessionId: currentSessionId,
        history: conversationHistory,
    };
}

// OpenRouter session management
async function initializeOpenRouterSession(apiKey, model, customPrompt = '', profile = 'interview', language = 'en-US', isReconnection = false) {
    if (isInitializingSession) {
        console.log('OpenRouter session initialization already in progress');
        return false;
    }

    isInitializingSession = true;
    sendToRenderer('session-initializing', true);

    // Store session parameters for reconnection (only if not already reconnecting)
    if (!isReconnection) {
        lastSessionParams = {
            apiKey,
            model,
            customPrompt,
            profile,
            language,
        };
        reconnectionAttempts = 0; // Reset counter for new session
    }

    // Get system prompt (Google Search always enabled for OpenRouter)
    const systemPrompt = getSystemPrompt(profile, customPrompt, true);

    // Initialize new conversation session (only if not reconnecting)
    if (!isReconnection) {
        initializeNewSession();
    }

    // For OpenRouter, session is stateless; we use a reference object
    const sessionObj = {
        apiKey,
        model,
        systemPrompt,
        profile,
        language,
        active: true,
    };

    isInitializingSession = false;
    sendToRenderer('session-initializing', false);
    sendToRenderer('update-status', `OpenRouter session initialized with model: ${model}`);
    return sessionObj;
}

// API call for chat completions (text only)
async function sendTextToOpenRouter(text, session) {
    if (!session || !session.apiKey || !session.model || !session.active) {
        throw new Error('No active OpenRouter session');
    }

    const messages = [
        { role: "system", content: session.systemPrompt },
        { role: "user", content: text }
    ];

    try {
        const resp = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: session.model,
                messages: messages,
            },
            {
                headers: {
                    "Authorization": `Bearer ${session.apiKey}`,
                    "Content-Type": "application/json",
                },
                timeout: 30000, // 30 second timeout
            }
        );

        // Forward output to renderer and conversation history
        const reply = resp.data?.choices?.[0]?.message?.content || '';
        sendToRenderer('update-response', reply);

        if (text && reply) {
            saveConversationTurn(text, reply);
        }

        return resp.data;
    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message || 'Unknown error';
        console.error("Error sending text to OpenRouter:", error.response?.data || error.message);
        sendToRenderer('update-status', "Error: " + errorMsg);
        throw new Error(errorMsg);
    }
}

// API call for multimodal (image+text) models
async function sendImageToOpenRouter(base64Data, session) {
    if (!session || !session.apiKey || !session.model || !session.active) {
        throw new Error('No active OpenRouter session');
    }

    const messages = [
        { role: "system", content: session.systemPrompt },
        {
            role: "user",
            content: [
                { type: "text", content: "Help me on this page, give me the answer no bs, complete answer. So if its a code question, give me the approach in few bullet points, then the entire code. Also if theres anything else i need to know, tell me. If its a question about the website, give me the answer no bs, complete answer. If its a mcq question, give me the answer no bs, complete answer." },
                { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Data}` } }
            ]
        }
    ];

    try {
        const resp = await axios.post(
            "https://openrouter.ai/api/v1/chat/completions",
            {
                model: session.model,
                messages: messages,
            },
            {
                headers: {
                    "Authorization": `Bearer ${session.apiKey}`,
                    "Content-Type": "application/json",
                },
                timeout: 45000, // 45 second timeout for image processing
            }
        );
        
        const reply = resp.data?.choices?.[0]?.message?.content || '';
        sendToRenderer('update-response', reply);

        if (reply) {
            saveConversationTurn('[Image sent]', reply);
        }

        return resp.data;
    } catch (error) {
        const errorMsg = error.response?.data?.error?.message || error.message || 'Unknown error';
        console.error("Error sending image to OpenRouter:", error.response?.data || error.message);
        sendToRenderer('update-status', "Error: " + errorMsg);
        throw new Error(errorMsg);
    }
}

// Placeholder for audio: OpenRouter does not support audio yet
async function sendAudioToOpenRouter(base64Data, session) {
    const errorMsg = 'Audio input not supported in OpenRouter (yet)';
    sendToRenderer('update-status', errorMsg);
    throw new Error(errorMsg);
}

// macOS audio capture logic (same as gemini.js but not functional for OpenRouter)
function killExistingSystemAudioDump() {
    return new Promise(resolve => {
        console.log('Checking for existing SystemAudioDump processes...');
        const killProc = spawn('pkill', ['-f', 'SystemAudioDump'], {
            stdio: 'ignore',
        });

        killProc.on('close', code => {
            if (code === 0) {
                console.log('Killed existing SystemAudioDump processes');
            } else {
                console.log('No existing SystemAudioDump processes found');
            }
            resolve();
        });

        killProc.on('error', err => {
            console.log('Error checking for existing processes (this is normal):', err.message);
            resolve();
        });

        setTimeout(() => {
            killProc.kill();
            resolve();
        }, 2000);
    });
}

async function startMacOSAudioCapture(openRouterSessionRef) {
    // OpenRouter doesn't support audio, so this will fail gracefully
    console.warn('Audio capture not supported with OpenRouter');
    return false;
}

function convertStereoToMono(stereoBuffer) {
    const samples = stereoBuffer.length / 4;
    const monoBuffer = Buffer.alloc(samples * 2);

    for (let i = 0; i < samples; i++) {
        const leftSample = stereoBuffer.readInt16LE(i * 4);
        monoBuffer.writeInt16LE(leftSample, i * 2);
    }

    return monoBuffer;
}

function stopMacOSAudioCapture() {
    if (systemAudioProc) {
        console.log('Stopping SystemAudioDump...');
        systemAudioProc.kill('SIGTERM');
        systemAudioProc = null;
    }
}

// IPC Handlers for Electron - using prefixed names to avoid conflicts with Gemini
function setupOpenRouterIpcHandlers(openRouterSessionRef, prefix = 'openrouter') {
    global.openRouterSessionRef = openRouterSessionRef;

    ipcMain.handle(`${prefix}-initialize-session`, async (event, apiKey, model, customPrompt, profile = 'interview', language = 'en-US') => {
        try {
            const session = await initializeOpenRouterSession(apiKey, model, customPrompt, profile, language);
            if (session) {
                openRouterSessionRef.current = session;
                return { success: true };
            }
            return { success: false, error: 'Failed to initialize OpenRouter session' };
        } catch (error) {
            console.error('Error initializing OpenRouter session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-send-text-message`, async (event, text) => {
        if (!openRouterSessionRef.current) {
            return { success: false, error: 'No active OpenRouter session' };
        }
        try {
            const resp = await sendTextToOpenRouter(text, openRouterSessionRef.current);
            return { success: true, data: resp };
        } catch (error) {
            console.error('Error sending text to OpenRouter:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-send-image-content`, async (event, { data }) => {
        if (!openRouterSessionRef.current) {
            return { success: false, error: 'No active OpenRouter session' };
        }
        try {
            const resp = await sendImageToOpenRouter(data, openRouterSessionRef.current);
            return { success: true, data: resp };
        } catch (error) {
            console.error('Error sending image to OpenRouter:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-send-audio-content`, async (event, { data }) => {
        // Will return error, audio not supported
        try {
            await sendAudioToOpenRouter(data, openRouterSessionRef.current);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-start-macos-audio`, async event => {
        return {
            success: false,
            error: 'Audio capture not supported with OpenRouter model',
        };
    });

    ipcMain.handle(`${prefix}-stop-macos-audio`, async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-close-session`, async event => {
        try {
            stopMacOSAudioCapture();
            lastSessionParams = null;
            if (openRouterSessionRef.current) {
                openRouterSessionRef.current.active = false;
                openRouterSessionRef.current = null;
            }
            return { success: true };
        } catch (error) {
            console.error('Error closing OpenRouter session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-get-current-session`, async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            console.error('Error getting OpenRouter session:', error);
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle(`${prefix}-start-new-session`, async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            console.error('Error starting new OpenRouter session:', error);
            return { success: false, error: error.message };
        }
    });

    console.log(`OpenRouter IPC handlers initialized with prefix: ${prefix}`);
}

module.exports = {
    initializeOpenRouterSession,
    sendTextToOpenRouter,
    sendImageToOpenRouter,
    sendAudioToOpenRouter,
    setupOpenRouterIpcHandlers,
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    formatSpeakerResults,
    sendToRenderer,
    killExistingSystemAudioDump,
    startMacOSAudioCapture,
    convertStereoToMono,
    stopMacOSAudioCapture,
};
