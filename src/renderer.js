// renderer.js - Consolidated renderer with unified Gemini/OpenRouter support
const { ipcRenderer } = require('electron');

// Initialize random display name for UI components
window.randomDisplayName = null;

// Request random display name from main process
ipcRenderer
    .invoke('get-random-display-name')
    .then(name => {
        window.randomDisplayName = name;
        console.log('Set random display name:', name);
    })
    .catch(err => {
        console.warn('Could not get random display name:', err);
        window.randomDisplayName = 'System Monitor';
    });

// --- Model Configuration ---
let PROFILE_DEFAULT = 'interview';
let LANG_DEFAULT = 'en-US';

// Media and audio variables
let mediaStream = null;
let screenshotInterval = null;
let audioContext = null;
let audioProcessor = null;
let micAudioProcessor = null;
let audioBuffer = [];
const SAMPLE_RATE = 24000;
const AUDIO_CHUNK_DURATION = 0.1; // seconds
const BUFFER_SIZE = 4096; // Increased buffer size for smoother audio

let hiddenVideo = null;
let offscreenCanvas = null;
let offscreenContext = null;
let currentImageQuality = 'medium'; // Store current image quality for manual screenshots

// Platform detection
const isLinux = process.platform === 'linux';
const isMacOS = process.platform === 'darwin';

// Token tracking
const tokenTracker = {
    totalTokens: 0,
    imageTokens: 0,
    textTokens: 0,
    
    calculateImageTokens(width, height) {
        // Simple calculation for image tokens based on resolution
        const pixels = width * height;
        return Math.ceil(pixels / 750); // Approximate tokens per image
    },
    
    addTokens(count, type = 'text') {
        this.totalTokens += count;
        if (type === 'image') {
            this.imageTokens += count;
        } else {
            this.textTokens += count;
        }
        console.log(`📊 ${type} tokens: +${count}, Total: ${this.totalTokens}`);
    }
};

// --- Utility Functions ---

// Get current model type
function getCurrentModelType() {
    return (localStorage.getItem('modelType') || 'gemini').toLowerCase();
}

// Audio conversion utilities
function convertFloat32ToInt16(float32Array) {
    const int16Array = new Int16Array(float32Array.length);
    for (let i = 0; i < float32Array.length; i++) {
        const clampedValue = Math.max(-1, Math.min(1, float32Array[i]));
        int16Array[i] = clampedValue < 0 ? clampedValue * 0x8000 : clampedValue * 0x7fff;
    }
    return int16Array;
}

