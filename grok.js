// Example: Using a hypothetical Grok SDK or direct HTTP requests
const { BrowserWindow, ipcMain } = require('electron');
const { spawn } = require('child_process');
const { saveDebugAudio } = require('../audioUtils');
const { getSystemPrompt } = require('./prompts');
// You need to replace this with the actual Grok client import or HTTP logic
// const { GrokClient } = require('@grok/api'); // Example SDK import
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

// --- Grok Session Management ---
async function initializeGrokSession(apiKey, customPrompt = '', profile = 'interview', language = 'en-US', isReconnection = false) {
    if (isInitializingSession) {
        console.log('Session initialization already in progress');
        return false;
    }
    isInitializingSession = true;
    sendToRenderer('session-initializing', true);

    if (!isReconnection) {
        lastSessionParams = { apiKey, customPrompt, profile, language };
        reconnectionAttempts = 0;
    }

    // System prompt and other context handling
    const systemPrompt = getSystemPrompt(profile, customPrompt, true); // true: Grok supports search

    // Replace below with actual Grok session initialization
    try {
        // Example: REST API call to Grok session endpoint
        const response = await axios.post(
            'https://api.grok.com/v1/sessions',
            {
                model: 'grok-live', // Replace with Grok's actual model name
                prompt: systemPrompt,
                language: language,
            },
            { headers: { Authorization: `Bearer ${apiKey}` } }
        );

        // Store session info globally for reconnection & commands
        global.grokSessionRef = { current: response.data.sessionId };

        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        sendToRenderer('update-status', 'Live session connected');
        if (!isReconnection) initializeNewSession();
        return response.data.sessionId;
    } catch (error) {
        console.error('Failed to initialize Grok session:', error);
        isInitializingSession = false;
        sendToRenderer('session-initializing', false);
        return null;
    }
}

// --- Sending Audio to Grok ---
async function sendAudioToGrok(base64Data, grokSessionRef) {
    if (!grokSessionRef.current) return;
    try {
        await axios.post(
            `https://api.grok.com/v1/sessions/${grokSessionRef.current}/audio`,
            {
                audio: base64Data,
                mimeType: 'audio/pcm;rate=24000',
            },
            { headers: { Authorization: `Bearer ${lastSessionParams.apiKey}` } }
        );
    } catch (error) {
        console.error('Error sending audio to Grok:', error);
    }
}

// --- Sending Text to Grok ---
async function sendTextToGrok(text, grokSessionRef) {
    if (!grokSessionRef.current) return;
    try {
        await axios.post(
            `https://api.grok.com/v1/sessions/${grokSessionRef.current}/text`,
            { text: text.trim() },
            { headers: { Authorization: `Bearer ${lastSessionParams.apiKey}` } }
        );
    } catch (error) {
        console.error('Error sending text to Grok:', error);
    }
}

// --- Sending Image to Grok ---
async function sendImageToGrok(base64Data, grokSessionRef) {
    if (!grokSessionRef.current) return;
    try {
        await axios.post(
            `https://api.grok.com/v1/sessions/${grokSessionRef.current}/image`,
            { image: base64Data, mimeType: 'image/jpeg' },
            { headers: { Authorization: `Bearer ${lastSessionParams.apiKey}` } }
        );
    } catch (error) {
        console.error('Error sending image to Grok:', error);
    }
}

// --- IPC Handlers Setup ---
function setupGrokIpcHandlers(grokSessionRef) {
    global.grokSessionRef = grokSessionRef;

    ipcMain.handle('initialize-grok', async (event, apiKey, customPrompt, profile = 'interview', language = 'en-US') => {
        const sessionId = await initializeGrokSession(apiKey, customPrompt, profile, language);
        if (sessionId) {
            grokSessionRef.current = sessionId;
            return true;
        }
        return false;
    });

    ipcMain.handle('send-audio-content', async (event, { data, mimeType }) => {
        if (!grokSessionRef.current) return { success: false, error: 'No active Grok session' };
        try {
            await sendAudioToGrok(data, grokSessionRef);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-image-content', async (event, { data }) => {
        if (!grokSessionRef.current) return { success: false, error: 'No active Grok session' };
        try {
            await sendImageToGrok(data, grokSessionRef);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    ipcMain.handle('send-text-message', async (event, text) => {
        if (!grokSessionRef.current) return { success: false, error: 'No active Grok session' };
        try {
            await sendTextToGrok(text, grokSessionRef);
            return { success: true };
        } catch (error) {
            return { success: false, error: error.message };
        }
    });

    // Add other IPC handlers as needed, similar to above, for session close, reconnection etc.
}

module.exports = {
    initializeGrokSession,
    sendAudioToGrok,
    sendTextToGrok,
    sendImageToGrok,
    setupGrokIpcHandlers,
    // Conversation/session functions
    initializeNewSession,
    saveConversationTurn,
    getCurrentSessionData,
    formatSpeakerResults,
    sendToRenderer,
};