"use strict";

// https://web.dev/articles/webrtc-basics
// https://developer.mozilla.org/en-US/docs/Web/API/MediaDevices/getUserMedia
let frontFacing = true;
let isRecording = false;

/** @type MediaStream | null */
let stream = null;

/** @type MediaRecorder | null */
let recorder = null;

/** @type HTMLElement | null */
let recordButton = null;

/** @type HTMLVideoElement | null */
let videoCanvas = null;

/**
 * @type {any}
 */
let socket = null;

const Kbits = 1e3;
const Mbits = 1e6;

const AUDIO_BITRATE = {
    LOSSLESS: 1411.2 * Kbits,
    SURROUND: 512 * Kbits,
    STEREO: 384 * Kbits,
    MONO: 128 * Kbits,
};

const VIDEO_BITRATE = {
    "8K": 100 * Mbits,
    "4K": 44 * Mbits,
    "2K": 20 * Mbits,
    "1080p": 10 * Mbits,
    "720p": 6.5 * Mbits,
};

/**
 * @type MediaStreamConstraints
 * https://webthesis.biblio.polito.it/16659/1/tesi.pdf
 * */
const constraints = {
    audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        // @ts-ignore
        latency: 0,
    },
    video: {
        facingMode: frontFacing ? "user" : "environment",
        frameRate: 30,
        width: { ideal: 4096 },
        height: { ideal: 2160 },
    },
};

/** @type {MediaRecorderOptions} */
const recorderOptions = {
    mimeType: "video/webm",
    videoBitsPerSecond: VIDEO_BITRATE["2K"],
    audioBitsPerSecond: AUDIO_BITRATE.MONO,
};

/**
 * @param {MediaStream} stream
 */
async function recordStream(stream) {
    console.log("Got stream with constraints:", constraints);

    if (!MediaRecorder.isTypeSupported("video/webm")) {
        recorderOptions.mimeType = "video/mp4";
    }

    try {
        // https://support.google.com/youtube/answer/1722171#zippy=%2Cbitrate
        recorder = new MediaRecorder(stream, recorderOptions);
    } catch (error) {
        socket.emit("end-stream");
        console.error(error);
        tearDown();
        return;
    }

    recorder.ondataavailable = (event) => {
        if (event.data.size === 0) return;
        socket.emit("data", event.data);
    };

    recorder.onstart = () => {
        console.log("[TRACE] starting recording");
    };

    recorder.onerror = (error) => {
        console.error("[ERROR] recording:", error);
        socket.emit("end-stream");

        tearDown();
    };

    recorder.onstop = () => {
        console.log("[TRACE] stopping recording");
    };

    recorder.start(100);
}

/**
 * @param {Error} error
 */
function displayError(error) {
    console.error(error);

    if (error.name === "OverconstrainedError") {
        errorMsg(
            `OverconstrainedError: The constraints could not be satisfied by the available devices. Constraints: ${JSON.stringify(
                constraints
            )}`
        );
    } else if (error.name === "NotAllowedError") {
        errorMsg(
            "NotAllowedError: The user has denied permission to use media devices"
        );
    }
    errorMsg(`Error: ${error.message}`);
}

/**
 * @param {string} msg
 */
function errorMsg(msg) {
    const errorElement = document.querySelector("#errorMsg");
    if (errorElement) {
        errorElement.innerHTML += `<p>${msg}</p>`;
    }
}

function tearDown() {
    console.log("[TRACE] Tearing down stream");
    if (recorder) {
        recorder.stop();
        // wait a little before stopping the stream
        setTimeout(() => socket.emit("end-stream"), 500);
    }

    isRecording = false;
    recorder = null;

    if (recordButton) {
        recordButton.innerHTML = "Start";
        recordButton.style.backgroundColor = "green";
    }
}

async function record() {
    console.log(`[TRACE] ${isRecording ? "Stopping " : "Starting "} recording`);
    if (isRecording) {
        tearDown();
        return;
    }

    try {
        await recordStream(await getStream());
        socket.emit("start-stream", recorderOptions.mimeType);

        isRecording = true;
        if (recordButton) {
            recordButton.innerHTML = "Stop";
            recordButton.style.backgroundColor = "red";
        }
    } catch (e) {
        // @ts-ignore
        displayError(e);
        console.error("[ERROR]", e);
    }
}

function connectToServer() {
    // @ts-ignore
    socket = io();

    socket.on("connect", () => {
        console.log(
            `connected with transport ${socket.io.engine.transport.name}`
        );
    });

    socket.on("disconnect", (/** @type {String} */ reason) => {
        console.log(`disconnect due to ${reason}`);
        if (isRecording) {
            tearDown();
        }
    });
}

async function flipCamera() {
    console.log("[TRACE] Flipping camera");

    frontFacing = !frontFacing;
    // @ts-ignore
    constraints.video.facingMode = frontFacing ? "user" : "environment";

    try {
        const prevRecorder = recorder;
        stopStream();

        // get new video stream
        stream = await navigator.mediaDevices.getUserMedia(constraints);
        if (videoCanvas) videoCanvas.srcObject = stream;

        if (!isRecording) return;

        // start new recording
        await recordStream(stream);

        // stop previous recorder
        prevRecorder?.stop();
    } catch (error) {
        console.error("[ERROR] changing camera:", error);
        tearDown();
    }
}

/**
 * @returns {Promise<MediaStream>}
 */
async function getStream() {
    if (stream) return stream;

    const _stream = await navigator.mediaDevices.getUserMedia(constraints);
    stream = _stream;
    if (videoCanvas) videoCanvas.srcObject = stream;

    return _stream;
}

function stopStream() {
    if (!stream) return;

    stream.getTracks().forEach((track) => {
        track.stop();
    });
    stream = null;
}

function handleVisibilityChange() {
    if (isRecording) return;

    if (document.hidden) {
        stopStream();
    } else {
        getStream();
    }
}

window.onload = () => {
    videoCanvas = document.querySelector("#videoCanvas");
    recordButton = document.querySelector("#streamButton");

    recordButton?.addEventListener("click", () => record());

    const flipCameraButton = document.querySelector("#flipCamera");
    flipCameraButton?.addEventListener("click", () => flipCamera());

    // show stream preview
    getStream();

    // stop preview when tab is inactive
    document.onvisibilitychange = () => handleVisibilityChange();

    connectToServer();
};