function arrayBufferToBase64(buffer) {
    let binary = '';
    const bytes = new Uint8Array(buffer);
    const len = bytes.byteLength;
    for (let i = 0; i < len; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

// --- Model Initialization Functions ---

async function initializeGemini(profile = PROFILE_DEFAULT, language = LANG_DEFAULT) {
    const apiKey = localStorage.getItem('geminiApiKey')?.trim();
    const customPrompt = localStorage.getItem('geminiCustomPrompt') || '';
    
    if (apiKey) {
        const success = await ipcRenderer.invoke(
            'initialize-model',
            apiKey,
            customPrompt,
            profile,
            language
        );
        
        if (success && success.success) {
            cheddar.setStatus('Live (Gemini)');
            return true;
        } else {
            cheddar.setStatus('error (Gemini)');
            console.error('Failed to initialize Gemini:', success?.error);
            return false;
        }
    } else {
        cheddar.setStatus('No Gemini API key');
        return false;
    }
}

async function initializeOpenRouter(profile = PROFILE_DEFAULT, language = LANG_DEFAULT) {
    const apiKey = localStorage.getItem('openRouterApiKey')?.trim();
    const model = localStorage.getItem('openRouterModel')?.trim();
    const customPrompt = localStorage.getItem('openRouterCustomPrompt') || '';
    
    if (apiKey && model) {
        const success = await ipcRenderer.invoke(
            'initialize-model',
            apiKey,
            customPrompt,
            profile,
            language
        );
        
        if (success && success.success) {
            cheddar.setStatus('Live (OpenRouter)');
            return true;
        } else {
            cheddar.setStatus('error (OpenRouter)');
            console.error('Failed to initialize OpenRouter:', success?.error);
            return false;
        }
    } else {
        cheddar.setStatus('Missing OpenRouter credentials');
        return false;
    }
}

// Initialize model based on localStorage setting
async function initializeModel(profile = PROFILE_DEFAULT, language = LANG_DEFAULT) {
    const modelType = getCurrentModelType();
    console.log(`Initializing ${modelType} model...`);
    
    if (modelType === 'openrouter') {
        return await initializeOpenRouter(profile, language);
    } else {
        return await initializeGemini(profile, language);
    }
}

// --- Message Sending Functions ---

// Send text message to active model
async function sendTextMessage(text) {
    if (!text || text.trim().length === 0) {
        console.warn('Cannot send empty text message');
        return { success: false, error: 'Empty message' };
    }

    try {
        const result = await ipcRenderer.invoke('send-text-message', text);
        if (result.success) {
            console.log('Text message sent successfully');
            // Track text tokens (rough estimate)
            const estimatedTokens = Math.ceil(text.length / 4);
            tokenTracker.addTokens(estimatedTokens, 'text');
        } else {
            console.error('Failed to send text message:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending text message:', error);
        return { success: false, error: error.message };
    }
}

// Send image message to active model
async function sendImageMessage(base64data) {
    if (!base64data || base64data.length < 100) {
        console.error('Invalid base64 data generated');
        return { success: false, error: 'Invalid image data' };
    }

    try {
        const result = await ipcRenderer.invoke('send-image-content', { data: base64data });
        if (result.success) {
            console.log('Image sent successfully');
        } else {
            console.error('Failed to send image:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending image:', error);
        return { success: false, error: error.message };
    }
}

// Send audio message (Gemini only)
async function sendAudioMessage(base64data) {
    if (!base64data || base64data.length < 100) {
        console.error('Invalid base64 audio data');
        return { success: false, error: 'Invalid audio data' };
    }
    
    const modelType = getCurrentModelType();
    
    // OpenRouter does not support audio
    if (modelType === 'openrouter') {
        console.warn('Audio input not supported with OpenRouter model.');
        return { success: false, error: 'Audio not supported for OpenRouter.' };
    }

    try {
        const result = await ipcRenderer.invoke('send-audio-content', { 
            data: base64data, 
            mimeType: 'audio/pcm;rate=24000' 
        });
        if (result.success) {
            console.log('Audio sent successfully');
        } else {
            console.error('Failed to send audio:', result.error);
        }
        return result;
    } catch (error) {
        console.error('Error sending audio:', error);
        return { success: false, error: error.message };
    }
}

// --- Screen Capture Functions ---

async function captureScreenshot(imageQuality = 'medium', isManual = false) {
    console.log(`Capturing ${isManual ? 'manual' : 'automated'} screenshot...`);
    if (!mediaStream) return;

    const video = hiddenVideo;
    const canvas = offscreenCanvas;
    const context = offscreenContext;

    if (!video || !canvas || !context) {
        console.error('Video, canvas, or context not initialized');
        return;
    }

    // Update video dimensions if they've changed
    if (video.videoWidth !== canvas.width || video.videoHeight !== canvas.height) {
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        console.log(`Canvas dimensions updated: ${canvas.width}x${canvas.height}`);
    }

    // Draw current video frame to canvas
    context.drawImage(video, 0, 0, canvas.width, canvas.height);

    // Convert quality setting to compression value
    const qualityMap = {
        low: 0.3,
        medium: 0.7,
        high: 0.95,
    };
    const qualityValue = qualityMap[imageQuality] || 0.7;

    canvas.toBlob(
        async blob => {
            if (!blob) {
                console.error('Failed to create blob from canvas');
                return;
            }

            const reader = new FileReader();
            reader.onloadend = async () => {
                const base64data = reader.result.split(',')[1];

                // Validate base64 data
                if (!base64data || base64data.length < 100) {
                    console.error('Invalid base64 data generated');
                    return;
                }

                const result = await sendImageMessage(base64data);

                if (result.success) {
                    // Track image tokens after successful send
                    const imageTokens = tokenTracker.calculateImageTokens(canvas.width, canvas.height);
                    tokenTracker.addTokens(imageTokens, 'image');
                    console.log(`📊 Image sent successfully - ${imageTokens} tokens used (${canvas.width}x${canvas.height})`);
                } else {
                    console.error('Failed to send image:', result.error);
                }
            };
            reader.readAsDataURL(blob);
        },
        'image/jpeg',
        qualityValue
    );
}

async function captureManualScreenshot(imageQuality = null) {
    console.log('Manual screenshot triggered');
    const quality = imageQuality || currentImageQuality;
    await captureScreenshot(quality, true);
    
    // Add delay and send contextual prompt
    await new Promise(resolve => setTimeout(resolve, 2000));
    await sendTextMessage(`Help me on this page, give me the answer no bs, complete answer.
        So if its a code question, give me the approach in few bullet points, then the entire code. Also if theres anything else i need to know, tell me.
        If its a question about the website, give me the answer no bs, complete answer.
        If its a mcq question, give me the answer no bs, complete answer.`);
}

// --- Audio Processing Functions ---

function setupLinuxMicProcessing(micStream) {
    // Setup microphone audio processing for Linux
    const micAudioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const micSource = micAudioContext.createMediaStreamSource(micStream);
    const micProcessor = micAudioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    micProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await sendAudioMessage(base64Data);
        }
    };

    micSource.connect(micProcessor);
    micProcessor.connect(micAudioContext.destination);

    // Store processor reference for cleanup
    micAudioProcessor = micProcessor;
}

function setupLinuxSystemAudioProcessing() {
    // Setup system audio processing for Linux (from getDisplayMedia)
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    audioProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await sendAudioMessage(base64Data);
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

function setupWindowsLoopbackProcessing() {
    // Setup audio processing for Windows loopback audio only
    audioContext = new AudioContext({ sampleRate: SAMPLE_RATE });
    const source = audioContext.createMediaStreamSource(mediaStream);
    audioProcessor = audioContext.createScriptProcessor(BUFFER_SIZE, 1, 1);

    let audioBuffer = [];
    const samplesPerChunk = SAMPLE_RATE * AUDIO_CHUNK_DURATION;

    audioProcessor.onaudioprocess = async e => {
        const inputData = e.inputBuffer.getChannelData(0);
        audioBuffer.push(...inputData);

        // Process audio in chunks
        while (audioBuffer.length >= samplesPerChunk) {
            const chunk = audioBuffer.splice(0, samplesPerChunk);
            const pcmData16 = convertFloat32ToInt16(chunk);
            const base64Data = arrayBufferToBase64(pcmData16.buffer);

            await sendAudioMessage(base64Data);
        }
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
}

// --- Screen and Audio Capture Functions ---

async function startCapture() {
    try {
        const modelType = getCurrentModelType();
        
        if (isLinux) {
            // Linux: Use getDisplayMedia for both screen and audio
            console.log('Starting Linux capture with getDisplayMedia...');
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 2 },
                audio: {
                    autoGainControl: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                }
            });

            setupVideoProcessing();
            
            if (modelType === 'gemini') {
                setupLinuxSystemAudioProcessing();
                
                // Also get microphone for speaker diarization
                try {
                    const micStream = await navigator.mediaDevices.getUserMedia({
                        audio: {
                            autoGainControl: false,
                            echoCancellation: false,
                            noiseSuppression: false,
                        }
                    });
                    setupLinuxMicProcessing(micStream);
                    console.log('Microphone stream added for speaker diarization');
                } catch (error) {
                    console.warn('Could not access microphone:', error);
                }
            }

        } else if (isMacOS) {
            // macOS: Use getDisplayMedia for screen, SystemAudioDump for audio
            console.log('Starting macOS capture...');
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 2 },
                audio: false // We'll use SystemAudioDump instead
            });

            setupVideoProcessing();
            
            if (modelType === 'gemini') {
                // Start macOS system audio capture
                const audioResult = await ipcRenderer.invoke('start-macos-audio');
                if (audioResult.success) {
                    console.log('macOS system audio capture started');
                } else {
                    console.error('Failed to start macOS audio capture:', audioResult.error);
                }
            }

        } else {
            // Windows: Use getDisplayMedia with loopback audio
            console.log('Starting Windows capture with getDisplayMedia...');
            mediaStream = await navigator.mediaDevices.getDisplayMedia({
                video: { frameRate: 2 },
                audio: {
                    autoGainControl: false,
                    echoCancellation: false,
                    noiseSuppression: false,
                }
            });

            setupVideoProcessing();
            
            if (modelType === 'gemini') {
                setupWindowsLoopbackProcessing();
            }
        }

        // Start screenshot intervals for OpenRouter or if desired for Gemini
        if (modelType === 'openrouter') {
            startScreenshotInterval();
        }

        cheddar.setStatus('Capturing...');
        console.log('Capture started successfully');

    } catch (error) {
        console.error('Error starting capture:', error);
        cheddar.setStatus('Error starting capture: ' + error.message);
        throw error;
    }
}

