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
    console.log('New conversation session started:', currentSessionId);
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
    console.log('Saved conversation turn:', conversationTurn);

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
        console.log('Session initialization already in progress');
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

    // Get system prompt
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
    };

    isInitializingSession = false;
    sendToRenderer('session-initializing', false);
    sendToRenderer('update-status', `OpenRouter session initialized with model: ${model}`);
    return sessionObj;
}

// API call for chat completions (text only)
async function sendTextToOpenRouter(text, session) {
    if (!session || !session.apiKey || !session.model) return;

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
            }
        );

        // Optionally, forward output to renderer and conversation history
        const reply = resp.data?.choices?.[0]?.message?.content || '';
        sendToRenderer('update-response', reply);

        if (text && reply) {
            saveConversationTurn(text, reply);
        }

        return resp.data;
    } catch (error) {
        console.error("Error sending text to OpenRouter:", error.response?.data || error.message);
        sendToRenderer('update-status', "Error: " + (error.response?.data?.error?.message || error.message));
        throw error;
    }
}

// API call for multimodal (image+text) models
async function sendImageToOpenRouter(base64Data, session) {
    if (!session || !session.apiKey || !session.model) return;

    const messages = [
        { role: "system", content: session.systemPrompt },
        {
            role: "user",
            content: [
                { type: "text", content: "Describe this image." },
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
            }
        );
        const reply = resp.data?.choices?.[0]?.message?.content || '';
        sendToRenderer('update-response', reply);

        saveConversationTurn('[Image sent]', reply);

        return resp.data;
    } catch (error) {
        console.error("Error sending image to OpenRouter:", error.response?.data || error.message);
        sendToRenderer('update-status', "Error: " + (error.response?.data?.error?.message || error.message));
        throw error;
    }
}

// Placeholder for audio: OpenRouter does not support audio yet
async function sendAudioToOpenRouter(base64Data, session) {
    sendToRenderer('update-status', 'Audio input not supported in OpenRouter (yet)');
    throw new Error('Audio input not supported in OpenRouter.');
}

// macOS audio capture logic (same as gemini.js)
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
    if (process.platform !== 'darwin') return false;
    await killExistingSystemAudioDump();

    console.log('Starting macOS audio capture with SystemAudioDump...');
    const { app } = require('electron');
    const path = require('path');
    let systemAudioPath;
    if (app.isPackaged) {
        systemAudioPath = path.join(process.resourcesPath, 'SystemAudioDump');
    } else {
        systemAudioPath = path.join(__dirname, '../assets', 'SystemAudioDump');
    }

    const spawnOptions = {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
            ...process.env,
            PROCESS_NAME: 'AudioService',
            APP_NAME: 'System Audio Service',
        },
        detached: false,
        windowsHide: false,
    };

    systemAudioProc = spawn(systemAudioPath, [], spawnOptions);

    if (!systemAudioProc.pid) {
        console.error('Failed to start SystemAudioDump');
        return false;
    }

    console.log('SystemAudioDump started with PID:', systemAudioProc.pid);

    const CHUNK_DURATION = 0.1;
    const SAMPLE_RATE = 24000;
    const BYTES_PER_SAMPLE = 2;
    const CHANNELS = 2;
    const CHUNK_SIZE = SAMPLE_RATE * BYTES_PER_SAMPLE * CHANNELS * CHUNK_DURATION;

    let audioBuffer = Buffer.alloc(0);

    systemAudioProc.stdout.on('data', data => {
        audioBuffer = Buffer.concat([audioBuffer, data]);
        while (audioBuffer.length >= CHUNK_SIZE) {
            const chunk = audioBuffer.slice(0, CHUNK_SIZE);
            audioBuffer = audioBuffer.slice(CHUNK_SIZE);

            const monoChunk = CHANNELS === 2 ? convertStereoToMono(chunk) : chunk;
            const base64Data = monoChunk.toString('base64');
            sendAudioToOpenRouter(base64Data, openRouterSessionRef); // will throw "not supported"

            if (process.env.DEBUG_AUDIO) {
                saveDebugAudio(monoChunk, 'system_audio');
            }
        }
        const maxBufferSize = SAMPLE_RATE * BYTES_PER_SAMPLE * 1;
        if (audioBuffer.length > maxBufferSize) {
            audioBuffer = audioBuffer.slice(-maxBufferSize);
        }
    });

    systemAudioProc.stderr.on('data', data => {
        console.error('SystemAudioDump stderr:', data.toString());
    });

    systemAudioProc.on('close', code => {
        console.log('SystemAudioDump process closed with code:', code);
        systemAudioProc = null;
    });

    systemAudioProc.on('error', err => {
        console.error('SystemAudioDump process error:', err);
        systemAudioProc = null;
    });

    return true;
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

// IPC Handlers for Electron
function setupOpenRouterIpcHandlers(openRouterSessionRef) {
    global.openRouterSessionRef = openRouterSessionRef;

    ipcMain.handle('initialize-openrouter', async (event, apiKey, model, customPrompt, profile = 'interview', language = 'en-US') => {
        try {
            const session = await initializeOpenRouterSession(apiKey, model, customPrompt, profile, language);
            openRouterSessionRef.current = session;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!openRouterSessionRef.current) return { success: false, error: 'No active OpenRouter session' };
        try {
            const resp = await sendTextToOpenRouter(text, openRouterSessionRef.current);
            return { success: true, data: resp };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data }) => {
        if (!openRouterSessionRef.current) return { success: false, error: 'No active OpenRouter session' };
        try {
            const resp = await sendImageToOpenRouter(data, openRouterSessionRef.current);
            return { success: true, data: resp };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-audio-content', async (event, { data }) => {
        // Will return error, audio not supported
        try {
            await sendAudioToOpenRouter(data, openRouterSessionRef.current);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-macos-audio', async event => {
        if (process.platform !== 'darwin') {
            return {
                success: false,
                error: 'macOS audio capture only available on macOS',
            };
        }

        try {
            const success = await startMacOSAudioCapture(openRouterSessionRef);
            return { success };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('stop-macos-audio', async event => {
        try {
            stopMacOSAudioCapture();
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('close-session', async event => {
        try {
            stopMacOSAudioCapture();
            lastSessionParams = null;
            openRouterSessionRef.current = null;
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('get-current-session', async event => {
        try {
            return { success: true, data: getCurrentSessionData() };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('start-new-session', async event => {
        try {
            initializeNewSession();
            return { success: true, sessionId: currentSessionId };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });
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