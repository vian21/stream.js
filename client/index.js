"use strict";

let isRecording = false;
let socket = null;
let mediaRecorder = null;
let localStream = null;
let frontFacing = true;

let videoCanvas = null;
let streamButton = null;
let flipCameraButton = null;
let errorMsgElement = null;

const VIDEO_BITRATE = 10 * 1024 * 1024; // 10 Mbps for HD quality

const constraints = {
    audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
    },
    video: {
        facingMode: "user",
        frameRate: { ideal: 30, max: 30 },
        width: { ideal: 1920 },
        height: { ideal: 1080 },
        aspectRatio: { ideal: 1.777777778 }
    }
};

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function displayError(msg) {
    console.error(msg);
    if (errorMsgElement) {
        errorMsgElement.innerHTML += `<p style="color: red;">${msg}</p>`;
    }
}

async function initSocket() {
    socket = io();
    socket.on("connect", () => console.log("[SOCKET] Connected"));
}

async function getStream() {
    if (localStream) return localStream;
    try {
        const stream = await navigator.mediaDevices.getUserMedia(constraints);
        localStream = stream;
        if (videoCanvas) videoCanvas.srcObject = localStream;
        return stream;
    } catch (err) {
        displayError(`Camera access failed: ${err.message}`);
        return null;
    }
}

async function startRecording() {
    if (isRecording) return;
    const stream = await getStream();
    if (!stream) return;

    socket.emit("start-stream");

    const options = { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: VIDEO_BITRATE };

    // Fallback for browsers that don't support VP9
    if (!MediaRecorder.isTypeSupported(options.mimeType)) {
        options.mimeType = 'video/webm;codecs=vp8,opus';
    }

    mediaRecorder = new MediaRecorder(stream, options);

    mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
            socket.emit("video-chunk", event.data);
        }
    };

    mediaRecorder.onstop = () => {
        if (!isRecording) {
            console.log("[TRACE] MediaRecorder stopped, waiting for final flush...");
            if (socket) {
                console.log("[TRACE] Sending final stop-stream signal");
                socket.emit("stop-stream");
            }
        } else {
            console.log("[TRACE] MediaRecorder stopped (likely camera flip), not sending stop-stream");
        }
    };

    // 100ms chunks for low latency delivery to server
    mediaRecorder.start(100);

    isRecording = true;
    streamButton.innerText = "Stop";
    streamButton.style.backgroundColor = "red";
}

function stopRecording() {
    isRecording = false;
    if (mediaRecorder) {
        // Force an immediate buffer dump and then stop
        mediaRecorder.requestData();

        // KEEP: requestData doesnt return the data directly. delay mediarecorder stop
        sleep(2000).then(() => {
            mediaRecorder.stop();
            mediaRecorder = null;
        })
    } else if (socket) {
        // Fallback if recorder was already null
        alert("recorder null")
        socket.emit("stop-stream");
    }
    streamButton.innerText = "Start";
    streamButton.style.backgroundColor = "green";
}

async function toggleRecording() {
    if (isRecording) stopRecording();
    else await startRecording();
}

async function flipCamera() {
    frontFacing = !frontFacing;
    constraints.video.facingMode = frontFacing ? "user" : "environment";

    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }

    const newStream = await getStream();
    if (isRecording && newStream) {
        // Stop current recorder and start new one with new stream
        if (mediaRecorder) {
            mediaRecorder.requestData();
            mediaRecorder.stop();
        }

        const options = { mimeType: 'video/webm;codecs=vp9,opus', videoBitsPerSecond: VIDEO_BITRATE };
        if (!MediaRecorder.isTypeSupported(options.mimeType)) options.mimeType = 'video/webm;codecs=vp8,opus';

        mediaRecorder = new MediaRecorder(newStream, options);
        mediaRecorder.ondataavailable = (event) => {
            if (event.data.size > 0) socket.emit("video-chunk", event.data);
        };
        mediaRecorder.onstop = () => {
            if (!isRecording) {
                console.log("[TRACE] MediaRecorder (flip) stopped, waiting for final flush...");
                if (socket) {
                    console.log("[TRACE] Sending final stop-stream signal");
                    socket.emit("stop-stream");
                }
            }
        };
        mediaRecorder.start(100);
    }
}

window.onload = () => {
    videoCanvas = document.querySelector("#videoCanvas");
    streamButton = document.querySelector("#streamButton");
    flipCameraButton = document.querySelector("#flipCamera");
    errorMsgElement = document.querySelector("#errorMsg");

    initSocket();
    streamButton.addEventListener("click", toggleRecording);
    flipCameraButton.addEventListener("click", flipCamera);
    getStream();
};