function setupVideoProcessing() {
    // Create hidden video element for frame capture
    hiddenVideo = document.createElement('video');
    hiddenVideo.style.display = 'none';
    hiddenVideo.muted = true;
    hiddenVideo.srcObject = mediaStream;
    hiddenVideo.play();
    document.body.appendChild(hiddenVideo);

    // Create offscreen canvas for processing
    offscreenCanvas = document.createElement('canvas');
    offscreenContext = offscreenCanvas.getContext('2d');

    hiddenVideo.addEventListener('loadedmetadata', () => {
        offscreenCanvas.width = hiddenVideo.videoWidth;
        offscreenCanvas.height = hiddenVideo.videoHeight;
        console.log(`Video dimensions: ${hiddenVideo.videoWidth}x${hiddenVideo.videoHeight}`);
    });
}

function startScreenshotInterval() {
    const interval = 5000; // 5 seconds for OpenRouter
    screenshotInterval = setInterval(() => {
        captureScreenshot(currentImageQuality);
    }, interval);
    console.log(`Screenshot interval started: ${interval}ms`);
}

async function stopCapture() {
    try {
        // Stop screenshot interval
        if (screenshotInterval) {
            clearInterval(screenshotInterval);
            screenshotInterval = null;
        }

        // Stop media streams
        if (mediaStream) {
            mediaStream.getTracks().forEach(track => track.stop());
            mediaStream = null;
        }

        // Cleanup audio processing
        if (audioProcessor) {
            audioProcessor.disconnect();
            audioProcessor = null;
        }
        
        if (micAudioProcessor) {
            micAudioProcessor.disconnect();
            micAudioProcessor = null;
        }

        if (audioContext) {
            await audioContext.close();
            audioContext = null;
        }

        // Stop platform-specific audio capture
        if (isMacOS) {
            const result = await ipcRenderer.invoke('stop-macos-audio');
            if (result.success) {
                console.log('macOS audio capture stopped');
            }
        }

        // Cleanup video elements
        if (hiddenVideo) {
            hiddenVideo.remove();
            hiddenVideo = null;
        }

        cheddar.setStatus('Stopped');
        console.log('Capture stopped successfully');

    } catch (error) {
        console.error('Error stopping capture:', error);
        cheddar.setStatus('Error stopping capture: ' + error.message);
    }
}

// --- Event Listeners ---

// Listen for status updates
ipcRenderer.on('update-status', (event, status) => {
    console.log('Status update:', status);
    cheddar.setStatus(status);
});

// Listen for AI response updates
ipcRenderer.on('update-response', (event, response) => {
    console.log('Response update received');
    cheddar.setResponse(response);
});

// --- Conversation History Functions ---

async function initConversationStorage() {
    return new Promise((resolve, reject) => {
        const request = indexedDB.open('ConversationHistory', 1);
        
        request.onerror = () => reject(request.error);
        request.onsuccess = () => resolve(request.result);
        
        request.onupgradeneeded = (event) => {
            const db = event.target.result;
            if (!db.objectStoreNames.contains('sessions')) {
                const store = db.createObjectStore('sessions', { keyPath: 'sessionId' });
                store.createIndex('timestamp', 'timestamp', { unique: false });
            }
        };
    });
}

async function getAllConversationSessions() {
    try {
        const db = await initConversationStorage();
        const transaction = db.transaction(['sessions'], 'readonly');
        const store = transaction.objectStore('sessions');
        
        return new Promise((resolve, reject) => {
            const request = store.getAll();
            request.onsuccess = () => resolve(request.result || []);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('Error getting conversation sessions:', error);
        return [];
    }
}

async function getConversationSession(sessionId) {
    try {
        const db = await initConversationStorage();
        const transaction = db.transaction(['sessions'], 'readonly');
        const store = transaction.objectStore('sessions');
        
        return new Promise((resolve, reject) => {
            const request = store.get(sessionId);
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
        });
    } catch (error) {
        console.error('Error getting conversation session:', error);
        return null;
    }
}

// --- Shortcut Handling ---

function handleShortcut(shortcutKey) {
    console.log('Handling shortcut:', shortcutKey);
    
    // Get current view to determine action
    const currentView = cheddar.getCurrentView();
    
    if (shortcutKey === 'cmd+enter' || shortcutKey === 'ctrl+enter') {
        if (currentView === 'main') {
            // In main view, start capture and initialize model
            console.log('Starting capture from shortcut');
            initializeModel().then(success => {
                if (success) {
                    startCapture();
                }
            });
        } else if (currentView === 'assistant') {
            // In assistant view, take manual screenshot
            console.log('Taking manual screenshot from shortcut');
            captureManualScreenshot();
        }
    }
}

// --- Main Initialization ---

// Expose functions to global scope for external access
window.captureManualScreenshot = captureManualScreenshot;

// Consolidated cheddar object - all functions in one place
const cheddar = {
    // Element access
    element: () => cheatingDaddyApp,
    e: () => cheatingDaddyApp,

    // App state functions - access properties directly from the app element
    getCurrentView: () => cheatingDaddyApp.currentView,
    getLayoutMode: () => cheatingDaddyApp.layoutMode,

    // Status and response functions
    setStatus: text => cheatingDaddyApp.setStatus(text),
    setResponse: response => cheatingDaddyApp.setResponse(response),

    // Core functionality
    initializeGemini,
    initializeOpenRouter,
    initializeModel,
    startCapture,
    stopCapture,
    sendTextMessage,
    sendImageMessage,
    sendAudioMessage,
    captureManualScreenshot,
    handleShortcut,

    // Conversation history functions
    getAllConversationSessions,
    getConversationSession,
    initConversationStorage,

    // Content protection function
    getContentProtection: () => {
        const contentProtection = localStorage.getItem('contentProtection');
        return contentProtection !== null ? contentProtection === 'true' : true;
    },

    // Model type function
    getCurrentModelType,

    // Platform detection
    isLinux: isLinux,
    isMacOS: isMacOS,

    // Token tracking
    tokenTracker
};

// Make it globally available
window.cheddar = cheddar;

// Initialize conversation storage and model on startup
Promise.all([
    initConversationStorage(),
    initializeModel()
]).then(() => {
    console.log('Renderer initialization complete');
}).catch(error => {
    console.error('Error during renderer initialization:', error);
});
